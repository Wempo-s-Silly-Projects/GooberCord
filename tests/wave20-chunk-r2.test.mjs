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

// Wave 20 — the chunk lane's byte leg to R2 (the 2026-11-19 slate, the owner
// R2-revival order newer by date than the lane's 2026-11-17 "no park, and no
// r2" ruling): each staging part puts its payload at
// gc-lane-staging/<uploadId>/<seq> in GC_MEDIA while the gc_upload_parts row
// keeps ONLY the relational arms (the 0025 data column is NOT NULL with no
// default and NO DDL rides this wave, so the row carries a 1-byte marker —
// never a payload byte; a later migration may drop the column). The commit
// assembles the store-of-record object at the media module's
// gc-attachments/<id> key from the staged part objects, the size arm riding
// the bucket's
// own streamed sum; the abort+abandon+sweep arms delete the objects whose
// rows they delete (the bucket follows, never leads — media.mjs:108 law).
// The 1 GiB arm OPENS: the lane ceiling is GC_PLUS_ATTACHMENT_BYTES exactly
// (GC_UPLOAD_LANE_MAX_BYTES retired), the commit re-verifies the tier (c26
// LOW T-LANE-TIER-COMMIT-RECHECK — one gate, size AND tier), and the client
// mirrors pin computed equality BOTH ways. Route-level through the dispatch
// harness (the wave-19 precedent, the c23 wiring-gap class); the bucket fake
// is a tiny in-memory { put, get, head, delete } store asserting keys.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { handleUploadRoutes, sweepStaleUploadParts, ABANDON_CLEAR_SQL, UPLOAD_TIER_ERROR, UPLOAD_INCOMPLETE_ERROR, UPLOAD_UNKNOWN_ERROR, UPLOAD_ONLY_IMAGES_ERROR } from "../api/uploads.mjs";
import { STORE_FAILED_ERROR } from "../api/media.mjs";
import { attachmentCapBytes } from "../api/plus.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import * as uploadsModule from "../public/js/ui/uploads.js";
import * as constantsModule from "../constants.mjs";
import {
  GC_ATTACHMENT_OBJECT_PREFIX,
  GC_PLUS_ATTACHMENT_BYTES,
  GC_UPLOAD_PART_BYTES,
  GC_UPLOAD_PARTS_MAX,
  MAX_ATTACHMENT_BYTES,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const ORIGIN = "http://localhost";
const USER_ID = 7;
const NOW = nowSeconds();

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
// The wave's touched modules (the freeze pin's exempt list — exactly the
// diff scope; every OTHER module must stay byte-identical across the range).
const TOUCHED = [
  "api/uploads.mjs",
  "api/media.mjs",
  "constants.mjs",
  "public/js/ui/uploads.js",
  "public/js/ui/chat.js",
  "docs/parity-limits.md",
  "tests/uploads-lane.test.mjs",
  "tests/wave14-uploads.test.mjs",
  "tests/wave19-tiers.test.mjs",
  "tests/wave20-chunk-r2.test.mjs",
  "tests/security-rbac.test.mjs", // retargeted by this wave's own commit (the lead's authorize)
];

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The ordered fake D1 (the uploads-lane/media-module conventions verbatim).
// An optional shared `journal` records the op ORDER across the D1 and bucket
// fakes — the ordering pins read one line from both sides.
function fakeDb(routes = [], journal = null) {
  const calls = [];
  let nextRowId = 1000;
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => { statement.bound = values; return statement; };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        if (journal) journal.push("db:first:" + sql);
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        if (journal) journal.push("db:all:" + sql);
        const route = routes.find((entry) => entry.test(sql));
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) {
          calls.push({ call: "run", sql, bound: statement.bound });
          if (journal) journal.push("db:run:" + sql);
        }
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
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      if (journal) journal.push("db:batch:" + statements[0].sql);
      return results;
    },
  };
  return db;
}

// The bucket fake: a tiny in-memory store keyed exactly as the routes key
// (draining streams on put so a streamed assembly completes under
// backpressure; recording every op so the pins can assert keys). The put
// records the WATCH-FILTER shape: `streamed` (ReadableStream in, never a
// full-buffer object), `pulls` (the read-stream pull count — chunk-by-chunk
// drain evidence, the assembly may never materialize the object before the
// put), and `bytes` (the fake's own pull-accounted total).
function fakeLaneR2(journal = null) {
  const objects = new Map();
  const calls = [];
  const recordJournal = (label) => { if (journal) journal.push(label); };
  const joinChunks = (chunks) => {
    if (chunks.length === 1 && chunks[0] instanceof Uint8Array) return chunks[0];
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at);
      at += chunk.byteLength;
    }
    return bytes;
  };
  return {
    calls,
    objects,
    async put(key, value) {
      const streamed = typeof (value && value.getReader) === "function";
      let pulls = 0;
      let bytes;
      if (streamed) {
        const reader = value.getReader();
        const chunks = [];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          pulls += 1;
          chunks.push(next.value);
        }
        bytes = joinChunks(chunks);
      } else if (value instanceof Uint8Array) {
        bytes = value;
      } else if (typeof value.arrayBuffer === "function") {
        bytes = new Uint8Array(await value.arrayBuffer());
      } else {
        bytes = new Uint8Array(value);
      }
      calls.push({ op: "put", key, streamed, pulls, bytes: bytes.length });
      recordJournal("rb2:put:" + key);
      objects.set(key, bytes);
    },
    async get(key) {
      calls.push({ op: "get", key });
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { body: new Blob([bytes]).stream(), size: bytes.length };
    },
    async head(key) {
      calls.push({ op: "head", key });
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async delete(key) {
      calls.push({ op: "delete", key });
      recordJournal("rb2:delete:" + key);
      objects.delete(key);
    },
  };
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const PLUS_TIER_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });
const plusTierRoute = (tier = "plus", renews = NOW + 3600) => ({
  test: PLUS_TIER_TEST,
  first: async () => ({ renews_until: renews, tier }),
});
// The commit's aggregate gate: the RELATIONAL arms only (count + contiguity
// over the part seqs — the D1 sum arm retired with the byte column).
const STAGING_VERIFY_TEST = (sql) =>
  /SELECT COUNT\(\*\) AS n, MIN\(seq\) AS lo, MAX\(seq\) AS hi FROM gc_upload_parts/.test(sql);
const ROW_BIRTH_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_attachments") && sql.includes("'pending'");
const IDENTITY_READ_TEST = (sql) =>
  sql.includes("SELECT id FROM gc_attachments WHERE message_id IS NULL");
const STAGING_CLEAR_TEST = (sql) =>
  sql === "DELETE FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";
const ABANDON_SEQLIST_TEST = (sql) =>
  sql.startsWith("SELECT seq FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?");
const SWEEP_DOOMED_TEST = (sql) =>
  sql.startsWith("SELECT upload_id, seq FROM gc_upload_parts WHERE created_at < ?");

async function sessionFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: csrf,
    expires_at: NOW + 3600,
    username: "wempos",
    role: "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return { row, headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf } };
}

async function dispatchUploads(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleUploadRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

function chunkForm(seq, bytes, extra = {}) {
  const form = new FormData();
  form.append("seq", String(seq));
  if (extra.uploadId) form.append("uploadId", extra.uploadId);
  if (extra.size) form.append("size", String(extra.size));
  form.append("chunk", new Blob([bytes]));
  return form;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function chunkPart(seq) {
  const part = new Uint8Array(GC_UPLOAD_PART_BYTES);
  if (seq === 0) part.set(PNG_MAGIC, 0); // the head bytes the commit sniffs
  else part[0] = seq; // the per-part order marker
  return part;
}
// The lane's lawful minimum: the size gate keeps the small lanes' single-buffer
// contract — the smallest large upload is 1 byte past the 20 MiB free cap, so
// the commit fixtures ride a 21-part staging (21 × 1,024,000 bytes > 20 MiB).
const LAWFUL_PARTS = 21;
const LAWFUL_SIZE = LAWFUL_PARTS * GC_UPLOAD_PART_BYTES;
const laneStagingKey = (uploadId, seq) => "gc-lane-staging/" + uploadId + "/" + seq;

// --- (a) the staged bytes live in the bucket; the D1 row writes none ---------

test("part staging puts the payload in GC_MEDIA and the D1 row writes NO bytes", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), plusTierRoute("plus")]);
  const r2 = fakeLaneR2();
  const open = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...headers },
      body: chunkForm(0, chunkPart(0), { size: String(LAWFUL_SIZE) }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(open.status, 201);
  const { uploadId } = await open.json();
  // The payload rode the bucket at the lane's key family.
  const puts = r2.calls.filter((call) => call.op === "put");
  assert.deepEqual(puts.map((call) => call.key), [laneStagingKey(uploadId, 0)]);
  const stored = r2.objects.get(laneStagingKey(uploadId, 0));
  assert.equal(stored.length, GC_UPLOAD_PART_BYTES, "the part's own bytes");
  assert.equal(stored[0], PNG_MAGIC[0], "the payload is byte-identical");

  // One row per part; the byte column carries the 1-byte marker, never the
  // payload (the 0025 column is NOT NULL and this wave writes NO DDL).
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 1, "one staged row per part");
  const statement = batch.statements[0];
  assert.match(statement.sql, /INSERT OR REPLACE INTO gc_upload_parts/);
  assert.equal(statement.bound[0], uploadId);
  assert.equal(statement.bound[1], USER_ID);
  assert.equal(statement.bound[2], 0, "the row's seq is the PART's seq");
  assert.equal(statement.bound[3].length, 1, "the byte column is the marker, not the payload");
  assert.notEqual(statement.bound[3].length, GC_UPLOAD_PART_BYTES);

  // A continuation rides the same shape at its own part seq.
  const contDb = fakeDb([sessionRoute(row), plusTierRoute("plus"),
    { test: (sql) => sql.startsWith("SELECT 1 FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0"), first: async () => ({ "1": 1 }) }]);
  const contR2 = fakeLaneR2();
  const continued = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...headers },
      body: chunkForm(1, chunkPart(1), { uploadId }),
    }),
    envWithLimiters({ GOOBER_DB: contDb, GC_MEDIA: contR2 }),
  );
  assert.equal(continued.status, 200);
  assert.deepEqual(contR2.calls.filter((call) => call.op === "put").map((call) => call.key),
    [laneStagingKey(uploadId, 1)]);
  const contBatch = contDb.calls.find((call) => call.call === "batch");
  assert.equal(contBatch.statements[0].bound[2], 1, "the continuation rows follow the part seq");
});

// --- (b) a failed put answers verbatim and stages nothing ---------------------

test("a failed staging put answers the store-failure family verbatim and stages nothing", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), plusTierRoute("plus")]);
  const r2 = fakeLaneR2();
  r2.calls.length = 0;
  r2.objects.clear();
  const busted = { ...r2, async put() { throw new Error("R2 down"); } };
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...headers },
      body: chunkForm(0, chunkPart(0), { size: String(LAWFUL_SIZE) }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: busted }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(STORE_FAILED_ERROR), true,
    "the verbatim store-failure copy, never a new string");
  assert.deepEqual(db.calls.filter((call) => call.call === "batch"), [], "nothing staged in D1");
  assert.deepEqual(r2.objects.size, 0, "nothing staged in the bucket");
  void r2;
});

// --- (c) the commit assembles the store-of-record object from the bucket ------

function commitDbFor(fixtureRows, uploadId, extra = {}) {
  return fakeDb([
    sessionRoute(fixtureRows.row),
    plusTierRoute("plus"),
    { test: STAGING_VERIFY_TEST, first: async () => ({ n: LAWFUL_PARTS, lo: 0, hi: LAWFUL_PARTS - 1 }) },
    { test: ROW_BIRTH_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: IDENTITY_READ_TEST, first: async () => ({ id: 4242 }) },
    { test: STAGING_CLEAR_TEST, run: async () => ({ meta: { changes: LAWFUL_PARTS } }) },
    ...(extra.routes || []),
  ], extra.journal ?? null);
}

test("the commit assembles from R2: one store-of-record object, the streamed sum the size arm, the staging after", async () => {
  const { row, headers } = await sessionFixtures();
  const uploadId = "CCCCCCCCCCCC";
  // The shared order journal: the D1 and bucket ops interleave onto ONE line
  // so the media idiom's ordering is pinned, not assumed.
  const journal = [];
  const db = commitDbFor({ row }, uploadId, { journal });
  const r2 = fakeLaneR2(journal);
  for (let seq = 0; seq < LAWFUL_PARTS; seq += 1) {
    r2.objects.set(laneStagingKey(uploadId, seq), chunkPart(seq));
  }
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/" + uploadId + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ size: LAWFUL_SIZE }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { attachment: { id: 4242, status: "pending" } });

  // The row birth rides the folded count arm (the verify→commit gap); the
  // mime is the bucket seq-0 sniff.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch, "the one D1 batch is the row birth");
  assert.equal(batch.statements.length, 1);
  assert.match(batch.statements[0].sql, /INSERT INTO gc_attachments/);
  assert.equal(batch.statements[0].bound[0], USER_ID);
  assert.equal(batch.statements[0].bound[1], "image/png", "the mime rides the bucket sniff");
  assert.equal(batch.statements[0].bound[2], LAWFUL_SIZE);
  assert.deepEqual(batch.statements[0].bound.slice(-3), [uploadId, USER_ID, LAWFUL_PARTS],
    "the count arm's pair + expected count");
  // WATCH-FILTER (row birth): the INSERT carries no byte payload and no move
  // arm — seven scalar binds, no gc_attachment_chunks statement, no BLOB.
  assert.equal(batch.statements[0].sql.includes("gc_attachment_chunks"), false,
    "the move arm retired with the byte leg");
  assert.ok(batch.statements[0].bound.every((bind) => typeof bind === "string" || typeof bind === "number"),
    "the row's binds carry no chunk/attachment bytes (scalar mime/size tuple + the count arm)");

  // The assembled object: the media module's key, byte-ordered, the exact
  // streamed sum.
  const objectKey = GC_ATTACHMENT_OBJECT_PREFIX + 4242;
  const assembled = r2.objects.get(objectKey);
  assert.ok(assembled, "the store-of-record object landed");
  assert.equal(assembled.length, LAWFUL_SIZE, "the streamed sum equals the declared size");
  assert.equal(assembled[0], PNG_MAGIC[0], "the head bytes are the staged ones");
  assert.equal(assembled[GC_UPLOAD_PART_BYTES], 1, "part 1's marker rides its own seq order");
  assert.equal(assembled[(LAWFUL_PARTS - 1) * GC_UPLOAD_PART_BYTES], LAWFUL_PARTS - 1,
    "the last part lands last");

  // WATCH-FILTER (assembly streaming): the store-of-record put received a
  // ReadableStream and drained it chunk-by-chunk — one part-shaped pull per
  // staged part, never a materialized whole-file object handed to the put.
  const storePut = r2.calls.find((call) => call.op === "put" && call.key === objectKey);
  assert.ok(storePut, "the store-of-record put rode the bucket");
  assert.equal(storePut.streamed, true, "the put received a stream, not a 1 GiB buffer");
  assert.ok(storePut.pulls >= LAWFUL_PARTS,
    "the pull count is part-shaped (" + storePut.pulls + " pulls), not whole-file");
  assert.equal(storePut.bytes, LAWFUL_SIZE, "the fake's pull accounting equals the declared size");

  // The media idiom's order, pinned on the shared journal: the row birth,
  // the durable put, then the staging deaths (bucket follows, never leads —
  // the staging rows AND objects clear only once the byte of record is
  // durable at the key).
  const clearSql = "DELETE FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";
  const birthAt = journal.indexOf("db:batch:" + batch.statements[0].sql);
  const putAt = journal.indexOf("rb2:put:" + objectKey);
  const clearAt = journal.indexOf("db:run:" + clearSql);
  const firstDeathAt = journal.indexOf("rb2:delete:" + laneStagingKey(uploadId, 0));
  assert.ok(birthAt !== -1 && putAt !== -1 && clearAt !== -1 && firstDeathAt !== -1,
    "the journal saw every leg");
  assert.ok(birthAt < putAt && putAt < clearAt && clearAt < firstDeathAt,
    "row born, then bytes durable at the key, then the staging dies — object key needs the born row's id (media.mjs intakes' own shape)");

  // The staging rides the D1 gate: the clear ran; the objects FOLLOWED the
  // rows (every staged part object deleted, the store-of-record kept).
  const clear = db.calls.find((call) => call.call === "run" && STAGING_CLEAR_TEST(call.sql));
  assert.ok(clear, "the staging rows left once the object was durable");
  const deletedKeys = r2.calls.filter((call) => call.op === "delete" && call.key.startsWith("gc-lane-staging/"));
  assert.equal(deletedKeys.length, LAWFUL_PARTS, "every staged part object died with its row");
  assert.ok(r2.objects.get(objectKey), "the store-of-record object survives the sweep");

  // No chunk bytes ever move into D1: no INSERT..SELECT into gc_attachment_chunks.
  assert.equal(db.calls.some((call) => (call.sql || "").includes("gc_attachment_chunks")), false,
    "the byte leg never re-lands in D1");
});

// --- (d) the commit re-checks the tier (c26 LOW, one gate size AND tier) ------

test("the commit's failed assembly is fail-closed: the just-born row rolls back and the partial object dies", async () => {
  const { row, headers } = await sessionFixtures();
  const uploadId = "CCCCCCCCCCCC";
  const db = commitDbFor({ row }, uploadId);
  const r2 = fakeLaneR2();
  // Lawful seqs 0..20, but the LAST part stages short — the streamed sum
  // disputes the declared size after 20 full parts and the marker rows.
  for (let seq = 0; seq < LAWFUL_PARTS - 1; seq += 1) {
    r2.objects.set(laneStagingKey(uploadId, seq), chunkPart(seq));
  }
  const shortLast = new Uint8Array(GC_UPLOAD_PART_BYTES - 1);
  r2.objects.set(laneStagingKey(uploadId, LAWFUL_PARTS - 1), shortLast);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/" + uploadId + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ size: LAWFUL_SIZE }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(response.status, 400);
  assert.ok((await response.text()).includes(UPLOAD_INCOMPLETE_ERROR));
  // Fail-closed: the just-born pending row rolled back, the partial object
  // deleted with it, the staging rows AND objects left for a retry.
  const rollback = db.calls.find(
    (call) => call.call === "run" && /DELETE FROM gc_attachments WHERE id = \? AND status = 'pending'/.test(call.sql),
  );
  assert.ok(rollback, "the born row's compensating delete rode");
  assert.equal(rollback.bound[0], 4242, "the rollback resolves the born row's id");
  assert.ok(r2.calls.some((call) => call.op === "delete" && call.key === GC_ATTACHMENT_OBJECT_PREFIX + 4242),
    "the partial object died with the row");
  assert.ok(r2.objects.get(GC_ATTACHMENT_OBJECT_PREFIX + 4242) == null, "no partial object survives");
  assert.equal(r2.calls.filter((call) => call.op === "delete" && call.key.startsWith("gc-lane-staging/")).length, 0,
    "the staging objects stayed for the retry");
  const clear = db.calls.find((call) => call.call === "run" && STAGING_CLEAR_TEST(call.sql));
  assert.equal(clear, undefined, "no staging clear behind a failed assembly");
});

test("the commit re-verifies the tier: a Mini-term (or lapsed) uploader answers the verbatim 403", async () => {
  const { row, headers } = await sessionFixtures();
  for (const tier of ["mini", "lapsed-plus"]) {
    const route = tier === "mini" ? plusTierRoute("mini") : plusTierRoute("plus", NOW - 3600);
    const db = fakeDb([sessionRoute(row), route]);
    const r2 = fakeLaneR2();
    const response = await dispatchUploads(
      new Request(ORIGIN + "/api/uploads/CCCCCCCCCCCC/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
        body: JSON.stringify({ size: LAWFUL_SIZE }),
      }),
      envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
    );
    assert.equal(response.status, 403, "tier " + String(tier));    assert.ok((await response.text()).includes(UPLOAD_TIER_ERROR), "verbatim tier copy");
    assert.equal(r2.calls.length, 0, "no bucket traffic behind the refusal");
    assert.equal(db.calls.some((call) => call.call === "batch"), false, "nothing born");
    assert.deepEqual(db.calls.filter((call) => STAGING_VERIFY_TEST(call.sql)), [],
      "the aggregate read never rode behind the tier refusal");
    void UPLOAD_INCOMPLETE_ERROR;
  }
});

// --- (e) the abandon and the sweep delete the objects whose rows they delete --

test("the abandon deletes the lane objects of the rows its clear deletes", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: (sql) => sql.includes("FROM gc_sound_pack_sounds WHERE upload_id = ?"), first: async () => null },
    { test: ABANDON_SEQLIST_TEST, all: async () => ({ results: [{ seq: 0 }, { seq: 3 }] }) },
  ]);
  const r2 = fakeLaneR2();
  r2.objects.set(laneStagingKey("AAAAAAAAAAAA", 0), new Uint8Array(1));
  r2.objects.set(laneStagingKey("AAAAAAAAAAAA", 3), new Uint8Array(1));
  r2.objects.set(laneStagingKey("AAAAAAAAAAAA", 9), new Uint8Array(1));
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/AAAAAAAAAAAA", {
      method: "DELETE",
      headers: { Origin: ORIGIN, ...headers },
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(response.status, 200);
  const clear = db.calls.find((call) => call.call === "run" && call.sql === ABANDON_CLEAR_SQL);
  assert.ok(clear, "the rows died with the abandon");
  assert.deepEqual(
    r2.calls.filter((call) => call.op === "delete").map((call) => call.key),
    [laneStagingKey("AAAAAAAAAAAA", 0), laneStagingKey("AAAAAAAAAAAA", 3)],
    "the objects of the deleted rows died with them, exactly those seqs",
  );
});

test("the TTL sweep deletes the doomed rows' lane objects (the binding present)", async () => {
  const db = fakeDb([
    { test: SWEEP_DOOMED_TEST, all: async () => ({ results: [{ upload_id: "EEEEEEEEEEEE", seq: 2 }] }) },
  ]);
  const r2 = fakeLaneR2();
  r2.objects.set(laneStagingKey("EEEEEEEEEEEE", 2), new Uint8Array(1));
  r2.objects.set(laneStagingKey("EEEEEEEEEEEE", 7), new Uint8Array(1));
  const at = NOW + 10_000;
  await sweepStaleUploadParts({ GOOBER_DB: db, GC_MEDIA: r2 }, at);
  assert.deepEqual(
    r2.calls.filter((call) => call.op === "delete").map((call) => call.key),
    [laneStagingKey("EEEEEEEEEEEE", 2)],
    "only the swept rows' objects die",
  );
});

// --- (f) the mirrors BOTH ways, and the open 1 GiB arm ------------------------

test("the lane ceiling is GC_PLUS_ATTACHMENT_BYTES both ways, and the arm opens at exactly 1 GiB", () => {
  const UPLOADS_UI = read("public/js/ui/uploads.js");
  const CONSTANTS_TEXT = read("constants.mjs");
  const numeral = (match) => Number(match?.[1].replaceAll("_", ""));
  const mirrorPlus = numeral(UPLOADS_UI.match(/export const UI_ATTACHMENT_PLUS_MAX = (\d+);/));
  const backendPlus = numeral(CONSTANTS_TEXT.match(/export const GC_PLUS_ATTACHMENT_BYTES = ([\d_]+);/));
  // forward: the mirror EQUALS the backend literal; backward: the backend
  // literal EQUALS the mirror (never an invented number).
  assert.equal(mirrorPlus, backendPlus);
  assert.equal(backendPlus, mirrorPlus);
  assert.equal(backendPlus, 1_073_741_824);
  // The lane mirror sits on the tier mirror's number, COMPUTED — a second
  // literal would be fresh drift.
  assert.match(UPLOADS_UI, /export const UI_UPLOAD_LANE_MAX_BYTES = UI_ATTACHMENT_PLUS_MAX;/);
  // The retired bound stays retired in BOTH trees.
  assert.equal(constantsModule.GC_UPLOAD_LANE_MAX_BYTES, undefined);
  assert.doesNotMatch(CONSTANTS_TEXT, /GC_UPLOAD_LANE_MAX_BYTES/);
  assert.doesNotMatch(UPLOADS_UI, /131072000/);
  // The parts window derives from the tier (1049 — the 128-part D1 bound retired).
  assert.match(CONSTANTS_TEXT,
    /export const GC_UPLOAD_PARTS_MAX = Math\.ceil\(GC_PLUS_ATTACHMENT_BYTES \/ GC_UPLOAD_PART_BYTES\);/);
  assert.equal(GC_UPLOAD_PARTS_MAX, Math.ceil(GC_PLUS_ATTACHMENT_BYTES / GC_UPLOAD_PART_BYTES));
  assert.equal(GC_UPLOAD_PARTS_MAX, 1049);

  // The predicate's window rides the mirror: exactly at 1 GiB the lane opens
  // for full-plus; one byte past closes.
  assert.equal(uploadsModule.ridesChunkLane(GC_PLUS_ATTACHMENT_BYTES, "plus"), true);
  assert.equal(uploadsModule.ridesChunkLane(GC_PLUS_ATTACHMENT_BYTES + 1, "plus"), false);
  assert.equal(uploadsModule.ridesChunkLane(MAX_ATTACHMENT_BYTES + 1, "plus"), true);
});

test("the backend size gates admit 1 GiB exactly and refuse one past (first part AND commit)", async () => {
  const { row, headers } = await sessionFixtures();
  const openEnv = (db, r2) => envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 });
  // Exactly the tier ceiling: the first part OPENS (201).
  const db = fakeDb([sessionRoute(row), plusTierRoute("plus")]);
  const r2 = fakeLaneR2();
  const opened = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...headers },
      body: chunkForm(0, chunkPart(0), { size: String(GC_PLUS_ATTACHMENT_BYTES) }),
    }),
    openEnv(db, r2),
  );
  assert.equal(opened.status, 201);
  assert.ok(r2.calls.some((call) => call.op === "put"), "the first part staged");
  // One past: the first-part AND commit arms refuse with the shared 400.
  const refDb = fakeDb([sessionRoute(row), plusTierRoute("plus")]);
  const refused = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...headers },
      body: chunkForm(0, chunkPart(0), { size: String(GC_PLUS_ATTACHMENT_BYTES + 1) }),
    }),
    openEnv(refDb, fakeLaneR2()),
  );
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "That file size is not a large upload.");
  const commit = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/BBBBBBBBBBBB/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ size: GC_PLUS_ATTACHMENT_BYTES + 1 }),
    }),
    openEnv(refDb, fakeLaneR2()),
  );
  assert.equal(commit.status, 400);
  assert.equal((await commit.json()).error, "That file size is not a large upload.");
});

test("chat.js's lane-bound refusal paints the mirror's arithmetic", () => {
  const CHAT = read("public/js/ui/chat.js");
  assert.match(CHAT, /if \(file\.size > UI_UPLOAD_LANE_MAX_BYTES\) \{\s*\n?\s*errorLine\.textContent = t\("gc\.chat\.attach\.tooLarge", \{ mib: Math\.round\(UI_UPLOAD_LANE_MAX_BYTES \/ 1048576\) \}\);/,
    "the lane refusal's paint rides the mirror's own arithmetic (1024 MiB)");
});

// --- the freeze (the wave-9 lesson; the c25 probe-of-the-probe shape) ---------

// LANE_BASE = 2c2c428 (main tip at lane open, the wave-20 slate commit).
// LANE_TIP = the wave's own committed feat tip — the lead retargets the
// placeholder at commit time; until then the placeholder diffs the base and
// the source pins carry the freeze.
test("freeze: every module outside the wave's touched set stays byte-identical", () => {
  const LANE_BASE = "2c2c428";
  const LANE_TIP = "8b58b69";
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  let touched;
  try {
    touched = execFileSync("git", ["diff", "--name-only", LANE_BASE, tip],
      { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
      .filter((path) => path && !TOUCHED.includes(path));
  } catch (error) {
    // The catch is an ARM, not a swallow: a genuinely no-history environment
    // (a shallow checkout, an exported tree) cannot answer the range — the
    // other source-read pins carry the freeze there. A throw in a FULL
    // checkout IS the defect (a mistyped SHA) and must fail loud. The probe
    // of the probe (the c25 audit LOW): a rev-parse failure alone is not
    // "not a git checkout" — a full checkout with a broken git still
    // rethrows, so a silent skip never rides a broken environment.
    let isShallow = null;
    try {
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    } catch {
      return; // git itself unusable (no repo at all — an exported tree)
    }
    try {
      isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"],
        { cwd: ROOT, encoding: "utf8" }).trim() === "true";
    } catch {
      throw error; // git answers HEAD but refuses the probe — not a swallow
    }
    if (isShallow) return;
    throw error;
  }
  assert.deepEqual(touched, [], `${touched.join(", ")} — every untouched module stays byte-frozen`);
});

// --- the AGPL header rides the new file in the canonical shape ------------------

test("the AGPL header rides the new file in the canonical shape", () => {
  const sourceText = read("tests/wave20-chunk-r2.test.mjs");
  const lines = sourceText.split("\n");
  assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", "line 1");
  for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
    `header line ${i + 1} rides the template`);
  assert.equal(lines[17], "", "rides the 17-lines-plus-blank template");
});
