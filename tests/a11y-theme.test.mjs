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

// The a11y theme rows (T81): the high-contrast token blocks, the font-scale
// root var, and the no-hex law for the a11y rules. The spec draft lives at
// docs/drafts/t81-a11y-theme-spec.md; the contrast floors recompute here —
// a hand-tuned hex that looks right cannot slip underneath a WCAG floor by
// eyeball. Floors: 4.5:1 text (WCAG 2.2 §1.4.3), 3:1 non-text (§1.4.11).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesheet = path.join(here, "..", "public", "styles.css");

const REQUIRED_HC_TOKENS = [
  "--ink", "--muted", "--desk", "--paper", "--line", "--focus", "--link",
  "--green", "--coral", "--error-chip-ink", "--error-chip-bg", "--quiet-hover",
];

const DARK_HC_SELECTOR = ':root[data-hc="on"]';
const LIGHT_HC_SELECTOR = ':root[data-theme="light"][data-hc="on"]';

// blockAround(css, selector) — the declaration block that follows the
// selector's first occurrence, braces matched by hand (the sheet is a flat
// lint target, the brace-balance test guarantees the walk is sound).
function blockAround(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let end = open; end < css.length; end++) {
    if (css[end] === "{") depth++;
    if (css[end] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, end);
    }
  }
  return null;
}

const tokensOf = (block) => {
  const found = new Map();
  if (!block) return found;
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)) {
    found.set(name.toLowerCase(), value.toLowerCase());
  }
  return found;
};

// WCAG 2.2 relative luminance + contrast ratio (§1.4.3's formula).
function luminance(hex) {
  const digits = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(front, back) {
  const [light, dark] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("the high-contrast token block rides BOTH themes (T81)", async () => {
  const css = await readFile(stylesheet, "utf8");
  const dark = tokensOf(blockAround(css, DARK_HC_SELECTOR));
  const light = tokensOf(blockAround(css, LIGHT_HC_SELECTOR));
  for (const [themeName, tokens, selector] of [
    ["dark", dark, DARK_HC_SELECTOR],
    ["light", light, LIGHT_HC_SELECTOR],
  ]) {
    const missing = REQUIRED_HC_TOKENS.filter((token) => !tokens.has(token));
    assert.deepEqual(missing, [],
      `${themeName} hc block (${selector}) must redefine every required token — missing: ${missing.join(" ")}`);
  }
});

test("the font-scale setting maps to a single root var (T81)", async () => {
  const css = await readFile(stylesheet, "utf8");
  const root = blockAround(css, ":root {");
  assert.ok(root && /--font-scale:\s*1\s*;/.test(root),
    ":root declares --font-scale: 1 — the sheet scales through one var, never scattered sizes");
  assert.match(css, /calc\(100% \* var\(--font-scale\)\)/,
    "the html base rule converts the var to the rem root — rem-riding sizes scale, px geometry stays");
});

test("the a11y rules carry zero hex literals — tokens are the single color source (T81)", async () => {
  const css = await readFile(stylesheet, "utf8");
  const start = css.indexOf("== a11y rules ==");
  assert.ok(start >= 0, "the == a11y rules == section exists (the toggles' var-only rules live there)");
  const end = css.indexOf("== end a11y ==", start);
  assert.ok(end > start, "the == end a11y == marker closes the section");
  const section = css.slice(start, end);
  const hexes = section.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexes, [], `rules reference var(--…) only — hex literals found: ${hexes.join(" ")}`);
});

test("the hc token values hold their WCAG 2.2 floors (T81, recomputed in-test)", async () => {
  const css = await readFile(stylesheet, "utf8");
  const floors = [
    ["--ink", "--desk", 4.5],
    ["--muted", "--desk", 4.5],
    ["--link", "--desk", 4.5],
    ["--focus", "--desk", 3],
    ["--line", "--desk", 3],
  ];
  for (const [themeName, selector] of [
    ["dark", DARK_HC_SELECTOR],
    ["light", LIGHT_HC_SELECTOR],
  ]) {
    const tokens = tokensOf(blockAround(css, selector));
    for (const [front, back, floor] of floors) {
      assert.ok(tokens.has(front) && tokens.has(back),
        `${themeName} hc (${selector}) defines ${front} and ${back} — the floor pairs are mandatory`);
      const ratio = contrast(tokens.get(front), tokens.get(back));
      assert.ok(ratio >= floor,
        `${themeName} hc ${front} on ${back} measures ${ratio.toFixed(2)} — floor ${floor}`);
    }
  }
});
