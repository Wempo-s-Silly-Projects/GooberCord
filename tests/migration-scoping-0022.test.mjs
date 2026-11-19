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

// Migration 0022 scoping: the upload tiers (the 2026-11-17 matrix). Static
// pins: the tier column's shape (NULL-able, 'mini'/'plus' only, legacy rows
// read full Goober+ read-side — no backfill), the rebuild's exact shape (same
// six-statement order the 0021 discipline pinned: children never rewritten),
// the 1 GiB CHECK, and the pending index recreated verbatim (the 0013
// rebuild lost it with its table). Real-SQLite pins: ids preserved, children
// resolving, the widened bound round-trips, the tier CHECK's vocabulary, and
// the loud FKs-on failure mode — plus the never-downgrade invariant by data
// (a legacy row's NULL tier passes untouched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0022_upload_tiers.sql"),
  "utf8",
);
const stripped = (s) => s.replace(/--[^\n]*/g, " ").trim();

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

test("piece one ALTERs only gc_plus_state — the tier column, no backfill write", () => {
  const alter = migrationStatements()[0];
  assert.match(alter, /^ALTER TABLE gc_plus_state ADD COLUMN tier TEXT NULL/i);
  assert.match(alter, /CHECK \(tier IS NULL OR tier IN \('mini', 'plus'\)\)/i);
  // No UPDATE follows the ALTER: the legacy NULL is a READ-SIDE semantic.
  assert.equal(stripped(MIGRATION).includes("UPDATE gc_plus_state"), false,
    "a UPDATE would force a tier on members the owner never sold one to");
  // 'gold'-shaped values can never ride the column.
  assert.doesNotMatch(alter, /'gold'|'premium'|'free'/i);
});

test("piece two is exactly five statements in the pinned rebuild order, index recreated last", () => {
  const list = migrationStatements().slice(1);
  assert.equal(list.length, 5, `five statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_attachments_rebuild\b/);
  assert.match(list[1], /^INSERT INTO gc_attachments_rebuild\b/);
  assert.match(list[2], /^DROP TABLE gc_attachments\b/);
  assert.match(list[3], /^ALTER TABLE gc_attachments_rebuild RENAME TO gc_attachments\b/);
  // The pending index, recreated verbatim against 0001's line at the END of
  // the file (the 0013 rebuild lost it when it dropped the shell).
  assert.equal(list[4], "CREATE INDEX idx_gc_messages_pending ON gc_attachments(status) WHERE status = 'pending'");
});

test("the copy lists every 0013 column explicitly; the only delta is the bound", () => {
  const list = migrationStatements().slice(1);
  const create = list[0];
  const expected = "id, message_id, uploader_id, mime, size_bytes, status, width, height, created_at, reviewed_by, reviewed_at";
  assert.match(list[1], new RegExp(`${expected}\\b[^;]*${expected}\\b`, "s"),
    "the INSERT lists the identical column set on both sides — explicit ids, nothing renumbered");
  for (const fragment of [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "message_id INTEGER NULL REFERENCES gc_messages(id)",
    "uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
    "mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','image/gif'))",
    "size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 1073741824)",
    "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected'))",
    "width INTEGER NULL",
    "height INTEGER NULL",
    "created_at INTEGER NOT NULL",
    "reviewed_by INTEGER NULL",
    "reviewed_at INTEGER NULL",
  ]) {
    assert.ok(create.includes(fragment), `missing: ${fragment}`);
  }
  // No second delta: the CHECK count matches 0013's final shape (mime,
  // size_bytes, status) plus the quoted bound change only.
  assert.equal((create.match(/CHECK\(/g) || []).length, 3);
  // The rebuild stays the safe shape: one DROP of the referenced table BY
  // ITS OWN NAME, one RENAME, children never rewritten.
  assert.equal((stripped(MIGRATION).match(/DROP TABLE/g) || []).length, 1);
  assert.equal((stripped(MIGRATION).match(/RENAME TO/g) || []).length, 1);
});

// The pre-state: the 0013 final gc_attachments shape and its two children.
function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
      created_at INTEGER NOT NULL);
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NULL REFERENCES gc_messages(id),
      uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','image/gif')),
      size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      width INTEGER NULL,
      height INTEGER NULL,
      created_at INTEGER NOT NULL,
      reviewed_by INTEGER NULL,
      reviewed_at INTEGER NULL);
    CREATE TABLE gc_attachment_chunks (
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000),
      PRIMARY KEY(attachment_id, seq));
    -- The 0020 expressions' RESTRICT child is precisely why the copy runs
    -- before the original drops.
    CREATE TABLE gc_emoji (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE RESTRICT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE(server_id, name));
    CREATE TABLE gc_plus_state (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      renews_until INTEGER NOT NULL,
      grace_until INTEGER NULL,
      tenure_started_at INTEGER NOT NULL);
    INSERT INTO users VALUES (2), (3);
    INSERT INTO gc_messages (id, channel_id, author_id, body, created_at) VALUES (5, 1, 2, 'hello', 100);
    -- A pending message attachment at exactly the old ceiling, an approved
    -- standalone (the expression intake's message_id IS NULL), a server icon
    -- pointer shape, and a 1-byte filler.
    INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, status, created_at)
      VALUES (10, 5, 2, 'image/png', 26214400, 'pending', 100);
    INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, status, created_at)
      VALUES (11, NULL, 3, 'image/png', 1048576, 'approved', 110);
    INSERT INTO gc_emoji (server_id, name, attachment_id, created_by, created_at)
      VALUES (1, 'wink', 11, 2, 120);
    -- A legacy member's term row: the tier column arrives with its NULL on
    -- (the never-downgrade invariant's fixture).
    INSERT INTO gc_plus_state (user_id, renews_until, tenure_started_at) VALUES (3, 999, 1);
    INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES
      (10, 0, x'89504e470d0a1a0a'), (10, 1, x'000102'),
      (11, 0, x'89504e470d0a1a0a');
  `);
  return db;
}

test("the rebuild copies everything through: ids, links, chunks, and the widened bound", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(MIGRATION);

  const rows = db
    .prepare("SELECT id, size_bytes, status FROM gc_attachments ORDER BY id")
    .all()
    .map((r) => ({ id: Number(r.id), size: Number(r.size_bytes), status: r.status }));
  assert.deepEqual([
    { id: 10, size: 26214400, status: "pending" },
    { id: 11, size: 1048576, status: "approved" },
  ], rows);

  const chunks = db
    .prepare("SELECT attachment_id, seq, length(data) AS len FROM gc_attachment_chunks ORDER BY attachment_id, seq")
    .all();
  assert.equal(chunks.length, 3, "chunk rows ride the ids untouched");

  // The widened bound admits a 1 GiB row and refuses one byte over.
  const insert = db.prepare(
    "INSERT INTO gc_attachments (message_id, uploader_id, mime, size_bytes, created_at) VALUES (NULL, 2, 'image/png', ?, 200)",
  );
  insert.run(1073741824);
  assert.throws(() => insert.run(1073741825));

  // Children still resolve (a DROP rewrites nothing; the rename recreated the
  // exact name the clauses name — the RESTRICT child above all).
  const link = db.prepare(
    "INSERT INTO gc_emoji (server_id, name, attachment_id, created_by, created_at) VALUES (1, 'grin', 10, 2, 200)",
  );
  assert.doesNotThrow(() => link.run());

  // The partial pending index rides the rebuilt table.
  const indexes = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'gc_attachments' AND name = 'idx_gc_messages_pending'")
    .all();
  assert.equal(indexes.length, 1, "idx_gc_messages_pending is recreated verbatim");

  // The legacy term row's tier reads NULL after the ALTER — the column
  // arrived without forcing a value (the never-downgrade invariant by data).
  const legacy = db.prepare("SELECT tier FROM gc_plus_state WHERE user_id = 3").get();
  assert.equal(legacy.tier, null);
  db.close();
});

function seedPlusState(db) {
  db.exec(`
    CREATE TABLE gc_plus_state (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      renews_until INTEGER NOT NULL,
      grace_until INTEGER NULL,
      tenure_started_at INTEGER NOT NULL);
  `);
  db.exec(migrationStatements()[0]);
}

test("the tier column's CHECK vocabulary holds on gc_plus_state's real shape", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (2), (3), (4);");
  seedPlusState(db);
  const insert = db.prepare(
    "INSERT INTO gc_plus_state (user_id, renews_until, tenure_started_at, tier) VALUES (?, 999, 1, ?)",
  );
  insert.run(2, "mini");
  insert.run(3, "plus");
  insert.run(4, null);
  // Anything outside the paired vocabulary refuses, CHECK-side.
  assert.throws(() => insert.run(3, "gold").all?.(), Error);
  void insert;
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM gc_plus_state WHERE tier = 'mini'").get().c), 1);
  // The legacy row's NULL survives the column's arrival untouched (the
  // never-downgrade invariant by data).
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM gc_plus_state WHERE tier IS NULL").get().c), 1);
  db.close();
});

test("with FK enforcement on at apply time, a populated parent refuses loudly", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(() => db.exec(MIGRATION), undefined,
    "the child-populated DROP of the referenced table must abort the apply, never half-apply");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM gc_attachments").get().c), 2);
  db.close();
});
