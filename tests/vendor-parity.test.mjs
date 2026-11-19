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

// Vendor parity (the rewrite's W-R1): public/js/vendor/ carries Project
// Designer's frontload + designer/kit modules, and the kit is the source of
// record — the GC copies must only differ from it by the allow-listed
// vendoring banner, never by code. The vendored tree MIRRORS the kit repo's
// layout (vendor/frontload/dom.mjs, vendor/frontload/tokens.mjs,
// vendor/designer/kit.mjs) so the kit's own relative imports resolve to the
// vendored siblings UNCHANGED — a path rewrite would break byte parity.
//
// Allow-listed substitutions ONLY:
//   the vendoring banner prepended to each GC copy (a fixed block ending at
//   the kit's own "// Project Designer — <module>" header)
// Everything else must be character-for-character identical.

import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VENDOR_DIR = path.resolve(HERE, "../public/js/vendor");
const KIT_DIR = "/Users/itswempo/project-designer";

// The kit's own header line starts each source file; stripping everything
// before it removes exactly the GC vendoring banner (and nothing else).
const KIT_HEADER_MARKER = "// Project Designer — ";

// [vendored path, kit path] — the rewrite's three used modules (the owner's
// law: frontload/dom, frontload/tokens, designer/kit; nothing else).
const MODULES = [
  ["frontload/dom.mjs", "frontload/dom.mjs"],
  ["frontload/tokens.mjs", "frontload/tokens.mjs"],
  ["designer/kit.mjs", "designer/kit.mjs"],
];

function readVendor(name) {
  return readFileSync(path.join(VENDOR_DIR, name), "utf-8");
}

function readKit(name) {
  return readFileSync(path.join(KIT_DIR, name), "utf-8");
}

function vendorize(text) {
  const marker = text.indexOf(KIT_HEADER_MARKER);
  assert.ok(marker > 0, "the vendored copy carries the GC banner before the kit header");
  return text.slice(marker);
}

for (const [vendored, kitPath] of MODULES) {
  test(`${vendored} is byte-identical to the kit after banner substitution`, () => {
    // The whole-file gate: the vendored copy differs from the source of
    // record by the banner and NOTHING else — an in-place edit of the kit
    // code fails here instead of silently forking the framework.
    assert.equal(vendorize(readVendor(vendored)), readKit(kitPath));

    // Localize a failure too: any GC-side line changed WITHOUT the kit's
    // line naming it shows up here (the kit files evolve; whole-file equality
    // alone doesn't say WHICH copy drifted).
    const vendorLines = vendorize(readVendor(vendored)).split("\n");
    const kitLines = readKit(kitPath).split("\n");
    assert.equal(vendorLines.length, kitLines.length, "same line count after substitution");
    for (let i = 0; i < kitLines.length; i++) {
      assert.equal(vendorLines[i], kitLines[i], `line ${i + 1}`);
    }
  });
}

// The banner itself is a contract: it must name the strip marker so the
// substitution is honest, and never sit BELOW the kit header (where it
// would masquerade as kit code).
test("the vendoring_banner sits exactly once, above the kit header", () => {
  for (const [vendored] of MODULES) {
    const text = readVendor(vendored);
    assert.equal((text.match(/VENDORED VERBATIM/g) || []).length, 1, vendored);
    assert.ok(text.startsWith("// VENDORED VERBATIM"), vendored + " starts with the banner");
    assert.ok(text.indexOf(KIT_HEADER_MARKER) > text.indexOf("VENDORED VERBATIM"), vendored);
  }
});
