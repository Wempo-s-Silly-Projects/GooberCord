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

// GIF search (parity bundle 0020): the Tenor route's contract — the key is
// OWNER-SUPPLIED ONLY (never hardcoded, never committed, never echoed), an
// unconfigured environment answers the shared 503 before any caller work,
// the query/limit/position shapes are clamped, and the upstream payload is
// mapped down to the three picker fields. The upstream fetch is injected via
// globalThis.fetch (no network in tests).
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
    headers: { Cookie: "goober_session=" + token },
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
    envWithLimiters({ TENOR_API_KEY: "", GOOBER_DB: { prepare: () => { throw new Error("should never query"); } } }),
  );
  assert.equal(response.status, 503);
});

test("the configured search clamps the shape and maps Tenor's payload down to the picker fields", async () => {
  let upstreamUrl = null;
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        results: [
          { id: "abc123", content_description: "happy cat", media_formats: {
            gif: { url: "https://media.tenor.com/abc/full.gif" },
            tinygif: { url: "https://media.tenor.com/abc/tiny.gif" },
          } },
          { id: "no-media", content_description: "mystery" },
        ],
        next: "7",
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
      envWithLimiters({ TENOR_API_KEY: "OWNER-SECRET", GOOBER_DB: db }),
    );
    assert.equal(response.status, 200);
    const body = await bodyOf(response);
    assert.deepEqual(body.gifs, [
      { id: "abc123", description: "happy cat",
        url: "https://media.tenor.com/abc/full.gif",
        previewUrl: "https://media.tenor.com/abc/tiny.gif" },
      { id: "no-media", description: "mystery", url: null, previewUrl: null },
    ]);
    assert.equal(body.position, "7");
    // The key never appears in the RESPONSE (it rode the upstream URL only).
    assert.equal(!JSON.stringify(body).includes("OWNER-SECRET"), true);
    assert.match(upstreamUrl, /key=OWNER-SECRET/);
    assert.match(upstreamUrl, /q=happy\+cat/); // URLSearchParams encodes the space
    assert.match(upstreamUrl, /limit=8/);
  } finally {
    delete globalThis.fetch;
  }
});
