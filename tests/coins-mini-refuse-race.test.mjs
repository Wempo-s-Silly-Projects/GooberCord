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

// The L2 fold-in's regression row (lock-hunt L2 + backend confirm): the
// Mini-refuse affordance must ride INSIDE the claim's single guarded
// statement — affordance check + debit share ONE WHERE (the coins claim
// idiom). The old shape checked the affordance in JS (a PLUS_READ before
// the batch), so a concurrent FULL-term renewal landing between that read
// and the claim batch could route a stale "lapsed" read into a Mini buy.
//
// This file replays THAT RACE honestly: the fake holds the first spend-run
// at a gate (the stale-read member's claim is IN FLIGHT), the full-term
// rider commits through the same fake while it holds, and the gate release
// lets the mini claim's statement evaluate against the POST-COMMIT truth.
// The fake's reads are LIVE throughout — the staleness is the real
// sequencing, not a fake artifact.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCoinRoutes } from "../api/coins.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import {
  GC_PLUS_RENEWAL_PRICE,
  GC_PLUS_TERM_DAYS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const NOW = nowSeconds();
const TERM = GC_PLUS_TERM_DAYS * 86400;

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

// The stale view both riders read BEFORE the full rider commits: a LAPSED
// full row (its tier is off — a Mini re-buy is allowed, the house rule).
const LAPSED_ROW = {
  renews_until: NOW - 100,
  grace_until: null,
  tenure_started_at: NOW - 90 * 86400,
  gifted_by: null,
  tier: "plus",
};

function raceDb(options = {}) {
  const ledger = (options.ledger || []).map((row) => ({ ...row }));
  const plusRows = new Map(options.plus || []);
  const calls = [];
  const users = options.users || [{ id: USER_ID, username: "wempos" }];

  const balanceOf = (userId) =>
    ledger.filter((row) => row.user_id === userId).reduce((total, row) => total + row.delta, 0);

  // The race's interleave seat: the FIRST spend-run of the suite pauses at
  // a gate until the test releases it (the full rider commits in between).
  let holdCount = options.holdFirstSpend ? 1 : 0;
  let gateResolve = null;
  const releaseRace = () => {
    if (gateResolve) gateResolve();
  };

  const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
  const PLUS_READ_TEST = (sql) =>
    sql.startsWith("SELECT renews_until, grace_until, tenure_started_at, gifted_by");
  const SPEND_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at)") &&
    sql.includes("WHERE EXISTS (SELECT 1 FROM users");
  const UPSERT_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_plus_state") && sql.includes("ON CONFLICT(user_id) DO UPDATE");
  const BALANCE_TEST = (sql) =>
    sql.startsWith("SELECT COALESCE(SUM(le.delta), 0) AS balance");

  const routes = [
    { test: SESSION_TEST, first: async () => SESSION_ROW },
    // LIVE read at all times: the staleness that makes the race is the real
    // sequencing (the mini claim's JS read ran BEFORE the full rider's
    // commit; only the statement runs after it).
    { test: PLUS_READ_TEST, first: async (bound) => plusRows.get(bound[0]) || null },
    {
      test: SPEND_TEST,
      run: async (bound, sql) => {
        const entry = { call: "run", sql, bound, changes: null };
        calls.push(entry);
        if (holdCount > 0) {
          // One-shot: consume the hold and wait for the test's release.
          holdCount -= 1;
          const atGate = new Promise((resolve) => { gateResolve = resolve; });
          await atGate;
        }
        // [gifter, -price, source, related, now, recipient, gifter, price...]
        // The mini statement (GREEN) carries the NOT EXISTS refuse arm —
        // the fake ENCODES it against the LIVE gc_plus_state truth. A mini
        // statement WITHOUT the arm (RED) skips straight to the mint.
        const gifter = Number(bound[0]);
        const affordable = balanceOf(bound[6] ?? bound[8] ?? gifter) >= Number(bound[7] ?? bound[9]);
        const recipientExists = users.some((user) => user.id === Number(bound[5]));
        const miniRefuse = sql.includes("gc_plus_state") && sql.includes("NOT EXISTS")
          ? isFullActive(sql, bound)
          : false;
        if (!recipientExists || !affordable || miniRefuse) {
          entry.changes = 0;
          return { meta: { changes: 0 } };
        }
        ledger.push({
          user_id: gifter, delta: Number(bound[1]), source: bound[2],
          related_user_id: bound[3] ?? null, created_at: Number(bound[4]),
        });
        entry.changes = 1;
        return { meta: { changes: 1 } };
      },
    },
    {
      test: UPSERT_TEST,
      run: (bound, sql) => {
        // [target, insertMaxA, insertMaxB, term, tenure, trail, insertedAt, tier,
        //  fpUser, fpSource, fpDelta, fpNow, fpRelated, updateNow, updateTerm,
        //  updateTrail, updateTier, updatedAt]
        const fingerprint = ledger.some((row) =>
          row.user_id === bound[8] && row.source === bound[9] &&
          row.delta === bound[10] && row.created_at === bound[11] &&
          (row.related_user_id ?? null) === bound[12]);
        if (!fingerprint) {
          calls.push({ call: "run", sql, bound, changes: 0 });
          return { meta: { changes: 0 } };
        }
        const stored = plusRows.get(bound[0]);
        if (stored) {
          plusRows.set(bound[0], {
            renews_until: Math.max(stored.renews_until, bound[13]) + bound[14],
            grace_until: null,
            tenure_started_at: stored.tenure_started_at,
            gifted_by: bound[15] === null ? stored.gifted_by : bound[15],
            tier: bound[16],
            updated_at: bound[17],
          });
        } else {
          plusRows.set(bound[0], {
            renews_until: Math.max(bound[1], bound[2]) + bound[3],
            grace_until: null,
            tenure_started_at: bound[4],
            gifted_by: bound[5],
            tier: bound[7],
            updated_at: bound[6],
          });
        }
        calls.push({ call: "run", sql, bound, changes: 1 });
        return { meta: { changes: 1 } };
      },
    },
    { test: BALANCE_TEST, first: async (bound) => ({ balance: balanceOf(bound[0]) }) },
    { test: () => true, run: () => ({ meta: { changes: 1 } }) },
  ];

  // isFullActive: the live-refusal rule the in-statement arm encodes — an
  // ACTIVE term that reads full (tier 'plus' or legacy NULL, never 'mini')
  // refuses a Mini buy. The arm's binds ride trailing (targetId, now).
  function isFullActive(sql, bound) {
    void sql;
    const stored = plusRows.get(Number(bound[8]));
    if (!stored) return false;
    return Number(stored.renews_until) > Number(bound[9]) &&
      (stored.tier === null || stored.tier === undefined || stored.tier !== "mini");
  }

  const db = {
    calls,
    ledger,
    plusRows,
    releaseRace,
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
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({ call: "batch", statements: statements.map((s) => ({ sql: s.sql, bound: s.bound })) });
      return results;
    },
  };
  return db;
}

function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
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

async function untilSpendInFlight(db) {
  for (let tick = 0; tick < 200; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (db.calls.some((call) =>
      call.call === "run" && call.sql?.includes("INSERT INTO gc_coin_ledger"))) return;
  }
  throw new Error("the held claim never reached its spend run");
}

test("a full-term renewal landing mid-claim refuses the stale Mini buy — the claim arms share ONE WHERE", async () => {
  const db = raceDb({
    holdFirstSpend: true,
    ledger: [{ user_id: USER_ID, delta: 920, source: "daily", related_user_id: null, created_at: NOW - 60 }],
    plus: [[USER_ID, { ...LAPSED_ROW }]],
  });

  // Rider A (the MIS-SALE candidate): a Mini buy whose affordance read ran
  // while the target was lapsed — its claim is now IN FLIGHT, held at the
  // spend run's gate.
  const staleMiniPromise = dispatch(
    authed("POST", "/api/plus/renew", { tier: "mini" }), envWithLimiters(db),
  );
  await untilSpendInFlight(db);

  // Rider B (the WINNER): a FULL-term renewal that commits while A's claim
  // is in flight — the lapsed row becomes an ACTIVE full term.
  const fullRenewResponse = await dispatch(
    authed("POST", "/api/plus/renew", {}), envWithLimiters(db),
  );
  const fullRenewBody = await bodyOf(fullRenewResponse);
  assert.equal(fullRenewResponse.status, 200, "the full rider's claim wins the race");
  assert.equal(fullRenewBody.price, GC_PLUS_RENEWAL_PRICE);
  const winnerRow = db.plusRows.get(USER_ID);
  assert.equal(winnerRow.tier, "plus");
  assert.ok(winnerRow.renews_until >= NOW + TERM, "B's term landed on the row");
  assert.equal(
    db.ledger.filter((row) => row.source === "plus_renewal" && row.delta < 0).length, 1,
    "exactly one winning spend row: B's");

  // The gate releases: A's claim evaluates against the POST-COMMIT truth —
  // the in-statement arm (affordance + debit share ONE WHERE) refuses it.
  db.releaseRace();
  const staleMiniResponse = await staleMiniPromise;
  assert.equal(staleMiniResponse.status, 409,
    "the lost race answers the mis-sale refusal, never a silent 200 Mini buy");
  assert.deepEqual(await bodyOf(staleMiniResponse), { error: "You already have full Goober+." });

  // NO PARTIAL PAYOUT: the losing claim moved NOTHING — no second spend row,
  // no term churn on the winner's row.
  assert.equal(
    db.ledger.filter((row) => row.source === "plus_renewal" && row.delta < 0).length, 1,
    "the losing claim minted no spend row");
  const afterRow = db.plusRows.get(USER_ID);
  assert.equal(afterRow.tier, "plus", "the losing claim never touched the tier");
  assert.equal(afterRow.renews_until, winnerRow.renews_until,
    "the losing claim never moved the term");

  // ALL-ZERO: every run statement of the losing batch answered changes 0.
  const spendRuns = db.calls.filter((call) =>
    call.call === "run" && call.sql?.startsWith("INSERT INTO gc_coin_ledger"));
  const upsertRuns = db.calls.filter((call) =>
    call.call === "run" && call.sql?.startsWith("INSERT INTO gc_plus_state"));
  assert.equal(upsertRuns[upsertRuns.length - 1]?.changes, 0,
    "the losing upsert's fingerprint found nothing to mint on");

  // THE FOLD, pinned on the statement: the Mini claim's spend carries the
  // refuse arm INSIDE its WHERE (the coins claim idiom — affordance + debit
  // share one statement).
  const miniSpend = spendRuns.find((call) => call.sql.includes("gc_plus_state"));
  assert.ok(miniSpend, "the Mini claim's spend statement exists");
  assert.ok(
    miniSpend.sql.includes("NOT EXISTS (SELECT 1 FROM gc_plus_state") &&
    miniSpend.sql.includes("ps.renews_until > ?") &&
    (miniSpend.sql.includes("(ps.tier IS NULL OR ps.tier <> 'mini')") ||
      miniSpend.sql.includes("(ps.tier IS NULL OR ps.tier != 'mini')")),
    "the refuse arm rides INSIDE the claim's single guarded statement");
  assert.equal(miniSpend.changes, 0,
    "the held claim answered all-zero");
});
