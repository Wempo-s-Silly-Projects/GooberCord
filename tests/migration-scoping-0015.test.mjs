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

// Migration 0015 scoping: the group-channel icon column. A bare nullable
// ALTER (the exact 0003 server-icon pattern — no FK, the intake guard lives
// in the route's UPDATE WHERE), so the real-SQLite pins are small: the only
// table named is gc_channels, existing rows survive with a NULL icon, and a
// set value is usable/readable like any int column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0015_group_channel_icon.sql"), "utf8");

test("migration 0015 touches ONLY gc_channels, as a single ADD COLUMN", () => {
  const stripped = MIGRATION.replace(/--[^\n]*/g, " ").trim();
  const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 1, "0015 is exactly one statement");
  assert.match(statements[0], /^ALTER TABLE gc_channels ADD COLUMN icon_media_id INTEGER NULL$/);
  // The gc_-only scope rule.
  const names = [...stripped.matchAll(/\b(?:ALTER\s+TABLE|REFERENCES|FROM|UPDATE)\s+([\w"]+)/gi)].map((m) => m[1]);
  for (const name of names) assert.match(name, /^gc_/, "0015 only touches GooberCord objects: " + name);
});

test("real-SQLite: existing rows survive the ALTER with a NULL icon, then carry set values", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gc_channels (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('dm','group')),
      server_id INTEGER NULL,
      name TEXT,
      last_message_id INTEGER NULL,
      last_message_at INTEGER NULL);
    INSERT INTO gc_channels (id, kind, server_id, name) VALUES
      (1, 'dm', NULL, NULL), (2, 'group', NULL, 'group');
  `);

  db.exec(MIGRATION);

  const rows = db.prepare("SELECT id, icon_media_id FROM gc_channels ORDER BY id").all();
  assert.deepEqual(
    rows.map((row) => ({ id: Number(row.id), icon: row.icon_media_id })),
    [{ id: 1, icon: null }, { id: 2, icon: null }],
    "both pre-0015 rows keep their identity with a NULL icon",
  );

  db.prepare("UPDATE gc_channels SET icon_media_id = ? WHERE id = ?").run(33, 2);
  assert.equal(db.prepare("SELECT icon_media_id AS icon FROM gc_channels WHERE id = 2").get().icon, 33);
});
