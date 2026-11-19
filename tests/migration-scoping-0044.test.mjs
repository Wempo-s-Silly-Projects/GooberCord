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

// Migration 0044 scoping (T-R2-WIPE): the legacy D1 byte table retires
// whole. The migration is ONE gc_-prefixed DROP TABLE — it reads nothing,
// writes no schema outside its own table, and leaves every auth/table-side
// column alone (the users avatar_* / pending_avatar_* columns stand; their
// serving flipped to the R2 avatars/* keys with these columns as the
// fallback). The pins execute the real SQL against node:sqlite (same engine
// class D1 speaks) and assert the exact before/after shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0044_gc_drop_attachment_chunks.sql"),
  "utf8",
);
const AGPL_HEADER_LINES = 18;

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "").split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

test("0044 is one gc_-prefixed DROP TABLE after the full AGPL header", () => {
  const lines = MIGRATION.split("\n");
  assert.ok(lines[0].startsWith("-- Copyright 2026"), "the AGPL header leads");
  for (let i = 0; i < AGPL_HEADER_LINES; i += 1) {
    assert.match(lines[i], /^--|^$/, `line ${i} keeps the header template`);
  }
  const body = migrationStatements();
  assert.equal(body.length, 1);
  assert.equal(body[0], "DROP TABLE gc_attachment_chunks");
  assert.ok(!/(?:^|[^_])users\b/i.test(body[0]), "no auth-table target");
});

test("0044 drops the chunk table and nothing else", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY, message_id INTEGER, uploader_id INTEGER,
      mime TEXT, size_bytes INTEGER, status TEXT, created_at INTEGER);
    CREATE TABLE gc_attachment_chunks (
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id),
      seq INTEGER NOT NULL,
      data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000),
      PRIMARY KEY (attachment_id, seq));
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL,
      avatar_status TEXT, avatar_mime TEXT, avatar_data BLOB,
      avatar_updated_at INTEGER, avatar_version TEXT,
      pending_avatar_mime TEXT, pending_avatar_data BLOB,
      pending_avatar_updated_at INTEGER, pending_avatar_version TEXT);
    CREATE TABLE gc_emoji (
      id INTEGER PRIMARY KEY, server_id INTEGER, attachment_id INTEGER, name TEXT);
    INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (5, 'image/png', 4);
    INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (5, 0, x'00aa');
    INSERT INTO users (id, username, avatar_mime, avatar_data) VALUES (7, 'wempos', 'image/png', x'00bb');
    INSERT INTO gc_emoji (id, server_id, attachment_id, name) VALUES (1, 2, 5, 'goob');
  `);

  for (const statement of migrationStatements()) db.exec(statement);

  const table = (name) => db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  assert.equal(table("gc_attachment_chunks").c, 0, "the byte table retired");
  assert.equal(table("gc_attachments").c, 1, "the metadata table stands");
  assert.equal(table("gc_emoji").c, 1, "every other gc_ table stands");
  assert.equal(table("users").c, 1, "the shared users table stands");

  const user = db.prepare(
    "SELECT avatar_mime, length(avatar_data) AS len FROM users WHERE id = 7",
  ).get();
  assert.equal(user.avatar_mime, "image/png", "avatar columns untouched");
  assert.equal(user.len, 2, "avatar bytes untouched");
  const attachment = db.prepare(
    "SELECT id FROM gc_attachments WHERE id = 5",
  ).get();
  assert.equal(attachment.id, 5, "metadata rows untouched");
});
