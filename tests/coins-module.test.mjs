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

// Goober Coins (0011): the economy's routes, grant guards, term state, and the
// owner's two hard decrees — the balance IS SUM(gc_coin_ledger.delta) (there
// is no balance column anywhere), and NO purchase path exists.
//
// Same fakeDb + pinned-SQL contract style as the roles/layers/mod-desk
// modules: every write's guard rides INSIDE the SQL, and the fake's handlers
// ENCODE that guard (the ceiling sum, the once-per-day NOT EXISTS, the
// spend's sufficient-coins arm, the term upsert's spend fingerprint) so a
// pinned statement that loses an arm fails the tests.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCoinRoutes, grantMessageCoins } from "../api/coins.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import {
  GC_COIN_DAILY_CEILING,
  GC_COIN_DAILY_GRANT,
  GC_COIN_MESSAGE_DAILY_CAP,
  GC_COIN_MESSAGE_GRANT,
  GC_COIN_VOICE_DAILY_CAP,
  GC_COIN_VOICE_GRANT,
  GC_COSMETIC_BANNER_PRICE,
  GC_COSMETIC_FLAIR_PRICE,
  GC_COSMETIC_PACK_PRICE,
  GC_MINI_PRICE,
  GC_MINI_RENEWAL_PRICE,
  GC_PLUS_DAILY_CEILING,
  GC_PLUS_MESSAGE_GRANT,
  GC_PLUS_PRICE,
  GC_PLUS_RENEWAL_PRICE,
  GC_PLUS_ROLLUP_GRANT,
  GC_PLUS_SERVER_GRANT,
  GC_PLUS_SINK_DISCOUNT_PERCENT,
  GC_PLUS_TERM_DAYS,
  GC_PLUS_VOICE_GRANT,
  GC_ROLLUP_DAILY_CAP,
  GC_ROLLUP_GRANT,
  GC_SERVER_GRANT,
  GC_SERVER_MINT_DAILY_CAP,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;
const NOW = nowSeconds();
const TERM = GC_PLUS_TERM_DAYS * 86400;
const GRACE = 7 * 86400;

// --- shared scaffolding (same conventions as the roles/mod-desk modules) ------

function request(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    JSON.stringify({ error: "That API endpoint does not exist." }),
    { status: 404 },
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// One standing session: the fake handles readSession's own SELECT (the same
// shape tests mod-desk-module pins), so the coin routes' requireUser gates
// pass the same way they do under the real vendored core.
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

// --- the stateful ledger fake ---------------------------------------------------
//
// The seed is a REAL ledger shape (delta rows only, no balance column); every
// handler below re-derives sums from it, so "balance === SUM(deltas)" is the
// invariant the suite exercises, not an assumption.

function coinDb(options = {}) {
  const ledger = (options.ledger || []).map((row) => ({ ...row }));
  const plusRows = new Map(options.plus || []);
  const plusCalls = [];
  const users = options.users || [
    { id: USER_ID, username: "wempos" },
    { id: TARGET_ID, username: "friend" },
  ];
  const voiceSeats = options.voiceSeats || []; // [{ channelId, userId }]
  const calls = [];
  let nextRowId = 100;

  const balanceOf = (userId) =>
    ledger.filter((row) => row.user_id === userId).reduce((total, row) => total + row.delta, 0);
  const earnedSince = (userId, dayStart, source = null) =>
    ledger.filter((row) =>
      row.user_id === userId && row.created_at >= dayStart && row.delta > 0 &&
      (source === null || row.source === source),
    ).reduce((total, row) => total + row.delta, 0);

  // Statement matchers (the pinned SQL shapes).
  const CLAIM_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") &&
    sql.includes("'daily'");
  const MESSAGE_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") &&
    sql.includes("'message'");
  const VOICE_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at)") &&
    sql.includes("'voice'");
  const SPEND_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at)") &&
    sql.includes("WHERE EXISTS (SELECT 1 FROM users");
  const UPSERT_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_plus_state") && sql.indexOf("ON CONFLICT(user_id) DO UPDATE") >= 0;
  const BALANCE_TEST = (sql) =>
    sql.startsWith("SELECT COALESCE(SUM(le.delta), 0) AS balance");
  const DAY_TEST = (sql) => sql.includes("AS earned") && sql.includes("AS daily");
  const PLUS_READ_TEST = (sql) =>
    sql.startsWith("SELECT renews_until, grace_until, tenure_started_at, gifted_by");
  const TOUCH_TEST = (sql) => sql.startsWith("UPDATE gc_plus_state SET grace_until");
  const TARGET_TEST = (sql) =>
    sql.startsWith("SELECT id, username FROM users WHERE username_key = ?");
  const LEDGER_TEST = (sql) =>
    sql.startsWith("SELECT le.id, le.delta, le.source, le.related_user_id");

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      test: CLAIM_TEST,
      run: (bound) => {
        // bound: [userId, grant, now, u, u, dayStart, u, dayStart, grant, ceiling]
        const [userId, delta, now] = bound;
        const dayStart = bound[5];
        const notExists = !ledger.some((row) =>
          row.user_id === userId && row.source === "daily" && row.created_at >= dayStart);
        const ceilingArm = earnedSince(userId, bound[7]) + bound[8] <= bound[9];
        const userExists = users.some((user) => user.id === bound[3]);
        if (!(userExists && notExists && ceilingArm)) return { meta: { changes: 0 } };
        ledger.push({ user_id: userId, delta, source: "daily", related_user_id: null, created_at: now });
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      },
    },
    {
      test: MESSAGE_TEST,
      run: (bound) => {
        // [userId, grant, now, u, dayStart, grant, ceiling, u, dayStart, grant, cap]
        const [userId, delta] = bound;
        const dayStart = bound[4];
        const insideCeiling = earnedSince(userId, dayStart) + bound[5] <= bound[6];
        const insideSource = earnedSince(userId, dayStart, "message") + bound[9] <= bound[10];
        if (!(insideCeiling && insideSource)) return { meta: { changes: 0 } };
        ledger.push({ user_id: userId, delta, source: "message", related_user_id: null, created_at: bound[2] });
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      },
    },
    {
      test: VOICE_TEST,
      run: (bound) => {
        // [userId, grant, now, membershipUser, channelId, u, dayStart, grant,
        //  ceiling, u, dayStart, grant, cap]
        const [userId, delta] = bound;
        const dayStart = bound[6];
        const seated = voiceSeats.some((seat) =>
          seat.channelId === bound[4] && seat.userId === bound[3]);
        const insideCeiling = earnedSince(userId, dayStart) + bound[7] <= bound[8];
        const insideSource = earnedSince(userId, dayStart, "voice") + bound[11] <= bound[12];
        if (!(seated && insideCeiling && insideSource)) return { meta: { changes: 0 } };
        ledger.push({ user_id: userId, delta, source: "voice", related_user_id: null, created_at: bound[2] });
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      },
    },
    {
      test: SPEND_TEST,
      run: (bound) => {
        // [gifter, -price, source, related, now, recipient, gifter, price]
        const [gifter, delta, source, related, now] = bound;
        const recipientExists = users.some((user) => user.id === bound[5]);
        const affordable = balanceOf(bound[6]) >= bound[7];
        if (!(recipientExists && affordable)) return { meta: { changes: 0 } };
        ledger.push({ user_id: gifter, delta, source, related_user_id: related, created_at: now });
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      },
    },
    {
      test: UPSERT_TEST,
      run: (bound) => {
        // bound: [target, MAX(now, now), +term, tenure, trail, updated, tier, |
        //         gifter, source, -price, now, related, | now, term, trail, tier, now]
        const [
          target, insertMaxA, insertMaxB, insertTerm, insertTenure, insertTrail, insertedAt, insertTier,
          fpUser, fpSource, fpDelta, fpNow, fpRelated,
          updateNow, updateTerm, updateTrail, updateTier, updatedAt,
        ] = bound;
        void insertMaxA; void insertMaxB; // the INSERT branch MAX()s them; both carry `now`
        const fingerprint = ledger.some((row) =>
          row.user_id === fpUser && row.source === fpSource && row.delta === fpDelta &&
          row.created_at === fpNow && (row.related_user_id ?? null) === fpRelated);
        if (!fingerprint) return { meta: { changes: 0 } };
        const stored = plusRows.get(target);
        if (stored) {
          plusRows.set(target, {
            renews_until: Math.max(stored.renews_until, updateNow) + updateTerm,
            grace_until: null,
            tenure_started_at: stored.tenure_started_at,
            gifted_by: updateTrail === null ? stored.gifted_by : updateTrail,
            // The purchased tier REPLACES the row's tier (the upgrade's
            // same-row carry-forward; the route 409s a Mini onto a full).
            tier: updateTier,
            updated_at: updatedAt,
          });
        } else {
          plusRows.set(target, {
            renews_until: Math.max(insertMaxA, insertMaxB) + insertTerm,
            grace_until: null,
            tenure_started_at: insertTenure,
            gifted_by: insertTrail,
            tier: insertTier,
            updated_at: insertedAt,
          });
        }
        plusCalls.push({ target, trail: updateTrail });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: TOUCH_TEST,
      run: (bound) => {
        // [graceSeconds, now, userId, now]
        const stored = plusRows.get(bound[2]);
        if (!stored || stored.grace_until !== null || stored.renews_until > bound[3]) {
          return { meta: { changes: 0 } };
        }
        stored.grace_until = stored.renews_until + bound[0];
        stored.updated_at = bound[1];
        plusRows.set(bound[2], stored);
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
      first: async (bound) => plusRows.get(bound[0]) || null,
    },
    {
      test: TARGET_TEST,
      first: async (bound) =>
        users.find((user) => user.username.toLowerCase() === String(bound[0])) || null,
    },
    {
      test: LEDGER_TEST,
      all: async (bound, sql) => {
        // bound: [userId] with the cursor appended when present; the LIMIT is
        // a statement-text literal (parsed here so the fake honors it). The
        // LEFT JOIN's trail name rides the row the way the SQL assembles it.
        const mine = ledger
          .filter((row) => row.user_id === bound[0])
          .map((row, index) => ({
            id: 5000 - index,
            ...row,
            related_username: users.find((user) => user.id === row.related_user_id)?.username || null,
          }));
        mine.sort((a, b) => b.id - a.id);
        const page = typeof bound[1] === "number" ? mine.filter((row) => row.id < bound[1]) : mine;
        const match = /LIMIT (\d+)\s*$/.exec(String(sql));
        return { results: match ? page.slice(0, Number(match[1])) : page };
      },
    },
  ];

  void plusCalls;

  const db = {
    calls,
    ledger,
    plusRows,
    balanceOf,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        return route && route.first ? await route.first(statement.bound, sql) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        return route && route.all ? await route.all(statement.bound, sql) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        if (!route || !route.run) return { meta: { changes: 1, last_row_id: ++nextRowId } };
        return route.run(statement.bound);
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

function envWithLimiters(db, overrides = {}) {
  const limitCalls = [];
  const env = { GOOBER_DB: db, ...overrides };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = {
      limit: async ({ key }) => {
        limitCalls.push(key);
        return { success: true, key };
      },
    };
  }
  return { env, limitCalls };
}

async function authed(path, { method = "GET", body } = {}) {
  const built = request(method, path, body, {
    Cookie: "goober_session=" + SESSION_TOKEN,
    "X-CSRF-Token": SESSION_ROW.csrf_token,
  });
  return { built };
}

// --- the economy's numbers (the owner-visible constants) ------------------------

test("the grant economics match the filed numbers (the ECONOMY RE-RULE)", () => {
  assert.equal(GC_COIN_DAILY_GRANT, 25);
  assert.equal(GC_COIN_MESSAGE_GRANT, 2);
  assert.equal(GC_PLUS_MESSAGE_GRANT, 3);
  assert.equal(GC_COIN_VOICE_GRANT, 5);
  assert.equal(GC_PLUS_VOICE_GRANT, 8);
  assert.equal(GC_ROLLUP_GRANT, 3);
  assert.equal(GC_PLUS_ROLLUP_GRANT, 5);
  assert.equal(GC_ROLLUP_DAILY_CAP, 5);
  assert.equal(GC_SERVER_GRANT, 50);
  assert.equal(GC_PLUS_SERVER_GRANT, 75);
  assert.equal(GC_SERVER_MINT_DAILY_CAP, 2);
  assert.equal(GC_COSMETIC_BANNER_PRICE, 100);
  assert.equal(GC_COSMETIC_FLAIR_PRICE, 100);
  assert.equal(GC_COSMETIC_PACK_PRICE, 250);
  assert.equal(GC_PLUS_SINK_DISCOUNT_PERCENT, 50);
  assert.equal(GC_COIN_VOICE_DAILY_CAP, 150);
  assert.equal(GC_COIN_MESSAGE_DAILY_CAP, 100);
  assert.equal(GC_COIN_DAILY_CEILING, 250);
  assert.equal(GC_PLUS_DAILY_CEILING, 500);
  // The pricing amendment: first 500, renewal 400.
  assert.equal(GC_PLUS_PRICE, 500);
  assert.equal(GC_PLUS_RENEWAL_PRICE, 400);
  assert.equal(GC_PLUS_TERM_DAYS, 30);
  // The ceiling is the ONE daily cap across sources and it bounds the sum of
  // the per-source maximums (a claim CAN crowd a voice session out on a
  // maximal day — that is the ceiling's actual job).
  assert.equal(GC_COIN_DAILY_GRANT + 100 + GC_COIN_VOICE_DAILY_CAP > GC_COIN_DAILY_CEILING, true);
});

// --- balance read: the balance IS the ledger's SUM ------------------------------

test("GET /api/coins answers the SUM of the ledger's deltas, never a stored balance", async () => {
  const ledger = [
    { user_id: USER_ID, delta: 25, source: "daily", related_user_id: null, created_at: NOW - 90000 },
    { user_id: USER_ID, delta: 12, source: "message", related_user_id: null, created_at: NOW - 400 },
    { user_id: USER_ID, delta: -500, source: "plus_renewal", related_user_id: null, created_at: NOW - 300 },
    { user_id: TARGET_ID, delta: 7, source: "voice", related_user_id: null, created_at: NOW - 100 },
  ];
  const db = coinDb({ ledger });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/coins");
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  const expected = 25 + 12 - 500;
  assert.equal(body.balance, expected, "balance is exactly SUM(delta)");
  assert.equal(body.dailyCeiling, GC_COIN_DAILY_CEILING);
  assert.equal(body.daily.claimedToday, false, "yesterday's daily row is outside today's window");
  assert.equal(typeof body.plus.hasPlus, "boolean");
  // The read-limiter identity: mirrors api/servers.mjs's scope + actor shape.
  assert.ok(limitCalls.includes(await sha256Hex("read:coins:" + USER_ID)));
});

test("GET /api/coins breaks today's earn down by source against the ceiling", async () => {
  const db = coinDb({
    ledger: [
      { user_id: USER_ID, delta: 5, source: "voice", related_user_id: null, created_at: NOW - 60 },
      { user_id: USER_ID, delta: -5, source: "plus_renewal", related_user_id: null, created_at: NOW - 50 },
    ],
    plus: [[USER_ID, { renews_until: NOW + 1000, grace_until: null, tenure_started_at: NOW - 9000, gifted_by: null }]],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins");
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.earnedToday, 5, "only positive deltas count as earned");
  assert.equal(body.voice.earnedToday, 5);
  assert.equal(body.message.earnedToday, 0);
  assert.equal(body.plus.hasPlus, true);
  assert.equal(body.plus.active, true, "renews_until in front of now is active");
  assert.equal(body.plus.inGrace, false, "the term has not lapsed, so no grace is claimed");
});

// --- the daily claim ------------------------------------------------------------

const CLAIM_SQL_PIN = {
  dailyLiteral: (sql) => sql.includes("'daily'"),
  oncePerDay: (sql) => /NOT EXISTS \(SELECT 1 FROM gc_coin_ledger ld/.test(sql),
  ceilingFilter: (sql) => /le\.delta > 0/.test(sql),
  ceilingArm: (sql) => /\) \+ \? <= \?\s*LIMIT 1$/.test(sql.trim()),
  userExists: (sql) => /EXISTS \(SELECT 1 FROM users u WHERE u\.id = \?\)/.test(sql),
};

test("POST /api/coins/claim mints the daily grant through ONE guarded INSERT", async () => {
  const db = coinDb({
    ledger: [
      { user_id: USER_ID, delta: 4, source: "message", related_user_id: null, created_at: NOW - 60 },
    ],
  });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/coins/claim", { method: "POST", body: {} });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.claimed, true);
  assert.equal(body.daily.claimedToday, true);
  assert.equal(body.balance, 4 + GC_COIN_DAILY_GRANT, "the minted delta IS the balance's change");

  const claim = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("'daily'"));
  assert.ok(claim, "exactly one ledger INSERT ran");
  for (const [label, pin] of Object.entries(CLAIM_SQL_PIN)) {
    assert.ok(pin(claim.sql), "the claim SQL carries its guard arm: " + label);
  }
  // bound[1] = grant, bound[8..9] = the ceiling arm's (delta, ceiling) pair.
  assert.equal(claim.bound[1], GC_COIN_DAILY_GRANT);
  assert.equal(claim.bound[8], GC_COIN_DAILY_GRANT);
  assert.equal(claim.bound[9], GC_COIN_DAILY_CEILING);
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:daily:" + USER_ID)));
});

test("a second claim on the same UTC day is refused without an oracle", async () => {
  const db = coinDb({
    ledger: [
      { user_id: USER_ID, delta: 25, source: "daily", related_user_id: null, created_at: NOW - 60 },
    ],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/claim", { method: "POST", body: {} });
  const response = await dispatch(built, env);
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), { error: "Already claimed today. Come back tomorrow." });
  const writes = db.calls.filter((entry) => entry.call === "run");
  assert.equal(writes.length, 1, "the refused mint ran once and inserted nothing");
  assert.equal(db.ledger.length, 1);
});

test("yesterday's daily row is outside the window: today's claim still mints", async () => {
  const db = coinDb({
    ledger: [
      { user_id: USER_ID, delta: 25, source: "daily", related_user_id: null, created_at: NOW - 90000 },
      { user_id: USER_ID, delta: 40, source: "voice", related_user_id: null, created_at: NOW - 89000 },
    ],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/claim", { method: "POST", body: {} });
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.claimed, true);
  assert.equal(body.balance, 25 + 40 + 25);
});

test("the claim's ceiling arm refuses a grant that would pass the daily ceiling", async () => {
  // 249 earned today + 25 → the guard refuses inside the SQL.
  const db = coinDb({
    ledger: [...Array(249).keys()].map(() => ({
      user_id: USER_ID, delta: 1, source: "message", related_user_id: null, created_at: NOW - 60,
    })),
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/claim", { method: "POST", body: {} });
  const response = await dispatch(built, env);
  assert.equal(response.status, 409, "the ceiling arm is the same refusal");
  assert.equal(db.ledger.length, 249, "nothing was minted");
});

// --- the per-message grant (api/messages.mjs's hook) ----------------------------

test("grantMessageCoins mints +1 under BOTH caps riding the INSERT", async () => {
  const db = coinDb({ ledger: [] });
  // The send pipeline passes the whole env (api/messages.mjs's shape).
  assert.equal(await grantMessageCoins({ GOOBER_DB: db }, USER_ID, NOW), true);
  assert.equal(db.balanceOf(USER_ID), GC_COIN_MESSAGE_GRANT);

  const grant = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("'message'"));
  assert.ok(grant);
  assert.match(grant.sql, /le\.source = 'message'/);
  assert.match(grant.sql, /\) \+ \? <= \?/);
  // binds: user, delta, now | u, dayStart, delta, ceiling | u, dayStart, delta, cap
  assert.equal(grant.bound[1], GC_COIN_MESSAGE_GRANT);
  assert.equal(grant.bound[6], GC_COIN_DAILY_CEILING);
  assert.equal(grant.bound[10], 100);
});

test("the message grant's source cap stops the mint on a maximal day", async () => {
  const rows = [...Array(100).keys()].map(() => ({
    user_id: USER_ID, delta: 1, source: "message", related_user_id: null, created_at: NOW - 60,
  }));
  const db = coinDb({ ledger: rows });
  assert.equal(await grantMessageCoins({ GOOBER_DB: db }, USER_ID, NOW), false);
  assert.equal(db.ledger.length, 100);
});

// --- the voice-presence tick -----------------------------------------------------

test("POST /api/coins/voice/tick grants the window's coins for a seated member", async () => {
  const db = coinDb({ voiceSeats: [{ channelId: 44, userId: USER_ID }] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/voice/tick", { method: "POST", body: { channelId: 44 } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.granted, true);
  assert.equal(body.balance, GC_COIN_VOICE_GRANT);

  const tick = db.calls.find(
    (entry) => entry.sql.includes("'voice'") && (entry.call === "run" || entry.call === "first"),
  );
  assert.ok(tick, "the tick minted once");
  assert.match(tick.sql, /vc\.kind = 'voice'/, "the channel must be a voice channel");
  assert.match(tick.sql, /JOIN gc_server_members vm ON vm\.server_id = vc\.server_id/, "membership rides the INSERT");
});

test("a tick at a foreign (or non-voice) channel grants nothing and stays a 200", async () => {
  const db = coinDb({ voiceSeats: [{ channelId: 44, userId: USER_ID }] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/voice/tick", { method: "POST", body: { channelId: 45 } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200, "no oracle: a reached cap and a foreign channel look alike");
  const body = await bodyOf(response);
  assert.equal(body.granted, false);
  assert.equal(body.balance, 0);
  assert.equal(db.ledger.length, 0);
});

test("the voice source's own cap stops the mint without an error response", async () => {
  const rows = [...Array(30).keys()].map(() => ({
    user_id: USER_ID, delta: 5, source: "voice", related_user_id: null, created_at: NOW - 60,
  }));
  const db = coinDb({ ledger: rows, voiceSeats: [{ channelId: 44, userId: USER_ID }] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/voice/tick", { method: "POST", body: { channelId: 44 } });
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.granted, false, "the cap is a routine non-event");
  assert.equal(body.voice.earnedToday, 150);
  assert.equal(db.ledger.length, 30);
});

test("a tick body without a positive channelId is a 400 with no write", async () => {
  const db = coinDb({ voiceSeats: [{ channelId: 44, userId: USER_ID }] });
  const { env } = envWithLimiters(db);
  for (const body of [{ channelId: 0 }, { channelId: "44" }, {}]) {
    const { built } = await authed("/api/coins/voice/tick", { method: "POST", body });
    const response = await dispatch(built, env);
    assert.equal(response.status, 400, "bad body " + JSON.stringify(body));
  }
  assert.equal(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch").length, 0);
});

// --- Goober+: renewal, gift, grace ----------------------------------------------

test("POST /api/plus/renew buys a term in ONE batch: the spend and the fingerprinted upsert", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 600, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST" });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.balance, 600 - GC_PLUS_PRICE, "the spend is one delta row");
  assert.equal(body.price, GC_PLUS_PRICE);
  assert.equal(body.plus.hasPlus, true);
  assert.equal(body.plus.active, true);

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "the purchase is one atomic batch");
  const spend = batch.statements.find((statement) =>
    statement.sql.startsWith("INSERT INTO gc_coin_ledger"));
  // bound: [gifter, -price, source, related, now, recipient, gifter, price]
  assert.equal(spend.bound[0], USER_ID);
  assert.equal(spend.bound[1], -GC_PLUS_PRICE);
  assert.equal(spend.bound[2], "plus_renewal");
  assert.equal(typeof spend.bound[4], "number", "created_at is bound");
  assert.match(spend.sql, /SELECT COALESCE\(SUM\(le\.delta\), 0\) FROM gc_coin_ledger le/, "the sufficient-coins arm rides the INSERT");
  assert.equal(spend.bound[7], GC_PLUS_PRICE, "the balance check compares the price INSIDE the SQL");

  const upsert = batch.statements.find((statement) =>
    statement.sql.startsWith("INSERT INTO gc_plus_state"));
  assert.match(upsert.sql, /ON CONFLICT\(user_id\) DO UPDATE/);
  assert.match(upsert.sql, /MAX\(gc_plus_state\.renews_until, \?\) \+ \?/, "renewal stacks from the CURRENT term end");
  assert.match(upsert.sql, /grace_until = NULL/);
  assert.match(upsert.sql, /COALESCE\(\?, gc_plus_state\.gifted_by\)/, "a self-renewal preserves the gift trail");
  // The term's stored row: renews = now + term, tenure = now, no gifter.
  const stored = db.plusRows.get(USER_ID);
  assert.equal(stored.renews_until, spend.bound[4] + TERM);
  assert.equal(stored.tenure_started_at, spend.bound[4]);
  assert.equal(stored.gifted_by, null);
  // The renewal limiter identity.
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:plus:" + USER_ID)));
});

test("a renewal on an ACTIVE term stacks, keeping tenure and an old gifter", async () => {
  const start = NOW - 3 * 86400;
  const renews = start + 10 * 86400; // still active, 7 days of term left
  const db = coinDb({
    ledger: [{ user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { renews_until: renews, grace_until: null, tenure_started_at: start, gifted_by: TARGET_ID }]],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST" });
  const body = await bodyOf(await dispatch(built, env));
  // The pricing amendment: a target WITH a gc_plus_state row pays the
  // renewal price, never the first-purchase one.
  assert.equal(body.balance, 900 - GC_PLUS_RENEWAL_PRICE);
  assert.equal(body.price, GC_PLUS_RENEWAL_PRICE);
  const stored = db.plusRows.get(USER_ID);
  assert.equal(stored.renews_until, renews + TERM, "stacks from the standing term end");
  assert.equal(stored.tenure_started_at, start, "tenure never moves");
  assert.equal(stored.gifted_by, TARGET_ID, "the gifter trail survives a self-renewal");
});

test("a LAPSED term re-buying restores a fresh term and stamps the grace window lazily", async () => {
  const lapsed = NOW - 86400;
  const db = coinDb({
    ledger: [{ user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { renews_until: lapsed, grace_until: null, tenure_started_at: NOW - 400000, gifted_by: null }]],
  });
  const { env } = envWithLimiters(db);
  // The grace touch runs on the way through the read (plusRowFor).
  const { built: readBuilt } = await authed("/api/coins");
  const read = await bodyOf(await dispatch(readBuilt, env));
  assert.equal(read.plus.active, true, "inside the grace window the member is still active");
  assert.equal(read.plus.inGrace, true, "renews_until is behind now, grace_until is not");
  const touch = db.calls.find(
    (entry) => entry.call === "run" && entry.sql.startsWith("UPDATE gc_plus_state SET grace_until"),
  );
  assert.ok(touch, "grace materialized lazily on the first touch");
  assert.equal(touch.bound[0], GRACE);
  // The re-buy after the window restores: MAX(lapsed-with-grace, now) → now + term.
  const { built } = await authed("/api/plus/renew", { method: "POST" });
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.balance, 900 - GC_PLUS_RENEWAL_PRICE);
  assert.equal(body.price, GC_PLUS_RENEWAL_PRICE);
  const stored = db.plusRows.get(USER_ID);
  assert.equal(stored.renews_until >= NOW + TERM, true);
  assert.equal(stored.tenure_started_at, NOW - 400000, "tenure still never moves");
  assert.equal(stored.grace_until, null, "the restored term clears the grace window");
});

test("POST /api/plus/gift spends the GIFTING member's coins on the recipient's term", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 500, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/plus/gift", { method: "POST", body: { username: "Friend" } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.giftedTo.id, TARGET_ID);
  assert.equal(body.giftedTo.username, "friend");
  assert.equal(body.balance, 0, "exactly the price left");
  assert.equal(body.plus.hasPlus, true, "the response's plus is the RECIPIENT's fresh row");
  assert.equal(body.plus.giftedBy, USER_ID);

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  const spend = batch.statements.find((statement) => statement.sql.startsWith("INSERT INTO gc_coin_ledger"));
  assert.equal(spend.bound[2], "plus_gift");
  assert.equal(spend.bound[3], TARGET_ID, "the gift trail names the recipient");
  assert.equal(spend.bound[0], USER_ID, "the spend row is the GIFTING member's");
  const upsert = batch.statements.find((statement) => statement.sql.startsWith("INSERT INTO gc_plus_state"));
  assert.ok(upsert);
  const stored = db.plusRows.get(TARGET_ID);
  assert.equal(stored.renews_until, spend.bound[4] + TERM);
  assert.equal(stored.gifted_by, USER_ID, "the recipient's row carries the gifter");
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:gift:" + USER_ID)));
});

test("a self-gift is refused before any write", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/gift", { method: "POST", body: { username: "Wempos" } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /renewal/);
  assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
  assert.equal(db.ledger.length, 1);
});

test("a gift to an unknown member is a 404 with no write", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/gift", { method: "POST", body: { username: "nobody_here" } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 404);
  assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
});

// --- the Mini SKU + the tier writes (the 2026-11-17 matrix's two member tiers) ----

test("the Mini's constants: its own price pair (PROPOSED half), full plus's term/grace shape", () => {
  assert.equal(GC_MINI_PRICE, 250);
  assert.equal(GC_MINI_RENEWAL_PRICE, 200);
});

test("the shop payload carries the Mini SKU beside the full bundle", async () => {
  const { env } = envWithLimiters(coinDb({}));
  const { built } = await authed("/api/coins/shop");
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.mini.name, "Goober+ Mini");
  assert.equal(body.mini.price, GC_MINI_PRICE);
  assert.equal(body.mini.renewalPrice, GC_MINI_RENEWAL_PRICE);
  assert.equal(body.mini.termDays, GC_PLUS_TERM_DAYS);
  assert.equal(body.mini.graceDays, 7);
  assert.match(body.mini.note, /keeps your term/, "the upgrade carry-forward spelled for the buyer");
  assert.match(body.mini.note, /50 MB/);
  // The full bundle stands untouched beside it.
  assert.equal(body.bundle.price, GC_PLUS_PRICE);
});

test("a Mini purchase writes tier='mini' on the term row it mints, at the MINI price", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 300, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST", body: { tier: "mini" } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.balance, 300 - GC_MINI_PRICE);
  assert.equal(body.price, GC_MINI_PRICE);
  assert.equal(body.plus.tier, "mini", "the payload answers the row's own tier");
  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  const upsert = batch.statements.find((statement) =>
    statement.sql.startsWith("INSERT INTO gc_plus_state"));
  assert.match(upsert.sql, /INSERT INTO gc_plus_state \([^]*tier\)/,
    "the upsert names the tier on both arms");
  assert.match(upsert.sql, /tier = \?/);
  assert.equal(upsert.bound[7], "mini");
  assert.equal(upsert.bound[16], "mini");
  const stored = db.plusRows.get(USER_ID);
  assert.equal(stored.tier, "mini");
  // The tier is the WRITE-side stamp only — the read-side perk predicate is
  // the 0022 resolver's (a Mini term rides GC_MINI_* at the attachment cap
  // and full-plus perk gates stay strict).
});

test("a Mini -> full upgrade carries the SAME row forward: term stacks, tenure holds, tier moves", async () => {
  const start = NOW - 2 * 86400;
  const renews = NOW + TERM / 4; // an active Mini term with a quarter left
  const db = coinDb({
    ledger: [{ user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { renews_until: renews, grace_until: null, tenure_started_at: start, gifted_by: null, tier: "mini" }]],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST" }); // no tier = full
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.price, GC_PLUS_RENEWAL_PRICE, "an existing row pays the renewal price");
  const stored = db.plusRows.get(USER_ID);
  assert.equal(stored.tier, "plus", "the upgrade moved the tier on the row it kept");
  assert.equal(stored.renews_until, renews + TERM, "the term stacked from the standing Mini end");
  assert.equal(stored.tenure_started_at, start, "tenure never re-mints");
});

test("a renewal re-writes its own tier: an active 'plus' row renewed stays 'plus'", async () => {
  const renews = NOW + TERM / 2;
  const db = coinDb({
    ledger: [{ user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { renews_until: renews, grace_until: null, tenure_started_at: NOW - 86400, gifted_by: null, tier: "plus" }]],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST" });
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.plus.tier, "plus");
  assert.equal(db.plusRows.get(USER_ID).tier, "plus");
});

test("a Mini buy against an ACTIVE FULL term is refused 409 with a zero write", async () => {
  // tier null on an active row = the legacy full semantics; the guard reads
  // full exactly so a legacy member can never mis-sell themselves one.
  for (const tier of [null, "plus"]) {
    const db = coinDb({
      ledger: [{ user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 }],
      plus: [[USER_ID, { renews_until: NOW + TERM, grace_until: null, tenure_started_at: NOW - 86400, gifted_by: null, tier }]],
    });
    const { env } = envWithLimiters(db);
    const { built } = await authed("/api/plus/renew", { method: "POST", body: { tier: "mini" } });
    const response = await dispatch(built, env);
    assert.equal(response.status, 409, "tier " + JSON.stringify(tier));
    assert.deepEqual(await bodyOf(response), { error: "You already have full Goober+." });
    assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
    assert.equal(db.ledger.length, 1, "no spend row");
  }
});

test("a LAPSED full row may re-buy Mini (its tiers are off), and the price echoes its row", async () => {
  const db = coinDb({
    ledger: [{ user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { renews_until: NOW - 86400, grace_until: null, tenure_started_at: NOW - 90 * 86400, gifted_by: null, tier: "plus" }]],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST", body: { tier: "mini" } });
  const body = await bodyOf(await dispatch(built, env));
  // A lapsed ROW still pays the renewal price (the standing amendment rule)
  // — lapsed means off, never a new-car deal.
  assert.equal(body.price, GC_MINI_RENEWAL_PRICE);
  assert.equal(body.plus.tier, "mini", "the re-buy restored a fresh MINI term");
  const stored = db.plusRows.get(USER_ID);
  assert.equal(stored.tenure_started_at, NOW - 90 * 86400,
    "an existing row's re-buy never re-mints: the tenure holds");
  assert.equal(stored.renews_until >= NOW + TERM, true);
});

test("a body tier outside the pair is a 400 with no write", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 900, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/renew", { method: "POST", body: { tier: "gold" } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 400);
  assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
});

test("the plus payload's tier rides additive: a legacy row reads null and keeps full semantics", async () => {
  const db = coinDb({
    ledger: [{ user_id: USER_ID, delta: 10, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { renews_until: NOW + TERM, grace_until: null, tenure_started_at: NOW - 86400, gifted_by: null }]],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins");
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.plus.tier, null, "the legacy NULL is the never-downgrade invariant's read");
  assert.equal(body.plus.active, true);
});

test("a gift body without a valid username is a 400", async () => {
  const db = coinDb({ ledger: [] });
  const { env } = envWithLimiters(db);
  for (const body of [{ username: "no" }, { username: "way too long for a name" }, {}, { username: 44 }]) {
    const { built } = await authed("/api/plus/gift", { method: "POST", body });
    const response = await dispatch(built, env);
    assert.equal(response.status, 400, "bad body " + JSON.stringify(body));
  }
});

test("an insufficient balance fails the SPEND inside the SQL: the term never moves", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 499, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/plus/gift", { method: "POST", body: { username: "friend" } });
  const response = await dispatch(built, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "Not enough Goober Coins for that." });
  assert.equal(db.plusRows.has(TARGET_ID), false, "the fingerprinted upsert minted nothing");
  assert.equal(db.ledger.length, 1, "the spend itself was refused");
});

// --- the ledger read -------------------------------------------------------------

test("GET /api/coins/ledger pages the member's own rows newest-first", async () => {
  const many = [...Array(30).keys()].map((index) => ({
    user_id: USER_ID,
    delta: index % 2 === 0 ? 25 : -500,
    source: index % 2 === 0 ? "daily" : "plus_renewal",
    related_user_id: null,
    created_at: NOW - index * 10,
  }));
  const db = coinDb({ ledger: many });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/ledger");
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.ok(Array.isArray(body.entries));
  assert.ok(body.entries.length <= 25);
  assert.ok(typeof body.nextAfter === "number");
  for (const entry of body.entries) {
    assert.equal(typeof entry.delta, "number");
    assert.notEqual(entry.delta, 0, "a zero row can never exist (the schema CHECK");
    assert.equal(typeof entry.source, "string");
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "balance"), false, "no balance rides the read");
  }
});

test("the ledger read validates its cursor and page size", async () => {
  const { env } = envWithLimiters(coinDb({}));
  for (const query of ["?before=abc", "?before=0", "?limit=999", "?limit=0", "?limit=nope"]) {
    const { built } = await authed("/api/coins/ledger" + query);
    const response = await dispatch(built, env);
    assert.equal(response.status, 400, "invalid " + query);
  }
  for (const query of ["", "?limit=100", "?before=123456", "?limit=1&before=4"]) {
    const { built } = await authed("/api/coins/ledger" + query);
    const response = await dispatch(built, env);
    assert.equal(response.status, 200, "valid " + query);
  }
});

test("the ledger read exposes a gift trail read from either side", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: -500, source: "plus_gift", related_user_id: TARGET_ID },
    { user_id: TARGET_ID, delta: 25, source: "daily", related_user_id: null },
  ], users: [
    { id: USER_ID, username: "wempos" },
    { id: TARGET_ID, username: "friend" },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/ledger");
  const body = await bodyOf(await dispatch(built, env));
  const gift = body.entries.find((entry) => entry.source === "plus_gift");
  assert.equal(gift.delta, -500);
  assert.equal(gift.relatedUserId, TARGET_ID);
  assert.equal(gift.relatedUsername, "friend");
});

// --- the owner's decrees: no purchase path, no transfer, no expiry ---------------

test("NO purchase, checkout, or payment route exists in the coin dispatch", async () => {
  const { env } = envWithLimiters(coinDb({}));
  const paths = [
    "/api/coins/purchase", "/api/coins/buy", "/api/coins/checkout", "/api/coins/pay",
    "/api/coins/topup", "/api/coins/subscribe", "/api/plus/purchase", "/api/plus/buy",
    "/api/coins/transfer", "/api/coins/give",
  ];
  for (const path of paths) {
    for (const method of ["POST", "GET"]) {
      const base = method === "GET"
        ? new Request(ORIGIN + path, { method, headers: { Cookie: "" } })
        : new Request(ORIGIN + path, {
          method,
          headers: { "Content-Type": "application/json", Origin: ORIGIN },
          body: JSON.stringify({ amount: 1000 }),
        });
      const response = await dispatch(base, env);
      assert.equal(response.status, 404, method + " " + path + " must not exist");
    }
  }
});

test("the routes' wire surface is exactly the seven economy routes", async () => {
  const { env } = envWithLimiters(coinDb({}));
  const known = [
    ["GET", "/api/coins"],
    ["GET", "/api/coins/shop"],
    ["GET", "/api/coins/ledger"],
    ["POST", "/api/coins/claim"],
    ["POST", "/api/coins/voice/tick"],
    ["POST", "/api/plus/renew"],
    ["POST", "/api/plus/gift"],
  ];
  for (const [method, path] of known) {
    const built = method === "GET"
      ? new Request(ORIGIN + path, { method, headers: {} })
      : new Request(ORIGIN + path, {
        method,
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({}),
      });
    const response = await dispatch(built, env);
    assert.notEqual(
      response.status,
      404,
      method + " " + path + " exists (401 here is the signed-out gate)",
    );
  }
});

test("the shop read carries the bundle, the free-things rider, and no per-item pricing", async () => {
  const { env } = envWithLimiters(coinDb({}));
  const { built } = await authed("/api/coins/shop");
  const body = await bodyOf(await dispatch(built, env));
  assert.equal(body.bundle.name, "Goober+");
  assert.equal(body.bundle.blaxel, true);
  assert.equal(body.bundle.price, GC_PLUS_PRICE);
  assert.equal(body.bundle.termDays, GC_PLUS_TERM_DAYS);
  assert.equal(body.bundle.graceDays, 7);
  assert.match(body.bundle.note, /boosts stay free/i);
  assert.match(body.bundle.note, /upload cap|message length|permission/);
  // ONE bundle: no itemized price list rides the payload.
  assert.ok(!("items" in body.bundle));
});

test("the footer's read and the shop's read are the same balance source", async () => {
  const db = coinDb({ ledger: [
    { user_id: USER_ID, delta: 32, source: "message", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const a = await bodyOf(await dispatch(await (await authed("/api/coins")).built, env));
  const b = await bodyOf(await dispatch(await (await authed("/api/coins/shop")).built, env));
  assert.equal(a.balance, b.balance);
  assert.equal(a.balance, 32);
});
