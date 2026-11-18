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

// T87: The Morning Paper (docs/drafts/t87-morning-paper-spec.md) — the
// server's own daily journal. The paper is DERIVED ON REQUEST from rows the
// server already stores (gc_messages, the thread seat, capsule seals): it
// mints nothing, sinks nothing, tracks nothing (sink law N/A by spec §5), and
// no render is ever persisted — the config row in gc_paper_configs IS the
// whole seat, and "yesterday's paper" re-derives the previous UTC day-key
// window the same way.
//
// PRIVACY: the rollups GROUP BY server/day/channel/thread only — never a
// member column. The section rows are counts and handles; the only personal
// fact is a capsule's sender HANDLE as api/capsules.mjs already paints it.
//
// LAWS: defaults law rides the WHERE (absence of the gc_paper_configs row IS
// the off-state — the next read answers the dedicated no-paper 404 after an
// off-transition deletes the row); the ON write's mod gate rides BOTH the
// pre-read membership check AND the statement (a non-mod's INSERT answers
// changes-0, classified to the shared unknown-server 404 — never a 403
// existence oracle); every window bound and section cap is a named
// constants.mjs import, never a magic number.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_PAPER_CAPSULES_MAX,
  GC_PAPER_CHANNELS_MAX,
  GC_PAPER_DAY_SECONDS,
  GC_PAPER_THREADS_MAX,
  GC_PAPER_YESTERDAY_KEYS,
} from "../constants.mjs";

// --- the SQL -----------------------------------------------------------------

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The off-state read: the config row IS the seat; no row = the surface does
// not exist for this server (the 404's own WHERE — the only statement the
// off-state earns, no activity aggregate rides for it).
const PAPER_CONFIG_READ_SQL =
  "SELECT enabled FROM gc_paper_configs WHERE server_id = ? LIMIT 1";

// The opt-in write, mod-gated INSIDE the statement: a non-mod's write makes
// zero changes (the statement gate), classified to the shared unknown-server
// 404. ON conflict the seat refreshes in place — enabled never stores a 0
// tombstone; the off-transition is the hard DELETE below.
const PAPER_ENABLE_SQL =
  "INSERT INTO gc_paper_configs (server_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (server_id) DO UPDATE SET enabled = excluded.enabled, " +
    "updated_by = excluded.updated_by, updated_at = excluded.updated_at " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator'))";

// The off-transition is the WHOLE off-state: a hard row delete, no tombstone
// column, no history row. Idempotent — an absent row answers its state.
const PAPER_DISABLE_SQL = "DELETE FROM gc_paper_configs WHERE server_id = ?";

// The channels section: the day's per-channel COUNT over the server's PUBLIC
// text channels only, cut at its own read-time LIMIT (never a whole-day load
// into memory). Aggregates carry no member column.
const CHANNEL_ACTIVITY_SQL =
  "SELECT m.channel_id, COUNT(*) AS row_count FROM gc_messages m " +
    "JOIN gc_channels c ON c.id = m.channel_id " +
    "WHERE c.server_id = ? AND c.kind = 'text' " +
      "AND m.created_at >= ? AND m.created_at < ? " +
    "GROUP BY m.channel_id " +
    "ORDER BY row_count DESC, m.channel_id ASC LIMIT " + GC_PAPER_CHANNELS_MAX;

// The threads section: the day's most-active public threads by row count,
// cut at its own cap. The thread seat is the phase-4 planned GC-OWNED table
// (docs/discord-parity-checklist.md:838 — a gc_threads row plus the
// thread_id column on the message table); until that seat lands the read
// degrades to the section's empty state (see the guarded catch).
const THREAD_ACTIVITY_SQL =
  "SELECT t.id AS thread_id, COUNT(m.id) AS row_count FROM gc_threads t " +
    "JOIN gc_messages m ON m.thread_id = t.id " +
    "WHERE t.server_id = ? AND m.created_at >= ? AND m.created_at < ? " +
    "GROUP BY t.id " +
    "ORDER BY row_count DESC, t.id ASC LIMIT " + GC_PAPER_THREADS_MAX;

// The capsules section: reveal-DUE seals only — id + due day + the sender
// HANDLE the seal's own routes already paint; the seal body NEVER rides the
// paper (the capsule's own route is the only body reader, T82 law carries).
// The pin-named seat reads gc_time_capsules (0031) under its spec name.
const CAPSULE_DUE_SQL =
  "WITH gc_capsules AS (SELECT id, reveal_at, author_id, server_id FROM gc_time_capsules) " +
  "SELECT c.id, c.reveal_at, u.username FROM gc_capsules c " +
    "LEFT JOIN users u ON u.id = c.author_id " +
    "WHERE c.server_id = ? AND c.reveal_at >= ? AND c.reveal_at < ? " +
    "ORDER BY c.reveal_at ASC LIMIT " + GC_PAPER_CAPSULES_MAX;

// --- the gates ----------------------------------------------------------------

async function membershipGate(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return { userId, role: String(membership.role || "") };
}

// --- the routes ----------------------------------------------------------------

export async function handlePaperRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

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

// POST /api/servers/:id/paper { enabled } — the mod-gated ON/OFF toggle, the
// non-mod intent answered 403 by the membership family and changes-0 by the
// statement (a member's write never conjures a row).
async function handlePaperToggleRoute(request, env, serverId) {
  const { userId, role } = await membershipGate(request, env, serverId);
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

// GET /api/servers/:id/paper and /paper/previous — the members' pull. All three
// activity reads ride the config seat INSIDE their dispatch order: no
// gc_messages/gc_capsules/gc_threads statement fires until the row answers
// enabled. The day key is the whole synchronization (the T83 idiom) — no
// timer, no lock, no double window possible.
async function handlePaperReadRoute(request, env, serverId, previous) {
  await membershipGate(request, env, serverId);
  await rateLimit(request, env, "read", "paper:read:" + serverId);

  const config = await env.GOOBER_DB.prepare(PAPER_CONFIG_READ_SQL).bind(serverId).first();
  if (!config || Number(config.enabled) !== 1) {
    // The dedicated no-paper 404 — the dispatch tail's generic shape never
    // answers for this route (the surface is absent, not unknown).
    throw new HttpError(404, "The Morning Paper is not configured on this server.");
  }

  const now = nowSeconds();
  const todayKey = Math.floor(now / GC_PAPER_DAY_SECONDS) * GC_PAPER_DAY_SECONDS;
  const startSeconds = previous
    ? todayKey - GC_PAPER_DAY_SECONDS * GC_PAPER_YESTERDAY_KEYS
    : todayKey;
  const endSeconds = startSeconds + GC_PAPER_DAY_SECONDS;

  const channelRows = (await env.GOOBER_DB.prepare(CHANNEL_ACTIVITY_SQL)
    .bind(serverId, startSeconds, endSeconds).all()).results || [];
  const channels = channelRows.slice(0, GC_PAPER_CHANNELS_MAX).map((row) => ({
    channelId: Number(row.channel_id),
    count: Number(row.row_count),
  }));

  let threadRows = [];
  try {
    threadRows = (await env.GOOBER_DB.prepare(THREAD_ACTIVITY_SQL)
      .bind(serverId, startSeconds, endSeconds).all()).results || [];
  } catch {
    /* the thread seat is the phase-4 planned table (docs/discord-parity-   */
    /* checklist.md:838): a pre-thread-lane database carries no gc_threads,  */
    /* so the section answers its empty state until the seat lands.          */
  }
  const threads = threadRows.slice(0, GC_PAPER_THREADS_MAX).map((row) => ({
    threadId: Number(row.thread_id),
    count: Number(row.row_count),
  }));

  const capsuleRows = (await env.GOOBER_DB.prepare(CAPSULE_DUE_SQL)
    .bind(serverId, startSeconds, endSeconds).all()).results || [];
  const capsules = capsuleRows.slice(0, GC_PAPER_CAPSULES_MAX).map((row) => ({
    sealId: Number(row.id),
    dueAt: Number(row.reveal_at),
    senderHandle: String(row.username || ""),
  }));

  const activityRows =
    channelRows.reduce((total, row) => total + (Number(row.row_count) || 0), 0) +
    threadRows.reduce((total, row) => total + (Number(row.row_count) || 0), 0) +
    capsuleRows.length;

  // Painted strings ride keys only: the title is the paper.* key, never
  // stored prose. The window label is the machine-painted UTC pair (the label
  // states UTC by construction, no per-server tz — the anchor is parked).
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  return json({
    titleKey: "paper.title",
    windowLabelUtc: iso(startSeconds) + "/" + iso(endSeconds),
    window: { startSeconds, endSeconds },
    activityRows,
    sections: { channels, threads, capsules },
  });
}
