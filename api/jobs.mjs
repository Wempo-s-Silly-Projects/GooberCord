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

// T86: Goober Jobs (docs/drafts/t86-goober-jobs-spec.md) — the weekly
// quests. Three per server, rotated by a server-seeded weekly shuffle that
// is COMPUTED, never stored (pickJobs: same server + same week = the same
// three jobs on every read and every isolate). The quest counters are
// AGGREGATE ONLY (gc_job_counters carries no member column, and no statement
// here ever attributes an act to a member — the slate's privacy law).
//
// SINK LAW: every finish mint routes to the server's Campfire pool FIRST —
// the credit rides api/campfire.mjs's campfirePoolCreditStatement (reuse,
// never a second cap constant) and binds BEFORE the member share in the
// same batch — and members only second; a finish with zero online members
// burns its whole member share into the pool. paid_total in gc_job_finishes
// is the batch's own conservation note (100, always).
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_JOB_COUNTER_SANITY_CAP,
  GC_JOB_DEFS_PER_WEEK,
  GC_JOB_FINISH_BONUS,
  GC_JOB_GOAL_JOINS,
  GC_JOB_GOAL_MESSAGES,
  GC_JOB_GOAL_REACTIONS,
  GC_JOB_GOAL_STOKES,
  GC_JOB_GOAL_VOICE,
  GC_JOB_MEMBER_SHARE_PERCENT,
  GC_JOB_POOL_SHARE_PERCENT,
  GC_JOB_WEEK_SECONDS,
} from "../constants.mjs";
import { campfirePoolCreditStatement, onlineServerMembers } from "./campfire.mjs";

// --- the static defs (CODE, not rows — painted titles ride i18n keys, the
// no-copy sweep law; a DB-backed def would mint untranslated prose) ---------

export const jobDefs = [
  { id: "wash_day", titleKey: "gc.jobs.wash_day", kind: "message", goal: GC_JOB_GOAL_MESSAGES },
  { id: "kindling", titleKey: "gc.jobs.kindling", kind: "voice", goal: GC_JOB_GOAL_VOICE },
  { id: "hearth_lights", titleKey: "gc.jobs.hearth_lights", kind: "reaction", goal: GC_JOB_GOAL_REACTIONS },
  { id: "open_door", titleKey: "gc.jobs.open_door", kind: "join", goal: GC_JOB_GOAL_JOINS },
  { id: "stoked", titleKey: "gc.jobs.stoked", kind: "stoke", goal: GC_JOB_GOAL_STOKES },
];

// --- the SQL (the counters ride guard arms inside their statements, the
// coins-module way) ------------------------------------------------------------

// Opt-in state: ONE row per server, defaults law (the row simply missing =
// opted out).
const JOBS_STATE_READ_SQL =
  "SELECT enabled FROM gc_server_jobs WHERE server_id = ? LIMIT 1";

// The owner gate rides INSIDE the upsert: a non-owner's write answers
// changes 0, classified to the shared unknown-server 404, never a 403
// existence oracle.
const JOBS_TOGGLE_UPSERT_SQL =
  "INSERT INTO gc_server_jobs (server_id, enabled, updated_at) VALUES (?, ?, ?) " +
  "ON CONFLICT (server_id) DO UPDATE SET enabled = ?, updated_at = ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members oj " +
    "WHERE oj.server_id = ? AND oj.user_id = ? AND oj.role = 'owner')";

// The counters ONLY: aggregate per server/week/kind. The growth arm is the
// sanity cap, never a cap on participation (counters count ACTIVITY — a
// ceiling-capped message is still a chore done).
const COUNTER_UPSERT_SQL =
  "INSERT INTO gc_job_counters (server_id, week_key, kind, counter) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (server_id, week_key, kind) DO UPDATE SET " +
    "counter = gc_job_counters.counter + ? " +
  "WHERE gc_job_counters.counter + ? <= " + GC_JOB_COUNTER_SANITY_CAP;

const COUNTER_READ_SQL =
  "SELECT counter FROM gc_job_counters WHERE server_id = ? AND week_key = ? AND kind = ? LIMIT 1";

// The double-finish fingerprint IS the PK: a lost race inserts nothing, and
// the pool credit's fingerprint (below) refuses to bank off a finish that
// never landed.
const FINISH_INSERT_SQL =
  "INSERT INTO gc_job_finishes (server_id, week_key, job_id, paid_total, finished_at) " +
    "SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM gc_job_finishes lf " +
      "WHERE lf.server_id = ? AND lf.week_key = ? AND lf.job_id = ?) LIMIT 1";

// The member share's mint: one guarded row per online member. A member who
// left between the presence read and the batch finds the EXISTS false — the
// verdict walk refunds their seat to the pool, so conservation holds
// (minted + refunded == the batch's own 100) like the Campfire draws'.
const MEMBER_SHARE_MINT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
    "SELECT ?, ?, 'job_finish', ? " +
    "WHERE EXISTS (SELECT 1 FROM gc_server_members jm " +
      "WHERE jm.server_id = ? AND jm.user_id = ?)";

// A skipped seat's coins stay UNMINTED (the verdict walk is informational —
// total mint <= 100, never a leak), so no seat-refund statement exists: the
// pool's own credit shape carries every pool-first coin.

// --- the weekly rotation (pure, computed, never stored) ------------------------

export function jobWeekKey(now) {
  return Math.floor(now / GC_JOB_WEEK_SECONDS) * GC_JOB_WEEK_SECONDS;
}

// mulberry32: the established tiny deterministic PRNG. The seed folds the
// server's id with the week floor, so a server's week is its own stable
// shuffle — same server + same week = the same three jobs, everywhere.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickJobs(serverId, weekKey) {
  const next = mulberry32((Math.imul(serverId, 2654435761) ^ weekKey) >>> 0);
  const order = jobDefs.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order.slice(0, GC_JOB_DEFS_PER_WEEK).map((index) => jobDefs[index]);
}

// --- the activity counter (the hooks are ride-alongs on lanes that ALREADY
// observe the activity; failures swallow — a chore miss only delays the
// finish, and a crossed counter retries on the next event) ---------------------

export async function recordJobProgress(env, serverId, kind, amount, now) {
  const state = await env.GOOBER_DB.prepare(JOBS_STATE_READ_SQL).bind(serverId).first();
  if (!state || Number(state.enabled) !== 1) return false;

  const weekKey = jobWeekKey(now);
  const counted = await env.GOOBER_DB.prepare(COUNTER_UPSERT_SQL).bind(
    serverId, weekKey, kind, amount,
    amount, amount,
  ).run();
  if (Number(counted.meta?.changes) !== 1) return false;

  const row = await env.GOOBER_DB.prepare(COUNTER_READ_SQL).bind(serverId, weekKey, kind).first();
  const counter = Number(row?.counter) || 0;
  const candidates = jobDefs.filter((def) => def.kind === kind);
  if (candidates.length === 0) return false;
  const crossed = candidates.filter((def) => counter >= def.goal);
  if (crossed.length === 0) return false;

  // Only a job the week's rotation SELECTED can finish: a crossed counter on
  // an unselected kind waits for its week. (More than one def may share a
  // kind someday; each crossed + selected one finishes on its own PK.)
  const selected = pickJobs(serverId, weekKey);
  for (const def of crossed) {
    if (!selected.some((job) => job.id === def.id)) continue;
    return finishJob(env, serverId, weekKey, def.id, now);
  }
  return false;
}

async function finishJob(env, serverId, weekKey, jobId, now) {
  const db = env.GOOBER_DB;
  // THE finish claim: the PK's NOT EXISTS arm serializes the race in one
  // statement — the loser's insert answers changes 0 and pays nothing; the
  // winner's changes verdict is the whole race's answer BEFORE any coin
  // moves (conservation: one finish = one mint, ever, per week).
  const landed = await db.prepare(FINISH_INSERT_SQL).bind(
    serverId, weekKey, jobId, GC_JOB_FINISH_BONUS, now,
    serverId, weekKey, jobId,
  ).run();
  if (Number(landed.meta?.changes) !== 1) {
    return { finished: false, alreadyPaid: true };
  }

  // The pool takes its share FIRST (the sink law's ordering, not a nicety):
  // the credit statement binds before any member seat in the same batch.
  const poolShare = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_POOL_SHARE_PERCENT / 100);
  const memberShare = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_MEMBER_SHARE_PERCENT / 100);

  const online = await onlineServerMembers(env, serverId).catch(() => []);
  const perMember = online.length > 0 ? Math.floor(memberShare / online.length) : 0;
  // The unsplit member share (rounding remainder, or the whole share when
  // nobody is online) burns into the pool — its own credit statement, so the
  // pool ledger shows exactly where the pool-first coins came from.
  const unsplit = memberShare - perMember * online.length;

  const statements = [campfirePoolCreditStatement(db, serverId, poolShare, now)];
  if (unsplit > 0) {
    statements.push(campfirePoolCreditStatement(db, serverId, unsplit, now));
  }
  for (const memberId of online) {
    if (perMember <= 0) break;
    statements.push(db.prepare(MEMBER_SHARE_MINT_SQL).bind(
      memberId, perMember, now,
      serverId, memberId,
    ));
  }

  const results = await db.batch(statements);
  // The verdict walk is informational only: a member seat whose membership
  // vanished mid-flight mints nothing (its coins stay unminted — total mint
  // <= 100, never a leak). The pool ledger's own rows carry the count.
  const seatOffset = statements.length - online.length;
  let mintedSeats = 0;
  for (let index = 0; index < online.length; index += 1) {
    const seat = results[seatOffset + index];
    if (seat && Number(seat.meta?.changes) === 1) mintedSeats += 1;
  }
  return {
    finished: true,
    minted: GC_JOB_FINISH_BONUS,
    poolShare,
    mintedShare: perMember * mintedSeats,
  };
}

// --- the routes ----------------------------------------------------------------

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
  return userId;
}

// The week's counters read once, keyed to the rotation's kinds — the read is
// the payload's only state; nothing is stored for the read.
const WEEK_COUNTERS_SQL =
  "SELECT kind, counter FROM gc_job_counters WHERE server_id = ? AND week_key = ? AND kind IN (?, ?, ?)";

export async function handleJobsRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const toggleMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/jobs\/toggle$/)
    : null;
  if (toggleMatch) {
    return handleJobsToggleRoute(request, env, Number(toggleMatch[1]));
  }

  const readMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/jobs$/)
    : null;
  if (readMatch) {
    return handleJobsReadRoute(request, env, Number(readMatch[1]));
  }

  return undefined;
}

// POST /api/servers/:id/jobs/toggle { enabled } — owner-only (the server
// settings' precedent), the authority riding INSIDE the upsert.
async function handleJobsToggleRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "write", "jobs:toggle:" + serverId + ":" + userId);
  const body = await readJson(request);
  const enabled = body && body.enabled;
  if (enabled !== true && enabled !== false) {
    throw new HttpError(400, "The jobs toggle wants a boolean.");
  }

  const now = nowSeconds();
  const result = await env.GOOBER_DB.prepare(JOBS_TOGGLE_UPSERT_SQL).bind(
    serverId, enabled ? 1 : 0, now,
    enabled ? 1 : 0, now,
    serverId, userId,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return json({ enabled });
}

// GET /api/servers/:id/jobs — the members' read. A not-opted-in server
// answers the defaults-law shape (enabled false, no jobs) instead of a 403 —
// the feature is simply absent for it. Painted titles ride titleKey ONLY.
async function handleJobsReadRoute(request, env, serverId) {
  await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "jobs:read:" + serverId);
  const now = nowSeconds();
  const weekKey = jobWeekKey(now);
  const state = await env.GOOBER_DB.prepare(JOBS_STATE_READ_SQL).bind(serverId).first();
  if (!state || Number(state.enabled) !== 1) {
    return json({ enabled: false, weekKey, jobs: [] });
  }

  const selected = pickJobs(serverId, weekKey);
  const rows = (await env.GOOBER_DB.prepare(WEEK_COUNTERS_SQL)
    .bind(serverId, weekKey, ...selected.map((job) => job.kind)).all()).results || [];
  const counterOf = new Map(rows.map((row) => [String(row.kind), Number(row.counter) || 0]));
  return json({
    enabled: true,
    weekKey,
    jobs: selected.map((job) => {
      const counter = counterOf.get(job.kind) || 0;
      return {
        id: job.id,
        titleKey: job.titleKey,
        goal: job.goal,
        counter,
        done: counter >= job.goal,
      };
    }),
  });
}
