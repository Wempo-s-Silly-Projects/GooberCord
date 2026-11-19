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

// Migration 0027 scoping (W-B1.5's rider): the gc_filter_rules CHECK
// widening the AutoMod constants demand. Static pins: the five-statement
// childless rebuild (CREATE / INSERT..SELECT / DROP / RENAME / index), the
// two widened arms verbatim — timeout_minutes now admits 40320 (28 days)
// and the terms bound 16384 → 65536 (a maxed 1000-term x 60-char rule is
// ~63k JSON chars; 0010's bound refused it at write time) — every other
// CHECK carried verbatim. Real-SQLite pins: the rebuild is childless (nothing
// REFERENCES gc_filter_rules), so the FIVE-STATEMENT family needs no canary
// table (the 0024 discipline is a populated PARENT's drop), the apply under
// FK enforcement carries populated rows, and each new bound admits its
// parity shape while refusing past itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(path.join(HERE, "..", "migrations", "0027_filter_widenings.sql"), "utf8");
const ORIGINAL = readFileSync(path.join(HERE, "..", "migrations", "0010_filter_upgrades.sql"), "utf8");

function migrationStatements() {
  return MIGRATION.replace(/--[^\n]*/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

const statements = migrationStatements();

test("the file's shape: the four-statement childless rebuild plus its index", () => {
  assert.equal(statements.length, 5, `five statements expected, got ${statements.length}`);
  assert.match(statements[0], /^CREATE TABLE gc_filter_rules_rebuild\b/);
  assert.match(statements[1], /^INSERT INTO gc_filter_rules_rebuild/);
  assert.match(statements[2], /^DROP TABLE gc_filter_rules\b/);
  assert.match(statements[3], /^ALTER TABLE gc_filter_rules_rebuild RENAME TO gc_filter_rules\b/);
  assert.match(statements[4], /^CREATE INDEX IF NOT EXISTS idx_gc_filter_rules_server\b/);
  // The copy carries the identity column AND every rule column.
  assert.match(statements[1], /SELECT\s+id, server_id, name, terms,/);
});

test("the two widened CHECKs ride their cited bounds and the rest carries verbatim", () => {
  const create = statements[0];
  // The parity timeout menu: the 28-day seat.
  assert.ok(create.includes(
    "timeout_minutes IN (1, 5, 10, 60, 1440, 10080, 40320)",
  ), "the timeout CHECK admits the 28d seat");
  // The terms budget: a maxed 1000-term x 60-char rule is ~63k JSON chars.
  assert.ok(create.includes("length(terms) BETWEEN 2 AND 65536"));
  // Everything else is the 0010 spelling — arms this migration never meant
  // to move must not have mooved.
  const original = ORIGINAL.slice(ORIGINAL.indexOf("CREATE TABLE IF NOT EXISTS gc_filter_rules"));
  for (const arm of [
    "length(trim(name)) BETWEEN 1 AND 64",
    "length(exempt_role_ids) <= 4096",
    "length(exempt_channel_ids) <= 4096",
    "length(actions) BETWEEN 2 AND 64",
    "is_care IN (0, 1)",
    "check_names IN (0, 1)",
    "length(block_message) <= 150",
    "REFERENCES gc_servers(id) ON DELETE CASCADE",
    "REFERENCES users(id)",
  ]) {
    assert.ok(original.includes(arm) && create.includes(arm), `the arm carries verbatim: ${arm}`);
  }
  // And the childless claim: no table ever references gc_filter_rules —
  // the drop cannot strand a foreign key.
  for (const file of ["0001_initial_goobercord.sql", "0002_vendored_core_tables.sql", "0010_filter_upgrades.sql"]) {
    const text = readFileSync(path.join(HERE, "..", "migrations", file), "utf8");
    assert.ok(!text.includes("REFERENCES gc_filter_rules"), file + " has no gc_filter_rules child");
  }
});

// The pre-state: gc_filter_rules at its 0010 CHECKs with rows, the FK
// parents resolved. The server's rules carry through the copy verbatim.
function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
    ${ORIGINAL.slice(ORIGINAL.indexOf("CREATE TABLE IF NOT EXISTS gc_filter_rules"))}
    INSERT INTO users VALUES (2);
    INSERT INTO gc_servers VALUES (1);
    INSERT INTO gc_filter_rules (
      id, server_id, name, terms, actions, is_care, check_names,
      created_by, created_at, updated_at
    ) VALUES (7, 1, 'swears', '["dog"]', '["block"]', 0, 1, 2, 100, 100);
  `);
  return db;
}

test("the migration applies under FK enforcement and carries every populated rule", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
  const row = db.prepare("SELECT id, name, terms, timeout_minutes FROM gc_filter_rules").get();
  assert.equal(row.id, 7, "the rule row rode the copy verbatim");
  assert.equal(row.name, "swears");
  assert.equal(row.timeout_minutes, null);
  // The old menu still stores; the 28d seat now stores too.
  db.prepare("UPDATE gc_filter_rules SET timeout_minutes = 10080 WHERE id = 7").run();
  db.prepare("UPDATE gc_filter_rules SET timeout_minutes = 40320 WHERE id = 7").run();
  const seat = Number(db.prepare("SELECT timeout_minutes FROM gc_filter_rules WHERE id = 7").get().timeout_minutes);
  assert.equal(seat, 40320, "28 days rides the widened CHECK");
  // An off-menu value still refuses (20160 = 2 weeks was never on it).
  assert.throws(() =>
    db.prepare("UPDATE gc_filter_rules SET timeout_minutes = 20160 WHERE id = 7").run(),
    undefined, "the off-menu seat refuses");
  db.close();
});

test("the widened terms bound admits the maxed keyword rule and the timeout keeps refusing past 40320", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
  // 1000 terms x 60 chars, JSON-encoded: ~63,000 chars of `["...","..."]`.
  const terms = JSON.stringify(Array.from({ length: 1000 }, (_, i) => "t".repeat(20) + String(i).padStart(4, "0")));
  assert.ok(terms.length > 16384, "the maxed rule outruns the OLD bound — that is why 0027 exists");
  assert.ok(terms.length <= 65536, "the maxed rule fits the widened bound");
  db.prepare("UPDATE gc_filter_rules SET terms = ? WHERE id = 7").run(terms);
  // And the widened bound refuses past itself.
  assert.throws(() =>
    db.prepare("UPDATE gc_filter_rules SET terms = ? WHERE id = 7").run("x".repeat(65537)),
    undefined, "the terms bound refuses past 65536");
  db.close();
});
