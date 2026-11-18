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

// T100 R2 migration — binding-CALL-SHAPE pins (docs/drafts/
// t100-r2-image-migration-spec.md §4). The fake env models the GC_MEDIA
// binding as a Map-backed stub recording every put/get/head/delete call
// (with the raw put value for byte checks), and every pin asserts the CALL
// SHAPE against it: the derived gc-attachments/<id> key, serving's get
// BEFORE any D1-chunk read, the delete ride in waitUntil, the commit's
// streamed put, and the fallback law — an env without the binding (tests,
// local dev) runs pure D1 with zero object calls.
import test from "node:test";
import assert from "node:assert/strict";

import { handleMediaRoutes, createAttachment } from "../api/media.mjs";
import { handleUploadRoutes } from "../api/uploads.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

// --- image fixtures (media-module's shapes, kept verbatim) -------------------------

function pngChunk(type, data = new Uint8Array(0)) {
  const out = new Uint8Array(12 + data.length);
  const length = data.length;
  out[0] = (length >>> 24) & 0xff;
  out[1] = (length >>> 16) & 0xff;
  out[2] = (length >>> 8) & 0xff;
  out[3] = length & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function pngImage(payloadBytes = 0) {
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
  ];
  if (payloadBytes > 0) parts.push(pngChunk("IDAT", new Uint8Array(payloadBytes)));
  parts.push(pngChunk("IEND"));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- fakes -------------------------------------------------------------------------

// Drains any put value: the small lane puts Uint8Array bytes; the large lane
// puts a ReadableStream sourced page-by-page from the D1 chunk set.
async function readAll(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof ReadableStream) {
    const chunks = [];
    const reader = value.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value));
    }
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
  throw new Error("fakeR2: unsupported put value " + typeof value);
}

// The Map-backed GC_MEDIA stub: every call lands in `calls` (op + key; puts
// also carry `value`), and puts resolve against the object map. `failPuts`
// flips the stub into the put-outage posture the best-effort pin asserts.
function fakeR2({ failPuts = false } = {}) {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    objects,
    async put(key, value) {
      const bytes = await readAll(value); // drained once; the entry records the bytes
      calls.push({ op: "put", key, value: bytes });
      if (failPuts) throw new Error("stub put outage");
      objects.set(key, bytes);
      return { key, etag: "e" + objects.size };
    },
    async get(key) {
      calls.push({ op: "get", key });
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { body: new Response(bytes).body, etag: "e" };
    },
    async head(key) {
      calls.push({ op: "head", key });
      const bytes = objects.get(key);
      return bytes ? { key, size: bytes.length, etag: "e" } : null;
    },
    async delete(key) {
      calls.push({ op: "delete", key });
      objects.delete(key);
    },
  };
}

function fakeCtx() {
  const waits = [];
  return {
    waits,
    waitUntil(promise) {
      waits.push(promise);
      promise.then(() => {}, () => {});
    },
  };
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The same ordered fake D1 the media-module tests ride.
function fakeDb(routes = []) {
  const calls = [];
  let nextRowId = 0;
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      calls.push({
        call: "batch",
        sql: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const ATTACHMENT_ROW_TEST = (sql) =>
  sql.includes("FROM gc_attachments") && sql.includes("WHERE id = ? LIMIT 1");
const CHUNK_BYTES_TEST = (sql) =>
  sql.includes("SELECT data FROM gc_attachment_chunks") && sql.includes("ORDER BY seq");
const PAGE_READ_TEST = (sql) =>
  sql.includes("SELECT seq, data FROM gc_attachment_chunks") && sql.includes("ORDER BY seq");

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });
const attachmentRoute = (row) => ({ test: ATTACHMENT_ROW_TEST, first: async () => row });
const chunksRoute = (data) => ({
  test: CHUNK_BYTES_TEST,
  all: async () => ({ results: (data || []).map((bytes) => ({ data: bytes })) }),
});

async function sessionFixtures(role = "member", userId = USER_ID) {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: userId,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role,
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return { token, row, headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf } };
}

async function dispatchMedia(request, env, ctx) {
  const url = new URL(request.url);
  try {
    return await handleMediaRoutes(request, env, url, url.pathname, request.method.toUpperCase(), ctx);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(error.payload || { error: error.message }, error.status, error.headers);
  }
}

async function dispatchUploads(request, env, ctx) {
  const url = new URL(request.url);
  try {
    return await handleUploadRoutes(request, env, url, url.pathname, request.method.toUpperCase(), ctx);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(error.payload || { error: error.message }, error.status, error.headers);
  }
}

// --- small intake --------------------------------------------------------------------

test("R2 small intake: createAttachment puts the sanitized bytes at gc-attachments/<id>, after the batch, in waitUntil", async () => {
  const bytes = pngImage();
  const db = fakeDb([]);
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const attachment = await createAttachment(
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
    USER_ID,
    bytes,
    ctx,
  );
  assert.equal(attachment.id, 1);

  // ONE put at the DERIVED key (row id, no schema change), the sanitized
  // bytes verbatim, riding ctx.waitUntil — the response never blocks on the
  // object write, and the id came from the D1 batch that preceded it.
  assert.deepEqual(bucket.calls.map((entry) => ({ op: entry.op, key: entry.key })), [
    { op: "put", key: "gc-attachments/1" },
  ]);
  assert.deepEqual(bucket.calls[0].value, bytes);
  assert.equal(ctx.waits.length, 1, "the put rode ctx.waitUntil");
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
});

test("R2 put failure is best-effort: the intake still resolves, the D1 row stands, no retry loop", async () => {
  const bytes = pngImage();
  const db = fakeDb([]);
  const bucket = fakeR2({ failPuts: true });
  const ctx = fakeCtx();
  const attachment = await createAttachment(
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
    USER_ID,
    bytes,
    ctx,
  );
  // The row was born; the put miss is recorded and tolerated (the repair
  // lane back-fills; no retry in the request path).
  assert.equal(attachment.id, 1);
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
  assert.equal(bucket.calls.filter((entry) => entry.op === "put").length, 1);
  await ctx.waits[0]; // the tolerated rejection settles without blowing up
});

test("fallback law (intake): no GC_MEDIA binding — the pure-D1 intake with zero object calls", async () => {
  const db = fakeDb([]);
  const attachment = await createAttachment(envWithLimiters({ GOOBER_DB: db }), USER_ID, pngImage());
  assert.equal(attachment.id, 1);
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
});

// --- serving -------------------------------------------------------------------------

test("R2-first serving: get runs before any D1 chunk read, and the object serves under the imageResponse law", async () => {
  const bytes = pngImage();
  const db = fakeDb([
    attachmentRoute({
      id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png", size_bytes: bytes.length,
    }),
    // A D1 set EXISTS — the R2 hit must leave it untouched.
    chunksRoute([bytes]),
  ]);
  const bucket = fakeR2();
  bucket.objects.set("gc-attachments/55", bytes);
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55"),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="image"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);

  // The gate passed → the object was consulted ONCE, and the D1 chunk table
  // was NEVER read: the R2 hit short-circuits the byte reads entirely.
  assert.deepEqual(bucket.calls.map((entry) => entry.op), ["get"]);
  assert.equal(db.calls.filter((call) => CHUNK_BYTES_TEST(call.sql)).length, 0);
});

test("the security gate runs BEFORE the R2 read: a stranger on a pending row gets the 404 and zero object calls", async () => {
  const stranger = await sessionFixtures("member", 42);
  const db = fakeDb([
    sessionRoute(stranger.row),
    attachmentRoute({ id: 55, uploader_id: USER_ID, status: "pending", mime: "image/png", size_bytes: 57 }),
  ]);
  const bucket = fakeR2();
  bucket.objects.set("gc-attachments/55", pngImage());
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55", { headers: stranger.headers }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
  );
  assert.equal(response.status, 404);
  // The object store was never consulted — the pending bytes cannot leak
  // through the object path.
  assert.deepEqual(bucket.calls, []);
});

test("R2 miss falls back: the D1 chunk set serves byte-identical after the get", async () => {
  const bytes = pngImage();
  const db = fakeDb([
    attachmentRoute({
      id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png", size_bytes: bytes.length,
    }),
    chunksRoute([bytes]),
  ]);
  const bucket = fakeR2(); // empty bucket: the miss posture
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55"),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(bucket.calls.map((entry) => entry.op), ["get"]);
  // Exactly one D1 read assembled the fallback, after the get.
  assert.equal(db.calls.filter((call) => CHUNK_BYTES_TEST(call.sql)).length, 1);
});

test("fallback law (serving): no GC_MEDIA binding — the pure-D1 serving shape, zero object calls", async () => {
  const bytes = pngImage();
  const db = fakeDb([
    attachmentRoute({
      id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png", size_bytes: bytes.length,
    }),
    chunksRoute([bytes]),
  ]);
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55"),
    envWithLimiters({ GOOBER_DB: db }), // binding absent (tests/local dev)
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("an R2 object whose head fails the mime re-verification is NEVER served; the D1 set answers instead", async () => {
  const bytes = pngImage();
  const db = fakeDb([
    attachmentRoute({
      id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png", size_bytes: bytes.length,
    }),
    chunksRoute([bytes]),
  ]);
  const bucket = fakeR2();
  bucket.objects.set("gc-attachments/55", new TextEncoder().encode("not an image under any magic"));
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55"),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(bucket.calls.filter((entry) => entry.op === "get").length, 1);
});

test("R2-first serving for the streamed large lane: the object serves under the large header twin, no D1 page read", async () => {
  const bytes = pngImage(64); // any R2 body size; size_bytes is the row's metadata
  const db = fakeDb([
    attachmentRoute({
      id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png",
      size_bytes: MAX_ATTACHMENT_BYTES + 5, // the streaming branch's trigger
    }),
  ]);
  const bucket = fakeR2();
  bucket.objects.set("gc-attachments/55", bytes);
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55"),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="image"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  // The object hit: the D1 chunk set was never paged.
  assert.deepEqual(bucket.calls.map((entry) => entry.op), ["get"]);
  assert.equal(db.calls.filter((call) => PAGE_READ_TEST(call.sql)).length, 0);
});

// --- delete rides --------------------------------------------------------------------

const REJECT_STATUS_TEST = (sql) => sql.startsWith("UPDATE gc_attachments SET status = 'rejected'");

test("the reject flip deletes the object via ctx.waitUntil; a 404 miss never fires one", async () => {
  const staff = await sessionFixtures("moderator", 9);
  const db = fakeDb([sessionRoute(staff.row)]);
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const response = await dispatchMedia(
    new Request(ORIGIN + "/api/admin/attachments/55/reject", {
      method: "POST",
      headers: { Origin: ORIGIN, ...staff.headers },
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }),
    ctx,
  );
  assert.equal(response.status, 200);

  // ONE delete at the derived key, scheduled in waitUntil (best-effort — the
  // D1 flip above stays the authority; a missed delete is an orphan the
  // sweep reports, never a dangling reference). Fires only when the row
  // actually died.
  await ctx.waits[0];
  assert.deepEqual(bucket.calls.map((entry) => ({ op: entry.op, key: entry.key })), [
    { op: "delete", key: "gc-attachments/55" },
  ]);

  // The miss posture (the D1 flip answered 404): no object op, no scheduled task.
  const missDb = fakeDb([sessionRoute(staff.row), { test: REJECT_STATUS_TEST, run: async () => ({ meta: { changes: 0 } }) }]);
  const missBucket = fakeR2();
  const missCtx = fakeCtx();
  const miss = await dispatchMedia(
    new Request(ORIGIN + "/api/admin/attachments/55/reject", {
      method: "POST",
      headers: { Origin: ORIGIN, ...staff.headers },
    }),
    envWithLimiters({ GOOBER_DB: missDb, GC_MEDIA: missBucket }),
    missCtx,
  );
  assert.equal(miss.status, 404);
  await Promise.all(missCtx.waits);
  assert.deepEqual(missCtx.waits, []);
  assert.deepEqual(missBucket.calls, []);
});

// --- large lane (commit) --------------------------------------------------------------

const PAGE_ROWS = 64;
// 400 full chunks = 25.6 MB: over the 20 MiB window the commit's size guard
// demands (the lane is the >-small-cap lane), under the 128-part max.
const LARGE_COUNT = 400;
const LARGE_SIZE = LARGE_COUNT * ATTACHMENT_CHUNK_BYTES;

function deterministicChunk(seq) {
  return new Uint8Array(ATTACHMENT_CHUNK_BYTES).fill(seq % 251);
}

const PLUS_TIER_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const STAGING_VERIFY_TEST = (sql) => sql.includes("MIN(CASE WHEN length(data)") && sql.includes("FROM gc_upload_parts");
const STAGING_HEAD_TEST = (sql) => sql.includes("FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0");
const STAGING_MOVE_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_attachment_chunks") && sql.includes("FROM gc_upload_parts");
const IDENTITY_TUPLE_TEST = (sql) => sql.includes("SELECT id FROM gc_attachments WHERE message_id IS NULL");

async function commitLarge(env, ctx, fixture) {
  const body = JSON.stringify({ size: LARGE_SIZE });
  return dispatchUploads(
    new Request(ORIGIN + "/api/uploads/abc123ABC123/commit", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", ...fixture.headers },
      body,
    }),
    env,
    ctx,
  );
}

function commitDbRoutes(fixture, { pages = false } = {}) {
  const order = [];
  const routes = [
    sessionRoute(fixture.row),
    { test: PLUS_TIER_TEST, first: async () => ({ renews_until: nowSeconds() + 3600, tier: "plus" }) },
    {
      test: STAGING_VERIFY_TEST,
      first: async () => ({ n: LARGE_COUNT, lo: 0, hi: LARGE_COUNT - 1, totalSize: LARGE_SIZE, firstShort: null }),
    },
    { test: STAGING_HEAD_TEST, first: async () => ({ data: pngImage() }) },
    { test: STAGING_MOVE_TEST, run: async () => ({ meta: { changes: LARGE_COUNT } }) },
    { test: IDENTITY_TUPLE_TEST, first: async () => ({ id: 777 }) },
  ];
  if (pages) {
    routes.push({
      test: PAGE_READ_TEST,
      all: async (bound) => {
        order.push("page");
        const cursor = Number(bound[1]);
        const rows = [];
        for (let seq = cursor; seq < Math.min(cursor + PAGE_ROWS, LARGE_COUNT); seq++) {
          rows.push({ seq, data: deterministicChunk(seq) });
        }
        return { results: rows };
      },
    });
  }
  return { order, routes };
}

test("the large lane's put: the commit streams the verified chunk set into GC_MEDIA at the derived key, after the batch", async () => {
  const fixture = await sessionFixtures();
  const { order, routes } = commitDbRoutes(fixture, { pages: true });
  const db = fakeDb(routes);
  const rawBatch = db.batch.bind(db);
  db.batch = async (statements) => {
    order.push("batch");
    return rawBatch(statements);
  };

  const bucket = fakeR2();
  const response = await commitLarge(envWithLimiters({ GOOBER_DB: db, GC_MEDIA: bucket }), {}, fixture);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { attachment: { id: 777, status: "pending" } });

  // ONE put at the derived key; the value is the FULL byte set, streamed
  // page-by-page (7 paged reads) and assembled byte-identical to the chunk set.
  assert.deepEqual(bucket.calls.map((entry) => entry.op), ["put"]);
  assert.equal(bucket.calls[0].key, "gc-attachments/777");
  const streamed = await readAll(bucket.calls[0].value);
  assert.equal(streamed.length, LARGE_SIZE);
  assert.deepEqual(streamed.slice(0, ATTACHMENT_CHUNK_BYTES), deterministicChunk(0));
  assert.deepEqual(streamed.slice(-ATTACHMENT_CHUNK_BYTES), deterministicChunk(LARGE_COUNT - 1));

  // Order: the D1 commit batch FIRST, the put after it, the paged reads the
  // put consumed last. The part contract rode UNCHANGED (3 statements).
  assert.equal(order[0], "batch");
  assert.equal(order.filter((marker) => marker === "batch").length, 1);
  assert.equal(order.filter((marker) => marker === "page").length, Math.ceil(LARGE_COUNT / PAGE_ROWS));
  const batch = db.calls.find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 3, "row insert + staging move + staging clear, unchanged");
});

test("fallback law (commit): no GC_MEDIA binding — the commit keeps its D1 shape with zero object calls", async () => {
  const fixture = await sessionFixtures();
  const { routes } = commitDbRoutes(fixture, { pages: false });
  const db = fakeDb(routes);
  const bucket = fakeR2(); // present but never consulted... and no env binding at all below
  const response = await commitLarge(envWithLimiters({ GOOBER_DB: db }), {}, fixture);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { attachment: { id: 777, status: "pending" } });
  assert.deepEqual(bucket.calls, []);
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
});
