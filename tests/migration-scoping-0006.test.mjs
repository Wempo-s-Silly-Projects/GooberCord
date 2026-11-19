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

// Migration 0006 scoping pin: phase-3 role foundation on the SHARED
// wempo-forum-data D1 (one ledger). Every statement must target a gc_-
// prefixed object; `users` and `gc_servers` are only ever FK REFERENCES
// targets, never altered. Reuses the 0001 splitter and the 0004 classifier
// convention (this migration's forms are ALTER TABLE / CREATE TABLE /
// CREATE INDEX IF NOT EXISTS).
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
  "0006_roles.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

// Same classify shape the 0004 pin uses (the two migrations ship the same
// statement forms); 0006 indexes are IF NOT EXISTS per the shared ledger.
function classify0006(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  let m = /^ALTER\s+TABLE\s+([\w"'.]+)/i.exec(plain);
  if (m) return { form: "ALTER TABLE", name: m[1], target: m[1] };

  m = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE TABLE", name: m[2], target: m[2], ifNotExists: Boolean(m[1]) };

  m = /^CREATE\s+INDEX\s+(?:UNIQUE\s+)?(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)\s+ON\s+([\w"'.]+)/is.exec(plain);
  if (m) {
    return { form: "CREATE INDEX", name: m[2], target: m[3], ifNotExists: Boolean(m[1]) };
  }

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0006 only targets gc_-prefixed objects with known statement forms", () => {
  const offenders = statements
    .map(classify0006)
    .filter((c) =>
      c.form === "unrecognized" ||
      !gc(c.target) ||
      (c.form === "CREATE INDEX" ? !gcIndex(c.name) : !gc(c.name)))
    .map((c) => c.form + " " + (c.name || ""));

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0006 has no DROP, PRAGMA, UPDATE, or forum-table writes", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(stripped, /\bDROP\b/i);
  assert.doesNotMatch(stripped, /\bPRAGMA\b/i);
  assert.doesNotMatch(stripped, /\bUPDATE\b/i);
  assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stripped, /\bINSERT\s+INTO\b/i);
  // The ALTERs are GooberCord's own gc_ tables only — the forum's users
  // table is never altered.
  for (const alter of statements.map(classify0006).filter((c) => c.form === "ALTER TABLE")) {
    assert.ok(alter.name === "gc_server_members" || alter.name === "gc_channels", alter.name);
  }
});

test("0006 creates gc_roles with the role contract", () => {
  const table = statements.map(classify0006)
    .find((c) => c.form === "CREATE TABLE" && c.name === "gc_roles");
  assert.ok(table, "gc_roles is created by 0006");
  assert.ok(table.ifNotExists, "gc_roles uses CREATE TABLE IF NOT EXISTS");
  const body = sql.slice(sql.indexOf("gc_roles"));
  assert.match(body, /id\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i);
  assert.match(body, /server_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+gc_servers\(id\)\s+ON\s+DELETE\s+CASCADE/i);
  assert.match(body, /name\s+TEXT\s+NOT\s+NULL\s+CHECK\(length\(trim\(name\)\)\s+BETWEEN\s+1\s+AND\s+32\)/i);
  // color: nullable, strictly lowercase #rrggbb (GLOB) when set.
  assert.match(body, /color\s+TEXT\s+NULL\s+CHECK\(color\s+IS\s+NULL/i);
  assert.match(body, /GLOB\s+'#\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]'/i);
  assert.match(body, /position\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  // permissions: the additive bitmask defaults to 0 (nothing extra).
  assert.match(body, /permissions\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  assert.match(body, /created_at\s+INTEGER\s+NOT\s+NULL/i);
});

test("0006 creates gc_member_roles with the (server, user, role) PK", () => {
  const table = statements.map(classify0006)
    .find((c) => c.form === "CREATE TABLE" && c.name === "gc_member_roles");
  assert.ok(table, "gc_member_roles is created by 0006");
  assert.match(sql, /PRIMARY KEY \(server_id, user_id, role_id\)/i);
  assert.match(
    sql,
    /role_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+gc_roles\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  );
  assert.match(
    sql,
    /user_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  );
});

test("0006 adds exactly the nickname and is_spoiler columns", () => {
  const alters = statements.map(classify0006).filter((c) => c.form === "ALTER TABLE");
  assert.equal(alters.length, 2, "nickname and is_spoiler are the only 0006 ALTERs");
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_server_members\s+ADD\s+COLUMN\s+nickname\s+TEXT\s+NULL/i,
  );
  // 1-32 trimmed chars or NULL (the display name, not free text).
  assert.match(sql, /CHECK\(nickname IS NULL OR length\(trim\(nickname\)\) BETWEEN 1 AND 32\)/i);
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_channels\s+ADD\s+COLUMN\s+is_spoiler\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0(;|\n)/i,
  );
});

test("0006 ships three gc_-prefixed IF NOT EXISTS indexes", () => {
  const indexes = statements.map(classify0006).filter((c) => c.form === "CREATE INDEX");
  assert.equal(indexes.length, 3, "roles by server; assignments by role and by (server, user)");
  for (const index of indexes) {
    assert.ok(index.ifNotExists, "the shared ledger needs CREATE INDEX IF NOT EXISTS");
    assert.ok(gcIndex(index.name), "index name is idx_gc_-prefixed: " + index.name);
    assert.ok(gc(index.target), "indexed table is gc_-prefixed: " + index.target);
  }
  const names = indexes.map((index) => index.name);
  assert.ok(names.includes("idx_gc_roles_server"), names.join(", "));
  assert.ok(names.includes("idx_gc_member_roles_role"), names.join(", "));
  assert.ok(names.includes("idx_gc_member_roles_server_user"), names.join(", "));
});
