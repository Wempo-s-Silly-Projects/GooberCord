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

// T90 The Campfire Ledger — the RED rows (spec: docs/drafts/t90-campfire-ledger-spec.md).
// DELIVERED FAILING: no ledger route in api/campfire.mjs, no migration 0039,
// no constants export. Idiom: the paperDb aggregate fake
// (tests/morning-paper-red.test.mjs) with the lead-ruled fake laws
// (tests/bookmarks-red.test.mjs): the session fake compares sha256Hex(token)
// at bound[0] (auth.mjs binds the hash — raw-token compare starves every
// session), and statement routes are ordered prefix-anchored first
// (routes.find() is first-match). The ledger is DERIVED ON REQUEST (the
// T87 idiom, api/paper.mjs): the fake seeds RAW pool-ledger rows and answers
// the aggregate read ONLY when the statement carries a GROUP BY, grouping by
// (class, source, direction) itself — so a GREEN that emits per-row or
// per-member lines cannot assemble the payload shape and fails here. The read
// mints and sinks NOTHING (spec §4.5): any INSERT/UPDATE/DELETE in the call
// log fails the read's audit, and a per-member derivation from gc_coin_ledger
// has no route in the fake — it fails by silence never being banked.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import worker from "../worker.mjs";
import { pickJobs, recordJobProgress, jobWeekKey } from "../api/jobs.mjs";
import {
  GC_JOB_FINISH_BONUS,
  GC_JOB_MEMBER_SHARE_PERCENT,
  GC_JOB_POOL_SHARE_PERCENT,
  GC_SEASON_REWARD_COINS,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const SERVER_ID = 1;
const OTHER_SERVER_ID = 2;
const MEMBER_ID = 22;
const OUTSIDER_ID = 44; // signed in, but not a member of SERVER_ID
const NOW = nowSeconds();
const WINDOW_SECONDS = 2592000; // spec §4.3: the 30-day fixed lookback

const MEMBER_TOKEN = "M".repeat(40);
const OUTSIDER_TOKEN = "X".repeat(40);

// auth.mjs binds sha256Hex(token) as token_hash (core/auth.mjs:104-105),
// so the session fake must compare the HASH — a raw-token comparison
// starves every session and 401s the whole lane (lead-ruled fake law
// of 2026-11-18; mirror of tests/bookmarks-red.test.mjs).
const MEMBER_HASH = await sha256Hex(MEMBER_TOKEN);
const OUTSIDER_HASH = await sha256Hex(OUTSIDER_TOKEN);

function sessionRow(userId, tokenSeed) {
  return {
    token_hash: tokenSeed.repeat(32).slice(0, 64),
    user_id: userId,
    csrf_token: "C".repeat(24),
    expires_at: nowSeconds() + 3600,
    username: "member" + userId,
  };
}
const MEMBER_SESSION = sessionRow(MEMBER_ID, "M");
const OUTSIDER_SESSION = sessionRow(OUTSIDER_ID, "X");

// The SINK LAW EXHIBIT labels (spec §3.2): the exact source classes the
// economy's own statements already record — 'campfire_stoke' is the stoke
// spend's label (api/campfire.mjs:74 STOKE_SPEND_SQL), 'chain_fee' the
// chain-fee spend's (api/coins.mjs:267 CHAIN_FEE_SPEND_SQL), and 'campfire'
// the draw payout's (api/campfire.mjs:119 DRAW_PAYOUT_SQL).
const STOKE_SOURCE = "campfire_stoke";
const CHAIN_FEE_SOURCE = "chain_fee";
const DRAW_SOURCE = "campfire";

// The ledgerDb fake: the raw pool-ledger rows ARE the whole seat (spec §2's
// 0039 shape — no member column exists to seed), plus the membership set the
// shared memberGate reads. The aggregate route matches ONLY a GROUP BY
// statement over gc_campfire_pool_ledger and merges the raw rows by
// (class, source, direction) — two rows in one class MUST answer one flow
// line, so a per-row or per-member rollup cannot paint the payload.
// RIDES AFTER the membership route: routes.find() is first-match, and the
// prefix-anchored membership read must never be shadowed by a broader
// includes() route (the lead-ruled fake law of 2026-11-18).
function ledgerDb(options = {}) {
  const membership = new Set(options.membership || []); // "user_id:server_id"
  const poolLedger = (options.poolLedger || []).map((row) => ({ ...row }));
  const calls = [];

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async (bound) => {
        const token = String(bound[0] || "");
        if (token === MEMBER_HASH) return MEMBER_SESSION;
        if (token === OUTSIDER_HASH) return OUTSIDER_SESSION;
        return null;
      },
    },
    {
      // The shared memberGate's membership read (api/campfire.mjs:90-91):
      // binds are (serverId, userId); absence IS the unknown-server 404 —
      // no existence oracle.
      test: (sql) => sql.startsWith("SELECT role FROM gc_server_members"),
      first: async (bound) => {
        const key = Number(bound[1]) + ":" + Number(bound[0]);
        return membership.has(key) ? { role: "member" } : null;
      },
    },
    {
      // The ONE aggregate read (spec §4.4): GROUP BY class, source, direction
      // over gc_campfire_pool_ledger. The fake groups the raw rows itself and
      // answers SUM(delta) AS amount, COUNT(*) AS count. Binds follow the
      // spec's clause order: (serverId, windowStart). No GROUP BY in the SQL
      // (a per-row or per-member emitter) matches nothing here and starves —
      // flows cannot be painted from an ungrouped read.
      test: (sql) => sql.includes("FROM gc_campfire_pool_ledger") && sql.includes("GROUP BY"),
      all: async (bound) => {
        const serverId = Number(bound[0]);
        const windowStart = bound[1] === undefined ? null : Number(bound[1]);
        const grouped = new Map();
        for (const row of poolLedger) {
          if (row.server_id !== serverId) continue;
          if (windowStart !== null && row.created_at < windowStart) continue;
          const key = row.class + "\u0000" + row.source + "\u0000" + row.direction;
          if (grouped.has(key)) {
            grouped.get(key).amount += row.delta;
            grouped.get(key).count += 1;
          } else {
            grouped.set(key, {
              class: row.class,
              source: row.source,
              direction: row.direction,
              amount: row.delta,
              count: 1,
            });
          }
        }
        return { results: [...grouped.values()] };
      },
    },
  ];

  const db = {
    calls,
    poolLedger,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql)) || null;
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound, call: "first" });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound, call: "all" });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound, call: "run" });
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
  };
  return db;
}

const SEED = {
  membership: [MEMBER_ID + ":" + SERVER_ID],
  // Three same-class stoke credit rows (the merge exhibit: ONE flow line,
  // amount 300, count 3 — the spec §5 painted row) beside the chain-fee line
  // and the draw-mint line; the other-server row must never leak across the
  // server-keyed WHERE.
  poolLedger: [
    { server_id: SERVER_ID, class: "pool-credit", source: STOKE_SOURCE, direction: "in", delta: 100, created_at: NOW - 60 },
    { server_id: SERVER_ID, class: "pool-credit", source: STOKE_SOURCE, direction: "in", delta: 100, created_at: NOW - 50 },
    { server_id: SERVER_ID, class: "pool-credit", source: STOKE_SOURCE, direction: "in", delta: 100, created_at: NOW - 40 },
    { server_id: SERVER_ID, class: "pool-credit", source: CHAIN_FEE_SOURCE, direction: "in", delta: 25, created_at: NOW - 30 },
    { server_id: SERVER_ID, class: "member-share-mint", source: DRAW_SOURCE, direction: "out", delta: 10, created_at: NOW - 20 },
    { server_id: SERVER_ID, class: "member-share-mint", source: DRAW_SOURCE, direction: "out", delta: 10, created_at: NOW - 10 },
    { server_id: OTHER_SERVER_ID, class: "pool-credit", source: STOKE_SOURCE, direction: "in", delta: 999, created_at: NOW - 5 },
  ],
};

function envOf(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function authed(method, path, session) {
  // session === null rides NO cookie: the un-authed visitor arm, Origin
  // present per the fleet csrf law.
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(session
        ? {
            Cookie: "__Host-goober_session=" + session.__token,
            "X-CSRF-Token": session.csrf_token,
          }
        : {}),
    },
  });
}
MEMBER_SESSION.__token = MEMBER_TOKEN;
OUTSIDER_SESSION.__token = OUTSIDER_TOKEN;

// The generic route-tail 404 the worker answers before the ledger exists —
// the shared unknown-server 404 must be a DIFFERENT body.
const GENERIC_404 = "That API endpoint does not exist.";

// --- rows -------------------------------------------------------------------

test("GC_CAMPFIRE_LEDGER_WINDOW_SECONDS is a named constants.mjs export riding 2592000 — the lookback never rides a magic number", () => {
  const constants = readFileSync(new URL("../constants.mjs", import.meta.url), "utf8");
  assert.match(constants, /export const GC_CAMPFIRE_LEDGER_WINDOW_SECONDS = 2592000\b/,
    "the fixed 30-day lookback is a named constants.mjs import beside the GC_CAMPFIRE_* family");
  const campfire = readFileSync(new URL("../api/campfire.mjs", import.meta.url), "utf8");
  assert.match(campfire, /\bGC_CAMPFIRE_LEDGER_WINDOW_SECONDS\b/,
    "the ledger route reads the window from the constant, never an inline 2592000");
});

test("the pool-ledger seat ships as ONE CREATE-only migration 0039: server-keyed, no member column, no backfill (spec §2 — NONE-NEEDED is FALSE)", () => {
  // The spec's migration verdict: pool-flow rows do NOT already exist
  // (gc_campfires.pool is one overwritten meter column; gc_coin_ledger is
  // member-keyed), so migration 0039 CREATE-only is REQUIRED — the ledger's
  // history cannot be derived without it.
  const migration = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => /0039_gc_campfire_pool_ledger\.sql$/.test(name))
    .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  assert.equal(migration.length, 1, "the migration occupies the 0039 ordinal");
  const text = migration[0];
  const body = text.slice(
    text.indexOf("CREATE TABLE gc_campfire_pool_ledger"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_campfire_pool_ledger")),
  );
  const creates = text.match(/CREATE TABLE/g) || [];
  assert.equal(creates.length, 1, "the pool ledger IS the whole seat — ONE table, CREATE-only");
  assert.ok(body.includes("REFERENCES gc_servers(id) ON DELETE CASCADE"), "a deleted server cascades its books away");
  for (const column of ["server_id", "class", "source", "direction", "delta", "created_at"]) {
    assert.match(body, new RegExp("\\b" + column + "\\b"), column + " rides the seat");
  }
  assert.doesNotMatch(text, /\b(user_id|related_user_id|member)\b/,
    "NO member column, ever — the no-attribution law rides the schema itself");
  assert.doesNotMatch(text, /\bINSERT INTO\b/, "no backfill: the books open at migration day");
  assert.doesNotMatch(text, /\b(ALTER|DROP|UPDATE|DELETE FROM)\b/, "CREATE-only, no shared-table edit");
});

test("un-authed GET /api/servers/:id/ledger with Origin present answers the 401 gate before any ledger statement fires", async () => {
  const db = ledgerDb(SEED);
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/ledger", null), envOf(db), {},
  );
  assert.equal(response.status, 401, "the member gate answers the un-signed 401");
  const ledgerStatements = db.calls.filter((call) =>
    call.sql.includes("gc_campfire_pool_ledger") || call.sql.includes("gc_coin_ledger"));
  assert.equal(ledgerStatements.length, 0, "the 401 rides ahead of the books — no ledger statement");
});

test("a signed-in non-member shares the unknown-server 404 body verbatim — no existence oracle, not the dispatch tail", async () => {
  const db = ledgerDb(SEED); // OUTSIDER_ID rides membership: []
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/ledger", OUTSIDER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error, "This server does not exist or you cannot view it.",
    "the shared unknown-server 404 class verbatim (api/campfire.mjs:284)");
  assert.notEqual(payload.error, GENERIC_404, "not the dispatch tail's generic 404");
});

test("the ledger read is DERIVED ON REQUEST: zero coin-affecting statements fire (no INSERT/UPDATE/DELETE, no gc_coin_ledger, no draw)", async () => {
  const db = ledgerDb(SEED);
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/ledger", MEMBER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 200, "the read exists and answers the books");
  const writes = db.calls.filter((call) =>
    /^(INSERT INTO|UPDATE|DELETE FROM)/.test(call.sql));
  assert.deepEqual(writes.map((call) => call.sql), [],
    "a book-keeper who stokes the fire during the audit wears gloves — ZERO writes of any kind");
  const coinStatements = db.calls.filter((call) => call.sql.includes("gc_coin_ledger"));
  assert.equal(coinStatements.length, 0,
    "the member-keyed gc_coin_ledger is never the ledger's basis (spec §2 — no attribution)");
});

test("flows merge per (class, source, direction) — three same-class stoke rows answer ONE flow line, never per-row or per-member lines", async () => {
  const db = ledgerDb(SEED);
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/ledger", MEMBER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.flows), "flows is a list, never an error");
  assert.equal(payload.flows.length, 3,
    "one line per (class, source, direction) present — the per-member/per-row rollup is impossible here");
  assert.deepEqual(
    payload.flows.find((flow) => flow.source === STOKE_SOURCE),
    { class: "pool-credit", source: STOKE_SOURCE, direction: "in", amount: 300, count: 3 },
    "the stoke flow merges its three rows (spec §5's painted line)");
  assert.deepEqual(
    payload.flows.find((flow) => flow.source === CHAIN_FEE_SOURCE),
    { class: "pool-credit", source: CHAIN_FEE_SOURCE, direction: "in", amount: 25, count: 1 });
  assert.deepEqual(
    payload.flows.find((flow) => flow.class === "member-share-mint"),
    { class: "member-share-mint", source: DRAW_SOURCE, direction: "out", amount: 20, count: 2 },
    "the mint flow merges its two rows");
  assert.equal(payload.flows.reduce((total, flow) => total + flow.amount, 0), 300 + 25 + 20,
    "the other server's 999-coin row never crosses the server-keyed WHERE");
  // No leaderboard law (spec §4.6): the payload is aggregate-only, never
  // per-member — no ids, no usernames, no ranked member rows.
  const painted = JSON.stringify(payload);
  assert.doesNotMatch(painted, /"user_id"|"userId"|"username"|"memberIds"|"top"|"rank"/,
    "no member-level key rides any flow line");
});

test("the sink law exhibit: every flow line carries the exact source class the economy's own statements already record", async () => {
  const db = ledgerDb(SEED);
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/ledger", MEMBER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const pinnedSources = [STOKE_SOURCE, CHAIN_FEE_SOURCE, DRAW_SOURCE];
  for (const flow of payload.flows) {
    assert.ok(pinnedSources.includes(flow.source),
      "source '" + flow.source + "' is named exactly as the real statement records it: " +
      "'campfire_stoke' (api/campfire.mjs:74), 'chain_fee' (api/coins.mjs:267), 'campfire' (api/campfire.mjs:119)");
    assert.equal(["pool-credit", "member-share-mint", "seat-refund", "draw-reversal"].includes(flow.class), true,
      "the class enum is exactly the spec §5 four");
    assert.equal(["in", "out"].includes(flow.direction), true,
      "the direction enum is exactly 'in' and 'out'");
  }
});

test("an empty ledger answers { window, flows: [] } with status 200 — a quiet fire is VALID, never a 404", async () => {
  const db = ledgerDb({ membership: [MEMBER_ID + ":" + SERVER_ID], poolLedger: [] });
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/ledger", MEMBER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 200, "an empty book is a VALID book, not an error");
  const payload = await response.json();
  assert.deepEqual(payload.flows, [], "the empty shape serves verbatim — no zero lines, no invented rows");
  assert.equal(typeof payload.window.startSeconds, "number", "the window's start is a number");
  assert.equal(typeof payload.window.endSeconds, "number", "the window's end is a number");
  assert.equal(payload.window.endSeconds - payload.window.startSeconds, WINDOW_SECONDS,
    "the fixed 30-day lookback rides the window shape");
});

// --- T90-c: the companion book rows at the jobs/seasons pool-credit call sites
// (spec §3 note 5) -------------------------------------------------------------
//
// The pool ledger's v1 shipped with a KNOWN PARTIAL: the two campfirePoolCreditStatement
// callers outside api/campfire.mjs — the jobs finish's pool shares and the
// seasonal credits — booked NOTHING, so the conservation read showed `in`
// visibly under the true credit. T90-c books the job-finish/season classes:
// a companion INSERT INTO gc_campfire_pool_ledger rides the SAME batch as its
// credit (books and money commit together), class='pool-credit',
// direction='in', and the source mirrors the call site's own gc_coin_ledger
// label — 'job_finish' (api/jobs.mjs MEMBER_SHARE_MINT_SQL), 'season_finish'
// (api/seasons.mjs MEMBER_SHARE_MINT_SQL) — never a new label. These pins go
// RED first: a RED here is the missing companion, not a broken economy (the
// credit upserts and their verdicts stay untouched by the lane).

const JOB_LEDGER_SOURCE = "job_finish";
const SEASON_LEDGER_SOURCE = "season_finish";
const POOL_SHARE = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_POOL_SHARE_PERCENT / 100);
const MEMBER_SHARE = Math.round(GC_JOB_FINISH_BONUS * GC_JOB_MEMBER_SHARE_PERCENT / 100);

// The batched companion list, read straight off the call log: only rows that
// rode a batch count — a free-running book row outside its credit's batch is
// the shape this pin refuses (the campfire.mjs companions are batch members).
function batchedCompanions(calls) {
  return calls.flatMap((entry) =>
    entry.call === "batch"
      ? entry.statements.filter((statement) =>
          statement.sql.startsWith("INSERT INTO gc_campfire_pool_ledger"))
      : []);
}

// The jobs-side fake: a strip of the jobsRaceDb fake (the
// jobs-finish-retry-race.test.mjs lanes) cut to the statements the finish
// fires — activity counters keyed by kind, the marker keyed by job id, the
// credit upsert banking plainly under the same 5000 cap, and everything else
// (the companion itself) defaulting to changes 1. Zero online members (no
// PRESENCE binding), so both pool credits fire: the claim's 80 and the
// burned unsplit 20.
function t90cJobsDb(seedCounters) {
  const counters = seedCounters.map((row) => ({ ...row }));
  const finishes = [];
  const campfires = [];
  const calls = [];
  const counterOf = (serverId, weekKey, key) =>
    counters.find((row) => Number(row.server_id) === Number(serverId) &&
      Number(row.week_key) === Number(weekKey) && row.kind === key)?.counter ?? 0;
  const routes = [
    { test: (sql) => sql.startsWith("SELECT enabled FROM gc_server_jobs"), first: async () => ({ enabled: 1 }) },
    { test: (sql) => sql.startsWith("INSERT INTO gc_job_counters"), run: (bound) => {
        const row = counters.find((candidate) =>
          Number(candidate.server_id) === Number(bound[0]) &&
          Number(candidate.week_key) === Number(bound[1]) &&
          candidate.kind === bound[2]);
        if (row) row.counter = Number(row.counter) + Number(bound[3]);
        else counters.push({
          server_id: Number(bound[0]), week_key: Number(bound[1]),
          kind: bound[2], counter: Number(bound[3]),
        });
        return { meta: { changes: 1 } };
      } },
    { test: (sql) => sql.startsWith("SELECT counter FROM gc_job_counters"),
      first: (bound) => ({ counter: counterOf(bound[0], bound[1], bound[2]) }) },
    { test: (sql) => sql.startsWith("INSERT INTO gc_job_finishes"), run: (bound) => {
        const existing = finishes.some((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.week_key) === Number(bound[1]) && row.job_id === bound[2]);
        if (existing) return { meta: { changes: 0 } };
        finishes.push({
          server_id: Number(bound[0]), week_key: Number(bound[1]),
          job_id: bound[2], paid_total: Number(bound[3]),
        });
        return { meta: { changes: 1 } };
      } },
    { test: (sql) => sql.startsWith("INSERT INTO gc_campfires"), run: (bound) => {
        let row = campfires.find((candidate) =>
          Number(candidate.server_id) === Number(bound[0]));
        if (!row) {
          row = { server_id: Number(bound[0]), pool: 0 };
          campfires.push(row);
        }
        row.pool = Math.min(row.pool + Number(bound[1]), 5000);
        return { meta: { changes: 1 } };
      } },
    { test: (sql) => sql.startsWith("UPDATE gc_job_counters"), run: () => ({ meta: { changes: 1 } }) },
  ];
  const db = {
    calls,
    finishes,
    campfires,
    prepare(sql) {
      const route = routes.find((candidate) => candidate.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.run = async () =>
        route && route.run ? route.run(statement.bound) : { meta: { changes: 1 } };
      statement.first = async () =>
        route && route.first ? route.first(statement.bound) : null;
      statement.all = async () =>
        route && route.all ? route.all(statement.bound) : { results: [] };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({ call: "batch", statements: statements.map((entry) => ({
        sql: entry.sql, bound: entry.bound,
      })) });
      return results;
    },
  };
  return db;
}

test("T90-c: a job-finish pool share books a pool-credit ledger row in the SAME batch (spec §3 note 5)", async () => {
  const weekFloor = jobWeekKey(NOW);
  const def = pickJobs(SERVER_ID, weekFloor)[0];
  const db = t90cJobsDb([{
    server_id: SERVER_ID, week_key: weekFloor, kind: def.kind, counter: def.goal,
  }]);
  const outcome = await recordJobProgress({ GOOBER_DB: db }, SERVER_ID, def.kind, 1, NOW);
  assert.ok(outcome && outcome.finished, "the finish ran");
  // ONE companion per pool credit — the claim's share and the burned unsplit
  // share each book; a free-running book row outside a batch never counts.
  const companions = batchedCompanions(db.calls);
  assert.equal(companions.length, 2,
    "the claim share AND the burned unsplit share each book one ledger row, inside their own batches");
  for (const companion of companions) {
    assert.ok(companion.sql.includes("'pool-credit'"), "class is the pool-credit flow class");
    assert.ok(companion.sql.includes("'direction', 'in'") || companion.sql.includes(", 'in', "),
      "direction is pool-in");
  }
  assert.deepEqual(companions.map((companion) => companion.bound[1]),
    [JOB_LEDGER_SOURCE, JOB_LEDGER_SOURCE],
    "the source mirrors the finish's own gc_coin_ledger label ('job_finish', MEMBER_SHARE_MINT_SQL), never a new one");
  assert.deepEqual(companions.map((companion) => companion.bound[2]),
    [POOL_SHARE, MEMBER_SHARE],
    "each book carries its own credit's amount, verbatim");
  // Same-batch pin: the claim batch carries BOTH the money (the credit
  // upsert) and the book row.
  const claimBatch = db.calls.find((entry) =>
    entry.call === "batch" &&
    entry.statements[0].sql.startsWith("INSERT INTO gc_job_finishes"));
  assert.ok(claimBatch.statements.some((statement) =>
    statement.sql.startsWith("INSERT INTO gc_campfires")),
    "the credit rides the claim batch");
  assert.ok(claimBatch.statements.some((statement) =>
    statement.sql.startsWith("INSERT INTO gc_campfire_pool_ledger")),
    "the book row rides the SAME batch");
  // ZERO behavioral change: the pool still holds exactly the finish's coins.
  assert.equal(db.campfires[0]?.pool, POOL_SHARE + MEMBER_SHARE,
    "the credit verdicts are untouched — the pool conserves the finish's 100");
});

// The seasons-side fake: a strip of the seasons route's statements — the
// session hash read, the member gate, the current-season lookup (an expired
// met season), the frozen meter, the guarded completion claim, the credit
// upsert, and the mint. Zero online members, so the finish banks poolShare +
// the burned unsplit share.
function t90cSeasonsDb(season) {
  const completions = [];
  const campfires = [];
  const calls = [];
  const routes = [
    { test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async (bound) => String(bound[0]) === MEMBER_HASH ? MEMBER_SESSION : null },
    { test: (sql) => sql.startsWith("SELECT role FROM gc_server_members"),
      first: async () => ({ role: "member" }) },
    { test: (sql) => sql.includes("FROM gc_server_seasons"), first: async () => ({ ...season }) },
    { test: (sql) => sql.includes("FROM gc_message_reactions"), first: async () => ({ meter: 5 }) },
    { test: (sql) => sql.startsWith("INSERT INTO gc_season_completions"), run: () => {
        completions.push({ server_id: SERVER_ID, season_started_at: season.started_at });
        return { meta: { changes: 1 } };
      } },
    { test: (sql) => sql.startsWith("SELECT completed_at FROM gc_season_completions"),
      first: async () => completions.length > 0 ? completions[0] : null },
    { test: (sql) => sql.startsWith("INSERT INTO gc_campfires"), run: (bound) => {
        let row = campfires.find((candidate) => Number(candidate.server_id) === Number(bound[0]));
        if (!row) {
          row = { server_id: Number(bound[0]), pool: 0 };
          campfires.push(row);
        }
        row.pool = Math.min(row.pool + Number(bound[1]), 5000);
        return { meta: { changes: 1 } };
      } },
    { test: (sql) => sql.startsWith("INSERT INTO gc_coin_ledger"), run: () => ({ meta: { changes: 1 } }) },
  ];
  const db = {
    calls,
    campfires,
    prepare(sql) {
      const route = routes.find((candidate) => candidate.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.run = async () =>
        route && route.run ? route.run(statement.bound) : { meta: { changes: 1 } };
      statement.first = async () =>
        route && route.first ? route.first(statement.bound) : null;
      statement.all = async () =>
        route && route.all ? route.all(statement.bound) : { results: [] };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({ call: "batch", statements: statements.map((entry) => ({
        sql: entry.sql, bound: entry.bound,
      })) });
      return results;
    },
  };
  return db;
}

test("T90-c: a seasonal pool credit books a season_finish ledger row in the SAME batch (spec §3 note 5)", async () => {
  const season = {
    started_at: NOW - 2 * 604800, // a one-week season, long closed
    name: "Ledger", color: "green", goal: 1, week_count: 1,
    created_by: 999, created_at: NOW - 2 * 604800,
  };
  const db = t90cSeasonsDb(season);
  const response = await worker.fetch(
    authed("GET", "/api/servers/" + SERVER_ID + "/seasons/current", MEMBER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.completed, true, "the expired met season completed lazily");
  const seasonPoolShare = Math.round(GC_SEASON_REWARD_COINS * GC_JOB_POOL_SHARE_PERCENT / 100);
  const seasonMemberShare = Math.round(GC_SEASON_REWARD_COINS * GC_JOB_MEMBER_SHARE_PERCENT / 100);
  const companions = batchedCompanions(db.calls);
  assert.equal(companions.length, 2,
    "the pool share AND the burned unsplit share each book one ledger row");
  for (const companion of companions) {
    assert.ok(companion.sql.includes("'pool-credit'"), "class is the pool-credit flow class");
  }
  assert.deepEqual(companions.map((companion) => companion.bound[1]),
    [SEASON_LEDGER_SOURCE, SEASON_LEDGER_SOURCE],
    "the source mirrors the finish's own gc_coin_ledger label ('season_finish', MEMBER_SHARE_MINT_SQL), never a new one");
  assert.deepEqual(companions.map((companion) => companion.bound[2]),
    [seasonPoolShare, seasonMemberShare],
    "each book carries its own credit's amount, verbatim");
  const finishBatch = db.calls.find((entry) =>
    entry.call === "batch" &&
    entry.statements.some((statement) => statement.sql.startsWith("INSERT INTO gc_campfires")));
  assert.ok(finishBatch.statements.some((statement) =>
    statement.sql.startsWith("INSERT INTO gc_season_completions") === false),
    "the finish's batch exists");
  assert.equal(finishBatch.statements.some((statement) =>
    statement.sql.startsWith("INSERT INTO gc_campfires")), true,
    "the credits ride the finish's batch");
  assert.equal(finishBatch.statements.filter((statement) =>
    statement.sql.startsWith("INSERT INTO gc_campfire_pool_ledger")).length, 2,
    "both book rows ride the SAME batch as their credits");
  assert.equal(db.campfires[0]?.pool, seasonPoolShare + seasonMemberShare,
    "the credit verdicts are untouched — the pool conserves the season's 250");
});
