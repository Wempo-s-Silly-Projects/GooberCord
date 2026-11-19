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

// Migration 0010 scoping pin: the filter/AutoMod batch (per-server filter
// rules + the hit alerts feed) on the SHARED wempo-forum-data D1. Same
// contract as the 0006/0007/0008 pins: every statement targets a gc_-prefixed
// object; `users` is never created, altered, or written (it is only ever a
// read-only FK target). The file carries ONLY CREATE TABLE / CREATE INDEX
// forms, all IF NOT EXISTS for the ledger's idempotent re-apply, and applies
// cleanly right after 0001 as well as on a database that already carries
// 0009 (no statement order dependence — the apply-cleanly pin rides
// tests/filter-rules.test.mjs's real-SQLite check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf } from "./migration-scoping.test.mjs";

const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "0010_filter_upgrades.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

// Same classify shape the 0008 pin uses (the two migrations ship the same
// statement forms).
function classify0010(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  const createTable =
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([\w"'.]+)/i.exec(plain);
  if (createTable) {
    return { form: "CREATE TABLE", name: createTable[1], target: createTable[1], ifNotExists: true };
  }

  const createIndex =
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)\s+ON\s+([\w"'.]+)/is.exec(plain);
  if (createIndex) {
    return { form: "CREATE INDEX", name: createIndex[1], target: createIndex[2], ifNotExists: true };
  }

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0010 only targets gc_-prefixed objects with known statement forms", () => {
  const offenders = statements
    .map(classify0010)
    .filter((c) =>
      c.form === "unrecognized" ||
      !gc(c.target) ||
      (c.form === "CREATE INDEX" ? !gcIndex(c.name) : !gc(c.name)))
    .map((c) => c.form + " " + (c.name || ""));
  assert.deepEqual(offenders, []);
  assert.ok(statements.length >= 5, "parsed at least one statement");
});

test("migration 0010 is CREATE-only (no ALTER/DROP/write of any kind)", () => {
  const bare = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(
    bare,
    /ALTER|DROP|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+|SET\s+\w+\s+=|PRAGMA/i,
  );
});

test("migration 0010 carries the two tables and their indexes, and no care storage", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gc_filter_rules/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gc_filter_alerts/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_gc_filter_rules_server/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_gc_filter_alerts_server/);
  // The Care contract: a hit is the response field and NOTHING in storage —
  // no care table, no notification inbox.
  assert.doesNotMatch(sql, /gc_filter_care|care_hits|notify/);
});
