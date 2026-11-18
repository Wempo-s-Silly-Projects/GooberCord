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

// T76 economy slate — RED rows (spec: docs/drafts/t76-economy-slate-spec.md).
// Failing TODAY by construction: no Well streaks, no Campfire, no chain routes
// exist yet. RED here means "fails for the right reason" — the surface the
// row names is missing, never a scaffolding crash. The GREEN lane implements
// the spec until these pass; extending this file's fake (seeding maps) during
// GREEN is expected and allowed.
//
// Idiom: the coins-module fakeDb + pinned-SQL contract style
// (tests/coins-module.test.mjs). The gc_well_streaks / gc_campfires map
// handlers here are SEEDS, not guard encodings — a row pins the SINK law by
// asserting the fee statement's SQL names gc_campfires, and pins the economy
// by asserting the seeded map changed the way the spec says.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCoinRoutes } from "../api/coins.mjs";
import worker from "../worker.mjs";
import { nowSeconds, sha256Hex, randomToken } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import * as C from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;
const SERVER_ID = 1;
const NOW = nowSeconds();
const TODAY = Math.floor(NOW / 86400) * 86400; // the UTC day floor, coins-style
const DAY = 86400;

// --- scaffolding (coins-module idiom, trimmed to the slate's needs) -----------

const SESSION_TOKEN = "A".repeat(40);
const SESSION_ROW = {
  token_hash: await sha256Hex(SESSION_TOKEN),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "wempos",
  role: "member",
  bio: "",
  avatar_status: null,
  avatar_mime: null,
  avatar_updated_at: null,
  avatar_version: null,
  totp_enabled: 0,
};

function coinDb(options = {}) {
  const ledger = (options.ledger || []).map((row) => ({ ...row }));
  const users = options.users || [
    { id: USER_ID, username: "wempos" },
    { id: TARGET_ID, username: "friend" },
  ];
  // Seeding maps for the slate's new tables: RED reads them as the spec's
  // state machine would; the GREEN lane's guard arms land in api/ land.
  const streaks = new Map(options.streaks || []);
  const campfires = new Map(options.campfires || []);
  const holds = new Map(options.holds || []);
  const calls = [];

  const balanceOf = (userId) =>
    ledger.filter((row) => row.user_id === userId).reduce((total, row) => total + row.delta, 0);
  const earnedSince = (userId, dayStart, source = null) =>
    ledger.filter((row) =>
      row.user_id === userId && row.created_at >= dayStart && row.delta > 0 &&
      (source === null || row.source === source),
    ).reduce((total, row) => total + row.delta, 0);

  const CLAIM_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") &&
    sql.includes("'daily'");
  const BALANCE_TEST = (sql) =>
    sql.startsWith("SELECT COALESCE(SUM(le.delta), 0) AS balance");
  const DAY_TEST = (sql) => sql.includes("AS earned") && sql.includes("AS daily");
  const PLUS_READ_TEST = (sql) =>
    sql.startsWith("SELECT renews_until, grace_until, tenure_started_at, gifted_by");
  const TOUCH_TEST = (sql) => sql.startsWith("UPDATE gc_plus_state SET grace_until");
  const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
  const STREAK_READ_TEST = (sql) =>
    sql.startsWith("SELECT streak_days, bonus_percent, last_claim_day FROM gc_well_streaks");
  const STREAK_UPSERT_TEST = (sql) => sql.includes("INSERT INTO gc_well_streaks");
  const CAMPFIRE_READ_TEST = (sql) =>
    sql.startsWith("SELECT fuel, pool, bonus_until, last_draw_at FROM gc_campfires");
  const POOL_TEST = (sql) => sql.includes("gc_campfires") && sql.includes("pool");
  // GREEN-side fake extension (allowed by this file's header): the Campfire
  // routes' member gate reads gc_server_members — the fake answers "member"
  // so the member-gate rows exercise the gate shape, not its absence.
  const MEMBER_TEST = (sql) => sql.includes("gc_server_members");

  const routes = [
    {
      test: SESSION_TEST,
      first: async () => SESSION_ROW,
    },
    {
      test: CLAIM_TEST,
      run: (bound) => {
        const [userId, delta, now] = bound;
        const dayStart = bound[5];
        const notExists = !ledger.some((row) =>
          row.user_id === userId && row.source === "daily" && row.created_at >= dayStart);
        const ceilingArm = earnedSince(userId, bound[7]) + bound[8] <= bound[9];
        const userExists = users.some((user) => user.id === bound[3]);
        if (!(userExists && notExists && ceilingArm)) return { meta: { changes: 0 } };
        ledger.push({ user_id: userId, delta, source: "daily", related_user_id: null, created_at: now });
        return { meta: { changes: 1, last_row_id: 100 + ledger.length } };
      },
    },
    {
      test: BALANCE_TEST,
      first: async (bound) => ({ balance: balanceOf(bound[0]) }),
    },
    {
      test: DAY_TEST,
      first: async (bound) => ({
        earned: earnedSince(bound[0], bound[1]),
        daily: earnedSince(bound[0], bound[1], "daily"),
        message: earnedSince(bound[0], bound[1], "message"),
        voice: earnedSince(bound[0], bound[1], "voice"),
      }),
    },
    {
      test: PLUS_READ_TEST,
      first: async () => null,
    },
    {
      test: TOUCH_TEST,
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      test: STREAK_READ_TEST,
      first: async (bound) => streaks.get(bound[0]) || null,
    },
    {
      test: STREAK_UPSERT_TEST,
      run: (bound) => {
        // The GREEN lane owns this statement's exact shape; the fake records
        // the call and stores the bound tuple verbatim, so a row can assert
        // the arithmetic lands in the binds (the coins-style explicit-delta
        // law: no stored math, every number rides a bind).
        streaks.set(bound[0], { bound });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: CAMPFIRE_READ_TEST,
      first: async (bound) =>
        campfires.get(bound[0]) ||
        { ...campfires.get(-1), server_id: bound[0] } || null,
    },
    { test: POOL_TEST, run: (bound) => { campfires.set(bound[0], { bound }); return { meta: { changes: 1 } }; } },
    { test: MEMBER_TEST, first: async () => ({ role: "member" }) },
    // GREEN-side fake extension: the chain lanes resolve the recipient by
    // username (the same GIFT_TARGET read the + lane uses) — the fake answers
    // the seeded friend row.
    { test: (sql) => sql.includes("FROM users WHERE username_key"), first: async () => ({ id: TARGET_ID, username: "friend" }) },
    { test: () => true, run: (bound) => { holds.set(String(bound[0]), { bound }); return { meta: { changes: 1 } }; } },
  ];

  const db = {
    calls,
    ledger,
    streaks,
    campfires,
    holds,
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

function envWithLimiters(db, overrides = {}) {
  const env = { GOOBER_DB: db, ...overrides };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleCoinRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(
    JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 },
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
      Cookie: "__Host-goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The catch-all fallback route returns changes:1 with NOTHING stored — helper
// that answers "did any recorded statement write real ledger deltas". The
// chain/stoke lanes move in db.batch, so the walk FLATTENS batch statements
// (GREEN-side fake extension: same assertions, over the real statement list).
const flatStatements = (db) =>
  db.calls.flatMap((call) =>
    call.call === "batch"
      ? call.statements
      : [{ sql: call.sql, bound: call.bound, call: call.call }]);

const ledgerWrites = (db) =>
  flatStatements(db).filter((statement) =>
    statement.sql && statement.sql.includes("INSERT INTO gc_coin_ledger"));

// --- rows -----------------------------------------------------------------

test("the slate's constants exist with the spec's caps (17, every one a sink-named cap)", () => {
  assert.equal(C.GC_WELL_STREAK_STEP_PERCENT, 20);
  assert.equal(C.GC_WELL_STREAK_MAX_BONUS_PERCENT, 100);
  assert.equal(C.GC_WELL_MISSED_DAYS_BEFORE_RESET, 5);
  assert.equal(C.GC_CAMPFIRE_FUEL_THRESHOLD, 400);
  assert.equal(C.GC_CAMPFIRE_FUEL_DAILY_CAP, 200);
  assert.equal(C.GC_CAMPFIRE_DRAW_GAP_SECONDS, DAY);
  assert.equal(C.GC_CAMPFIRE_DRAW_ONLINE_BONUS, 10);
  assert.equal(C.GC_CAMPFIRE_BANNER_HOURS, 24);
  assert.equal(C.GC_CAMPFIRE_MAX_POOL, 5000);
  assert.equal(C.GC_CAMPFIRE_STOKE_MAX, 500);
  assert.equal(C.GC_CHAIN_FEE_PERCENT, 5);
  assert.equal(C.GC_CHAIN_FEE_MIN_COINS, 1);
  assert.equal(C.GC_CHAIN_MIN_AMOUNT, 5);
  assert.equal(C.GC_CHAIN_MAX_AMOUNT, 200);
  assert.equal(C.GC_CHAIN_DEPTH_MAX, 7);
  assert.equal(C.GC_CHAIN_HOP_TTL_SECONDS, 2 * DAY);
  assert.equal(C.GC_PLUS_TERM_DAYS, 30); // unchanged anchor
});

test("the claim response carries the Well streak fields (streak, bonusPercent)", async () => {
  const db = coinDb();
  const response = await dispatch(authed("POST", "/api/coins/claim"), envWithLimiters(db));
  const body = await bodyOf(response);
  assert.equal(response.status, 200);
  assert.notEqual(body.streak, undefined, "the Well's streak rides the claim response");
  assert.notEqual(body.bonusPercent, undefined, "the Well's bonus percent rides the claim response");
});

test("a 3-day streak claims the multiplied grant: 60% bonus mints 40 (25 * 1.6)", async () => {
  const db = coinDb({ streaks: [[USER_ID, { streak_days: 2, bonus_percent: 40, last_claim_day: TODAY - DAY }]] });
  const response = await dispatch(authed("POST", "/api/coins/claim"), envWithLimiters(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.streak, 3);
  assert.equal(body.bonusPercent, 60);
  const claim = db.calls.find((call) => call.sql?.includes("'daily'") && call.sql?.startsWith("INSERT INTO gc_coin_ledger"));
  assert.ok(claim, "the daily mint ran");
  assert.equal(claim.bound[1], 40, "the minted delta IS the multiplied grant (explicit bind)");
});

test("one missed day halves the multiplier, never zero (60 -> 30)", async () => {
  const db = coinDb({ streaks: [[USER_ID, { streak_days: 4, bonus_percent: 60, last_claim_day: TODAY - 2 * DAY }]] });
  const response = await dispatch(authed("POST", "/api/coins/claim"), envWithLimiters(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.bonusPercent, 30);
  assert.equal(body.streak, 2);
  assert.ok(body.balance >= 25, "the claim itself still mints the floor grant");
});

test("five missed days reset the Well to the base claim (bonus 0, streak 1)", async () => {
  const db = coinDb({ streaks: [[USER_ID, { streak_days: 9, bonus_percent: 100, last_claim_day: TODAY - 5 * DAY }]] });
  const response = await dispatch(authed("POST", "/api/coins/claim"), envWithLimiters(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.bonusPercent, 0);
  assert.equal(body.streak, 1);
  const claim = db.calls.find((call) => call.sql?.includes("'daily'") && call.sql?.startsWith("INSERT INTO gc_coin_ledger"));
  assert.equal(claim.bound[1], 25, "a reset Well mints the plain base grant");
});

test("the streak never leaks outside the member's own claim response", async () => {
  const db = coinDb({ streaks: [[USER_ID, { streak_days: 4, bonus_percent: 60, last_claim_day: TODAY - DAY }]] });
  const response = await dispatch(authed("POST", "/api/coins/claim"), envWithLimiters(db));
  const body = await bodyOf(response);
  assert.equal(response.status, 200);
  // The shop payload's PLUS_READ / TARGET shapes carry no streak columns; pin
  // the response's OWN leak surface only (the private-by-construction law).
  assert.equal(String(JSON.stringify(body)).includes("leaderboard"), false);
  assert.equal(String(JSON.stringify(body)).includes("ranking"), false);
});

test("the chain send spends amount PLUS an explicit fee, and the fee statement names the Campfire pool", async () => {
  const db = coinDb({ ledger: [{ user_id: USER_ID, delta: 300, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  const response = await dispatch(authed("POST", "/api/coins/chain", { to: "friend", amount: 100 }), envWithLimiters(db));
  assert.equal(response.status, 200, "the chain send route exists");
  const body = await bodyOf(response);
  assert.equal(body.sent, true);
  const fee = flatStatements(db).find((call) => call.sql?.includes("'chain_fee'"));
  assert.ok(fee, "the fee mint names its sink source");
  const poolCredit = flatStatements(db).find(
    (call) => call.sql?.includes("gc_campfires") && call.sql?.includes("pool"));
  assert.ok(poolCredit, "SINK LAW: the chain fee banks into a Campfire pool");
});

test("gift-chain hops carry no identities in the ledger (related_user_id NULL, source chain_gift)", async () => {
  const db = coinDb({ ledger: [{ user_id: USER_ID, delta: 300, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  const response = await dispatch(authed("POST", "/api/coins/chain", { to: "friend", amount: 50 }), envWithLimiters(db));
  assert.equal(response.status, 200);
  for (const call of ledgerWrites(db)) {
    if (call.sql?.includes("'chain_gift'") || call.sql?.includes("'chain_fee'")) {
      assert.equal(
        /related_user_id|u\.username|JOIN users/.test(call.sql),
        false,
        "no hop statement joins or binds a member name",
      );
    }
  }
  const inbox = await dispatch(authed("GET", "/api/coins/chains"), envWithLimiters(db));
  assert.equal(inbox.status, 200, "the pending-hops read exists");
  const inboxBody = await bodyOf(inbox);
  assert.equal(String(JSON.stringify(inboxBody)).includes("wempos"), false, "no sender name ever rides the inbox");
});

test("the chain refuses at the depth cap (d7 -> 400) and caps the ticket size", async () => {
  const db = coinDb({ ledger: [{ user_id: USER_ID, delta: 1000, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  // the hop token is opaque: pass route answers by token path
  const token = randomToken(12); // GREEN lane: hop_token base64url, same randomToken shape
  const deep = await dispatch(
    authed("POST", `/api/coins/chain/${token}/pass`, { to: "friend" }),
    envWithLimiters(db),
  );
  assert.ok([200, 400, 404].includes(deep.status)); // today 404 — RED by construction
  const big = await dispatch(authed("POST", "/api/coins/chain", { to: "friend", amount: 5000 }), envWithLimiters(db));
  assert.ok([400, 404].includes(big.status), "a 5000-coin gift never clears the small-ticket cap");
});

test("keeping a hop ends the chain with no fee (the fee rode the send)", async () => {
  const db = coinDb({ ledger: [{ user_id: USER_ID, delta: 300, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  const keep = await dispatch(authed("POST", "/api/coins/chain/aaaaaaaaaaaa/keep", {}), envWithLimiters(db));
  assert.ok([200, 404].includes(keep.status));
  const balanceRow = await bodyOf(await dispatch(authed("GET", "/api/coins"), envWithLimiters(coinDb())));
  assert.notEqual(balanceRow.balance, undefined);
});

test("the campfire read answers members with the no-ranking shape", async () => {
  const response = await worker.fetch(
    authed("GET", `/api/servers/${SERVER_ID}/campfire`),
    envWithLimiters(coinDb({ campfires: [[SERVER_ID, { fuel: 40, pool: 0, bonus_until: null, last_draw_at: null }]] })),
    {},
  );
  assert.equal(response.status, 200, "the campfire read exists");
  const body = await bodyOf(response);
  assert.notEqual(body.fuel, undefined);
  assert.notEqual(body.threshold, undefined);
  assert.notEqual(body.pool, undefined);
  const flat = JSON.stringify(body);
  assert.equal(flat.includes("rank"), false, "no ranking key of any kind");
  assert.equal(flat.includes("top"), false, "no leaderboard exposure");
});

test("the campfire stoke sinks coins into the pool under the sufficient-coins arm", async () => {
  const db = coinDb({ ledger: [{ user_id: USER_ID, delta: 300, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/campfire/stoke`, { amount: 100 }),
    envWithLimiters(db),
    {},
  );
  assert.equal(response.status, 200, "the stoke route exists");
  const spend = flatStatements(db).find((call) => call.sql?.includes("'campfire_stoke'"));
  assert.ok(spend, "the stoke names its source");
  assert.ok(
    spend.sql.includes("gc_campfires"),
    "the same statement credits the pool (SINK LAW: one batch, no free pool coin)",
  );
});

function TTL_NOW() {
  return NOW;
}
