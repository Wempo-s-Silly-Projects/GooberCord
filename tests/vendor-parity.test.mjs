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

// Vendored banner law: public/js/vendor/ carries the frontload +
// designer/kit modules with a fixed VENDORED VERBATIM banner above each
// module's own "// Project Designer — <module>" header. The kit repo was
// cancelled by owner order 2026-11-18, so the against-the-kit byte-parity
// pins are RETIRED; what remains here is the banner shape contract on the
// app-owned vendored copies.

import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VENDOR_DIR = path.resolve(HERE, "../public/js/vendor");

// The kit header marker each vendored copy carries below the banner.
const KIT_HEADER_MARKER = "// Project Designer — ";

// [vendored path] — the three vendored modules.
const MODULES = [
  "frontload/dom.mjs",
  "frontload/tokens.mjs",
  "designer/kit.mjs",
];

function readVendor(name) {
  return readFileSync(path.join(VENDOR_DIR, name), "utf-8");
}

// The banner itself is a contract: it names the strip marker so the
// vendoring banner stays a structured header, and never sits BELOW the kit
// header (where it would masquerade as kit code).
test("the vendoring_banner sits exactly once, above the kit header", () => {
  for (const vendored of MODULES) {
    const text = readVendor(vendored);
    assert.equal((text.match(/VENDORED VERBATIM/g) || []).length, 1, vendored);
    assert.ok(text.startsWith("// VENDORED VERBATIM"), vendored + " starts with the banner");
    assert.ok(text.indexOf(KIT_HEADER_MARKER) > text.indexOf("VENDORED VERBATIM"), vendored);
  }
});
