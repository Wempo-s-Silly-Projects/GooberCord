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

// Migration 0020 scoping: the gc_emoji + gc_stickers twin tables. The static
// pins hold the scoping (two CREATEs only, every referenced object gc_-owned
// or the shared users/gc_servers/gc_attachments FK targets, forum tables
// untouched); the real-SQLite pins hold the shape (name CHECK arms, the
// per-server UNIQUE namespace, the attachment's RESTRICT — a referenced
// image cannot be deleted out from under an emoji row).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0020_emoji_stickers.sql"), "utf8");
const stripped = (s) => s.replace(/--[^\n]*/g, " ").trim();

test("migration 0020 is exactly two twin CREATEs of gc_ objects, gc_-scoped", () => {
  const body = stripped(MIGRATION);
  const statements = body.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2, "the twin tables are the whole migration");
  for (const statement of statements) {
    assert.match(statement, /^CREATE TABLE IF NOT EXISTS gc_/);
  }
  // The gc_-only scope rule (FK targets are the shared users account table
  // and the two gc_-owned media objects — never a forum table).
  const names = [...body.matchAll(/\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|REFERENCES|ALTER\s+TABLE|FROM|UPDATE)\s+([\w"]+)/gi)].map((m) => m[1]);
  for (const name of names) {
    assert.match(name, /^(?:gc_|users$)/, "0020 references only gc_ objects (+ shared users): " + name);
  }
  // The chat-import lane's discipline holds here too — no forum table name
  // appears in ANY statement.
  for (const forum of ["chat_messages", "dm_messages", "dm_threads"]) {
    assert.equal(body.includes(forum), false, "no forum table named: " + forum);
  }
});

test("both twins pin the same namespace: name alphabet + per-server UNIQUE + RESTRICT attachment", () => {
  for (const table of ["gc_emoji", "gc_stickers"]) {
    const block = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?\\);`).exec(MIGRATION)[0];
    assert.match(block, /name TEXT NOT NULL CHECK\(length\(name\) BETWEEN 2 AND 16/);
    assert.match(block, /name GLOB '\[A-Za-z0-9_\]\[A-Za-z0-9_\]\*'/);
    assert.match(block, /name NOT GLOB '\*\[\^A-Za-z0-9_\]\*'/);
    assert.match(block, /UNIQUE\(server_id, name\)/);
    assert.match(block, /attachment_id INTEGER NOT NULL\s+REFERENCES gc_attachments\(id\) ON DELETE RESTRICT/);
    assert.match(block, /REFERENCES gc_servers\(id\) ON DELETE CASCADE/);
    assert.match(block, /REFERENCES users\(id\) ON DELETE CASCADE/);
  }
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY,
      message_id INTEGER NULL,
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    INSERT INTO users (id) VALUES (7);
    INSERT INTO gc_servers (id) VALUES (3);
    INSERT INTO gc_attachments (id, uploader_id, mime, size_bytes, status, created_at)
      VALUES (9, 7, 'image/png', 100, 'pending', 1);
  `);
  db.exec(MIGRATION);
  return db;
}

test("real-SQLite: the name CHECK arms hold, the namespace is per-server, RESTRICT guards the picture", () => {
  const db = fixture();
  const insert = () =>
    db.prepare("INSERT INTO gc_emoji (server_id, name, attachment_id, created_by, created_at) VALUES (3, ?, 9, 7, 1)");
  insert().run("partyparrot");
  // Alphabet arms: too short, too long, a hyphen, and a non-ASCII char all throw.
  for (const bad of ["a", "x".repeat(17), "bad-name", "ñao", "a b", ""]) {
    assert.throws(() => insert().run(bad), /CHECK/, "rejected name: " + JSON.stringify(bad));
  }
  // The 16-char ceiling and the full alphabet pass.
  assert.doesNotThrow(() => insert().run("a".repeat(16)));
  // The namespace is per-server: the SAME name is free on another server, the
  // UNIQUE throws inside one.
  db.prepare("INSERT INTO gc_servers (id) VALUES (4)").run();
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO gc_emoji (server_id, name, attachment_id, created_by, created_at) VALUES (4, 'partyparrot', 9, 7, 1)").run());
  assert.throws(
    () => db.prepare("INSERT INTO gc_emoji (server_id, name, attachment_id, created_by, created_at) VALUES (3, 'partyparrot', 9, 7, 1)").run(),
    /UNIQUE/,
  );
  // The attachment FK is RESTRICT: a referenced picture cannot be deleted
  // out from under the emoji row — but leaves cleanly once the row does.
  assert.throws(() => db.prepare("DELETE FROM gc_attachments WHERE id = 9").run(), /FOREIGN KEY/);
  db.prepare("DELETE FROM gc_emoji").run();
  assert.doesNotThrow(() => db.prepare("DELETE FROM gc_attachments WHERE id = 9").run());
  db.close();
});

test("real-SQLite: the sticker twin is its own namespace, same rules", () => {
  const db = fixture();
  db.prepare(
    "INSERT INTO gc_stickers (server_id, name, attachment_id, created_by, created_at) VALUES (3, 'stick1_2', 9, 7, 1)",
  ).run();
  // A sticker name never collides with an emoji name (SEPARATE namespaces).
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO gc_emoji (server_id, name, attachment_id, created_by, created_at) VALUES (3, 'stick1_2', 9, 7, 1)").run());
  // The CHECK arms apply identically.
  assert.throws(() =>
    db.prepare("INSERT INTO gc_stickers (server_id, name, attachment_id, created_by, created_at) VALUES (3, 'bad name', 9, 7, 1)").run(),
    /CHECK/);
  // The server CASCADE removes a server's whole twin inventory with it.
  db.prepare("DELETE FROM gc_servers WHERE id = 3").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_emoji").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_stickers").get().n, 0);
  db.close();
});
