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

// T86 Goober Jobs — the sink-law rows (spec: docs/drafts/t86-goober-jobs-spec.md).
// The lane's RED rows were delivered failing (no module, no routes, no DDL);
// these are the same pins made executable against api/jobs.mjs +
// migrations/0032_gc_server_jobs.sql. Idiom: the coins-module fakeDb +
// pinned-SQL contract style — every statement's guard arms are ENCODED in the
// fake, so a pinned statement that loses an arm fails the tests (the ceiling
// arm, the once-per-week PK, the pool fingerprint, the owner gate).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import worker from "../worker.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import * as C from "../constants.mjs";
import { jobDefs, jobWeekKey, pickJobs, recordJobProgress } from "../api/jobs.mjs";
import { nowSeconds } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const SERVER_ID = 1;
const USER_ID = 7;
const OTHER_ID = 22;
const DAY = 86400;
const NOW = nowSeconds();
const WEEK_KEY = jobWeekKey(NOW);

const SESSION_TOKEN = "A".repeat(40);

const SESSION_ROW = {
  token_hash: "S".repeat(64),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "wempos",
};

function coinDb(options = {}) {
  const roster = options.roster || [USER_ID, OTHER_ID];
  const serverJobs = new Map(options.serverJobs || []); // server_id -> enabled (0/1)
  const counters = new Map(options.counters || []);     // "srv:week:kind" -> counter
  const finishes = new Map(options.finishes || []);     // "srv:week:job" -> { paidTotal, at }
  const campfires = new Map(options.campfires || []);   // server_id -> { pool }
  const ledgers = options.ledgers || [];                // [{ user_id, delta }]
  const calls = [];

  const balanceOf = (userId) =>
    ledgers.reduce((total, row) => total + (row.user_id === userId ? row.delta : 0), 0);
  const counterOf = (serverId, weekKey, kind) =>
    counters.get(`${serverId}:${weekKey}:${kind}`) || 0;
  const bumpCounter = (serverId, weekKey, kind, amount) => {
    const key = `${serverId}:${weekKey}:${kind}`;
    counters.set(key, counterOf(serverId, weekKey, kind) + amount);
    return counterOf(serverId, weekKey, kind);
  };

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      test: (sql) => sql.startsWith("SELECT role FROM gc_server_members"),
      first: async (bound) => (roster.includes(Number(bound[1])) ? { role: "owner" } : null),
    },
    {
      test: (sql) => sql.startsWith("SELECT user_id FROM gc_server_members WHERE server_id = ?"),
      all: async (bound) => ({
        results: roster.filter((id) => Number(bound[0]) === SERVER_ID)
          .map((id) => ({ user_id: id })),
      }),
    },
    {
      test: (sql) => sql.startsWith("SELECT enabled FROM gc_server_jobs"),
      first: async (bound) =>
        serverJobs.has(Number(bound[0]))
          ? { enabled: serverJobs.get(Number(bound[0])) }
          : null,
    },
    {
      test: (sql) => sql.startsWith("INSERT INTO gc_server_jobs"),
      run: (bound) => {
        // The owner gate rides INSIDE the statement (binds 5/6: server + user)
        // — the fake encodes it, so a pinned toggle that loses the arm fails
        // here.
        const isOwner = roster.includes(Number(bound[6]));
        if (!isOwner) return { meta: { changes: 0 } };
        serverJobs.set(Number(bound[0]), Number(bound[1]));
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("INSERT INTO gc_job_counters"),
      run: (bound) => {
        const before = counterOf(bound[0], bound[1], bound[2]);
        if (before + Number(bound[5]) > C.GC_JOB_COUNTER_SANITY_CAP) {
          return { meta: { changes: 0 } };
        }
        const after = bumpCounter(bound[0], bound[1], bound[2], Number(bound[3]));
        return { meta: { changes: after === before + Number(bound[3]) ? 1 : 0 } };
      },
    },
    {
      test: (sql) => sql.startsWith("SELECT counter FROM gc_job_counters"),
      first: async (bound) => ({ counter: counterOf(bound[0], bound[1], bound[2]) }),
    },
    {
      test: (sql) => sql.startsWith("SELECT kind, counter FROM gc_job_counters"),
      all: async (bound) => ({
        results: [bound[2], bound[3], bound[4]].map((kind) => ({
          kind, counter: counterOf(bound[0], bound[1], kind),
        })),
      }),
    },
    {
      test: (sql) => sql.startsWith("INSERT INTO gc_job_finishes"),
      run: (bound) => {
        const key = `${bound[0]}:${bound[1]}:${bound[2]}`;
        if (finishes.has(key)) return { meta: { changes: 0 } };
        finishes.set(key, { paidTotal: Number(bound[3]), at: Number(bound[4]) });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The finish's pool credit (campfirePoolCreditStatement's shape): the
      // two-step design fingerprints nothing — the finish claim's changes
      // verdict IS the race answer, so every credit statement here is plain
      // and the double-finish row pins the conservation at the claim.
      test: (sql) => sql.startsWith("INSERT INTO gc_campfires"),
      run: (bound) => {
        const amount = Number(bound[1]);
        const current = campfires.get(Number(bound[0])) || { pool: 0 };
        campfires.set(Number(bound[0]), { pool: Math.min(current.pool + amount, C.GC_CAMPFIRE_MAX_POOL) });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("UPDATE gc_campfires SET pool"),
      run: (bound) => {
        const current = campfires.get(Number(bound[2])) || { pool: 0 };
        campfires.set(Number(bound[2]), { pool: Math.min(current.pool + Number(bound[0]), C.GC_CAMPFIRE_MAX_POOL) });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("INSERT INTO gc_coin_ledger"),
      run: (bound) => {
        // The member-share mint's membership arm rides the statement.
        if (!roster.includes(Number(bound[0]))) return { meta: { changes: 0 } };
        ledgers.push({ user_id: Number(bound[0]), delta: Number(bound[1]), source: "job_finish" });
        return { meta: { changes: 1 } };
      },
    },
  ];

  const db = {
    calls,
    serverJobs,
    counters,
    finishes,
    campfires,
    ledgers,
    balanceOf,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
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
        return route && route.run ? route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({ call: "batch", statements: statements.map((s) => ({ sql: s.sql, bound: s.bound })) });
      return results;
    },
  };
  return db;
}

// The presence stub shape: the hub answers { online: [{ userId }] } — the
// jobs finish intersects it with the roster, never with names.
function presenceStub(onlineIds) {
  return {
    idFromName: () => "hub",
    get: () => ({
      fetch: async () => ({
        json: async () => ({ online: onlineIds.map((userId) => ({ userId })) }),
      }),
    }),
  };
}

function envOf(db, presence = null) {
  const env = { GOOBER_DB: db };
  if (presence) env.PRESENCE = presence;
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function authed(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "__Host-goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- rows -------------------------------------------------------------------

test("the Goober Jobs constants exist with the spec's caps (the 80/20 split closes to 100)", () => {
  assert.equal(C.GC_JOB_FINISH_BONUS, 100);
  assert.equal(C.GC_JOB_POOL_SHARE_PERCENT, 80);
  assert.equal(C.GC_JOB_MEMBER_SHARE_PERCENT, 20);
  assert.equal(
    C.GC_JOB_POOL_SHARE_PERCENT + C.GC_JOB_MEMBER_SHARE_PERCENT, 100,
    "the finish mint splits pool and members, never a third way",
  );
  assert.equal(C.GC_JOB_WEEK_SECONDS, 7 * DAY);
  assert.equal(C.GC_JOB_DEFS_PER_WEEK, 3);
  assert.equal(C.GC_JOB_GOAL_MESSAGES, 250);
  assert.equal(C.GC_JOB_GOAL_VOICE, 60);
  assert.equal(C.GC_JOB_GOAL_REACTIONS, 100);
  assert.equal(C.GC_JOB_GOAL_JOINS, 5);
  assert.equal(C.GC_JOB_GOAL_STOKES, 5);
  // The mint cap names its sink: the pool share is pre-sunk capacity, the
  // circulating growth is the member share's <= 60 per server-week.
  assert.equal(C.GC_JOB_FINISH_BONUS * C.GC_JOB_DEFS_PER_WEEK, 300);
  assert.equal(
    C.GC_JOB_FINISH_BONUS * C.GC_JOB_MEMBER_SHARE_PERCENT / 100 * C.GC_JOB_DEFS_PER_WEEK, 60,
  );
});

test("a not-opted-in server answers the defaults law: enabled false, no jobs, no prose", async () => {
  const db = coinDb(); // no gc_server_jobs seed -> the opt-in row is absent
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/jobs`), envOf(db), {});
  assert.equal(response.status, 200, "an opted-out server answers the read (absent, never forbidden)");
  const payload = await response.json();
  assert.equal(payload.enabled, false);
  assert.deepEqual(payload.jobs, []);
});

test("the toggle route opts the server in and writes the gc_server_jobs row", async () => {
  const db = coinDb();
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/jobs/toggle`, { enabled: true }), envOf(db), {},
  );
  assert.equal(response.status, 200, "the owner-side toggle exists");
  assert.deepEqual(await response.json(), { enabled: true });
  assert.equal(db.serverJobs.get(SERVER_ID), 1, "the opt-in state landed");
  // The defaults law at write time: the row never exists before the toggle.
  const writes = db.calls.filter((call) =>
    (call.call === "run" || call.call === "batch") && call.sql?.startsWith("INSERT INTO gc_server_jobs"));
  assert.equal(writes.length, 1);
});

test("weekly rotation determinism: same server + week answers the SAME three jobs", () => {
  const first = pickJobs(SERVER_ID, WEEK_KEY);
  const second = pickJobs(SERVER_ID, WEEK_KEY);
  assert.deepEqual(first, second, "same server + week -> the same rotation, everywhere");
  assert.equal(first.length, C.GC_JOB_DEFS_PER_WEEK);
  const ids = first.map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length, "no def repeats in one week's rotation");
  for (const job of first) {
    assert.ok(jobDefs.some((def) => def.id === job.id), "the rotation rotates the static defs only");
  }
});

test("the payload paints by keys only: every job's title is an i18n key, never prose", async () => {
  const db = coinDb({ serverJobs: [[SERVER_ID, 1]] });
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/jobs`), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.enabled, true);
  assert.equal(payload.jobs.length, C.GC_JOB_DEFS_PER_WEEK);
  for (const job of payload.jobs) {
    assert.match(job.titleKey, /^gc\.jobs\./, "painted titles ride gc.jobs.* keys");
    assert.equal(job.title, undefined, "no stored prose rides beside the key");
    assert.equal(typeof job.goal, "number");
    assert.equal(job.done, false, "a fresh week finishes nothing");
  }
});

test("the counter table carries NO member column (privacy law, DDL-level pin)", () => {
  const migration = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8") }))
    .find(({ text }) => text.includes("CREATE TABLE gc_job_counters"));
  assert.ok(migration, "the counters table's CREATE TABLE ships in a migration");
  const body = migration.text.slice(
    migration.text.indexOf("CREATE TABLE gc_job_counters"),
    migration.text.indexOf(";", migration.text.indexOf("CREATE TABLE gc_job_counters")),
  );
  assert.doesNotMatch(body, /user_id|member_id|actor_id/, "counters are aggregate-only (counters ONLY)");
});

test("the pool-first mint: the finish claim lands first, then the pool binds BEFORE the member payout", async () => {
  const db = coinDb({ serverJobs: [[SERVER_ID, 1]] });
  const kind = crossedKind(db);
  defCrossedSelected(db);
  const outcome = await recordJobProgress(envOf(db, presenceStub([OTHER_ID])), SERVER_ID, kind, 1, NOW);
  assert.ok(outcome && outcome.finished, "the finish ran");
  // The two-step conservation: the finish claim is the race's verdict (one
  // awaited statement), THEN the credits batch — no same-second double mint.
  const finishIdx = db.calls.findIndex((call) =>
    call.call !== "batch" && call.sql?.startsWith("INSERT INTO gc_job_finishes"));
  const batchIdx = db.calls.findIndex((call) => call.call === "batch");
  assert.ok(finishIdx >= 0 && batchIdx > finishIdx, "the finish claim answers the race BEFORE the credits batch");
  const batch = db.calls[batchIdx].statements;
  const poolIdx = batch.findIndex((s) => s.sql.startsWith("INSERT INTO gc_campfires"));
  const memberIdx = batch.findIndex((s) => s.sql.includes("'job_finish'"));
  assert.ok(poolIdx === 0, "SINK LAW ORDER: the batch leads with the pool credit");
  assert.ok(poolIdx < memberIdx, "members pay second");
  assert.equal(batch[poolIdx].bound[1], 80, "the pool takes its 80% (delta == finish * share)");
  assert.equal(batch[memberIdx].bound[1], 20, "the one online member takes the split share");
  assert.equal(db.campfires.get(SERVER_ID).pool, 80, "the pool ledger shows exactly the 80");
  assert.equal(db.balanceOf(OTHER_ID), 20, "the member share rode the same batch");
  assert.equal(db.calls[finishIdx].bound[3], C.GC_JOB_FINISH_BONUS, "paid_total records the conservation (100)");
});

test("zero online members: the unsplit member share ALSO routes into the pool (no circulating mint)", async () => {
  const db = coinDb({ serverJobs: [[SERVER_ID, 1]] });
  defCrossedSelected(db);
  const outcome = await recordJobProgress(envOf(db, null), SERVER_ID, crossedKind(db), 1, NOW);
  assert.ok(outcome && outcome.finished, "the finish ran");
  const batch = db.calls.find((call) => call.call === "batch").statements;
  const credits = batch.filter((s) => s.sql.startsWith("INSERT INTO gc_campfires"));
  assert.equal(credits.length, 2, "the pool takes the finish share AND the unsplit member share");
  assert.equal(credits[0].bound[1], 80, "the pool-first share");
  assert.equal(credits[1].bound[1], 20, "the burned member share");
  assert.equal(db.campfires.get(SERVER_ID).pool, 100, "nothing circulated");
  assert.equal(db.ledgers.length, 0, "no member mint without online members");
});

test("a job finishes once per week: the finishes PK arm refuses the double mint", async () => {
  const db = coinDb({ serverJobs: [[SERVER_ID, 1]] });
  const kind = crossedKind(db);
  defCrossedSelected(db);
  await recordJobProgress(envOf(db, null), SERVER_ID, kind, 1, NOW);
  await recordJobProgress(envOf(db, null), SERVER_ID, kind, 1, NOW);
  assert.equal(db.finishes.size, 1, "one finish row, ever, per week");
  const creditBatches = db.calls.filter((call) =>
    call.call === "batch" && call.statements.some((s) => s.sql.startsWith("INSERT INTO gc_campfires")));
  assert.equal(creditBatches.length, 1, "one credit batch, never two (the race's loser paid nothing)");
  assert.equal(db.campfires.get(SERVER_ID).pool, 100, "one finish's mint, never two");
});

// The helper: the crossed activity for THIS week's rotation is whichever
// selected def's counter sits at goal-1, so the rows work for any week.
function crossedKind(db) {
  return pickJobs(SERVER_ID, WEEK_KEY)[0].kind;
}

function defCrossedSelected(db) {
  const kind = crossedKind(db);
  const def = jobDefs.find((entry) => entry.kind === kind);
  db.counters.set(`${SERVER_ID}:${WEEK_KEY}:${kind}`, def.goal - 1);
  return kind;
}
