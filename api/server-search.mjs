// Copyright 2026 YourLocalGoober
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
// see <https://www.gnu.org/licenses/>

// T-R25-SPLIT-SERVERS-7: the search family's home (the wave-25 area-9 seam,
// off the phase-1 monolith). The server's message search answers here — the
// member-gated, VIEW-gated LIKE over the text channels' bodies. The ONE
// forward below hands the route to the router from the search arm's
// ORIGINAL position (its interloper seat between the mod desk's forward and
// the invites dispatch, preserved exactly) with an 'undefined' fall-through
// — route order is semantically byte-unchanged, and every gate rides INSIDE
// the SQL / the shared messages gate exactly as before (an extraction moves
// bytes, not behavior).
//
// The VIEW gate stays ONE implementation: viewerCanViewChannel lives in
// messages.mjs and is IMPORTED (never copied) — the layer machinery's own
// boolean, one instance across every family that consumes it.
//
// The family keeps no guard mirrors: it owns no module-scope guard fragment
// (the member gate + the escape discipline ride the SQL texts verbatim).

import { requireUser } from "./core/auth.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { GC_SEARCH_PAGE_MAX, GC_SEARCH_TERM_MAX } from "../constants.mjs";
// The per-hit VIEW gate rides the shared layer machinery (one boolean, never
// the throwing route gate — a denied hit is DROPPED, not a page-kill).
import { viewerCanViewChannel } from "./messages.mjs";

// The server's message search (W-B2): a LIKE over the text channels' bodies,
// member-gated and VIEW-gated. The escape discipline rides the SQL's own
// ESCAPE arm — the user's % and _ are LITERALIZED (a query containing them
// matches the characters, never the wildcards) — while the dispatch's
// "word-bounded" reading stays a later lane (SQLite's LIKE cannot express a
// word seam without a padded corpus; GC matches the whole-contains term,
// case-insensitive for ASCII via LIKE's own collation). A server carrying no
// channel overwrites admits every member to every text channel (the
// graceful default, documented at messages.mjs's layer comments) — the
// per-hit VIEW evaluation only runs when overwrites exist at all, so the
// common server spends one read on the question. The route is read-limited
// on the 'read' bucket, never the slowmode.
const SERVER_SEARCH_MEMBERSHIP_SQL =
  "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";
const SERVER_SEARCH_OVERWRITES_SQL =
  "SELECT EXISTS(SELECT 1 FROM gc_channel_overwrites o JOIN gc_channels c " +
    "ON c.id = o.channel_id WHERE c.server_id = ?) AS any_overwrites";
const SERVER_SEARCH_SQL =
  "SELECT m.id AS id, m.channel_id AS channel_id, c.name AS channel_name, " +
    "c.server_id AS server_id, m.author_id AS author_id, " +
    "gu.username AS author_username, m.body AS body, m.created_at AS created_at " +
  "FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id " +
    "JOIN users gu ON gu.id = m.author_id " +
  "WHERE c.kind = 'text' AND c.server_id = ? AND m.body LIKE ? ESCAPE '\\' " +
    "AND EXISTS (SELECT 1 FROM gc_server_members fsm WHERE fsm.server_id = c.server_id " +
      "AND fsm.user_id = ?) ";

async function handleSearchServerRoute(request, env, serverId, url) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "user:" + userId);

  const member = await env.GOOBER_DB.prepare(SERVER_SEARCH_MEMBERSHIP_SQL)
    .bind(serverId, userId).first();
  if (!member) throw new HttpError(403, "You do not have permission to do that.");

  const qRaw = url.searchParams.get("q");
  if (qRaw === null) throw new HttpError(400, "That search term is invalid.");
  const term = qRaw.trim();
  if (term.length < 1 || term.length > GC_SEARCH_TERM_MAX) {
    throw new HttpError(400, "That search term is invalid.");
  }
  // The channel param: an optional single-channel narrowing; malformed ids
  // 400, never silently broadened server-wide.
  const channelRaw = url.searchParams.get("channel");
  let channelId = null;
  if (channelRaw !== null && channelRaw !== "") {
    if (!/^[1-9][0-9]{0,14}$/.test(channelRaw)) {
      throw new HttpError(400, "That channel filter is invalid.");
    }
    channelId = Number(channelRaw);
  }

  const escaped = term.replace(/[\\%_]/g, (ch) => "\\" + ch);
  const sql =
    SERVER_SEARCH_SQL +
    (channelId === null ? "" : "AND c.id = ? ") +
    "ORDER BY m.id DESC LIMIT " + GC_SEARCH_PAGE_MAX;

  const rows = (await env.GOOBER_DB.prepare(sql)
    .bind(
      serverId,
      "%" + escaped + "%",
      userId,
      // The 4th placeholder ONLY exists when the channel arm rode the SQL —
      // a bind must never ride out of step with the placeholder count.
      ...(channelId === null ? [] : [channelId]),
    ).all()).results || [];

  // The VIEW gate: the graceful default's question first (one read), then
  // the per-hit evaluation only when the server carries overwrites at all.
  let hits = rows;
  if (rows.length > 0) {
    const overwrites = await env.GOOBER_DB.prepare(SERVER_SEARCH_OVERWRITES_SQL)
      .bind(serverId).first();
    if (Number(overwrites?.any_overwrites) === 1) {
      const allowed = [];
      for (const row of rows) {
        if (await viewerCanViewChannel(env, { id: row.channel_id, server_id: row.server_id }, userId)) {
          allowed.push(row);
        }
      }
      hits = allowed;
    }
  }

  return json({
    results: hits.map((row) => ({
      id: Number(row.id),
      channelId: Number(row.channel_id),
      channelName: row.channel_name,
      authorId: Number(row.author_id),
      authorUsername: row.author_username,
      body: row.body,
      createdAt: Number(row.created_at),
    })),
  }, 200);
}


export async function handleServerSearchRoutes(request, env, url, path, method) {
  const searchMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/search$/)
    : null;
  if (searchMatch) {
    return handleSearchServerRoute(request, env, Number(searchMatch[1]), url);
  }

  return undefined;
}
