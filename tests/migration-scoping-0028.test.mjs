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

// Migration 0028 scoping (W-B2's mentions lane): the gc_mentions table and
// its user index. Static pins: the two-statement shape, both FKs CASCADE,
// the composite PRIMARY KEY (the dedupe the send-side INSERT OR IGNORE
// rides), NO synthetic id (the deleted-mentions-endpoint's {id} was the
// message id). Real-SQLite pins: apply under FK enforcement needs the two
// parents, a repeated (message, user) pair refuses, the CASCADEs carry (a
// message delete carries its mention rows; an account delete carries both
// halves), and the scoping invariant — every created object is gc_-prefixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0028_mentions.sql"), "utf8");

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

const statements = migrationStatements();

test("the file's shape: one CREATE TABLE plus its user index, nothing else", () => {
  assert.equal(statements.length, 2, `two statements expected, got ${statements.length}`);
  assert.equal(statements[0].replace(/\s+/g, " ").startsWith("CREATE TABLE gc_mentions"), true);
  assert.match(statements[1], /CREATE INDEX idx_gc_mentions_user ON gc_mentions\(user_id, message_id\)/,
    "the inbox read's index leads with the user_id half");
  // Both FKs CASCADE — the parity notes (a dead message stops resolving;
  // a deleted account carries BOTH halves).
  assert.match(statements[0], /REFERENCES gc_messages\(id\) ON DELETE CASCADE/);
  assert.match(statements[0], /REFERENCES users\(id\) ON DELETE CASCADE/);
  // No synthetic id: the PK IS the (message, user) pair — the dedupe arm.
  assert.match(statements[0], /PRIMARY KEY\(message_id, user_id\)/);
  assert.match(statements[0], /created_at INTEGER NOT NULL/, "the inbox's sort face carries its own clock");
});

// The parents the FK enforcement resolves: users + gc_messages at their
// essential shape — the author side IS wired (the real table's REFERENCES
// users ON DELETE CASCADE), because the account-CASCADE pin needs it real.
function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (2);
    INSERT INTO users VALUES (9);
    INSERT INTO gc_messages (id, channel_id, author_id, body, created_at)
      VALUES (40, 3, 9, 'hello @wempos', 100);
  `);
  return db;
}

test("the migration applies under FK enforcement, the pair is the identity", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);

  const insert = db.prepare(
    "INSERT INTO gc_mentions (message_id, user_id, created_at) VALUES (?, ?, ?)",
  );
  insert.run(40, 2, 100);
  // The composite PK refuses the repeated pair — the send-side's
  // INSERT OR IGNORE is what keeps the retry quiet (the table refuses it).
  assert.throws(() => insert.run(40, 2, 101), undefined,
    "a repeated (message, user) pair refuses — one row per mention, ever");
  // A different user on the same message fits.
  insert.run(40, 9, 100);
  const rows = db.prepare(
    "SELECT message_id, user_id FROM gc_mentions WHERE message_id = 40 ORDER BY user_id",
  ).all().map((row) => [row.message_id, row.user_id]);
  assert.deepEqual(rows, [
    [40, 2],
    [40, 9],
  ], "one row per (message, mentioned member) — the inbox is a plain indexed read");
  db.close();
});

test("the CASCADEs carry: a dead message drops its mention rows, a dead account drops both halves", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
  db.prepare("INSERT INTO gc_mentions (message_id, user_id, created_at) VALUES (40, 2, 100)").run();
  db.prepare("INSERT INTO gc_mentions (message_id, user_id, created_at) VALUES (40, 9, 100)").run();

  // The message half: the mentioned member's inbox row goes WITH the message.
  db.prepare("DELETE FROM gc_messages WHERE id = 40").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_mentions").get().c, 0,
    "Discord's semantics: the mentions of dead messages stop resolving");

  // The account half on a second message: the deleted member's OWN sends'
  // rows go too (the messages row cascades with the author).
  db.prepare("INSERT INTO gc_messages (id, channel_id, author_id, body, created_at) VALUES (41, 3, 9, 'again', 102)").run();
  db.prepare("INSERT INTO gc_mentions (message_id, user_id, created_at) VALUES (41, 2, 102)").run();
  db.prepare("DELETE FROM users WHERE id = 9").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_messages").get().c, 0,
    "the message FK's author side cascades");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_mentions").get().c, 0,
    "both halves of a deleted account's mention rows are gone");
  db.close();
});

test("the created objects are gc_-prefixed (the scoping invariant)", () => {
  for (const object of ["gc_mentions", "idx_gc_mentions_user"]) {
    assert.ok(MIGRATION.includes(object), `${object} is gc_-prefixed or forum-owned`);
  }
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index')
     AND name NOT IN ('users','gc_messages')`,
  ).all();
  for (const row of rows) {
    assert.match(row.name, /^(gc_|idx_gc_)/, row.name + " carries the gc_ prefix");
  }
  db.close();
});
