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

// Migration 0007 scoping pin: phase-3 channel layers (categories, per-channel
// overwrites, slowmode) on the SHARED wempo-forum-data D1. Same contract as
// the 0006 pin: every statement targets a gc_-prefixed object; `users` is
// never touched and no forum table is created or altered. Reuses the 0001
// splitter and the 0006 classifier convention (this migration's forms are
// ALTER TABLE / CREATE TABLE / CREATE UNIQUE INDEX, all IF NOT EXISTS for the
// shared ledger's idempotent re-apply).
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
  "0007_layers.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

// Same classify shape the 0006 pin uses (the two migrations ship the same
// statement forms; here CREATE INDEX may carry UNIQUE).
function classify0007(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  let m = /^ALTER\s+TABLE\s+([\w"'.]+)/i.exec(plain);
  if (m) return { form: "ALTER TABLE", name: m[1], target: m[1] };

  m = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE TABLE", name: m[2], target: m[2], ifNotExists: Boolean(m[1]) };

  m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:UNIQUE\s+)?(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)\s+ON\s+([\w"'.]+)/is.exec(plain);
  if (m) {
    return { form: "CREATE INDEX", name: m[2], target: m[3], ifNotExists: Boolean(m[1]) };
  }

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0007 only targets gc_-prefixed objects with known statement forms", () => {
  const offenders = statements
    .map(classify0007)
    .filter((c) =>
      c.form === "unrecognized" ||
      !gc(c.target) ||
      (c.form === "CREATE INDEX" ? !gcIndex(c.name) : !gc(c.name)))
    .map((c) => c.form + " " + (c.name || ""));

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0007 has no DROP, PRAGMA, UPDATE, DELETE, or INSERT statements", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(stripped, /\bDROP\b/i);
  assert.doesNotMatch(stripped, /\bPRAGMA\b/i);
  assert.doesNotMatch(stripped, /\bUPDATE\b/i);
  assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stripped, /\bINSERT\s+INTO\b/i);
  // The only ALTER target is GooberCord's own gc_channels — the forum's
  // users table is never altered.
  for (const alter of statements.map(classify0007).filter((c) => c.form === "ALTER TABLE")) {
    assert.equal(alter.name, "gc_channels", alter.name);
  }
});

test("0007 creates gc_channel_categories with the folder contract", () => {
  const table = statements.map(classify0007)
    .find((c) => c.form === "CREATE TABLE" && c.name === "gc_channel_categories");
  assert.ok(table, "gc_channel_categories is created by 0007");
  assert.ok(table.ifNotExists, "gc_channel_categories uses CREATE TABLE IF NOT EXISTS");
  assert.match(sql, /id\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i);
  assert.match(
    sql,
    /server_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+gc_servers\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  );
  assert.match(sql, /name\s+TEXT\s+NOT\s+NULL\s+CHECK\(length\(trim\(name\)\)\s+BETWEEN\s+1\s+AND\s+32\)/i);
  assert.match(sql, /position\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  assert.match(sql, /created_at\s+INTEGER\s+NOT\s+NULL/i);
});

test("0007 widens gc_channels with category_id (SET NULL) and slowmode_seconds", () => {
  const alters = statements.map(classify0007).filter((c) => c.form === "ALTER TABLE");
  assert.equal(alters.length, 2, "category_id and slowmode_seconds are the only 0007 ALTERs");
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_channels\s+ADD\s+COLUMN\s+category_id\s+INTEGER\s+NULL\s+REFERENCES\s+gc_channel_categories\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i,
  );
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_channels\s+ADD\s+COLUMN\s+slowmode_seconds\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0(;|\n)/i,
  );
});

test("0007 creates gc_channel_overwrites with the layer contract", () => {
  const table = statements.map(classify0007)
    .find((c) => c.form === "CREATE TABLE" && c.name === "gc_channel_overwrites");
  assert.ok(table, "gc_channel_overwrites is created by 0007");
  assert.match(sql, /channel_id\s+INTEGER\s+NULL\s+REFERENCES\s+gc_channels\(id\)\s+ON\s+DELETE\s+CASCADE/i);
  assert.match(
    sql,
    /category_id\s+INTEGER\s+NULL\s+REFERENCES\s+gc_channel_categories\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  );
  // role_id NULL is the @everyone sentinel; the member-specific tier is
  // reserved (documented, not implemented).
  assert.match(sql, /role_id\s+INTEGER\s+NULL/i);
  assert.match(sql, /allow_mask\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  assert.match(sql, /deny_mask\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  // Exactly one layer id is set: every row is a channel override or a
  // category override, never both and never neither.
  const check = sql.match(/CHECK\(\(channel_id IS NOT NULL[\s\S]*?category_id IS NULL\)\)/i);
  assert.ok(check, "an exactly-one-layer CHECK pins the row shape");
});

test("0007 ships the unique layer key and three lookup indexes", () => {
  const indexes = statements.map(classify0007).filter((c) => c.form === "CREATE INDEX");
  assert.equal(indexes.length, 4, "categories-by-server, layer-unique index, two FK lookups");
  for (const index of indexes) {
    assert.ok(index.ifNotExists, "the shared ledger needs CREATE INDEX IF NOT EXISTS");
    assert.ok(gcIndex(index.name), "index name is idx_gc_-prefixed: " + index.name);
    assert.ok(
      /^(gc_channel_overwrites|gc_channel_categories)$/.test(index.target),
      "index target is a 0007 table: " + index.target,
    );
  }
  const unique = sql.match(
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_gc_channel_overwrites_layer[\s\S]*?IFNULL\(channel_id, 0\), IFNULL\(category_id, 0\), IFNULL\(role_id, 0\)/i,
  );
  assert.ok(unique, "one row per (channel_or_category, role), NULLs folded to the sentinel");
  assert.match(sql, /idx_gc_channel_overwrites_channel\s+ON\s+gc_channel_overwrites\(channel_id\)/i);
  assert.match(sql, /idx_gc_channel_overwrites_category\s+ON\s+gc_channel_overwrites\(category_id\)/i);
  assert.match(
    sql,
    /idx_gc_channel_categories_server\s+ON\s+gc_channel_categories\(server_id\)/i,
  );
});
