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

// Migration 0016 scoping: the presence-tier column. One bare nullable ALTER on
// gc_member_status (the persisted truth the presence hub already overlays),
// NULL = online, CHECK pins the two overlay tiers. Real-SQLite pins: pre-0016
// rows survive untouched, the tier values admit, garbage refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0016_presence_state.sql"), "utf8");

test("migration 0016 touches ONLY gc_member_status, as a single ADD COLUMN", () => {
  const stripped = MIGRATION.replace(/--[^\n]*/g, " ").trim();
  const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 1, "0016 is exactly one statement");
  assert.match(statements[0], /^ALTER TABLE gc_member_status ADD COLUMN presence_state TEXT NULL/);
  assert.match(statements[0], /presence_state IS NULL OR presence_state IN \('idle','dnd'\)/);
  const names = [...stripped.matchAll(/\b(?:ALTER\s+TABLE|REFERENCES|FROM|UPDATE)\s+([\w"]+)/gi)].map((m) => m[1]);
  for (const name of names) assert.match(name, /^gc_/, "0016 only touches GooberCord objects: " + name);
});

test("real-SQLite: pre-0016 rows survive with a NULL tier and only the two overlay tiers admit", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    INSERT INTO users (id, username, role) VALUES (1, 'wempos', 'member'), (7, 'ada', 'member'),
      (9, 'gus', 'member'), (11, 'fem', 'member'), (13, 'ivy', 'member');
    CREATE TABLE gc_member_status (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status_text TEXT NULL CHECK(status_text IS NULL OR length(status_text) <= 128),
      status_until INTEGER NULL,
      updated_at INTEGER NOT NULL);
    INSERT INTO gc_member_status (user_id, status_text, status_until, updated_at)
      VALUES (1, 'building goobercord', NULL, 5);
  `);

  db.exec(MIGRATION);

  assert.deepEqual(
    db.prepare("SELECT user_id, status_text, presence_state FROM gc_member_status").all()
      .map((row) => ({ user: Number(row.user_id), text: row.status_text, tier: row.presence_state })),
    [{ user: 1, text: "building goobercord", tier: null }],
    "the pre-0016 row keeps its values with a NULL tier",
  );

  const insert = (userId, tier) => db.prepare(
    "INSERT INTO gc_member_status (user_id, status_text, status_until, presence_state, updated_at) VALUES (?, NULL, NULL, ?, 6)",
  ).run(Number(userId), tier);
  insert(7, "idle");
  insert(9, "dnd");
  assert.throws(() => insert(11, "superstar"), /CHECK/);
  // The PK still guards duplicates (a second row for the same user refuses).
  insert(11, "idle");
  assert.throws(() => insert(11, "idle"), /UNIQUE/);
  // The NULL default also passes the CHECK (the online vocabulary).
  db.prepare(
    "INSERT INTO gc_member_status (user_id, status_text, status_until, presence_state, updated_at) VALUES (?, NULL, NULL, NULL, 6)",
  ).run(Number(13));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_member_status").get().n, 5,
  );
});

test("real-SQLite: the CHECK admits an UPDATE through the tier's own vocabulary", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    INSERT INTO users (id, username, role) VALUES (1, 'wempos', 'member');
    CREATE TABLE gc_member_status (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status_text TEXT NULL,
      status_until INTEGER NULL,
      updated_at INTEGER NOT NULL);
    INSERT INTO gc_member_status (user_id, status_text, status_until, updated_at)
      VALUES (1, NULL, NULL, 5);
  `);
  db.exec(MIGRATION);
  // Pick online again: the PATCH's set-branch UPDATE carries NULL through the
  // CHECK happily, so a member can leave a tier.
  db.prepare("UPDATE gc_member_status SET presence_state = 'idle'").run();
  db.prepare("UPDATE gc_member_status SET presence_state = NULL").run();
  db.prepare("UPDATE gc_member_status SET presence_state = 'dnd'").run();
});
