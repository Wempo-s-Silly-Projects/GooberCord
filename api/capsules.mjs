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
// see <https://www.gnu.org/licenses/>

// Time capsules (lane2-lifecycle recode, migration 0052): a letter to your
// future self, postmarked by the server. One schedule, one reveal, ZERO
// timers — the reveal is a property of the ROW, checked by time comparison
// at read time, so reads gate themselves. The laws the module encodes:
//   * defaults law: nothing is sealed, revealed, or rendered without the
//     acting member's own request;
//   * deletion control: the author hard-deletes until the postmark (the
//     delete gate rides the DELETE statement's own reveal_at > ? arm); after
//     the postmark the letter is locked — THE ROOM'S, not theirs;
//   * privacy law: the body rides EXACTLY ONE read — the post-reveal body
//     read, which no pre-reveal arm can reach. The sealed-shape reads (the
//     author read, the gate's non-author view read, the member's own list)
//     select the body column NOWHERE;
//   * self-seal: channel_id NULL rides to the author alone, forever — every
//     non-author arm answers the 404 shape (no existence oracle);
//   * caps from constants.mjs only.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_CAPSULE_BODY_MAX,
  GC_CAPSULE_MAX_AHEAD_SECONDS,
  GC_CAPSULE_MIN_AHEAD_SECONDS,
  GC_CAPSULES_MAX_OPEN_PER_MEMBER,
  GC_CAPSULES_MINE_LIST_MAX,
} from "../constants.mjs";
import { channelForUser, enforceChannelBits } from "./messages.mjs";

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The member's OWN list: the author seat rides INSIDE the read (no
// cross-member row is reachable by construction), and one indexed WHERE
// answers the whole page. No body column — the surprise stays sealed here.
// The read CAPS at the constant: revealed rows are undeletable by law and
// accumulate forever, and the open-envelope cap covers only reveal_at >
// now rows — past it this page would be unbounded on the wire. The order
// rides reveal_at DESC (lane-c18-fix, the deslop-c17 prescription): the
// actionable open rows (future reveal_at) paint FIRST in the capped page —
// the oldest revealed rows truncate harmlessly on the far side, where each
// truncated row is a bodyless pointer the reveal route still answers.
// Zero new binds: the same author + server seats, order seat only.
const CAPSULES_MINE_SQL =
  "SELECT id, channel_id, reveal_at FROM gc_time_capsules " +
    "WHERE author_id = ? AND server_id = ? ORDER BY reveal_at DESC LIMIT " + GC_CAPSULES_MINE_LIST_MAX;

// The mine page's "more" probe: the bookmarks idiom (BOOKMARKS_LIST_PROBE_SQL
// at api/bookmarks.mjs) — the D1-cheapest over-extension signal, one indexed
// one-row read bounded by OFFSET + 1 entries past the cap. A COUNT behind
// the same WHERE would scan the whole author index span (unbounded in N).
// The probe adds a boolean seat to the answer; the capped statement's shape
// stays untouched, and the ORDER BY rides IDENTICAL to the list's (the
// probe must over-extend the SAME page the read answered).
const CAPSULES_MINE_PROBE_SQL =
  "SELECT 1 AS one FROM gc_time_capsules WHERE author_id = ? AND server_id = ? " +
    "ORDER BY reveal_at DESC LIMIT 1 OFFSET " + GC_CAPSULES_MINE_LIST_MAX;

// The author read: the delete route's pre-check and the reveal gate's author
// arm. No body column — the letter stays sealed even from its writer. The
// URL's server_id rides the WHERE too: a capsule answers only through its
// OWN server's URL namespace (a member of two servers cannot address their
// server-A capsule through a server-B URL).
const CAPSULE_AUTHOR_READ_SQL =
  "SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules " +
    "WHERE id = ? AND server_id = ? AND author_id = ? LIMIT 1";

// The reveal gate's non-author arm: the by-id read scoped to the URL's
// server namespace, still with NO body column — it only classifies
// (pre-reveal 404 / self-seal 404 / channel VIEW gate). The body rides the
// post-reveal read alone.
const CAPSULE_VIEW_READ_SQL =
  "SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules " +
    "WHERE id = ? AND server_id = ? LIMIT 1";

// THE body read — the one statement whose result carries the letter's text.
// Every caller reached it through a gate arm (the author read, or the
// channel VIEW gate), so authorization rides the reads before it.
const CAPSULE_BODY_READ_SQL = "SELECT body FROM gc_time_capsules WHERE id = ? LIMIT 1";

// The delete: hard row delete, the GDPR shape. The statement's own WHERE
// carries all four seats — id, the URL's server namespace, author, and the
// deletable-until-reveal arm — so a raced reveal between the pre-check and
// this run answers changes 0 (the caller re-classifies as locked, never
// half-deletes), and a foreign-server URL never matches at all.
const CAPSULE_DELETE_SQL =
  "DELETE FROM gc_time_capsules WHERE id = ? AND server_id = ? AND author_id = ? AND reveal_at > ?";

// The create: ONE guarded statement (the coins-claim idiom) — the author's
// OPEN-capsule cap rides the INSERT's own WHERE arm, so a racing burst can
// never overshoot the cap; the loser answers changes 0 and gets the refusal.
const CAPSULE_CREATE_SQL =
  "INSERT INTO gc_time_capsules (author_id, server_id, channel_id, body, reveal_at, created_at) " +
    "SELECT ?, ?, ?, ?, ?, ? " +
    "WHERE (SELECT COUNT(*) FROM gc_time_capsules WHERE author_id = ? AND reveal_at > ?) < " +
      GC_CAPSULES_MAX_OPEN_PER_MEMBER;

// The shared member gate: non-members share the unknown-server 404 — no
// server-existence oracle.
const SHARED_UNKNOWN_SERVER_404 = "This server does not exist or you cannot view it.";

async function memberGate(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) throw new HttpError(404, SHARED_UNKNOWN_SERVER_404);
  return userId;
}

// The CREATE-time channel-target gate: the desk allows by not denying the
// author's SEND seat in that channel, so no second config table and no new
// toggle. The target must be a REAL channel of THIS server, else the 404
// shape (never a cross-server leak of another server's channel ids).
async function channelTargetGate(env, channelId, serverId, userId) {
  const channel = await channelForUser(env, channelId, userId);
  if (!channel || Number(channel.server_id) !== serverId) {
    throw new HttpError(404, "This channel does not exist or you cannot post there.");
  }
  await enforceChannelBits(env, channel, userId, ["VIEW", "SEND"]);
  return channelId;
}

function publicCapsule(row, body = undefined) {
  // The id seat rides ONLY a real row id: a create whose meta carries no
  // last_row_id (c17 LOW-4) ships NO id at all — Number(null) is 0, and an
  // id of 0 is a lie, not a seat.
  const capsule = {};
  if (row.id !== undefined && row.id !== null) capsule.id = Number(row.id);
  capsule.channelId = row.channel_id === null || row.channel_id === undefined
    ? null
    : Number(row.channel_id);
  capsule.revealAt = Number(row.reveal_at);
  capsule.sealed = true;
  if (body !== undefined) {
    capsule.sealed = false;
    capsule.body = body;
  }
  return capsule;
}

async function handleCapsuleCreateRoute(request, env, serverId, clock) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "write", "capsule:create:" + serverId + ":" + userId);
  const payload = await readJson(request);
  const rawBody = payload && typeof payload.body === "string" ? payload.body : "";
  const text = rawBody.trim();
  // The constant seats 2000 while migration 0052's CHECK backstop still
  // allows 4000 (schema_backstop_4000_vs_route_2000, c16 audit LOW-4): the
  // schema is the wider envelope, the stricter cap lives in the constant
  // only — no value change.
  if (text.length < 1 || text.length > GC_CAPSULE_BODY_MAX) {
    throw new HttpError(400, "Your letter needs between 1 and 2000 characters.");
  }
  const now = clock();
  const revealAt = payload?.revealAt;
  if (!Number.isInteger(revealAt) ||
    revealAt - now < GC_CAPSULE_MIN_AHEAD_SECONDS ||
    revealAt - now > GC_CAPSULE_MAX_AHEAD_SECONDS) {
    throw new HttpError(400, "That reveal time is out of the schedule's range.");
  }
  const rawChannelId = payload?.channelId;
  if (rawChannelId !== undefined && rawChannelId !== null && !Number.isInteger(rawChannelId)) {
    throw new HttpError(400, "That target channel is invalid.");
  }
  const channelId = rawChannelId === undefined || rawChannelId === null
    ? null
    : await channelTargetGate(env, rawChannelId, serverId, userId);

  const result = await env.GOOBER_DB.prepare(CAPSULE_CREATE_SQL).bind(
    userId, serverId, channelId, text, revealAt, now,
    userId, now,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(409, "Too many open capsules — let one reveal before you seal another.");
  }
  // The envelope's id seat rides ONLY a real integer last_row_id (c17
  // LOW-4): Number(null) is 0, so the old ?? null painted id: 0 — a lie.
  // The seat is additive-safe: no client consumer reads it (the panel
  // reloads its own lane).
  const lastRowId = result.meta?.last_row_id;
  const created = {
    channel_id: channelId,
    reveal_at: revealAt,
  };
  if (Number.isInteger(lastRowId)) created.id = lastRowId;
  return json(publicCapsule(created), 201);
}

async function handleCapsuleMineRoute(request, env, serverId, clock) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "capsule:mine:" + serverId + ":" + userId);
  const now = clock();
  const page = (await env.GOOBER_DB.prepare(CAPSULES_MINE_SQL)
    .bind(userId, serverId).all()).results || [];
  // The additive "more" seat (the bookmarks list idiom): the author's row
  // past the cap is no longer dropped silently — the probe answers whether
  // rows exist past the cap.
  const overCap = await env.GOOBER_DB.prepare(CAPSULES_MINE_PROBE_SQL)
    .bind(userId, serverId).first();
  // sealed recomputes per row against now — no stored state, no timers.
  return json({
    capsules: page.map((row) => ({
      ...publicCapsule(row),
      sealed: Number(row.reveal_at) > now,
    })),
    truncated: Boolean(overCap),
  });
}

async function handleCapsuleDeleteRoute(request, env, serverId, capsuleId, clock) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "write", "capsule:delete:" + serverId + ":" + userId);
  const now = clock();
  const row = await env.GOOBER_DB.prepare(CAPSULE_AUTHOR_READ_SQL)
    .bind(capsuleId, serverId, userId).first();
  if (!row) throw new HttpError(404, "This capsule does not exist or you cannot view it.");
  if (Number(row.reveal_at) <= now) {
    // The route's classification; the DELETE statement's own reveal_at > ?
    // arm remains the raced-reveal backstop (changes 0 re-answers this).
    throw new HttpError(409, "Your letter has been revealed — it stays where it was posted.");
  }
  const result = await env.GOOBER_DB.prepare(CAPSULE_DELETE_SQL)
    .bind(capsuleId, serverId, userId, now).run();
  if (Number(result.meta?.changes) !== 1) {
    // The pre-reveal check raced its reveal into the past (or the row moved
    // between the reads): the same locked answer either way.
    throw new HttpError(409, "Your letter has been revealed — it stays where it was posted.");
  }
  return json({ ok: true, id: Number(capsuleId) });
}

async function handleCapsuleRevealRoute(request, env, serverId, capsuleId, clock) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "capsule:reveal:" + serverId + ":" + userId);
  const now = clock();
  const authorArm = await env.GOOBER_DB.prepare(CAPSULE_AUTHOR_READ_SQL)
    .bind(capsuleId, serverId, userId).first();
  if (authorArm) {
    // The author: pre-postmark the SEALED shape only (the letter is read at
    // the postmark, not before — even from its writer); post-postmark, the
    // body. The author's control rides the delete route instead.
    if (Number(authorArm.reveal_at) > now) {
      return json(publicCapsule(authorArm));
    }
    const sealed = await env.GOOBER_DB.prepare(CAPSULE_BODY_READ_SQL)
      .bind(capsuleId).first();
    return json(publicCapsule(authorArm, sealed?.body ?? ""));
  }
  // The non-author arm: pre-postmark NOTHING answers (no existence oracle)
  // and a self-seal NEVER leaves its author. A revealed channel letter
  // rides the target channel's own VIEW gate.
  const row = await env.GOOBER_DB.prepare(CAPSULE_VIEW_READ_SQL)
    .bind(capsuleId, serverId).first();
  if (!row || Number(row.reveal_at) > now ||
    row.channel_id === null || row.channel_id === undefined) {
    throw new HttpError(404, "This capsule does not exist or it has not been revealed yet.");
  }
  const channel = await channelForUser(env, Number(row.channel_id), userId);
  if (!channel) {
    throw new HttpError(404, "This capsule does not exist or it has not been revealed yet.");
  }
  await enforceChannelBits(env, channel, userId, ["VIEW"]);
  const letter = await env.GOOBER_DB.prepare(CAPSULE_BODY_READ_SQL)
    .bind(capsuleId).first();
  return json(publicCapsule(row, letter?.body ?? ""));
}

// The optional clock seam (tests inject one fixed clock so the schedule's
// window edges cannot slip between the caller's read and the handler's);
// production rides the default real wall clock, unchanged.
export async function handleCapsuleRoutes(request, env, url, path, method, ctx, clock = nowSeconds) {
  void url;
  void ctx;

  const createMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/capsules$/)
    : null;
  if (createMatch) return handleCapsuleCreateRoute(request, env, Number(createMatch[1]), clock);

  const mineMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/capsules\/mine$/)
    : null;
  if (mineMatch) return handleCapsuleMineRoute(request, env, Number(mineMatch[1]), clock);

  const capsuleMatch = (method === "GET" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/capsules\/(0|[1-9][0-9]*)$/)
    : null;
  if (capsuleMatch) {
    const serverId = Number(capsuleMatch[1]);
    const capsuleId = Number(capsuleMatch[2]);
    return method === "GET"
      ? handleCapsuleRevealRoute(request, env, serverId, capsuleId, clock)
      : handleCapsuleDeleteRoute(request, env, serverId, capsuleId, clock);
  }

  return undefined;
}
