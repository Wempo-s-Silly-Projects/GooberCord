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

// Daily quests, recoded fresh on the reverted base (recode lane,
// 2026-11-18). DESIGN: the quest layer is LAZY — progress is DERIVED from
// the coin ledger's earn rows (msg earn 2-3 per posted message, voice
// ticks, the day's total earn), so no new progress table and NO new
// migration file (0052 is the lane's reserved slot and stays empty). The
// claim is the ECONOMY RE-RULE's claim — 25 FLAT, the daily grant's slot
// (source 'daily'), once per UTC day, SHARED with the shop claim — so the
// quest surface adds ZERO new minting: it can only mint a row the plain
// claim could have minted, gated on finishing the day's quests, inside the
// same daily ceiling. No mint inflation is possible by construction; the
// shop's plain claim stays untouched as the fallback door.
//
// Pin set: the goal constants, the claims' statement arms (not-exists pair,
// the three completion counts, the ceiling), the read's shape, the
// classification of a zero-change claim, and a real-SQLite full quest day.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleQuestRoutes } from "../api/quests.mjs";
import { sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  GC_COIN_DAILY_GRANT,
  GC_QUEST_CLAIM,
  GC_QUEST_GOAL_EARNED,
  GC_QUEST_GOAL_MESSAGES,
  GC_QUEST_GOAL_VOICE,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USER_ID = 7;
const NOW = nowSeconds();
const DAY = NOW - (NOW % 86400);

const USERS_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    accent_color TEXT, created_at INTEGER NOT NULL, bio TEXT, avatar_status TEXT,
    avatar_mime TEXT, avatar_updated_at INTEGER, avatar_version INTEGER, totp_enabled INTEGER);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER, csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER NOT NULL);
  CREATE TABLE gc_coin_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    source TEXT NOT NULL,
    related_user_id INTEGER,
    created_at INTEGER NOT NULL);
`;

const TOKEN = "Q" + "q".repeat(39);
const CSRF_TOKEN = "Q".repeat(24);
const TOKEN_HASH = await sha256Hex(TOKEN);

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(USERS_SQL);
  db.prepare("INSERT INTO users (id, username, role, created_at) VALUES (?, 'quester', 'member', ?)")
    .run(USER_ID, NOW - 100);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(TOKEN_HASH, USER_ID, CSRF_TOKEN, NOW, NOW + 3600);
  return db;
}

function d1(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let bound = [];
      return {
        bind(...values) {
          bound = values;
          return this;
        },
        async first() {
          return statement.get(...bound) ?? null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const info = statement.run(...bound);
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function envFor(db, { perks = false } = {}) {
  const env = { GOOBER_DB: d1(db) };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async () => ({ success: true }) };
  }
  if (perks) {
    db.prepare("INSERT INTO gc_plus_state (user_id, renews_until) VALUES (?, ?)").run(USER_ID, NOW + 1000);
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleQuestRoutes(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

function authed(method, path, body) {
  return new Request("http://localhost" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Cookie: "goober_session=" + TOKEN,
      "X-CSRF-Token": CSRF_TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// --- structural pins ------------------------------------------------------

const MODULE_SOURCE = readFileSync(path.join(HERE, "..", "api", "quests.mjs"), "utf8");

test("the goal constants carry the re-rule's numbers: claim 25 flat, goals 20 messages / 2 voice hits / 150 earned", () => {
  assert.equal(GC_QUEST_CLAIM, 25);
  assert.equal(GC_QUEST_CLAIM, GC_COIN_DAILY_GRANT, "the quest claim IS the daily grant's number");
  assert.equal(GC_QUEST_GOAL_MESSAGES, 20);
  assert.equal(GC_QUEST_GOAL_VOICE, 2);
  assert.equal(GC_QUEST_GOAL_EARNED, 150);
});

test("no mint inflation: the quest claim mints ONLY the daily slot — no 'quest' source row exists", () => {
  const source = readFileSync(path.join(HERE, "..", "constants.mjs"), "utf8");
  assert.ok(!/GC_QUEST\w*_GRANT/.test(source), "no separate quest grant constant rides the tree");
  assert.match(MODULE_SOURCE, /'daily'/);
  assert.ok(!MODULE_SOURCE.includes("'quest'"), "a new quest coin source would inflate the mint — none exists");
});

test("the claim's arms are all INSIDE the statement: the not-exists pair, the three completion counts, the ceiling", () => {
  assert.match(
    MODULE_SOURCE,
    /gc_coin_ledger ld WHERE ld\.user_id = \? AND ld\.source = 'daily' /,
    "the shop claim's once-per-day arm is the daily slot",
  );
  assert.match(MODULE_SOURCE, /lm\.source = 'message' /);
  assert.match(MODULE_SOURCE, /lv\.source = 'voice' /);
  assert.match(MODULE_SOURCE, /lv\.created_at >= \?\) >= \? /, "the voice goal rides its own arm");
  assert.match(MODULE_SOURCE, /le\.delta > 0\) >= \? /, "the earn goal rides its own arm");
});

// --- the reads --------------------------------------------------------------

test("GET /api/quests derives the day's progress from the ledger in ONE read and names the claim state", async () => {
  const db = makeDb();
  const earn = db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < 5; i++) earn.run(USER_ID, 2, "message", DAY + i);
  earn.run(USER_ID, 5, "voice", DAY + 1);
  earn.run(USER_ID, 50, "rollup", DAY + 1);
  earn.run(USER_ID, -100, "cosmetic", DAY + 1);

  const response = await dispatch(authed("GET", "/api/quests"), envFor(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.quests, [
    { kind: "message", goal: GC_QUEST_GOAL_MESSAGES, progress: 5, complete: false },
    { kind: "voice", goal: GC_QUEST_GOAL_VOICE, progress: 1, complete: false },
    { kind: "earn", goal: GC_QUEST_GOAL_EARNED, progress: 65, complete: false },
  ]);
  assert.deepEqual(body.claim, { claimed: false, reward: 25 });
});

test("an incomplete day's claim mints nothing even when one quest is short", async () => {
  const db = makeDb();
  const earn = db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < 20; i++) earn.run(USER_ID, 2, "message", DAY + i);
  for (let i = 0; i < 2; i++) earn.run(USER_ID, 5, "voice", DAY + i);
  earn.run(USER_ID, 40, "rollup", DAY);

  const response = await dispatch(authed("POST", "/api/quests/claim"), envFor(db));
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger WHERE source = 'daily'").get().n, 0);
});

test("GET /api/quests is bounded to TODAY's ledger rows and self-scoped to the caller", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)")
    .run(USER_ID, 2, "message", DAY - 60);
  db.prepare("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)")
    .run(9, 2, "message", DAY + 1);

  const response = await dispatch(authed("GET", "/api/quests"), envFor(db));
  const body = await bodyOf(response);
  assert.equal(body.quests[0].progress, 0, "yesterday's earn and another member's earn ride nothing");
});

// --- the claim ----------------------------------------------------------------

test("an empty day's claim is refused class-first: not claimed yet answers the completion 400, never a 409", async () => {
  const db = makeDb();
  const response = await dispatch(authed("POST", "/api/quests/claim"), envFor(db));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "Finish today's quests before claiming.");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger").get().n, 0);
});

test("a real quest day claims the flat 25 through the daily slot; the replay is the 409, never a second row", async () => {
  const db = makeDb();
  const earn = db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < 20; i++) earn.run(USER_ID, 2, "message", DAY + i);
  for (let i = 0; i < 2; i++) earn.run(USER_ID, 5, "voice", DAY + i);
  earn.run(USER_ID, 150, "rollup", DAY);

  const response = await dispatch(authed("POST", "/api/quests/claim"), envFor(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.claim, { claimed: true, reward: 25 });
  const rows = db.prepare("SELECT source, delta, created_at FROM gc_coin_ledger WHERE delta = 25").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "daily", "the claim mints the DAILY slot, one source of truth for once-per-day");

  const replay = await dispatch(authed("POST", "/api/quests/claim"), envFor(db));
  assert.equal(replay.status, 409);
  assert.equal((await bodyOf(replay)).error, "Already claimed today. Come back tomorrow.");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger WHERE delta = 25").get().n, 1);
});

test("a shop-claimed day is ALSO claimed through the quests door — one slot, zero inflation", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)")
    .run(USER_ID, 25, "daily", DAY + 1);

  const response = await dispatch(authed("GET", "/api/quests"), envFor(db));
  const body = await bodyOf(response);
  assert.deepEqual(body.claim, { claimed: true, reward: 25 });

  const questClaim = await dispatch(authed("POST", "/api/quests/claim"), envFor(db));
  assert.equal(questClaim.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger WHERE source = 'daily'").get().n, 1);
});

test("the ceiling arm is the caller's own tier: an ACTIVE term binds the plus ceiling", async () => {
  const db = makeDb();
  const earn = db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < 20; i++) earn.run(USER_ID, 2, "message", DAY + i);
  for (let i = 0; i < 2; i++) earn.run(USER_ID, 5, "voice", DAY + i);
  earn.run(USER_ID, 150, "rollup", DAY);
  earn.run(USER_ID, 500, "server", DAY);

  const response = await dispatch(authed("POST", "/api/quests/claim"), envFor(db, { perks: true }));
  assert.equal(response.status, 409, "the plus ceiling (500) still binds: 680 earned + 25 > 500");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger WHERE source = 'daily'").get().n, 0);
});

test("un-authed: both quest routes answer 401 before any statement fires", async () => {
  const db = makeDb();
  for (const [method, path] of [["GET", "/api/quests"], ["POST", "/api/quests/claim"]]) {
    const response = await dispatch(
      new Request("http://localhost" + path, {
        method,
        headers: { Origin: "http://localhost", "X-CSRF-Token": "N".repeat(24) },
      }),
      envFor(db),
    );
    assert.equal(response.status, 401, method + " " + path + " must 401");
  }
});

test("the seat rides the worker's chain: handleQuestRoutes is wired in worker.mjs", () => {
  const worker = readFileSync(path.join(HERE, "..", "worker.mjs"), "utf8");
  assert.match(worker, /handleQuestRoutes/);
});
