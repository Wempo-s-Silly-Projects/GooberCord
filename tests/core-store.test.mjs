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

// The bus: keyed state (notify only on real changes), named events, and the
// house rule that createStore — Kit's, vendored — is the state primitive.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const { get, set, subscribe, on, emit, reset, default: store } =
  await import("../public/js/core/store.js");

const SOURCE = readFileSync(join(HERE, "../public/js/core/store.js"), "utf8");

test.beforeEach(() => reset());

test("set() notifies touched keys only, and only on a !== change", () => {
  const seen = [];
  const stop = subscribe("user", (state, key) => seen.push([key, state.user]));
  set({ user: "wempo", other: 1 });
  set({ user: "wempo" }); // no-op: same value
  stop();
  set({ user: "again" });
  assert.deepEqual(seen, [["user", "wempo"]]);
});

test("an array-key subscription filters each key", () => {
  const seen = [];
  subscribe(["a", "b"], (state, key) => seen.push(key));
  set({ a: 1, c: 3 });
  set({ b: 2 });
  assert.deepEqual(seen, ["a", "b"]);
});

test("events fire for every listener each emit; unsubscribes go dead", () => {
  const seen = [];
  const off = on("auth:unauthorized", (p) => seen.push(p));
  const second = on("auth:unauthorized", (p) => seen.push(p));
  emit("auth:unauthorized", "x");
  off();
  second();
  emit("auth:unauthorized", "y");
  assert.deepEqual(seen, ["x", "x"]);
});

test("reset() returns a pristine bus (state gone, subscriptions dead)", () => {
  const seen = [];
  subscribe("k", () => seen.push(1));
  set({ k: 1 });
  reset();
  assert.deepEqual(seen, [1], "the pre-reset write fired its subscription");
  assert.equal(get("k"), undefined);
  set({ k: 2 });
  assert.deepEqual(seen, [1], "the pre-reset subscription never sees the post-reset write");
});

test("createStore — the vendored Kit primitive — is the state engine; no app-side twin", () => {
  assert.match(SOURCE, /import \{ createStore \} from "\.\.\/vendor\/designer\/kit\.mjs";/);
  assert.match(SOURCE, /createStore\(\{\}\)/);
  assert.equal((SOURCE.match(/localStorage/g) || []).length, 0, "no persistence here");
  // The named-event lane is not state, so it stays its own map.
  assert.match(SOURCE, /const eventSubscribers = new Map\(\)/);
});

test("the default export keeps the whole surface for importers", () => {
  for (const name of ["get", "set", "subscribe", "on", "emit", "reset"]) {
    assert.equal(typeof store[name], "function", name);
  }
});
