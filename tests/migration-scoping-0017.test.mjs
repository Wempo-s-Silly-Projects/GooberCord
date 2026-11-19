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

// Migration 0017 scoping: the invite lifecycle columns. Three bare nullable
// ALTERs on gc_invites (0004's table) — no rebuild, no FK work.
// Real-SQLite pins: a pre-0017 invite survives all three statements with
// NULLs (never/unlimited/live behavior), then carries set values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0017_invite_management.sql"), "utf8");

test("migration 0017 touches ONLY gc_invites, as exactly three ADD COLUMN statements", () => {
  const stripped = MIGRATION.replace(/--[^\n]*/g, " ").trim();
  const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, [
    "ALTER TABLE gc_invites ADD COLUMN expires_at INTEGER NULL",
    "ALTER TABLE gc_invites ADD COLUMN max_uses INTEGER NULL",
    "ALTER TABLE gc_invites ADD COLUMN revoked_at INTEGER NULL",
  ]);
  const names = [...stripped.matchAll(/\b(?:ALTER\s+TABLE|REFERENCES|FROM|UPDATE)\s+([\w"]+)/gi)].map((m) => m[1]);
  for (const name of names) assert.match(name, /^gc_/, "0017 only touches GooberCord objects: " + name);
});

test("real-SQLite: a pre-0017 invite survives with NULLs, then carries set values", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    INSERT INTO users (id, username, role) VALUES (7, 'wempos', 'member');
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_user_id INTEGER NOT NULL);
    INSERT INTO gc_servers (id, name, owner_user_id) VALUES (3, 'goober', 7);
    CREATE TABLE gc_invites (
      code TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0);
    INSERT INTO gc_invites (code, server_id, created_by, created_at)
      VALUES ('Goober12', 3, 7, 5);
  `);

  db.exec(MIGRATION);

  assert.deepEqual(
    db.prepare("SELECT code, uses, expires_at, max_uses, revoked_at FROM gc_invites").all()
      .map((row) => ({
        code: row.code, uses: Number(row.uses),
        expires: row.expires_at, max: row.max_uses, revoked: row.revoked_at,
      })),
    [{ code: "Goober12", uses: 0, expires: null, max: null, revoked: null }],
    "the pre-0017 invite keeps its identity + counter, all three lifecycle columns NULL",
  );

  db.prepare("UPDATE gc_invites SET max_uses = ?, expires_at = ? WHERE code = ?")
    .run(4, 20, "Goober12");
  const updated = db.prepare("SELECT max_uses, expires_at FROM gc_invites WHERE code = 'Goober12'").get();
  assert.equal(Number(updated.max_uses), 4);
  assert.equal(Number(updated.expires_at), 20);
});
