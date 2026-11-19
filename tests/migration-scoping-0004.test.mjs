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

// Migration 0004 scoping pin: 0004 adds server discovery + invite links on
// the SHARED wempo-forum-data D1 (one ledger, one 0003 taken by a parallel
// worker). Every statement must target a gc_-prefixed object; `users` and
// `gc_servers` are only ever FK REFERENCES targets, never written.
//
// Reuses the strict statement splitter from the 0001 scoping test, but keeps
// its own classifier because 0004 legitimately ships two statement forms that
// the 0001 pin (written before this migration existed) rejects as
// unrecognized: ALTER TABLE (the gc_servers.is_public add) and CREATE INDEX
// IF NOT EXISTS (the shared-ledger variant).
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
  "0004_discovery_invites.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

// classify0004: { form, name, target } or { form: "unrecognized" }.
function classify0004(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  let m = /^(ALTER\s+TABLE)\s+([\w"'.]+)/i.exec(plain);
  if (m) return { form: "ALTER TABLE", name: m[2], target: m[2] };

  m = /^(CREATE\s+TABLE)\s+(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE TABLE", name: m[3], target: m[3], ifNotExists: Boolean(m[2]) };

  m = /^(CREATE\s+INDEX)\s+(?:UNIQUE\s+)?(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)\s+ON\s+([\w"'.]+)/is.exec(plain);
  if (m) {
    return {
      form: "CREATE INDEX",
      name: m[3],
      target: m[4],
      ifNotExists: Boolean(m[2]),
    };
  }

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
// Indexes follow 0001's project convention: idx_gc_<table>_<concern>.
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0004 only targets gc_-prefixed objects, with only known statement forms", () => {
  const offenders = statements
    .map(classify0004)
    .filter((classified) =>
      classified.form === "unrecognized" ||
      !gc(classified.target) ||
      (classified.form === "CREATE INDEX"
        ? !gcIndex(classified.name)
        : !gc(classified.name)))
    .map((classified) => classified.form + " " + (classified.name || ""));

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0004 has no DROP, PRAGMA, UPDATE, or forum-table writes", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(stripped, /\bDROP\b/i);
  assert.doesNotMatch(stripped, /\bPRAGMA\b/i);
  assert.doesNotMatch(stripped, /\bUPDATE\b/i);
  assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stripped, /\bINSERT\s+INTO\b/i);
  // The ALTER is gc_servers only — the forum's users table is never altered.
  const alters = statements.map(classify0004).filter((c) => c.form === "ALTER TABLE");
  for (const alter of alters) assert.equal(alter.name, "gc_servers");
});

test("0004 adds exactly the is_public column with the NOT NULL DEFAULT 0 backfill", () => {
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_servers\s+ADD\s+COLUMN\s+is_public\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0(;|\n)/i,
  );
  assert.equal(
    statements.map(classify0004).filter((c) => c.form === "ALTER TABLE").length,
    1,
    "a second ALTER in 0004 belongs in its own region/migration",
  );
});

test("0004 creates gc_invites with the invited contract", () => {
  const invitesTable = statements
    .map(classify0004)
    .find((c) => c.form === "CREATE TABLE" && c.name === "gc_invites");
  assert.ok(invitesTable, "gc_invites table is created by 0004");
  assert.ok(invitesTable.ifNotExists, "gc_invites uses CREATE TABLE IF NOT EXISTS");

  const body = sql.slice(sql.indexOf("gc_invites"));
  assert.match(body, /code\s+TEXT\s+PRIMARY\s+KEY/i);
  assert.match(body, /server_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+gc_servers\(id\)\s+ON\s+DELETE\s+CASCADE/i);
  assert.match(body, /created_by\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)/i);
  assert.match(body, /created_at\s+INTEGER\s+NOT\s+NULL/i);
  assert.match(body, /uses\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
});

test("0004 ships exactly two gc_-prefixed IF NOT EXISTS indexes", () => {
  const indexes = statements.map(classify0004).filter((c) => c.form === "CREATE INDEX");
  assert.equal(indexes.length, 2, "exactly one index per concern: invites by server, servers by is_public");
  for (const index of indexes) {
    assert.ok(index.ifNotExists, "the shared ledger needs CREATE INDEX IF NOT EXISTS");
    assert.ok(gcIndex(index.name), "index name is idx_gc_-prefixed: " + index.name);
    assert.ok(gc(index.target), "indexed table is gc_-prefixed: " + index.target);
  }
  const names = indexes.map((index) => index.name);
  assert.ok(names.includes("idx_gc_invites_server"), names.join(", "));
  assert.ok(names.includes("idx_gc_servers_is_public"), names.join(", "));
});
