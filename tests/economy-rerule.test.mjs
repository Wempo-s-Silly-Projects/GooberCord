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

// The ECONOMY RE-RULE (owner, 2026-11-17): coins are earned by IN the
// community and spent on COSMETICS. This file pins the re-rule's new surfaces:
// the forum-post rollup's lazy mint, the server-create mint hook, the
// ownership-backed shop items (both prices exposed) and the buy route, the
// equip gate on PATCH /api/me/cosmetics, the renewal-vs-first pricing, and
// migration 0019 (gc_cosmetic_ownership). Same fakeDb + pinned-SQL style as
// the coins/discovery modules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleCoinRoutes, grantServerCreateCoins, mintRollupCoins } from "../api/coins.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const NOW = nowSeconds();
const DAY = NOW - (NOW % 86400);

// --- 0019 scoping ----------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0019_cosmetic_ownership.sql"), "utf8");

test("migration 0019 is one CREATE of the ownership table, gc_-scoped", () => {
  const stripped = MIGRATION.replace(/--[^\n]*/g, " ").trim();
  const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS gc_cosmetic_ownership/);
  assert.match(stripped, /REFERENCES users\(id\) ON DELETE CASCADE/);
  const names = [...stripped.matchAll(/\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|REFERENCES|ALTER\s+TABLE|FROM|UPDATE)\s+([\w"]+)/gi)].map((m) => m[1]);
  for (const name of names) assert.match(name, /^gc_|^users$/, "0019 touches only gc_ objects (+ the shared users FK target): " + name);
});

test("real-SQLite: the ownership PK dedupes and the item CHECK holds", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    INSERT INTO users (id, username, role) VALUES (7, 'wempos', 'member'), (9, 'ada', 'member');
  `);
  db.exec(MIGRATION);
  const insert = (item) => db.prepare(
    "INSERT INTO gc_cosmetic_ownership (user_id, item, purchased_at) VALUES (?, ?, ?)",
  ).run(Number(USER_ID), item, 5);
  insert("banner");
  insert("flair");
  assert.throws(() => insert("banner"), /UNIQUE/, "the PK dedupes the re-spend");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_cosmetic_ownership").get().n, 2);
  db.prepare(
    "INSERT INTO gc_cosmetic_ownership (user_id, item, purchased_at) VALUES (?, ?, ?)",
  ).run(Number(9), "banner", 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_cosmetic_ownership").get().n, 3);
  assert.throws(
    () => db.prepare(
      "INSERT INTO gc_cosmetic_ownership (user_id, item, purchased_at) VALUES (?, ?, ?)",
    ).run(Number(9), "pack", 5),
    /CHECK/,
  );
});

// --- scaffolding -------------------------------------------------------------------

const SESSION_TOKEN = "A".repeat(40);
const SESSION_ROW = {
  token_hash: await sha256Hex(SESSION_TOKEN),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
  expires_at: NOW + 3600,
  username: "wempos",
  role: "member",
  bio: "",
  avatar_status: null,
  avatar_mime: null,
  avatar_updated_at: null,
  avatar_version: null,
  totp_enabled: 0,
};

function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleCoinRoutes(request, env, url, url.pathname, request.method.toUpperCase());
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function authed(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const sessionRoute = { test: SESSION_READ_TEST, first: async () => SESSION_ROW };
const TERM_ROUTE = (active) => ({
  test: (sql) =>
    sql.startsWith("SELECT renews_until FROM gc_plus_state WHERE user_id = ? LIMIT 1") ||
    sql.startsWith("SELECT renews_until, grace_until, tenure_started_at, gifted_by"),
  first: async () => (active
    ? { renews_until: NOW + 1000, grace_until: null, tenure_started_at: NOW - 9000, gifted_by: null }
    : null),
});
const BALANCE_TEST = (sql) => sql.startsWith("SELECT COALESCE(SUM(le.delta), 0) AS balance");
const DAY_TEST = (sql) => sql.includes("AS earned") && sql.includes("AS rollup");
const OWNERSHIP_TEST = (sql) => sql.startsWith("SELECT item FROM gc_cosmetic_ownership");
const LEDGER_RUN_TEST = (sql) => sql.startsWith("INSERT INTO gc_coin_ledger");
const LEGER_OWNERSHIP_TEST = (sql) => sql.startsWith("INSERT INTO gc_cosmetic_ownership");

// The shared read fixture: balance 600, an empty day, no plus row.
function baseRoutes({ balance = 600 } = {}) {
  return [
    sessionRoute,
    TERM_ROUTE(false),
    { test: BALANCE_TEST, first: async () => ({ balance }) },
    { test: DAY_TEST, first: async () => ({ earned: 0, daily: 0, message: 0, voice: 0, rollup: 0, server: 0 }) },
    { test: OWNERSHIP_TEST, all: async () => ({ results: [] }) },
  ];
}

// --- the ROLLUP (the lazy forum-post mint) ------------------------------------------

const ROLLUP_TEST = (sql) => sql.startsWith("INSERT INTO gc_coin_ledger") && sql.includes("'rollup'");

test("mintRollupCoins mints ONE user+day row: the not-exists arm, the MIN(post cap), the tiered rate, and the ceiling all riding the statement", async () => {
  const db = fakeDb([
    TERM_ROUTE(true),
    { test: ROLLUP_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  await mintRollupCoins(envWithLimiters({ GOOBER_DB: db }), USER_ID, NOW);
  const mint = db.calls.find((call) => call.call === "run" && ROLLUP_TEST(call.sql));
  assert.ok(mint);
  // The count arm reads the forum's OWN posts table (GC's read-only lane):
  // public visibility, the >= 40 char body, today's window, the author.
  assert.match(mint.sql, /SELECT COUNT\(\*\) FROM posts p WHERE p\.author_id = \? AND p\.visibility = 'public' AND p\.created_at >= \? AND length\(trim\(p\.body\)\) >= \?\), \?\)/);
  // The user+day gate.
  assert.match(mint.sql, /NOT EXISTS \(SELECT 1 FROM gc_coin_ledger rl WHERE rl\.user_id = \? AND rl\.source = 'rollup' AND rl\.created_at >= \?\)$/);
  // Binds (textual order): user, rate, then the count sub-query, the cap, now,
  // the ceilings and the not-exists' own pair — the PLUS tier rides 5.
  assert.equal(mint.bound[0], USER_ID);
  assert.equal(mint.bound[1], 5);
  assert.equal(mint.bound[2], USER_ID);
  assert.equal(mint.bound[3], DAY);
  assert.equal(mint.bound[4], 40);
  assert.equal(mint.bound[5], 5);
  assert.equal(Math.abs(mint.bound[6] - NOW) < 2, true);
  assert.equal(mint.bound[7], 5, "the >0 arm rebinds the rate");
  assert.equal(mint.bound[15], 500, "the ceiling arm ends in the plus ceiling");
  assert.equal(mint.bound[16], USER_ID);
  assert.equal(mint.bound[17], DAY);
});

test("the coins read is the rollup's LAZY trigger (one rollup mint beside the reads)", async () => {
  const db = fakeDb(baseRoutes());
  const response = await dispatch(authed("GET", "/api/coins"), envWithLimiters({ GOOBER_DB: db }));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.rollup, { per: 3, cap: 5, minBody: 40, earnedToday: 0 });
  assert.ok(db.calls.find((call) => ROLLUP_TEST(call.sql)), "every coins touch tries the day's rollup");
});

// --- the SERVER-CREATE mint ----------------------------------------------------------

const SERVER_MINT_TEST = (sql) => sql.startsWith("INSERT INTO gc_coin_ledger") && sql.includes("'server'");

test("grantServerCreateCoins mints the builder's grant against the ceiling and the 2-per-day mint cap", async () => {
  for (const [active, per, ceiling] of [[true, 75, 500], [false, 50, 250]]) {
    const db = fakeDb([
      TERM_ROUTE(active),
      { test: SERVER_MINT_TEST, run: () => ({ meta: { changes: 1 } }) },
    ]);
    const minted = await grantServerCreateCoins(envWithLimiters({ GOOBER_DB: db }), USER_ID, NOW);
    assert.equal(minted, true);
    const mint = db.calls.find((call) => call.call === "run" && SERVER_MINT_TEST(call.sql));
    // binds: [userId, per, now, userId, dayStart, per, ceiling, userId, dayStart, cap]
    assert.deepEqual(
      [mint.bound[0], mint.bound[1], mint.bound[5], mint.bound[6]],
      [USER_ID, per, per, ceiling],
    );
    assert.equal(mint.bound[9], 2, "the cap binds MINT EVENTS (2 day), not coins");
    assert.match(mint.sql, /SELECT COUNT\(\*\) FROM gc_coin_ledger sv WHERE sv\.user_id = \? AND sv\.source = 'server' AND sv\.created_at >= \?\) < \?$/);
  }
});

// --- the cosmetic SINK ---------------------------------------------------------------

test("GET /api/coins/shop exposes BOTH prices per item, the caller's cost, and ownership", async () => {
  const db = fakeDb([
    ...baseRoutes(),
    { test: SESSION_READ_TEST, first: async () => SESSION_ROW },
  ]);
  const response = await dispatch(authed("GET", "/api/coins/shop"), envWithLimiters({ GOOBER_DB: db }));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  // A non-buyer sees the LIST prices both ways (own cost = list). The 0056
  // inventory SKUs ride beside them (the 2026-11-19 cosmetics v1 slate):
  // the consumable answers its qty, the own items their equip state.
  assert.deepEqual(body.items, [
    { item: "banner", price: 100, plusPrice: 50, cost: 100, owned: false },
    { item: "flair", price: 100, plusPrice: 50, cost: 100, owned: false },
    { item: "pack", price: 250, plusPrice: 250, cost: 250, plusOnly: true, owned: false },
    { item: "fx_burst_confetti", price: 50, plusPrice: 25, cost: 50, owned: false, kind: "consumable", qty: 0 },
    { item: "frame_gold", price: 100, plusPrice: 50, cost: 100, owned: false, kind: "own", equipped: false },
    { item: "frame_neon", price: 100, plusPrice: 50, cost: 100, owned: false, kind: "own", equipped: false },
    { item: "channel_banner_dusk", price: 150, plusPrice: 75, cost: 150, owned: false, kind: "own", equipped: false },
  ]);
  assert.deepEqual(body.inventory, [], "the 0056 inventory read rides the shop payload");
  // The bundle's pricing amendment answers both prices too.
  assert.equal(body.bundle.price, 500);
  assert.equal(body.bundle.renewalPrice, 400);
});

test("POST /api/coins/cosmetics buys banner in an atomic batch: the negative row + the ownership row, both guarded", async () => {
  // The final read runs AFTER the batch inserted the row — a stateful
  // stand-in for the table (it REPLACES baseRoutes' own empty answer).
  let bought = false;
  const routes = [
    sessionRoute,
    TERM_ROUTE(false),
    { test: BALANCE_TEST, first: async () => ({ balance: 600 }) },
    { test: DAY_TEST, first: async () => ({ earned: 0, daily: 0, message: 0, voice: 0, rollup: 0, server: 0 }) },
    {
      test: OWNERSHIP_TEST,
      all: async () => ({ results: bought ? [{ item: "banner" }] : [] }),
    },
  ];
  const db = fakeDb(routes);
  const originalBatch = db.batch.bind(db);
  db.batch = async (statements) => {
    bought = true;
    return originalBatch(statements);
  };
  const response = await dispatch(
    authed("POST", "/api/coins/cosmetics", { item: "banner" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    bought: true,
    cost: 100,
    items: [
      { item: "banner", price: 100, plusPrice: 50, cost: 100, owned: true },
      { item: "flair", price: 100, plusPrice: 50, cost: 100, owned: false },
      { item: "pack", price: 250, plusPrice: 250, cost: 250, plusOnly: true, owned: false },
      { item: "fx_burst_confetti", price: 50, plusPrice: 25, cost: 50, owned: false, kind: "consumable", qty: 0 },
      { item: "frame_gold", price: 100, plusPrice: 50, cost: 100, owned: false, kind: "own", equipped: false },
      { item: "frame_neon", price: 100, plusPrice: 50, cost: 100, owned: false, kind: "own", equipped: false },
      { item: "channel_banner_dusk", price: 150, plusPrice: 75, cost: 150, owned: false, kind: "own", equipped: false },
    ],
    inventory: [],
  });

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const [spend, ownership] = batch.statements;
  // The ledger row: -100 at the caller's own tier, the fingerprint's binds.
  assert.equal(spend.bound[1], -100);
  assert.equal(spend.bound[2], "cosmetic");
  assert.match(spend.sql, /WHERE \(SELECT COALESCE\(SUM\(le4\.delta\), 0\) FROM gc_coin_ledger le4 WHERE le4\.user_id = \?\) >= \? LIMIT 1$/);
  // The ownership row guards on THIS batch's spend fingerprint (the spend's
  // own nonce — 0058, so a same-second refusal echoes nothing) AND its own
  // NOT EXISTS.
  assert.match(ownership.sql, /WHERE EXISTS \(SELECT 1 FROM gc_coin_ledger cl WHERE cl\.user_id = \? AND cl\.source = \? AND cl\.delta = \? AND cl\.created_at = \? AND cl\.spend_nonce = \?\) AND NOT EXISTS \(SELECT 1 FROM gc_cosmetic_ownership ow WHERE ow\.user_id = \? AND ow\.item = \?\)$/);
});

test("the pack is PLUS-ONLY at its flat 250 (no discount), riding TWO ownership rows", async () => {
  // Without a term the 403 rides before any statement.
  const refused = new fakeDb(baseRoutes());
  const refusedResponse = await dispatch(
    authed("POST", "/api/coins/cosmetics", { item: "pack" }),
    envWithLimiters({ GOOBER_DB: refused }),
  );
  assert.equal(refusedResponse.status, 403);
  assert.equal(
    (await bodyOf(refusedResponse)).error,
    "That one is a Goober+ pack. Get Goober+ in the shop first.",
  );
  assert.equal(refused.calls.some((call) => call.call === "batch"), false);

  // With a term: one batch, one ledger row, two ownership INSERTs.
  const db = fakeDb(baseRoutes({ balance: 300 }));
  db.calls.push({ call: "session" });
  db.prepare = db.prepare.bind(db);
  const routes = [
    sessionRoute,
    TERM_ROUTE(true),
    { test: BALANCE_TEST, first: async () => ({ balance: 300 }) },
    { test: DAY_TEST, first: async () => ({ earned: 0, daily: 0, message: 0, voice: 0, rollup: 0, server: 0 }) },
    { test: OWNERSHIP_TEST, all: async () => ({ results: [] }) },
  ];
  const packDb = fakeDb(routes);
  const response = await dispatch(
    authed("POST", "/api/coins/cosmetics", { item: "pack" }),
    envWithLimiters({ GOOBER_DB: packDb }),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.cost, 250, "the pack never discounts");
  const batch = packDb.calls.find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 3);
  assert.equal(batch.statements[0].bound[1], -250);
  assert.equal(batch.statements[0].bound[2], "cosmetic_pack");
  assert.deepEqual(batch.statements.slice(1).map((statement) => statement.bound[1]), ["banner", "flair"]);

  // The buy route refuses shapes it does not know before anything runs.
  const junk = fakeDb(baseRoutes());
  const junkResponse = await dispatch(
    authed("POST", "/api/coins/cosmetics", { item: "halo" }),
    envWithLimiters({ GOOBER_DB: junk }),
  );
  assert.equal(junkResponse.status, 400);
  void db;
});

test("an already-owned re-spend is the 409 and insufficient coins the 400 (classified after the atomic batch)", async () => {
  // Owned: the ownership INSERT answers changes=0, the balance probe says
  // plenty → the ownership 409.
  const ownedDb = fakeDb([
    ...baseRoutes(),
    { test: LEGER_OWNERSHIP_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  const ownedResponse = await dispatch(
    authed("POST", "/api/coins/cosmetics", { item: "flair" }),
    envWithLimiters({ GOOBER_DB: ownedDb }),
  );
  assert.equal(ownedResponse.status, 409);
  assert.equal((await bodyOf(ownedResponse)).error, "You already own that cosmetic.");

  // Broke: the same zero-change signature, but the balance probe is short.
  const brokeDb = fakeDb([
    ...baseRoutes({ balance: 40 }),
    { test: LEGER_OWNERSHIP_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  const brokeResponse = await dispatch(
    authed("POST", "/api/coins/cosmetics", { item: "flair" }),
    envWithLimiters({ GOOBER_DB: brokeDb }),
  );
  assert.equal(brokeResponse.status, 400);
  assert.equal((await bodyOf(brokeResponse)).error, "Not enough Goober Coins for that.");
});

test("the equip gate on PATCH /api/me/cosmetics refuses an unowned banner/flair before any validation", async () => {
  // The route lives in accounts.mjs; pin its gate structurally plus the copy.
  const source = readFileSync(new URL("../api/accounts.mjs", import.meta.url), "utf8");
  assert.match(source, /Buy that cosmetic in the coin shop first\./);
  assert.match(source, /SELECT item FROM gc_cosmetic_ownership WHERE user_id = \?/);
  // Clearing rides WITHOUT the gate (null never needs ownership).
  assert.match(source, /body\.banner !== null && !ownedItems\.has\("banner"\)/);
  assert.match(source, /body\.flair !== null && !ownedItems\.has\("flair"\)/);
});

// The ledger's DAY read gains the two re-rule sources, additive to the day
// read's four existing CASE columns.
test("the day read gains the rollup + server sources beside the four earn sources", () => {
  const source = readFileSync(new URL("../api/coins.mjs", import.meta.url), "utf8");
  for (const needle of [
    "le.source = 'rollup' THEN le.delta",
    "le.source = 'server' THEN le.delta",
  ]) {
    assert.ok(source.includes(needle), "the day read carries: " + needle);
  }
});
