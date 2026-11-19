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

// The R2 recode port (gc-attachments + avatars onto wempos-forum-r2): pins
// for the OLD modules' new R2 rides, driven against a Map-backed fake R2
// bucket alongside the same fake-DB conventions as tests/media-module.test.mjs.
// Four orders are pinned: the intake is FAIL-CLOSED — the batch carries the
// ledger row alone (the chunk write-through is retired), the put is AWAITED
// after the commit and before createAttachment resolves, and a failed put
// rolls the byte-less row back and rejects the upload 503; serving reads R2
// first and falls back to the D1 chunk set (including the fail-safe: an R2
// object whose bytes fail the egress verifier never serves); the moderator's
// reject rides the existing changes==1 verdict with one R2 delete per doomed
// id; and a missing GC_MEDIA binding (local dev) keeps the D1 chunk intake
// and serving byte-identically to the D1-only old code.
import test from "node:test";
import assert from "node:assert/strict";

import { HttpError } from "../api/core/http.mjs";
import { handleMediaRoutes, createAttachment, deleteAttachmentObjectRide } from "../api/media.mjs";
import { handleAvatarRoutes } from "../api/avatars.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import {
  RATE_LIMIT_BINDINGS,
  ATTACHMENT_CHUNK_BYTES,
  GC_ATTACHMENT_OBJECT_PREFIX,
  GC_AVATAR_OBJECT_PREFIX,
  MAX_ATTACHMENT_BYTES,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const STAFF_ID = 2;
const USER_ID = 7;

// --- fixtures -------------------------------------------------------------------

// The smallest PNG the intake sanitizer accepts: signature, IHDR (13 data
// bytes), IEND. CRC bytes ride along verbatim.
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

// A non-PNG payload under an image/png row claim: the egress-verifier fail.
const NOT_PNG = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

// A Map-backed fake R2 bucket. get() answers a body-bearing object (the
// real R2ObjectBody shape: an arrayBuffer reader) or null for a miss.
function fakeR2() {
  const store = new Map();
  const calls = [];
  const objectFor = (key) => {
    const copy = new Uint8Array(store.get(key));
    return { key, body: copy.buffer, arrayBuffer: async () => copy.buffer.slice(0) };
  };
  return {
    store,
    calls,
    async get(key) {
      calls.push({ op: "get", key });
      return store.has(key) ? objectFor(key) : null;
    },
    async put(key, value) {
      calls.push({ op: "put", key });
      store.set(key, new Uint8Array(value));
    },
    async delete(key) {
      calls.push({ op: "delete", key });
      return store.delete(key);
    },
  };
}

// A fake execution context: every scheduled task is collected, then resolved
// by the tests, pinning the waitUntil ride order.
function fakeCtx() {
  const ctx = {
    tasks: [],
    waitUntil(promise) {
      ctx.tasks.push(Promise.resolve(promise).catch(() => {}));
    },
  };
  return ctx;
}

async function settled(ctx) {
  for (const task of ctx.tasks) await task;
}

// Ordered fake DB: the first matching route answers each statement shape.
// Top-level run() calls are recorded individually; batch() is recorded as
// ONE call carrying every statement's SQL + bound values.
function fakeDb(routes) {
  const calls = [];
  let nextRowId = 0;
  const find = (sql) => routes.find((route) => route.test(sql));
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
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// --- SQL-shape probes -----------------------------------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

const ATTACHMENT_ROW_TEST = (sql) =>
  sql.includes("FROM gc_attachments") && sql.includes("WHERE id = ? LIMIT 1");

const CHUNK_BYTES_TEST = (sql) =>
  sql.includes("SELECT data FROM gc_attachment_chunks") && sql.includes("ORDER BY seq");

const PAGED_CHUNK_TEST = (sql) =>
  sql.includes("SELECT seq, data FROM gc_attachment_chunks") && sql.includes("seq >= ?");

const STANDALONE_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_attachments") && sql.includes("VALUES (NULL, ?");

const REJECT_STATUS_TEST = (sql) =>
  sql.includes("UPDATE gc_attachments SET status = 'rejected'");

const AVATAR_ROW_MATCH = (sql) =>
  sql.includes("SELECT avatar_status, avatar_mime, avatar_data, pending_avatar_mime,") &&
  sql.includes("FROM users WHERE id = ? LIMIT 1");

const standaloneRoute = () => ({
  test: STANDALONE_INSERT_TEST,
  run: async () => ({ meta: { changes: 1, last_row_id: 41 } }),
});

const chunksRoute = (bytes) => ({
  test: CHUNK_BYTES_TEST,
  all: async () => ({ results: [{ data: bytes, seq: 0 }] }),
});

const approvedRow = (overrides = {}) => ({
  id: 41,
  uploader_id: USER_ID,
  status: "approved",
  mime: "image/png",
  size_bytes: 0,
  ...overrides,
});

async function staffFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: STAFF_ID,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role: "admin",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return {
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
    sessionRoute: { test: SESSION_READ_TEST, first: async () => row },
  };
}

// --- media intake: fail-closed, R2 store of record --------------------------------

test("intake commits D1 first, then awaits the R2 put before its success return", async () => {
  const image = pngImage();
  // The batch gate: held shut until the test release, so "no put before the
  // commit" is a real ordering pin, not a code-shape reading.
  let releaseBatch;
  const batchGate = new Promise((resolve) => { releaseBatch = resolve; });
  const gatedStandaloneRoute = {
    test: STANDALONE_INSERT_TEST,
    run: async () => {
      await batchGate;
      return { meta: { changes: 1, last_row_id: 41 } };
    },
  };
  const db = fakeDb([gatedStandaloneRoute]);
  const r2 = fakeR2();
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const pending = createAttachment(env, USER_ID, image);
  // The batch has not resolved — no R2 put may have been attempted yet.
  assert.equal(r2.calls.length, 0);

  releaseBatch();
  const attachment = await pending;
  assert.equal(attachment.id, 41);
  // The put is AWAITED on the intake path: it already landed by the time
  // the route's success returns — a background ride left to settle would
  // leave the bucket empty here.
  assert.equal(r2.calls.length, 1);
  assert.equal(r2.calls[0].key, GC_ATTACHMENT_OBJECT_PREFIX + "41");
  assert.deepEqual(
    Uint8Array.from(r2.store.get(GC_ATTACHMENT_OBJECT_PREFIX + "41")),
    image,
  );
  // The batch rides the gate as one commit (the ledger row ALONE — the
  // chunk write-through is retired under the binding).
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 1);
  assert.ok(batch.statements[0].sql.startsWith("INSERT INTO gc_attachments"));
});

test("a failed R2 put rolls the byte-less row back — the upload rejects 503", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  r2.put = async (key) => {
    r2.calls.push({ op: "put", key });
    throw new Error("bucket down");
  };
  const db = fakeDb([standaloneRoute()]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  // Fail closed: the put is the only byte leg, so its failure rejects the
  // intake with the store's 503 — never a committed byte-less row.
  await assert.rejects(
    createAttachment(env, USER_ID, image),
    (error) => error instanceof HttpError && error.status === 503,
  );
  // Exactly one put was attempted, then the compensating sweep: the
  // just-inserted pending row deleted AND its object-delete ride scheduled
  // (the rolled-back row now leaves no orphan behind — FINDING 2), and the
  // batch never carried a chunk statement.
  assert.deepEqual(r2.calls.map((call) => call.op), ["put", "delete"]);
  assert.equal(r2.calls[1].key, GC_ATTACHMENT_OBJECT_PREFIX + "41");
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 1);
  assert.ok(batch.statements[0].sql.startsWith("INSERT INTO gc_attachments"));
  const rollback = db.calls.find(
    (call) => call.call === "run" && (call.sql.startsWith("DELETE FROM gc_attachments WHERE id = ?") && call.sql.includes("AND status = 'pending'")),
  );
  assert.ok(rollback);
  assert.deepEqual(rollback.bound, [41]);
});

test("intake without the GC_MEDIA binding keeps the legacy D1 chunk intake", async () => {
  const image = pngImage();
  const db = fakeDb([standaloneRoute()]);
  const env = envWithLimiters({ GOOBER_DB: db });
  assert.ok(!("GC_MEDIA" in env));

  const attachment = await createAttachment(env, USER_ID, image);
  assert.equal(attachment.id, 41);
  assert.equal(attachment.status, "pending");
  assert.equal(attachment.mime, "image/png");
  assert.equal(attachment.width, null);
  assert.equal(attachment.height, null);
  assert.equal(attachment.sizeBytes, image.length);
  // The write-through is the no-binding lane's byte store: the batch still
  // carries the chunk INSERT set (row first, one INSERT per 64k page).
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const [rowInsert, ...chunkInserts] = batch.statements;
  assert.ok(rowInsert.sql.startsWith("INSERT INTO gc_attachments"));
  assert.ok(chunkInserts.length >= 1);
  for (const chunk of chunkInserts) {
    assert.ok(chunk.sql.startsWith("INSERT INTO gc_attachment_chunks"));
    assert.ok(chunk.bound[5].length <= ATTACHMENT_CHUNK_BYTES);
  }
});

// --- media serving: R2 first, D1 chunks fallback ---------------------------------

async function serveAttachment(env, id = 41) {
  const request = new Request(ORIGIN + "/api/attachments/" + id, { method: "GET" });
  return handleMediaRoutes(
    request, env, new URL(request.url), "/api/attachments/" + id, "GET", fakeCtx(),
  );
}

test("serving answers an R2 hit without touching the D1 chunk set", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  await r2.put(GC_ATTACHMENT_OBJECT_PREFIX + "41", image);
  const db = fakeDb([{ test: ATTACHMENT_ROW_TEST, first: async () => approvedRow() }]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAttachment(env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  // The D1 chunk read never happened.
  assert.ok(!db.calls.some((call) => call.call === "all" && CHUNK_BYTES_TEST(call.sql)));
});

test("serving falls back to the D1 chunks when R2 misses", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow() },
    chunksRoute(image),
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAttachment(env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.ok(db.calls.some((call) => call.call === "all" && CHUNK_BYTES_TEST(call.sql)));
});

test("serving falls back to the D1 chunks when the R2 object fails the egress verifier", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  await r2.put(GC_ATTACHMENT_OBJECT_PREFIX + "41", NOT_PNG);
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow() },
    chunksRoute(image),
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAttachment(env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
});

test("serving 404s when the row id is unknown under an R2 bucket", async () => {
  const r2 = fakeR2();
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => null },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  await assert.rejects(serveAttachment(env, 99), (error) => error.status === 404);
  // The id gate precedes any R2 read.
  assert.equal(r2.calls.length, 0);
});

test("serving without the GC_MEDIA binding serves the D1 chunks", async () => {
  const image = pngImage();
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow() },
    chunksRoute(image),
  ]);
  const env = envWithLimiters({ GOOBER_DB: db });
  assert.ok(!("GC_MEDIA" in env));

  const response = await serveAttachment(env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
});

test("serving answers a LARGE lane row's R2 object before the chunk-size lane", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  await r2.put(GC_ATTACHMENT_OBJECT_PREFIX + "41", image);
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow({ size_bytes: MAX_ATTACHMENT_BYTES + 1 }) },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  // Plus-tier multipart puts bytes ONLY in R2 (zero chunk rows): the object
  // serves 200 even though the size gate would route to the empty D1 set.
  const response = await serveAttachment(env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  // The paged chunk lane never ran.
  assert.ok(!db.calls.some((call) => call.call === "all" && PAGED_CHUNK_TEST(call.sql)));
});

test("serving a LARGE lane row absent from R2 falls back to the paged chunk stream", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow({ size_bytes: MAX_ATTACHMENT_BYTES + 1 }) },
    { test: PAGED_CHUNK_TEST, all: async () => ({ results: [{ data: image, seq: 0 }] }) },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAttachment(env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.ok(db.calls.some((call) => call.call === "all" && PAGED_CHUNK_TEST(call.sql)));
});

test("serving a LARGE lane row absent everywhere 404s exactly as before", async () => {
  const r2 = fakeR2();
  const db = fakeDb([
    { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow({ size_bytes: MAX_ATTACHMENT_BYTES + 1 }) },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  await assert.rejects(serveAttachment(env), (error) => error.status === 404);
  // The R2 consult still happened first — the miss just fell through.
  assert.ok(r2.calls.some((call) => call.op === "get" && call.key === GC_ATTACHMENT_OBJECT_PREFIX + "41"));
});

// --- media moderation: the R2 delete rides the changes==1 verdict ----------------

const chunkDeleteRoute = (changes) => ({
  test: (sql) => sql.includes("DELETE FROM gc_attachment_chunks") &&
    sql.includes("SELECT id FROM gc_attachments WHERE id = ? AND status = 'pending'"),
  run: async () => ({ meta: { changes } }),
});

const rejectRoute = (changes) => ({
  test: REJECT_STATUS_TEST,
  run: async () => ({ meta: { changes } }),
});

// One fake db routes BOTH the staff session read and the reject statements —
// the caller's staff fixture owns the cookie, so the session read and the
// supplied CSRF token answer to the same row.
async function rejectAttachment(env, staff, id = 41) {
  const request = new Request(ORIGIN + "/api/admin/attachments/" + id + "/reject", {
    method: "POST",
    headers: { Origin: ORIGIN, ...staff.headers },
  });
  const ctx = fakeCtx();
  const response = await handleMediaRoutes(
    request, env, new URL(request.url), "/api/admin/attachments/" + id + "/reject", "POST", ctx,
  );
  return { ctx, response };
}

test("a successful reject schedules one R2 object delete after the changes==1 verdict", async () => {
  const staff = await staffFixtures();
  const db = fakeDb([
    staff.sessionRoute,
    chunkDeleteRoute(1),
    rejectRoute(1),
  ]);
  const r2 = fakeR2();
  await r2.put(GC_ATTACHMENT_OBJECT_PREFIX + "41", pngImage());
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const { ctx, response } = await rejectAttachment(env, staff);
  assert.deepEqual(JSON.parse(await response.text()), { rejected: true, id: 41 });

  // The delete rides the verdict, through ctx.waitUntil — exactly one doomed
  // id (its own object key, once; the test's setup put is the other call).
  const deletes = () => r2.calls.filter((call) => call.op === "delete");
  assert.equal(deletes().length, 1);
  assert.deepEqual(deletes().map((call) => call.key), [GC_ATTACHMENT_OBJECT_PREFIX + "41"]);
  await settled(ctx);
  assert.equal(r2.store.has(GC_ATTACHMENT_OBJECT_PREFIX + "41"), false);
});

test("a failed (non-pending) reject schedules no R2 delete", async () => {
  const staff = await staffFixtures();
  const db = fakeDb([
    staff.sessionRoute,
    chunkDeleteRoute(0),
    rejectRoute(0),
  ]);
  const r2 = fakeR2();
  await r2.put(GC_ATTACHMENT_OBJECT_PREFIX + "41", pngImage());
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  await assert.rejects(rejectAttachment(env, staff), (error) => error.status === 404);
  assert.equal(r2.calls.some((call) => call.op === "delete"), false);
  assert.equal(r2.store.has(GC_ATTACHMENT_OBJECT_PREFIX + "41"), true);
});

test("a successful reject without the GC_MEDIA binding schedules nothing", async () => {
  const staff = await staffFixtures();
  const db = fakeDb([
    staff.sessionRoute,
    chunkDeleteRoute(1),
    rejectRoute(1),
  ]);
  const r2 = fakeR2();
  const env = envWithLimiters({ GOOBER_DB: db });

  const { ctx, response } = await rejectAttachment(env, staff);
  assert.deepEqual(JSON.parse(await response.text()), { rejected: true, id: 41 });
  assert.equal(ctx.tasks.length, 0);
  assert.equal(r2.calls.length, 0);
});

// --- the exported object-delete ride (out-of-scope callers' one-liner) ------------

test("deleteAttachmentObjectRide schedules one delete through ctx, no-op without the binding", async () => {
  const r2 = fakeR2();
  const env = envWithLimiters({ GC_MEDIA: r2 });
  const ctx = fakeCtx();

  deleteAttachmentObjectRide(env, ctx, 41);
  assert.equal(ctx.tasks.length, 1);
  await settled(ctx);
  assert.deepEqual(
    r2.calls.filter((call) => call.op === "delete").map((call) => call.key),
    [GC_ATTACHMENT_OBJECT_PREFIX + "41"],
  );

  // The no-binding dev lane answers the same one-line ride with nothing.
  const bindingless = envWithLimiters({});
  const silent = fakeCtx();
  deleteAttachmentObjectRide(bindingless, silent, 41);
  assert.equal(silent.tasks.length, 0);
  assert.equal(r2.calls.filter((call) => call.op === "delete").length, 1);
});

// --- avatars: R2 avatars/<id> first, D1 avatar_data fallback -----------------------

async function serveAvatar(env, id = USER_ID) {
  return handleAvatarRoutes(
    new Request(ORIGIN + "/api/avatars/" + id, { method: "GET" }),
    env, new URL(ORIGIN + "/api/avatars/" + id), "/api/avatars/" + id, "GET",
  );
}

const avatarRow = (overrides = {}) => ({
  user_id: USER_ID,
  avatar_mime: "image/png",
  avatar_data: null,
  ...overrides,
});

test("avatars serve an R2 hit even when the D1 row carries no bytes", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  await r2.put(GC_AVATAR_OBJECT_PREFIX + USER_ID, image);
  const db = fakeDb([
    {
      test: AVATAR_ROW_MATCH,
      first: async () => avatarRow(),
    },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAvatar(env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
});

test("avatars fall back to the D1 avatar_data when R2 misses", async () => {
  const image = pngImage();
  const r2 = fakeR2();
  const db = fakeDb([
    {
      test: AVATAR_ROW_MATCH,
      first: async () => avatarRow({ avatar_mime: "image/png", avatar_data: image }),
    },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAvatar(env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
});

test("avatars serve the R2 bytes in preference to D1 avatar_data", async () => {
  const r2Image = pngImage(32);
  const d1Image = pngImage(0);
  const r2 = fakeR2();
  await r2.put(GC_AVATAR_OBJECT_PREFIX + USER_ID, r2Image);
  const db = fakeDb([
    {
      test: AVATAR_ROW_MATCH,
      first: async () => avatarRow({ avatar_mime: "image/png", avatar_data: d1Image }),
    },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  const response = await serveAvatar(env);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), r2Image);
});

test("avatars 404 when neither R2 nor the D1 row holds bytes", async () => {
  const r2 = fakeR2();
  const db = fakeDb([
    { test: AVATAR_ROW_MATCH, first: async () => avatarRow() },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });

  await assert.rejects(serveAvatar(env), (error) => error.status === 404);
});

test("avatars without the GC_MEDIA binding serve D1 avatar_data only", async () => {
  const image = pngImage(8);
  const r2 = fakeR2();
  const db = fakeDb([
    {
      test: AVATAR_ROW_MATCH,
      first: async () => avatarRow({ avatar_mime: "image/png", avatar_data: image }),
    },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db });

  const response = await serveAvatar(env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.equal(r2.calls.length, 0);
});
