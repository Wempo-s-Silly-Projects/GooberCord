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
  const hops = new Map(options.hops || []);
  const calls = [];
  // The batch engine's changes() cursor: statement N's `(SELECT changes())`
  // arms read the count of the most recently COMPLETED statement (the probe —
  // /tmp/gc-audit-fix-probe.mjs — verifies a zero-row INSERT resets it to 0).
  let lastChanges = 0;

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
  // The WAVE-3 roster seat: the Campfire draw's online crossing reads the
  // server's roster — the fake seeder carries two members (ids 1 and 22).
  const ROSTER_TEST = (sql) =>
    sql.startsWith("SELECT user_id FROM gc_server_members WHERE server_id = ?");
  // The repair (C1/H1 RED pins): the guarded coin spends — the real SQL's
  // balance arm IS encoded here per the real statement, so a sender below the
  // guard answers changes-0 instead of the catch-all's blind changes-1. The
  // `changes() = 1` arm (fixed fee spend / hop) reads the batch cursor, and
  // the stoke's pool-cap arm reads the campfires map, exactly where the real
  // SQL's clauses put them.
  const SPEND_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) SELECT ?, ?, '") &&
    sql.includes("WHERE (SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le WHERE le.user_id = ?) >= ?");
  // The pool credit upsert (both the shipped no-fp 5-bind form and the fixed
  // fingerprinted builder form) — the fingerprint arms are decoded from the
  // binds the real builder placed: (server, amount, now, …fp, amount, now, …fp).
  const POOL_CREDIT_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_campfires (server_id, fuel, pool, updated_at)");

  const routes = [
    {
      test: SESSION_TEST,
      first: async () => SESSION_ROW,
    },
    {
      test: ROSTER_TEST,
      all: async () => ({ results: [{ user_id: 1 }, { user_id: 22 }] }),
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
      test: SPEND_TEST,
      run: (bound, sql) => {
        if (sql.includes("(SELECT changes()) = 1") && lastChanges !== 1) {
          return { meta: { changes: 0 } };
        }
        if (balanceOf(bound[0]) < bound[4]) return { meta: { changes: 0 } };
        if (sql.includes("cf.pool")) {
          // The stoke's pool-cap arm: COALESCE(pool,0) + amount <= cap.
          const current = Number(campfires.get(Number(bound[5]))?.pool) || 0;
          if (current + bound[6] > C.GC_CAMPFIRE_MAX_POOL) return { meta: { changes: 0 } };
        }
        const source = (sql.match(/SELECT \?, \?, '([a-z_]+)', \?/) || [])[1] || "unknown";
        ledger.push({ user_id: bound[0], delta: bound[1], source, related_user_id: null, created_at: bound[2] });
        return { meta: { changes: 1 } };
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
    {
      test: POOL_CREDIT_TEST,
      run: (bound, sql) => {
        if (sql.includes("(SELECT changes()) = 1") && lastChanges !== 1) {
          return { meta: { changes: 0 } };
        }
        // The fingerprinted builder form: the EXISTS arm lands only when the
        // cause row it names is on the batch's own ledger (the chain_fee /
        // campfire_stoke spend row the real guard fingerprints).
        if (bound.length > 5) {
          const fpBinds = bound.slice(3, bound.length - 5);
          const source = (sql.match(/le\.source = '([a-z_]+)'/) || [])[1];
          const landed = source && ledger.some((row) =>
            row.user_id === fpBinds[0] && row.source === source &&
            row.delta === fpBinds[1] && row.created_at === fpBinds[2]);
          if (!landed) return { meta: { changes: 0 } };
        }
        const previous = campfires.get(Number(bound[0]));
        const pool = Math.min((Number(previous?.pool) || 0) + Number(bound[1]), C.GC_CAMPFIRE_MAX_POOL);
        campfires.set(Number(bound[0]), { ...(previous || {}), fuel: Number(previous?.fuel) || 0, pool, updated_at: bound[2] });
        return { meta: { changes: 1 } };
      },
    },
    { test: POOL_TEST, run: (bound) => { campfires.set(bound[0], { bound }); return { meta: { changes: 1 } }; } },
    {
      // The send's hop rides the fee spend's changes; the shipped plain-VALUES
      // form commits unconditionally (the C1 defect the refusal pin encodes),
      // and the pass's fingerprinted form keeps its (token, created_at) claim.
      test: (sql) => sql.startsWith("INSERT INTO gc_chain_hops"),
      run: (bound, sql) => {
        if (sql.includes("(SELECT changes()) = 1") && lastChanges !== 1) {
          return { meta: { changes: 0 } };
        }
        hops.set(String(bound[0]), { bound });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The hold rides the hop (the CHAIN_PASS idiom): no hop, no hold. The
      // shipped plain-VALUES form commits unconditionally — the same defect.
      test: (sql) => sql.startsWith("INSERT INTO gc_chain_hold"),
      run: (bound, sql) => {
        if (sql.includes("nh.hop_token = ?") && !hops.has(String(bound[3]))) {
          return { meta: { changes: 0 } };
        }
        holds.set(String(bound[0]), { bound });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("SELECT h.hop_token, h.depth, h.amount, h.expires_at, h.created_at"),
      // GREEN-side fake extension: the chain lanes resolve a hop by its OWN
      // hold row — the fake answers a riding hop (depth 6, amount 100).
      first: async (bound) => ({
        hop_token: String(bound[0]),
        depth: 6,
        amount: 100,
        created_at: 5,
        expires_at: NOW + DAY,
      }),
    },
    { test: MEMBER_TEST, first: async () => ({ role: "member" }) },
    // GREEN-side fake extension: the chain lanes resolve the recipient by
    // username (the same GIFT_TARGET read the + lane uses) — the fake answers
    // the seeded friend row.
    { test: (sql) => sql.includes("FROM users WHERE username_key"), first: async () => ({ id: TARGET_ID, username: "friend" }) },
    {
      test: () => true,
      run: () => ({ meta: { changes: 1 } }),
    },
  ];

  const db = {
    calls,
    ledger,
    streaks,
    campfires,
    holds,
    hops,
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
        let out;
        // The WAVE-3 verdict hook: options.verdictFor stages a live
        // changes-verdict per SQL (a lost race's zero) BEFORE the route's own
        // handler — a vetoed statement must not mutate the fake's maps (its
        // real engine answered changes-0), so the staged verdict wins first.
        if (options.verdictFor) {
          const verdict = options.verdictFor(sql);
          if (verdict !== undefined) out = { meta: { changes: verdict } };
        }
        if (out === undefined) {
          out = route && route.run ? await route.run(statement.bound, sql) : { meta: { changes: 1 } };
        }
        calls[calls.length - 1].changes = out.meta?.changes;
        lastChanges = out.meta?.changes;
        return out;
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
// that answers "did any recorded statement write real ledger deltas". Batch
// statements record as their own run entries (verdict included), so the walk
// reads THOSE (the aggregated batch entry stays out — no double counting).
const flatStatements = (db) =>
  db.calls.filter((call) => call.call === "run");

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

// The C1/H1 refusal pins: a REFUSED opener must leave the whole batch a
// single atomic no-op — no fee, no hop, no hold, no pool coin, no book row.

test("a chain send with the fee but not the gift refuses WHOLE — the sender's money never moves", async () => {
  // amount 100 + fee 5 costs 105; the sender holds exactly [fee, amount+fee).
  const db = coinDb({ ledger: [{ user_id: USER_ID, delta: 104, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  const response = await dispatch(authed("POST", "/api/coins/chain", { to: "friend", amount: 100 }), envWithLimiters(db));
  assert.equal(response.status, 400, "the gift refuses at the opener's balance arm");
  assert.equal(db.balanceOf(USER_ID), 104, "the fee ride-along never charges a refused send");
  assert.equal(db.ledger.length, 1, "no chain_fee row rides the refusal");
  assert.equal(db.hops.size, 0, "no live hop banks on a refused opener");
  assert.equal(db.holds.size, 0, "no hold banks on a refused opener");
  assert.equal(db.campfires.size, 0, "SINK LAW: no pool credit mints from a refused send");
});

test("a stoke past the coins arm banks no pool credit and spends no coin", async () => {
  const db = coinDb({ campfires: [[SERVER_ID, { fuel: 40, pool: 1000, bonus_until: null, last_draw_at: null }]] });
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/campfire/stoke`, { amount: 100 }),
    envWithLimiters(db),
    {},
  );
  assert.equal(response.status, 400, "the stoke refuses at the sufficient-coins arm");
  assert.equal(db.balanceOf(USER_ID), 0, "no coin spent");
  assert.equal(Number(db.campfires.get(SERVER_ID)?.pool), 1000, "the pool never banks a refused stoke");
});

test("a stoke at the capped pool refuses — the pool-cap arm is the gate, no coin moves", async () => {
  const db = coinDb({
    campfires: [[SERVER_ID, { fuel: 40, pool: C.GC_CAMPFIRE_MAX_POOL, bonus_until: null, last_draw_at: null }]],
    ledger: [{ user_id: USER_ID, delta: 300, source: "daily", related_user_id: null, created_at: TTL_NOW() }],
  });
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/campfire/stoke`, { amount: 100 }),
    envWithLimiters(db),
    {},
  );
  assert.equal(response.status, 400, "the stoke refuses at the pool-cap arm");
  assert.equal(db.balanceOf(USER_ID), 300, "no coin spent");
  assert.equal(Number(db.campfires.get(SERVER_ID)?.pool), C.GC_CAMPFIRE_MAX_POOL, "the cap arm held");
  const credit = flatStatements(db).find((call) =>
    call.sql?.startsWith("INSERT INTO gc_campfires (server_id, fuel, pool, updated_at)"));
  assert.ok(credit, "the pool credit still rides the batch");
  assert.ok(
    credit.sql.includes("(SELECT changes()) = 1") && credit.sql.includes("le.source = 'campfire_stoke'"),
    "the credit is fingerprinted to the stoke's own spend (H1 gate, both arms)",
  );
});

// The WAVE-3 presence stub: the draw's roster crossing reads the hub — the
// fake answers two online members against the roster route's {1, 22}.
const fakeHub = () => ({
  idFromName: (name) => ({ name }),
  get: () => ({
    fetch: async () => new Response(
      JSON.stringify({ online: [{ userId: 1 }, { userId: 22 }] }),
      { headers: { "content-type": "application/json" } },
    ),
  }),
});

test("the campfire draw mints exactly the pool's debit — no free coin rides a draw", async () => {
  const baseline = 2 * C.GC_CAMPFIRE_DRAW_ONLINE_BONUS;
  const db = coinDb({
    campfires: [[SERVER_ID, { fuel: C.GC_CAMPFIRE_FUEL_THRESHOLD, pool: baseline, bonus_until: null, last_draw_at: null }]],
  });
  const response = await worker.fetch(
    authed("GET", `/api/servers/${SERVER_ID}/campfire`),
    envWithLimiters(db, { PRESENCE: fakeHub() }),
    {},
  );
  assert.equal(response.status, 200);
  const payoutRows = flatStatements(db).filter((call) =>
    call.sql?.startsWith("INSERT INTO gc_coin_ledger") && call.sql?.includes("'campfire'"));
  assert.equal(payoutRows.length, 2, "one payout per online member, never a general mint");
  const paid = payoutRows.reduce((total, call) => total + call.bound[1], 0);
  const debit = flatStatements(db).find((call) => call.sql?.includes("pool = pool - ?"));
  assert.ok(debit, "the draw DEBITS the pool (spec line 90), it never free-mints");
  assert.equal(debit.bound[0], 2 * C.GC_CAMPFIRE_DRAW_ONLINE_BONUS,
    "the debit IS the paid sum (the delta pin, not the >= 0 floor)");
  assert.equal(paid, debit.bound[0], "total minted == amount paid to members");
});

test("a second concurrent draw cannot double-pay — the claim's verdict gates every payout", async () => {
  const db = coinDb({
    campfires: [[SERVER_ID, { fuel: C.GC_CAMPFIRE_FUEL_THRESHOLD, pool: 2 * C.GC_CAMPFIRE_DRAW_ONLINE_BONUS, bonus_until: null, last_draw_at: null }]],
    verdictFor: (sql) => (sql.includes("pool = pool - ?") ? 0 : undefined),
  });
  const response = await worker.fetch(
    authed("GET", `/api/servers/${SERVER_ID}/campfire`),
    envWithLimiters(db, { PRESENCE: fakeHub() }),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(
    flatStatements(db).filter((call) =>
      call.sql?.startsWith("INSERT INTO gc_coin_ledger") && call.sql?.includes("'campfire'")).length,
    0, "the losing draw mints nothing",
  );
  assert.equal(
    db.calls.some((call) => call.call === "run" && call.sql?.includes("pool = pool + ?")),
    false, "no pool drift: the loser never refunds what it never debited",
  );
});

test("two concurrent pass batches — the old hold survives to serve exactly one pass", async () => {
  const winnerDb = coinDb({ ledger: [{ user_id: USER_ID, delta: 1000, source: "daily", related_user_id: null, created_at: TTL_NOW() }] });
  const win = await dispatch(authed("POST", "/api/coins/chain/aaaaaaaaaaaa/pass", { to: "friend" }), envWithLimiters(winnerDb));
  assert.equal(win.status, 200, "the winner's pass rides whole");
  const winnerHoldDelete = flatStatements(winnerDb).find((call) => call.sql?.startsWith("DELETE FROM gc_chain_hold"));
  assert.ok(winnerHoldDelete, "the winner claimed the old hold");
  assert.equal(winnerHoldDelete.changes, 1, "the old hold is deleted exactly once");

  // The loser stages the race: its fee spend fingerprints to a hop the
  // winner already moved — every statement answers changes 0, nothing mints,
  // and the old hold survives.
  const loserDb = coinDb({
    ledger: [{ user_id: USER_ID, delta: 1000, source: "daily", related_user_id: null, created_at: TTL_NOW() }],
    verdictFor: (sql) => (sql.includes("'chain_fee'")
      || sql.includes("gh.hop_token = ? AND gh.created_at = ?")
      || sql.includes("SELECT 1 FROM gc_chain_hops nh WHERE nh.hop_token = ?")
      || sql.startsWith("DELETE FROM gc_chain_hold")
      || sql.startsWith("DELETE FROM gc_chain_hops"))
      ? 0 : undefined,
  });
  const lose = await dispatch(authed("POST", "/api/coins/chain/aaaaaaaaaaaa/pass", { to: "friend" }), envWithLimiters(loserDb));
  assert.equal(lose.status, 409, "the loser's claim is the refused one, never a silent re-move");
  assert.equal(
    flatStatements(loserDb).filter((call) => call.call === "run").every((call) => call.changes === 0),
    true, "the losing batch moved NOTHING (no double-mint of the carried amount)",
  );
  assert.equal(
    flatStatements(loserDb).filter((call) => call.sql?.startsWith("DELETE FROM gc_chain_hold"))[0]?.changes,
    0, "the old hold survives to serve exactly one pass",
  );
});

function TTL_NOW() {
  return NOW;
}
