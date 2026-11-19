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

// The rules-gate flow's recognizer: only the gate's exact shape opens the
// accept dialog (403 + the exact message + serverId + rules, from the payload
// OR the X-Rules-Gate header); every other 403 returns false for the caller's
// own verbatim rendering. One shared module for the REST arm and the WS arm.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const { rulesGateError } = await import("../public/js/ui/rules-gate.js");
const SOURCE = readFileSync(join(HERE, "../public/js/ui/rules-gate.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");

test("the exact gate shape is recognized; anything else is not", () => {
  const gate = rulesGateError({
    status: 403,
    message: "You must accept this server's rules before doing that.",
    serverId: 9,
    rules: "Be kind.",
  });
  assert.deepEqual(gate, { serverId: 9, rules: "Be kind." });
  // The header disambiguator fills a missing/ambiguous payload serverId.
  assert.deepEqual(rulesGateError({
    status: 403,
    message: "You must accept this server's rules before doing that.",
    rules: "Be kind.",
    rulesGate: "server:12",
  }), { serverId: 12, rules: "Be kind." });
  assert.equal(rulesGateError({ status: 403, message: "other refusal" }), null);
  assert.equal(rulesGateError({ status: 400, message: "You must accept this server's rules before doing that." }), null);
  assert.equal(rulesGateError(null), null);
  assert.equal(rulesGateError({
    status: 403, message: "You must accept this server's rules before doing that.", serverId: 5,
  }), null, "no rules doc = not the gate shape");
});

test("the flow: accept POSTs the bodyless accept route, then re-offers the original action once", () => {
  assert.match(SOURCE, /\/rules\/accept/);
  assert.match(SOURCE, /method: "POST"/);
  assert.match(SOURCE, /await onAccepted\(\)/, "the member's own action re-offered after the settle");
  assert.match(SOURCE, /modalOnly: true/, "the accept is a single confirmation, not a page farm");
});

test("both arms feed one module (the WS frame's fields share the shape)", () => {
  // api.js lands the REST header; the chat wave's send_failed frame carries
  // {rules, serverId} in the same field names — assert the field vocabulary.
  for (const field of ["serverId", "rules", "rulesGate"]) {
    assert.ok(SOURCE.includes(field), field);
  }
  assert.match(MAIN, /guardRulesGate|renderServerSettings/,
    "the REST arm rides the settings route's writes");
});

test("the gate's copy rides the bundle; the recognition string stays the server's (protocol)", () => {
  const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
  assert.equal(en["gc.gate.heading"], "This server has rules");
  assert.equal(en["gc.gate.body"], "To keep going here, accept this server's rules.");
  assert.equal(en["gc.gate.accept"], "Accept and continue");
  assert.equal(en["gc.gate.later"], "Not now");
  assert.match(SOURCE, /t\("gc\.gate\.heading"\)/);
  assert.match(SOURCE, /t\("gc\.gate\.body"\)/);
  assert.match(SOURCE, /t\("gc\.gate\.accept"\)/);
  assert.match(SOURCE, /t\("gc\.gate\.later"\)/);
  // GATE_MESSAGE is the SERVER's own 403 string — the recognizability of the
  // gate rides its exact bytes; it never localizes (the caller paints the
  // verbatim error). The seed row stays a catalog row, no call site.
  assert.match(SOURCE, /You must accept this server's rules before doing that/);
});
