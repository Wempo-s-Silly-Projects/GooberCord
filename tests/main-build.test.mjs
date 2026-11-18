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

// The boot's stamp contract: <meta name="app-build"> (VERSION@SHA) compared
// against /api/version's { version, build } every 60s; a successor offers a
// reload strip, never an auto-reload. compareBuild + the strip pin without a
// browser (main.js's browser boot is guarded so node can import the pure
// pieces).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { compareBuild, buildStaleStrip } from "../public/js/main.js";
import { initI18n } from "../public/js/i18n.js";

const HERE = dirname(new URL(import.meta.url).pathname);
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
let previousFetch = null;

// The en bundle primes FIRST: after this sweep commit the code carries no
// copy — buildStaleStrip paints through t("gc.boot.stale.*").
const enBundle = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify(enBundle), { status: 200 });
await initI18n();

test("an empty side never flags (a dev boot without vars is quiet)", () => {
  assert.deepEqual(compareBuild("", { version: "0.1.0", build: "abc" }), { stale: false });
  assert.deepEqual(compareBuild("0.1.0@abc", {}), { stale: false });
  assert.deepEqual(compareBuild("0.1.0@abc", null), { stale: false });
});

test("a deployed successor (a changed build) flags; the same stamp does not", () => {
  assert.deepEqual(compareBuild("0.1.0@abc", { version: "0.2.0", build: "def" }), { stale: true });
  assert.deepEqual(compareBuild("0.2.0@def", { version: "0.2.0", build: "def" }), { stale: false });
  assert.deepEqual(
    compareBuild("0.1.0@abc", { version: "0.1.0", build: "abc123" }),
    { stale: true },
    "the SHA half must match too — a version-only match is not the same build",
  );
});

test("no build component compares the version part only (dev servers)", () => {
  assert.deepEqual(
    compareBuild("0.1.0@whatever", { version: "0.1.0", build: "" }),
    { stale: false },
  );
  assert.deepEqual(
    compareBuild("0.1.0@whatever", { version: "0.2.0", build: "" }),
    { stale: true },
  );
});

test("the offer is a strip the member acts on: hidden by default, a quiet Reload", () => {
  // A minimal document stub is enough for the builder to run.
  const created = {};
  const doc = {
    createElement: (tag) => (created[tag] = {
      children: [], hidden: undefined, id: undefined,
      append: (...nodes) => created[tag].children.push(...nodes),
      addEventListener: () => {},
    }),
  };
  const strip = buildStaleStrip(doc);
  assert.equal(strip.id, "stale-build-strip");
  assert.equal(strip.hidden, true, "served hidden; the interval unhides it");
  const reload = strip.children.find((child) => child.textContent === "Reload");
  assert.ok(reload, "a Reload affordance exists");
  assert.ok(strip.children[0].includes("A new build is available."),
    "the strip's copy rides the en bundle through t(), verbatim in English");
});

test("the interval checks /api/version and only ever offers, never auto-reloads", () => {
  assert.match(MAIN, /api\("\/api\/version"\)/);
  assert.match(MAIN, /60000/);
  assert.match(MAIN, /removeAttribute\("hidden"\)/);
  assert.doesNotMatch(MAIN, /location\.reload\(\)(?![\s\S]*button)/);
});

test("the auth-expiry signal lands on Accounts, with exactly one listener registered", () => {
  assert.match(MAIN, /store\.on\(AUTH_EVENT/);
  assert.match(MAIN, /registerUnauthorizedHandler\(\)/);
  assert.match(MAIN, /wempoAccountsSignInUrl\(win\.location\.origin\)/);
  assert.match(MAIN, /if \(typeof window !== "undefined"\)/,
    "the browser boot is guarded so the pure exports pin in node");
});

const codeOnly = MAIN.replace(/\/\/[^\n]*/g, "");
test("the sweep carries no copy: the strip paints through t() keys", () => {
  for (const key of ["gc.boot.stale.available", "gc.boot.stale.reload"]) {
    assert.match(codeOnly, new RegExp("t\\(\"" + key + "\"\\)"), `${key} rides the lookup`);
    const value = enBundle[key];
    assert.doesNotMatch(codeOnly, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the literal copy lives only in en.json");
  }
});
