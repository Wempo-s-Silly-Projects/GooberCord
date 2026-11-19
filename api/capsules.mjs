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

// Time capsules (lane2-lifecycle recode, migration 0050): a letter to your
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
} from "../constants.mjs";
import { channelForUser, enforceChannelBits } from "./messages.mjs";

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The member's OWN list: the author seat rides INSIDE the read (no
// cross-member row is reachable by construction), and one indexed WHERE
// answers the whole page. No body column — the surprise stays sealed here.
const CAPSULES_MINE_SQL =
  "SELECT id, channel_id, reveal_at FROM gc_time_capsules " +
    "WHERE author_id = ? AND server_id = ? ORDER BY reveal_at ASC";

// The author read: the delete route's pre-check and the reveal gate's author
// arm. No body column — the letter stays sealed even from its writer.
const CAPSULE_AUTHOR_READ_SQL =
  "SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules " +
    "WHERE id = ? AND author_id = ? LIMIT 1";

// The reveal gate's non-author arm: the unfiltered by-id read, still with NO
// body column — it only classifies (pre-reveal 404 / self-seal 404 / channel
// VIEW gate). The body rides the post-reveal read alone.
const CAPSULE_VIEW_READ_SQL =
  "SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules WHERE id = ? LIMIT 1";

// THE body read — the one statement whose result carries the letter's text.
// Every caller reached it through a gate arm (the author read, or the
// channel VIEW gate), so authorization rides the reads before it.
const CAPSULE_BODY_READ_SQL = "SELECT body FROM gc_time_capsules WHERE id = ? LIMIT 1";

// The delete: hard row delete, the GDPR shape. The statement's own WHERE
// carries all three seats — author, id, and the deletable-until-reveal arm —
// so a raced reveal between the pre-check and this run answers changes 0
// (the caller re-classifies as locked, never half-deletes).
const CAPSULE_DELETE_SQL =
  "DELETE FROM gc_time_capsules WHERE id = ? AND author_id = ? AND reveal_at > ?";

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
  const capsule = {
    id: Number(row.id),
    channelId: row.channel_id === null || row.channel_id === undefined
      ? null
      : Number(row.channel_id),
    revealAt: Number(row.reveal_at),
    sealed: true,
  };
  if (body !== undefined) {
    capsule.sealed = false;
    capsule.body = body;
  }
  return capsule;
}

async function handleCapsuleCreateRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "write", "capsule:create:" + serverId + ":" + userId);
  const payload = await readJson(request);
  const rawBody = payload && typeof payload.body === "string" ? payload.body : "";
  const text = rawBody.trim();
  if (text.length < 1 || text.length > GC_CAPSULE_BODY_MAX) {
    throw new HttpError(400, "Your letter needs between 1 and 2000 characters.");
  }
  const now = nowSeconds();
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
  return json(publicCapsule({
    id: result.meta?.last_row_id ?? null,
    channel_id: channelId,
    reveal_at: revealAt,
  }), 201);
}

async function handleCapsuleMineRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "capsule:mine:" + serverId + ":" + userId);
  const now = nowSeconds();
  const page = (await env.GOOBER_DB.prepare(CAPSULES_MINE_SQL)
    .bind(userId, serverId).all()).results || [];
  // sealed recomputes per row against now — no stored state, no timers.
  return json({
    capsules: page.map((row) => ({
      ...publicCapsule(row),
      sealed: Number(row.reveal_at) > now,
    })),
  });
}

async function handleCapsuleDeleteRoute(request, env, serverId, capsuleId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "write", "capsule:delete:" + serverId + ":" + userId);
  const now = nowSeconds();
  const row = await env.GOOBER_DB.prepare(CAPSULE_AUTHOR_READ_SQL)
    .bind(capsuleId, userId).first();
  if (!row) throw new HttpError(404, "This capsule does not exist or you cannot view it.");
  if (Number(row.reveal_at) <= now) {
    // The route's classification; the DELETE statement's own reveal_at > ?
    // arm remains the raced-reveal backstop (changes 0 re-answers this).
    throw new HttpError(409, "Your letter has been revealed — it stays where it was posted.");
  }
  const result = await env.GOOBER_DB.prepare(CAPSULE_DELETE_SQL)
    .bind(capsuleId, userId, now).run();
  if (Number(result.meta?.changes) !== 1) {
    // The pre-reveal check raced its reveal into the past (or the row moved
    // between the reads): the same locked answer either way.
    throw new HttpError(409, "Your letter has been revealed — it stays where it was posted.");
  }
  return json({ ok: true, id: Number(capsuleId) });
}

async function handleCapsuleRevealRoute(request, env, serverId, capsuleId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "capsule:reveal:" + serverId + ":" + userId);
  const now = nowSeconds();
  const authorArm = await env.GOOBER_DB.prepare(CAPSULE_AUTHOR_READ_SQL)
    .bind(capsuleId, userId).first();
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
    .bind(capsuleId).first();
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

export async function handleCapsuleRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const createMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/capsules$/)
    : null;
  if (createMatch) return handleCapsuleCreateRoute(request, env, Number(createMatch[1]));

  const mineMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/capsules\/mine$/)
    : null;
  if (mineMatch) return handleCapsuleMineRoute(request, env, Number(mineMatch[1]));

  const capsuleMatch = (method === "GET" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/capsules\/(0|[1-9][0-9]*)$/)
    : null;
  if (capsuleMatch) {
    const serverId = Number(capsuleMatch[1]);
    const capsuleId = Number(capsuleMatch[2]);
    return method === "GET"
      ? handleCapsuleRevealRoute(request, env, serverId, capsuleId)
      : handleCapsuleDeleteRoute(request, env, serverId, capsuleId);
  }

  return undefined;
}
