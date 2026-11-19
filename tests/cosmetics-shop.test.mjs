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

// The cosmetic inventory's shop backend (0056 + the 2026-11-19 cosmetics v1
// slate): the recurring coin-sink SKUs ride the SAME claim idiom as the v1
// shop — one atomic batch, the ledger spend guarded by the sufficient-coins
// arm, the inventory row double-guarded by the ledger fingerprint (the
// NOT-EXISTS-ownership arm is the 409, never a second row), the plus
// discount computed ROUTE-SIDE. Equips are one batch (clear the slot's
// siblings, then set the picked row); consumable uses are one guarded
// UPDATE — a lost race is all-zero + 409 with the original row surviving
// (economy-skill law 3).
//
// Same fakeDb + pinned-SQL contract style as tests/coins-module.test.mjs:
// every write's guard rides INSIDE the SQL and the fake's handlers ENCODE
// that guard, so a pinned statement that loses an arm fails the tests.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCoinRoutes } from "../api/coins.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import {
  GC_COSMETIC_CHANNEL_BANNER_PRICE,
  GC_COSMETIC_FRAME_PRICE,
  GC_COSMETIC_FX_BURST_PRICE,
  GC_COSMETIC_FX_BURST_USES,
  GC_COSMETIC_INVENTORY_SKUS,
  GC_PLUS_SINK_DISCOUNT_PERCENT,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const NOW = nowSeconds();

// --- shared scaffolding (same conventions as the coins module) -----------------

function request(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(body === undefined ? {} : undefined),
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

// --- the stateful fake ----------------------------------------------------------

// ledger = real delta rows (balance IS the SUM); inventory = the 0056 rows
// keyed by (user, item_key); seats = the gc_server_members pairs.
function shopDb(options = {}) {
  const ledger = (options.ledger || []).map((row) => ({ ...row }));
  const inventory = new Map(); // "userId:itemKey" -> row
  for (const row of options.inventory || []) {
    inventory.set(row.user_id + ":" + row.item_key, { ...row });
  }
  const ownership = new Map(options.ownership || []); // userId -> ["banner", ...]
  const seats = new Set((options.seats || []).map((pair) => pair.join(":")));
  const plusUntil = options.plusUntil || null;
  const calls = [];

  const balanceOf = (userId) =>
    ledger.filter((row) => row.user_id === userId).reduce((total, row) => total + row.delta, 0);
  const invRow = (userId, itemKey) => inventory.get(userId + ":" + itemKey) || null;

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      test: (sql) => sql.includes("'rollup'"),
      run: () => ({ meta: { changes: 0 } }),
    },
    {
      test: (sql) => sql.startsWith("SELECT COALESCE(SUM(le.delta), 0) AS balance"),
      first: async (bound) => ({ balance: balanceOf(bound[0]) }),
    },
    {
      test: (sql) => sql.includes("AS earned") && sql.includes("AS daily"),
      first: async () => ({ earned: 0, daily: 0, message: 0, voice: 0 }),
    },
    {
      // the DISPLAY read (publicPlus) — distinct from the strict perk read.
      test: (sql) => sql.startsWith("SELECT renews_until, grace_until, tenure_started_at"),
      first: async () => plusUntil === null ? null : {
        renews_until: plusUntil, grace_until: null,
        tenure_started_at: NOW - 90000, gifted_by: null, tier: "plus",
      },
    },
    {
      test: (sql) => sql.startsWith("SELECT renews_until FROM gc_plus_state"),
      first: async () => plusUntil === null ? null : { renews_until: plusUntil },
    },
    {
      test: (sql) => sql.startsWith("UPDATE gc_plus_state SET grace_until"),
      run: () => ({ meta: { changes: 0 } }),
    },
    {
      test: (sql) => sql.startsWith("SELECT item FROM gc_cosmetic_ownership"),
      all: async (bound) => ({
        results: (ownership.get(bound[0]) || []).map((item) => ({ item })),
      }),
    },
    {
      // the inventory read (the shop payload's inventory arm).
      test: (sql) => sql.startsWith("SELECT item_key, kind, qty, equipped, server_id"),
      all: async (bound) => ({
        results: [...inventory.values()]
          .filter((row) => row.user_id === bound[0])
          .sort((a, b) => a.item_key.localeCompare(b.item_key)),
      }),
    },
    {
      // The INVENTORY spend is the GUARDED CLAIM: [user, -cost, source, now,
      // nonce, user, cost, user, itemKey, serverId, serverId, user] — its
      // arms are the balance, the NOT-EXISTS-ownership, and the server-
      // membership arm (NULLable serverId), all INSIDE the INSERT. The fake
      // encodes them so a pinned spend that loses an arm fails the tests.
      test: (sql) =>
        sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce)") &&
        sql.includes("gc_cosmetic_inventory"),
      run: (bound) => {
        if (balanceOf(bound[5]) < bound[6]) return { meta: { changes: 0 } };
        const itemKey = bound[8];
        const serverId = bound[9] ?? null;
        if (invRow(bound[7], itemKey) !== null) return { meta: { changes: 0 } };
        if (serverId !== null && !seats.has(serverId + ":" + bound[11])) {
          return { meta: { changes: 0 } };
        }
        ledger.push({
          user_id: bound[0], delta: bound[1], source: bound[2],
          related_user_id: null, spend_nonce: bound[4], created_at: bound[3],
        });
        return { meta: { changes: 1, last_row_id: 9000 + ledger.length } };
      },
    },
    {
      // the v1 cosmetic spend: [user, -price, source, now, nonce, user, price]
      // — the sufficient-coins arm rides INSIDE the INSERT, the fake encodes
      // it, and the nonce (0058) rides into the row.
      test: (sql) =>
        sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce)") &&
        sql.includes(">= ? LIMIT 1"),
      run: (bound) => {
        if (balanceOf(bound[5]) < bound[6]) return { meta: { changes: 0 } };
        ledger.push({
          user_id: bound[0], delta: bound[1], source: bound[2],
          related_user_id: null, spend_nonce: bound[4], created_at: bound[3],
        });
        return { meta: { changes: 1, last_row_id: 9000 + ledger.length } };
      },
    },
    {
      // the 'own' purchase insert: [user, item, serverId, created, updated,
      //  fpUser, fpSource, fpDelta, fpCreated, fpNonce, neUser, neItem]
      test: (sql) => sql.startsWith("INSERT INTO gc_cosmetic_inventory") && sql.includes("NOT EXISTS"),
      run: (bound) => {
        const [userId, itemKey, serverId, createdAt, updatedAt,
          fpUser, fpSource, fpDelta, fpCreated, fpNonce, neUser, itemKeyAgain] = bound;
        void updatedAt;
        const fingerprint = ledger.some((row) =>
          row.user_id === fpUser && row.source === fpSource &&
          row.delta === fpDelta && row.created_at === fpCreated &&
          row.spend_nonce === fpNonce);
        if (!fingerprint || invRow(neUser, itemKeyAgain) !== null) {
          return { meta: { changes: 0 } };
        }
        inventory.set(neUser + ":" + itemKeyAgain, {
          user_id: neUser, item_key: itemKeyAgain, kind: "own", qty: 1,
          equipped: 0, server_id: serverId ?? null,
          created_at: createdAt, updated_at: createdAt,
        });
        return { meta: { changes: 1 } };
      },
    },
    {
      // the consumable bump: [user, item, uses, created, updated,
      //  fpUser, fpSource, fpDelta, fpCreated, fpNonce, bumpUses, updatedAgain]
      test: (sql) => sql.startsWith("INSERT INTO gc_cosmetic_inventory") && sql.includes("ON CONFLICT"),
      run: (bound) => {
        const [userId, itemKey, uses, createdAt, updatedAt,
          fpUser, fpSource, fpDelta, fpCreated, fpNonce, bumpUses, updatedAtAgain] = bound;
        void updatedAt;
        const fingerprint = ledger.some((row) =>
          row.user_id === fpUser && row.source === fpSource &&
          row.delta === fpDelta && row.created_at === fpCreated &&
          row.spend_nonce === fpNonce);
        if (!fingerprint) return { meta: { changes: 0 } };
        const stored = invRow(fpUser, itemKey);
        if (stored === null) {
          inventory.set(userId + ":" + itemKey, {
            user_id: userId, item_key: itemKey, kind: "consumable", qty: uses,
            equipped: 0, server_id: null, created_at: createdAt, updated_at: createdAt,
          });
        } else {
          const bumped = { ...stored, qty: stored.qty + bumpUses, updated_at: updatedAtAgain };
          inventory.set(userId + ":" + itemKey, bumped); // immutable update
        }
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("SELECT 1 FROM gc_server_members"),
      first: async (bound) => seats.has(bound[0] + ":" + bound[1]) ? { "1": 1 } : null,
    },
    {
      // the unequip arm: [now, userId, itemKey] — the equipped = 1 arm IS the
      // verdict; an unowned or already-unequipped row is changes = 0/404.
      test: (sql) =>
        sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 0") &&
        sql.includes("AND equipped = 1"),
      run: (bound) => {
        const [now, userId, itemKey] = bound;
        const stored = invRow(userId, itemKey);
        if (stored === null || stored.equipped !== 1) return { meta: { changes: 0 } };
        inventory.set(userId + ":" + itemKey, { ...stored, equipped: 0, updated_at: now });
        return { meta: { changes: 1 } };
      },
    },
    {
      // the equip clear: [now, userId, ...slotSkus]
      test: (sql) => sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 0"),
      run: (bound) => {
        const [now, userId, ...skus] = bound;
        let changes = 0;
        for (const [key, row] of [...inventory.entries()]) {
          if (row.user_id === userId && skus.includes(row.item_key) && row.equipped === 1) {
            inventory.set(key, { ...row, equipped: 0, updated_at: now });
            changes += 1;
          }
        }
        return { meta: { changes } };
      },
    },
    {
      // The ownership pre-check (the equip arm's read-before-batch): the qty
      // rides beside the existence — the empty-pack guard spends the same row.
      test: (sql) => sql.startsWith("SELECT qty FROM gc_cosmetic_inventory"),
      first: async (bound) => {
        const row = invRow(bound[0], bound[1]);
        return row === null ? null : { qty: row.qty };
      },
    },
    {
      // the equip set: [now, userId, itemKey]
      test: (sql) => sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 1"),
      run: (bound) => {
        const [now, userId, itemKey] = bound;
        const stored = invRow(userId, itemKey);
        if (stored === null) return { meta: { changes: 0 } };
        inventory.set(userId + ":" + itemKey, { ...stored, equipped: 1, updated_at: now });
        return { meta: { changes: 1 } };
      },
    },
    {
      // the consumable use: [now, userId, itemKey] — the qty > 0 arm is the
      // whole guarded-claim; a loser is changes = 0 and the row survives.
      test: (sql) => sql.startsWith("UPDATE gc_cosmetic_inventory SET qty = qty - 1"),
      run: (bound) => {
        const [now, userId, itemKey] = bound;
        const stored = invRow(userId, itemKey);
        if (stored === null || stored.kind !== "consumable" || stored.qty < 1) {
          return { meta: { changes: 0 } };
        }
        inventory.set(userId + ":" + itemKey, { ...stored, qty: stored.qty - 1, updated_at: now });
        return { meta: { changes: 1 } };
      },
    },
  ];

  const db = {
    calls,
    ledger,
    inventory,
    balanceOf,
    invRow,
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
        if (!route || !route.run) return { meta: { changes: 1, last_row_id: 9001 } };
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

function envWithLimiters(db) {
  const limitCalls = [];
  const env = { GOOBER_DB: db };
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
  return {
    built: new Request(ORIGIN + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "goober_session=" + SESSION_TOKEN,
        "X-CSRF-Token": SESSION_ROW.csrf_token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

const SEED_FUNDS = {
  ledger: [
    { user_id: USER_ID, delta: 600, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ],
};

// --- the SKU constants (the owner-visible shop math) -----------------------------

test("the v1 SKU constants: the recurring sink pairs, the SKU list, the 5-use pack", () => {
  assert.equal(GC_COSMETIC_FX_BURST_PRICE, 50);
  assert.equal(GC_COSMETIC_FRAME_PRICE, 100);
  assert.equal(GC_COSMETIC_CHANNEL_BANNER_PRICE, 150);
  assert.equal(GC_COSMETIC_FX_BURST_USES, 5);
  assert.equal(GC_PLUS_SINK_DISCOUNT_PERCENT, 50);
  assert.deepEqual(GC_COSMETIC_INVENTORY_SKUS, [
    { itemKey: "fx_burst_confetti", kind: "consumable" },
    { itemKey: "frame_gold", kind: "own" },
    { itemKey: "frame_neon", kind: "own" },
    { itemKey: "channel_banner_dusk", kind: "own" },
  ]);
});

// --- the shop payload ------------------------------------------------------------

test("the shop payload carries the four inventory SKUs beside the v1 items", async () => {
  const db = shopDb({});
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/shop");
  const body = await bodyOf(await dispatch(built, env));
  const skus = Object.fromEntries(body.items.map((item) => [item.item, item]));
  for (const sku of ["fx_burst_confetti", "frame_gold", "frame_neon", "channel_banner_dusk"]) {
    assert.ok(skus[sku], "the payload answers " + sku);
    assert.equal(skus[sku].owned, false);
    assert.ok(typeof skus[sku].kind === "string");
  }
  assert.equal(skus.fx_burst_confetti.price, 50);
  assert.equal(skus.fx_burst_confetti.plusPrice, 25);
  assert.equal(skus.frame_gold.price, 100);
  assert.equal(skus.frame_gold.plusPrice, 50);
  assert.equal(skus.frame_neon.price, skus.frame_gold.price);
  assert.equal(skus.channel_banner_dusk.price, 150);
  assert.equal(skus.channel_banner_dusk.plusPrice, 75);
  // The v1 items stand untouched beside them.
  assert.equal(skus.banner.owned, false);
  assert.equal(skus.pack.plusOnly, true);
});

test("the shop payload's inventory read answers the caller's rows with the stored shape", async () => {
  const db = shopDb({
    ...SEED_FUNDS,
    inventory: [
      { user_id: USER_ID, item_key: "frame_gold", kind: "own", qty: 1, equipped: 1, server_id: null },
      { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: 3, equipped: 0, server_id: null },
      { user_id: USER_ID, item_key: "channel_banner_dusk", kind: "own", qty: 1, equipped: 0, server_id: 11 },
    ],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/shop");
  const body = await bodyOf(await dispatch(built, env));
  assert.ok(Array.isArray(body.inventory));
  const byKey = Object.fromEntries(body.inventory.map((row) => [row.itemKey, row]));
  assert.deepEqual(byKey.frame_gold, { itemKey: "frame_gold", kind: "own", qty: 1, equipped: true, serverId: null });
  assert.equal(byKey.fx_burst_confetti.qty, 3);
  assert.equal(byKey.channel_banner_dusk.serverId, 11);
  // Items mirror the inventory's own state.
  const skus = Object.fromEntries(body.items.map((item) => [item.item, item]));
  assert.equal(skus.frame_gold.owned, true);
  assert.equal(skus.frame_gold.equipped, true);
  assert.equal(skus.fx_burst_confetti.owned, true);
  assert.equal(skus.fx_burst_confetti.qty, 3);
});

test("a Plus caller's cost is the route-side discount on every inventory SKU", async () => {
  const db = shopDb({ ...SEED_FUNDS, plusUntil: NOW + 3600 });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/shop");
  const body = await bodyOf(await dispatch(built, env));
  const skus = Object.fromEntries(body.items.map((item) => [item.item, item]));
  assert.equal(skus.fx_burst_confetti.cost, 25);
  assert.equal(skus.frame_gold.cost, 50);
  assert.equal(skus.channel_banner_dusk.cost, 75,
    "the discount is the same percent route-side, math.round-shape like the pack");
  // plusPrice stays the ITEM attribute, not the caller's.
  assert.equal(skus.frame_gold.plusPrice, 50);
});

// --- the purchase route (the claim idiom, extended to the new SKUs) ---------------

test("buying the burst pack is ONE atomic batch: the guarded spend, then the fingerprinted bump", async () => {
  const db = shopDb(SEED_FUNDS);
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const stored = db.invRow(USER_ID, "fx_burst_confetti");
  assert.equal(stored.kind, "consumable");
  assert.equal(stored.qty, GC_COSMETIC_FX_BURST_USES, "one pack = the named use count");
  assert.equal(db.balanceOf(USER_ID), 600 - GC_COSMETIC_FX_BURST_PRICE);

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "the purchase is one atomic batch");
  const spend = batch.statements[0];
  assert.equal(spend.bound[0], USER_ID);
  assert.equal(spend.bound[1], -GC_COSMETIC_FX_BURST_PRICE);
  assert.equal(spend.bound[2], "cosmetic");
  assert.match(spend.sql, /SELECT COALESCE\(SUM\(le4\.delta\), 0\) FROM gc_coin_ledger le4/,
    "the sufficient-coins arm rides inside the INSERT");
  const bump = batch.statements[1];
  assert.match(bump.sql, /INSERT INTO gc_cosmetic_inventory/);
  assert.match(bump.sql, /EXISTS \(SELECT 1 FROM gc_coin_ledger cl/, "the ledger fingerprint arm");
  assert.match(bump.sql, /ON CONFLICT\(user_id, item_key\) DO UPDATE SET qty = qty \+ \?/);
  // The consumable's spend is the balance-guarded claim (a re-buy stacks,
  // so no ownership arm rides it — the bump's ON CONFLICT is the stack).
  assert.equal(spend.sql.includes("gc_cosmetic_inventory"), false);
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:cosmetic:" + USER_ID)));
});

test("re-buying the burst pack stacks the same row: the PK row grows by one pack", async () => {
  const db = shopDb(SEED_FUNDS);
  const { env } = envWithLimiters(db);
  for (const expectedQty of [GC_COSMETIC_FX_BURST_USES, GC_COSMETIC_FX_BURST_USES * 2]) {
    const { built } = await authed("/api/coins/cosmetics", {
      method: "POST", body: { item: "fx_burst_confetti" },
    });
    const response = await dispatch(built, env);
    assert.equal(response.status, 200);
    assert.equal(db.invRow(USER_ID, "fx_burst_confetti").qty, expectedQty);
  }
  assert.equal(db.balanceOf(USER_ID), 600 - GC_COSMETIC_FX_BURST_PRICE * 2,
    "the recurring sink drains BOTH purchases");
});

test("a poor caller's consumable re-buy is the 400/insufficient arm, never the already-own 409", async () => {
  // A stacking pack is never "already owned" — the owned probe skips the
  // consumable kind entirely, so a failed balance arm is what the caller
  // gets, with the standing qty untouched.
  const db = shopDb({
    ledger: [
      { user_id: USER_ID, delta: 49, source: "daily", related_user_id: null, created_at: NOW - 60 },
    ],
    inventory: [
      { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: GC_COSMETIC_FX_BURST_USES, equipped: 0, server_id: null },
    ],
  });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "Not enough Goober Coins for that." });
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").qty, GC_COSMETIC_FX_BURST_USES,
    "the pack never grew and never moved");
});

test("buying a frame lands one 'own' row at qty 1, and a re-buy is the 409 with no spent coin", async () => {
  const db = shopDb(SEED_FUNDS);
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "frame_gold" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const stored = db.invRow(USER_ID, "frame_gold");
  assert.equal(stored.kind, "own");
  assert.equal(stored.qty, 1);
  assert.equal(stored.equipped, 0, "newly owned cosmetics wait unequipped");
  // The OWN purchase's spend is the guarded claim: the ownership + (here,
  // NULL-server) membership arms sit INSIDE the spend INSERT.
  const batch = db.calls.find((entry) => entry.call === "batch");
  const spend = batch.statements[0];
  assert.match(spend.sql, /NOT EXISTS \(SELECT 1 FROM gc_cosmetic_inventory/,
    "a re-buy loses the race inside the SQL");
  assert.match(spend.sql, /\? IS NULL OR EXISTS \(SELECT 1 FROM gc_server_members/,
    "the per-server arm rides the same INSERT");
  const afterBuy = db.ledger.length;

  const { built: again } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "frame_gold" },
  });
  const refused = await dispatch(again, env);
  assert.equal(refused.status, 409);
  assert.deepEqual(await bodyOf(refused), { error: "You already own that cosmetic." });
  assert.equal(db.ledger.length, afterBuy, "the lost race never persists a spend row");
  assert.equal(db.invRow(USER_ID, "frame_gold").qty, 1, "the original row survives");
});

test("a purchase past the balance is the 400 with no row and no spend", async () => {
  const db = shopDb({ ledger: [
    { user_id: USER_ID, delta: 49, source: "daily", related_user_id: null, created_at: NOW - 60 },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "frame_gold" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "Not enough Goober Coins for that." });
  assert.equal(db.invRow(USER_ID, "frame_gold"), null);
  assert.equal(db.ledger.length, 1, "the spend itself was refused");
});

test("a Plus member buys at the route-side discounted price through the same guarded spend", async () => {
  const db = shopDb({ ...SEED_FUNDS, plusUntil: NOW + 3600 });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const batch = db.calls.find((entry) => entry.call === "batch");
  const spend = batch.statements[0];
  assert.equal(spend.bound[1], -25, "50 minus the 50% discount");
  assert.equal(db.balanceOf(USER_ID), 600 - 25);
});

test("the channel-banner SKU is server-scoped: a serverId + membership are demanded", async () => {
  const db = shopDb({ ...SEED_FUNDS, seats: [[11, USER_ID]] });
  const { env } = envWithLimiters(db);
  // Without a serverId the purchase is refused before any write.
  const { built: noServer } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "channel_banner_dusk" },
  });
  assert.equal((await dispatch(noServer, env)).status, 400);
  assert.equal(db.invRow(USER_ID, "channel_banner_dusk"), null);

  // A server the member does not belong to is refused inside the SPEND's
  // membership arm — the coin itself is never drained.
  const { built: foreign } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "channel_banner_dusk", serverId: 12 },
  });
  const foreignResponse = await dispatch(foreign, env);
  assert.equal(foreignResponse.status, 403);
  assert.equal(db.invRow(USER_ID, "channel_banner_dusk"), null);
  assert.equal(db.ledger.length, 1, "the refused purchase left no spend row");
  // The guarded-claim shape: the membership arm sits INSIDE the spend INSERT.
  const bannerBatch = db.calls.find(
    (entry) => entry.call === "batch" && entry.statements[0].sql.includes("gc_server_members"));
  assert.ok(bannerBatch, "the membership arm rides inside the INSERT");
  assert.match(bannerBatch.statements[0].sql,
    /gc_server_members sm WHERE sm\.server_id = \? AND sm\.user_id = \?/);

  // A member of the server lands the per-server row.
  const { built: own } = await authed("/api/coins/cosmetics", {
    method: "POST", body: { item: "channel_banner_dusk", serverId: 11 },
  });
  const ownResponse = await dispatch(own, env);
  assert.equal(ownResponse.status, 200);
  assert.equal(db.invRow(USER_ID, "channel_banner_dusk").server_id, 11);
});

test("a body item outside the catalog is a 400 with no write", async () => {
  const db = shopDb(SEED_FUNDS);
  const { env } = envWithLimiters(db);
  for (const body of [{ item: "fx_nope" }, { item: 44 }, {}]) {
    const { built } = await authed("/api/coins/cosmetics", { method: "POST", body });
    const response = await dispatch(built, env);
    assert.equal(response.status, 400, "bad body " + JSON.stringify(body));
  }
  assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
});

// --- the equip arm (one equipped per slot, route-side, one batch) -----------------

test("equipping is one atomic batch: clear the SLOT's siblings, then set the picked row", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "frame_gold", kind: "own", qty: 1, equipped: 0, server_id: null },
    { user_id: USER_ID, item_key: "frame_neon", kind: "own", qty: 1, equipped: 0, server_id: null },
    { user_id: USER_ID, item_key: "channel_banner_dusk", kind: "own", qty: 1, equipped: 1, server_id: 11 },
  ] });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "frame_gold" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  assert.equal(db.invRow(USER_ID, "frame_gold").equipped, 1);
  assert.equal(db.invRow(USER_ID, "frame_neon").equipped, 0, "the sibling never rode this slot's clear");

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "one batch, one transaction");
  assert.equal(batch.statements.length, 2, "the clear, then the set");
  assert.match(batch.statements[0].sql, /SET equipped = 0/);
  assert.match(batch.statements[1].sql, /SET equipped = 1/);
  // The clear's IN-list is the slot's own SKUs — the banner sibling at 11
  // keeps its equipped=1 outside the frame slot.
  const clearBound = batch.statements[0].bound;
  assert.equal(typeof clearBound[0], "number", "the clear binds updated_at");
  assert.equal(clearBound[1], USER_ID);
  assert.ok(clearBound.includes("frame_gold") && clearBound.includes("frame_neon"),
    "the frame slot's SKUs ride as binds");
  assert.equal(clearBound.includes("channel_banner_dusk"), false,
    "the IN-list never reaches another slot's SKUs");
  assert.equal(db.invRow(USER_ID, "channel_banner_dusk").equipped, 1,
    "cross-slot equipped state is untouched");
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:cosmetic-equip:" + USER_ID)));
});

test("equipping the second frame swaps the slot: the sibling clears in the SAME batch", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "frame_gold", kind: "own", qty: 1, equipped: 1, server_id: null },
    { user_id: USER_ID, item_key: "frame_neon", kind: "own", qty: 1, equipped: 0, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "frame_neon" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  assert.equal(db.invRow(USER_ID, "frame_neon").equipped, 1);
  assert.equal(db.invRow(USER_ID, "frame_gold").equipped, 0, "one equipped per slot");
});

test("equipping an unowned SKU is the buy-first refusal with no write", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "frame_gold", kind: "own", qty: 1, equipped: 1, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "frame_neon" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 403);
  assert.equal(db.invRow(USER_ID, "frame_gold").equipped, 1, "the slot state never moved");
  assert.equal(db.calls.filter((entry) => entry.call === "batch").length, 0);
});

test("an equip body outside the catalog is a 400 with no write", async () => {
  const db = shopDb({});
  const { env } = envWithLimiters(db);
  for (const body of [{ itemKey: "fx_nope" }, {}, { itemKey: 44 }]) {
    const { built } = await authed("/api/coins/cosmetics/equip", { method: "POST", body });
    const response = await dispatch(built, env);
    assert.equal(response.status, 400, "bad body " + JSON.stringify(body));
  }
  assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
});

test("equipping the fx_burst pack rides the ONE batch (the effects slot's equipped arm)", async () => {
  // Phase 3 amendment (the 2026-11-19 slate): the burst arm spends only the
  // EQUIPPED row, so the effects slot's consumable IS the equip surface — the
  // equip stays the same clear-then-set batch. A consumable OUTSIDE that slot
  // would still be refused (no such SKU exists in v1).
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: GC_COSMETIC_FX_BURST_USES, equipped: 0, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").equipped, 1, "the pack is the slot's active effect");
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").qty, GC_COSMETIC_FX_BURST_USES, "the equip never moves qty");
  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "one batch, one transaction");
});

// --- the consumable use (the guarded claim, economy-skill law 3) -------------------

test("using the burst pack decrements ONE use through the guarded UPDATE", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: 2, equipped: 0, server_id: null },
  ] });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/consume", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.used, true);
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").qty, 1);
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:cosmetic-consume:" + USER_ID)));
});

test("the use that loses the race is all-zero + 409 and the ORIGINAL ROW SURVIVES", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: 1, equipped: 0, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/consume", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  assert.equal((await dispatch(built, env)).status, 200);
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").qty, 0);

  const { built: again } = await authed("/api/coins/cosmetics/consume", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  const refused = await dispatch(again, env);
  assert.equal(refused.status, 409, "the empty pack is the same 409 the claim idiom rides");
  assert.deepEqual(await bodyOf(refused), { error: "That pack is empty." },
    "the kind-honest generic copy, pinned once");
  const stored = db.invRow(USER_ID, "fx_burst_confetti");
  assert.equal(stored.qty, 0, "the loser never minted a use");
  assert.ok(stored, "the original row survives (never deleted)");
});

test("using an unowned pack is the buy-first refusal with no write", async () => {
  const db = shopDb({ ...SEED_FUNDS });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/consume", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 403);
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti"), null);
});

test("the consume UPDATE carries its guards INSIDE the SQL", async () => {
  const db = shopDb({ ...SEED_FUNDS });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/consume", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  await dispatch(built, env);
  const use = db.calls.find(
    (entry) => entry.sql.startsWith("UPDATE gc_cosmetic_inventory SET qty = qty - 1"));
  assert.ok(use, "the guarded use did ride the route");
  assert.match(use.sql, /kind = 'consumable'/, "only a consumable row can decrement");
  assert.match(use.sql, /qty > 0/, "the zero pack never decrements");
});

// --- the unequip arm (the UX rider: one verdict-gated row clear) -------------------

test("unequipping is ONE verdict-gated write on the picked row, never a slot clear", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "frame_gold", kind: "own", qty: 1, equipped: 1, server_id: null },
    { user_id: USER_ID, item_key: "frame_neon", kind: "own", qty: 1, equipped: 0, server_id: null },
    { user_id: USER_ID, item_key: "channel_banner_dusk", kind: "own", qty: 1, equipped: 1, server_id: 11 },
  ] });
  const { env, limitCalls } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "frame_gold", unequip: true },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.unequipped, true);
  assert.equal(db.invRow(USER_ID, "frame_gold").equipped, 0);
  assert.equal(db.invRow(USER_ID, "channel_banner_dusk").equipped, 1,
    "the unequip clears ONLY the picked row — no sibling, no slot walk");
  assert.ok(Array.isArray(body.inventory), "the standing inventory echoes back");
  assert.equal(db.calls.filter((entry) => entry.call === "batch").length, 0,
    "no slot-clear batch rides the arm");
  const clear = db.calls.find(
    (entry) => entry.call === "run" && entry.sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 0"));
  assert.ok(clear, "the unequip rode one guarded UPDATE");
  assert.match(clear.sql, /AND equipped = 1/, "the verdict arm sits INSIDE the SQL");
  assert.deepEqual(clear.bound.slice(1), [USER_ID, "frame_gold"],
    "the row IS the whole target — no IN-list");
  assert.equal(body.inventory.every((row) => row.itemKey !== "frame_gold" || row.equipped === false),
    true, "the echo re-reads the cleared row");
  assert.ok(limitCalls.includes(await sha256Hex("write:coins:cosmetic-equip:" + USER_ID)),
    "the arm rides the equip family's write bucket");
});

test("the unequip verdicts: an already-unequipped and an unowned row are the same 404, no echo", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "frame_gold", kind: "own", qty: 1, equipped: 0, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "frame_gold", unequip: true },
  });
  const refused = await dispatch(built, env);
  assert.equal(refused.status, 404, "a row already sitting unequipped loses the verdict");
  assert.deepEqual(await bodyOf(refused), { error: "Cosmetic not found." });

  const { built: unowned } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "frame_neon", unequip: true },
  });
  assert.equal((await dispatch(unowned, env)).status, 404, "a lost row is the same shared 404");
});

test("unequipping a consumable is the kind's refusal shape — the burst pack stays equip-only", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: GC_COSMETIC_FX_BURST_USES, equipped: 1, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "fx_burst_confetti", unequip: true },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That cosmetic is a consumable pack." });
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").equipped, 1,
    "neither the equipped state nor the qty moved");
});

test("the unequip arm still names a catalog SKU: anything else is a 400", async () => {
  const db = shopDb({});
  const { env } = envWithLimiters(db);
  for (const body of [{ itemKey: "fx_nope", unequip: true }, { unequip: true }, { itemKey: 7, unequip: true }]) {
    const { built } = await authed("/api/coins/cosmetics/equip", { method: "POST", body });
    assert.equal((await dispatch(built, env)).status, 400, "bad unequip body " + JSON.stringify(body));
  }
  assert.equal(db.calls.filter((entry) => entry.call === "batch" || entry.call === "run").length, 0);
});

test("equipping an EMPTY pack is the empty-pack 409 before any batch (the low-4 guard)", async () => {
  const db = shopDb({ ...SEED_FUNDS, inventory: [
    { user_id: USER_ID, item_key: "fx_burst_confetti", kind: "consumable", qty: 0, equipped: 0, server_id: null },
  ] });
  const { env } = envWithLimiters(db);
  const { built } = await authed("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey: "fx_burst_confetti" },
  });
  const response = await dispatch(built, env);
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), { error: "That pack is empty." });
  assert.equal(db.invRow(USER_ID, "fx_burst_confetti").equipped, 0, "the inert-wart state never forms");
  assert.equal(db.calls.filter((entry) => entry.call === "batch").length, 0,
    "the refusal is pre-batch — no orphan echo");
});

// --- the wire surface -------------------------------------------------------------

test("the new routes answer on the wire and the forbidden money paths stay 404", async () => {
  const db = shopDb({});
  const { env } = envWithLimiters(db);
  for (const [method, path, body] of [
    ["POST", "/api/coins/cosmetics/equip", {}],
    ["POST", "/api/coins/cosmetics/consume", {}],
  ]) {
    const { built } = await authed(path, { method, body });
    const response = await dispatch(built, env);
    assert.notEqual(response.status, 404, method + " " + path + " exists");
  }
  for (const path of ["/api/coins/cosmetics/purchase", "/api/coins/cosmetics/buy",
    "/api/coins/cosmetics/unequip"]) {
    const base = new Request(ORIGIN + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({}),
    });
    assert.equal((await dispatch(base, env)).status, 404, path + " must not exist");
  }
});
