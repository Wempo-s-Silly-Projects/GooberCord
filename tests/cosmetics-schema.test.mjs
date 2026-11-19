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

// Migration 0056 (the cosmetic inventory) scoping pin: ONE additive
// CREATE-only file — the table rides the 0052 discipline (IF NOT EXISTS,
// no shared-table edit, no ALTER, no trigger, no seed), the equip state
// rides its own column instead of an ALTER on gc_cosmetics, and every
// referenced parent (users, gc_servers) is referenced-name-stable so NO
// rename/rebuild dance rides this file. The real-SQLite pin holds the DDL's
// fidelity end-to-end: both CASCADEs fire, the CHECK lists refuse foreign
// SKUs and kinds, and account deletion takes the inventory with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf } from "./migration-scoping.test.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  path.join(TESTS_DIR, "..", "migrations", "0056_gc_cosmetic_inventory.sql"),
  "utf8",
);

function stripped(sql) {
  return sql.replace(/--[^\n]*/g, " ").trim();
}

test("0056 is exactly two statements: the table, then the equipped index", () => {
  const list = statementsOf(SQL);
  assert.equal(list.length, 2, `two statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE IF NOT EXISTS gc_cosmetic_inventory \(/);
  assert.match(
    list[1],
    /^CREATE INDEX IF NOT EXISTS idx_gc_cosmetic_inventory_equipped\s+ON gc_cosmetic_inventory\(user_id, equipped\)/,
  );
});

test("0056 is CREATE-only: no ALTER, DROP, UPDATE, INSERT, DELETE, or trigger", () => {
  const body = stripped(SQL).toUpperCase();
  for (const banned of ["ALTER TABLE", "DROP", "UPDATE ", "INSERT INTO", "DELETE FROM", "TRIGGER", "PRAGMA"]) {
    assert.equal(body.includes(banned), false, `banned statement form: ${banned}`);
  }
});

test("0056 carries the 17-line-plus-blank AGPLv3 header", () => {
  const lines = SQL.split("\n");
  assert.match(lines[0], /^-- Copyright 2026 /);
  assert.equal(lines[16].startsWith("--"), true, "line 17 ends the license block");
  assert.equal(lines[17].trim(), "", "line 18 is the blank separator line");
  assert.match(SQL, /GNU Affero General Public License/);
});

test("the table shape: composite PK, defaults, and the four CHECK lists", () => {
  const body = stripped(SQL);
  assert.match(
    body,
    /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    "the account-deletion CASCADE is the FK law (capsule family discipline)",
  );
  assert.match(
    body,
    /item_key TEXT NOT NULL CHECK \(item_key IN \('fx_burst_confetti', 'frame_gold', 'frame_neon', 'channel_banner_dusk'\)\)/,
    "the SKU keys are the CHECK list exactly as the slate drafts them",
  );
  assert.match(body, /kind TEXT NOT NULL CHECK \(kind IN \('consumable', 'own'\)\)/);
  assert.match(body, /qty INTEGER NOT NULL DEFAULT 1 CHECK \(qty >= 0\)/);
  assert.match(body, /equipped INTEGER NOT NULL DEFAULT 0 CHECK \(equipped IN \(0, 1\)\)/);
  assert.match(
    body,
    /server_id INTEGER NULL REFERENCES gc_servers\(id\) ON DELETE CASCADE/,
    "the channel-banner row dies WITH its server",
  );
  assert.match(body, /created_at INTEGER NOT NULL/);
  assert.match(body, /updated_at INTEGER NOT NULL/);
  assert.match(body, /PRIMARY KEY \(user_id, item_key\)/);
  // The equip state rides a column HERE — no ALTER touches gc_cosmetics.
  assert.doesNotMatch(body, /gc_cosmetics\b/, "the v1 surface is never ALTERed");
  // No deleted_at, no timers (the capsule law).
  assert.doesNotMatch(body, /deleted_at/);
});

test("no forum-side table beyond the read-only parents is touched", () => {
  const body = stripped(SQL);
  const tables = [...new Set(
    [...body.matchAll(/(?:REFERENCES|FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1]),
  )].filter((name) => name !== "gc_cosmetic_inventory" && !name.startsWith("gc_"));
  assert.deepEqual(tables, ["users"]);
});

// --- real SQLite (the schema's fidelity end-to-end) --------------------------

function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
    INSERT INTO users (id) VALUES (2), (3);
    INSERT INTO gc_servers (id, created_at) VALUES (5, 900);
  `);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SQL); // 0056 rides as written, FKs enforcing
  return db;
}

test("the apply lands the table and index on a fresh tree with FKs enforcing", () => {
  const db = seed();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gc_cosmetic_inventory'",
  ).all();
  assert.deepEqual(tables.map((r) => r.name), ["gc_cosmetic_inventory"]);
  assert.ok(db.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'idx_gc_cosmetic_inventory_equipped'",
  ).get());
});

test("a re-apply is a no-op: IF NOT EXISTS never errors on the table or index", () => {
  const db = seed();
  db.exec(SQL);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'gc_cosmetic_inventory'").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_gc_cosmetic_inventory_equipped'").get().n,
    1,
  );
});

test("the CHECK lists refuse a foreign SKU, a foreign kind, and a negative qty", () => {
  const db = seed();
  const insert = (itemKey, kind, qty) => {
    db.prepare(
      "INSERT INTO gc_cosmetic_inventory (user_id, item_key, kind, qty, equipped, server_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 0, NULL, 1, 1)",
    ).run(2, itemKey, kind, qty);
  };
  assert.throws(() => insert("fx_nope", "consumable", 5), /item_key/);
  assert.throws(() => insert("frame_gold", "rental", 1), /kind/);
  assert.throws(() => insert("frame_gold", "own", -1), /qty/);
  assert.doesNotThrow(() => insert("fx_burst_confetti", "consumable", 5));
  assert.doesNotThrow(() => insert("frame_gold", "own", 1));
  assert.doesNotThrow(() => insert("channel_banner_dusk", "own", 1));
  const equippedSql = "INSERT INTO gc_cosmetic_inventory (user_id, item_key, kind, qty, equipped, server_id, created_at, updated_at) VALUES (2, 'frame_neon', 'own', 1, ?, NULL, 1, 1)";
  assert.throws(() => db.prepare(equippedSql).run(2), /equipped/);
});

test("account death takes the inventory, and a server death takes its scoped rows CASCADE style", () => {
  const db = seed();
  const insert = (userId, itemKey, serverId) =>
    db.prepare(
      "INSERT INTO gc_cosmetic_inventory (user_id, item_key, kind, qty, equipped, server_id, created_at, updated_at) " +
      "VALUES (?, ?, 'own', 1, 0, ?, 1, 1)",
    ).run(userId, itemKey, serverId);
  insert(2, "frame_gold", null);
  insert(2, "frame_neon", null);
  insert(3, "frame_gold", null);
  insert(2, "channel_banner_dusk", 5);

  db.exec("DELETE FROM gc_servers WHERE id = 5");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_cosmetic_inventory WHERE item_key = 'channel_banner_dusk'").get().n,
    0,
    "the server-scoped row died with the server",
  );

  db.exec("DELETE FROM users WHERE id = 2");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_cosmetic_inventory").get().n,
    1,
    "the victim's inventory was taken along; the survivor's frame survives",
  );
  assert.equal(
    db.prepare("SELECT user_id FROM gc_cosmetic_inventory").get().user_id,
    3,
  );
});
