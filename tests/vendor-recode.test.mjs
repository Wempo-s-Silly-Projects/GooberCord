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

// Interface pins for the fleet-owned recode of api/vendor/{db,http}.mjs.
// Every export's contract the callers and the suite rely on is pinned here,
// so the recode can never silently move a signature, a status, or a message
// literal.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  parseActivityCursor,
  parseScoreCursor,
  encodeActivityCursor,
  encodeScoreCursor,
  makeBlockGate,
} from "../api/vendor/db.mjs";
import {
  HttpError,
  MAX_JSON_BYTES,
  securityHeaders,
  json,
  errorReply,
  dispatch,
  isDocumentRequest,
  unconditional,
  makeHttp,
} from "../api/vendor/http.mjs";

// --- api/vendor/db.mjs: cursor codecs ---------------------------------------

test("parseActivityCursor: ranked and legacy forms", () => {
  assert.deepEqual(parseActivityCursor("0_5_12"), { rank: 0, seconds: 5, id: 12 });
  assert.deepEqual(parseActivityCursor("1_5_12"), { rank: 1, seconds: 5, id: 12 });
  assert.deepEqual(parseActivityCursor("5_12"), { seconds: 5, id: 12 });
});

test("parseActivityCursor: malformed input parses to null", () => {
  for (const raw of [null, undefined, 5, "", "abc", "1_2_3_4", "99999999999999_1", "1_99999999999999_1"]) {
    assert.equal(parseActivityCursor(raw), null, String(raw));
  }
});

test("parseScoreCursor: signed score half", () => {
  assert.deepEqual(parseScoreCursor("3_12"), { score: 3, id: 12 });
  assert.deepEqual(parseScoreCursor("-3_12"), { score: -3, id: 12 });
  for (const raw of [null, 5, "", "_12", "3_", "3_-12", "9999999999999_1"]) {
    assert.equal(parseScoreCursor(raw), null, String(raw));
  }
});

test("encodeActivityCursor: rank mirrors pinned_at", () => {
  assert.equal(encodeActivityCursor({ pinned_at: null, last_activity_at: "5", id: "12" }), "1_5_12");
  assert.equal(encodeActivityCursor({ pinned_at: undefined, last_activity_at: 5, id: 12 }), "1_5_12");
  assert.equal(encodeActivityCursor({ pinned_at: 100, last_activity_at: 9, id: 2 }), "0_9_2");
});

test("encodeScoreCursor: net score + id", () => {
  assert.equal(encodeScoreCursor({ like_count: 5, dislike_count: 8, id: 9 }), "-3_9");
  assert.equal(encodeScoreCursor({ like_count: 0, dislike_count: 0, id: 1 }), "0_1");
  assert.equal(encodeScoreCursor({ like_count: "2", dislike_count: "0", id: "7" }), "2_7");
});

// --- api/vendor/db.mjs: the block gate ---------------------------------------

function fakeD1ForBlocks({ first = null, allResults = [] } = {}) {
  const queries = [];
  const makeFirst = (row) => async () => row;
  const makeAll = (results) => async () => ({ results });
  return {
    queries,
    FORUM_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            queries.push({ sql, params });
            return {
              first: makeFirst(first),
              all: makeAll(allResults),
            };
          },
        };
      },
    },
  };
}

test("makeBlockGate: blockPairExists consults both directions", async () => {
  const gate = makeBlockGate();
  const db = fakeD1ForBlocks({ first: { "1": 1 } });
  assert.equal(await gate.blockPairExists(db, 7, 11), true);
  assert.match(db.queries[0].sql, /FROM blocks/);
  assert.deepEqual(db.queries[0].params, [7, 11]);

  const gate2 = makeBlockGate({ table: "gc_blocks" });
  const db2 = fakeD1ForBlocks({});
  assert.equal(await gate2.blockPairExists(db2, 7, 11), false);
  assert.match(db2.queries[0].sql, /FROM gc_blocks/);
});

test("makeBlockGate: table/column literals ride config into the SQL", () => {
  const gate = makeBlockGate({ table: "gc_blocks", blockerColumn: "a_id", blockedColumn: "b_id" });
  const filter = gate.blockFilterSql("author_id");
  assert.match(filter, /AND author_id NOT IN/);
  assert.match(filter, /SELECT b_id FROM gc_blocks WHERE a_id = /);
  assert.match(filter, /UNION SELECT a_id FROM gc_blocks WHERE b_id = /);
});

test("makeBlockGate: blockedIdList flattens the union and coerces to Number", async () => {
  const gate = makeBlockGate();
  const db = fakeD1ForBlocks({ allResults: [{ id: "3" }, { id: 8 }] });
  assert.deepEqual(await gate.blockedIdList(db, "12"), [3, 8]);
  assert.deepEqual(db.queries[0].params, [12]);
});

test("makeBlockGate: viewer filter is empty for guests and staff", () => {
  const gate = makeBlockGate();
  assert.equal(gate.viewerBlockFilterSql(null, "author_id"), "");
  assert.equal(gate.viewerBlockFilterSql({ id: 3, role: "owner" }, "author_id"), "");
  assert.equal(gate.viewerBlockFilterSql({ id: 3, role: "admin" }, "author_id"), "");
  // A viewer with an id but no resolved public role is not staff — filtered.
  assert.equal(gate.viewerBlockFilterSql({ id: 3 }, "author_id"), gate.blockFilterSql("author_id"));
  const custom = makeBlockGate({ staffRoles: ["mod"] });
  assert.equal(custom.viewerBlockFilterSql({ id: 3, role: "owner" }, "author_id"), gate.blockFilterSql("author_id"));
  assert.equal(custom.viewerBlockFilterSql({ id: 3, role: "mod" }, "author_id"), "");
});

// --- api/vendor/http.mjs: the vocabulary ------------------------------------

test("HttpError carries status/headers/payload and is an Error", () => {
  const error = new HttpError(429, "Slow down.", { "Retry-After": "60" }, { error: "x", extra: 1 });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "HttpError");
  assert.equal(error.status, 429);
  assert.deepEqual(error.headers, { "Retry-After": "60" });
  assert.deepEqual(error.payload, { error: "x", extra: 1 });
  assert.deepEqual(new HttpError(500, "x").headers, {});
  assert.equal(new HttpError(500, "x").payload, null);
});

test("MAX_JSON_BYTES is 16 KiB", () => {
  assert.equal(MAX_JSON_BYTES, 16 * 1024);
});

test("securityHeaders: applies the full set and preserves existing headers", () => {
  const headers = securityHeaders(new Headers({ "X-Existing": "yes" }));
  assert.equal(headers.get("X-Existing"), "yes");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.match(headers.get("Content-Security-Policy"), /default-src 'self'/);
  assert.match(headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});

test("json: security headers + no-store content type + status + body", async () => {
  const response = json({ ok: true }, 201, { "X-Marker": "1" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Marker"), "1");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.deepEqual(await response.json(), { ok: true });
});

test("errorReply: HttpErrors ride their own shape, the rest get the shared 500", async () => {
  const ban = errorReply(new HttpError(403, "banned", {}, { error: "banned", reason: "spam" }));
  assert.equal(ban.status, 403);
  assert.deepEqual(await ban.json(), { error: "banned", reason: "spam" });

  const plain = errorReply(new HttpError(400, "Bad input.", { "X-H": "1" }));
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get("X-H"), "1");
  assert.deepEqual(await plain.json(), { error: "Bad input." });

  const originalError = console.error;
  let capturedLabel = null;
  console.error = (label) => { capturedLabel = label; };
  try {
    const generic = errorReply(new Error("secret internals"), "App label:");
    assert.equal(capturedLabel, "App label:");
    assert.equal(generic.status, 500);
    assert.deepEqual(await generic.json(), { error: "Something went wrong. Please try again." });
  } finally {
    console.error = originalError;
  }
});

test("dispatch: first truthy response wins, after-tail, then the shared 404", async () => {
  const miss = () => null;
  const hit = () => json({ from: "hit" });
  const through = dispatch([miss, hit, () => json({ unreachable: true })]);
  assert.deepEqual(await (await through(new Request("https://x/"), {}, null, "/", "GET", null)).json(), { from: "hit" });

  const tailValue = json({ from: "tail" });
  const withAfter = dispatch([miss], () => tailValue);
  assert.deepEqual(await (await withAfter(new Request("https://x/"), {}, null, "/", "GET", null)).json(), { from: "tail" });

  await assert.rejects(
    dispatch([miss])(new Request("https://x/"), {}, null, "/", "GET", null),
    (error) => error instanceof HttpError && error.status === 404 && error.message === "Not found.",
  );
});

test("isDocumentRequest: sec-fetch-dest first, path heuristic fallback", () => {
  const withDest = (dest) => new Request("https://x/", { headers: dest ? { "Sec-Fetch-Dest": dest } : {} });
  assert.equal(isDocumentRequest(withDest("document")), true);
  assert.equal(isDocumentRequest(withDest("iframe")), true);
  assert.equal(isDocumentRequest(withDest("frame")), true);
  assert.equal(isDocumentRequest(withDest("DOCUMENT")), true);
  assert.equal(isDocumentRequest(withDest("style")), false);
  assert.equal(isDocumentRequest(withDest("empty")), false);
  assert.equal(isDocumentRequest(new Request("https://x/")), true);
  assert.equal(isDocumentRequest(new Request("https://x/a/b")), true);
  assert.equal(isDocumentRequest(new Request("https://x/page.html")), true);
  assert.equal(isDocumentRequest(new Request("https://x/a.PNG")), false);
});

test("unconditional: strips conditional gets from documents, leaves assets alone", () => {
  const documentRequest = new Request("https://x/", {
    headers: { "If-None-Match": "abc", "If-Modified-Since": "yesterday" },
  });
  const stripped = unconditional(documentRequest);
  assert.notEqual(stripped, documentRequest);
  assert.equal(stripped.headers.get("If-None-Match"), null);
  assert.equal(stripped.headers.get("If-Modified-Since"), null);
  assert.equal(stripped.url, documentRequest.url);
  assert.equal(stripped.method, "GET");

  const assetRequest = new Request("https://x/app.js", { headers: { "If-None-Match": "abc" } });
  assert.equal(unconditional(assetRequest), assetRequest);
});

// --- makeHttp: the config-bound half -----------------------------------------

function sha256HexExpected(value) {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function fakeRequestWithHeaders(url, headers = {}) {
  return new Request(url, { headers: new Headers(headers) });
}

test("makeHttp.rateLimit: a missing or malformed limiter is a hard 503", async () => {
  const app = makeHttp({ rateLimitBindings: {} });
  await assert.rejects(
    app.rateLimit(fakeRequestWithHeaders("https://x/"), {}, "login"),
    (error) => error instanceof HttpError && error.status === 503,
  );
  // A binding name configured but not present on env fails the same way —
  // never a silently unlimited route.
  const unmapped = makeHttp({ rateLimitBindings: { login: "MISSING" } });
  await assert.rejects(
    unmapped.rateLimit(fakeRequestWithHeaders("https://x/"), {}, "login"),
    (error) => error instanceof HttpError && error.status === 503,
  );
});

test("makeHttp.rateLimit: keys hash scope:actor and scope:ip", async () => {
  const seen = [];
  const limiter = { limit: async ({ key }) => { seen.push(key); return { success: true }; } };
  const app = makeHttp({ rateLimitBindings: { login: "RATE_LIMITER" } });
  await app.rateLimit(fakeRequestWithHeaders("https://x/", { "CF-Connecting-IP": "10.0.0.1" }),
    { RATE_LIMITER: limiter }, "login", "user-42");
  await app.rateLimit(fakeRequestWithHeaders("https://x/", { "CF-Connecting-IP": "10.0.0.1" }),
    { RATE_LIMITER: limiter }, "login");
  assert.deepEqual(seen, [
    sha256HexExpected("login:user-42"),
    sha256HexExpected("login:10.0.0.1"),
  ]);
});

test("makeHttp.rateLimit: a refused limit answers 429 with Retry-After", async () => {
  const limiter = { limit: async () => ({ success: false }) };
  const app = makeHttp({ rateLimitBindings: { login: "RATE_LIMITER" } });
  await assert.rejects(
    app.rateLimit(fakeRequestWithHeaders("https://x/", { "CF-Connecting-IP": "10.1.1.1" }),
      { RATE_LIMITER: limiter }, "login"),
    (error) => error instanceof HttpError && error.status === 429
      && error.headers["Retry-After"] === "60"
      && error.message === "Too many requests. Please wait a little and try again.",
  );
});

test("makeHttp.requireMutationApplied: changes !== 1 is the shared 403", async () => {
  const app = makeHttp({});
  const applied = { meta: { changes: 1 } };
  assert.equal(app.requireMutationApplied(applied), applied);
  await assert.rejects(
    async () => app.requireMutationApplied({ meta: { changes: 0 } }),
    (error) => error instanceof HttpError && error.status === 403
      && error.message === "This account is currently banned.",
  );
  await assert.rejects(async () => app.requireMutationApplied(null), (error) => error.status === 403);
});

test("makeHttp.readLimitedBody: caps by declared length and by streaming total", async () => {
  const app = makeHttp({ maxJsonBytes: 8 });
  await assert.rejects(
    app.readLimitedBody(fakeRequestWithHeaders("https://x/", { "Content-Length": "100" }), 8),
    (error) => error.status === 413,
  );
  const stream = new Request("https://x/", {
    method: "POST",
    body: "a".repeat(9),
  });
  await assert.rejects(
    app.readLimitedBody(stream, 8),
    (error) => error.status === 413,
  );
  const fits = new Request("https://x/", { method: "POST", body: "short" });
  const bytes = await app.readLimitedBody(fits, 8);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes), "short");
  const empty = await app.readLimitedBody(fakeRequestWithHeaders("https://x/"), 8);
  assert.deepEqual(empty, new Uint8Array(0));
});

test("makeHttp.readJson: content-type gate, JSON gate, object gate", async () => {
  const app = makeHttp({});
  await assert.rejects(
    app.readJson(fakeRequestWithHeaders("https://x/", { "Content-Type": "text/plain" })),
    (error) => error.status === 415 && error.message === "Send this form as JSON.",
  );
  const badBody = new Request("https://x/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  await assert.rejects(
    app.readJson(badBody),
    (error) => error.status === 400 && error.message === "The request body is not valid JSON.",
  );
  const arrayBody = new Request("https://x/", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: "[1,2]",
  });
  await assert.rejects(
    app.readJson(arrayBody),
    (error) => error.status === 400 && error.message === "The request body must be a JSON object.",
  );
  const goodBody = new Request("https://x/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "room" }),
  });
  assert.deepEqual(await app.readJson(goodBody), { name: "room" });
});

test("makeHttp.requiredText: type, emptiness, and length bounds", async () => {
  const app = makeHttp({});
  await assert.rejects(async () => app.requiredText(5, "name", 10), (error) => error.status === 400);
  await assert.rejects(async () => app.requiredText("   ", "name", 10), (error) => error.status === 400);
  await assert.rejects(async () => app.requiredText("abcde", "name", 4), (error) => error.status === 400);
  assert.equal(await app.requiredText("  ok  ", "name", 10), "ok");
});

test("makeHttp.secureResponse: rewraps header set, not body/status", async () => {
  const upstream = new Response("<html>", { status: 200, headers: { "Cache-Control": "public" } });
  const app = makeHttp({ securityHeaders: securityHeaders });
  const wrapped = app.secureResponse(upstream);
  assert.equal(wrapped.status, upstream.status);
  assert.match(wrapped.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});
