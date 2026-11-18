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

// Migration 0030 scoping (T76, docs/drafts/t76-economy-slate-spec.md): the
// economy slate's four NEW tables, no rebuild anywhere (every statement is a
// CREATE — 0024's canary law has nothing to guard and the file must carry no
// DROP and no RENAME). The sink law rides in-schema: the pool column's floor
// CHECK is the draw batch's loud backstop, the chain fee's marker seat is
// deliberately FK-free (the no-shared-server corner still sinks), and the
// chain's ONLY identity pointer is the hold map — gc_chain_hops carries no
// member column by construction, and both CASCADE laws die with their rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0030_gc_economy.sql"),
  "utf8",
);

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "").split(";")
    .map((part) => part.trim()).filter(Boolean);
}

test("the file is exactly six statements: four CREATEs and their two indexes, no rebuild", () => {
  const list = migrationStatements();
  assert.equal(list.length, 6, `six statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_well_streaks \(/);
  assert.match(list[1], /^CREATE TABLE gc_campfires \(/);
  assert.match(list[2], /^CREATE TABLE gc_chain_hops \(/);
  assert.match(list[3], /^CREATE INDEX idx_gc_chain_hops_expiry ON gc_chain_hops\(expires_at\)$/);
  assert.match(list[4], /^CREATE TABLE gc_chain_hold \(/);
  assert.match(list[5], /^CREATE INDEX idx_gc_chain_hold_user ON gc_chain_hold\(user_id\)$/);
  const body = MIGRATION;
  assert.equal((body.match(/DROP TABLE/g) || []).length, 0, "no DROP anywhere");
  assert.equal((body.match(/RENAME TO/g) || []).length, 0, "no RENAME anywhere");
  assert.equal((body.match(/ALTER TABLE/g) || []).length, 0, "no ALTER anywhere");
  assert.equal(body.includes("CREATE TABLE gc_channels_fk_canary"), false,
    "no canary rides: there is no rebuild to guard");
});

test("the four shapes carry the slate's law in-schema", () => {
  const list = migrationStatements();
  assert.match(list[0], /user_id INTEGER PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(list[0], /bonus_percent INTEGER NOT NULL DEFAULT 0\s+CHECK \(bonus_percent BETWEEN 0 AND 200\)/);
  assert.match(list[1], /server_id INTEGER PRIMARY KEY REFERENCES gc_servers\(id\) ON DELETE CASCADE/);
  assert.match(list[1], /pool INTEGER NOT NULL DEFAULT 0 CHECK \(pool >= 0\)/,
    "the pool floor: the draw batch's backstop");
  assert.match(list[2], /hop_token TEXT PRIMARY KEY/);
  assert.match(list[2], /depth INTEGER NOT NULL CHECK \(depth >= 1\)/);
  assert.match(list[2], /pool_server_id INTEGER NOT NULL/);
  assert.doesNotMatch(list[2], /user_id|REFERENCES users/,
    "gc_chain_hops carries NO member column — the hop chain is anonymous by construction");
  assert.match(list[4], /hop_token TEXT PRIMARY KEY REFERENCES gc_chain_hops\(hop_token\) ON DELETE CASCADE/);
  assert.match(list[4], /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
});

// --- the fresh-db smoke (FK-ENFORCING runner: D1 enforces FKs at write time,
// the DDL-time non-enforcement is 0034-verified, and 0030 does no DDL drops) ---

const SEED = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
  CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
`;

test("the tables apply fresh, the pool floor and depth CHECKs enforce, and the cascades fire", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  db.exec(SEED);
  db.exec(MIGRATION);
  db.exec(`
    INSERT INTO users VALUES (7, 'wempos');
    INSERT INTO gc_servers VALUES (1);
    INSERT INTO gc_well_streaks (user_id, streak_days, bonus_percent, last_claim_day, updated_at)
      VALUES (7, 3, 60, 100, 100);
    INSERT INTO gc_campfires (server_id, fuel, pool, updated_at) VALUES (1, 400, 500, 1);
    INSERT INTO gc_chain_hops (hop_token, depth, amount, pool_server_id, expires_at, created_at)
      VALUES ('tok', 1, 50, 1, 9, 1);
    INSERT INTO gc_chain_hold (hop_token, user_id, created_at) VALUES ('tok', 7, 1);
  `);
  // (The SEED's own gc_servers rides the name LIKE too — the four NEW table
  // names are the migration's, queried over the created-and-named set.)
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gc_%' " +
    "AND name != 'gc_servers' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(tables, ["gc_campfires", "gc_chain_hold", "gc_chain_hops", "gc_well_streaks"]);
  // The pool's floor: an overdrawing draw aborts loudly.
  assert.throws(() => db.exec("UPDATE gc_campfires SET pool = -1 WHERE server_id = 1"));
  // The depth floor and the marker seat: depth 0 refuses; the marker pool 0
  // banks a fee with no campfire row beneath it (the no-FK corner).
  assert.throws(() => db.exec(
    "INSERT INTO gc_chain_hops (hop_token, depth, amount, pool_server_id, expires_at, created_at) " +
    "VALUES ('tok2', 0, 50, 1, 9, 1)"));
  db.exec(
    "INSERT INTO gc_chain_hops (hop_token, depth, amount, pool_server_id, expires_at, created_at) " +
    "VALUES ('tok3', 1, 50, 0, 9, 1)");
  // The cascades: the hop's token carries its hold; the member's rows die
  // with the account on BOTH tables.
  db.exec("DELETE FROM gc_chain_hops WHERE hop_token = 'tok'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_chain_hold").get().n, 0,
    "the resolved hop takes its hold row with it");
  db.exec("DELETE FROM users WHERE id = 7");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_well_streaks").get().n, 0,
    "a deleted member carries their Well row out");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_chain_hold").get().n, 0,
    "a deleted member carries their hold rows out");
});
