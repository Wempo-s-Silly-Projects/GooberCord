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

// Migration 0021 scoping: the message body bound raised for Goober+ ("Goober+
// lets u send larger messages"). The proposal (owner confirms via the lead):
// free keeps 2000, plus admits 4000 — the CHECK becomes the WIDEST admission
// (4000), the tier split lives at send/edit admission. The static pins hold
// the rebuild's exact shape (six statements, in this order, nothing else — a
// CHECK cannot be ALTERed so the table rebuilds; the DROP sits AFTER the copy
// and the final RENAME AFTER the drop), the real-SQLite pins hold the
// fidelity (ids preserved, children's FK clauses still resolve to
// gc_messages, the 4000-bound round-trips and 4001 refuses) and the
// 0013→0014 hazard stays dead (never a rename-DROP of the referenced shell;
// children are never rewritten at all in this sequence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0021_message_body_plus.sql"),
  "utf8",
);
const stripped = (s) => s.replace(/--[^\n]*/g, " ").trim();

function migrationStatements() {
  const parts = MIGRATION.replace(/--[^\n]*/g, "").split(";");
  return parts.map((p) => p.trim()).filter(Boolean);
}

test("the file is exactly six statements in the pinned rebuild order", () => {
  const list = migrationStatements();
  assert.equal(list.length, 6, `six statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_messages_rebuild\b/);
  assert.match(list[1], /^INSERT INTO gc_messages_rebuild\b/);
  assert.match(list[2], /^DROP TABLE gc_messages\b/);
  assert.match(list[3], /^ALTER TABLE gc_messages_rebuild RENAME TO gc_messages\b/);
  assert.match(list[4], /^CREATE INDEX idx_gc_messages_channel\b/);
  assert.match(list[5], /^CREATE INDEX idx_gc_messages_author_channel\b/);
});

test("no chat-style sentinel names and no other table is touched", () => {
  const body = stripped(MIGRATION);
  for (const name of ["gc_messages_pre_0021", "gc_chat_import_map", "chat_messages"]) {
    assert.equal(body.includes(name), false, `${name} must not appear`);
  }
  // The only DROP and the only RENAME operate on the rebuild pair — the
  // referenced original is dropped BY ITS OWN NAME after the copy, never via
  // a rename-out (the shape that dangled 0013's children).
  assert.match(body, /DROP TABLE gc_messages;?\s*$/m);
  assert.equal((body.match(/DROP TABLE/g) || []).length, 1);
  assert.equal((body.match(/RENAME TO/g) || []).length, 1);
  assert.doesNotMatch(body, /RENAME TO.*gc_messages_pre/);
});

test("the copy lists every column explicitly and preserves ids", () => {
  const copy = migrationStatements()[1];
  const expected = "id, channel_id, author_id, body, client_message_id, source, created_at, edited_at";
  assert.match(copy, new RegExp(`${expected}\\b[^;]*${expected}\\b`, "s"),
    "the INSERT lists the identical (non-renewing) column set on both sides — no autoincrement rewrite");
});

test("the single delta is the bound: the rest of the shape matches 0001", () => {
  const create = migrationStatements()[0];
  for (const fragment of [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE CASCADE",
    "author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
    "body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000)",
    "client_message_id TEXT NULL CHECK(length(client_message_id) BETWEEN 8 AND 64)",
    "source TEXT NULL CHECK(source IN ('forum-chat','forum-dm') OR source IS NULL)",
    "created_at INTEGER NOT NULL",
    "edited_at INTEGER NULL",
    "UNIQUE(channel_id, author_id, client_message_id)",
  ]) {
    assert.ok(create.includes(fragment), `missing: ${fragment}`);
  }
  // No second delta slips in: exactly the three 0001 CHECK clauses (body,
  // client_message_id, source) — the widened body bound being the only
  // change among them.
  assert.equal((create.match(/CHECK\(/g) || []).length, 3,
    "body + client_message_id + source CHECKs only — no new constraint rides along");
});

test("both indices are recreated verbatim after the rename", () => {
  const body = stripped(MIGRATION);
  assert.match(body, /CREATE INDEX idx_gc_messages_channel ON gc_messages\(channel_id, id\)/);
  assert.match(body, /CREATE INDEX idx_gc_messages_author_channel ON gc_messages\(author_id, channel_id\)/);
  const channelAt = body.indexOf("CREATE INDEX idx_gc_messages_channel");
  const renameAt = body.indexOf("ALTER TABLE gc_messages_rebuild RENAME TO gc_messages");
  assert.ok(renameAt < channelAt, "indices are (re)created only on the final table");
});

function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_channels (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      created_at INTEGER NOT NULL);
    -- The 0001 original (the two CHECKs pinned above are its only constraint
    -- delta in 0021).
    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
      client_message_id TEXT NULL CHECK(length(client_message_id) BETWEEN 8 AND 64),
      source TEXT NULL CHECK(source IN ('forum-chat','forum-dm') OR source IS NULL),
      created_at INTEGER NOT NULL,
      edited_at INTEGER NULL,
      UNIQUE(channel_id, author_id, client_message_id));
    CREATE INDEX idx_gc_messages_channel ON gc_messages(channel_id, id);
    CREATE INDEX idx_gc_messages_author_channel ON gc_messages(author_id, channel_id);
    -- Children that reference the rebuilt parent by name (the 0001 and 0009
    -- shapes): their stored FK clauses are what the rename-swap must keep
    -- resolving.
    CREATE TABLE gc_message_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL REFERENCES gc_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY,
      message_id INTEGER NULL REFERENCES gc_messages(id),
      created_at INTEGER NOT NULL);
    INSERT INTO users (id) VALUES (2), (3), (4);
    INSERT INTO gc_channels (id, server_id, created_at) VALUES (1, NULL, 500);
    INSERT INTO gc_messages (id, channel_id, author_id, body, client_message_id, source, created_at, edited_at) VALUES
      (10, 1, 2, 'first', 'aaaa0001', 'forum-dm', 1000, NULL),
      (11, 1, 3, 'a reply', 'aaaa0002', 'forum-dm', 1010, 1050),
      (12, 1, 2, 'plain client send', NULL, NULL, 1100, NULL);
    INSERT INTO gc_messages (id, channel_id, author_id, body, created_at)
      VALUES (13, 1, 4, '${"x".repeat(2000)}', 1200);
    INSERT INTO gc_message_reactions (channel_id, message_id, user_id, emoji, created_at)
      VALUES (1, 10, 3, '👋', 1100);
    INSERT INTO gc_attachments (message_id, created_at) VALUES (10, 1100);
  `);
  return db;
}

function apply(db) {
  db.exec(MIGRATION);
}

test("the rebuild copies everything through: ids, links, and the widened bound", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = OFF");
  apply(db);

  const rows = db
    .prepare("SELECT id, body, edited_at FROM gc_messages ORDER BY id")
    .all()
    .map((r) => ({ id: Number(r.id), len: r.body.length, edited: r.edited_at === null ? null : Number(r.edited_at) }));
  assert.deepEqual(rows, [
    { id: 10, len: 5, edited: null },
    { id: 11, len: 7, edited: 1050 },
    { id: 12, len: 17, edited: null },
    { id: 13, len: 2000, edited: null },
  ]);

  // The widened bound admits 4000 characters and refuses 4001.
  const insert = db.prepare(
    "INSERT INTO gc_messages (channel_id, author_id, body, created_at) VALUES (1, 2, ?, 2000)",
  );
  insert.run("y".repeat(4000));
  assert.throws(() => insert.run("z".repeat(4001)));
  const top = Number(
    db.prepare("SELECT MAX(id) AS m FROM gc_messages").get().m,
  );
  assert.equal(top, 14, "the new row continues the sequence past the preserved ids");

  // Children still resolve: FK clauses were never rewritten (a DROP rewrites
  // nothing; the final RENAME recreated the exact name they always named), so
  // new child rows referencing a preserved message id insert cleanly.
  const link = db.prepare(
    "INSERT INTO gc_message_reactions (channel_id, message_id, user_id, emoji, created_at) VALUES (1, 10, 3, '✨', 2000)",
  );
  assert.doesNotThrow(() => link.run());
  const fkTargets = db
    .prepare(
      "SELECT \"table\" FROM pragma_foreign_key_list('gc_message_reactions') LIMIT 1",
    )
    .get();
  assert.equal(fkTargets.table, "gc_messages");
  db.close();
});

test("with FK enforcement on at apply time, a populated parent refuses loudly", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(
    () => apply(db),
    undefined,
    "the child-populated DROP of the referenced table must abort the apply, never half-apply",
  );
  // The aborted ledger leaves the original intact: the stream is untouched.
  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM gc_messages").get().c);
  assert.equal(count, 4);
  db.close();
});
