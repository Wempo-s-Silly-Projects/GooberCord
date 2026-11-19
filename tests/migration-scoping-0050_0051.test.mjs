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

// Migrations 0050 (time capsules) and 0051 (bookmarks) scoping pins: both
// are additive, CREATE-only migrations on the shared wempo-forum-data D1 —
// every statement creates one gc_-prefixed object, and neither touches a
// shared table, an existing row, or a foreign table's write path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf } from "./migration-scoping.test.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function classify(statement) {
  const plain = statement.replace(/--[^\n]*/g, "").trim();
  if (!plain) return { form: "comment-only" };

  let m = /^(CREATE\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE TABLE", target: m[2] };

  m = /^(CREATE\s+(?:UNIQUE\s+)?INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"'.]+)/i.exec(plain);
  if (m) return { form: "CREATE INDEX", target: m[2] };

  return { form: "unrecognized", target: plain.slice(0, 40) };
}

const gc = (value) => /^idx_gc_|^gc_/.test(String(value || "").replace(/^"(.*)"$/, "$1"));

for (const [file, name] of [
  ["0050_gc_time_capsules.sql", "0050 time capsules"],
  ["0051_gc_bookmarks.sql", "0051 bookmarks"],
]) {
  const sql = readFileSync(path.join(TESTS_DIR, "..", "migrations", file), "utf8");
  const statements = statementsOf(sql);

  test("migration " + name + " only creates gc_-prefixed objects, CREATE-only", () => {
    const offenders = statements
      .map(classify)
      .filter((classified) =>
        classified.form === "unrecognized" ||
        !gc(classified.target));
    assert.deepEqual(offenders, []);
  });

  test("migration " + name + " carries no ALTER, DROP, UPDATE, or DELETE", () => {
    const stripped = sql.replace(/--[^\n]*/g, "").toUpperCase();
    assert.equal(stripped.includes("ALTER TABLE"), false);
    assert.equal(stripped.includes("DROP"), false);
    assert.equal(stripped.includes("UPDATE "), false);
    assert.equal(stripped.includes("INSERT INTO"), false);
  });
}
