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

// Migration 0012 scoping pin: the server rules gate's two columns on the
// SHARED wempo-forum-data D1. Same contract as the 0006/0007/0008 pins: every
// statement targets a gc_-prefixed object, and the forum's tables (users
// among them) are never created, altered, or written. This migration is the
// smallest shape the contract admits: NO new tables at all — the gate is two
// ALTER TABLE ADD COLUMN statements on GooberCord's own gc_servers and
// gc_server_members.
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
  "0012_rules_gate.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

// Same classify shape the 0008 pin uses.
function classify0012(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  const m = /^ALTER\s+TABLE\s+([\w"'.]+)/i.exec(plain);
  if (m) return { form: "ALTER TABLE", name: m[1], target: m[1] };

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));

test("migration 0012 only targets gc_-prefixed objects with the two-column shape", () => {
  const offenders = statements
    .map(classify0012)
    .filter((c) => c.form === "unrecognized" || !gc(c.target))
    .map((c) => c.form + " " + (c.name || ""));

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0012 creates NO tables and writes nothing — two ALTERs, both GooberCord's", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  // The whole migration is additive schema: no DROPs, no data writes, no
  // settings pokes — the two columns on the existing gc_ tables are it.
  assert.doesNotMatch(stripped, /\bCREATE\b/i, "no new tables: the gate rides two existing gc_ tables");
  assert.doesNotMatch(stripped, /\bDROP\b/i);
  assert.doesNotMatch(stripped, /\bPRAGMA\b/i);
  assert.doesNotMatch(stripped, /\bUPDATE\b/i, "no data writes");
  assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stripped, /\bINSERT\s+INTO\b/i);

  const alters = statements.map(classify0012).filter((c) => c.form === "ALTER TABLE");
  assert.equal(alters.length, 2, "the two gate columns are the only ALTERs");
  assert.deepEqual(
    alters.map((c) => c.name),
    ["gc_servers", "gc_server_members"],
  );
  // The forum's users table appears only as the header prose — never as a
  // statement target.
  assert.doesNotMatch(
    stripped,
    /ALTER\s+TABLE\s+users/i,
    "the forum's users table is never altered",
  );
});

test("0012's two columns carry the gate's contract", () => {
  // The owner's rules document: NULL is the gate OFF (every pre-0012 server's
  // behavior), a set document turns the gate ON.
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_servers\s+ADD\s+COLUMN\s+rules_text\s+TEXT\s+NULL(;|\n)/i,
  );
  // Per-member acceptance: NULL until the accept/manual-verify routes fill it.
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_server_members\s+ADD\s+COLUMN\s+rules_accepted_at\s+INTEGER\s+NULL(;|\n)/i,
  );
});
