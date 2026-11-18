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

// Migration 0032 scoping (T86, docs/drafts/t86-goober-jobs-spec.md): the
// Goober Jobs' three NEW tables, no rebuild anywhere (every statement is a
// CREATE — 0024's canary law has nothing to guard, no DROP, no RENAME, no
// ALTER). The privacy law rides in-schema: gc_job_counters carries NO member
// column by construction (counters ONLY — a counter answers "the server did
// this many", never "who did it"), and gc_job_finishes' PK is the
// double-finish fingerprint the finish claim's changes verdict rides. The
// defaults law rides in-schema too: gc_server_jobs.enabled is DEFAULT 0 — a
// server's jobs do not exist until its owner opts in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0032_gc_server_jobs.sql"),
  "utf8",
);

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "").split(";")
    .map((part) => part.trim()).filter(Boolean);
}

test("the file is exactly three CREATEs, no rebuild", () => {
  const list = migrationStatements();
  assert.equal(list.length, 3, `three statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_server_jobs \(/);
  assert.match(list[1], /^CREATE TABLE gc_job_counters \(/);
  assert.match(list[2], /^CREATE TABLE gc_job_finishes \(/);
  const body = MIGRATION;
  assert.equal((body.match(/DROP TABLE/g) || []).length, 0, "no DROP anywhere");
  assert.equal((body.match(/RENAME TO/g) || []).length, 0, "no RENAME anywhere");
  assert.equal((body.match(/ALTER TABLE/g) || []).length, 0, "no ALTER anywhere");
  assert.equal(body.includes("CREATE TABLE gc_channels_fk_canary"), false,
    "no canary rides: there is no rebuild to guard");
});

test("the three shapes carry the slate's law in-schema", () => {
  const list = migrationStatements();
  // The defaults law: the opt-in row is OFF until a mod turns it on.
  assert.match(list[0], /enabled INTEGER NOT NULL DEFAULT 0 CHECK \(enabled IN \(0, 1\)\)/);
  assert.match(list[0], /server_id INTEGER PRIMARY KEY REFERENCES gc_servers\(id\) ON DELETE CASCADE/);
  // The privacy law: the counters ONLY — no member column exists to attrit.
  assert.match(list[1], /counter INTEGER NOT NULL DEFAULT 0 CHECK \(counter >= 0\)/);
  assert.match(list[1], /PRIMARY KEY \(server_id, week_key, kind\)/);
  assert.doesNotMatch(list[1], /user_id|member_id|REFERENCES users/,
    "gc_job_counters carries NO member column — counters are aggregate-only");
  // The double-finish fingerprint: ONE row per server/week/job, and the
  // conservation seat is fixed at the finish bonus.
  assert.match(list[2], /PRIMARY KEY \(server_id, week_key, job_id\)/);
  assert.match(list[2], /paid_total INTEGER NOT NULL CHECK \(paid_total = 100\)/);
});

// --- the fresh-db smoke (FK-enforcing runner: the CASCADE dies with the
// server, the CHECKs are the counters' and finishes' own teeth) ---

const SEED = `
  CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
`;

test("the tables apply fresh, the defaults arm and the CHECKs enforce, the cascade dies with the server", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  db.exec(SEED);
  db.exec(MIGRATION);
  db.exec("INSERT INTO gc_servers VALUES (1)");
  db.exec(
    "INSERT INTO gc_server_jobs (server_id, enabled, updated_at) VALUES (1, 1, 1)");
  db.exec(
    "INSERT INTO gc_job_counters (server_id, week_key, kind, counter) VALUES (1, 100, 'message', 250)");
  db.exec(
    "INSERT INTO gc_job_finishes (server_id, week_key, job_id, paid_total, finished_at) " +
      "VALUES (1, 100, 'wash_day', 100, 200)");
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gc_%' " +
    "AND name != 'gc_servers' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(tables, ["gc_job_counters", "gc_job_finishes", "gc_server_jobs"]);
  // The defaults law in-schema: the column's DEFAULT answers the absent row.
  assert.equal(
    db.prepare("SELECT enabled FROM gc_server_jobs WHERE server_id = 1").get().enabled, 1,
  );
  // The counters' floor and the conservation seat: a negative count and an
  // off-bonus paid_total both abort loudly.
  assert.throws(() => db.exec(
    "INSERT INTO gc_job_counters (server_id, week_key, kind, counter) VALUES (1, 101, 'voice', -1)"));
  assert.throws(() => db.exec(
    "INSERT INTO gc_job_finishes (server_id, week_key, job_id, paid_total, finished_at) " +
      "VALUES (1, 101, 'kindling', 60, 2)"));
  // The double-finish fingerprint IS the PK: a same-week re-finish inserts
  // nothing (a UNIQUE violation rides the primary key under the FK runner).
  assert.throws(() => db.exec(
    "INSERT INTO gc_job_finishes (server_id, week_key, job_id, paid_total, finished_at) " +
      "VALUES (1, 100, 'wash_day', 100, 300)"));
  // The cascade: the server's jobs state, counters, and finishes all die
  // with the server.
  db.exec("DELETE FROM gc_servers WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_jobs").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_job_counters").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_job_finishes").get().n, 0);
});
