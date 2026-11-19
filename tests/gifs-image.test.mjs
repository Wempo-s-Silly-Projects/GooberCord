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

// The GIF media proxy (owner-direct ruling wave 2): GET /api/gifs/image?u=
// <picker media url> streams Tenor's bytes same-origin so the site CSP's
// img-src 'self' admits the picker's <img>s. Pins: the 503-first key
// discipline (never touched network, never leaked), the Tenor-host
// allowlist (https + tenor.com or a subdomain — every other reference is
// the 400 and no fetch runs at all), the stream pass-through with the
// image/* pin + the shared cache, and the 502s (upstream fails, or
// upstream answers with bytes we did not validate as images).
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  handleGifRoutes,
  GIF_IMAGE_INVALID_ERROR,
  GIF_SEARCH_CONFIGURED_ERROR,
  GIF_SEARCH_UNAVAILABLE_ERROR,
} from "../api/gifs.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

const SESSION_FIX = (async () => {
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
})();

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

const sessionDb = {
  prepare: (sql) => ({
    bind: () => ({
      first: async () => (SESSION_READ_TEST(sql) ? (await SESSION_FIX).row : null),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    }),
  }),
};

test("an unconfigured environment 503s the shared copy before any session work or network", async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true }; };
  try {
    const response = await dispatch(
      new Request(ORIGIN + "/api/gifs/image?u=https%3A%2F%2Fmedia.tenor.com%2Fa.gif"),
      envWithLimiters({
        TENOR_API_KEY: "",
        GOOBER_DB: { prepare: () => { throw new Error("should never query"); } },
      }),
    );
    assert.equal(response.status, 503);
    assert.equal((await bodyOf(response)).error, GIF_SEARCH_CONFIGURED_ERROR);
    assert.equal(fetched, false, "no upstream fetch without the secret");
  } finally {
    delete globalThis.fetch;
  }
});

test("the allowlist pin: every non-Tenor-host or non-https reference is a 400 with no fetch", async () => {
  const refs = [
    "", // missing entirely
    "https://evil.com/a.gif",
    "https://tenor.com.evil.net/a.gif",
    "http://media.tenor.com/a.gif", // scheme downgraded
    "https://cdn.tenor-proxy.example/a.gif",
    "javascript:alert(1)",
    "tenor.com/a.gif", // not even an absolute URL
    "x".repeat(2049),
  ];
  for (const ref of refs) {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return { ok: true, body: "bytes", headers: { get: () => "image/gif" } };
    };
    try {
      const response = await dispatch(
        new Request(
          ORIGIN + "/api/gifs/image?u=" + encodeURIComponent(ref),
          { headers: (await SESSION_FIX).headers },
        ),
        envWithLimiters({ TENOR_API_KEY: "OWNER-SECRET", GOOBER_DB: sessionDb }),
      );
      assert.equal(response.status, 400, ref);
      assert.equal((await bodyOf(response)).error, GIF_IMAGE_INVALID_ERROR);
      assert.equal(fetched, false, "a refused reference never fetches");
    } finally {
      delete globalThis.fetch;
    }
  }
});

test("a valid Tenor reference streams through same-origin: bytes pass, image type pinned, cached", async () => {
  let upstreamUrl = null;
  // The upstream body is a real stream: the pass-through keeps it one (the
  // route never buffers a media body into a buffer).
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x16, 0x20]);
  const upstreamBody = () => new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
  globalThis.fetch = async (url) => {
    upstreamUrl = String(url);
    return {
      ok: true,
      body: upstreamBody(),
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/gif" : null) },
    };
  };
  const source = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "api", "gifs.mjs"),
    "utf8",
  );
  const proxySource = source.slice(source.indexOf("/api/gifs/image"));
  try {
    const response = await dispatch(
      new Request(
        ORIGIN + "/api/gifs/image?u=" +
          encodeURIComponent("https://media1.tenor.com/m/AAAQ-MDxyz/Cat%20gif.gif"),
        { headers: (await SESSION_FIX).headers },
      ),
      envWithLimiters({ TENOR_API_KEY: "OWNER-SECRET", GOOBER_DB: sessionDb }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/gif");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=86400");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.doesNotMatch(proxySource, /arrayBuffer|\.json\($|readLimitedBody/,
      "the proxy never buffers a media body — it hands the stream straight through");
    // The upstream target is the allowed host's own path + its search, and
    // the SECRET never rides a media fetch.
    assert.match(upstreamUrl, /^https:\/\/media1\.tenor\.com\/m\//);
    assert.equal(upstreamUrl.includes("OWNER-SECRET"), false);
    // The bytes arrive intact through the pass-through.
    const received = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...received], [...bytes]);
  } finally {
    delete globalThis.fetch;
  }
});

test("the upstream's failures answer the shared 502: not-ok, non-image, and network errors", async () => {
  const upstreamShapes = [
    { ok: false, headers: { get: () => "image/gif" } },
    { ok: true, headers: { get: () => "text/html" } },
    { ok: true, headers: { get: (name) => name === "content-type" ? "" : null } },
  ];
  for (const shape of upstreamShapes) {
    globalThis.fetch = async () => shape;
    try {
      const response = await dispatch(
        new Request(
          ORIGIN + "/api/gifs/image?u=" +
            encodeURIComponent("https://media.tenor.com/x/video.mp4"),
          { headers: (await SESSION_FIX).headers },
        ),
        envWithLimiters({ TENOR_API_KEY: "OWNER-SECRET", GOOBER_DB: sessionDb }),
      );
      assert.equal(response.status, 502);
      assert.equal((await bodyOf(response)).error, GIF_SEARCH_UNAVAILABLE_ERROR);
    } finally {
      delete globalThis.fetch;
    }
  }

  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const response = await dispatch(
      new Request(
        ORIGIN + "/api/gifs/image?u=" +
          encodeURIComponent("https://media.tenor.com/x/a.gif"),
        { headers: (await SESSION_FIX).headers },
      ),
      envWithLimiters({ TENOR_API_KEY: "OWNER-SECRET", GOOBER_DB: sessionDb }),
    );
    assert.equal(response.status, 502);
    assert.equal((await bodyOf(response)).error, GIF_SEARCH_UNAVAILABLE_ERROR);
  } finally {
    delete globalThis.fetch;
  }
});
