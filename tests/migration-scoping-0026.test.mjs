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

// Migration 0026 scoping (read parity): the pins column, the dead
// gc_read_state's drop, and the three cited name-CHECK widenings. Static
// pins: fourteen statements in the exact family order, the ALTER's DEFAULT
// 0, the un-wired store's DROP, each rebuild's GLOB arms verbatim and its
// own length arm (the sticker's 30 is EXACT). Real-SQLite pins: apply UNDER
// foreign_keys enforcement (the three expression tables are childless — the
// 0024 canary discipline is for a populated PARENT's drop, not for these),
// existing rows carry through the copy, and each new bound refuses past
// itself while the GLOB alphabet still refuses what it always did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0026_read_parity.sql"), "utf8");
const TWIN = readFileSync(path.join(HERE, "..", "migrations", "0020_emoji_stickers.sql"), "utf8");
const SOUND_TWIN = readFileSync(path.join(HERE, "..", "migrations", "0023_soundboard.sql"), "utf8");

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

const statements = migrationStatements();

test("the file's shape: the ALTER, the DROP, then the three childless rename-copy dances", () => {
  assert.equal(statements.length, 14, `fourteen statements expected, got ${statements.length}`);
  const rebuild = (table) => {
    const start = statements.findIndex((s) => s.startsWith("CREATE TABLE " + table + "_rebuild"));
    assert.ok(start > 0, "the rebuild CREATE opens the family");
    const family = statements.slice(start, start + 4);
    assert.match(family[0], new RegExp("^CREATE TABLE " + table + "_rebuild\\b"));
    assert.match(family[1], new RegExp("^INSERT INTO " + table + "_rebuild SELECT id, server_id, name, attachment_id, created_by, created_at FROM " + table));
    assert.match(family[2], new RegExp("^DROP TABLE " + table));
    assert.match(family[3], new RegExp("^ALTER TABLE " + table + "_rebuild RENAME TO " + table));
    assert.ok(start + 4 <= statements.length, "the family stays contiguous");
  };
  assert.equal(statements[0].startsWith("ALTER TABLE gc_messages ADD COLUMN is_pinned"), true);
  assert.equal(statements[1], "DROP TABLE gc_read_state");
  rebuild("gc_emoji");
  rebuild("gc_stickers");
  rebuild("gc_sounds");
});

test("the three name CHECKs ride their cited bounds and keep the GLOB alphabet verbatim", () => {
  const bounds = [
    { table: "gc_emoji_rebuild", length: "BETWEEN 2 AND 32" },
    { table: "gc_stickers_rebuild", length: "BETWEEN 2 AND 30" },
    { table: "gc_sounds_rebuild", length: "BETWEEN 2 AND 32" },
  ];
  for (const { table, length } of bounds) {
    const create = statements.find((s) => s.startsWith("CREATE TABLE " + table));
    assert.ok(create, table + " exists");
    assert.ok(create.includes(length), `${table} carries ${length}`);
  }
  // The GLOB arms are verbatim twins of the 0020/0023 spelling — only the
  // length arm moved, so the wire grammar can never mint an alphabet the
  // rebuilt CHECK refuses.
  for (const arm of [
    "name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'",
    "name NOT GLOB '*[^A-Za-z0-9_]*'",
  ]) {
    assert.ok(TWIN.includes(arm) && SOUND_TWIN.includes(arm), `the twin's arm is real: ${arm}`);
  }
  const occurrences = (needle) => MIGRATION.split(needle).length - 1;
  assert.equal(occurrences("name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'"), 3, "three GLOB pair-arms, one per table");
  assert.equal(occurrences("name NOT GLOB '*[^A-Za-z0-9_]*'"), 3, "three NOT-GLOB arms, one per table");
  assert.equal(occurrences("REFERENCES gc_attachments(id) ON DELETE RESTRICT"), 3, "the RESTRICT arm carries through every rebuild");
  assert.equal(occurrences("REFERENCES users(id) ON DELETE CASCADE"), 3, "the creator CASCADE carries through every rebuild");
  assert.equal(occurrences("UNIQUE(server_id, name)"), 3, "the per-server namespace carries through every rebuild");
});

// The pre-state: the three expression tables at their OLD 2..16 CHECKs with
// populated rows (the copy must carry them), plus the parents the FK
// enforcement resolves. gc_read_state holds a row the DROP must take with it.
function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_channels (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE gc_attachment_chunks (attachment_id INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NULL,
      uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL);
    INSERT INTO users VALUES (2);
    INSERT INTO gc_servers VALUES (1);
    INSERT INTO gc_channels VALUES (5);
    INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, status)
      VALUES (11, NULL, 2, 'image/png', 4096, 'approved');
    INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, status)
      VALUES (12, NULL, 2, 'image/png', 4096, 'approved');
    INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, status)
      VALUES (13, NULL, 2, 'image/png', 4096, 'approved');
  `);
  const expression = (name) => `
    CREATE TABLE ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 16
        AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
        AND name NOT GLOB '*[^A-Za-z0-9_]*'),
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE RESTRICT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(server_id, name)
    );`;
  db.exec(expression("gc_emoji"));
  db.exec(expression("gc_stickers"));
  db.exec(expression("gc_sounds"));
  const insertFor = (name) =>
    `INSERT INTO ${name} (id, server_id, name, attachment_id, created_by, created_at) VALUES (?, 1, 'airhorn', ?, 2, 100)`;
  const insert = (name, id, attachment) => {
    const statement = db.prepare(insertFor(name));
    statement.run(id, attachment);
  };
  insert("gc_emoji", 1, 11);
  insert("gc_stickers", 2, 12);
  insert("gc_sounds", 3, 13);
  db.exec(`
    CREATE TABLE gc_read_state (
      user_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, channel_id));
    INSERT INTO gc_read_state VALUES (2, 5, 9);
  `);
  return db;
}

test("the migration applies under FK enforcement and carries every populated row", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);

  // The copy carried: one row per expression table, under the rebuilt
  // tables' exact original names.
  for (const table of ["gc_emoji", "gc_stickers", "gc_sounds"]) {
    const count = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
    assert.equal(count, 1, table + " kept its row through the rebuild");
    const name = db.prepare(`SELECT name FROM ${table} WHERE id = ` +
      (table === "gc_emoji" ? 1 : table === "gc_stickers" ? 2 : 3)).get();
    assert.equal(name.name, "airhorn", "the copied row's values ride verbatim");
  }
  // The pins column: the dead store's table is gone; an OLD-shaped INSERT
  // (no pin column named) rides the DEFAULT 0, and an explicit flag flips.
  assert.throws(() => db.prepare("SELECT is_pinned FROM gc_read_state").all(),
    undefined, "the dead store's table is gone");
  db.prepare(
    "INSERT INTO gc_messages (channel_id, author_id, body, created_at) VALUES (5, 2, 'quiet', 101)",
  ).run();
  const quiet = Number(db.prepare("SELECT is_pinned AS p FROM gc_messages WHERE body = 'quiet'").get().p);
  assert.equal(quiet, 0, "an old-shaped INSERT rides the DEFAULT 0");
  db.prepare(
    "INSERT INTO gc_messages (channel_id, author_id, body, created_at, is_pinned) VALUES (5, 2, 'loud', 102, 1)",
  ).run();
  const loud = Number(db.prepare("SELECT is_pinned AS p FROM gc_messages WHERE body = 'loud'").get().p);
  assert.equal(loud, 1, "the flag stores and reads as written");
  db.close();
});

test("each rebuilt bound refuses past itself and the GLOB alphabet still rules", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
  const tryName = (table, value) => {
    const insert = db.prepare(
      `INSERT INTO ${table} (server_id, name, attachment_id, created_by, created_at) VALUES (1, ?, 11, 2, 200)`,
    );
    insert.run(value);
  };
  // gc_emoji: 32 passes, 33 and 1-char refuse, a space refuses.
  tryName("gc_emoji", "a".repeat(32));
  assert.throws(() => tryName("gc_emoji", "a".repeat(33)), undefined, "33 chars refuse");
  assert.throws(() => tryName("gc_emoji", "x"), undefined, "1 char refuses");
  assert.throws(() => tryName("gc_emoji", "has space"), undefined);
  // gc_stickers: 30 passes EXACTLY — the 31 AND the 32 both refuse (NOT a
  // 32 superset; a 31-char sticker name failing is parity-correct).
  tryName("gc_stickers", "b".repeat(30));
  assert.throws(() => tryName("gc_stickers", "b".repeat(31)), undefined, "31 chars refuse");
  assert.throws(() => tryName("gc_stickers", "b".repeat(32)), undefined, "32 refuses too — the bound is exact");
  // gc_sounds: 32 passes, 33 refuses.
  tryName("gc_sounds", "c".repeat(32));
  assert.throws(() => tryName("gc_sounds", "c".repeat(33)), undefined);

  // The old table's UNIQUE namespace survives the rebuild: a duplicate
  // (server, name) pair refuses in the rebuilt table.
  assert.throws(() => tryName("gc_emoji", "airhorn"), undefined, "the rebuilt table still owns its namespace");
  db.close();
});
