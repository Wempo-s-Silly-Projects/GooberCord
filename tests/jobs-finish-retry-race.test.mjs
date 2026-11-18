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

// The C1 repair's regression row (backend confirm + lead dispatch): the
// finish claim's affordance/credit split — the claim stands in its own batch
// while the pool credit waits across the presence-read await, so an
// interrupted delivery stamps paid_total=100 and banks NOTHING, and the PK
// arm then refuses every retry forever (the pool share is stuck, coins
// undeliverable). The repair folds the pool credit INTO the claim's one
// guarded batch (affordance + credit share the transaction; changes:0 =
// lost race, nothing commits) and the payouts fingerprint the claim's row.
//
// The replay: attempt 1 claims the finish; its payout batch is held at a
// gate and THROWN (the interrupted delivery, exactly what an isolate death
// looks like). Attempt 2 is the retry. The pool share must land EXACTLY
// ONCE — never lost to the interruption, never doubled by the retry.
import test from "node:test";
import assert from "node:assert/strict";

import { recordJobProgress, jobDefs, jobWeekKey, pickJobs } from "../api/jobs.mjs";
import { nowSeconds } from "../api/core/crypto.mjs";
import {
  GC_JOB_FINISH_BONUS,
  GC_JOB_POOL_SHARE_PERCENT,
  GC_JOB_MEMBER_SHARE_PERCENT,
} from "../constants.mjs";

const NOW = nowSeconds();
const WEEK = jobWeekKey(NOW);
const SERVER_ID = 1;
const ONLINE_ID = 22;
const POOL_SHARE = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_POOL_SHARE_PERCENT / 100);
const MEMBER_SHARE = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_MEMBER_SHARE_PERCENT / 100);
const PER_MEMBER = Math.floor(MEMBER_SHARE / 1);

function jobsRaceDb(options = {}) {
  const finishes = options.finishes || [];
  const campfires = options.campfires || [];
  const ledger = options.ledger || [];
  const counters = options.counters || [];
  const jobIdKind = options.jobIdKind || null; // the claim marker's kind (def.id)
  const calls = [];

  const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
  const STATE_TEST = (sql) => sql.startsWith("SELECT enabled FROM gc_server_jobs");
  const COUNTER_UPSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_job_counters");
  const COUNTER_READ_TEST = (sql) => sql.startsWith("SELECT counter FROM gc_job_counters");
  const FINISH_TEST = (sql) => sql.startsWith("INSERT INTO gc_job_finishes");
  const CREDIT_TEST = (sql) => sql.startsWith("INSERT INTO gc_campfires");
  const MEMBER_MINT_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger") && sql.includes("'job_finish'");
  const MEMBERSHIP_TEST = (sql) => sql.includes("gc_server_members");

  const counterFor = (serverId, weekKey, kind) =>
    counters.find((row) =>
      Number(row.server_id) === Number(serverId) &&
      Number(row.week_key) === Number(weekKey) &&
      row.kind === kind) || { counter: 0 };

  // The claim marker's counter — the delivery state the md fingerprint reads.
  const markerCount = () =>
    jobIdKind === null
      ? 0
      : Number(counters.find((row) => row.kind === jobIdKind)?.counter) || 0;

  const routes = [
    { test: SESSION_TEST, first: async () => null },
    { test: STATE_TEST, first: async () => ({ enabled: 1 }) },
    {
      test: COUNTER_UPSERT_TEST,
      run: (bound, sql) => {
        // [serverId, weekKey, kind, amount, | amount, amount]
        let row = counters.find((candidate) =>
          Number(candidate.server_id) === Number(bound[0]) &&
          Number(candidate.week_key) === Number(bound[1]) &&
          candidate.kind === bound[2]);
        if (!row) {
          row = { server_id: bound[0], week_key: bound[1], kind: bound[2], counter: 0 };
          counters.push(row);
        }
        row.counter += Number(bound[3]);
        calls.push({ call: "run", sql, bound, changes: 1 });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: COUNTER_READ_TEST,
      first: async (bound, sql) => ({ counter: counterFor(bound[0], bound[1], bound[2]).counter }),
    },
    {
      test: FINISH_TEST,
      run: (bound, sql) => {
        // [serverId, weekKey, jobId, paid_total, finished_at, | PK fp seats]
        const existing = finishes.some((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.week_key) === Number(bound[1]) &&
          row.job_id === bound[2]);
        // The PK arm the fake ENCODES: a lost race inserts nothing.
        if (existing) {
          calls.push({ call: "run", sql, bound, changes: 0 });
          return { meta: { changes: 0 } };
        }
        finishes.push({
          server_id: Number(bound[0]), week_key: Number(bound[1]),
          job_id: bound[2], paid_total: Number(bound[3]), finished_at: Number(bound[4]),
        });
        calls.push({ call: "run", sql, bound, changes: 1 });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: CREDIT_TEST,
      run: (bound, sql) => {
        // The credit upsert, its fingerprint seats encoded: the claim credit
        // carries the claimed finish row's EXISTS (lc) — a racer whose claim
        // never landed banks NOTHING; the burned unsplit credit carries the
        // claimed marker's EXISTS (md, counter = 1) — a delivery whose batch
        // queued past another delivery's stamp banks NOTHING. Refusals ride
        // the calls ledger as changes 0, so every test can count them.
        if (sql.includes("gc_job_finishes lc") && finishes.length === 0) {
          calls.push({ call: "run", sql, bound, changes: 0 });
          return { meta: { changes: 0 } };
        }
        if (sql.includes("gc_job_counters md") && markerCount() !== 1) {
          calls.push({ call: "run", sql, bound, changes: 0 });
          return { meta: { changes: 0 } };
        }
        const amount = Number(bound[1]);
        let row = campfires.find((candidate) =>
          Number(candidate.server_id) === Number(bound[0]));
        if (!row) {
          row = { server_id: Number(bound[0]), pool: 0 };
          campfires.push(row);
        }
        row.pool = Math.min(row.pool + amount, 5000);
        calls.push({ call: "run", sql, bound, changes: 1 });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: MEMBER_MINT_TEST,
      run: (bound, sql) => {
        // [memberId, perMember, now, | finishRow fp seats | membership seats]
        const entry = ({ call: "run", sql, bound, changes: null });
        calls.push(entry);
        // The fold's law encoded: the mint rides the claimed finish row's
        // own EXISTS (lf) AND the claimed marker's state (md, counter = 1)
        // — a delivery past the stamp mints nothing, a non-fingerprinted
        // mint banks nothing either (the shape regression this fake guards).
        entry.changes = sql.includes("gc_job_finishes lf") && markerCount() === 1 ? 1 : 0;
        if (entry.changes === 1) {
          ledger.push({
            user_id: Number(bound[0]), delta: Number(bound[1]),
            source: "job_finish", related_user_id: null, created_at: Number(bound[2]),
          });
        }
        return { meta: { changes: entry.changes } };
      },
    },
    {
      // The delivered stamp (DELIVERY_DONE_SQL): the marker's counter lifted
      // to the conservation note, guarded by AND counter < ? — one stamp
      // wins every stamp race, and the loser records a changes 0.
      test: (sql) => sql.startsWith("UPDATE gc_job_counters"),
      run: (bound, sql) => {
        // [100, serverId, weekKey, jobId, 100]
        const stampRow = counters.find((row) => row.kind === String(bound[3]));
        const changes = stampRow && Number(stampRow.counter) < Number(bound[4]) ? 1 : 0;
        if (changes === 1) stampRow.counter = Number(bound[0]);
        calls.push({ call: "run", sql, bound, changes });
        return { meta: { changes } };
      },
    },
    { test: MEMBERSHIP_TEST, all: async () => ({ results: [{ user_id: ONLINE_ID }] }) },
    { test: () => true, run: () => ({ meta: { changes: 1 } }) },
  ];

  // The payout batch is gated at its own entry (zero statements executed) —
  // throw mode = the interrupted delivery (an isolate death between the
  // batches); defer mode = the batch QUEUES and runs when released, exactly
  // what a second serialized D1 batch reads against.
  let holdCount = options.holdBatches ?? (options.holdFirstPayoutBatch ? 1 : 0);
  const deferHolds = options.holdMode === "defer";
  const deferredBatches = [];

  const db = {
    calls,
    finishes,
    campfires,
    ledger,
    counters,
    releaseThrow: () => { if (gateResolve) gateResolve(); },
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        return route && route.run ? await route.run(statement.bound, sql) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      if (holdCount > 0 &&
        statements.length > 0 &&
        !statements[0].sql.startsWith("INSERT INTO gc_job_finishes")) {
        holdCount -= 1;
        if (deferHolds) {
          // The delivery batch holds as an UNRESOLVED promise — its caller
          // suspends mid-await (the real flow's own presence-read await),
          // and the test decides WHEN it commits.
          return new Promise((resolve) => {
            deferredBatches.push({ statements, resolve });
          });
        }
        // The gate throws WITH zero statements executed: the delivery batch
        // died at its very entry, exactly what an isolate death looks like.
        throw new Error("D1 interrupted the delivery batch");
      }
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({ call: "batch", statements: statements.map((s) => ({ sql: s.sql, bound: s.bound })) });
      return results;
    },
    // Release held batches in order: each runs to completion exactly as a
    // serialized D1 batch would, then resolves.
    async releaseDeferred() {
      const queued = deferredBatches.splice(0, deferredBatches.length);
      for (const held of queued) {
        const results = [];
        for (const statement of held.statements) results.push(await statement.run());
        calls.push({ call: "batch", statements: held.statements.map((s) => ({ sql: s.sql, bound: s.bound })) });
        held.resolve(results);
      }
    },
    // Spin the event loop until n delivery batches are held (or the budget
    // runs out) — the honest way to pin an async chain mid-flight.
    async waitForDeferred(n) {
      for (let spins = 0; spins < 200 && deferredBatches.length < n; spins += 1) {
        await new Promise(setImmediate);
      }
      return deferredBatches.length;
    },
  };
  return db;
}

function envWithLimiters(db, onlineIds = [ONLINE_ID]) {
  const PRESENCE = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => new Response(
        // The snapshot carries the SAME id the roster route answers — the
        // presence ∩ roster intersection must pick the member up or the
        // member share burns into the pool and this row's shape means
        // nothing.
        JSON.stringify({ online: onlineIds.map((userId) => ({ userId })) }),
        { headers: { "content-type": "application/json" } },
      ),
    }),
  };
  return { GOOBER_DB: db, PRESENCE };
}

test("an interrupted pool delivery completes on the retry without double-paying", async () => {
  // The rotation's first selected def: its counter is seeded AT the goal
  // minus one, so the single progress event crosses it into the finish.
  const selected = pickJobs(SERVER_ID, WEEK);
  const def = selected[0];

  const db = jobsRaceDb({
    holdFirstPayoutBatch: true,
    // The claim marker's kind (def.id) — the md fingerprint's read key.
    jobIdKind: def.id,
    counters: [{ server_id: SERVER_ID, week_key: WEEK, kind: def.kind, counter: def.goal - 1 }],
  });

  // Attempt 1: the claim lands; the payout batch (credit + member share) is
  // held and thrown — the delivery is interrupted, exactly like an isolate
  // death between the claim batch and the payout batch.
  const firstAttempt = await recordJobProgress(
    envWithLimiters(db), SERVER_ID, def.kind, 1, NOW,
  ).then(
    (value) => ({ value }),
    (error) => ({ interrupted: true, error }),
  );
  assert.equal(db.finishes.length, 1, "the claim stands (paid_total stamped)");
  assert.equal(firstAttempt.interrupted, true, "the delivery batch died mid-flight");
  assert.equal(db.finishes[0].paid_total, GC_JOB_FINISH_BONUS);
  assert.equal(db.ledger.length, 0, "no member share leaked past the interruption");

  // Attempt 2: the RETRY. The PK arm refuses a second claim — and the
  // fold-in's answer: the pool share banks EXACTLY ONCE (the claim batch
  // carried its own credit), the retry delivers nothing twice, no coins
  // stay stuck behind the paid_total stamp.
  const retry = await recordJobProgress(envWithLimiters(db), SERVER_ID, def.kind, 1, NOW);
  assert.deepEqual(retry, { finished: false, alreadyPaid: true },
    "the retry is the PK arm's answer, never a second delivery");
  assert.equal(db.finishes.length, 1, "one finish row, ever");

  // THE POOL SHARE: banked EXACTLY ONCE — by the claim batch's own folded
  // credit, not by the payout batch that died, not by the retry.
  assert.equal(db.campfires.length, 1, "the pool share landed exactly once, never lost");
  assert.equal(db.campfires[0]?.pool, POOL_SHARE, "never doubled past POOL_SHARE");
  const creditRuns = db.calls.filter((call) =>
    call.call === "run" && call.sql?.startsWith("INSERT INTO gc_campfires") &&
    call.changes === 1);
  assert.equal(creditRuns.length, 1, "exactly one winning pool credit");

  // THE FOLD, pinned on the statements: the claim's own batch carries the
  // pool credit (its fingerprint rides the claimed finish row), and the
  // member mints carry the same claimed-row EXISTS.
  const claimBatch = db.calls.find((call) =>
    call.call === "batch" &&
    call.statements[0]?.sql.startsWith("INSERT INTO gc_job_finishes"));
  assert.ok(claimBatch, "the claim batch exists");
  assert.ok(claimBatch.statements.length >= 2,
    "the fold: the claim's batch carries more than the claim alone");
  const foldedCredit = claimBatch.statements[1];
  assert.ok(foldedCredit.sql.startsWith("INSERT INTO gc_campfires"),
    "the pool credit rides INSIDE the claim's batch");
  assert.ok(foldedCredit.sql.includes("gc_job_finishes lc"),
    "the credit's fingerprint is the claimed finish row itself");
  const memberMintSql = (await Promise.resolve(
    db.calls.find((call) => call.call === "run" && call.sql?.includes("'job_finish'"))?.sql)) || "";
  assert.ok(memberMintSql.includes("gc_job_finishes lf"),
    "the member mints fingerprint the claim's row");
  assert.ok(jobDefs.includes(def), "the def is one of the five static defs");
  assert.equal(POOL_SHARE + MEMBER_SHARE, GC_JOB_FINISH_BONUS, "the split conserves 100");
});

test("a delivery batch queuing behind another delivery's stamp re-banks nothing (interleaved D1 queue)", async () => {
  // Two entries inside the claimed(1) window, zero online members: the first
  // delivery banks the 20-coin burned share and stamps delivered; the second
  // delivery was ALREADY en route when the stamp ran (its pre-read saw
  // claimed(1)) — its serialized batch must bank nothing at all.
  const selected = pickJobs(SERVER_ID, WEEK);
  const def = selected[0];

  const db = jobsRaceDb({
    holdBatches: 2,
    holdMode: "defer",
    jobIdKind: def.id,
    counters: [{ server_id: SERVER_ID, week_key: WEEK, kind: def.kind, counter: def.goal - 1 }],
  });
  const env = envWithLimiters(db, []);

  const firstEntry = recordJobProgress(env, SERVER_ID, def.kind, 1, NOW);
  assert.equal(await db.waitForDeferred(1), 1, "the first delivery is en route (pre-read claimed the finish)");

  // The second INSIDE the claimed window: its pre-read also sees the marker
  // at claimed(1), so it is NOT the PK arm's loser — the fold's md gauntlet
  // is the only guard standing between it and a double-banked pool.
  const secondEntry = recordJobProgress(env, SERVER_ID, def.kind, 1, NOW);
  assert.equal(await db.waitForDeferred(2), 2, "the second delivery also queued inside the claimed window");

  // Serialized D1: the first delivery commits (unsplit credit + stamp), THEN
  // the second executes against the stamped marker.
  await db.releaseDeferred();
  assert.deepEqual(
    await firstEntry, { finished: true, minted: GC_JOB_FINISH_BONUS, poolShare: POOL_SHARE, mintedShare: 0 },
    "the claiming entry answers the normal finish verdict",
  );
  assert.deepEqual(await secondEntry, { finished: false, alreadyPaid: true });

  const finishes = await Promise.resolve(db.finishes);
  assert.equal(finishes.length, 1, "one finish row, ever");
  const banked = db.calls.filter((call) =>
    call.call === "run" && call.sql?.startsWith("INSERT INTO gc_campfires") &&
    call.changes === 1);
  assert.equal(banked.length, 2,
    "exactly two banks total: the claim batch's 80 + the first delivery's 20");
  const refused = db.calls.filter((call) =>
    call.call === "run" && call.sql?.startsWith("INSERT INTO gc_campfires") &&
    call.changes === 0);
  assert.equal(refused.length, 1,
    "the queued delivery's credit hit the md gauntlet and banked NOTHING");
  assert.equal(db.campfires[0]?.pool, POOL_SHARE + MEMBER_SHARE,
    "the pool holds the finish's 100, never the race's 120");
  assert.equal(db.ledger.length, 0, "no member mint with zero online members");
});
