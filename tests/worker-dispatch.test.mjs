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

// Pin: worker.mjs carries no second copy of the error mapping. The ONE
// classifier (errorReply) and the ONE dispatch chain (dispatch) come from the
// vendored framework; this file holds the line
// on the public behavior that must NOT have moved in the swap — the two 404
// copies, the shared 500 for a non-HttpError, and the console label (GC's
// twin carried the FORUM's "Forum request failed:" literal since the
// vendoring; it was DELIBERATELY renamed to GC's own in the follow-up commit
// — a separate act with these pins capturing the new label).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker.mjs";

const WORKER_SOURCE = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");

// A db stub that answers every read nothing — enough for the dispatch tier
// (filter priming reads site_settings, keeps the secret when it's absent)
// to reach the route chain.
function stubDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
}

const okEnv = (overrides = {}) => ({
  GOOBER_DB: stubDb(),
  GC_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
  GC_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ...overrides,
});

// --- structural: the copy is gone, the vendor is consumed ----------------------

test("worker.mjs no longer carries its own apiError — the classifier is the vendor's", () => {
  assert.ok(!/function apiError/.test(WORKER_SOURCE), "the inline second copy is gone");
  assert.match(WORKER_SOURCE, /import \{ dispatch, errorReply \} from "\.\/api\/vendor\/http\.mjs"/);
  assert.match(WORKER_SOURCE, /errorReply\(error, "GooberCord request failed:"\)/,
    "the console label is GC's OWN (deliberately renamed from the vendored-forum literal)");
});

test("the not-found tail stays THROWN 404s classified through the chain, not a rival shape", () => {
  const tail = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf("function notFound"));
  assert.match(tail, /That API endpoint does not exist\./);
  assert.match(tail, /Not found\./, "the tail keeps BOTH the api copy and the bare copy");
  assert.match(WORKER_SOURCE, /dispatch\(API_HANDLERS, notFound\)/,
    "the chain is the vendor dispatch, not an inlined handlers-for-loop");
});

// --- behavior: the swap cannot answer differently than the inline twin did ----

test("an unknown /api/ path answers the api 404 copy WITH the security header set", async () => {
  const response = await worker.fetch(new Request("https://goobercord.test/api/no-such-lane"), okEnv(), undefined);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "That API endpoint does not exist." });
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
});

test("a non-HttpError inside the chain takes the shared 500 and never echoes the error", async () => {
  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args);
  try {
    const response = await worker.fetch(
      new Request("https://goobercord.test/api/no-such-lane", { method: "POST" }),
      okEnv({ GC_WRITE_RATE_LIMITER: { limit: async () => { throw new Error("limiter exploded"); } } }),
      undefined,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Something went wrong. Please try again." });
    assert.deepEqual(captured[0][0], "GooberCord request failed:", "the renamed label survives the classifier verbatim");
  } finally {
    console.error = original;
  }
});

// --- pin: the static leg rides the vendor ---------------------------------------

test("worker.mjs stops carrying the static-leg twins — they come from the core leaf now", () => {
  assert.ok(!/function secureResponse/.test(WORKER_SOURCE), "the re-wrap comes from core via makeHttp(config)");
  assert.ok(!/isDocumentRequest|CONDITIONAL_HEADERS/.test(WORKER_SOURCE), "the conditional-get trade is the framework verbatim");
  assert.match(WORKER_SOURCE, /secureResponse, unconditional \} from "\.\/api\/core\/http\.mjs"/);
  // The build stamp STAYS app-side (the hardened anchored injector is a
  // GooberCord document, pinned by tests/stale-stamp-comment.test.mjs).
  assert.match(WORKER_SOURCE, /async function stampedAssetResponse/);
  assert.match(WORKER_SOURCE, /escapeHtmlAttribute\(build\)/);
  // The static-leg call shape survives the swap: stamp first, re-wrap last.
  assert.match(WORKER_SOURCE, /secureResponse\(await stampedAssetResponse\(await env\.ASSETS\.fetch\(unconditional\(request\)\), env\)\)/);
});

// Behavior through the static leg, driven exactly the way the stale-stamp
// suite drives it (a stub ASSETS): the re-wrap carries GC's divergent
// microphone policy, and the conditional-get trade applies to documents
// only — now decided by the vendored unconditional, not a local twin.
test("a document request drops conditionals and re-wraps with GC's security set", async () => {
  const seen = [];
  const env = {
    ASSETS: {
      fetch(request) {
        seen.push(request.headers);
        return new Response("<html><head></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "ETag": '"v1"' },
        });
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://goobercord.itswempo.workers.dev/", {
      headers: { "If-None-Match": '"v1"', "If-Modified-Since": "yesterday" },
    }),
    env,
    undefined,
  );
  assert.equal(response.status, 200);
  const arriving = seen[0];
  assert.equal(arriving.get("If-None-Match"), null, "the document's conditionals were dropped upstream");
  assert.equal(arriving.get("If-Modified-Since"), null);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(
    response.headers.get("Permissions-Policy"),
    "camera=(), microphone=(self), geolocation=()",
    "the static leg rides GC's divergent securityHeaders, not the framework default",
  );
});

test("a script asset keeps its conditionals (the 304 revalidation path survives)", async () => {
  const seen = [];
  const env = {
    ASSETS: {
      fetch(request) {
        seen.push(request.headers);
        return new Response("export {}", {
          status: 200,
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://goobercord.itswempo.workers.dev/app.js", {
      headers: { "Sec-Fetch-Dest": "script", "If-None-Match": '"v1"' },
    }),
    env,
    undefined,
  );
  assert.equal(response.status, 200);
  assert.equal(seen[0].get("If-None-Match"), '"v1"', "the conditionals were NOT dropped for a script");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY", "the re-wrap still applies");
});
