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

// Migration 0009 scoping pin: the phase-3 social layer (gc_friend_requests,
// gc_friends, gc_blocks, gc_social_prefs, gc_message_reactions) on the SHARED
// wempo-forum-data D1. Same contract as the 0006/0007/0008 pins: every
// statement targets a gc_-prefixed object; `users` is never created, altered,
// or written (it is only ever a read-only FK target — every *_id references
// users(id) ON DELETE CASCADE). Reuses migrations/0001's splitter via the 0006
// classifier convention.
//
// INDEPENDENCE: the file must also apply cleanly right after 0006 (no 0007 or
// 0008 objects anywhere in it, and no statement-order dependence) — pinned
// below.
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
  "0009_social.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

function classify0009(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  let m = /^ALTER\s+TABLE\s+([\w"'.]+)/i.exec(plain);
  if (m) return { form: "ALTER TABLE", name: m[1], target: m[1] };

  m = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE TABLE", name: m[2], target: m[2], ifNotExists: Boolean(m[1]) };

  m = /^CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)\s+ON\s+([\w"'.]+)/is.exec(plain);
  if (m) return { form: "CREATE INDEX", name: m[1], target: m[2], ifNotExists: true };

  return { form: "unrecognized" };
}

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0009 exists and only targets gc_-prefixed objects", () => {
  const offenders = statements
    .map(classify0009)
    .filter((c) =>
      c.form === "unrecognized" ||
      !gc(c.target) ||
      (c.form === "CREATE INDEX" ? !gcIndex(c.name) : !gc(c.name)))
    .map((c) => c.form + " " + (c.name || ""));

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0009 has no DROP, PRAGMA, UPDATE, DELETE, INSERT, or ALTER statements", () => {
  // The social batch is CREATE-only: five tables + one target-side index, no
  // column widenings on anyone's table (users is never even altered).
  const stripped = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(stripped, /\bDROP\b/i);
  assert.doesNotMatch(stripped, /\bPRAGMA\b/i);
  assert.doesNotMatch(stripped, /\bUPDATE\b/i);
  assert.doesNotMatch(stripped, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stripped, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(stripped, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(stripped, /\bTRIGGER\b/i);
});

test("0009 creates the five social tables, all IF NOT EXISTS", () => {
  const created = statements.map(classify0009)
    .filter((c) => c.form === "CREATE TABLE");
  const names = created.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "gc_blocks",
    "gc_friend_requests",
    "gc_friends",
    "gc_message_reactions",
    "gc_social_prefs",
  ]);
  for (const table of created) {
    assert.ok(table.ifNotExists, table.name + " uses CREATE TABLE IF NOT EXISTS");
  }
});

test("0009 ships exactly the two reverse-lookup indexes", () => {
  const indexes = statements.map(classify0009).filter((c) => c.form === "CREATE INDEX");
  assert.deepEqual(indexes.map((c) => c.name), [
    "idx_gc_friend_requests_target",
    "idx_gc_blocks_blocked",
  ]);
  assert.match(sql, /idx_gc_friend_requests_target\s+ON\s+gc_friend_requests\s*\(target_id\)/i);
  assert.match(sql, /idx_gc_blocks_blocked\s+ON\s+gc_blocks\s*\(blocked_id\)/i);
});

test("0009 users is a read-only FK target everywhere", () => {
  // Every users reference is a REFERENCES clause on a gc_* table; no
  // statement creates, alters, or otherwise names users as its target.
  const targets = statements.map((statement) => classify0009(statement).target || "");
  for (const target of targets) {
    if (!target) continue;
    assert.notEqual(target, "users");
  }
  assert.match(sql, /REFERENCES users\(id\) ON DELETE CASCADE/i);
});

test("0009 gc_friends is the canonical pair form", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS gc_friends \(\s*\n\s*user_a_id INTEGER NOT NULL REFERENCES users\(id\)\s+ON DELETE CASCADE,\s*\n\s*user_b_id INTEGER NOT NULL REFERENCES users\(id\)\s+ON DELETE CASCADE,\s*\n\s*created_at INTEGER NOT NULL,\s*\n\s*CHECK \(user_a_id < user_b_id\),\s*\n\s*PRIMARY KEY \(user_a_id, user_b_id\)/i,
  );
});

test("0009 gc_blocks carries the two kinds in one table", () => {
  assert.match(
    sql,
    /kind TEXT NOT NULL CHECK\(kind IN \('blocked','ignored'\)\),\s*\n\s*created_at INTEGER NOT NULL,\s*\n\s*PRIMARY KEY \(blocker_id, blocked_id\)/i,
  );
});

test("0009 gc_message_reactions keys (message, user, emoji) and caps the emoji at 32", () => {
  assert.match(
    sql,
    /message_id INTEGER NOT NULL REFERENCES gc_messages\(id\) ON DELETE CASCADE,?\s*\n?\s*user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE,?\s*\n?\s*emoji TEXT NOT NULL CHECK\(length\(emoji\) BETWEEN 1 AND 32\)/i,
  );
  assert.match(sql, /PRIMARY KEY \(message_id, user_id, emoji\)/i);
});

test("0009 gc_social_prefs is the Everyone-vs-OFF gate with the every-user default", () => {
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS gc_social_prefs \(\s*\n\s*user_id INTEGER PRIMARY KEY REFERENCES users\(id\)\s+ON DELETE CASCADE,\s*\n\s*accept_requests INTEGER NOT NULL DEFAULT 1,\s*\n\s*updated_at INTEGER NOT NULL\s*\n\s*\)/i,
  );
});

test("0009 is independent of the later migrations (applies right after 0006 too)", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [
    // 0007's layer objects
    "gc_channel_categories",
    "gc_channel_overwrites",
    "gc_roles",
    "gc_member_roles",
    "category_id",
    "slowmode_seconds",
    // 0008's mod-desk objects
    "gc_server_bans",
    "timed_out_until",
    "created_by_invite",
    "verification_level",
  ]) {
    assert.equal(
      new RegExp("\\b" + forbidden + "\\b", "i").test(stripped),
      false,
      "0009 must not reference " + forbidden,
    );
  }
  // Statement-order independence: the only external object any statement
  // could need besides users is gc_messages (the reactions FK) — a 0001
  // table. No other gc_* name is READ before it is created in this file.
  const createdFirst = new Set();
  const reads = [];
  for (const statement of statements) {
    const classified = classify0009(statement);
    for (const read of reads) {
      assert.ok(
        createdFirst.has(read) || ["users", "gc_messages"].includes(read),
        statement.slice(0, 60) + " reads " + read + " before it exists",
      );
    }
    if (classified.form === "CREATE TABLE") createdFirst.add(classified.name);
    if (classified.form === "CREATE INDEX") {
      assert.ok(createdFirst.has(classified.target), "the index's table precedes it");
    }
    // The tables this statement could read (a plain CREATE TABLE reads only
    // its REFERENCES targets).
    for (const match of statement.matchAll(/REFERENCES ([A-Za-z_"]+)\(/g)) {
      reads.push(match[1].replace(/^"(.*)"$/, "$1"));
    }
  }
});
