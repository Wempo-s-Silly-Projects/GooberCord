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

import test from "node:test";
import assert from "node:assert/strict";

import { relayVerify } from "../api/relay.mjs";

const REAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

test("relayNetworkBanCheck requires a boolean verdict and Forum-keyed IP hash", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ banned: true, ipHash: "a".repeat(64) }), { status: 200 });
  const { relayNetworkBanCheck } = await import("../api/relay.mjs");
  assert.deepEqual(await relayNetworkBanCheck(
    { RELAY_TOKEN: "r".repeat(64) },
    "203.0.113.7",
  ), { banned: true, ipHash: "a".repeat(64) });
});

test("relayNetworkBanCheck treats a malformed Forum answer as unavailable", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ blocked: true }), { status: 200 });
  const { relayNetworkBanCheck } = await import("../api/relay.mjs");
  assert.equal(await relayNetworkBanCheck(
    { RELAY_TOKEN: "r".repeat(64) },
    "203.0.113.7",
  ), null);
});

test("relayVerify rejects a successful HTTP response with a malformed JSON shape", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ accepted: true }), { status: 200 });
  const result = await relayVerify(
    { RELAY_TOKEN: "r".repeat(64) },
    "wempos",
    "correct-horse-battery",
  );
  assert.equal(result, null);
});

test("relayVerify treats malformed relay-token headers as an unavailable relay", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(JSON.stringify({ valid: true }), { status: 200 });
  };
  const result = await relayVerify(
    { RELAY_TOKEN: "valid-prefix\ninvalid-header" },
    "wempos",
    "correct-horse-battery",
  );
  assert.equal(result, null);
  assert.equal(called, false, "invalid header construction must fail before fetch");
});

test("relayVerify accepts only a boolean valid field", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ valid: true }), { status: 200 });
  const result = await relayVerify(
    { RELAY_TOKEN: "r".repeat(64) },
    "wempos",
    "correct-horse-battery",
  );
  assert.deepEqual(result, { valid: true });
});
