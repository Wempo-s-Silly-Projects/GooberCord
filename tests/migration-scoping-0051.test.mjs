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

// Migration 0051 scoping pin: the community seats (the Morning Paper's config
// row and the month-day anniversaries) on the SHARED wempo-forum-data D1.
// Same contract as the 0004-0028 pins: every statement targets a gc_-prefixed
// object; the shared `users` rows are never created, altered, or written
// (users appears only as a read-only FK reference). Two CREATE TABLEs, one
// index — nothing else, additive only, no rebuild of any existing seat.
//
// PRIVACY: gc_user_anniversaries carries MONTH+DAY and nothing else — there
// is NO year column and no anchored timestamp; any migration that adds one is
// rejected on its face (LIMIT COLLECTION NOT ACCESS).
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
  "0051_gc_community_seats.sql",
);

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

test("migration 0051 is exactly the two community seats + their one index", () => {
  const names = statements
    .map((statement) => /(?:CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?)([\w"'.]+)/i.exec(
      statement.replace(/--[^\n]*/g, ""),
    )?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(names, [
    "gc_paper_configs",
    "gc_user_anniversaries",
    "idx_gc_user_anniversaries_month_day",
  ]);
});

test("migration 0051 has no DROP, PRAGMA, UPDATE, DELETE, INSERT, or ALTER statements", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  for (const forbidden of [
    /\bDROP\b/i, /\bPRAGMA\b/i, /\bUPDATE\b/i, /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i,
    /\bALTER\b/i,
  ]) {
    assert.doesNotMatch(stripped, forbidden);
  }
});

test("gc_paper_configs is the paper's whole seat: config only, no issue cache", () => {
  const paper = /CREATE\s+TABLE\s+gc_paper_configs\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1] || "";
  for (const column of ["server_id", "enabled", "updated_by", "updated_at"]) {
    assert.match(paper, new RegExp("\\b" + column + "\\b"), column + " rides 0051");
  }
  // The seat's shape: one row per server, the enabled flag is a 0/1 flag (a
  // 0 tombstone is never written — the DELETE is the off-transition), and
  // both FKs cascade so the config can never outlive its owners.
  assert.match(paper, /PRIMARY KEY\s*\(\s*server_id\s*\)/);
  assert.match(paper, /CHECK\s*\(\s*enabled\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/);
  assert.match(paper, /REFERENCES\s+gc_servers\(id\)\s+ON DELETE CASCADE/i);
  assert.match(paper, /REFERENCES\s+users\(id\)\s+ON DELETE CASCADE/i);
  // No render cache, no issue history, no per-section persistence: the paper
  // is derived on request and nothing else may squat on the config row.
  assert.doesNotMatch(paper, /\bcache\b|\bissue\b|\brender\b|\bhistory\b/i);
});

test("gc_user_anniversaries is month+day and NOTHING else — no year, no timestamp", () => {
  const anniv = /CREATE\s+TABLE\s+gc_user_anniversaries\s*\(([\s\S]*?)\n\);/i.exec(sql)?.[1] || "";
  assert.match(anniv, /user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(anniv, /month\s+INTEGER NOT NULL CHECK/);
  assert.match(anniv, /day\s+INTEGER NOT NULL CHECK/);
  assert.match(anniv, /PRIMARY KEY\s*\(\s*user_id\s*\)/);
  assert.match(anniv, /\bmonth\s+IN\s*\(\s*0,1,2,3,4,5,6,7,8,9,10,11\s*\)/, "months are 0-11");
  assert.match(anniv, /day\s*>=\s*1\s+AND\s+day\s*<=\s*31/, "days are 1-31, structural only");
  // LIMIT COLLECTION NOT ACCESS: the columns a "member for N years"
  // computation needs DO NOT EXIST on this seat. The data columns are
  // EXACTLY identity + month + day — no other column of any name.
  const columnNames = anniv.split("\n")
    .map((line) => line.trim().replace(/--[^\n]*/g, ""))
    .filter(Boolean)
    .map((line) => line.split(/[\s(]/)[0])
    .filter((name) => name && name !== "PRIMARY");
  assert.deepEqual(
    columnNames.sort(),
    ["day", "month", "user_id"],
    "month+day+identity only — no year, no anchored timestamp",
  );
});

test("the celebrant read's access path exists as an index on (month, day)", () => {
  assert.match(sql, /CREATE INDEX idx_gc_user_anniversaries_month_day\s*\n?\s*ON gc_user_anniversaries\s*\(\s*month\s*,\s*day\s*\)/);
});

test("migration 0051 mentions no forum-only table beyond the read-only users reference", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  const tables = [...new Set(
    [...stripped.matchAll(/(?:REFERENCES|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1]),
  )].filter((name) => !name.startsWith("gc_"));
  assert.deepEqual(tables, ["users"]);
});
