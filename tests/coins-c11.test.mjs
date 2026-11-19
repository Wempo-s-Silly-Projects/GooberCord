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

// The go-haywire-c11 coins pins, on REAL SQLite (node:sqlite) where the D1
// batch semantics are load-bearing: statements run sequentially and COMMIT
// on non-error — a zero-changes statement does NOT abort a batch. That is
// the whole finding: a legacy cosmetic re-buy (banner/flair/pack) used to
// drain the coin on its refused 409, because the spend carried only the
// balance arm while the ownership INSERT's NOT EXISTS yielded changes=0
// silently. The pins ride the route end-to-end (the same batch executor
// shape D1 answers), not a fakeDb, so a spend that loses an arm cannot
// pretend it applied.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { handleCoinRoutes } from "../api/coins.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const NOW = nowSeconds();
const SESSION_TOKEN = "A".repeat(40);
const CSRF = "B".repeat(24);

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_DDL = readFileSync(
  path.join(TESTS_DIR, "..", "migrations", "0056_gc_cosmetic_inventory.sql"),
  "utf8",
);

// The minimal real schema the route's own statements walk (FKs enforcing,
// per the D1 law); 0056 rides as written. gc_plus_state stays EMPTY unless
// the seed asks for an active term (the pack's plus gate).
async function coinDb({ ledger = 0, ownership = [], inventory = [], plus = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, bio TEXT,
      avatar_status TEXT, avatar_mime TEXT, avatar_updated_at INTEGER, avatar_version INTEGER,
      totp_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER,
      csrf_token TEXT, expires_at INTEGER);
    CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER,
      grace_until INTEGER, tenure_started_at INTEGER, gifted_by INTEGER, updated_at INTEGER);
    CREATE TABLE gc_coin_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL CHECK(delta <> 0), source TEXT, related_user_id INTEGER,
      created_at INTEGER, spend_nonce TEXT);
    CREATE TABLE gc_cosmetic_ownership (user_id INTEGER, item TEXT,
      purchased_at INTEGER, PRIMARY KEY (user_id, item));
    CREATE TABLE gc_server_members (server_id INTEGER, user_id INTEGER);
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY, created_at INTEGER);
    INSERT INTO gc_servers (id, created_at) VALUES (5, 900);
    INSERT INTO users (id, username, role, totp_enabled) VALUES (7, 'wempos', 'member', 0);
  `);
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
    .run(await sha256Hex(SESSION_TOKEN), USER_ID, CSRF, NOW + 3600);
  if (ledger > 0) {
    db.prepare("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, ?, ?)")
      .run(USER_ID, ledger, "daily", NOW - 60);
  }
  if (plus) {
    db.prepare(
      "INSERT INTO gc_plus_state (user_id, renews_until, tenure_started_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(USER_ID, NOW + 3600, NOW - 90000, NOW - 90000);
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(INVENTORY_DDL);
  for (const item of ownership) {
    db.prepare("INSERT INTO gc_cosmetic_ownership (user_id, item, purchased_at) VALUES (?, ?, ?)")
      .run(USER_ID, item, NOW - 60);
  }
  for (const row of inventory) {
    db.prepare(
      "INSERT INTO gc_cosmetic_inventory (user_id, item_key, kind, qty, equipped, server_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(USER_ID, row.itemKey, row.kind, row.qty, 0, row.serverId ?? null, NOW - 60, NOW - 60);
  }
  return db;
}

// The D1-shaped executor over the real SQLite connection: statements run
// sequentially and the batch COMMITS unless a statement throws — the exact
// semantics the c11 finding rides (zero-changes commits).
function coinEnv(db) {
  const env = { GOOBER_DB: d1From(db) };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function d1From(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let params = [];
      const bound = {
        bind(...values) {
          params = values;
          return bound;
        },
        async first() {
          const row = stmt.get(...params);
          return row === undefined ? null : row;
        },
        async all() {
          return { results: stmt.all(...params) };
        },
        async run() {
          const info = stmt.run(...params);
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
      };
      return bound;
    },
    async batch(statements) {
      const results = [];
      db.exec("BEGIN");
      try {
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return results;
    },
  };
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

function buy(item) {
  return new Request(ORIGIN + "/api/coins/cosmetics", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": CSRF,
    },
    body: JSON.stringify({ item }),
  });
}

const balanceOf = (db) =>
  db.prepare("SELECT COALESCE(SUM(delta), 0) AS b FROM gc_coin_ledger WHERE user_id = ?")
    .get(USER_ID).b;
const ledgerCount = (db) =>
  db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger WHERE user_id = ?").get(USER_ID).n;
const ownedItems = (db) =>
  db.prepare("SELECT item FROM gc_cosmetic_ownership WHERE user_id = ? ORDER BY item")
    .all(USER_ID).map((row) => row.item);
const invQty = (db, itemKey) =>
  Number(db.prepare("SELECT qty FROM gc_cosmetic_inventory WHERE user_id = ? AND item_key = ?")
    .get(USER_ID, itemKey)?.qty ?? 0);

test("a legacy re-buy of an owned banner is the 409 own-verdict with balance and ledger untouched", async () => {
  const db = await coinDb({ ledger: 600 });
  const env = coinEnv(db);

  // Legacy FIRST-buy still works: the spend + the ownership row both apply.
  const bought = await dispatch(buy("banner"), env);
  assert.equal(bought.status, 200, "the first buy lands");
  assert.equal(balanceOf(db), 500, "the first buy drains exactly the price");
  assert.deepEqual(ownedItems(db), ["banner"]);
  const rowsAfterBuy = ledgerCount(db);
  assert.equal(rowsAfterBuy, 2, "one spend row lands beside the seeded balance row (the fingerprint)");

  // The re-buy: the 409 own-verdict — and NOTHING else moves. Real D1
  // commits zero-changes statements, so the refuse-minted-drain version of
  // this route fails BOTH the balance pin and the ledger-row pin here.
  const refused = await dispatch(buy("banner"), env);
  assert.equal(refused.status, 409);
  assert.deepEqual(await bodyOf(refused), { error: "You already own that cosmetic." });
  assert.equal(balanceOf(db), 500, "a refused re-buy never drains the coin");
  assert.equal(ledgerCount(db), rowsAfterBuy, "a refused re-buy never persists a spend row");
  assert.deepEqual(ownedItems(db), ["banner", "flair"].slice(0, 1));
});

test("a re-bought Goober+ pack is the 409 with no second drain (one batch, two ownership rows)", async () => {
  const db = await coinDb({ ledger: 600, plus: true });
  const env = coinEnv(db);

  const bought = await dispatch(buy("pack"), env);
  assert.equal(bought.status, 200);
  assert.equal(balanceOf(db), 350, "the pack is its flat 250, never discounted");
  assert.deepEqual(ownedItems(db).sort(), ["banner", "flair"]);
  const rowsAfterBuy = ledgerCount(db);
  assert.equal(rowsAfterBuy, 2, "one pack spend row carries BOTH ownership inserts");

  const refused = await dispatch(buy("pack"), env);
  assert.equal(refused.status, 409);
  assert.deepEqual(await bodyOf(refused), { error: "You already own that cosmetic." });
  assert.equal(balanceOf(db), 350, "the refused pack re-buy never drains");
  assert.equal(ledgerCount(db), rowsAfterBuy);
  assert.deepEqual(ownedItems(db).sort(), ["banner", "flair"]);
});

test("consuming an 'own' SKU is the consumable-only 400, never the empty-pack mislabel", async () => {
  const db = await coinDb({
    ledger: 600,
    inventory: [{ itemKey: "frame_gold", kind: "own", qty: 1 }],
  });
  const env = coinEnv(db);
  const request = new Request(ORIGIN + "/api/coins/cosmetics/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": CSRF,
    },
    body: JSON.stringify({ itemKey: "frame_gold" }),
  });
  const response = await dispatch(request, env);
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That cosmetic is not a consumable pack." });
  assert.equal(invQty(db, "frame_gold"), 1, "the own row never decrement");
});

test("consuming a stocked consumable still decrements ONE use (the claim law intact)", async () => {
  const db = await coinDb({
    ledger: 600,
    inventory: [{ itemKey: "fx_burst_confetti", kind: "consumable", qty: 2 }],
  });
  const env = coinEnv(db);
  const request = new Request(ORIGIN + "/api/coins/cosmetics/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": CSRF,
    },
    body: JSON.stringify({ itemKey: "fx_burst_confetti" }),
  });
  const response = await dispatch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { used: true, inventory:
    [{ itemKey: "fx_burst_confetti", kind: "consumable", qty: 1, equipped: false, serverId: null }] });
  assert.equal(invQty(db, "fx_burst_confetti"), 1);
  assert.equal(balanceOf(db), 600, "a use never touches the coin");
  assert.equal(ledgerCount(db), 1, "a use never writes the ledger");
});
