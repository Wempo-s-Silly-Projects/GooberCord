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

// Phase-3 social layer: the friend graph, the two-tier block table, and
// message reactions — the routes the friends hub, the profile/context
// affordances, and the message hover bar ride.
//
// Authorization follows the module-wide rule (api/permissions.mjs): the
// guards ride INSIDE the SQL. Every friend/block write is a one-row DELETE /
// INSERT-or-UPSERT whose WHERE pins the caller to the (blocker|requester)
// side of the row (or the target side for the accept/decline pair), so a
// refused action never changes a row it cannot even see. Friend reads join
// users on the OTHER side of the canonical pair — the CASE expression is the
// either-direction lookup's whole cost.
//
// Reactions: add/see via the channel-access gate (the same CHANNEL_ACCESS_SQL
// messages.mjs exports — one shared source of truth for "can this viewer
// touch this channel"), remove-own authorless, and MOD removal carries the
// moderation guard (the mod desk's DELETE_MESSAGES class, replicated from
// api/servers.mjs's moderationGuardSql so the two never gate differently —
// servers.mjs keeps its own because its routes bind the server id directly,
// while a reaction has to RESOLVE the server through the message's channel).
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { channelForUser, enforceChannelBits, enforceMemberGatesForChannel } from "./messages.mjs";
import { SERVER_PERMISSIONS, holdsRolesBitsSql, holdsRolesBitsParams } from "./permissions.mjs";
import { plusActiveExpr, plusMemberActive, plusPerkActive, publicIsPlus } from "./plus.mjs";
import { GC_COSMETIC_FX_BURST_ITEM, GC_PLUS_REACTIONS, GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE } from "../constants.mjs";

// The parity law reads Discord's real caps directly (verified 2026-11-17):
// docs/parity-limits.md — Friends 1000. Discord's cap is also cheap insurance
// on both sides of the graph, so the mirror constant rides the row.
const MAX_FRIENDS = 1000;
const MAX_PENDING_REQUESTS = 20;
// Matches the route-id conventions (bare ids, bounded width).
const MAX_ID = 1e15;
// The reaction picker's whole vocabulary: the RENDERED emoji (or shortname),
// capped at 32 by the schema CHECK — mirrors that cap here so oversized
// bodies 400 instead of 500-ing.
const MAX_EMOJI_LENGTH = 32;
const BLOCK_KINDS = ["blocked", "ignored"];
// The platform-staff tier (users.role) can never be the target of a block:
// the owner bypass sits on every filed guard, and the client hides the
// affordance against them anyway.
const STAFF_ROLES = ["owner", "admin"];

// Canonical friendship pairs: INSERT with (MIN, MAX) computed here, so the
// CHECK(user_a_id < user_b_id) is a data invariant the routes never trip.
function canonicalPair(aId, bId) {
  return aId < bId ? [aId, bId] : [bId, aId];
}

// The pending-request row's read-side join: the OTHER user's public shape.
// The is_plus badge rides both templates here (plusActiveExpr's `?` sits in
// the SELECT list, so its `now` bind precedes every WHERE bind — callers
// prepend nowSeconds() in textual order).
const FRIEND_ROW_SELECT =
  "SELECT u.id AS user_id, u.username AS username, r.created_at AS created_at, " +
    plusActiveExpr("u.id") + " FROM ";

// The three-facet hub read: accepted friends (either direction of the pair),
// pending sent (requester side), pending received (target side). One read
// each, never a per-user loop.
//
// The friends facet does NOT share the row template above: that template's
// `r.created_at` names the pending-requests alias (`r`), and the friends read
// aliases the pair table (`f`), so a templated friends SELECT failed at the
// runtime table check with "no such column: r.created_at" — a 500 on every
// /api/friends read the fakeDb could not see (real SQLite pins it below in
// tests/social-sqlite.test.mjs). The friend SELECT carries its own column.
const FRIENDS_LIST_SQL =
  "SELECT u.id AS user_id, u.username AS username, f.created_at AS created_at, " +
    plusActiveExpr("u.id") + " FROM " +
  "gc_friends f JOIN users u ON u.id = " +
  "(CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END) " +
  "WHERE f.user_a_id = ? OR f.user_b_id = ?";

const PENDING_SENT_SQL =
  FRIEND_ROW_SELECT + "gc_friend_requests r JOIN users u ON u.id = r.target_id " +
  "WHERE r.requester_id = ?";

const PENDING_RECEIVED_SQL =
  FRIEND_ROW_SELECT + "gc_friend_requests r JOIN users u ON u.id = r.requester_id " +
  "WHERE r.target_id = ?";

// The two-block lookup (either direction) shared by the friend-request gate:
// no request between a BLOCKED pair survives (filed: mutual, invisible). The
// 'ignored' rows stay out of the read — the soft tier is cosmetic, so an
// ignore never refuses a request either direction might have wanted to send.
const BLOCKED_PAIR_SQL =
  "SELECT 1 FROM gc_blocks WHERE ((blocker_id = ? AND blocked_id = ?) " +
  "OR (blocker_id = ? AND blocked_id = ?)) AND kind = 'blocked' LIMIT 1";

// The friend-state read the roster/DM payloads need (the client mirrors it
// from the hub payload; this one feeds the server gates).
const FRIENDSHIP_EXISTS_SQL =
  "SELECT 1 FROM gc_friends WHERE (user_a_id = ? AND user_b_id = ?) " +
  "OR (user_a_id = ? AND user_b_id = ?) LIMIT 1";

// The per-user preference row: absent row = everyone-can-request (the filed
// default), so the read COALESCEs and no backfill UPDATE ever targets users.
const REQUEST_GATE_SQL =
  "SELECT COALESCE((SELECT accept_requests FROM gc_social_prefs WHERE user_id = ?), 1) AS accept_requests";

// The friend-REQUEST count caps: one COUNT read each, only reached when the
// graph check passes (cheap insurance, filed).
const PENDING_SENT_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM gc_friend_requests WHERE requester_id = ?";
const FRIENDS_COUNT_SQL =
  "SELECT (SELECT COUNT(*) FROM gc_friends WHERE user_a_id = ?) + " +
    "(SELECT COUNT(*) FROM gc_friends WHERE user_b_id = ?) AS n";

// The friendship + request rows a BLOCKED state dissolves (filed: block
// removes friendship and pending requests between the pair, same batch).
const FRIEND_DELETE_SQL =
  "DELETE FROM gc_friends WHERE (user_a_id = ? AND user_b_id = ?) " +
    "OR (user_a_id = ? AND user_b_id = ?)";
const REQUEST_DELETE_SQL =
  "DELETE FROM gc_friend_requests WHERE (requester_id = ? AND target_id = ?) " +
    "OR (requester_id = ? AND target_id = ?)";

// The reaction reads/writes. The grouped detail read joins users for the
// per-emoji member lists the View-Reactions dialog renders. The fx_burst
// column (0057) rides the SELECT: the cosmetics effects arm (Phase 3) flags
// the rows its spend lands on, and the reads echo the flag ADDITIVELY — a
// row without the flag keeps the exact payload shape it always had.
const REACTION_GROUPED_SQL =
  "SELECT r.emoji AS emoji, r.user_id AS user_id, u.username AS username, r.fx_burst AS fx_burst " +
  "FROM gc_message_reactions r JOIN users u ON u.id = r.user_id " +
  "WHERE r.message_id = ? ORDER BY r.emoji, r.created_at, r.user_id";
// The message's reactions ride the LIST payload as one grouped read per page
// (api/messages.mjs imports this SQL — a single source of truth with this file).
export const MESSAGE_REACTIONS_GROUPED_SQL = REACTION_GROUPED_SQL;

// The cosmetics effects arm (the 2026-11-19 slate's Phase 3): a fresh
// reaction ADD by a member whose EQUIPPED fx_burst pack still holds uses
// spends exactly one use and pins the burst flag onto the minted row. The
// pair is ONE batch (one transaction), and each statement carries the WHOLE
// guard set so the decrement and the flag land together or not at all — the
// flag rides FIRST (its arms read the PRE-state: the row is unflagged and
// the pack is live), the consume rides SECOND (its arms: the pack's qty
// floor and the flag THERE — visible only because the batch is one
// transaction). A loser is all-zero with the original pack row surviving
// (the economy-skill law 3 shape, Phase 1's purchase idiom).
const BURST_FLAG_SQL =
  "UPDATE gc_message_reactions SET fx_burst = 1 " +
  "WHERE message_id = ? AND user_id = ? AND emoji = ? AND fx_burst = 0 AND EXISTS (" +
    "SELECT 1 FROM gc_cosmetic_inventory iv WHERE iv.user_id = ? AND iv.item_key = ? " +
    "AND iv.kind = 'consumable' AND iv.equipped = 1 AND iv.qty > 0)";
const BURST_CONSUME_SQL =
  "UPDATE gc_cosmetic_inventory SET qty = qty - 1, updated_at = ? " +
  "WHERE user_id = ? AND item_key = ? AND kind = 'consumable' AND equipped = 1 AND qty > 0 AND EXISTS (" +
    "SELECT 1 FROM gc_message_reactions r WHERE r.message_id = ? AND r.user_id = ? " +
    "AND r.emoji = ? AND r.fx_burst = 1)";

// --- the moderation guard (replicated from api/servers.mjs) ----------------------
//
// Same three fragments servers.mjs builds its guard from — the string-tier
// owner row, the per-bit role EXISTS (exact OR — SUM carried duplicate bits
// into phantom higher bits), and the two hierarchy positions. Kept verbatim
// (including the bind order) because the mod desk's routes and this
// route must refuse the same actor/target pairs.

const TOP_POSITION_SELECT =
  "(SELECT COALESCE(MAX(hr.position), -1) FROM gc_member_roles hmr " +
    "JOIN gc_roles hr ON hr.id = hmr.role_id " +
    "WHERE hmr.server_id = ? AND hmr.user_id = ?)";

const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// moderationGuardSql(serverId, actorId, targetId, bits): the mod-desk family
// guard — actor is the string-tier owner, OR holds EVERY bit (one per-bit
// EXISTS arm per bit, exact OR semantics) AND outranks the target (strictly
// greater top position).
function moderationGuardSql(serverId, actorId, targetId, bits) {
  const list = Array.isArray(bits) ? bits : [bits];
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR (" +
        holdsRolesBitsSql(list) + " AND " +
        TOP_POSITION_SELECT + " > " + TOP_POSITION_SELECT + "))",
    params: [serverId, actorId, ...holdsRolesBitsParams(serverId, actorId, list), serverId, actorId, serverId, targetId],
  };
}

// --- friends ---------------------------------------------------------------------

function friendPayload(row) {
  return {
    userId: Number(row.user_id),
    username: row.username,
    createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
    isPlus: publicIsPlus(row),
  };
}

async function handleSendFriendRequestRoute(request, env) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "friend-request:" + session.user.id);
  const body = await readJson(request);
  const selfId = Number(session.user.id);

  // Accept a username OR a user id (the profile-card affordance rides the id):
  // exactly one of the two, so an ambiguous body is a 400 rather than a
  // surprise resolution.
  const hasUsername = typeof body.username === "string" && body.username.trim().length > 0;
  const hasUserId = body.userId !== undefined && body.userId !== null;
  if (hasUsername === hasUserId) {
    throw new HttpError(400, "Send a username or a user id for the friend request.");
  }

  let target = null;
  if (hasUsername) {
    const username = body.username.trim();
    if (username.length > 32) {
      throw new HttpError(400, "That request didn't work. Double check that the username is correct.");
    }
    // The normalized key (login/register/coins all ride username_key): a
    // request by any casing of the name resolves the one unique row, and the
    // SELECT returns the display casing untouched.
    target = await env.GOOBER_DB.prepare(
      "SELECT id, username, role FROM users WHERE username_key = ? LIMIT 1",
    ).bind(username.toLowerCase()).first();
  } else {
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId < 1 || userId >= MAX_ID) {
      throw new HttpError(400, "That request didn't work. Double check that the name is correct.");
    }
    target = await env.GOOBER_DB.prepare(
      "SELECT id, username, role FROM users WHERE id = ? LIMIT 1",
    ).bind(userId).first();
  }

  // The filed miss copy, verbatim: a miss and an idle 400 carry the same
  // shape (no oracle for which usernames EXIST beyond this one refused row).
  if (!target) {
    throw new HttpError(400, "That request didn't work. Double check that the username is correct.");
  }
  const targetId = Number(target.id);
  if (targetId === selfId) {
    throw new HttpError(400, "That request didn't work. Double check that the username is correct.");
  }

  const friendRow = await env.GOOBER_DB.prepare(FRIENDSHIP_EXISTS_SQL)
    .bind(selfId, targetId, targetId, selfId).first();
  if (friendRow) {
    throw new HttpError(400, "You're already friends with that user.");
  }

  const pendingRow = await env.GOOBER_DB.prepare(
    "SELECT 1 FROM gc_friend_requests WHERE (requester_id = ? AND target_id = ?) " +
      "OR (requester_id = ? AND target_id = ?) LIMIT 1",
  ).bind(selfId, targetId, targetId, selfId).first();
  if (pendingRow) {
    throw new HttpError(400, "That friend request is already pending.");
  }

  // The filed gate (Everyone vs OFF): the target's prefs row answers, then
  // the blocks pair (either direction refuses — mutual, invisible). Order is
  // deliberate: the prefs copy is the FILED "not accepting requests" copy, so
  // it wins over the silent blocks refusal.
  const gate = await env.GOOBER_DB.prepare(REQUEST_GATE_SQL).bind(targetId).first();
  if (Number(gate?.accept_requests) === 0) {
    throw new HttpError(400, "This user isn't accepting friend requests right now.");
  }

  const blockedRow = await env.GOOBER_DB.prepare(BLOCKED_PAIR_SQL)
    .bind(selfId, targetId, targetId, selfId).first();
  if (blockedRow) {
    throw new HttpError(400, "You can't send a friend request to that user.");
  }

  // The caps are cheap insurance (filed): the sender's own pending count and
  // the parity law's 1000-friend ceiling (docs/parity-limits.md: Friends
  // 1000). A request that would be a duplicate friendship is already refused
  // above.
  const sent = await env.GOOBER_DB.prepare(PENDING_SENT_COUNT_SQL).bind(selfId).first();
  if (Number(sent?.n) >= MAX_PENDING_REQUESTS) {
    throw new HttpError(400, "That's too many pending requests — wait for a few to settle first.");
  }
  const friends = await env.GOOBER_DB.prepare(FRIENDS_COUNT_SQL)
    .bind(selfId, selfId).first();
  if (Number(friends?.n) >= MAX_FRIENDS) {
    throw new HttpError(400, "Your friends list is full.");
  }

  const result = await env.GOOBER_DB.prepare(
    "INSERT INTO gc_friend_requests (requester_id, target_id, created_at) " +
      "VALUES (?, ?, ?) ON CONFLICT(requester_id, target_id) DO NOTHING",
  ).bind(selfId, targetId, nowSeconds()).run();

  return json({
    request: {
      userId: targetId,
      username: target.username,
      direction: "sent",
      // A duplicate INSERT (a parallel tab won the race) stays a 200-shaped
      // no-op row: the pending read above already made this idempotent.
      existed: Number(result?.meta?.changes) !== 1,
    },
  }, 201);
}

async function handleFriendRequestDecisionRoute(request, env, decision) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "friend-request:" + session.user.id);
  const body = await readJson(request);
  const selfId = Number(session.user.id);

  const requesterId = Number(body.userId);
  if (!Number.isInteger(requesterId) || requesterId < 1 || requesterId >= MAX_ID) {
    throw new HttpError(400, "Send the requester's user id.");
  }
  if (requesterId === selfId) {
    throw new HttpError(404, "That friend request doesn't exist.");
  }

  // The accepter is the TARGET side: the DELETE's WHERE pins both sides, so a
  // non-target (nor the requester themself) can never settle this row, and a
  // zero-change delete answers the outsider 404 without touching anything.
  const removed = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_friend_requests WHERE requester_id = ? AND target_id = ?",
  ).bind(requesterId, selfId).run();
  if (Number(removed?.meta?.changes) !== 1) {
    throw new HttpError(404, "That friend request doesn't exist.");
  }

  if (decision === "declined") {
    return json({ ok: true, decision: "declined" });
  }

  // Accept: the friendship INSERT rides the canonical pair and ignores a
  // duplicate (a parallel accept never re-trips the CHECK).
  const [userAId, userBId] = canonicalPair(selfId, requesterId);
  await env.GOOBER_DB.prepare(
    "INSERT INTO gc_friends (user_a_id, user_b_id, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_a_id, user_b_id) DO NOTHING",
  ).bind(userAId, userBId, nowSeconds()).run();

  const target = await env.GOOBER_DB.prepare(
    "SELECT username FROM users WHERE id = ? LIMIT 1",
  ).bind(requesterId).first();

  return json({
    ok: true,
    decision: "accepted",
    friend: { userId: requesterId, username: target?.username || null },
  }, 200);
}

async function handleCancelFriendRequestRoute(request, env, targetUserId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "friend-request:" + session.user.id);
  const selfId = Number(session.user.id);

  // The requester's own X (the filed cancel-outgoing affordance): the same
  // two-sided DELETE as the decisions, minus the accept.
  const removed = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_friend_requests WHERE requester_id = ? AND target_id = ?",
  ).bind(selfId, Number(targetUserId)).run();
  if (Number(removed?.meta?.changes) !== 1) {
    throw new HttpError(404, "That friend request doesn't exist.");
  }
  return json({ ok: true });
}

async function handleUnfriendRoute(request, env, targetUserId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "friend:" + session.user.id);
  const selfId = Number(session.user.id);
  const [userAId, userBId] = canonicalPair(selfId, Number(targetUserId));

  // Either side may unfriend (filed), so the canonical pair IS the WHERE —
  // and a refused call deletes nothing it would have been allowed to.
  const removed = await env.GOOBER_DB.prepare(FRIEND_DELETE_SQL)
    .bind(userAId, userBId, userBId, userAId).run();
  if (Number(removed?.meta?.changes) !== 1) {
    throw new HttpError(404, "You aren't friends with that user.");
  }
  return json({ ok: true });
}

async function handleListFriendsRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const selfId = Number(session.user.id);

  const [friends, sent, received, gate] = await Promise.all([
    env.GOOBER_DB.prepare(FRIENDS_LIST_SQL).bind(nowSeconds(), selfId, selfId, selfId).all(),
    env.GOOBER_DB.prepare(PENDING_SENT_SQL).bind(nowSeconds(), selfId).all(),
    env.GOOBER_DB.prepare(PENDING_RECEIVED_SQL).bind(nowSeconds(), selfId).all(),
    env.GOOBER_DB.prepare(REQUEST_GATE_SQL).bind(selfId).first(),
  ]);

  return json({
    friends: (friends.results || []).map(friendPayload),
    pendingSent: (sent.results || []).map(friendPayload),
    pendingReceived: (received.results || []).map(friendPayload),
    settings: { acceptRequests: Number(gate?.accept_requests ?? 1) === 1 },
  });
}

async function handleUpdateFriendSettingsRoute(request, env) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "settings:" + session.user.id);
  const body = await readJson(request);
  const selfId = Number(session.user.id);

  // The binary filed form: true/false (the "Everyone" / "OFF" selector).
  if (typeof body.acceptRequests !== "boolean") {
    throw new HttpError(400, "Send acceptRequests as true or false.");
  }
  const value = body.acceptRequests ? 1 : 0;

  // gc_social_prefs is the ONLY table this touches (users stays read-only):
  // one upsert per user, the missing-row case rides the insert.
  await env.GOOBER_DB.prepare(
    "INSERT INTO gc_social_prefs (user_id, accept_requests, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET accept_requests = excluded.accept_requests, " +
      "updated_at = excluded.updated_at",
  ).bind(selfId, value, nowSeconds()).run();

  return json({ settings: { acceptRequests: value === 1 } });
}

// --- blocks ----------------------------------------------------------------------

function blockPayload(row) {
  return {
    userId: Number(row.user_id || row.blocked_id),
    username: row.username || null,
    kind: row.kind,
    createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
  };
}

async function handlePutBlockRoute(request, env, targetRaw) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "block:" + session.user.id);
  const body = await readJson(request);
  const selfId = Number(session.user.id);

  const userId = Number(targetRaw);
  if (!Number.isInteger(userId) || userId < 1 || userId >= MAX_ID) {
    throw new HttpError(400, "That user id is invalid.");
  }
  if (userId === selfId) {
    throw new HttpError(400, "You can't block yourself.");
  }
  const kind = body.kind;
  if (!BLOCK_KINDS.includes(kind)) {
    throw new HttpError(400, "Send kind as 'blocked' or 'ignored'.");
  }

  const target = await env.GOOBER_DB.prepare(
    "SELECT id, username, role FROM users WHERE id = ? LIMIT 1",
  ).bind(userId).first();
  if (!target) throw new HttpError(400, "That user doesn't exist.");
  if (STAFF_ROLES.includes(String(target.role))) {
    throw new HttpError(400, "You can't block that account.");
  }

  const now = nowSeconds();
  // The filed block side effects ride the SAME batch as the row's own upsert,
  // but ONLY for the hard tier ('blocked'): the friendship and any pending
  // requests between the pair dissolve together. An 'ignored' upsert changes
  // nothing else — ignore is cosmetic by contract. The deletes are either-
  // direction reads of the canonical pair (and both request directions), and
  // their zero-change results are NOT errors: a block with no friendship
  // still lands.
  const statements = [
    env.GOOBER_DB.prepare(
      "INSERT INTO gc_blocks (blocker_id, blocked_id, kind, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(blocker_id, blocked_id) DO UPDATE SET " +
        "kind = excluded.kind, created_at = excluded.created_at",
    ).bind(selfId, userId, kind, now),
  ];
  if (kind === "blocked") {
    statements.push(
      env.GOOBER_DB.prepare(FRIEND_DELETE_SQL).bind(selfId, userId, userId, selfId),
      env.GOOBER_DB.prepare(REQUEST_DELETE_SQL).bind(selfId, userId, userId, selfId),
    );
  }
  const results = await env.GOOBER_DB.batch(statements);
  if (Number(results[0]?.meta?.changes) !== 1) {
    throw new HttpError(500, "The block could not be saved. Please try again.");
  }

  return json({ block: { userId, username: target.username, kind, createdAt: new Date(now * 1000).toISOString() } });
}

async function handleDeleteBlockRoute(request, env, targetRaw) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "block:" + session.user.id);
  const selfId = Number(session.user.id);
  const userId = Number(targetRaw);
  if (!Number.isInteger(userId) || userId < 1 || userId >= MAX_ID) {
    throw new HttpError(400, "That user id is invalid.");
  }

  // Unblock/unignore: the caller's own row only (the blocker side is the
  // WHERE's first arm, so a blocked user can never delete another's block).
  const removed = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_blocks WHERE blocker_id = ? AND blocked_id = ?",
  ).bind(selfId, userId).run();
  if (Number(removed?.meta?.changes) !== 1) {
    throw new HttpError(404, "That account isn't blocked or ignored.");
  }
  return json({ ok: true });
}

async function handleListBlocksRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const selfId = Number(session.user.id);

  const rows = (await env.GOOBER_DB.prepare(
    "SELECT b.blocked_id AS blocked_id, b.kind AS kind, b.created_at AS created_at, " +
    "u.username AS username FROM gc_blocks b LEFT JOIN users u ON u.id = b.blocked_id " +
    "WHERE b.blocker_id = ? ORDER BY b.kind, u.username",
  ).bind(selfId).all()).results || [];

  return json({ blocked: rows.map(blockPayload) });
}

// --- reactions ---------------------------------------------------------------------

async function readReactionMessage(env, messageId) {
  const message = await env.GOOBER_DB.prepare(
    "SELECT m.id AS id, m.channel_id AS channel_id FROM gc_messages m WHERE m.id = ? LIMIT 1",
  ).bind(messageId).first();
  if (!message) throw new HttpError(404, "Message not found.");
  return message;
}

function emojiFromBody(body) {
  const raw = typeof body.emoji === "string" ? body.emoji.trim() : "";
  if (!raw || raw.length > MAX_EMOJI_LENGTH) {
    throw new HttpError(400, "Send an emoji shorter than " + (MAX_EMOJI_LENGTH + 1) + " characters.");
  }
  return raw;
}

// The cosmetics effects arm (Phase 3): ONE batch — the flag statement first,
// the consume second (each carrying the WHOLE guard set, see BURST_FLAG_SQL).
// Answer truth: "the effect fired" IS "the pack spent one use" ("the consume
// fired"). Never a thrower: the caller wraps it best-effort (the reaction
// never fails for the effect — the coin grant / timeout rides carry the same
// discipline).
async function fireReactionBurstArm(env, messageId, userId, emoji) {
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(BURST_FLAG_SQL).bind(
      messageId, userId, emoji, userId, GC_COSMETIC_FX_BURST_ITEM,
    ),
    env.GOOBER_DB.prepare(BURST_CONSUME_SQL).bind(
      nowSeconds(), userId, GC_COSMETIC_FX_BURST_ITEM, messageId, userId, emoji,
    ),
  ]);
  return Number(results?.[1]?.meta?.changes) === 1;
}

// PUT = the toggle-on gate: channel access first, then the member-state gates
// (the mod desk's timed-out pair — a timed-out member cannot ADD a reaction),
// then the INSERT-or-ignore. Already-present rows are idempotent 200s.
async function handleAddReactionRoute(request, env, messageId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "react:" + session.user.id);
  const body = await readJson(request);
  const emoji = emojiFromBody(body);
  const selfId = Number(session.user.id);

  const message = await readReactionMessage(env, messageId);
  const channel = await channelForUser(env, Number(message.channel_id), selfId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");

  // The super-reaction tier (0020; re-tiered by the 2026-11-17 matrix): a
  // sparkle-set emoji is a Goober+ perk that rides MINI too, so the
  // MINI-INCLUSIVE predicate answers BEFORE the overwrite gates — a
  // grace-window member still reads as a plain member here (the badge stays,
  // the perk does not). Channel bits next, exactly as the plain reaction had it.
  if (GC_PLUS_REACTIONS.includes(emoji) && !(await plusMemberActive(env, selfId, nowSeconds()))) {
    throw new HttpError(403, "Super reactions are a Goober+ perk.");
  }

  // VIEW for the read, ADD_REACTIONS for the write (the one NEW mask bit the
  // reactions feature slotted in — a channel deny layer strips it like SEND);
  // the graceful default keeps deny-free servers reacting exactly as before.
  await enforceChannelBits(env, channel, selfId, ["VIEW", "ADD_REACTIONS"]);
  // The filed addition gate: timeouts answer here (403), removal never runs it.
  await enforceMemberGatesForChannel(env, Number(message.channel_id), selfId);

  // The unique-emoji ceiling (parity law, docs/parity-limits.md: unique emoji
  // per message 20 — Discord error 30010, verified 2026-11-17) folded INTO the
  // INSERT as its own WHERE arm. The verifier's race point: the old read-
  // then-insert pair let two concurrent first-adds at cap-1 both pass the
  // read and overshoot to cap+1 — DISTINCT statements can interleave, one
  // statement's subquery cannot. Allowed iff the caller already holds THIS
  // emoji on the message (their repeat — the per-emoji reactor count stays
  // unlimited) OR the message's distinct-emoji count sits below the ceiling.
  // A zero-change INSERT is classified by one EXISTS re-read: an already-held
  // row replays 201 (the idempotent verdict), a genuine cap refusal answers
  // the filed copy verbatim.
  const cap = GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE;
  // GO-HAYWIRE cycle-2 fix 2: the old INSERT..SELECT admitted the caller's
  // ALREADY-HELD emoji through its EXISTS arm and the composite PK then
  // threw UNIQUE on real SQLite — every repeat PUT 500ed and the held-replay
  // branch below was unreachable. INSERT OR IGNORE makes changes = 1 mean
  // exactly "a fresh row landed" (the burst verdict's premise), the held
  // case is IGNOREd (no cap math involved — a hold replays 201 even at
  // cap), and a genuine cap refusal still classifies by the re-read.
  const insert = await env.GOOBER_DB.prepare(
    "INSERT OR IGNORE INTO gc_message_reactions (message_id, user_id, emoji, created_at) " +
      "SELECT ?, ?, ?, ? " +
      "WHERE (SELECT COUNT(DISTINCT emoji) FROM gc_message_reactions WHERE message_id = ?) < " + cap,
  ).bind(
    Number(message.id), selfId, emoji, nowSeconds(),
    Number(message.id),
  ).run();

  if (Number(insert?.meta?.changes) === 1) {
    // The cosmetics effects arm rides the verdict (Phase 3): a fresh ADD by
    // an equipped pack holder spends one use and flags the row. Best-effort —
    // the burst never fails the reaction (the timeout/grant rides carry the
    // same discipline).
    let burst = false;
    try {
      burst = await fireReactionBurstArm(env, Number(message.id), selfId, emoji);
    } catch (error) {
      console.error("Cosmetic burst arm failed:", error?.name || "UnknownError", {
        messageId: Number(message.id),
        userId: selfId,
      });
    }
    return json({ reaction: {
      messageId: Number(message.id), emoji, userId: selfId, mine: true,
      ...(burst ? { fxBurst: true } : {}),
    } }, 201);
  }

  const held = await env.GOOBER_DB.prepare(
    "SELECT 1 AS held FROM gc_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? LIMIT 1",
  ).bind(Number(message.id), selfId, emoji).first();
  if (held) {
    return json({ reaction: { messageId: Number(message.id), emoji, userId: selfId, mine: true } }, 201);
  }

  throw new HttpError(
    400,
    `This message already has ${GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE} different reactions.`,
  );
}

// DELETE without ?user_id= = the toggle-off of the CALLER'S OWN reaction (a
// zero-change delete is a 404, never a silent no-op). ?user_id= flips to MOD
// removal and carries the moderation guard (the DELETE_MESSAGES class —
// Manage Messages parity) with the hierarchy inside the SQL.
async function handleRemoveReactionRoute(request, env, messageId, url) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "react:" + session.user.id);
  const emoji = emojiFromBody(await readJson(request));
  const selfId = Number(session.user.id);

  const targetRaw = url.searchParams.get("user_id");
  let targetUserId = selfId;
  if (targetRaw !== null && targetRaw !== "") {
    targetUserId = Number(targetRaw);
    if (!Number.isInteger(targetUserId) || targetUserId < 1 || targetUserId >= MAX_ID) {
      throw new HttpError(400, "That user id is invalid.");
    }
    if (targetUserId === selfId) {
      throw new HttpError(400, "Remove your own reaction with your own request.");
    }
  }

  const message = await readReactionMessage(env, messageId);

  if (targetUserId !== selfId) {
    // The channel's server must exist (a dm/group message has no moderation
    // tier at all), and the actor must outrank the target — same guard body
    // as the kick/ban family, bound over the resolved server.
    const channelRow = await env.GOOBER_DB.prepare(
      "SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1",
    ).bind(Number(message.channel_id)).first();
    const serverId = Number(channelRow?.server_id);
    if (!Number.isInteger(serverId) || serverId < 1) {
      throw new HttpError(403, "Only the author can remove that reaction.");
    }
    const guard = moderationGuardSql(serverId, selfId, targetUserId, [
      SERVER_PERMISSIONS.DELETE_MESSAGES,
    ]);
    const modResult = await env.GOOBER_DB.prepare(
      "DELETE FROM gc_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? AND " +
        guard.sql,
    ).bind(Number(message.id), targetUserId, emoji, ...guard.params).run();
    if (Number(modResult?.meta?.changes) !== 1) {
      throw new HttpError(403, "You do not have permission to do that.");
    }
    return json({ removed: { messageId: Number(message.id), emoji, userId: targetUserId } });
  }

  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
  ).bind(Number(message.id), selfId, emoji).run();
  if (Number(result?.meta?.changes) !== 1) {
    throw new HttpError(404, "That reaction doesn't exist.");
  }
  return json({ removed: { messageId: Number(message.id), emoji, userId: selfId } });
}

async function handleListReactionsRoute(request, env, messageId) {
  const session = await requireSignedInRead(request, env);
  const selfId = Number(session.user.id);

  const message = await readReactionMessage(env, messageId);
  const channel = await channelForUser(env, Number(message.channel_id), selfId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");
  await enforceChannelBits(env, channel, selfId, ["VIEW"]);

  const rows = (await env.GOOBER_DB.prepare(REACTION_GROUPED_SQL)
    .bind(Number(message.id)).all()).results || [];

  // Grouped per-emoji for the details dialog: one row per emoji carrying its
  // whole user list (the dialog renders who reacted what, with the caller's
  // own X marked by the userId comparison client-side).
  const byEmoji = new Map();
  for (const row of rows) {
    const key = String(row.emoji);
    const entry = byEmoji.get(key) || { emoji: key, users: [] };
    // The fx_burst echo (Phase 3): ADDITIVE — flagged rows gain fxBurst, an
    // unflagged row keeps the exact entry shape it always had.
    entry.users.push(row.fx_burst
      ? { id: Number(row.user_id), username: row.username, fxBurst: true }
      : { id: Number(row.user_id), username: row.username });
    byEmoji.set(key, entry);
  }

  return json({ messageId: Number(message.id), reactions: [...byEmoji.values()] });
}

// --- dispatch ----------------------------------------------------------------------

export async function handleSocialRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) completes the dispatch loop's
  // handler signature; these routes schedule no background work today.
  void ctx;

  if (path === "/api/friends/requests" && method === "POST") {
    return handleSendFriendRequestRoute(request, env);
  }
  if ((path === "/api/friends/requests/accept" || path === "/api/friends/requests/decline") &&
      method === "POST") {
    return handleFriendRequestDecisionRoute(
      request, env, path.endsWith("/accept") ? "accepted" : "declined",
    );
  }
  const cancelMatch = method === "DELETE"
    ? path.match(/^\/api\/friends\/requests\/([1-9][0-9]{0,14})$/)
    : null;
  if (cancelMatch) return handleCancelFriendRequestRoute(request, env, Number(cancelMatch[1]));

  if (path === "/api/friends" && method === "GET") {
    return handleListFriendsRoute(request, env);
  }
  if (path === "/api/friends/settings" && method === "PUT") {
    return handleUpdateFriendSettingsRoute(request, env);
  }
  const friendMatch = method === "DELETE"
    ? path.match(/^\/api\/friends\/([1-9][0-9]{0,14})$/)
    : null;
  if (friendMatch) return handleUnfriendRoute(request, env, Number(friendMatch[1]));

  if (path === "/api/blocks" && method === "GET") {
    return handleListBlocksRoute(request, env);
  }
  const blockMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/blocks\/([1-9][0-9]{0,14})$/)
    : null;
  if (blockMatch) {
    return method === "PUT"
      ? handlePutBlockRoute(request, env, Number(blockMatch[1]))
      : handleDeleteBlockRoute(request, env, Number(blockMatch[1]));
  }

  const reactionsMatch = method === "GET"
    ? path.match(/^\/api\/messages\/([1-9][0-9]{0,14})\/reactions$/)
    : null;
  if (reactionsMatch) {
    return handleListReactionsRoute(request, env, Number(reactionsMatch[1]));
  }
  const reactionMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/messages\/([1-9][0-9]{0,14})\/reactions$/)
    : null;
  if (reactionMatch) {
    return method === "PUT"
      ? handleAddReactionRoute(request, env, Number(reactionMatch[1]))
      : handleRemoveReactionRoute(request, env, Number(reactionMatch[1]), url);
  }

  return undefined;
}
