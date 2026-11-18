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

// T91 Month-day anniversaries — the RED rows (spec:
// docs/drafts/t91-anniversaries-spec.md). DELIVERED FAILING: no route
// module, no migration, no constants, no worker.mjs registration.
// Idiom: the paper's fakeDb (tests/morning-paper-red.test.mjs, itself the
// jobs-row idiom) — every guard arm is ENCODED in the fake so a GREEN
// implementation that loses an arm fails here. The seat mints and sinks
// NOTHING (sink law N/A by spec §5): no gc_coin_ledger route exists in the
// fake, so a set/clear that ever mints fails by silence never being banked.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import worker from "../worker.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_USER_ANNIVERSARY_MONTH_MAX,
  GC_USER_ANNIVERSARY_DAY_MAX,
  GC_PAPER_ANNIVERSARIES_MAX,
} from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const USER_ID = 22;
const SESSION_TOKEN = "M".repeat(40);
// auth.mjs:99-106 binds the token's sha256 WHERE s.token_hash = ? — a raw-token
// compare starves every session (the T88 fake-defect class). The fake compares
// the hash at bound[0], same idiom as the sibling wave tests.
const SESSION_HASH = await sha256Hex(SESSION_TOKEN);
const SESSION_ROW = {
  token_hash: "T".repeat(64),
  user_id: USER_ID,
  csrf_token: "C".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "plainmember",
};

// The anniversary fake: the seat is one Map keyed by the user_id PK
// (absence IS off — defaults law); the paper's section seed answers the
// read-only join shape the spec pins.
function anniversaryDb(options = {}) {
  const rows = new Map(options.rows || []);          // user_id -> { month, day }
  const memberRows = options.memberRows || [];       // [{ user_id, month, day, username }]
  const config = new Map(options.config || []);      // server_id -> { enabled }
  const calls = [];

  const routes = [
    // The paper's seat reads (the ride-along dispatch order: membership ->
    // config -> sections — the anniversaries join only fires after the
    // config row answers enabled, the T87 seat's own law).
    {
      test: (sql) => sql.startsWith("SELECT role FROM gc_server_members"),
      first: async () => ({ role: "member" }),
    },
    {
      test: (sql) => sql.includes("FROM gc_paper_configs"),
      first: async (bound) =>
        config.has(Number(bound[0])) ? config.get(Number(bound[0])) : null,
    },
    {
      test: (sql) => sql.includes("FROM gc_messages") && sql.includes("GROUP BY"),
      all: async () => ({ results: [] }),
    },
    { test: (sql) => sql.includes("FROM gc_capsules"), all: async () => ({ results: [] }) },
    { test: (sql) => sql.includes("gc_threads"), all: async () => ({ results: [] }) },
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async (bound) =>
        bound[0] === SESSION_HASH ? SESSION_ROW : null,
    },
    {
      test: (sql) => sql.startsWith("SELECT month, day FROM gc_user_anniversaries"),
      first: async (bound) => rows.has(Number(bound[0])) ? rows.get(Number(bound[0])) : null,
    },
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_user_anniversaries"),
      run: (bound) => {
        rows.delete(Number(bound[0]));
        return { meta: { changes: rows.has(Number(bound[0])) ? 1 : 0 } };
      },
    },
    {
      // The upsert: ONE statement set/clear can ride, self-scoped by the
      // bound user id — a write that conjures a row for anyone else fails.
      test: (sql) => sql.startsWith("INSERT INTO gc_user_anniversaries"),
      run: (bound) => {
        const userId = Number(bound[0]);
        if (userId !== USER_ID) return { meta: { changes: 0 } };
        rows.set(userId, { month: Number(bound[1]), day: Number(bound[2]) });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The paper ride-along: the read-only three-table join (seat ⋈
      // membership ⋈ users). Bound order under test: [month, day, serverId].
      test: (sql) =>
        sql.includes("FROM gc_user_anniversaries") &&
        sql.includes("JOIN users") &&
        sql.includes("JOIN gc_server_members"),
      all: async (bound) => ({
        results: memberRows.filter(
          (row) => row.month === Number(bound[0]) && row.day === Number(bound[1]),
        ),
      }),
    },
  ];

  const db = {
    calls,
    rows,
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

function envOf(db) {
  const env = { GOOBER_DB: db };
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

function unAuthed(method, path, body) {
  // Origin present (the fleet csrf law): the un-signed request is refused
  // on the session seat, not on the browser gate.
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  });
}

// --- rows -------------------------------------------------------------------

test("the anniversaries' constants exist with the spec's structural bounds (never re-declared)", () => {
  assert.equal(GC_USER_ANNIVERSARY_MONTH_MAX, 11, "month is 0-11, the calendar's own range");
  assert.equal(GC_USER_ANNIVERSARY_DAY_MAX, 31, "day is 1-31, structural only");
  assert.ok(GC_PAPER_ANNIVERSARIES_MAX >= 1, "the paper section rides its own named cap");
});

test("the seat ships as ONE CREATE-only table with NO year column (the schema IS the privacy law)", () => {
  const migration = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => /0040_gc_anniversaries\.sql$/.test(name))
    .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  assert.equal(migration.length, 1, "the migration occupies the 0040 ordinal");
  const text = migration[0];
  const creates = text.match(/CREATE TABLE/g) || [];
  assert.equal(creates.length, 1, "the seat is ONE table (CREATE-only, no rebuild, no ALTER)");
  const body = text.slice(
    text.indexOf("CREATE TABLE gc_user_anniversaries"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_user_anniversaries")),
  );
  assert.doesNotMatch(body, /\byear\b|\bsince\b|\bcreated_at\b/i,
    "no year, no derived-year anchor, no timestamps — LIMIT COLLECTION NOT ACCESS");
  assert.ok(body.includes("REFERENCES users(id) ON DELETE CASCADE"), "the users FK cascades");
  assert.doesNotMatch(body, /\bON DELETE (?!CASCADE)\w+/, "no non-cascade FK action rides the seat");
  assert.match(body, /month\s+INTEGER NOT NULL/, "month is not null");
  assert.match(body, /day\s+INTEGER NOT NULL/, "day is not null");
  assert.match(body, /PRIMARY KEY \(user_id\)/, "one anniversary per member, ever");
});

test("the member's opt-in PUT stores month+day verbatim and answers the seat shape", async () => {
  const db = anniversaryDb();
  const response = await worker.fetch(
    authed("PUT", "/api/users/me/anniversary", { month: 10, day: 18 }), envOf(db), {},
  );
  assert.equal(response.status, 200, "the opt-in act exists and answers its state");
  assert.deepEqual(await response.json(), { month: 10, day: 18 });
  assert.deepEqual(db.rows.get(USER_ID), { month: 10, day: 18 },
    "month+day stored verbatim, nothing else bound");
  const writes = db.calls.filter((call) =>
    call.call === "run" && call.sql.startsWith("INSERT INTO gc_user_anniversaries"));
  assert.equal(writes.length, 1, "exactly ONE seat statement, no tracker beside it");
  assert.equal(writes[0].bound.length, 3, "user_id, month, day — no fourth column exists to bind");
});

test("the off-state is structural: an untouched member's routes answer absence, no default row", async () => {
  const db = anniversaryDb();
  // No PUT ever ran: the seat is empty and the DELETE clears nothing.
  const response = await worker.fetch(authed("DELETE", "/api/users/me/anniversary"), envOf(db), {});
  assert.equal(response.status, 200, "the clear is idempotent over absence");
  assert.equal(db.rows.size, 0, "absence IS the off-state (defaults law, nothing default-on)");
  const upserts = db.calls.filter((call) => call.sql.startsWith("INSERT INTO gc_user_anniversaries"));
  assert.equal(upserts.length, 0, "the clear never conjures a row on anyone's behalf");
});

test("DELETE clears the member's seat; the self-scoped route cannot clear another member's", async () => {
  const db = anniversaryDb({ rows: [[USER_ID, { month: 2, day: 29 }]] });
  const other = new Map([[999, { month: 10, day: 18 }]]);
  const response = await worker.fetch(authed("DELETE", "/api/users/me/anniversary"), envOf(db), {});
  assert.equal(response.status, 200);
  assert.equal(db.rows.has(USER_ID), false, "the member's own row is gone");
  assert.ok(other.size === 1 && other.has(999) && !db.rows.has(999),
    "wrong-member clears cannot exist: the route is self-scoped (/me), the bind carries nobody else");
});

test("the range gate: month outside 0-11 or day outside 1-31 answers the shared 400 validation shape", async () => {
  for (const [month, day] of [[-1, 15], [12, 15], [6, 0], [6, 32], [1.5, 15], [6, 15.5]]) {
    const db = anniversaryDb();
    const response = await worker.fetch(
      authed("PUT", "/api/users/me/anniversary", { month, day }), envOf(db), {},
    );
    assert.equal(response.status, 400, "month " + month + " day " + day + " is structurally refused");
    const payload = await response.json();
    assert.ok(payload.error && typeof payload.error === "string", "the shared error shape answers");
    assert.equal(db.rows.size, 0, "a refused write stores nothing");
  }
});

test("the calendar is not the validator: Feb 30 is stored verbatim (structural range only, no leap math)", async () => {
  const db = anniversaryDb();
  const response = await worker.fetch(
    authed("PUT", "/api/users/me/anniversary", { month: 1, day: 30 }), envOf(db), {},
  );
  assert.equal(response.status, 200,
    "Feb 30 rides the structural day <= 31 gate — no calendar knowledge, no derived normalization");
  assert.deepEqual(await response.json(), { month: 1, day: 30 });
  assert.deepEqual(db.rows.get(USER_ID), { month: 1, day: 30 },
    "stored verbatim; it simply never fires (a calendar-less month-day can never equal today)");
});

test("un-authed: every anniversary route answers 401 before any seat statement fires (Origin present)", async () => {
  const db = anniversaryDb({ rows: [[USER_ID, { month: 10, day: 18 }]] });
  for (const [method, path, body] of [
    ["PUT", "/api/users/me/anniversary", { month: 10, day: 18 }],
    ["DELETE", "/api/users/me/anniversary", undefined],
  ]) {
    const response = await worker.fetch(unAuthed(method, path, body), envOf(db), {});
    assert.equal(response.status, 401, method + " " + path + " answers the un-signed 401");
  }
  const seatStatements = db.calls.filter((call) =>
    call.sql.includes("gc_user_anniversaries"));
  assert.equal(seatStatements.length, 0, "the 401 rides ahead of the seat");
});

test("no mint, no tracker: a set and a clear fire ZERO coin statements and ZERO counters (sink law N/A)", async () => {
  const db = anniversaryDb();
  await worker.fetch(authed("PUT", "/api/users/me/anniversary", { month: 10, day: 18 }), envOf(db), {});
  const afterSet = db.calls.filter((call) =>
    call.sql.includes("gc_coin_ledger") ||
    call.sql.includes("gc_job_counters") ||
    call.sql.includes("counter") ||
    call.sql.includes("delta"));
  assert.equal(afterSet.length, 0, "the set touches no coin seat, no counter seat");
  await worker.fetch(authed("DELETE", "/api/users/me/anniversary"), envOf(db), {});
  const afterClear = db.calls.filter((call) =>
    call.sql.includes("gc_coin_ledger") ||
    call.sql.includes("gc_job_counters") ||
    call.sql.includes("counter") ||
    call.sql.includes("delta"));
  assert.equal(afterClear.length, 0, "the clear touches no coin seat, no counter seat");
});
