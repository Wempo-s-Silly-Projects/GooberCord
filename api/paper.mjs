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

// The Morning Paper + the community anniversaries (2026-11-18 re-code wave).
//
// THE PAPER: the server's own daily journal. The paper is DERIVED ON REQUEST
// from rows the server already stores (gc_messages, the reactions seat):
// it mints nothing, sinks nothing, tracks nothing, and no write statement of
// any kind fires during a read — the config row in gc_paper_configs IS the
// whole seat, and "yesterday's paper" re-derives the previous UTC day-key
// window the same way.
//
// PRIVACY: the rollups GROUP BY server/day/channel/emoji only — never a
// member column. The sections are counts; the only personal fact is a
// celebrant's handle, and only because the member set their own month-day
// anniversary.
//
// LAWS: defaults law rides the WHERE (absence of the gc_paper_configs row IS
// the off-state — the next read answers the no-paper 404); the ON write's mod
// gate rides BOTH the route-side role check AND the statement (a non-mod's
// INSERT answers changes-0, classified to the shared unknown-server 404 —
// never a 403 existence oracle); every window bound and section cap is a
// named constants.mjs import, never a magic number.
//
// THE ANNIVERSARIES: one member, at most one month-day anniversary, and the
// schema carries month+day and nothing else — no year, no anchored timestamp
// (LIMIT COLLECTION NOT ACCESS). The routes are self-scoped /api/users/me/
// annivs: validation is STRUCTURAL ONLY (0-11 / 1-31, no per-month day
// counts, no leap math — Feb 30 is stored verbatim and simply never fires).
// The celebrant read rides the paper as a member-scoped read-only join.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_PAPER_ANNIVERSARIES_MAX,
  GC_PAPER_CHANNELS_MAX,
  GC_PAPER_DAY_SECONDS,
  GC_PAPER_REACTIONS_MAX,
  GC_PAPER_YESTERDAY_KEYS,
  GC_USER_ANNIVERSARY_DAY_MAX,
  GC_USER_ANNIVERSARY_MONTH_MAX,
} from "../constants.mjs";

// --- the SQL -----------------------------------------------------------------

// The shared member gate's read: non-members share the unknown-server 404 —
// no server-existence oracle.
const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The off-state read: the config row IS the seat; no row = the surface does
// not exist for this server (the 404's own WHERE — the only statement the
// off-state earns, no activity aggregate rides for it).
const PAPER_CONFIG_READ_SQL =
  "SELECT enabled FROM gc_paper_configs WHERE server_id = ? LIMIT 1";

// The opt-in write, mod-gated INSIDE the statement: a non-mod's write makes
// zero changes. ON conflict the seat refreshes in place — enabled never
// stores a 0 tombstone; the off-transition is the hard DELETE below.
const PAPER_ENABLE_SQL =
  "INSERT INTO gc_paper_configs (server_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (server_id) DO UPDATE SET enabled = excluded.enabled, " +
    "updated_by = excluded.updated_by, updated_at = excluded.updated_at " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator'))";

// The off-transition is the WHOLE off-state: a hard row delete, no tombstone
// column, no history row. Idempotent — an absent row answers its state.
const PAPER_DISABLE_SQL = "DELETE FROM gc_paper_configs WHERE server_id = ?";

// The channels section: the day's per-channel COUNT over the server's public
// text channels only, cut at its own read-time LIMIT (never a whole-day load
// into memory). Aggregates carry no member column.
const CHANNEL_ACTIVITY_SQL =
  "SELECT m.channel_id, COUNT(*) AS row_count FROM gc_messages m " +
    "JOIN gc_channels c ON c.id = m.channel_id " +
    "WHERE c.server_id = ? AND c.kind = 'text' " +
      "AND m.created_at >= ? AND m.created_at < ? " +
    "GROUP BY m.channel_id " +
    "ORDER BY row_count DESC, m.channel_id ASC LIMIT " + GC_PAPER_CHANNELS_MAX;

// The reactions section: the window's most-given tokens on the server's
// text-channel messages, grouped by emoji only — no member column exists in
// the shape, only the count.
const REACTIONS_ACTIVITY_SQL =
  "SELECT r.emoji, COUNT(*) AS row_count FROM gc_message_reactions r " +
    "JOIN gc_messages m ON m.id = r.message_id " +
    "JOIN gc_channels c ON c.id = m.channel_id " +
    "WHERE c.server_id = ? AND c.kind = 'text' " +
      "AND r.created_at >= ? AND r.created_at < ? " +
    "GROUP BY r.emoji " +
    "ORDER BY row_count DESC, r.emoji ASC LIMIT " + GC_PAPER_REACTIONS_MAX;

// The celebrants ride-along: a READ-ONLY three-table join (seat ⋈ membership
// ⋈ users) — members of the server whose structural (month, day) equals the
// UTC (month, day) of the same nowSeconds() clock the paper's day-key rides.
// Handles only; there is no year data to ride and no aggregate to count.
const ANNIVERSARY_TODAY_SQL =
  "SELECT u.id, u.username FROM gc_user_anniversaries a " +
    "JOIN users u ON u.id = a.user_id " +
    "JOIN gc_server_members m ON m.user_id = a.user_id " +
    "WHERE a.month = ? AND a.day = ? AND m.server_id = ? " +
    "LIMIT " + GC_PAPER_ANNIVERSARIES_MAX;

// The anniversary seat's ONE set statement — a second PUT overwrites in place
// on the user_id PK, no history, no tombstone.
const ANNIVERSARY_SET_SQL =
  "INSERT INTO gc_user_anniversaries (user_id, month, day) VALUES (?, ?, ?) " +
  "ON CONFLICT (user_id) DO UPDATE SET month = excluded.month, day = excluded.day";

// The clear is idempotent (absence IS the off-state — the route answers its
// state, never a 404): the whole off-transition is this row's absence.
const ANNIVERSARY_CLEAR_SQL = "DELETE FROM gc_user_anniversaries WHERE user_id = ?";

// --- the gates ----------------------------------------------------------------

// The paper's reads skip CSRF (read-only); its writes and the seat's writes
// carry the full same-origin + CSRF gate.
async function sessionGate(request, env, mutating) {
  return mutating ? requireUser(request, env) : requireSignedInRead(request, env);
}

async function membershipGate(request, env, serverId, mutating) {
  const session = await sessionGate(request, env, mutating);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return { userId, role: String(membership.role || "") };
}

// --- the paper routes -----------------------------------------------------------

// POST /api/servers/:id/paper { enabled } — the mod-gated ON/OFF toggle, the
// non-mod intent answered 403 by the membership family and changes-0 by the
// statement (a member's write never conjures a row).
async function handlePaperToggleRoute(request, env, serverId) {
  const { userId, role } = await membershipGate(request, env, serverId, true);
  await rateLimit(request, env, "write", "paper:toggle:" + serverId + ":" + userId);
  const body = await readJson(request);
  const enabled = body && body.enabled;
  if (enabled !== true && enabled !== false) {
    throw new HttpError(400, "The paper toggle wants a boolean.");
  }
  if (role !== "owner" && role !== "moderator") {
    throw new HttpError(403, "Only moderators can turn the paper on or off.");
  }

  if (enabled) {
    const result = await env.GOOBER_DB.prepare(PAPER_ENABLE_SQL).bind(
      serverId, 1, userId, nowSeconds(),
      serverId, userId,
    ).run();
    if (Number(result.meta?.changes) !== 1) {
      throw new HttpError(404, "This server does not exist or you cannot view it.");
    }
    return json({ enabled: true });
  }

  await env.GOOBER_DB.prepare(PAPER_DISABLE_SQL).bind(serverId).run();
  return json({ enabled: false });
}

// GET /api/servers/:id/paper and /paper/previous — the members' pull. All
// activity reads ride the config seat INSIDE their dispatch order: no
// gc_messages/gc_message_reactions statement fires until the row answers
// enabled. The day key is the whole synchronization — no timer, no lock, no
// double window possible.
async function handlePaperReadRoute(request, env, serverId, previous) {
  await membershipGate(request, env, serverId, false);
  await rateLimit(request, env, "read", "paper:read:" + serverId);

  const config = await env.GOOBER_DB.prepare(PAPER_CONFIG_READ_SQL).bind(serverId).first();
  if (!config || Number(config.enabled) !== 1) {
    // The dedicated no-paper 404 — the dispatch tail's generic shape never
    // answers for this route (the surface is absent, not unknown).
    throw new HttpError(404, "The Morning Paper is not configured on this server.");
  }

  const now = nowSeconds();
  const window = resolvePaperWindow(previous, now);
  const channelRows = await readChannelActivity(env, serverId, window.startSeconds, window.endSeconds);
  const reactionRows = await readReactionActivity(env, serverId, window.startSeconds, window.endSeconds);
  const anniversaries = await readTodayAnniversaries(env, serverId, now);
  return paperReadPayload(window, channelRows, reactionRows, anniversaries);
}

// The GET's payload: Painted strings ride keys only — the title is the
// paper.* key, never stored prose. The window label is the machine-painted
// UTC pair (the label states UTC by construction, no per-server tz — the
// anchor is parked).
function paperReadPayload(window, channelRows, reactionRows, anniversaries) {
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  return json({
    titleKey: "paper.title",
    windowLabelUtc: iso(window.startSeconds) + "/" + iso(window.endSeconds),
    window: { startSeconds: window.startSeconds, endSeconds: window.endSeconds },
    activityRows: sumActivityRows(channelRows, reactionRows, anniversaries.length),
    sections: {
      channels: channelRows.map((row) => ({
        channelId: Number(row.channel_id),
        count: Number(row.row_count),
      })),
      reactions: reactionRows.map((row) => ({
        emoji: String(row.emoji || ""),
        count: Number(row.row_count),
      })),
      anniversaries,
    },
  });
}

// The read's day window: today's key (the wall clock's own floor), rolled
// back one day per GC_PAPER_YESTERDAY_KEYS when the caller wants /previous.
function resolvePaperWindow(previous, now) {
  const todayKey = Math.floor(now / GC_PAPER_DAY_SECONDS) * GC_PAPER_DAY_SECONDS;
  const startSeconds = previous
    ? todayKey - GC_PAPER_DAY_SECONDS * GC_PAPER_YESTERDAY_KEYS
    : todayKey;
  return { startSeconds, endSeconds: startSeconds + GC_PAPER_DAY_SECONDS };
}

// The channels section: the window's per-channel message counts, in the SQL's
// own order (the row's channel_id) — the payload's Number() wraps are the
// only shaping.
async function readChannelActivity(env, serverId, startSeconds, endSeconds) {
  return (await env.GOOBER_DB.prepare(CHANNEL_ACTIVITY_SQL)
    .bind(serverId, startSeconds, endSeconds).all()).results || [];
}

// The reactions section: the window's per-emoji counts, same seat and order.
async function readReactionActivity(env, serverId, startSeconds, endSeconds) {
  return (await env.GOOBER_DB.prepare(REACTIONS_ACTIVITY_SQL)
    .bind(serverId, startSeconds, endSeconds).all()).results || [];
}

// The anniversaries section: today's UTC celebrants — the join only fires
// here, after the config row has answered enabled (the same dispatch order
// every other section rides).
async function readTodayAnniversaries(env, serverId, now) {
  const today = new Date(now * 1000);
  const anniversaryRows = (await env.GOOBER_DB.prepare(ANNIVERSARY_TODAY_SQL)
    .bind(today.getUTCMonth(), today.getUTCDate(), serverId).all()).results || [];
  return anniversaryRows.map((row) => ({
    userId: Number(row.id),
    handle: String(row.username || ""),
  }));
}

// activityRows: the window's total across the sections' own rows.
function sumActivityRows(channelRows, reactionRows, anniversaryCount) {
  return channelRows.reduce((total, row) => total + (Number(row.row_count) || 0), 0) +
    reactionRows.reduce((total, row) => total + (Number(row.row_count) || 0), 0) +
    anniversaryCount;
}

// --- the anniversary routes -------------------------------------------------------

// PUT /api/users/me/anniversary { month, day } — the member's self-scoped
// opt-in. Both keys must be integers inside the structural range; a PUT
// missing either key is a 400 — the off-state is never written on anyone's
// behalf (defaults law). A re-set overwrites in place (no history exists).
async function handleAnniversarySetRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "anniversary:set:" + userId);
  const body = await readJson(request);
  const month = body ? body.month : undefined;
  const day = body ? body.day : undefined;
  if (
    !Number.isInteger(month) || !Number.isInteger(day) ||
    month < 0 || month > GC_USER_ANNIVERSARY_MONTH_MAX ||
    day < 1 || day > GC_USER_ANNIVERSARY_DAY_MAX
  ) {
    throw new HttpError(400, "An anniversary wants a month (0-11) and a day (1-31).");
  }
  await env.GOOBER_DB.prepare(ANNIVERSARY_SET_SQL).bind(userId, month, day).run();
  return json({ month, day });
}

// DELETE /api/users/me/anniversary — the member's clear: immediate, total,
// idempotent (an untouched member's clear clears nothing and answers its
// state). The route's bind carries only the self user_id — a wrong-member
// clear cannot exist structurally.
async function handleAnniversaryClearRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "anniversary:clear:" + userId);
  await env.GOOBER_DB.prepare(ANNIVERSARY_CLEAR_SQL).bind(userId).run();
  return json({ month: null, day: null });
}

// --- dispatch ---------------------------------------------------------------------

export async function handlePaperRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  // The anniversary seat routes: self-scoped (/me), self-gated (requireUser
  // inside, NOT the server membership gate) — exact matches, no prefix shadow.
  const anniversaryMatch =
    (method === "PUT" || method === "DELETE") &&
    path === "/api/users/me/anniversary";
  if (anniversaryMatch) {
    return method === "PUT"
      ? handleAnniversarySetRoute(request, env)
      : handleAnniversaryClearRoute(request, env);
  }

  const toggleMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/paper$/)
    : null;
  if (toggleMatch) {
    return handlePaperToggleRoute(request, env, Number(toggleMatch[1]));
  }

  const readMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/paper$/)
    : null;
  if (readMatch) {
    return handlePaperReadRoute(request, env, Number(readMatch[1]), false);
  }

  const previousMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/paper\/previous$/)
    : null;
  if (previousMatch) {
    return handlePaperReadRoute(request, env, Number(previousMatch[1]), true);
  }

  return undefined;
}
