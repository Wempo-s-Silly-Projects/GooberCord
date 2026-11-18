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
//
// THE C1 FOLD-IN: the finish claim, its pool credit, and the claim's marker
// row ride ONE atomic batch, so an interrupted delivery can never orphan a
// paid_total=100 stamp behind an empty Campfire. The member share is the
// SECOND batch, ended by the delivered stamp (the marker's counter = 100,
// the conservation note again): the claim marker's only two states are
// claimed(1, pool banked, delivery pending) and delivered(100) — a retry
// between them re-runs the delivery exactly once (the batch is atomic, so
// mints + stamp commit together or never), and a retry past it answers
// alreadyPaid without touching a coin.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_CAMPFIRE_MAX_POOL,
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

// The owner gate rides INSIDE the upsert on BOTH arms: the fresh INSERT's
// SELECT carries it (a member's first toggle never lands the row) and the
// DO UPDATE WHERE carries it again — a non-owner's write answers changes 0,
// classified to the shared unknown-server 404, never a 403 existence oracle.
// Bind order follows ?-positions: server, enabled, now, | fresh arm server,
// user, | update arm server, user.
const JOBS_TOGGLE_UPSERT_SQL =
  "INSERT INTO gc_server_jobs (server_id, enabled, updated_at) " +
  "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_server_members fi " +
    "WHERE fi.server_id = ? AND fi.user_id = ? AND fi.role = 'owner') " +
  "ON CONFLICT (server_id) DO UPDATE SET enabled = excluded.enabled, " +
    "updated_at = excluded.updated_at " +
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

// T90-c (spec §3 note 5): the job-finish pool share's book row — the pool
// ledger companion riding the SAME batch as its campfirePoolCreditStatement.
// The claim batch's fold order is pinned finish → credit → marker (the C1
// fold), so the companion rides LAST and reads the pool at its own execution
// time: the guard requires post-credit headroom (pool + amount <=
// GC_CAMPFIRE_MAX_POOL), so the booked delta IS the amount verbatim — a pool
// with no headroom for a second credit of the same size banks NO book row
// (0039's CHECK (delta <> 0) would abort the whole batch instead — never a
// booked zero), so a clipped credit leaves the books UNDER, never over. The
// guard fingerprints the credit's own cause row, so a refused credit banks
// no book row either. The source is BOUND, not literal: it mirrors the
// finish's own gc_coin_ledger label ('job_finish') and keeps the companion's
// SQL text from masquerading as a member mint in statement-matching fakes.
const JOB_POOL_LEDGER_SOURCE = "job_finish";

const CLAIM_CREDIT_FP_SQL =
  "(SELECT changes()) = 1 AND EXISTS (SELECT 1 FROM gc_job_finishes lc " +
    "WHERE lc.server_id = ? AND lc.week_key = ? AND lc.job_id = ?)";
const UNSPLIT_CREDIT_FP_SQL =
  "EXISTS (SELECT 1 FROM gc_job_counters md " +
    "WHERE md.server_id = ? AND md.week_key = ? AND md.kind = ? AND md.counter = 1)";

function jobPoolLedgerStatement(db, serverId, amount, now, fingerprint) {
  return db.prepare(
    "INSERT INTO gc_campfire_pool_ledger (server_id, class, source, direction, delta, created_at) " +
      "SELECT ?, 'pool-credit', ?, 'in', ?, ? " +
      "WHERE " + fingerprint.sql + " " +
      "AND COALESCE((SELECT cf.pool FROM gc_campfires cf WHERE cf.server_id = ?), 0) + ? <= " +
      GC_CAMPFIRE_MAX_POOL,
  ).bind(serverId, JOB_POOL_LEDGER_SOURCE, amount, now, ...fingerprint.binds, serverId, amount);
}

// The member share's mint: one guarded row per online member. A member who
// left between the presence read and the batch finds the EXISTS false — the
// verdict walk refunds their seat to the pool, so conservation holds
// (minted + refunded == the batch's only 100). The mint ALSO fingerprints the
// claim's row (lf) AND the delivery state (md, counter=1 = claimed,
// undelivered): coins never mint off an unclaimed finish, and a racing
// delivery whose target is already stamped delivered(100) mints nothing.
const MEMBER_SHARE_MINT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
    "SELECT ?, ?, 'job_finish', ? " +
    "WHERE EXISTS (SELECT 1 FROM gc_job_finishes lf " +
      "WHERE lf.server_id = ? AND lf.week_key = ? AND lf.job_id = ?) " +
    "AND EXISTS (SELECT 1 FROM gc_job_counters md " +
      "WHERE md.server_id = ? AND md.week_key = ? AND md.kind = ? AND md.counter = 1) " +
    "AND EXISTS (SELECT 1 FROM gc_server_members jm " +
      "WHERE jm.server_id = ? AND jm.user_id = ?)";

// A skipped seat's coins stay UNMINTED (the verdict walk is informational —
// total mint <= 100, never a leak), so no seat-refund statement exists: the
// pool's own credit shape carries every pool-first coin.
//
// The C1 fold's other two statements: the claim marker (the finish's durable
// stamp — its kind is the JOB'S id, a keyspace DISJOINT from the activity
// kinds, so it never collides with a chore counter) and the delivered stamp
// (the marker's counter lifted to the conservation note, 100) — claimed(1)
// and delivered(100) are the marker's only two states, and the delivery
// batch is atomic, so the retry between them re-delivers exactly once.
const CLAIM_MARKER_INSERT_SQL =
  "INSERT INTO gc_job_counters (server_id, week_key, kind, counter) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT (server_id, week_key, kind) DO NOTHING";

const DELIVERY_DONE_SQL =
  "UPDATE gc_job_counters SET counter = ? " +
    "WHERE server_id = ? AND week_key = ? AND kind = ? AND counter < ?";

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
  // THE C1 PRE-READ: the claim marker's counter is the delivery state —
  // claimed(1, pool banked, delivery pending) or delivered(100). Delivered →
  // the retry answers alreadyPaid BEFORE any statement can re-run; claimed →
  // the delivery re-runs exactly once below (its mints are guarded on the
  // claimed state); absent → the claim batches now.
  const poolShare = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_POOL_SHARE_PERCENT / 100);
  const memberShare = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_MEMBER_SHARE_PERCENT / 100);
  const marker = await db.prepare(COUNTER_READ_SQL).bind(serverId, weekKey, jobId).first();
  const markerState = Number(marker?.counter) || 0;
  if (markerState >= GC_JOB_FINISH_BONUS) {
    return { finished: false, alreadyPaid: true };
  }
  if (markerState === 0) {
    // THE finish claim, FOLDED (the C1 repair): claim + pool credit + the
    // claim marker ride ONE atomic batch — an interrupted delivery can never
    // orphan a paid_total=100 stamp behind an empty Campfire. The credit's
    // fingerprint is the claimed finish row (lc) PLUS the changes() arm: a
    // raced claim that inserts nothing refuses to bank, even in its batch.
    const results = await db.batch([
      db.prepare(FINISH_INSERT_SQL).bind(
        serverId, weekKey, jobId, GC_JOB_FINISH_BONUS, now,
        serverId, weekKey, jobId,
      ),
      campfirePoolCreditStatement(db, serverId, poolShare, now, {
        sql: CLAIM_CREDIT_FP_SQL,
        binds: [serverId, weekKey, jobId],
      }),
      db.prepare(CLAIM_MARKER_INSERT_SQL).bind(serverId, weekKey, jobId, 1),
      // T90-c: the pool share's book row rides the claim's own batch (the
      // fold order's LAST seat — books and money commit together), under the
      // claimed marker's fresh insert for its changes arm and the claimed
      // finish row for its EXISTS arm.
      jobPoolLedgerStatement(db, serverId, poolShare, now, {
        sql: CLAIM_CREDIT_FP_SQL,
        binds: [serverId, weekKey, jobId],
      }),
    ]);
    if (Number(results[0].meta?.changes) !== 1) {
      return { finished: false, alreadyPaid: true };
    }
  }
  // markerState 1 (pending): the claim is already banked — deliver only;
  // the retry's answer stays the PK arm's alreadyPaid, never a second claim.

  // The member delivery (pool-first, members second): burn the unsplit share
  // into the pool, mint each online member's seat, and END on the delivered
  // stamp. Atomic, so a retry between claimed(1) and delivered(100) delivers
  // exactly once: the mints are themselves guarded on the claimed state, and
  // a delivery whose target already reads delivered mints nothing.
  const online = await onlineServerMembers(env, serverId).catch(() => []);
  const perMember = online.length > 0 ? Math.floor(memberShare / online.length) : 0;
  // The unsplit member share (rounding remainder, or the whole share when
  // nobody is online) burns into the pool — its own credit statement, so the
  // pool ledger shows exactly where the pool-first coins came from.
  const unsplit = memberShare - perMember * online.length;

  const delivery = [];
  if (unsplit > 0) {
    // The burned share fingerprints the CLAIMED marker (md, counter = 1) —
    // the same gauntlet the mints below carry. A delivery whose batch races
    // past another delivery's stamp can never double-bank: the marker leaving
    // claimed(1) means someone already delivered, so the credit refuses.
    delivery.push(campfirePoolCreditStatement(db, serverId, unsplit, now, {
      sql: UNSPLIT_CREDIT_FP_SQL,
      binds: [serverId, weekKey, jobId],
    }));
    // T90-c: the burned share's book row, the same batch, under the claimed
    // marker's own counter = 1 gauntlet (the delivered stamp rides last).
    delivery.push(jobPoolLedgerStatement(db, serverId, unsplit, now, {
      sql: UNSPLIT_CREDIT_FP_SQL,
      binds: [serverId, weekKey, jobId],
    }));
  }
  const seatOffset = delivery.length;
  for (const memberId of online) {
    if (perMember <= 0) break;
    delivery.push(db.prepare(MEMBER_SHARE_MINT_SQL).bind(
      memberId, perMember, now,
      serverId, weekKey, jobId,
      serverId, weekKey, jobId,
      serverId, memberId,
    ));
  }
  // The delivered stamp RIDES LAST: atomic with the mints it vouches for.
  delivery.push(db.prepare(DELIVERY_DONE_SQL).bind(
    GC_JOB_FINISH_BONUS, serverId, weekKey, jobId,
    GC_JOB_FINISH_BONUS,
  ));
  const deliveryResults = await db.batch(delivery);
  // The verdict walk is informational only: a member seat whose membership
  // vanished mid-flight mints nothing (its coins stay unminted — total mint
  // <= 100, never a leak). The pool ledger's own rows carry the count.
  let mintedSeats = 0;
  for (let index = 0; index < online.length; index += 1) {
    const seat = deliveryResults[seatOffset + index];
    if (seat && Number(seat.meta?.changes) === 1) mintedSeats += 1;
  }
  return markerState === 1
    ? { finished: false, alreadyPaid: true }
    : {
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
    serverId, userId,
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
