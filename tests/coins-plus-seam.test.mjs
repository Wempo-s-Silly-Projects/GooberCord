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

// T-R25-SPLIT-COINS-2: the Goober+ seam (the second family off
// api/coins.mjs). The plus purchase family rides api/coins-plus.mjs
// verbatim: the spend + term-upsert SQL fragments (PLUS_SPEND_SQL,
// PLUS_TERM_UPSERT_SQL), the gift target read (GIFT_TARGET_READ_SQL), the
// three handlers (renew, purchasePlusTerm, gift), and the two router arms
// (renew/gift — contiguous at the dispatcher's tail, no interior
// interloper). The forward sits at the renew arm's ORIGINAL position; its
// `undefined` fall-through keeps the dispatcher's remaining arms running
// exactly as before. The plus reads + shaping the coins snapshot shares
// (PLUS_READ_SQL/publicPlus) and the fingerprint machinery
// (SPEND_NONCE_BYTES/BALANCE_READ_SQL) stay ONE implementation in
// coins.mjs, imported at CALL time (the circular import stays inert);
// the GC_PLUS_*/GC_MINI_* law constants keep their home in constants.mjs
// (imported by both sides — never a second literal).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleCoinRoutes } from "../api/coins.mjs";
import { handleCoinsPlusRoutes } from "../api/coins-plus.mjs";
import { GC_PLUS_PRICE, GC_PLUS_TERM_DAYS, GC_PLUS_GRACE_DAYS, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/coins-plus.mjs"), "utf8");
const COINS_SOURCE = readFileSync(join(HERE, "../api/coins.mjs"), "utf8");

const ORIGIN = "http://localhost";
const USER_ID = 7;

test("the plus family rides api/coins-plus.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleRenewRoute",
    "purchasePlusTerm",
    "handleGiftRoute",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("async function " + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's own SQL fragments ride with it (no SQL text rewritten
  // anywhere).
  for (const fragment of [
    "PLUS_SPEND_SQL", "PLUS_TERM_UPSERT_SQL", "GIFT_TARGET_READ_SQL",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("const " + fragment), fragment + " moved with its family");
  }
  // The plus reads + fingerprint machinery stay ONE implementation —
  // imported at call time, never copied.
  for (const shared of [
    "PLUS_READ_SQL", "publicPlus", "SPEND_NONCE_BYTES", "BALANCE_READ_SQL",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("\\b" + shared + "\\b"), shared + " imported");
  }
  assert.doesNotMatch(SEAM_SOURCE, /const PLUS_READ_SQL/);
  assert.doesNotMatch(SEAM_SOURCE, /const BALANCE_READ_SQL/);
  assert.doesNotMatch(SEAM_SOURCE, /const SPEND_NONCE_BYTES/);
  // The plus law constants ride constants.mjs (never a second literal).
  for (const lawConstant of ["GC_PLUS_PRICE", "GC_MINI_PRICE", "GC_PLUS_TERM_DAYS"]) {
    assert.ok(SEAM_SOURCE.includes(lawConstant), lawConstant + " imported by the seam");
    assert.doesNotMatch(SEAM_SOURCE, new RegExp("const " + lawConstant));
  }
});

test("coins.mjs delegates the plus — one dispatch, no copied plus handlers", () => {
  for (const handler of ["handleRenewRoute", "purchasePlusTerm", "handleGiftRoute"]) {
    assert.doesNotMatch(COINS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in coins.mjs");
  }
  for (const fragment of [
    "const PLUS_SPEND_SQL", "const PLUS_TERM_UPSERT_SQL", "const GIFT_TARGET_READ_SQL",
  ]) {
    assert.doesNotMatch(COINS_SOURCE, new RegExp(fragment),
      fragment + " must NOT remain defined in coins.mjs");
  }
  // The router's dispatch block is the forward.
  assert.match(COINS_SOURCE, /await handleCoinsPlusRoutes\(/,
    "the dispatcher hands the plus pair to the seam module");
  // The shared reads + shaping stay ONE implementation in coins.mjs (the
  // one-implementation contract — still defined HERE).
  for (const shared of [
    "const PLUS_READ_SQL", "function publicPlus", "const SPEND_NONCE_BYTES",
    "const BALANCE_READ_SQL",
  ]) {
    assert.match(COINS_SOURCE, new RegExp("(export )?" + shared.replace("$", "\\$")),
      shared + " stays in coins.mjs");
  }
});

test("no other family's path overlaps a plus path", () => {
  // The dispatcher's remaining exact arms (/api/coins, /shop, /ledger,
  // /claim, /voice/tick, the cosmetics forward) answer no /api/plus path,
  // and the plus pair's shapes appear in NO sibling module.
  for (const siblingName of ["coins-cosmetics.mjs", "messages-pins.mjs", "server-mod.mjs", "server-body.mjs"]) {
    const sibling = readFileSync(join(HERE, "../api", siblingName), "utf8");
    for (const shape of ["/api/plus/renew", "/api/plus/gift"]) {
      assert.ok(!sibling.includes(shape),
        siblingName + " must not answer a plus path");
    }
  }
  // The seam answers every family arm (nothing rides the fall-through by
  // accident).
  for (const shape of ["/api/plus/renew", "/api/plus/gift"]) {
    assert.ok(SEAM_SOURCE.includes('"' + shape + '"'), "the seam answers " + shape);
  }
  // And the family arms moved out of coins.mjs's dispatcher.
  assert.doesNotMatch(COINS_SOURCE, /path === "\/api\/plus\/renew"/,
    "the plus arms moved to the seam");
});

// --- the smoke (the renew route through handleCoinRoutes) -------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const BALANCE_READ_TEST = (sql) => sql.includes("SELECT COALESCE(SUM(delta), 0) AS balance");

const { randomToken, sha256Hex, nowSeconds } = await import("../api/core/crypto.mjs");
const HttpError = (await import("../api/core/http.mjs")).HttpError;
const json = (await import("../api/core/http.mjs")).json;
const authToken = randomToken();
const csrf = randomToken(24);
const sessionRow = {
  token_hash: await sha256Hex(authToken),
  user_id: USER_ID,
  csrf_token: csrf,
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatchCoins(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleCoinRoutes(request, env, url, url.pathname, request.method.toUpperCase());
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

test("the seam walks the SAME wire through handleCoinRoutes (the first-purchase batch runs)", async () => {
  // The absent-plus read (the first-purchase price path), the TWO-statement
  // purchase batch (spend + fingerprinted term upsert), and the paired
  // balance + plus echo reads — byte-unchanged by the seam.
  const batchCalls = [];
  const firstCalls = [];
  const env = {
    GOOBER_DB: {
      async batch(statements, _binds) {
        batchCalls.push(statements.map((statement) => statement.sql));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.first = async () => {
          firstCalls.push({ sql, bound: statement.bound });
          if (SESSION_READ_TEST(sql)) return sessionRow;
          if (sql.includes("FROM gc_plus_state WHERE user_id = ?")) return null;
          if (BALANCE_READ_TEST(sql)) return { balance: 425 };
          return null;
        };
        statement.run = async () => ({ meta: { changes: 1 } });
        statement.all = async () => ({ results: [] });
        return statement;
      },
    },
  };
  const before = nowSeconds();
  const response = await dispatchCoins(
    new Request(ORIGIN + "/api/plus/renew", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  // First-purchase price: no gc_plus_state row → the price pair's first arm.
  assert.equal(body.price, GC_PLUS_PRICE);
  assert.equal(typeof body.balance, "number");
  assert.equal(body.plus.hasPlus, false);
  assert.equal(body.plus.active, false);
  const batch = batchCalls[0];
  assert.ok(batch, "the purchase rides ONE batch");
  assert.equal(batch.length, 2);
  assert.ok(batch[0].includes("INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at, spend_nonce)"),
    "the spend arm rides byte-unchanged");
  assert.ok(batch[1].includes("INSERT INTO gc_plus_state"),
    "the fingerprinted term upsert rides byte-unchanged");
  assert.ok(batch[1].includes("ON CONFLICT(user_id) DO UPDATE SET"),
    "the upsert's update arm rides byte-unchanged");
  const plusRead = firstCalls.find((call) => call.sql.includes("FROM gc_plus_state WHERE user_id = ?"));
  assert.ok(plusRead, "the target's plus read rides the same pre-check");
  assert.ok(before <= nowSeconds() + 1, "the wire used a live clock");
});
