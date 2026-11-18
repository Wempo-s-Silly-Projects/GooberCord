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

// T84: Server Seasons (docs/drafts/t84-server-seasons-spec.md) — the server
// has a calendar. A mod creates a season (the defaults law's explicit act:
// no season row == no change, nothing default-on), members watch the shared
// meter fill, and the finish mints pool-first per the sink law. The meter is
// a PURE read-time aggregate over the activity the server already has
// (messages + reactions through the channel seat) — no tracker table, no
// event hook, and the live lanes never learn this feature exists. Season
// windows are pure date-key comparisons at read time: no timers anywhere.
//
// SINK LAW: the finish's GC_SEASON_REWARD_COINS split reuses the jobs lane's
// GC_JOB_POOL_SHARE_PERCENT / GC_JOB_MEMBER_SHARE_PERCENT (one Campfire-pool
// share law, one declaration) and rides api/campfire.mjs's
// campfirePoolCreditStatement — the pool credit binds BEFORE the member share
// in the batch, exactly the jobs finish's ordering (api/jobs.mjs:192-207).
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_CAMPFIRE_MAX_POOL,
  GC_JOB_MEMBER_SHARE_PERCENT,
  GC_JOB_POOL_SHARE_PERCENT,
  GC_SEASON_COLOR_TOKENS,
  GC_SEASON_MAX_WEEKS,
  GC_SEASON_METER_GOAL_MAX,
  GC_SEASON_NAME_MAX,
  GC_SEASON_REWARD_COINS,
  GC_SEASON_WEEK_SECONDS,
} from "../constants.mjs";
import { campfirePoolCreditStatement, onlineServerMembers } from "./campfire.mjs";

// --- the SQL (named pins, the coins-module way) -------------------------------

// The current-season lookup: the ONLY statement a seasonless server ever
// fires — the defaults law's read path stops here and answers null.
const CURRENT_READ_SQL = `SELECT started_at, name, color, goal, week_count, created_by, created_at
  FROM gc_server_seasons
  WHERE server_id = ?
  ORDER BY started_at DESC LIMIT 1`;

const COMPLETION_READ_SQL =
  "SELECT completed_at FROM gc_season_completions " +
  "WHERE server_id = ? AND season_started_at = ? LIMIT 1";

// The completion claim IS the conservation seat: its ON CONFLICT arm turns a
// raced pair of readers into one mint ever (the loser answers changes 0 and
// pays nothing — the jobs finish's once-per-week PK, per-season).
const COMPLETION_INSERT_SQL =
  "INSERT INTO gc_season_completions (server_id, season_started_at, completed_at) " +
  "VALUES (?, ?, ?) ON CONFLICT (server_id, season_started_at) DO NOTHING";

const SEASON_CREATE_SQL =
  "INSERT INTO gc_server_seasons " +
  "(server_id, started_at, name, color, goal, week_count, created_by, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

// The end-early burn: deleting an UNEXPIRED season mints nothing — there is
// no credit statement on this path at all. The completion row cascades.
const SEASON_DELETE_SQL =
  "DELETE FROM gc_server_seasons WHERE server_id = ? AND started_at = ?";

// THE METER — a pure read-time aggregate over the rows the server already
// has: member-authored messages + member-reacted reactions, both joined to
// the server through gc_channels' server seat (the channel row is the only
// server seat a message carries) and bounded by the season window. Nothing
// writes; the same window always answers the same meter.
const METER_READ_SQL = `SELECT
    (SELECT COUNT(*) FROM gc_messages m
      JOIN gc_channels c ON c.id = m.channel_id
      WHERE c.server_id = ?
        AND m.created_at >= ? AND m.created_at < ?
        AND EXISTS (SELECT 1 FROM gc_server_members sm
          WHERE sm.server_id = ? AND sm.user_id = m.author_id))
  + (SELECT COUNT(*) FROM gc_message_reactions r
      JOIN gc_messages m2 ON m2.id = r.message_id
      JOIN gc_channels c2 ON c2.id = m2.channel_id
      WHERE c2.server_id = ?
        AND r.created_at >= ? AND r.created_at < ?
        AND EXISTS (SELECT 1 FROM gc_server_members sm2
          WHERE sm2.server_id = ? AND sm2.user_id = r.user_id))
  AS meter`;

// The member share's mint: one guarded row per online member, the jobs
// finish's seat shape (a membership that vanished mid-flight mints nothing).
const MEMBER_SHARE_MINT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
    "SELECT ?, ?, 'season_finish', ? " +
    "WHERE EXISTS (SELECT 1 FROM gc_server_members sm " +
      "WHERE sm.server_id = ? AND sm.user_id = ?)";

// T90-c (spec §3 note 5): the seasonal pool credit's book row — the pool
// ledger companion riding the SAME batch as its campfirePoolCreditStatement,
// in the jobs finish's booked shape (api/jobs.mjs jobPoolLedgerStatement):
// the guard fingerprints the season's landed completion row and requires
// post-credit headroom (pool + amount <= GC_CAMPFIRE_MAX_POOL), so the
// booked delta IS the amount verbatim and a clipped credit banks nothing
// (books under, never over — 0039's CHECK (delta <> 0) never trips). The
// source is BOUND and mirrors the finish's own gc_coin_ledger label
// ('season_finish', MEMBER_SHARE_MINT_SQL above), never a new one.
const SEASON_POOL_LEDGER_SOURCE = "season_finish";

const SEASON_POOL_LEDGER_FP_SQL =
  "EXISTS (SELECT 1 FROM gc_season_completions sc " +
    "WHERE sc.server_id = ? AND sc.season_started_at = ?)";

function seasonPoolLedgerStatement(db, serverId, amount, now, startedAt) {
  return db.prepare(
    "INSERT INTO gc_campfire_pool_ledger (server_id, class, source, direction, delta, created_at) " +
      "SELECT ?, 'pool-credit', ?, 'in', ?, ? " +
      "WHERE " + SEASON_POOL_LEDGER_FP_SQL + " " +
      "AND COALESCE((SELECT cf.pool FROM gc_campfires cf WHERE cf.server_id = ?), 0) + ? <= " +
      GC_CAMPFIRE_MAX_POOL,
  ).bind(serverId, SEASON_POOL_LEDGER_SOURCE, amount, now, serverId, startedAt, serverId, amount);
}

// The pure window arithmetic: active while now < started_at + weeks * week.
function seasonEndsAt(row) {
  return Number(row.started_at) + Number(row.week_count) * GC_SEASON_WEEK_SECONDS;
}

function seasonShape(row) {
  return {
    name: String(row.name),
    color: String(row.color),
    goal: Number(row.goal),
    weekCount: Number(row.week_count),
    startedAt: Number(row.started_at),
    endsAt: seasonEndsAt(row),
    createdBy: Number(row.created_by),
  };
}

// The finish: claim the completion seat FIRST (once-per-season PK), and only
// the winner's batch moves coins — pool share bound first, member seats
// after, the unsplit remainder burning into the pool (the jobs finish's
// exact ordering).
async function finishSeason(env, db, serverId, startedAt, now) {
  const landed = await db.prepare(COMPLETION_INSERT_SQL)
    .bind(serverId, startedAt, now).run();
  if (Number(landed.meta?.changes) !== 1) {
    return { minted: false, alreadyPaid: true };
  }

  const poolShare = Math.round(GC_SEASON_REWARD_COINS * GC_JOB_POOL_SHARE_PERCENT / 100);
  const memberShare = Math.round(GC_SEASON_REWARD_COINS * GC_JOB_MEMBER_SHARE_PERCENT / 100);

  const online = await onlineServerMembers(env, serverId).catch(() => []);
  const perMember = online.length > 0 ? Math.floor(memberShare / online.length) : 0;
  const unsplit = memberShare - perMember * online.length;

  const statements = [campfirePoolCreditStatement(db, serverId, poolShare, now)];
  // T90-c: each pool credit's book row rides the finish's own batch, right
  // beside its credit — books and money commit together, verdicts untouched.
  statements.push(seasonPoolLedgerStatement(db, serverId, poolShare, now, startedAt));
  if (unsplit > 0) {
    statements.push(campfirePoolCreditStatement(db, serverId, unsplit, now));
    statements.push(seasonPoolLedgerStatement(db, serverId, unsplit, now, startedAt));
  }
  for (const memberId of online) {
    if (perMember <= 0) break;
    statements.push(db.prepare(MEMBER_SHARE_MINT_SQL).bind(
      memberId, perMember, now,
      serverId, memberId,
    ));
  }

  await db.batch(statements);
  return { minted: true, poolShare };
}

// --- the routes (all requireUser, all rate-limited, member-gated 404) ---------

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

async function memberGate(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return { userId, role: String(membership.role || "") };
}

function requireOwner(gate) {
  if (gate.role !== "owner") {
    throw new HttpError(403, "Only the server owner can shape the season calendar.");
  }
}

function integerSeat(value, lo, hi, message) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < lo || parsed > hi) {
    throw new HttpError(400, message);
  }
  return parsed;
}

async function readMeter(env, serverId, row) {
  const startedAt = Number(row.started_at);
  const endsAt = seasonEndsAt(row);
  const meterRow = await env.GOOBER_DB.prepare(METER_READ_SQL).bind(
    serverId, startedAt, endsAt,
    serverId,
    serverId, startedAt, endsAt,
    serverId,
  ).first();
  return Number(meterRow?.meter) || 0;
}

export async function handleSeasonRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const readMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/seasons\/current$/)
    : null;
  if (readMatch) {
    return handleSeasonReadRoute(request, env, Number(readMatch[1]));
  }

  const createMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/seasons$/)
    : null;
  if (createMatch) {
    return handleSeasonCreateRoute(request, env, Number(createMatch[1]));
  }

  const endMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/seasons\/current$/)
    : null;
  if (endMatch) {
    return handleSeasonEndRoute(request, env, Number(endMatch[1]));
  }

  return undefined;
}

// GET /api/servers/:id/seasons/current — the season a member sees. With no
// season row the ONLY statement fired is the current-season lookup and the
// answer is the defaults-law shape (season null). An expired season's first
// qualifying read lazily mints the finish (the guarded completion claim);
// every later read answers the identical completed shape idempotently.
// Painted copy rides gc.seasons keys ONLY (the no-copy sweep law).
async function handleSeasonReadRoute(request, env, serverId) {
  await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "seasons:read:" + serverId);
  const db = env.GOOBER_DB;
  const now = nowSeconds();
  const row = await db.prepare(CURRENT_READ_SQL).bind(serverId).first();
  if (!row) {
    return json({ season: null, meter: null, completed: false });
  }

  const expired = now >= seasonEndsAt(row);
  let completed = false;
  let meter = 0;
  if (expired) {
    // The window closed: the aggregate is frozen, so meter >= goal is the
    // completion verdict's pure input — no timer waits anywhere.
    meter = await readMeter(env, serverId, row);
    if (meter >= Number(row.goal)) {
      await finishSeason(env, db, serverId, Number(row.started_at), now);
    }
    const completionRow = await db.prepare(COMPLETION_READ_SQL)
      .bind(serverId, Number(row.started_at)).first();
    completed = Boolean(completionRow);
  } else {
    meter = await readMeter(env, serverId, row);
  }

  return json({
    season: seasonShape(row),
    meter,
    completed,
  });
}

// POST /api/servers/:id/seasons { name, color, goal, weeks } — the mod's
// opt-in act (owner role; the 403/404 classification rides the spec). The
// started_at seat is SERVER-rendered (the client sends none of the times).
async function handleSeasonCreateRoute(request, env, serverId) {
  const gate = await memberGate(request, env, serverId);
  requireOwner(gate);
  await rateLimit(request, env, "write", "seasons:start:" + serverId + ":" + gate.userId);
  const body = await readJson(request);

  const name = String(body && body.name ? body.name : "").trim();
  if (name.length < 1 || name.length > GC_SEASON_NAME_MAX) {
    throw new HttpError(400, "A season name is 1-64 characters.");
  }
  const color = String(body && body.color ? body.color : "");
  if (!GC_SEASON_COLOR_TOKENS.includes(color)) {
    throw new HttpError(400, "Pick one of the season colors.");
  }
  const goal = integerSeat(body && body.goal, 1, GC_SEASON_METER_GOAL_MAX, "The meter goal is 1-100000.");
  const weekCount = integerSeat(body && body.weeks, 1, GC_SEASON_MAX_WEEKS, "A season runs 1-12 weeks.");

  const now = nowSeconds();
  // The overlap refusal rides the pure window comparison: an UNEXPIRED
  // season means the calendar is occupied (409, never a silent extension).
  const current = await env.GOOBER_DB.prepare(CURRENT_READ_SQL).bind(serverId).first();
  if (current && now < seasonEndsAt(current)) {
    throw new HttpError(409, "A season is already running.");
  }

  const created = await env.GOOBER_DB.prepare(SEASON_CREATE_SQL).bind(
    serverId, now, name, color, goal, weekCount, gate.userId, now,
  ).run();
  if (Number(created.meta?.changes) !== 1) {
    throw new HttpError(409, "A season is already running.");
  }
  return json({
    season: {
      name, color, goal, weekCount, startedAt: now,
      endsAt: now + weekCount * GC_SEASON_WEEK_SECONDS,
    },
  });
}

// DELETE /api/servers/:id/seasons/current — the mod ends the season early.
// Burn shape: nothing mints (no credit statement exists on this path);
// completed seasons are history and refuse the delete (409).
async function handleSeasonEndRoute(request, env, serverId) {
  const gate = await memberGate(request, env, serverId);
  requireOwner(gate);
  await rateLimit(request, env, "write", "seasons:end:" + serverId + ":" + gate.userId);
  const now = nowSeconds();
  const row = await env.GOOBER_DB.prepare(CURRENT_READ_SQL).bind(serverId).first();
  if (!row) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  if (now >= seasonEndsAt(row)) {
    throw new HttpError(409, "The season has ended.");
  }
  const deleted = await env.GOOBER_DB.prepare(SEASON_DELETE_SQL)
    .bind(serverId, Number(row.started_at)).run();
  if (Number(deleted.meta?.changes) !== 1) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return json({ ended: true });
}
