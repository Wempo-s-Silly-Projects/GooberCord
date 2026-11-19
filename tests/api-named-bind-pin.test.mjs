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

// The named-bind object pin (board T-LESSON-NAMED-BINDS rider, wave-22): no
// api/*.mjs module may bind through the named-bind object form `.bind({...})`
// — the fleet's only named-bind consumer 500'd real prod D1 on Nov 19 by
// owner blank-shell report while the fakeDb suite rode green. The law is
// positional: D1 binds ride `.bind(now, userId)` with `?` placeholders, and
// this pin keeps the idiom single.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "api");

// api/core/*.mjs rides the same law as the flat route files (code-review,
// wave-22 follow-up: the flat readdir missed the 12-module core subtree).
function walkMjs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return [
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs")).map((entry) => join(dir, entry.name)),
    ...entries.filter((entry) => entry.isDirectory() && entry.name !== "vendor").flatMap((entry) => walkMjs(join(dir, entry.name))),
  ];
}

test("no api module binds through the named-bind object form (.bind({)", () => {
  const modules = walkMjs(API_DIR).sort();
  for (const file of modules) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\.bind\(\{/,
      relative(API_DIR, file) + " carries the named-bind object form — name the receiver and bind to it instead");
  }
});
