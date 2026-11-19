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

// Migration 0060 (the channel polls' poll rows, wave 26 W26-2) scoping
// pin: ONE CREATE-only statement — the gc_polls table — gc_-prefixed and
// FK-free (the D1 FK-runner law, 0059's precedent; a deleted message's
// poll row is inert history). The message_id UNIQUE is one poll per
// message and the read arm's index together. The cap literals mirror
// constants.mjs (GC_POLL_QUESTION_MAX 200, the 2048-byte JSON envelope).
// The real-SQLite hold lands the table and proves the UNIQUE arm beside
// the closed-poll NULL pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf, assertTargetsAreGc } from "./migration-scoping.test.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(TESTS_DIR, "..", "migrations");
const SQL = readFileSync(path.join(MIGRATIONS_DIR, "0060_gc_polls.sql"), "utf8");

test("0060 is exactly one statement: the gc_polls table", () => {
  const list = statementsOf(SQL);
  assert.equal(list.length, 1, `one statement expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE IF NOT EXISTS\s*\n?\s*gc_polls\s*\(/);
});

test("0060 classifies gc_-prefixed and carries no FK-bearing form", () => {
  assertTargetsAreGc(SQL);
  const body = SQL.replace(/--[^\n]*/g, " ").toUpperCase();
  for (const banned of ["FOREIGN KEY", "REFERENCES", "ALTER ", "DROP ", "UPDATE ", "INSERT INTO", "TRIGGER", "PRAGMA", "RENAME"]) {
    assert.equal(body.includes(banned), false, `banned statement form: ${banned}`);
  }
});

test("0060 carries the 17-line-plus-blank AGPLv3 header", () => {
  const lines = SQL.split("\n");
  assert.match(lines[0], /^-- Copyright 2026 /);
  assert.equal(lines[16].startsWith("--"), true, "line 17 ends the license block");
  assert.equal(lines[17].trim(), "", "line 18 is the blank separator line");
  assert.match(SQL, /GNU Affero General Public License/);
});

test("the table lands on real SQLite: UNIQUE one-poll-per-message, capped question, closable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(SQL);
    // A live poll beside a closed one: the NULL close pair is real, the
    // UNIQUE(message_id) arm refuses a second poll on one message, and the
    // question cap bites at the engine.
    db.prepare(
      "INSERT INTO gc_polls (message_id, channel_id, question, options_json, multiple, closed_at, closed_by, created_at) " +
        "VALUES (1, 10, 'Lunch?', '[\"Pizza\",\"Sushi\"]', 0, NULL, NULL, 5)",
    ).run();
    assert.throws(() =>
      db.prepare(
        "INSERT INTO gc_polls (message_id, channel_id, question, options_json, multiple, closed_at, closed_by, created_at) " +
          "VALUES (1, 10, 'Again?', '[\"Pizza\",\"Sushi\"]', 0, NULL, NULL, 6)",
      ).run(),
    "the UNIQUE(message_id) floor refuses a second poll on one message");
    // The close pair accepts NULLs and the question cap bites at 201.
    assert.ok(db.prepare(
      "UPDATE gc_polls SET closed_at = 9 WHERE message_id = 1",
    ).run());
    assert.throws(() =>
      db.prepare(
        "INSERT INTO gc_polls (message_id, channel_id, question, options_json, multiple, closed_at, closed_by, created_at) " +
          "VALUES (2, 10, ?, '[\"Pizza\",\"Sushi\"]', 0, NULL, NULL, 7)",
      ).run("q".repeat(201)),
    "the 200-character question CHECK refuses the oversized row");
  } finally { db.close(); }
});
