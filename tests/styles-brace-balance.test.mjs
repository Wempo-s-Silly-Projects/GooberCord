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

// The stylesheet lint: public/styles.css must keep its braces balanced.
// The social/coins batch merge once dropped a block's closing `}` (the
// .shop-ledger-date rule), which nested EVERY following rule inside it —
// the friends-hub, reactions, visibility, and later sections silently
// stopped applying. Parsing never failed and no test caught it, so the
// balance is now structural: one open must have exactly one close.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesheet = path.join(here, "..", "public", "styles.css");

test("styles.css braces balance — a dropped close must never swallow whole sections again", async () => {
  const css = await readFile(stylesheet, "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutStrings = withoutComments.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
  let depth = 0;
  let line = 1;
  for (const character of withoutStrings) {
    if (character === "\n") line++;
    if (character === "{") depth++;
    if (character === "}") {
      depth--;
      assert.ok(depth >= 0, `extra } at line ${line}`);
    }
  }
  assert.equal(depth, 0, "unclosed { — blocks after it are swallowed");
});

test("mobile app shell: the members rail drops first, the rails compact second", async () => {
  const css = await readFile(stylesheet, "utf8");
  const membersBreak = css.indexOf("@media (max-width: 900px)");
  assert.ok(membersBreak >= 0, "the mobile members-rail breakpoint exists");
  const members = css.slice(membersBreak);
  assert.match(members, /\.rail-members\s*\{[^}]*display:\s*none/s);
  assert.match(members, /grid-template-columns:\s*72px\s+250px\s+minmax\(0,\s*1fr\);/,
    "the main pane widens to fill the dropped members column");
  const narrowBreak = css.indexOf("@media (max-width: 640px)");
  assert.ok(narrowBreak > membersBreak, "the narrow-phone breakpoint exists");
  const narrow = css.slice(narrowBreak);
  assert.match(narrow, /grid-template-columns:\s*56px\s+210px\s+minmax\(0,\s*1fr\);/,
    "the rails compact, the chat pane keeps the floor");
});

// --- the render-failure card (T28) ------------------------------------------

test("the .router-error card pins: one minimal tokenized rule, both themes ride vars", async () => {
  const css = await readFile(stylesheet, "utf8");
  const at = css.indexOf(".router-error {");
  assert.ok(at !== -1, "the rule rides the stylesheet");
  const block = css.slice(at, css.indexOf("}", at) + 1);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b/,
    "tokens only — no hex literals outside the token system");
  assert.match(block, /border:\s*2px solid var\(--error-chip-border\)/,
    "the border is the error idiom's token");
  assert.match(block, /background:\s*var\(--error-soft\)/, "the muted background is tokenized");
  assert.match(block, /color:\s*var\(--error-ink\)/, "the ink is tokenized");
  assert.match(block, /padding:\s*1\.4rem 1\.6rem/, "the card padding matches the gate-panel idiom");
  assert.match(block, /max-width:\s*34rem/, "the card width matches the gate-panel idiom");
});
