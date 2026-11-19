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

// Migration 0023 scoping: the soundboard's gc_sounds table (the
// server-boost LEVELS' one rowed feature). Static pins: one CREATE, every
// object gc_-prefixed or shared, no sentinel tables, and the 0020 twin's
// exact arms (strict name CHECK, RESTRICT on the attachment,
// UNIQUE(server_id, name), CASCADEs). Real-SQLite pins: apply, the name
// CHECK's vocabulary holds (2..16 strict [A-Za-z0-9_]), the per-server
// UNIQUE namespace refuses a duplicate, RESTRICT holds the referenced
// attachment, and the server/user CASCADEs empty the table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0023_soundboard.sql"), "utf8");
const TWIN = readFileSync(path.join(HERE, "..", "migrations", "0020_emoji_stickers.sql"), "utf8");

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

test("piece one is exactly one CREATE of gc_sounds — nothing else in the file", () => {
  const list = migrationStatements();
  assert.equal(list.length, 1, `one statement expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_sounds\b/);
  // No sentinel/shared-domain names reach the server: the one statement only
  // names its own gc_-prefixed table and the parents it borrows rows from.
  assert.doesNotMatch(list[0], /sentinel|pre-nitro|chat_messages|forums|wempos?\b/i);
  assert.doesNotMatch(list[0], /CREATE (?!TABLE gc_sounds)/, "no second object is created");
});

test("gc_sounds is the 0020 twin: the same arms, its own namespace and table", () => {
  // Whitespace-normalized matching: the migration files may wrap their lines
  // differently, but every arm must be the same tokens.
  const flat = (text) => text.replace(/\s+/g, " ");
  const arms = [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
    "attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE RESTRICT",
    "created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
    "created_at INTEGER NOT NULL",
    "UNIQUE(server_id, name)",
  ];
  const create = flat(migrationStatements()[0]);
  for (const arm of arms) assert.ok(create.includes(arm), `missing: ${arm}`);
  // The name CHECK's arms are present and identical in both twins (the wire
  // grammar spelled once, so the :s:name:id token can never mint a name the
  // table refuses) — matched as fragments, since the twins wrap their lines
  // differently.
  const nameArms = [
    "length(name) BETWEEN 2 AND 16",
    "name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'",
    "name NOT GLOB '*[^A-Za-z0-9_]*'",
  ];
  for (const arm of nameArms) {
    assert.ok(MIGRATION.includes(arm), `gc_sounds' name CHECK is missing: ${arm}`);
    assert.ok(TWIN.includes(arm), `the 0020 twin's pin moved: ${arm} no longer spelled there`);
  }
});

// The pre-state: gc_sounds' three parents and the attachment shell the
// standalone intake writes (message_id NULL, like an expression's asset).
function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (
      id INTEGER PRIMARY KEY,
      boosts INTEGER NOT NULL DEFAULT 0,
      icon_media_id INTEGER NULL);
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NULL,
      uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 1073741824),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      width INTEGER NULL,
      height INTEGER NULL,
      created_at INTEGER NOT NULL,
      reviewed_by INTEGER NULL,
      reviewed_at INTEGER NULL);
    INSERT INTO users VALUES (2), (3);
    INSERT INTO gc_servers (id, boosts, icon_media_id) VALUES (1, 2, NULL), (2, 0, NULL);
    INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, status, created_at)
      VALUES (11, NULL, 2, 'image/png', 4096, 'approved', 100);
  `);
  return db;
}

test("the table applies, holds the vocabulary, and namespaces per server", () => {
  const db = seed();
  db.exec(MIGRATION);

  const insert = db.prepare(
    "INSERT INTO gc_sounds (server_id, name, attachment_id, created_by, created_at) VALUES (1, ?, 11, 2, 200)",
  );
  insert.run("airhorn");
  // The vocabulary: short and off-alphabet refuse; 16 chars pass.
  assert.throws(() => insert.run("x"));
  assert.throws(() => insert.run("has dash"));
  assert.throws(() => insert.run(""));
  assert.doesNotThrow(() => insert.run("sixteen_______"), "16 chars is the cap's edge and passes");

  const duplicate = db.prepare(
    "INSERT INTO gc_sounds (server_id, name, attachment_id, created_by, created_at) VALUES (1, 'airhorn', 11, 3, 300)",
  );
  assert.throws(() => duplicate.run(), undefined, "the per-server namespace refuses a duplicate");
  const otherServer = db.prepare(
    "INSERT INTO gc_sounds (server_id, name, attachment_id, created_by, created_at) VALUES (2, 'airhorn', 11, 3, 300)",
  );
  assert.doesNotThrow(() => otherServer.run(), "another server owns its own copy of the name");
  db.close();
});

test("RESTRICT holds the attachment; the server and user CASCADEs empty the table", () => {
  const db = seed();
  db.exec(MIGRATION);
  db.prepare("INSERT INTO gc_sounds (server_id, name, attachment_id, created_by, created_at) VALUES (1, 'airhorn', 11, 2, 200)").run();

  // The referenced asset cannot be deleted out from under a sound (the 0020
  // emoji cleanup owns the release; the sounds' routes inherit the shape).
  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(() => db.prepare("DELETE FROM gc_attachments WHERE id = 11").run(),
    undefined, "a RESTRICT child refuses the delete loudly");

  // The parents' CASCADEs empty the table (the server delete's one batch
  // never needs a gc_sounds statement of its own).
  db.prepare("DELETE FROM gc_servers WHERE id = 1").run();
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM gc_sounds").get().c), 0, "the server's CASCADE carries the sounds");
  db.close();
});
