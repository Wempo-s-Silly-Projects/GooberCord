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

// T87 The Morning Paper — the RED rows (spec: docs/drafts/t87-morning-paper-spec.md).
// DELIVERED FAILING: no route module, no worker.mjs registration, no GREEN.
// Idiom: the jobs-row fakeDb (tests/goober-jobs-red.test.mjs) — every guard
// arm is ENCODED in the fake (the mod gate inside the config insert, the
// config-absence IS the off-state), so a GREEN implementation that loses an
// arm fails here. The paper mints and sinks NOTHING (sink law N/A by spec §5):
// no gc_coin_ledger route exists in the fake, so a paper that ever mints
// fails by silence never being banked.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import worker from "../worker.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_PAPER_DAY_SECONDS,
  GC_PAPER_CHANNELS_MAX,
  GC_PAPER_THREADS_MAX,
  GC_PAPER_CAPSULES_MAX,
  GC_PAPER_YESTERDAY_KEYS,
} from "../constants.mjs";
import { nowSeconds } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const SERVER_ID = 1;
const MOD_ID = 7;
const MEMBER_ID = 22;
const NOW = nowSeconds();
// The T83 day-key idiom the spec pins: the UTC day key is the whole
// synchronization, never a timer.
const TODAY_KEY = (Math.floor(NOW / GC_PAPER_DAY_SECONDS)) * GC_PAPER_DAY_SECONDS;
const YESTERDAY_KEY = TODAY_KEY - GC_PAPER_DAY_SECONDS * GC_PAPER_YESTERDAY_KEYS;

const SESSION_TOKEN = "A".repeat(40);

const MEMBER_TOKEN = "M".repeat(40);
const MEMBER_SESSION_ROW = {
  token_hash: "T".repeat(64),
  user_id: MEMBER_ID,
  csrf_token: "C".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "plainmember",
};

const SESSION_ROW = {
  token_hash: "S".repeat(64),
  user_id: MOD_ID,
  csrf_token: "B".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "wempos",
};

// The paperDb fake: the config seat map is the whole state (absence IS off —
// defaults law); the activity seeds answer the read-time aggregates the spec
// pins (channel counts, thread rollups, due capsules), grouped by
// server/day/channel/thread ONLY (no per-member GROUP BY key is ever served,
// so a GREEN statement that groups by a member column finds no matching
// shape and fails the payload rows).
function paperDb(options = {}) {
  const config = new Map(options.config || []);        // server_id -> { enabled, updated_by }
  const channelCounts = options.channelCounts || [];   // [{ channel_id, row_count }]
  const threadCounts = options.threadCounts || [];     // [{ thread_id, row_count }]
  const dueCapsules = options.dueCapsules || [];       // [{ id, reveal_at, author_id }]
  const calls = [];

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      // bound[0] = the token_hash (auth.mjs's session read): the member
      // token answers the MEMBER session row, everything else the mod's —
      // the plain-member gate path needs a session that IS a member.
      first: async (bound) =>
        bound[0] === MEMBER_TOKEN ? MEMBER_SESSION_ROW : SESSION_ROW,
    },
    {
      // The mod gate rides the EXISTING permission check (spec §5): owner
      // vs plain member vs outside-the-server absent.
      test: (sql) => sql.startsWith("SELECT role FROM gc_server_members"),
      first: async (bound) => {
        if (Number(bound[1]) === MOD_ID) return { role: "owner" };
        if (Number(bound[1]) === MEMBER_ID) return { role: "member" };
        return null;
      },
    },
    {
      // The off-transition is the WHOLE off-state: a hard row delete, no
      // tombstone column, no history row. RIDES FIRST — routes.find() is
      // order-sensitive and every DELETE contains the read route's "FROM
      // gc_paper_configs" substring; a later-match shadowing here would make
      // config.size unable to ever decrease (the fake-defect class the lead
      // ruled on 2026-11-18).
      test: (sql) => sql.startsWith("DELETE FROM gc_paper_configs"),
      run: (bound) => {
        config.delete(Number(bound[0]));
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.includes("FROM gc_paper_configs"),
      first: async (bound) =>
        config.has(Number(bound[0]))
          ? { enabled: config.get(Number(bound[0])).enabled }
          : null,
    },
    {
      // The opt-in write, mod-gated INSIDE the fake: a non-mod's write makes
      // zero changes, so a GREEN toggle that loses the gate arm cannot
      // conjure a row.
      test: (sql) => sql.startsWith("INSERT INTO gc_paper_configs"),
      run: (bound) => {
        const actingId = Number(bound[2]);
        if (actingId !== MOD_ID) return { meta: { changes: 0 } };
        config.set(Number(bound[0]), { enabled: Number(bound[1]), updated_by: actingId });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.includes("FROM gc_messages") && sql.includes("GROUP BY"),
      all: async () => ({ results: channelCounts }),
    },
    {
      test: (sql) => sql.includes("FROM gc_capsules"),
      all: async () => ({ results: dueCapsules.map((capsule) => ({ ...capsule, username: "wempos" })) }),
    },
    { test: (sql) => sql.includes("gc_threads"), all: async () => ({ results: threadCounts }) },
  ];

  const db = {
    calls,
    config,
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

function authed(method, path, body, member = false) {
  // The member variant presents MEMBER_TOKEN → the fake's session route
  // answers MEMBER_SESSION_ROW (user MEMBER_ID): the only way a plain
  // member's request can even exist in this fake.
  const session = member ? MEMBER_SESSION_ROW : SESSION_ROW;
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "__Host-goober_session=" + (member ? MEMBER_TOKEN : SESSION_TOKEN),
      "X-CSRF-Token": session.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The generic route-tail 404 the worker answers before the paper exists —
// the dedicated no-paper-configured 404 (spec §1's "404-shape") must be a
// DIFFERENT body, so these rows can distinguish a paper handler that
// answered from the dispatch tail's silence.
const GENERIC_404 = "That API endpoint does not exist.";

// --- rows -------------------------------------------------------------------

test("the Morning Paper constants exist with the spec's caps (window bounds, never re-declared)", () => {
  assert.equal(GC_PAPER_DAY_SECONDS, 86400);
  assert.equal(GC_PAPER_CHANNELS_MAX, 10);
  assert.equal(GC_PAPER_THREADS_MAX, 5);
  assert.equal(GC_PAPER_CAPSULES_MAX, 25);
  assert.equal(GC_PAPER_YESTERDAY_KEYS, 1, "v1's history depth is yesterday only");
});

test("the paper's config seat ships as ONE CREATE TABLE with cascading FKs and no issue archive (DDL-level pin)", () => {
  const migration = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => /0037_gc_morning_paper\.sql$/.test(name))
    .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  assert.equal(migration.length, 1, "the migration occupies the 0037 ordinal");
  const text = migration[0];
  const body = text.slice(
    text.indexOf("CREATE TABLE gc_paper_configs"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_paper_configs")),
  );
  assert.ok(body.includes("REFERENCES gc_servers(id) ON DELETE CASCADE"), "the server FK cascades");
  assert.ok(body.includes("REFERENCES users(id) ON DELETE CASCADE"), "the mod FK cascades");
  assert.doesNotMatch(body, /\bON DELETE (?!CASCADE)\w+/, "no non-cascade FK action rides the seat");
  assert.match(body, /CHECK \(enabled IN \(0, 1\)\)/, "enabled is the CHECK-bound flag");
  assert.match(body, /PRIMARY KEY \(server_id\)/, "one config row per server, ever");
  const creates = text.match(/CREATE TABLE/g) || [];
  assert.equal(creates.length, 1, "the config row IS the whole seat — ONE table");
  assert.doesNotMatch(text, /CREATE TABLE gc_paper_(issues|renders|history|cache)/,
    "no issue archive, no render cache (re-derivation, not storage)");
});

test("a not-opted-in server answers the dedicated no-paper 404 and reads ZERO activity rows (defaults law)", async () => {
  const db = paperDb(); // no gc_paper_configs seed -> the surface does not exist
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/paper`), envOf(db), {});
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.notEqual(payload.error, GENERIC_404,
    "a paper-shaped 404 answered, not the dispatch tail");
  // "The dispatch fires ZERO gc_paper statements" (spec §2): no activity
  // aggregate is served for a server whose seat is absent (the config read
  // rides the 404's own WHERE — the only statement the off-state earns).
  const activityReads = db.calls.filter((call) =>
    call.sql.includes("FROM gc_messages") || call.sql.includes("FROM gc_capsules"));
  assert.equal(activityReads.length, 0, "no gc_messages/gc_capsules read without the seat");
});

test("the mod's opt-in POST writes the gc_paper_configs row and answers the enabled shape", async () => {
  const db = paperDb();
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/paper`, { enabled: true }), envOf(db), {},
  );
  assert.equal(response.status, 200, "the opt-in act exists and answers its state");
  assert.deepEqual(await response.json(), { enabled: true });
  assert.deepEqual(db.config.get(SERVER_ID), { enabled: 1, updated_by: MOD_ID },
    "the config row IS the whole seat");
  // The defaults law at write time: the row never existed before the toggle.
  const writes = db.calls.filter((call) =>
    call.call === "run" && call.sql.startsWith("INSERT INTO gc_paper_configs"));
  assert.equal(writes.length, 1);
});

test("a plain member's POST cannot flip the paper (the mod gate rides the existing permission check)", async () => {
  const db = paperDb();
  const memberSession = authed("POST", `/api/servers/${SERVER_ID}/paper`, { enabled: true }, true);
  const response = await worker.fetch(memberSession, envOf(db), {});
  assert.equal(response.status, 403, "the mod gate answers the forbidden family");
  assert.equal(db.config.size, 0, "the non-mod's intent never conjures a row");
});

test("a configured server serves today's paper: capped sections in shape, and no member rollup anywhere", async () => {
  const db = paperDb({
    config: [[SERVER_ID, { enabled: 1, updated_by: MOD_ID }]],
    channelCounts: Array.from({ length: GC_PAPER_CHANNELS_MAX + 5 }, (_, i) => ({
      channel_id: 100 + i, row_count: 30 - i,
    })),
    threadCounts: [{ thread_id: 5, row_count: 12 }],
    dueCapsules: [],
  });
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/paper`), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.sections, "the paper's sections exist");
  assert.ok(Array.isArray(payload.sections.channels), "channels is a list, never an error");
  assert.ok(payload.sections.channels.length <= GC_PAPER_CHANNELS_MAX,
    "the channels cut at their own cap (read-time LIMIT, never a whole-day load)");
  for (const row of payload.sections.channels) {
    assert.equal(typeof row.count, "number", "a channel row is a COUNT, never a member rollup");
    assert.equal(typeof row.channelId, "number");
  }
  assert.ok(payload.sections.threads.length <= GC_PAPER_THREADS_MAX, "threads cut at their cap");
  for (const row of payload.sections.threads) {
    assert.equal(typeof row.count, "number", "a thread row carries its row-count, not its members");
    assert.equal(row.memberIds, undefined, "no member identity rides a thread row");
  }
  const painted = JSON.stringify(payload);
  assert.doesNotMatch(painted, /"user_id"|"author_id"|"presence"|"dm_ids"/,
    "the paper's shape has NO member-level rows (no-profiling law)");
});

test("the zero-activity window serves the complete empty shape verbatim (no filler, no invented highlights)", async () => {
  const db = paperDb({ config: [[SERVER_ID, { enabled: 1, updated_by: MOD_ID }]] });
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/paper`), envOf(db), {});
  assert.equal(response.status, 200, "a quiet day is VALID, not an error");
  const payload = await response.json();
  assert.deepEqual(payload.sections, { channels: [], threads: [], capsules: [] },
    "every section answers its empty state, none dropped");
  assert.equal(payload.activityRows, 0, "the zero-activity shape serves verbatim");
});

test("the paper's painted strings ride keys only: title is the paper.* key, never stored prose", async () => {
  const db = paperDb({ config: [[SERVER_ID, { enabled: 1, updated_by: MOD_ID }]] });
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/paper`), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.titleKey, /^paper\./, "the painted title rides the paper.* namespace");
  assert.equal(payload.title, undefined, "no stored prose rides beside the key");
  assert.equal(typeof payload.windowLabelUtc, "string", "the UTC window label is painted");
});

test("yesterday's paper answers the completed previous UTC window (history depth = GC_PAPER_YESTERDAY_KEYS)", async () => {
  const db = paperDb({ config: [[SERVER_ID, { enabled: 1, updated_by: MOD_ID }]] });
  const response = await worker.fetch(
    authed("GET", `/api/servers/${SERVER_ID}/paper/previous`), envOf(db), {},
  );
  assert.equal(response.status, 200, "the most recent completed window re-derives, no archive");
  const payload = await response.json();
  assert.equal(payload.window.startSeconds, YESTERDAY_KEY,
    "the previous day-key window, computed by the day-key arithmetic");
});

test("capsule due rows carry id, due day, and sender handle — never a sealed body (T82 law carries)", async () => {
  const db = paperDb({
    config: [[SERVER_ID, { enabled: 1, updated_by: MOD_ID }]],
    dueCapsules: [{ id: 11, reveal_at: TODAY_KEY + 100, author_id: MOD_ID }],
  });
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/paper`), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.sections.capsules), "the capsules section exists");
  const due = payload.sections.capsules[0];
  assert.ok(due, "the due-today seal is carried as a reveal-due row");
  assert.equal(typeof due.sealId, "number", "the seal's id is carried");
  assert.equal(typeof due.dueAt, "number", "the due day is carried");
  assert.match(due.senderHandle, /\S/, "the sender HANDLE as T82's own routes already paint it");
  const painted = JSON.stringify(payload.sections.capsules);
  assert.doesNotMatch(painted, /"body"|"preview"|"sealed_body"/,
    "the paper never carries a seal body — the capsule's own route is the only body reader");
});

test("the off-transition mid-cycle deletes the config row and the NEXT read answers the unconfigured shape", async () => {
  const db = paperDb({ config: [[SERVER_ID, { enabled: 1, updated_by: MOD_ID }]] });
  const off = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/paper`, { enabled: false }), envOf(db), {},
  );
  assert.equal(off.status, 200, "the mid-cycle off answers its state");
  assert.deepEqual(await off.json(), { enabled: false });
  assert.equal(db.config.size, 0, "the DELETE is the whole off-state (no tombstone, no history)");
  const next = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/paper`), envOf(db), {});
  assert.equal(next.status, 404, "the next pull answers the unconfigured shape");
  const nextBody = await next.json();
  assert.notEqual(nextBody.error, GENERIC_404, "the dedicated no-paper 404, not the dispatch tail");
});
