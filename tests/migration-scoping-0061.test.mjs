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

// Migration 0061 (the channel polls' votes, wave 26 W26-2) scoping pin:
// ONE CREATE-only statement — the gc_poll_votes table — gc_-prefixed and
// FK-free (the D1 FK-runner law, 0059's precedent). UNIQUE(poll_id,
// user_id) is the vote claim's floor: one vote per user per poll at the
// schema level, the changeable vote riding the upsert's conflict arm.
// The real-SQLite hold lands the table and proves the claim arm and the
// choices envelope together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf, assertTargetsAreGc } from "./migration-scoping.test.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(TESTS_DIR, "..", "migrations");
const SQL = readFileSync(path.join(MIGRATIONS_DIR, "0061_gc_poll_votes.sql"), "utf8");

test("0061 is exactly one statement: the gc_poll_votes table", () => {
  const list = statementsOf(SQL);
  assert.equal(list.length, 1, `one statement expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE IF NOT EXISTS\s*\n?\s*gc_poll_votes\s*\(/);
});

test("0061 classifies gc_-prefixed and carries no FK-bearing form", () => {
  assertTargetsAreGc(SQL);
  const body = SQL.replace(/--[^\n]*/g, " ").toUpperCase();
  for (const banned of ["FOREIGN KEY", "REFERENCES", "ALTER ", "DROP ", "UPDATE ", "INSERT INTO", "TRIGGER", "PRAGMA", "RENAME"]) {
    assert.equal(body.includes(banned), false, `banned statement form: ${banned}`);
  }
});

test("0061 carries the 17-line-plus-blank AGPLv3 header", () => {
  const lines = SQL.split("\n");
  assert.match(lines[0], /^-- Copyright 2026 /);
  assert.equal(lines[16].startsWith("--"), true, "line 17 ends the license block");
  assert.equal(lines[17].trim(), "", "line 18 is the blank separator line");
  assert.match(SQL, /GNU Affero General Public License/);
});

test("the table lands on real SQLite: one vote claim per (poll, user), changeable in-statement", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(SQL);
    const insert = "INSERT INTO gc_poll_votes (poll_id, user_id, choices_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)";
    // A first claim, then the conflict arm: a second cast is a REPLACE of
    // the claim (the upsert shape), never a second row.
    db.prepare(insert).run(1, 42, "[0]", 5, 5);
    db.prepare(
      "INSERT INTO gc_poll_votes (poll_id, user_id, choices_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(poll_id, user_id) DO UPDATE SET " +
        "choices_json = excluded.choices_json, updated_at = excluded.updated_at",
    ).run(1, 42, "[1, 2]", 9, 9);
    const rows = db.prepare(
      "SELECT choices_json FROM gc_poll_votes WHERE poll_id = ? AND user_id = ?",
    ).all(1, 42);
    assert.equal(rows.length, 1, "the claim floor admits ONE row per (poll, user)");
    assert.equal(rows[0].choices_json, "[1, 2]", "the changeable vote rode the conflict arm");
    // A DIFFERENT member claims freely beside the first.
    db.prepare(insert).run(1, 43, "[0]", 6, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_poll_votes").get().n, 2, "the count");
    // The choices envelope bites at the engine.
    assert.throws(() =>
      db.prepare(insert).run(2, 42, "x".repeat(65), 6, 6),
    "the 64-byte choices CHECK refuses the oversized row");
  } finally { db.close(); }
});
