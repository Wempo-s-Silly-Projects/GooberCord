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

// T-R25-SPLIT-COINS-1: the cosmetics seam (the first family off
// api/coins.mjs). The cosmetic sink + inventory family rides
// api/coins-cosmetics.mjs verbatim: the sink/inventory SQL fragments, the
// three route handlers + the inventory purchase/refusal helpers, and the
// three router arms (buy/equip/consume — contiguous in the dispatch, no
// interior interloper between them). The forward sits at the cosmetics
// arm's ORIGINAL position; its `undefined` fall-through keeps the
// router's remaining arms running exactly as before. The shop-shared
// reads + shaping (OWNERSHIP_READ_SQL/INVENTORY_READ_SQL/
// publicCosmeticItems/publicInventoryRow/inventoryShape/discountedPrice/
// SPEND_NONCE_BYTES) stay ONE implementation in coins.mjs, imported at
// CALL time (the circular import stays inert); the GC_COSMETIC_* law
// constants keep their home in constants.mjs (imported by both sides —
// never a second literal).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleCoinRoutes } from "../api/coins.mjs";
import { handleCosmeticsRoutes } from "../api/coins-cosmetics.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_COSMETIC_INVENTORY_SKUS, GC_COSMETIC_FX_BURST_ITEM, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/coins-cosmetics.mjs"), "utf8");
const COINS_SOURCE = readFileSync(join(HERE, "../api/coins.mjs"), "utf8");

const ORIGIN = "http://localhost";
const USER_ID = 7;

test("the cosmetics family rides api/coins-cosmetics.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleCosmeticBuyRoute",
    "purchaseInventoryCosmetic",
    "inventoryServerId",
    "inventoryPurchaseRefusal",
    "handleCosmeticEquipRoute",
    "handleCosmeticUnequipArm",
    "handleCosmeticConsumeRoute",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("(async function |function )" + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's own SQL fragments ride with it (no SQL text rewritten
  // anywhere).
  for (const fragment of [
    "COSMETIC_LEDGER_SPEND_SQL", "COSMETIC_OWNERSHIP_INSERT_SQL",
    "COSMETIC_LEGACY_SPEND_HEAD_SQL", "INVENTORY_SPEND_SQL",
    "INVENTORY_OWN_SQL", "INVENTORY_BUMP_SQL",
    "INVENTORY_OWNED_PROBE_SQL", "INVENTORY_MEMBERSHIP_SQL",
    "INVENTORY_EQUIP_CLEAR_SQL", "INVENTORY_EQUIP_SET_SQL",
    "INVENTORY_UNEQUIP_SQL", "INVENTORY_CONSUME_SQL",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("const " + fragment), fragment + " moved with its family");
  }
  assert.match(SEAM_SOURCE, /const INVENTORY_UNEQUIP_404 = "Cosmetic not found.";/);
  // The shop-shared reads + shaping stay ONE implementation — imported at
  // call time, never copied.
  for (const shared of [
    "OWNERSHIP_READ_SQL", "INVENTORY_READ_SQL", "publicCosmeticItems",
    "publicInventoryRow", "inventoryShape", "discountedPrice",
    "SPEND_NONCE_BYTES",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("\\b" + shared + "\\b"), shared + " imported");
  }
  assert.doesNotMatch(SEAM_SOURCE, /const INVENTORY_READ_SQL/);
  assert.doesNotMatch(SEAM_SOURCE, /const OWNERSHIP_READ_SQL/);
  assert.doesNotMatch(SEAM_SOURCE, /const SPEND_NONCE_BYTES/);
});

test("coins.mjs delegates the cosmetics — one dispatch, no copied cosmetic handlers", () => {
  for (const handler of [
    "handleCosmeticBuyRoute", "handleCosmeticEquipRoute", "handleCosmeticConsumeRoute",
  ]) {
    assert.doesNotMatch(COINS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in coins.mjs");
  }
  for (const fragment of [
    "const COSMETIC_LEDGER_SPEND_SQL", "const INVENTORY_SPEND_SQL",
    "const INVENTORY_EQUIP_SET_SQL", "const INVENTORY_UNEQUIP_SQL",
    "const INVENTORY_CONSUME_SQL",
  ]) {
    assert.doesNotMatch(COINS_SOURCE, new RegExp(fragment),
      fragment + " must NOT remain defined in coins.mjs");
  }
  // The router's dispatch block is the forward.
  assert.match(COINS_SOURCE, /await handleCosmeticsRoutes\(/,
    "the dispatcher hands the cosmetics to the seam module");
  // The shared reads + shaping stay ONE implementation in coins.mjs (the
  // one-implementation contract — still defined HERE).
  for (const shared of [
    "const OWNERSHIP_READ_SQL", "const INVENTORY_READ_SQL",
    "function publicCosmeticItems", "function publicInventoryRow",
    "function inventoryShape", "const SPEND_NONCE_BYTES",
  ]) {
    assert.match(COINS_SOURCE, new RegExp(shared.replace("$", "\\$")),
      shared + " stays in coins.mjs");
  }
});

test("no other family's path overlaps a cosmetics path", () => {
  // The dispatcher's remaining arms are exact paths (/api/coins, /shop,
  // /ledger, /claim, /voice/tick, /api/plus/*) — none is a prefix of the
  // cosmetics trio, and the trio's /cosmetics + /cosmetics/equip +
  // /cosmetics/consume shapes appear in NO sibling module.
  for (const siblingName of ["messages-pins.mjs", "server-mod.mjs", "server-body.mjs"]) {
    const sibling = readFileSync(join(HERE, "../api", siblingName), "utf8");
    for (const shape of ["/coins/cosmetics", "/cosmetics/equip", "/cosmetics/consume"]) {
      assert.ok(!sibling.includes(shape),
        siblingName + " must not answer a cosmetics path");
    }
  }
  // The seam answers every family arm (nothing rides the fall-through by
  // accident).
  for (const shape of [
    "/api/coins/cosmetics", "/api/coins/cosmetics/equip", "/api/coins/cosmetics/consume",
  ]) {
    assert.ok(SEAM_SOURCE.includes('"' + shape + '"'), "the seam answers " + shape);
  }
  // And the family arms moved out of coins.mjs's dispatcher.
  assert.doesNotMatch(COINS_SOURCE, /path === "\/api\/coins\/cosmetics"/,
    "the cosmetics arms moved to the seam");
});

// --- the smoke (the equip route through handleCoinRoutes) -------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const OWNED_PROBE_TEST = (sql) => sql.includes("SELECT qty FROM gc_cosmetic_inventory");
const INVENTORY_READ_TEST = (sql) => sql.includes("FROM gc_cosmetic_inventory WHERE user_id = ?");

const { randomToken, sha256Hex, nowSeconds } = await import("../api/core/crypto.mjs");
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

test("the seam walks the SAME wire through handleCoinRoutes (the guarded equip batch runs)", async () => {
  // The owned-probe pre-check, the ONE-batch equip (clear the slot's own
  // SKUs + set the picked row), and the inventory echo read — byte-unchanged
  // by the seam.
  const batchCalls = [];
  const allCalls = [];
  const firstCalls = [];
  const env = {
    GOOBER_DB: {
      async batch(statements) {
        batchCalls.push(statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })));
        const results = [];
        for (const statement of statements) results.push(await statement.run(false));
        return results;
      },
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.first = async () => {
          firstCalls.push({ sql, bound: statement.bound });
          if (SESSION_READ_TEST(sql)) return sessionRow;
          if (sql.includes("FROM gc_plus_state")) return null;
          if (OWNED_PROBE_TEST(sql)) return { qty: 3 };
          return null;
        };
        statement.run = async () => ({ meta: { changes: 1 } });
        statement.all = async () => {
          allCalls.push({ sql, bound: statement.bound });
          return {
            results: [{
              item_key: "frame_gold", kind: "own", qty: 1, equipped: 1, server_id: null,
            }],
          };
        };
        return statement;
      },
    },
  };
  const OWN_SKU = GC_COSMETIC_INVENTORY_SKUS.find((sku) => sku.kind === "own");
  const response = await dispatchCoins(
    new Request(ORIGIN + "/api/coins/cosmetics/equip", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ itemKey: OWN_SKU.itemKey }),
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  assert.equal(body.equipped, true);
  assert.equal(body.itemKey, OWN_SKU.itemKey);
  const batch = batchCalls[0];
  assert.ok(batch, "the equip rides ONE batch");
  assert.ok(batch.some((statement) => statement.sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 0")),
    "the slot-clear arm rides the seam module's batch");
  assert.ok(batch.some((statement) =>
    statement.sql === "UPDATE gc_cosmetic_inventory SET equipped = 1, updated_at = ? " +
      "WHERE user_id = ? AND item_key = ?"),
    "the set arm rides byte-unchanged");
  const echo = allCalls.find((call) => INVENTORY_READ_TEST(call.sql));
  assert.ok(echo, "the inventory echo read rides byte-unchanged");
  const probe = firstCalls.find((call) => OWNED_PROBE_TEST(call.sql));
  assert.ok(probe, "the owned probe rides the same pre-check");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleCosmeticsRoutes, "function");
});
