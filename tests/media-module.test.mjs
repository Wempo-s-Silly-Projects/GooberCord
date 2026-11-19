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

// Image attachments (Phase 1, Task 6): the multipart upload, the gated
// serving, the staff review queue, and the send-with-image variant — driven
// against a fake GOOBER_DB. Same fake conventions as the messages test
// module: fakeDb records every statement's bound values, with batch()
// carrying each statement's SQL so tests pin the guarded-SQL shape itself
// (the authorization and intake contracts live in the query text, so that is
// what the tests assert).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { handleMediaRoutes, createAttachment, prepareAttachmentBytes } from "../api/media.mjs";
import { handleMessageRoutes, sendMessageToChannel } from "../api/messages.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const CHANNEL_ID = 3;

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

// Builds a real multipart/form-data request the way a browser would: text
// parts as fields, file parts as Files named `image` (or another field name
// for the stray-file cases).
function multipartRequest(path, { fields = {}, files = [] }, headers = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, String(value));
  }
  for (const file of files) {
    form.append(file.field || "image", new File([file.bytes], file.name || "image.png"));
  }
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { Origin: ORIGIN, ...headers },
    body: form,
  });
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

// --- image fixtures -------------------------------------------------------------
// The smallest PNG the 2c4f571-intake sanitizer accepts: signature, IHDR
// (13 data bytes), IEND. CRC bytes ride along verbatim (the sanitizer never
// re-verifies them).

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

// An optional big IDAT chunk stretches the image across N chunk rows while
// staying a structurally valid PNG the sanitizer keeps verbatim.
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

// A prefix that sniffs as PNG but never reaches IEND: the structurally
// invalid case the sanitizer rejects even though the magic bytes look fine.
function truncatedPng() {
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...new Uint8Array(20),
  ]);
}

// --- fake db and sessions --------------------------------------------------------

// Ordered fake DB: the first matching route answers each statement shape.
// Top-level run() calls are recorded individually; batch() is recorded as ONE
// call carrying every statement's SQL + bound values (a real D1 batch executes
// its statements under a single transaction). Unrouted runs default to a
// single-row insert with an incrementing last_row_id, like a real write.
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

// A session row exactly as the vendored readSession SELECT joins it, with a
// real cookie/CSRF token pair for the requireUser-routed requests.
const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

async function sessionFixtures(role = "member", userId = USER_ID) {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: userId,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role, // the STORED vocabulary, exactly like the D1 row readSession joins
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return {
    token,
    row,
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

// --- SQL-shape probes ------------------------------------------------------------

const ATTACHMENT_ROW_TEST = (sql) =>
  sql.includes("FROM gc_attachments") && sql.includes("WHERE id = ? LIMIT 1");

const CHUNK_BYTES_TEST = (sql) =>
  sql.includes("SELECT data FROM gc_attachment_chunks") && sql.includes("ORDER BY seq");

const PENDING_QUEUE_TEST = (sql) =>
  sql.includes("FROM gc_attachments a JOIN users u") && sql.includes("status = 'pending'");

const APPROVE_TEST = (sql) =>
  sql.includes("UPDATE gc_attachments SET status = 'approved'") &&
  sql.includes("status = 'pending'");

const REJECT_STATUS_TEST = (sql) =>
  sql.includes("UPDATE gc_attachments SET status = 'rejected'");

const REJECT_CHUNKS_TEST = (sql) =>
  sql.includes("DELETE FROM gc_attachment_chunks") &&
  sql.includes("SELECT id FROM gc_attachments WHERE id = ? AND status = 'pending'");

const STANDALONE_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_attachments") && sql.includes("VALUES (NULL, ?");

const STANDALONE_CHUNK_TEST = (sql) =>
  sql.includes("INSERT INTO gc_attachment_chunks") &&
  sql.includes("message_id IS NULL AND uploader_id = ?");

// The multipart send's attachment INSERT: message_id resolved INSIDE the send
// batch by the idempotency triple, and replay-guarded.
const ATTACHED_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_attachments") &&
  sql.includes("client_message_id IS ?") &&
  sql.includes("WHERE NOT EXISTS");

const ATTACHED_CHUNK_TEST = (sql) =>
  sql.includes("INSERT INTO gc_attachment_chunks") &&
  sql.includes("client_message_id IS ?");

const MESSAGE_RESELECT_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("client_message_id") &&
  // The reselect is the triple read ended by the newest-first LIMIT 1 (the
  // page reads use LIMIT <page size>).
  sql.includes("ORDER BY m.id DESC LIMIT 1");

const MESSAGE_INSERT_TEST = (sql) =>
  sql.includes("INSERT INTO gc_messages") &&
  sql.includes("ON CONFLICT(channel_id, author_id, client_message_id) DO NOTHING");

const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c WHERE c.id = ?") &&
  sql.includes("gc_server_members m") &&
  sql.includes("gc_conversation_members cm");

const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");

const MESSAGES_PAGE_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") && sql.includes("ORDER BY m.id DESC LIMIT");

// The read-side visibility predicate (Task 6): the page's attachment lookup
// returns approved rows PLUS the viewer's own pending ones, in ONE lookup.
const ATTACHMENT_VISIBILITY_TEST = (sql) =>
  sql.includes("gc_attachments") &&
  sql.includes("status = 'approved' OR uploader_id = ?") &&
  sql.includes("ORDER BY id");

function messageRow(overrides = {}) {
  return {
    id: 5,
    author_id: USER_ID,
    author_name: "wempos",
    body: "hello",
    client_message_id: null,
    source: null,
    created_at: 100,
    edited_at: null,
    ...overrides,
  };
}

async function dispatch(request, env, handler = handleMediaRoutes) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handler(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

const writes = (db) => db.calls.filter((call) => call.call === "batch" || call.call === "run");

// --- handler contract ------------------------------------------------------------

test("media dispatch answers only its own paths and falls through elsewhere", async () => {
  const { row, headers } = await sessionFixtures();
  const env = envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) });
  assert.equal(
    await handleMediaRoutes(
      get("/api/nope"), env, new URL(ORIGIN + "/api/nope"), "/api/nope", "GET", undefined),
    undefined,
  );
  assert.equal(
    await handleMediaRoutes(
      get("/api/attachments/abc"), env, new URL(ORIGIN + "/api/attachments/abc"),
      "/api/attachments/abc", "GET", undefined),
    undefined,
  );
  assert.equal(
    await handleMediaRoutes(
      get("/api/admin"), env, new URL(ORIGIN + "/api/admin"), "/api/admin", "GET", undefined),
    undefined,
  );
});

// --- POST /api/attachments ---------------------------------------------------------

test("the approved intake stores one pending attachment and its 64000-byte chunks in ONE batch", async () => {
  const { row, headers } = await sessionFixtures();
  // 2.5 chunks' worth of bytes: the sanitizer passes the fixture through
  // verbatim (nothing to strip — the big IDAT is kept), so the chunking must
  // split it at 64000 exactly.
  const bytes = pngImage(ATTACHMENT_CHUNK_BYTES * 2 + 5 - 57);
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatch(
    multipartRequest("/api/attachments", { files: [{ bytes, name: "photo.png" }] }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), { attachment: { id: 1, status: "pending" } });

  // Everything rides one batch; no standalone writes.
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const [attachmentInsert, ...chunks] = batch.statements;

  // The metadata row: an unattached pending attachment (message_id NULL, a
  // server-bound uploader id and server clock — never client data).
  assert.match(
    attachmentInsert.sql,
    /^INSERT INTO gc_attachments \(message_id, uploader_id, mime, size_bytes, status, width, height, created_at\) VALUES \(NULL, \?, \?, \?, 'pending', NULL, NULL, \?\)$/,
  );
  assert.deepEqual(attachmentInsert.bound.slice(0, 3), [USER_ID, "image/png", bytes.length]);

  // One chunk INSERT per 64000-byte slice: 64000, 64000, then the tail.
  assert.equal(chunks.length, 3);
  const seqs = chunks.map((chunk) => chunk.bound[4]);
  assert.deepEqual(seqs, [0, 1, 2]);
  const tail = bytes.length - ATTACHMENT_CHUNK_BYTES * 2;
  assert.deepEqual(chunks.map((chunk) => chunk.bound[5].length), [64000, 64000, tail]);
  assert.ok(tail > 0 && tail <= ATTACHMENT_CHUNK_BYTES);
  // Each chunk resolves its attachment id INSIDE the batch (the row the first
  // statement just inserted), keyed on the unattached upload identity.
  assert.match(
    chunks[0].sql,
    /SELECT \(SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = \? AND mime = \? AND size_bytes = \? AND created_at = \? ORDER BY id DESC LIMIT 1\), \?, \?$/,
  );
});

test("(a) a non-image upload is refused with 400 and zero chunk rows", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatch(
    multipartRequest(
      "/api/attachments",
      { files: [{ bytes: new TextEncoder().encode("<script>alert(1)</script>"), name: "payload.png" }] },
      headers,
    ),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 400);
  assert.equal(
    (await bodyOf(response)).error,
    "Only JPEG, PNG, WebP, and GIF images can be attached.",
  );
  // Nothing was ever written or assembled: no attachment row, no chunks.
  assert.deepEqual(writes(db), []);
});

test("(a2) a sniffable but structurally invalid image is refused before any write", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatch(
    multipartRequest("/api/attachments", { files: [{ bytes: truncatedPng() }] }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 400);
  assert.equal(
    (await bodyOf(response)).error,
    "That image could not be read. Try re-saving it and uploading again.",
  );
  assert.deepEqual(writes(db), []);
});

test("(b) an upload over the 20 MiB free cap is refused 413 before any chunk insert", async () => {
  const { row, headers } = await sessionFixtures();
  const tooBig = async () => {
    const db = fakeDb([sessionRoute(row)]);
    const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    bytes.set(pngImage(), 0);
    const response = await dispatch(
      multipartRequest("/api/attachments", { files: [{ bytes }] }, headers),
      envWithLimiters({ GOOBER_DB: db }),
    );
    assert.equal(response.status, 413);
    assert.equal((await bodyOf(response)).error, "Images must be 20 MiB or smaller.");
    // The rejection happened before ANY intake write — one byte past the cap,
    // zero chunk rows ever existed.
    assert.deepEqual(writes(db), []);
  };
  // Route level AND the shared primitive level (the JS side of the schema's
  // size_bytes CHECK — the CHECK alone would only 500 after the fact).
  await tooBig();
  let primitiveGuard = false;
  try {
    await createAttachment(
      envWithLimiters({ GOOBER_DB: fakeDb([]) }),
      USER_ID,
      new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
    );
  } catch (error) {
    primitiveGuard = error instanceof HttpError && error.status === 413;
  }
  assert.equal(primitiveGuard, true);
});

test("the upload route demands a multipart body, exactly one image field, and a session", async () => {
  const { row, headers } = await sessionFixtures();
  // A JSON-typed POST is a client bug, not an upload: 415.
  const jsonTyped = await dispatch(
    new Request(ORIGIN + "/api/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: "{}",
    }),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) }),
  );
  assert.equal(jsonTyped.status, 415);

  // Two image fields is a contract violation, not "take the first".
  const two = await dispatch(
    multipartRequest("/api/attachments", {
      files: [{ bytes: pngImage() }, { bytes: pngImage() }],
    }, headers),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) }),
  );
  assert.equal(two.status, 400);
  assert.equal((await bodyOf(two)).error, "Attach exactly one image.");

  // A file part under another field name is refused (the pipeline only ever
  // reads `image`).
  const stray = await dispatch(
    multipartRequest("/api/attachments", { files: [{ bytes: pngImage(), field: "doc" }] }, headers),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) }),
  );
  assert.equal(stray.status, 400);

  // No session cookie: the same-origin/CSRF gate 401s before any intake.
  const db = fakeDb([]);
  const unauthorized = await dispatch(
    multipartRequest("/api/attachments", { files: [{ bytes: pngImage() }] }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(writes(db), []);
});

test("the upload rides the GC_UPLOAD rate limiter under the session's user id", async () => {
  const { row, headers } = await sessionFixtures();
  const limiterKeys = [];
  const env = envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) });
  env[RATE_LIMIT_BINDINGS.upload] = {
    limit: async ({ key }) => {
      limiterKeys.push(key);
      return { success: true };
    },
  };
  await dispatch(
    multipartRequest("/api/attachments", { files: [{ bytes: pngImage() }] }, headers),
    env,
  );
  // One keyed entry, and the keyed limiter's key is the salted sha256 of
  // "upload:user:<id>" — the session's user id scopes it, never request data.
  assert.equal(limiterKeys.length, 1);
  assert.equal(limiterKeys[0].length, 64);
});

// --- GET /api/attachments/:id ------------------------------------------------------

const attachmentRoute = (row) => ({ test: ATTACHMENT_ROW_TEST, first: async () => row });
const chunksRoute = (data) => ({
  test: CHUNK_BYTES_TEST,
  all: async () => ({ results: (data || []).map((bytes) => ({ data: bytes })) }),
});

test("(c) a third party cannot fetch a pending attachment at all", async () => {
  const { row, headers } = await sessionFixtures("member", 42); // someone else
  const pending = {
    id: 55,
    uploader_id: USER_ID,
    status: "pending",
    mime: "image/png",
  };
  const db = fakeDb([sessionRoute(row), attachmentRoute(pending), chunksRoute([pngImage()])]);
  const response = await dispatch(
    get("/api/attachments/55", headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  // 404 — never 403, and never a partial serve: the endpoint does not confirm
  // the existence of bytes a stranger may not see.
  assert.equal(response.status, 404);
  assert.equal((await bodyOf(response)).error, "Attachment not found.");
  // The gate sat BEFORE the chunk assembly: no byte read ever ran.
  assert.equal(db.calls.filter((call) => CHUNK_BYTES_TEST(call.sql)).length, 0);
});

test("(c2) the uploader receives their own pending image with the sniffed content type", async () => {
  const { row, headers } = await sessionFixtures();
  const bytes = pngImage();
  const db = fakeDb([
    sessionRoute(row),
    attachmentRoute({ id: 55, uploader_id: USER_ID, status: "pending", mime: "image/png" }),
    chunksRoute([bytes]),
  ]);
  const response = await dispatch(
    get("/api/attachments/55", headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  // Pending bytes are the uploader's: private, short-lived caching, and the
  // full defensive header set comes from imageResponse itself.
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="image"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("(c3) stored-role staff can review pending bytes; rejected rows serve nothing", async () => {
  // Stored 'moderator' is the admin tier in the PRE-3.1 vocabulary; readSession
  // maps it to the public 'admin' the staff check compares against.
  const { row, headers } = await sessionFixtures("moderator", 42);
  const db = fakeDb([
    sessionRoute(row),
    attachmentRoute({ id: 55, uploader_id: USER_ID, status: "pending", mime: "image/png" }),
    chunksRoute([pngImage()]),
  ]);
  const response = await dispatch(
    get("/api/attachments/55", headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);

  // A rejected row has no chunk rows left (rejection removed them in its
  // batch), so nobody — not even staff — can serve one: always the same 404.
  const rejected = fakeDb([
    sessionRoute(row),
    attachmentRoute({ id: 56, uploader_id: USER_ID, status: "rejected", mime: "image/png" }),
    chunksRoute([]),
  ]);
  const rejectedResponse = await dispatch(
    get("/api/attachments/56", headers),
    envWithLimiters({ GOOBER_DB: rejected }),
  );
  assert.equal(rejectedResponse.status, 404);
});

test("(d) approval flips a pending row to approved; a third party can then GET it", async () => {
  const staff = await sessionFixtures("admin", 9); // stored 'admin' → public 'owner'
  const viewer = await sessionFixtures("member", 42);
  const envDb = fakeDb([sessionRoute(staff.row)]);
  const approveResponse = await dispatch(
    new Request(ORIGIN + "/api/admin/attachments/55/approve", {
      method: "POST",
      headers: { Origin: ORIGIN, ...staff.headers },
    }),
    envWithLimiters({ GOOBER_DB: envDb }),
  );

  assert.equal(approveResponse.status, 200);
  assert.deepEqual(await bodyOf(approveResponse), { approved: true, id: 55 });
  // ONE guarded statement: the reviewer's id and the clock ride the guard —
  // a non-pending (or already reviewed) row can never be re-labeled.
  const approve = envDb.calls.find((call) => APPROVE_TEST(call.sql));
  assert.ok(approve);
  assert.match(
    approve.sql,
    /^UPDATE gc_attachments SET status = 'approved', reviewed_by = \?, reviewed_at = \? WHERE id = \? AND status = 'pending'$/,
  );
  assert.equal(approve.bound[0], 9); // the reviewer's id, from the session
  assert.equal(typeof approve.bound[1], "number"); // the server clock
  assert.equal(approve.bound[2], 55);
  assert.deepEqual(writes(envDb).length, 1);

  // Now a third party's GET succeeds with the public, immutable cache contract.
  const serveDb = fakeDb([
    sessionRoute(viewer.row),
    attachmentRoute({ id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png" }),
    chunksRoute([pngImage()]),
  ]);
  const serve = await dispatch(
    get("/api/attachments/55", viewer.headers),
    envWithLimiters({ GOOBER_DB: serveDb }),
  );
  assert.equal(serve.status, 200);
  assert.equal(serve.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(serve.headers.get("Content-Type"), "image/png");
});

test("(d2) an unknown or already-reviewed attachment is a plain 404; egress re-verifies the mime", async () => {
  const staff = await sessionFixtures("admin", 9);
  // changes 0 — the row is approved already (or never existed): 404.
  const db = fakeDb([
    sessionRoute(staff.row),
    { test: APPROVE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    new Request(ORIGIN + "/api/admin/attachments/55/approve", {
      method: "POST",
      headers: { Origin: ORIGIN, ...staff.headers },
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 404);

  // Serving fail-safety: bytes whose magic no longer matches the stored mime
  // are NEVER served best-guess — 404, not a mismatched Content-Type.
  const serveDb = fakeDb([
    attachmentRoute({ id: 55, uploader_id: USER_ID, status: "approved", mime: "image/png" }),
    chunksRoute([new TextEncoder().encode("not an image at all really")]),
  ]);
  const tampered = await dispatch(get("/api/attachments/55"), envWithLimiters({ GOOBER_DB: serveDb }));
  assert.equal(tampered.status, 404);
});

test("(e) rejection deletes the chunk rows in ONE batch and leaves nothing servable", async () => {
  const staff = await sessionFixtures("moderator", 9); // stored 'moderator' → public 'admin'
  const env = envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(staff.row)]) });
  const response = await dispatch(
    new Request(ORIGIN + "/api/admin/attachments/55/reject", {
      method: "POST",
      headers: { Origin: ORIGIN, ...staff.headers },
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { rejected: true, id: 55 });

  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 2);
  const [chunksDelete, statusUpdate] = batch.statements;

  // The chunks die first, gated on the SAME pending state as the status flip —
  // a concurrent approval can never leave an approved row with its bytes gone.
  assert.match(
    chunksDelete.sql,
    /^DELETE FROM gc_attachment_chunks WHERE attachment_id IN \(SELECT id FROM gc_attachments WHERE id = \? AND status = 'pending'\)$/,
  );
  assert.match(
    statusUpdate.sql,
    /UPDATE gc_attachments SET status = 'rejected', reviewed_by = \?, reviewed_at = \? WHERE id = \? AND status = 'pending'$/,
  );
  assert.equal(statusUpdate.bound[0], 9);

  // Non-pending / unknown ids are 404, before any byte loss would matter.
  const missDb = fakeDb([
    sessionRoute(staff.row),
    { test: REJECT_STATUS_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const miss = await dispatch(
    new Request(ORIGIN + "/api/admin/attachments/55/reject", {
      method: "POST",
      headers: { Origin: ORIGIN, ...staff.headers },
    }),
    envWithLimiters({ GOOBER_DB: missDb }),
  );
  assert.equal(miss.status, 404);
});

test("the review queue lists pending uploads oldest-first for staff only", async () => {
  const { row, headers } = await sessionFixtures("member");
  const denied = await dispatch(
    get("/api/admin/attachments", headers),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) }),
  );
  assert.equal(denied.status, 403);

  const staff = await sessionFixtures("admin", 9);
  const db = fakeDb([
    sessionRoute(staff.row),
    {
      test: PENDING_QUEUE_TEST,
      all: async () => ({
        results: [{
          id: 55, uploader_name: "wempos", mime: "image/png", size_bytes: 64005, created_at: 100,
        }, {
          id: 56, uploader_name: "koda", mime: "image/gif", size_bytes: 42, created_at: 200,
        }],
      }),
    },
  ]);
  const response = await dispatch(
    get("/api/admin/attachments", staff.headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    attachments: [
      { id: 55, uploaderName: "wempos", sizeBytes: 64005, mime: "image/png", createdAt: "1970-01-01T00:01:40.000Z" },
      { id: 56, uploaderName: "koda", sizeBytes: 42, mime: "image/gif", createdAt: "1970-01-01T00:03:20.000Z" },
    ],
  });
  // Oldest first, bounded like the forum's desk.
  const queue = db.calls.find((call) => PENDING_QUEUE_TEST(call.sql));
  assert.match(queue.sql, /ORDER BY a.created_at ASC LIMIT 100$/);
});

// --- send-with-image (multipart POST /api/channels/:id/messages) ---------------------

const channelsFor = (row, extras = []) =>
  fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    ...extras,
  ]);

test("the multipart send stores the message WITH its attachment in one batch", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const bytes = pngImage();
  const db = channelsFor(row, [
    {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({
        meta: { changes: 1, last_row_id: 11 },
        results: [messageRow({ id: 11 })],
      }),
    },
    { test: ATTACHMENT_VISIBILITY_TEST, all: async () => ({ results: [{ id: 77, message_id: 11 }] }) },
  ]);
  const response = await dispatch(
    multipartRequest(
      `/api/channels/${CHANNEL_ID}/messages`,
      { fields: { body: "look at this", clientMessageId: "cccccccc" }, files: [{ bytes }] },
      headers,
    ),
    envWithLimiters({ GOOBER_DB: db }),
    handleMessageRoutes,
  );

  assert.equal(response.status, 201);
  const payload = await bodyOf(response);
  assert.equal(payload.message.id, 11);

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const [messageInsert, channelBump, attachmentInsert, ...rest] = batch.statements;

  // Same message statements, byte-for-byte JSON-send shape — the attachment
  // INSERT and its chunks ride between the last_* bump and the reselect; the
  // idempotency/triple logic is NEVER duplicated by the multipart branch.
  assert.match(messageInsert.sql, /^INSERT INTO gc_messages/);
  assert.match(channelBump.sql, /UPDATE gc_channels SET last_message_id =/);
  assert.ok(MESSAGE_INSERT_TEST(messageInsert.sql));

  // The attachment row resolves its message INSIDE the batch via the exact
  // idempotency triple (`IS ?` matches both NULL and the id; newest-first so
  // a cid-less triple resolves the row just sent), and a replayed send adds
  // no second copy.
  assert.match(
    attachmentInsert.sql,
    /INSERT INTO gc_attachments \(message_id, uploader_id, mime, size_bytes, status, width, height, created_at\) SELECT \(SELECT id FROM gc_messages WHERE channel_id = \? AND author_id = \? AND client_message_id IS \? ORDER BY id DESC LIMIT 1\), \?, \?, \?, 'pending', NULL, NULL, \? WHERE NOT EXISTS/,
  );
  assert.equal(attachmentInsert.bound[3], USER_ID);
  assert.equal(attachmentInsert.bound[4], "image/png");

  // Chunks follow, each resolving the attachment by the same triple.
  const chunks = rest.slice(0, rest.length - 1);
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    assert.match(chunk.sql, /INSERT INTO gc_attachment_chunks/);
    assert.match(chunk.sql, /client_message_id IS \? ORDER BY id DESC LIMIT 1/);
    assert.ok(chunk.bound[4].length <= ATTACHMENT_CHUNK_BYTES);
  }
  // The read that resolves the outgoing row is LAST, as in the JSON path.
  assert.ok(MESSAGE_RESELECT_TEST(rest[rest.length - 1].sql));
  // The just-attached row comes back on the read path (approved-or-own gate).
  assert.deepEqual(payload.message.attachmentIds, [77]);
});

test("the multipart send refuses two images and, through createAttachment, an oversized one", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatch(
    multipartRequest(
      `/api/channels/${CHANNEL_ID}/messages`,
      { fields: { body: "hello" }, files: [{ bytes: pngImage() }, { bytes: pngImage() }] },
      headers,
    ),
    envWithLimiters({ GOOBER_DB: db }),
    handleMessageRoutes,
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "Attach at most one image.");
  assert.deepEqual(writes(db), []);

  // The shared intake (used by BOTH routes) refuses oversized bytes before any
  // sniffed pipeline work — the JS side of the size_bytes CHECK.
  const oversize = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  oversize.set(pngImage(), 0);
  let primitiveGuard = false;
  try {
    await createAttachment(envWithLimiters({ GOOBER_DB: fakeDb([]) }), USER_ID, oversize);
  } catch (error) {
    primitiveGuard = error instanceof HttpError && error.status === 413;
  }
  assert.equal(primitiveGuard, true);
});

// The vendored intake's parity pin lives in tests/contract-parity.test.mjs,
// which compares api/core/images.mjs against the forum's restored code.

// --- real-SQLite regression (review round 1) ------------------------------------
//
// Attachment linkage resolves by an SQL subselect, which the fake DB above
// cannot execute: a linkage bug is invisible to it. This harness runs the
// send primitive's ACTUAL statements in real SQLite so the linkage pins
// behavior, not query text. (D1-shaped adapter: prepare → bind → run/first/
// all/batch, meta.changes/last_row_id. Batches run sequentially — the intake
// SQL deliberately uses subselects over committed row state, not session
// rowid tracking, so ordering within one batch is all it depends on.)
function realSqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, accent_color TEXT);
    INSERT INTO users (id, username, role) VALUES (${USER_ID}, 'wempos', 'member');

    CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER NOT NULL);
    CREATE TABLE site_settings (key TEXT, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO site_settings (key, value, updated_at) VALUES ('filtered_words', '', 1);

    CREATE TABLE gc_channels (id INTEGER PRIMARY KEY, server_id INTEGER NULL, kind TEXT NULL, slowmode_seconds INTEGER NOT NULL DEFAULT 0, last_message_id INTEGER, last_message_at INTEGER);
    INSERT INTO gc_channels (id) VALUES (${CHANNEL_ID});

    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL, author_id INTEGER NOT NULL,
      body TEXT NOT NULL, client_message_id TEXT, source TEXT,
      created_at INTEGER NOT NULL, edited_at INTEGER,
      UNIQUE(channel_id, author_id, client_message_id));

    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NULL REFERENCES gc_messages(id),
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      width INTEGER NULL, height INTEGER NULL,
      created_at INTEGER NOT NULL, reviewed_by INTEGER NULL, reviewed_at INTEGER NULL);

    CREATE TABLE gc_attachment_chunks (
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000),
      PRIMARY KEY(attachment_id, seq));
  `);

  return {
    db,
    env: {
      GOOBER_DB: {
        prepare(sql) {
          let bound = [];
          return {
            bind(...values) {
              bound = values;
              return this;
            },
            async first() {
              const row = db.prepare(sql).get(...bound);
              return row === undefined || row === null ? null : row;
            },
            async all() {
              return { results: db.prepare(sql).all(...bound) };
            },
            async run() {
              if (/^SELECT/i.test(sql)) {
                return { meta: { changes: 0 }, results: db.prepare(sql).all(...bound) };
              }
              const result = db.prepare(sql).run(...bound);
              return {
                meta: {
                  changes: Number(result.changes),
                  last_row_id: Number(result.lastInsertRowid ?? 0),
                },
                results: [],
              };
            },
          };
        },
        async batch(statements) {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        },
      },
    },
  };
}

// The subselect that resolves the attachment's message (and every chunk's
// attachment) MUST pick the newest matching row: with a NULL client id there
// can be older NULL-cid messages in the same channel, and a no-ORDER-BY
// subselect resolves the OLDEST one — linking the fresh image to a stranger's
// older message (and, when the older one already had an attachment, appending
// fresh chunks to the OLD attachment at non-colliding seqs: mixed bytes).
test("real-SQLite: a multipart send without a client id links its image to the row just sent", async () => {
  _resetFilterWordsCacheForTests();
  const { db, env } = realSqliteEnv();
  const user = { id: USER_ID, username: "wempos", role: "member" };
  const firstImage = pngImage(); // 45-byte PNG → one chunk

  const first = await sendMessageToChannel(
    env, user, CHANNEL_ID, "first", null, prepareAttachmentBytes(firstImage));
  assert.equal(first.message.id, 1);

  // The second send carries a DIFFERENT, >1-chunk image (64,005 total bytes)
  // and NO client id, in the channel that already contains the older NULL-cid
  // send above. (pngImage(payload) yields a 45-byte header + 12 + payload.)
  const secondImage = pngImage(63948);
  const second = await sendMessageToChannel(
    env, user, CHANNEL_ID, "look at this", null, prepareAttachmentBytes(secondImage));

  // The response must echo the row THAT send just inserted — before the fix
  // the primitive re-selected the channel's oldest NULL-cid row.
  assert.equal(second.message.id, 2);
  assert.equal(second.message.body, "look at this");
  assert.deepEqual(second.message.attachmentIds, [2]);

  // Stored rows: two attachments, each linked to its OWN message — the fresh
  // image must not ride the older row (and, chained through the chunk
  // subselect, must not append chunks onto the older attachment's rows).
  // Real SQLite rows are null-prototype objects: spread them into plain ones.
  const toPlain = (rows) => rows.map((row) => ({ ...row }));
  assert.deepEqual(
    toPlain(db.prepare("SELECT id, message_id FROM gc_attachments ORDER BY id").all()),
    [{ id: 1, message_id: 1 }, { id: 2, message_id: 2 }],
  );
  const chunks = db.prepare(
    "SELECT attachment_id, seq, length(data) AS len FROM gc_attachment_chunks ORDER BY attachment_id, seq",
  ).all();
  assert.deepEqual(
    chunks.map((row) => [row.attachment_id, row.seq, row.len]),
    [[1, 0, firstImage.length], [2, 0, 64000], [2, 1, 5]],
  );
  // The older attachment's bytes are untouched by the second intake.
  const firstBytes = new Uint8Array(db.prepare(
    "SELECT data FROM gc_attachment_chunks WHERE attachment_id = 1 ORDER BY seq",
  ).get().data);
  assert.deepEqual(firstBytes, firstImage);
});
