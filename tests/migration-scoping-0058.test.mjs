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

// Migration 0058 (the ledger spend nonce) scoping pin: ONE additive
// statement — ALTER TABLE gc_coin_ledger ADD COLUMN spend_nonce TEXT NULL —
// the only ALTER form the scoping parser admits (0057's discipline). No
// rename, no rebuild, no FK change (the gift trail's related_user_id stays
// the users FK; the D1 FK-runner law keeps rename-rebuild dead on populated
// parents). The real-SQLite hold lands the column on a 0011-seeded tree and
// proves the nonce rides a spend row WITHOUT disturbing the FK trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf } from "./migration-scoping.test.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(TESTS_DIR, "..", "migrations");
const SQL = readFileSync(path.join(MIGRATIONS_DIR, "0058_gc_ledger_nonce.sql"), "utf8");

function stripped(sql) {
  return sql.replace(/--[^\n]*/g, " ").trim();
}

test("0058 is exactly one statement: the ledger's nonce column", () => {
  const list = statementsOf(SQL);
  assert.equal(list.length, 1, `one statement expected, got ${list.length}`);
  assert.match(
    list[0],
    /^ALTER TABLE gc_coin_ledger ADD COLUMN spend_nonce TEXT NULL$/,
  );
});

test("0058 is ADD-COLUMN-only: no rename, no rebuild, no FK or trigger edit", () => {
  const body = stripped(SQL).toUpperCase();
  for (const banned of ["RENAME", "DROP", "UPDATE ", "INSERT INTO", "DELETE FROM", "TRIGGER", "PRAGMA"]) {
    assert.equal(body.includes(banned), false, `banned statement form: ${banned}`);
  }
  assert.equal((body.match(/ALTER TABLE/g) || []).length, 1, "exactly one ALTER, on a gc_ table");
  assert.match(body, /ALTER TABLE GC_COIN_LEDGER/);
});

test("0058 carries the 17-line-plus-blank AGPLv3 header", () => {
  const lines = SQL.split("\n");
  assert.match(lines[0], /^-- Copyright 2026 /);
  assert.equal(lines[16].startsWith("--"), true, "line 17 ends the license block");
  assert.equal(lines[17].trim(), "", "line 18 is the blank separator line");
  assert.match(SQL, /GNU Affero General Public License/);
});

test("the column lands on a 0011-seeded tree and rides a spend row beside the gift trail", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
  `);
  applyLedger(db);
  db.exec(SQL);
  db.exec("INSERT INTO users (id) VALUES (7)");
  // A nonce-bearing spend beside a FK-carrying gift row: the trail stays,
  // the nonce is optional, the old-shaped row stays valid (a NULL nonce).
  db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at, spend_nonce) " +
    "VALUES (7, -400, 'plus_renewal', NULL, 5, 'n0nc3_n0nc3_n0n')",
  ).run();
  db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) VALUES (7, 2, 'daily', 5)",
  ).run();
  const rows = db.prepare(
    "SELECT source, spend_nonce FROM gc_coin_ledger ORDER BY source",
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.source === "plus_renewal").spend_nonce, "n0nc3_n0nc3_n0n", "the spend row carries the nonce");
  assert.equal(rows.find((row) => row.source === "daily").spend_nonce, null, "the non-fingerprinted earn row stays NULL");
  const shape = db.prepare(
    "SELECT type, name FROM pragma_table_info('gc_coin_ledger') WHERE name = 'spend_nonce'",
  ).all();
  assert.equal(shape.length, 1, "the column rides the table after the apply");
});

function applyLedger(db) {
  const statements = statementsOf(
    readFileSync(path.join(MIGRATIONS_DIR, "0011_coin_economy.sql"), "utf8"),
  );
  for (const statement of statements) db.exec(statement);
}
