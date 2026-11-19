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

// Real-SQLite pin for the coin ledger's spend fingerprint (GO-HAYWIRE cycle
// 2, fix 1): the fingerprint matchers keyed on (user, source, delta,
// created_at) collide when two requests land in the SAME wall-clock second,
// so a REFUSED batch's fingerprint consumer echoed the earlier spend row —
// the ownership arm, the inventory bump, and the plus term upsert all minted
// for free while the batch's own spend arm was refused. The fix binds a
// fresh per-request nonce into the ledger spend row (gc_coin_ledger
// .spend_nonce, migration 0058) and every fingerprint consumer matches
// THIS batch's nonce, so a refused batch can never find an earlier row.
//
// Same real-node:sqlite contract as tests/social-sqlite.test.mjs: the
// handler's exact SQL meets SQLite through the D1-shaped adapter, with the
// route's wall clock normalized to ONE fixed second (the shim rewrites the
// ledger INSERTs' created_at bind) so the same-second collision is
// deterministic, never a second-boundary flake.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { handleCoinRoutes } from "../api/coins.mjs";
import { sha256Hex } from "../api/core/crypto.mjs";
import { HttpError } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { statementsOf } from "./migration-scoping.test.mjs";
import {
  GC_COSMETIC_FX_BURST_ITEM,
  GC_COSMETIC_FX_BURST_PRICE,
  GC_COSMETIC_FX_BURST_USES,
  GC_PLUS_TERM_DAYS,
} from "../constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");
const NOW = 1_800_000_000; // the shim's fixed second for EVERY ledger write
const USER_ID = 7;
const SESSION_TOKEN = "A".repeat(40);
const SESSION_COOKIE = "goober_session=" + SESSION_TOKEN;
const TOKEN_HASH = await sha256Hex(SESSION_TOKEN);

// The minimal users/sessions shape the session wall needs (the vendored
// 0002's full forum column set is not what this pin is about). gc_plus_state
// and gc_coin_ledger ride their own migrations below; the tier column rides
// 0022's shape as a plain ALTER here so the pinned reads stay migration-
// independent.
const USERS_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    accent_color TEXT, created_at INTEGER NOT NULL, bio TEXT, avatar_status TEXT,
    avatar_mime TEXT, avatar_updated_at INTEGER, avatar_version INTEGER, totp_enabled INTEGER);
  CREATE TABLE gc_servers (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER, csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

function applyMigration(db, file) {
  for (const statement of statementsOf(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))) {
    db.exec(statement);
  }
}

function seedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(USERS_SQL);
  applyMigration(db, "0011_coin_economy.sql");
  applyMigration(db, "0019_cosmetic_ownership.sql");
  applyMigration(db, "0056_gc_cosmetic_inventory.sql");
  applyMigration(db, "0058_gc_ledger_nonce.sql");
  db.exec("ALTER TABLE gc_plus_state ADD COLUMN tier TEXT NULL");
  db.exec(
    "INSERT INTO users (id, username, role, created_at) VALUES (7, 'wempos', 'member', 1), " +
    "(8, 'friend', 'member', 1)",
  );
  db.exec(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES ('" +
    TOKEN_HASH + "', 7, 'c', 1, 9999999999)",
  );
  const grant = db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (?, ?, 'daily', ?)",
  );
  return { db, grant };
}

// The D1-shaped adapter over node:sqlite, with the ledger-clock shim: any
// bind carrying the CURRENT wall second is rewritten to NOW, so two
// sequential route calls (and every fingerprint arm riding them) are
// deterministically the SAME second — never a second-boundary flake. The
// route's small integers (user ids, coin prices, ceilings) can never equal
// the wall second, so the rewrite only ever touches timestamps.
function coinDb(db) {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      prepared.push(sql);
      const statement = db.prepare(sql);
      let bound = [];
      return {
        bind(...values) {
          const currentSecond = Math.floor(Date.now() / 1000);
          bound = values.map((value) => (value === currentSecond ? NOW : value));
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

function envOf(db) {
  const adapter = coinDb(db);
  const env = { GOOBER_DB: adapter, adapter };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async () => ({ success: true }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  try {
    return await handleCoinRoutes(request, env, url, url.pathname, request.method.toUpperCase());
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return Response.json({ error: error.message }, { status: error.status });
  }
}

const buyRequest = (item) => new Request("http://localhost/api/coins/cosmetics", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://localhost",
    "X-CSRF-Token": "c", Cookie: SESSION_COOKIE },
  body: JSON.stringify({ item }),
});

const renewRequest = () => new Request("http://localhost/api/plus/renew", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://localhost",
    "X-CSRF-Token": "c", Cookie: SESSION_COOKIE },
  body: JSON.stringify({ tier: "plus" }),
});

const cosmeticsLedger = (db) =>
  db.prepare("SELECT user_id, delta, source, created_at, spend_nonce FROM gc_coin_ledger WHERE source = 'cosmetic'")
    .all();
const balanceOf = (db) =>
  db.prepare("SELECT COALESCE(SUM(delta), 0) AS balance FROM gc_coin_ledger WHERE user_id = ?")
    .get(USER_ID).balance;
const plusRow = (db) =>
  db.prepare("SELECT renews_until FROM gc_plus_state WHERE user_id = ?").get(USER_ID);

test("two same-second burst buys: the refused second batch leaves NO ledger echo and NO free bump", async () => {
  const { db, grant } = seedDb();
  grant.run(USER_ID, GC_COSMETIC_FX_BURST_PRICE, NOW - 60);

  const first = await dispatch(buyRequest(GC_COSMETIC_FX_BURST_ITEM), envOf(db));
  assert.equal(first.status, 200, "the affordable first buy lands");
  assert.equal(balanceOf(db), 0, "the first spend drained the balance to zero");

  const second = await dispatch(buyRequest(GC_COSMETIC_FX_BURST_ITEM), envOf(db));
  assert.equal(second.status, 400, "the broke second buy is refused");

  assert.equal(cosmeticsLedger(db).length, 1,
    "the refused batch minted NO second cosmetic spend row");
  const bump = db.prepare(
    "SELECT qty FROM gc_cosmetic_inventory WHERE user_id = 7 AND item_key = ?",
  ).get(GC_COSMETIC_FX_BURST_ITEM).qty;
  assert.equal(bump, GC_COSMETIC_FX_BURST_USES,
    "the bump echoed NO free pack — the fingerprint found only THIS batch's nonce");
});

test("two same-second plus renewals: the refused second batch never extends the term", async () => {
  const { db, grant } = seedDb();
  // A LAPSED existing row keeps the renewal price (a first purchase spends
  // 500; a renewal spends 400 — the collision needs the SAME delta twice).
  db.exec(
    "INSERT INTO gc_plus_state (user_id, renews_until, tenure_started_at, gifted_by, updated_at) " +
    "VALUES (" + USER_ID + ", " + (NOW - 100) + ", " + (NOW - 100) + ", NULL, " + (NOW - 100) + ")",
  );
  grant.run(USER_ID, 400, NOW - 60);

  const first = await dispatch(renewRequest(), envOf(db));
  assert.equal(first.status, 200, "the affordable first renewal lands");

  const termAfterFirst = Number(plusRow(db).renews_until);
  assert.equal(
    Number(plusRow(db).renews_until),
    NOW + GC_PLUS_TERM_DAYS * 86400,
    "the first renewal wrote its fresh term",
  );

  const second = await dispatch(renewRequest(), envOf(db));
  assert.equal(second.status, 400, "the broke second renewal is refused");

  assert.equal(
    Number(plusRow(db).renews_until),
    termAfterFirst,
    "the upsert fingerprint found NOTHING to echo — the term never moved twice",
  );
});

test("every ledger buy rides a fresh nonce, and the fingerprints consume THIS batch's spend", async () => {
  const { db, grant } = seedDb();
  grant.run(USER_ID, 1_000, NOW - 60);
  const env = envOf(db);
  await dispatch(buyRequest(GC_COSMETIC_FX_BURST_ITEM), env);
  await dispatch(buyRequest(GC_COSMETIC_FX_BURST_ITEM), env);
  await dispatch(renewRequest(), env);

  const cosmeticSpends = cosmeticsLedger(db);
  assert.equal(cosmeticSpends.length, 2,
    "both burst buys minted (an affordable re-buy IS the business)");
  const nonces = cosmeticSpends.map((row) => row.spend_nonce);
  for (const nonce of nonces) {
    assert.equal(typeof nonce, "string", "the spend nonce rides the row");
    assert.ok(nonce.length >= 12, "the nonce carries real entropy, not a stub");
  }
  assert.equal(new Set(nonces).size, nonces.length,
    "two same-second spends NEVER share a nonce");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_coin_ledger WHERE source = 'cosmetic' AND spend_nonce IS NULL")
      .get().n,
    0,
    "no cosmetic spend row ever lands nonceless",
  );

  // The pinned fingerprint shapes: every ledger SPEND carries the nonce and
  // every fingerprint consumer (ownership, inventory own + bump, the plus
  // term upsert) matches THIS batch's nonce — no consumer ever reads the
  // legacy created_at-only matcher again.
  const shapes = env.adapter.prepared;
  const matches = (fragments) => shapes.some((sql) => fragments.every((fragment) => sql.includes(fragment)));
  assert.ok(matches(["INSERT INTO gc_coin_ledger", "spend_nonce"]),
    "the purchases' ledger INSERT mints the nonce");
  assert.ok(matches(["INSERT INTO gc_cosmetic_ownership", "cl.spend_nonce = ?"]) ||
            matches(["INSERT INTO gc_cosmetic_inventory", "cl.spend_nonce = ?"]),
    "the cosmetic fingerprint consumers match the nonce");
  assert.ok(matches(["INSERT INTO gc_plus_state", "le.spend_nonce = ?"]),
    "the term upsert's fingerprint matches the nonce");
  assert.ok(matches(["INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at, spend_nonce"]),
    "the plus spend mints the nonce beside its gift trail");
});
