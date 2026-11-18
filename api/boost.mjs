// Copyright 2026 ItsWempo
//
// This file is part of GooberCord.
//
// GooberCord is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>.

// T79: the forum post boost's GC render half (docs/drafts/t79-post-boost-spec.md
// §2.4-2.5). The forum side MINTS a row into gc_fleet_boosts (0029, its pending
// shape: rendered_message_id NULL); THIS module renders pending boosts as
// mirrored card messages into a server's announcement channel:
//   * the kind gate answers FIRST (unknown id → 404, any non-announcement kind
//     → 409), before a single row is read for rendering;
//   * the card rides THE ONE gc_messages writer (the mirrored-card insert in
//     api/messages.mjs — the module's own MESSAGE_INSERT_SQL + cursor
//     statement; no second SQL home);
//   * one boost renders at most one card per channel (0029's partial UNIQUE
//     index + the rendered stamp), so a replayed consume stamps, never
//     duplicates;
//   * identity is the shared users row (t64 G1) and deletions cascade
//     (gc_fleet_boosts.author_id + gc_messages.author_id, per 0029) — a
//     deleted member's boost and its card die together.
import { HttpError, json } from "./core/http.mjs";
import { requireUser } from "./core/auth.mjs";
import { channelForUser, enforceChannelBits, insertMirroredCardMessage } from "./messages.mjs";

// The forum's canonical origin (the card's provenance link target): the
// forum worker's public hostname. The env override exists for dev mirrors.
const FORUM_ORIGIN_DEFAULT = "https://wempos-forum.itswempo.workers.dev";

// The card's excerpt cap (spec §2.5): longer thread excerpts ellipsize.
const EXCERPT_CAP = 240;

// The per-call consume cap: one request renders at most this many pending
// boosts (the route may be repeated; nothing is lost to the cap).
const MAX_CONSUME_PER_CALL = 10;

// The announcement gate (spec §2.4): unknown id → 404 (a non-member must not
// learn that a channel exists); any other kind → 409 (a text channel is a
// real channel, just not a mirror target). Returns the channel untouched on
// the happy path.
export function validateAnnouncementChannel(channel) {
  if (!channel) {
    throw new HttpError(404, "This channel does not exist or you cannot view it.");
  }
  if (channel.kind !== "announcement") {
    throw new HttpError(409, "Boosts render only into announcement channels.");
  }
  return channel;
}

// The card composer (spec §2.5) — pure, deterministic byte shape:
//   [Forum boost] {thread_title}
//
//   {thread_excerpt, ellipsized at EXCERPT_CAP}
//
//   Posted in the forum by {author} — read it at {origin}/posts/{id}
export function renderBoostCard(boost, forumOrigin) {
  const excerpt = boost.thread_excerpt.length > EXCERPT_CAP
    ? boost.thread_excerpt.slice(0, EXCERPT_CAP) + "…"
    : boost.thread_excerpt;
  return {
    body:
      "[Forum boost] " + boost.thread_title +
      "\n\n" +
      excerpt +
      "\n\n" +
      "Posted in the forum by " + boost.author_name +
      " — read it at " + forumOrigin + "/posts/" + boost.forum_post_id,
  };
}

// The consume pass: pending boosts, oldest first, each rendered as ONE card
// through the shared writer and stamped back (the stamp pair rides the same
// batch's rederived message id via the boost-derived client id, so an
// idempotent replay lands on DO NOTHING and leaves no second card).
const BOOST_PENDING_SQL =
  "SELECT b.id, b.forum_post_id, b.author_id, b.thread_title, b.thread_excerpt, " +
    "u.username AS author_name " +
  "FROM gc_fleet_boosts b JOIN users u ON u.id = b.author_id " +
  "WHERE b.rendered_message_id IS NULL " +
  "ORDER BY b.created_at ASC, b.id ASC LIMIT ?";

const BOOST_STAMP_SQL =
  "UPDATE gc_fleet_boosts SET rendered_channel_id = ?, " +
    "rendered_message_id = (SELECT id FROM gc_messages WHERE channel_id = ? " +
      "AND author_id = ? AND client_message_id = ? ORDER BY id DESC LIMIT 1), " +
    "rendered_at = ? " +
  "WHERE id = ? AND rendered_message_id IS NULL";

async function consumeBoosts(env, channel, user, forumOrigin) {
  const pending = await env.GOOBER_DB.prepare(BOOST_PENDING_SQL)
    .bind(MAX_CONSUME_PER_CALL).all();
  const boostRows = pending?.results ?? [];
  const rendered = [];
  for (const boost of boostRows) {
    const clientMessageId = `boost-${boost.id}-c${channel.id}`;
    const card = renderBoostCard(boost, forumOrigin);
    const cardResult = await insertMirroredCardMessage(
      env, channel.id, Number(boost.author_id), card.body, clientMessageId,
    );
    if (!cardResult?.created) continue; // already rendered by a concurrent caller — skip the stamp
    await env.GOOBER_DB.prepare(BOOST_STAMP_SQL)
      .bind(channel.id, channel.id, Number(boost.author_id), clientMessageId,
        cardResult.message.created_at, boost.id)
      .run();
    rendered.push({ boostId: boost.id, messageId: Number(cardResult.message.id) });
  }
  return rendered;
}

// The route body (wired in the servers dispatch):
// POST /api/servers/:serverId/channels/:channelId/consume-boosts.
// Gate order: kind FIRST (the 404/409 answers precede every member read),
// then the membership read (channelForUser is the one member gate —
// a non-member shares the unknown-channel 404), then the channel's SEND bit
// (the mirror is a render into the room; the room's send law still applies).
export async function handleConsumeBoostsRoute(request, env, serverId, channelId) {
  const session = await requireUser(request, env);
  const user = session.user;

  const channelById = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(Number(channelId)).first();
  if (!channelById || Number(channelById.server_id) !== Number(serverId)) {
    throw new HttpError(404, "This channel does not exist or you cannot view it.");
  }

  // The gate, FIRST (before any member-state read or row move).
  validateAnnouncementChannel(channelById);

  // The membership read + the SEND bit: announcement mirrors write real
  // messages, so the room's SEND layer governs who may consume.
  const memberChannel = await channelForUser(env, channelId, Number(user.id));
  if (!memberChannel) {
    throw new HttpError(404, "This channel does not exist or you cannot view it.");
  }
  await enforceChannelBits(env, memberChannel, Number(user.id), ["SEND"]);

  const forumOrigin = env.FORUM_PUBLIC_ORIGIN ?? FORUM_ORIGIN_DEFAULT;
  const rendered = await consumeBoosts(env, memberChannel, user, forumOrigin);
  return json({ rendered });
}
