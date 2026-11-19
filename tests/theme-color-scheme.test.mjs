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

// The color-scheme contract (the dark-mode-toggle guide, wave-24): the
// <meta name="color-scheme"> hint is the runtime source ("light dark" rides
// the system, a stored pin maps to "light"/"dark"), the CSS :has() mapping
// follows it (the property is never hardcoded at :root), and the chrome
// pair re-paints on the pin. By source: theme-preload runs before paint,
// the shell's toggle seat is the only runtime write (Kit's engine is
// vendored and meta-blind).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const INDEX = readFileSync(join(HERE, "../public/index.html"), "utf8");
const PRELOAD = readFileSync(join(HERE, "../public/js/theme-preload.js"), "utf8");
const CSS = readFileSync(join(HERE, "../public/styles.css"), "utf8");
const SHELL = readFileSync(join(HERE, "../public/js/ui/shell.js"), "utf8");
const VENDOR = readFileSync(join(HERE, "../public/js/vendor/frontload/tokens.mjs"), "utf8");

test("index.html authors the color-scheme meta before the preload script", () => {
  const metaAt = INDEX.indexOf('<meta name="color-scheme" content="light dark">');
  assert.ok(metaAt > 0, "the meta exists with the system default");
  const preloadAt = INDEX.indexOf("<script src=\"/js/theme-preload.js");
  assert.ok(metaAt < preloadAt, "the hint settles before theme-preload runs");
});

test("theme-preload maps the stored pin onto the hint and the chrome pair", () => {
  assert.match(PRELOAD, /meta\[name="color-scheme"\]/, "the preload syncs the hint");
  assert.match(PRELOAD, /"light dark"/, "an absent pin keeps the system default");
  assert.match(
    PRELOAD,
    /'meta\[name="theme-color"\]'/,
    "the chrome pair follows the pin at first paint",
  );
  assert.match(PRELOAD, /removeAttribute\("media"\)/, "the media pair yields to the pin");
  assert.match(PRELOAD, /#131b27/, "the dark chrome color");
  assert.match(PRELOAD, /#f7efdc/, "the light chrome color");
});

test("styles.css :root maps the hint, never pins a scheme", () => {
  const root = CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("}", CSS.indexOf(":root {")));
  assert.match(root, /color-scheme: light dark;/, "the base :root stays the system hint");
  assert.doesNotMatch(root, /color-scheme: (?:dark|light);/, "no hardcoded pin at :root");
  assert.match(
    CSS,
    /:root:has\(> head > meta\[name="color-scheme"\]\[content="dark"\]\) \{\s+color-scheme: dark;\s+\}/,
    "the flat dark mapping follows the meta",
  );
  assert.match(
    CSS,
    /:root:has\(> head > meta\[name="color-scheme"\]\[content="light"\]\) \{\s+color-scheme: light;\s+\}/,
    "the flat light mapping follows the meta",
  );
  const light = CSS.slice(
    CSS.indexOf(':root[data-theme="light"]'),
    CSS.indexOf("}", CSS.indexOf(':root[data-theme="light"]')),
  );
  assert.doesNotMatch(light, /color-scheme:/, "the palette block carries no scheme pin");
});

test("the runtime write seat syncs the hint; the vendored engine stays untouched", () => {
  assert.strictEqual(
    readFileSync(join(HERE, "../public/js/vendor/frontload/tokens.mjs"), "utf8"),
    VENDOR,
  );
  assert.match(SHELL, /syncColorSchemeContract\(document, next\)/,
    "the toggle seat rides the contract after the engine call");
  assert.match(SHELL, /function syncColorSchemeContract\(/, "the shell owns the sync helper");
  assert.match(SHELL, /meta\[name="color-scheme"\]/, "the helper repaints the hint");
  assert.match(SHELL, /removeAttribute\("media"\)/, "the helper settles the chrome pair");
});
