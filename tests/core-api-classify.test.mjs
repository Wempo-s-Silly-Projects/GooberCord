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

// The api layer's G-1/G-8 classification: the stale-CSRF 403 retries exactly
// once against a fresh /api/me token, the X-Rules-Gate header lands on the
// error as .rulesGate, and Retry-After parses to .retryAfter — everything
// else surfaces verbatim with no invented copy.
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
let responses = [];

const json = (body, status, headers = {}) => new Response(
  typeof body === "string" ? body : JSON.stringify(body),
  { status, headers },
);

globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, headers: init.headers || {}, method: init.method || "GET" });
  const next = responses.shift();
  return next();
};

const { api, setCsrfToken } = await import("../public/js/core/api.js");
const store = (await import("../public/js/core/store.js")).default;

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("a stale-CSRF 403 probes /api/me once and retries with the fresh token", async () => {
  setCsrfToken("stale");
  responses = [
    () => json({ error: "Your security token is out of date. Reload the page and try again." }, 403),
    () => json({ user: { id: 7, username: "wempo" }, csrfToken: "fresh" }, 200),
    () => json({ ok: true }, 200),
  ];
  const result = await api("/api/friends/settings", { method: "PUT", body: { acceptRequests: true } });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers["X-CSRF-Token"], "stale");
  assert.equal(calls[1].path, "/api/me", "the refresh probe");
  assert.equal(calls[2].headers["X-CSRF-Token"], "fresh", "the retry carries the fresh token");
  assert.equal(store.get("csrfToken"), "fresh");
});

test("the retry is EXACTLY once: a second stale response surfaces inline", async () => {
  setCsrfToken("stale");
  responses = [
    () => json({ error: "Your security token is out of date. Reload the page and try again." }, 403),
    () => json({ user: null, csrfToken: "fresh2" }, 200),
    () => json({ error: "Your security token is out of date. Reload the page and try again." }, 403),
  ];
  const error = await api("/api/friends", { method: "PUT", body: {} }).catch((caught) => caught);
  assert.equal(error.status, 403);
  assert.equal(error.message.startsWith("Your security token is out of date."), true);
  assert.equal(calls.length, 3, "no further loop: the caller renders it");
});

test("other 403s never retry; the X-Rules-Gate header rides the error", async () => {
  responses = [() => json(
    { error: "You must accept this server's rules before doing that.", serverId: 5, rules: "Be kind." },
    403, { "x-rules-gate": "server:5" },
  )];
  const error = await api("/api/channels/4/messages", { method: "POST", body: { body: "hi" } })
    .catch((caught) => caught);
  assert.equal(error.status, 403);
  assert.equal(error.rulesGate, "server:5");
  assert.equal(error.serverId, 5);
  assert.equal(error.rules, "Be kind.");
  assert.equal(calls.length, 1, "no CSRF retry for a rules gate");
});

test("Retry-After parses onto the error (the slowmode meter's fuel)", async () => {
  responses = [() => json(
    { error: "Slowmode is on — wait 30s before sending again." }, 429, { "retry-after": "30" },
  )];
  const error = await api("/api/channels/4/messages", { method: "POST", body: { body: "hi" } })
    .catch((caught) => caught);
  assert.equal(error.retryAfter, 30);
});
