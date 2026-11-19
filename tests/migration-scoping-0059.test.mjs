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

// Migration 0059 (the server audit log, wave 26 W26-1) scoping pin: TWO
// CREATE-only statements — the gc_server_audit table and its
// newest-first read index — both gc_-prefixed, both FK-free (the D1
// FK-runner law keeps FK-bearing targets dead on populated parents,
// 0055's precedent; an audit trail must survive the actors/targets it
// names anyway). The payload's byte ceiling mirrors the constants.mjs
// seat (AUDIT_PAYLOAD_MAX_BYTES) as its literal CHECK bound. The
// real-SQLite hold lands both statements and proves a nullable target +
// the capped payload beside each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf, assertTargetsAreGc } from "./migration-scoping.test.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(TESTS_DIR, "..", "migrations");
const SQL = readFileSync(path.join(MIGRATIONS_DIR, "0059_gc_server_audit.sql"), "utf8");

test("0059 is exactly two statements: the audit table + its read index", () => {
  const list = statementsOf(SQL);
  assert.equal(list.length, 2, `two statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE IF NOT EXISTS\s*\n?\s*gc_server_audit\s*\(/);
  assert.match(list[1], /^CREATE INDEX idx_gc_server_audit_server\s*\n?\s*ON gc_server_audit\s*\(server_id, id\)\s*$/);
});

test("0059 classifies gc_-prefixed and carries no FK-bearing form", () => {
  assertTargetsAreGc(SQL);
  const body = SQL.replace(/--[^\n]*/g, " ").toUpperCase();
  for (const banned of ["FOREIGN KEY", "REFERENCES", "ALTER ", "DROP ", "UPDATE ", "INSERT INTO", "TRIGGER", "PRAGMA", "RENAME"]) {
    assert.equal(body.includes(banned), false, `banned statement form: ${banned}`);
  }
});

test("0059 carries the 17-line-plus-blank AGPLv3 header", () => {
  const lines = SQL.split("\n");
  assert.match(lines[0], /^-- Copyright 2026 /);
  assert.equal(lines[16].startsWith("--"), true, "line 17 ends the license block");
  assert.equal(lines[17].trim(), "", "line 18 is the blank separator line");
  assert.match(SQL, /GNU Affero General Public License/);
});

test("the table lands on real SQLite: nullable target, capped payload, newest-first index", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(SQL);
    // A logged kick beside a logged nick edit: the target is optional, the
    // payload rides the cap, the id monotonically serves the read's order.
    db.prepare(
      "INSERT INTO gc_server_audit (server_id, actor_id, action_key, target_user_id, target_ref, payload_json, created_at) " +
        "VALUES (1, 7, 'member.kick', 42, NULL, '{}', 5)",
    ).run();
    db.prepare(
      "INSERT INTO gc_server_audit (server_id, actor_id, action_key, target_user_id, target_ref, payload_json, created_at) " +
        "VALUES (1, 7, 'role.update', NULL, NULL, '{\"before\":{\"name\":\"old\"},\"after\":{\"name\":\"new\"}}', 6)",
    ).run();
    const page = db.prepare(
      "SELECT action_key, target_user_id, payload_json FROM gc_server_audit " +
        "WHERE server_id = ? ORDER BY id DESC LIMIT 100",
    ).all(1);
    assert.equal(page.length, 2);
    assert.equal(page[0].action_key, "role.update", "the read serves newest-first");
    assert.equal(page[1].target_user_id, 42, "the nullable target rides");

    // The payload cap is a real CHECK: 4097 bytes refuse at the engine.
    assert.throws(() =>
      db.prepare(
        "INSERT INTO gc_server_audit (server_id, actor_id, action_key, target_user_id, target_ref, payload_json, created_at) " +
          "VALUES (1, 7, 'member.ban', 42, NULL, ?, 7)",
      ).run("x".repeat(4097)),
    "the 4096-byte payload CHECK refuses the oversized row");
  } finally { db.close(); }
});
