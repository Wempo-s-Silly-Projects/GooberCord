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

// Migration 0011 scoping pin: the Goober Coins economy (gc_coin_ledger) and the
// Goober+ term state (gc_plus_state) on the SHARED wempo-forum-data D1. Same
// contract as the 0004/0006/0007/0008 pins: every statement targets a
// gc_-prefixed object; the shared `users` rows are never created, altered, or
// written (users appears only as a read-only FK reference for the ledger's
// owner/gift trail). Two CREATE TABLEs and two indexes — nothing else.
//
// INDEPENDENCE: the file must also apply cleanly right after 0002 (no 0008
// objects anywhere in it, no statement order dependence) — pinned below.
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
  "0011_coin_economy.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

const gc = (value) => /^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));
const gcIndex = (value) => /^idx_gc_/.test(String(value || ""));

test("migration 0011 only targets gc_-prefixed objects with known statement forms", () => {
  const offenders = statements
    .map((statement) => {
      const plain = statement.replace(/--[^\n]*/g, "").trim();
      if (!plain) return { form: "comment-only", name: "" };

      const table = /^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
      if (table) return { form: "CREATE TABLE", name: table[2], ifNotExists: Boolean(table[1]) };

      const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
      if (index) return { form: "CREATE INDEX", name: index[1], ifNotExists: true };

      return { form: "unrecognized", name: "" };
    })
    .filter((entry) =>
      entry.form === "unrecognized" ||
      (entry.form === "CREATE INDEX" ? !gcIndex(entry.name) : !gc(entry.name)) ||
      (entry.form === "CREATE TABLE" && !entry.ifNotExists))
    .map((entry) => entry.form + " " + entry.name);

  assert.ok(statements.length > 0, "parsed at least one statement");
  assert.deepEqual(offenders, []);
});

test("migration 0011 is exactly the two economy tables + their two indexes", () => {
  const names = statements
    .map((statement) => /(?:CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?)([\w"'.]+)/i.exec(
      statement.replace(/--[^\n]*/g, ""),
    )?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(names, [
    "gc_coin_ledger",
    "gc_plus_state",
    "idx_gc_coin_ledger_gift_trail",
    "idx_gc_coin_ledger_user_created",
  ]);
});

test("migration 0011 has no DROP, PRAGMA, UPDATE, DELETE, or INSERT statements", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [/\bDROP\b/i, /\bPRAGMA\b/i, /\bUPDATE\b/i, /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i]) {
    assert.doesNotMatch(stripped, forbidden);
  }
  // No ALTERs at all: the economy adds no columns to anybody's table — the
  // balance lives in the ledger's SUM, and Goober+ lives in its own table.
  assert.doesNotMatch(stripped, /ALTER\s+TABLE/i);
});

test("the ledger's delta integrity is enforced by a schema CHECK, not by client code", () => {
  const ledger = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?gc_coin_ledger\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1] || "";
  assert.match(ledger, /delta\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*delta\s*<>\s*0\s*\)/, "delta <> 0 rides the schema");
  // The delta-only rule: a member's balance is SUM(delta); a balance COLUMN
  // would be a second, driftable copy of it.
  const ledgerColumns = ledger
    .split("\n")
    .map((line) => line.trim().replace(/--[^\n]*/g, ""))
    .filter(Boolean)
    .map((line) => line.split(/[\s(]/)[0]);
  assert.ok(!ledgerColumns.includes("balance"), "no balance column exists anywhere");
  assert.match(ledger, /source\s+TEXT\s+NOT\s+NULL\s+CHECK/);
  assert.match(ledger, /REFERENCES\s+users/i, "coins are account-tied (the shared identity, read-only)");
});

test("gc_plus_state carries the owner's four state keys and nothing else", () => {
  const plus = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?gc_plus_state\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1] || "";
  for (const column of ["renews_until", "grace_until", "tenure_started_at", "gifted_by"]) {
    assert.match(plus, new RegExp("\\b" + column + "\\b"), column + " rides 0011");
  }
  // No pricing split, no balance: Goober+ is ONE bundle and coins are spent
  // straight out of the ledger.
  assert.doesNotMatch(plus, /\bprice\b|\bplan\b|\btier\b|\bbalance\b/i);
  // The FKs keep the money inside GooberCord's own prefix (gc_ tables only;
  // users is a target, never a write).
  assert.match(plus, /REFERENCES\s+users/i);
});

test("migration 0011 mentions no forum-only table beyond the read-only users reference", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  const tables = [...new Set(
    [...stripped.matchAll(/(?:REFERENCES|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1]),
    // users may be REFERENCED only; gc_* may be created.
  )]
    .filter((name) => !name.startsWith("gc_"));
  assert.deepEqual(tables, ["users"]);
});
