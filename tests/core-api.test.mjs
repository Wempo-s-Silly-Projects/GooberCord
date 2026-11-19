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

// The one fetch wrapper. Pins: JSON transport, the CSRF header only on
// mutating methods, 204 -> null, the additive error shape, and the 401
// signal that emits store's event (main.js's single listener consumes it).
import test from "node:test";
import assert from "node:assert/strict";

let lastRequest = null;
let responder = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

globalThis.fetch = async (path, init) => {
  lastRequest = { path, ...init };
  return responder();
};

const { api, setCsrfToken, AUTH_EVENT } = await import("../public/js/core/api.js");
const store = (await import("../public/js/core/store.js")).default;

test.beforeEach(() => {
  lastRequest = null;
  responder = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  store.reset();
});

test("a GET carries no CSRF header and no content-type; JSON rides the body", async () => {
  await api("/api/me");
  assert.equal(lastRequest.method, "GET");
  assert.equal(lastRequest.headers["X-CSRF-Token"], undefined);
  assert.equal(lastRequest.headers["Content-Type"], undefined);
  assert.equal(lastRequest.body, undefined);
  assert.equal(lastRequest.credentials, "same-origin");
});

test("mutating methods carry the session's CSRF token and serialized JSON", async () => {
  setCsrfToken("tok-123");
  await api("/api/servers", { method: "POST", body: { name: "GC" }, idempotencyKey: "abc" });
  assert.equal(lastRequest.headers["X-CSRF-Token"], "tok-123");
  assert.equal(lastRequest.headers["Content-Type"], "application/json");
  assert.equal(lastRequest.headers["Idempotency-Key"], "abc");
  assert.equal(lastRequest.body, JSON.stringify({ name: "GC" }));
});

test("204 resolves null; FormData travels untouched", async () => {
  responder = () => new Response(null, { status: 204 });
  assert.equal(await api("/api/auth/logout", { method: "POST" }), null);
  const form = new FormData();
  await api("/api/uploads", { method: "POST", body: form });
  assert.equal(lastRequest.body, form);
  assert.equal(lastRequest.headers["Content-Type"], undefined, "the boundary sets its own");
});

test("a failure throws the additive error shape (message, status, extra fields)", async () => {
  responder = () => new Response(JSON.stringify({
    error: "This account is currently banned.",
    banned: true,
    reason: "spam",
    expiresAt: 1800,
  }), { status: 403 });
  const error = await api("/api/anything").catch((caught) => caught);
  assert.equal(error.status, 403);
  assert.equal(error.message, "This account is currently banned.");
  assert.equal(error.banned, true);
  assert.equal(error.reason, "spam");
  assert.equal(error.expiresAt, 1800);
});

test("a 401 emits store's auth event exactly once per refusal", async () => {
  responder = () => new Response(JSON.stringify({ error: "Please sign in to do that." }), { status: 401 });
  const seen = [];
  store.on(AUTH_EVENT, () => seen.push(true));
  await api("/api/me").catch(() => {});
  assert.deepEqual(seen, [true]);
});

test("the wrapper is the only fetch in the client", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const root = join(dirname(new URL(import.meta.url).pathname), "..");
  for (const file of [
    "public/js/main.js", "public/js/ui/shell.js", "public/js/ui/landing.js",
    "public/js/core/store.js", "public/js/core/router.js",
  ]) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /\bfetch\(/, file);
  }
});

test("the transport's own failure words ride the bundle, byte-equal (the blessing's batch)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const here = dirname(new URL(import.meta.url).pathname);
  const en = JSON.parse(readFileSync(join(here, "../public/locales/en.json"), "utf8"));
  assert.equal(en["gc.errors.invalidResponse"], "Invalid response ({{status}})");
  assert.equal(en["gc.errors.requestFailed"], "Request failed ({{status}})");
  const apiSource = readFileSync(join(here, "../public/js/core/api.js"), "utf8");
  assert.match(apiSource, /t\("gc\.errors\.invalidResponse", \{ status: response\.status \}\)/);
  assert.match(apiSource, /typeof result\?\.error === "string"/);
  assert.match(apiSource, /Your security token is out of date\./);
  // The server's error string stays verbatim; the CSRF prefix stays the
  // server's bytes — recognition, never copy.
  assert.match(apiSource, /const message = typeof result\?\.error === "string" && result\.error\n      \? result\.error/);
});

test("the tokenStale seed stays dead (recognition rides the literal, not a key)", async () => {
  // The stale-CSRF prefix is the SERVER's bytes — like rules-gate's
  // GATE_MESSAGE, recognizability rides the exact string, it never
  // localizes, so the seed row was a dead key: the canon drops it.
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const here = dirname(new URL(import.meta.url).pathname);
  const en = JSON.parse(readFileSync(join(here, "../public/locales/en.json"), "utf8"));
  assert.equal(en["gc.errors.tokenStale"], undefined, "the dead seed is dropped");
  const apiSource = readFileSync(join(here, "../public/js/core/api.js"), "utf8");
  assert.match(apiSource, /Your security token is out of date\./,
    "the recognition literal stays");
  assert.doesNotMatch(apiSource, /tokenStale/);
});
