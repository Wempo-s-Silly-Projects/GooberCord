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

// GIF search (KLIPY migration, Tenor EOL 2026-06-30): the KLIPY route's
// contract — the key is OWNER-SUPPLIED ONLY (never hardcoded, never
// committed, never echoed) and rides the UPSTREAM PATH segment, an
// unconfigured environment answers the shared 503 before any caller work,
// the query/limit/page shapes are clamped, and the upstream payload is
// mapped down to the same three picker fields the client contract carried —
// the wire shape NEVER changes with the provider. KLIPY's customer_id and
// locale are OMITTED ENTIRELY (privacy law: LIMIT COLLECTION NOT ACCESS —
// no user identifiers go to third parties). The upstream fetch is injected
// via globalThis.fetch (no network in tests).
import test from "node:test";
import assert from "node:assert/strict";

import { handleGifRoutes, GIF_SEARCH_CONFIGURED_ERROR } from "../api/gifs.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

// ONE memoized fixture: the session read must answer the SAME row the
// request's cookie was built from.
async function session() {
  const token = randomToken();
  return {
    row: {
      token_hash: await sha256Hex(token),
      user_id: USER_ID,
      csrf_token: randomToken(24),
      expires_at: nowSeconds() + 3600,
      username: "wempos",
      role: "member",
      bio: "",
      avatar_status: null,
      avatar_mime: null,
      avatar_updated_at: null,
      avatar_version: null,
      totp_enabled: 0,
    },
    headers: { Cookie: "__Host-goober_session=" + token },
  };
}

const SESSION_FIX = session();

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleGifRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

test("an unconfigured environment answers the shared 503 before any session work — never the network", async () => {
  let searched = false;
  globalThis.fetch = async () => { searched = true; return { ok: false }; };
  try {
    const response = await dispatch(
      new Request(ORIGIN + "/api/gifs/search?q=cats", { method: "GET" }),
      envWithLimiters({ GOOBER_DB: { prepare: () => { throw new Error("should never query"); } } }),
    );
    assert.equal(response.status, 503);
    assert.equal((await bodyOf(response)).error, GIF_SEARCH_CONFIGURED_ERROR);
    assert.equal(searched, false, "no upstream fetch without the secret");
  } finally {
    delete globalThis.fetch;
  }
});

test("an empty-string key counts as unconfigured", async () => {
  const response = await dispatch(
    new Request(ORIGIN + "/api/gifs/search?q=cats", { method: "GET" }),
    envWithLimiters({ KLIPY_API_KEY: "", GOOBER_DB: { prepare: () => { throw new Error("should never query"); } } }),
  );
  assert.equal(response.status, 503);
});

test("the configured search clamps the shape and maps KLIPY's payload down to the unchanged picker fields", async () => {
  let upstreamUrl = null;
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        result: true,
        data: {
          data: [
            { id: "abc123", title: "happy cat", file: {
              md: { gif: { url: "https://static.klipy.com/abc/md.gif" } },
              sm: { gif: { url: "https://static.klipy.com/abc/sm.gif" } },
            } },
            { id: "no-media", title: "mystery", file: {} },
          ],
          current_page: 1,
          per_page: 8,
          has_next: true,
        },
      }),
    };
  };
  try {
    const db = {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (SESSION_READ_TEST(sql) ? (await SESSION_FIX).row : null),
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    };
    const response = await dispatch(
      new Request(ORIGIN + "/api/gifs/search?q=happy%20cat&limit=8", {
        method: "GET",
        headers: (await SESSION_FIX).headers,
      }),
      envWithLimiters({ KLIPY_API_KEY: "OWNER-SECRET", GOOBER_DB: db }),
    );
    assert.equal(response.status, 200);
    const body = await bodyOf(response);
    assert.deepEqual(body.gifs, [
      { id: "abc123", description: "happy cat",
        url: "https://static.klipy.com/abc/md.gif",
        previewUrl: "https://static.klipy.com/abc/sm.gif" },
      { id: "no-media", description: "mystery", url: null, previewUrl: null },
    ]);
    assert.equal(body.position, "2", "KLIPY's page cursor maps DOWN to the wire's opaque position — has_next hands the next page");
    // The key never appears in the RESPONSE (it rode the upstream path only)
    // and the privacy law rides: no customer_id, no locale, no client_key.
    const echo = JSON.stringify(body);
    assert.equal(!echo.includes("OWNER-SECRET"), true);
    assert.match(upstreamUrl, /\/api\/v1\/OWNER-SECRET\/gifs\/search/, "the key rides KLIPY's PATH segment");
    assert.match(upstreamUrl, /q=happy\+cat/); // URLSearchParams encodes the space
    assert.match(upstreamUrl, /per_page=8/);
    assert.match(upstreamUrl, /content_filter=low/, "the named default content filter rides");
    assert.match(upstreamUrl, /format_filter=gif/, "the route asks the one format the picker renders");
    assert.doesNotMatch(upstreamUrl, /customer_id=|locale=|client_key=/,
      "LIMIT COLLECTION NOT ACCESS — no user identifiers or free locale knobs ride upstream");
  } finally {
    delete globalThis.fetch;
  }
});

test("the position cursor maps to KLIPY's page: the wire's token walks one page at a time", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      json: async () => ({ result: true, data: { data: [], current_page: 3, per_page: 12, has_next: false } }),
    };
  };
  try {
    const db = {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (SESSION_READ_TEST(sql) ? (await SESSION_FIX).row : null),
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    };
    const response = await dispatch(
      new Request(ORIGIN + "/api/gifs/search?q=cats&position=3", {
        method: "GET",
        headers: (await SESSION_FIX).headers,
      }),
      envWithLimiters({ KLIPY_API_KEY: "OWNER-SECRET", GOOBER_DB: db }),
    );
    assert.equal(response.status, 200);
    assert.match(seen[0], /page=3/, "the wire's position token walks KLIPY's page param");
    const body = await bodyOf(response);
    assert.equal(body.gifs.length, 0);
    assert.equal(body.position, null, "has_next=false hands back the end-of-list null the client contract carries");
  } finally {
    delete globalThis.fetch;
  }
});

test("the page size clamps at 50 (KLIPY's per_page ceiling) — beyond is the shared 400", async () => {
  const db = {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (SESSION_READ_TEST(sql) ? (await SESSION_FIX).row : null),
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    };
  for (const limit of ["51", "0", "-3", "12x"]) {
    const response = await dispatch(
      new Request(ORIGIN + "/api/gifs/search?q=cats&limit=" + encodeURIComponent(limit), {
        method: "GET",
        headers: (await SESSION_FIX).headers,
      }),
      envWithLimiters({ KLIPY_API_KEY: "OWNER-SECRET", GOOBER_DB: db }),
    );
    assert.equal(response.status, 400, "limit=" + limit);
    assert.equal((await bodyOf(response)).error, "That page size is invalid.");
  }
});

test("KLIPY's failure shapes answer the shared 502 — a false result flag never maps down", async () => {
  const db = {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (SESSION_READ_TEST(sql) ? (await SESSION_FIX).row : null),
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ result: false, error: "upstream said no" }),
  });
  try {
    const response = await dispatch(
      new Request(ORIGIN + "/api/gifs/search?q=cats", {
        method: "GET",
        headers: (await SESSION_FIX).headers,
      }),
      envWithLimiters({ KLIPY_API_KEY: "OWNER-SECRET", GOOBER_DB: db }),
    );
    assert.equal(response.status, 502);
    assert.equal((await bodyOf(response)).error, "GIF search is unavailable right now.");
  } finally {
    delete globalThis.fetch;
  }
});
