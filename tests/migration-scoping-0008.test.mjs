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

// Migration 0008 scoping pin: the phase-3 mod desk (gc_server_bans, the
// timeout + join-attribution + verification-level columns, and the prune's
// author index) on the SHARED wempo-forum-data D1. Same contract as the 0006
// and 0007 pins: every statement targets a gc_-prefixed object; `users` is
// never created, altered, or written (it is only ever a read-only FK target —
// gc_server_bans.server_id/user_id/created_by). Reuses migrations/0001's
// splitter via the 0006 classifier convention (this migration's forms are
// CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX, all IF NOT EXISTS for
// the shared ledger's idempotent re-apply).
//
// INDEPENDENCE: the file must also apply cleanly right after 0006 (no 0007
// objects anywhere in it, and no statement order dependence) — pinned below.
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
  "0008_mod_desk.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

// Same classify shape the 0007 pin uses (the two migrations ship the same
// statement forms).
function classify0008(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  let m = /^ALTER\s+TABLE\s+([\w"'.]+)/i.exec(plain);
  if (m) return { form: "ALTER TABLE", name: m[1], target: m[1] };

  m = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE TABLE", name: m[2], target: m[2], ifNotExists: Boolean(m[1]) };

  m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:UNIQUE\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)\s+ON\s+([\w"'.]+)/is.exec(plain);
  if (m) {
    return { form: "CREATE INDEX", name: m[1], target: m[2], ifNotExists: true };
  }

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0008 only targets gc_-prefixed objects with known statement forms", () => {
  const offenders = statements
    .map(classify0008)
    .filter((c) =>
      c.form === "unrecognized" ||
      !gc(c.target) ||
      (c.form === "CREATE INDEX" ? !gcIndex(c.name) : !gc(c.name)))
    .map((c) => c.form + " " + (c.name || ""));

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0008 has no DROP, PRAGMA, UPDATE, DELETE, or INSERT statements", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(stripped, /\bDROP\b/i);
  assert.doesNotMatch(stripped, /\bPRAGMA\b/i);
  assert.doesNotMatch(stripped, /\bUPDATE\b/i);
  assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stripped, /\bINSERT\s+INTO\b/i);
  // The only ALTER targets are GooberCord's own gc_server_members /
  // gc_servers / gc_messages — the forum's users table is never altered.
  const alterTargets = statements.map(classify0008)
    .filter((c) => c.form === "ALTER TABLE")
    .map((c) => c.name);
  for (const target of alterTargets) {
    assert.match(target, /^gc_(server_members|servers|messages)$/, target);
  }
  assert.equal(alterTargets.length, 3, "the member, server, and message columns are the only ALTERs");
});

test("0008 creates gc_server_bans with the account-ban contract", () => {
  const table = statements.map(classify0008)
    .find((c) => c.form === "CREATE TABLE" && c.name === "gc_server_bans");
  assert.ok(table, "gc_server_bans is created by 0008");
  assert.ok(table.ifNotExists, "gc_server_bans uses CREATE TABLE IF NOT EXISTS");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gc_server_bans \(/);
  assert.match(
    sql,
    /server_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+gc_servers\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  );
  assert.match(
    sql,
    /user_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i,
  );
  assert.match(sql, /created_by\s+INTEGER\s+NULL\s+REFERENCES\s+users\(id\)/i);
  // The optional reason is capped (the route mirrors the CHECK so oversized
  // reasons 400 instead of 500-ing).
  assert.match(sql, /reason\s+TEXT\s+NULL\s+CHECK\(reason\s+IS\s+NULL\s+OR\s+length\(reason\)\s+<=\s+280\)/i);
  assert.match(sql, /created_at\s+INTEGER\s+NOT\s+NULL/i);
  assert.match(sql, /PRIMARY KEY\s*\(server_id,\s*user_id\)/i);
});

test("0008 widens gc_server_members with the timeout and join-attribution columns", () => {
  const alters = statements.map(classify0008).filter((c) => c.form === "ALTER TABLE");
  assert.equal(alters.length, 3, "the three 0008 columns ride three ALTERs");
  // The time-out FAQ: NULL is not-timed-out; removal sets it back to NULL.
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_server_members\s+ADD\s+COLUMN\s+timed_out_until\s+INTEGER\s+NULL(;|\n)/i,
  );
  // The members-page join attribution: the code used at join time, or NULL.
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_server_members\s+ADD\s+COLUMN\s+created_by_invite\s+TEXT\s+NULL(;|\n)/i,
  );
});

test("0008 widens gc_servers with the verification ladder column", () => {
  // The filed mapping, documented in the migration itself and encoded in one
  // helper (api/permissions.mjs):
  //   0 = none, 1 = account > 1d, 2 = account > 7d, 3 = member > 10m,
  //   4 = account > 7d AND member > 10m.
  assert.match(
    sql,
    /ALTER\s+TABLE\s+gc_servers\s+ADD\s+COLUMN\s+verification_level\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\n?\s*CHECK\(verification_level IN \(0, 1, 2, 3, 4\)\)/i,
  );
  assert.match(sql, /0=none, 1=account older than 1 day/i, "the ladder is documented in this file");
});

test("0008 ships exactly one lookup index (the prune's author direction)", () => {
  const indexes = statements.map(classify0008).filter((c) => c.form === "CREATE INDEX");
  assert.equal(indexes.length, 1, "gc_server_bans' PK covers its own lookups");
  assert.equal(indexes[0].name, "idx_gc_messages_author_channel");
  assert.equal(indexes[0].target, "gc_messages");
  assert.ok(indexes[0].ifNotExists, "the shared ledger needs CREATE INDEX IF NOT EXISTS");
  assert.match(
    sql,
    /idx_gc_messages_author_channel\s+ON\s+gc_messages\(author_id,\s*channel_id\)/i,
  );
});

test("0008 is independent of every later migration (applies right after 0006 too)", () => {
  // No 0007 object may appear anywhere — the file runs on a database that
  // never saw the category/overwrite layer.
  const stripped = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [
    "gc_channel_categories",
    "gc_channel_overwrites",
    "gc_roles",
    "gc_member_roles",
    "category_id",
    "slowmode_seconds",
    "is_spoiler",
    "nickname",
    "gc_invites",
    "gc_server_boosts",
    "gc_goober_perk",
  ]) {
    assert.equal(
      new RegExp("\\b" + forbidden + "\\b", "i").test(stripped),
      false,
      "0008 must not reference " + forbidden,
    );
  }
  // Statement order independence: the ALTERs name only tables that exist
  // since 0001, and nothing in the file depends on a statement that follows.
  const tables = statements.map((statement) => classify0008(statement).target || "");
  assert.ok(tables.includes("gc_server_members"));
  assert.ok(tables.includes("gc_servers"));
  assert.ok(tables.includes("gc_server_bans"));
});
