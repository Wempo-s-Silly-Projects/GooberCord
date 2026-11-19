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

// Migration 0025 scoping: the D1-only uploads lane' staging table
// (gc_upload_parts). Static pins: exactly two statements (one CREATE, one
// CREATE INDEX), every object gc_-prefixed, no sentinel tables, the chunk
// row's proven shape (64,000-byte BLOB CHECK — the same literal
// gc_attachment_chunks carries), and the uploader CASCADE. Real-SQLite pins:
// apply, the data-length CHECK holds (0 and >64,000 refuse, 64,000 passes),
// the (upload_id, seq) PK refuses a duplicate chunk, and the user CASCADE
// empties an abandoned upload when its uploader's account dies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0025_gc_upload_staging.sql"), "utf8");

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

test("the file is exactly one CREATE TABLE gc_upload_parts plus its index — nothing else", () => {
  const list = migrationStatements();
  assert.equal(list.length, 2, `two statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_upload_parts\b/);
  assert.match(list[1], /^CREATE INDEX idx_gc_upload_parts_uploader ON gc_upload_parts/);
  // No sentinel/shared-domain names reach the server: the two statements
  // name only their own gc_-prefixed table and the users parent.
  assert.doesNotMatch(MIGRATION, /sentinel|pre-nitro|chat_messages|forums|wempos?\b/i);
  assert.doesNotMatch(list[0], /CREATE (?!TABLE gc_upload_parts)/, "no second table is created");
});

test("the chunk row shape rides the proven machinery: the bytes CHECK, the uploader CASCADE, the pair PK", () => {
  const create = migrationStatements()[0].replace(/\s+/g, " ");
  const arms = [
    "upload_id TEXT NOT NULL",
    "uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
    "seq INTEGER NOT NULL CHECK(seq >= 0)",
    "data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000)",
    "created_at INTEGER NOT NULL",
    "PRIMARY KEY(upload_id, seq)",
  ];
  for (const arm of arms) assert.ok(create.includes(arm), `missing: ${arm}`);
  // The 64000 literal is the SAME proven bound the attachment chunk table's
  // CHECK carries (ATTACHMENT_CHUNK_BYTES in code) — never a lane-local size.
  const chunkTable = readFileSync(
    path.join(HERE, "..", "migrations", "0001_initial_goobercord.sql"), "utf8",
  );
  const chunkArm = chunkTable.match(/gc_attachment_chunks[^;]*?CHECK\(length\(data\) BETWEEN 1 AND (\d+)\)/s);
  assert.ok(chunkArm);
  assert.equal(chunkArm[1], "64000");
  assert.ok(create.includes("64000"), "the staging CHECK rides the same literal");
});

function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users VALUES (2), (3);
  `);
  db.exec(MIGRATION);
  return db;
}

const INSERT_CHUNK =
  "INSERT INTO gc_upload_parts (upload_id, uploader_id, seq, data, created_at) VALUES ('AAAAAAAAAAAA', ?, ?, ?, 100)";

test("the table applies and holds the data-length vocabulary: 0 and over-64k refuse, 64k passes", () => {
  const db = seed();
  const insert = db.prepare(INSERT_CHUNK);
  const full = new Uint8Array(64000).fill(1);
  assert.doesNotThrow(() => insert.run(2, 0, full), "a full 64,000-byte chunk is the checked shape");
  assert.throws(() => insert.run(2, 1, new Uint8Array(0)), undefined, "an empty chunk refuses");
  assert.throws(() => insert.run(2, 2, new Uint8Array(64001)), undefined, "an over-cap chunk refuses");
  assert.throws(() => insert.run(2, -1, full), undefined, "a negative seq refuses the CHECK");
  db.close();
});

test("the pair PK refuses a duplicate seq, and the uploader CASCADE empties an abandoned upload", () => {
  const db = seed();
  const full = new Uint8Array(64000).fill(1);
  db.prepare(INSERT_CHUNK).run(2, 0, full);
  assert.throws(
    () => db.prepare(INSERT_CHUNK).run(2, 0, full),
    undefined,
    "the (upload_id, seq) pair refuses a retried row at the same position",
  );
  // The table's key is (upload_id, seq) — the uploader scoping lives in the
  // routes' WHERE, but a DIFFERENT upload id never collides.
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO gc_upload_parts (upload_id, uploader_id, seq, data, created_at) VALUES ('BBBBBBBBBBBB', 3, 0, ?, 100)").run(full));

  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("DELETE FROM users WHERE id = 2").run();
  const left = Number(db.prepare("SELECT COUNT(*) AS c FROM gc_upload_parts WHERE upload_id = 'AAAAAAAAAAAA'").get().c);
  assert.equal(left, 0, "the uploader's CASCADE carries their staged rows");
  const other = Number(db.prepare("SELECT COUNT(*) AS c FROM gc_upload_parts WHERE upload_id = 'BBBBBBBBBBBB'").get().c);
  assert.equal(other, 1, "another member's staged upload survives");
  db.close();
});
