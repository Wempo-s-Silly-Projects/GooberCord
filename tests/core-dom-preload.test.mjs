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

// The element builder and the pre-paint theme setter, by source: the builder
// may never parse markup (no innerHTML), strings ride text nodes, SVG sets
// attributes; theme-preload reads the GC key with the forum key as a
// read-only legacy home, writes nothing, and guards storage (private
// windows) — an absent or blocked read silently leaves the dark default.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const DOM = readFileSync(join(HERE, "../public/js/core/dom.js"), "utf8");
const PRELOAD = readFileSync(join(HERE, "../public/js/theme-preload.js"), "utf8");
const INDEX = readFileSync(join(HERE, "../public/index.html"), "utf8");

test("h() never parses markup: createElement, textContent, appendChild only", () => {
  assert.doesNotMatch(DOM, /innerHTML/, "no innerHTML anywhere in the builder");
  assert.match(DOM, /document\.createElement\(/);
  assert.match(DOM, /appendChild|node\.append\(/);
  assert.match(DOM, /createTextNode/);
  assert.match(DOM, /export function svg\(/, "the SVG-namespaced twin exists for icons");
});

test("theme-preload only skins a recognized stored choice, guarded", () => {
  assert.match(PRELOAD, /"goober-theme"/);
  assert.match(PRELOAD, /"forum-theme"/, "the forum key reads along as legacy only");
  assert.doesNotMatch(PRELOAD, /setItem/, "pre-paint writes nothing");
  assert.match(PRELOAD, /try \{[\s\S]*catch/);
  assert.match(PRELOAD, /storedTheme === "dark" \|\| storedTheme === "light"/);
});

test("the document serves the preload before the stylesheet, then the module boot", () => {
  const preloadAt = INDEX.indexOf("/js/theme-preload.js");
  const stylesAt = INDEX.indexOf("/styles.css");
  const mainAt = INDEX.indexOf("/js/main.js");
  assert.ok(preloadAt > 0 && preloadAt < stylesAt, "the skin settles before styles.css paints");
  assert.ok(stylesAt < mainAt, "styles land before the module boot");
  assert.match(INDEX, /<meta name="viewport"/);
});

test("the stamp contract: worker injects app-build; the document carries no static stamp", () => {
  assert.doesNotMatch(INDEX, /name="app-build"/, "the stamp is injected at serve time");
  const worker = readFileSync(join(HERE, "../worker.mjs"), "utf8");
  assert.match(worker, /<meta name="app-build" content="/);
});
