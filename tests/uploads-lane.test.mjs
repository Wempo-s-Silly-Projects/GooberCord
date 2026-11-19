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

// The LARGE-FILE upload lane, its BYTE LEG on R2 (wave-20, the owner R2
// revival order: staging payloads ride GC_MEDIA at gc-lane-staging/<uploadId>/
// <seq>; the D1 gc_upload_parts rows carry only the relational arms — the
// 0025 data column is NOT NULL, so each row binds a 1-byte marker, never a
// payload byte). Pins: the bucket-backed part staging, the commit's
// aggregate gate + count-arm row birth + streamed store-of-record assembly,
// the abandon/sweep object deletes, media.mjs's paged large-row serving,
// and the send route's attach-by-id. The bucket is an in-memory fake
// (tests/wave20-chunk-r2.test.mjs shapes it); no part of the lane writes a
// payload byte into D1.
import test from "node:test";
import assert from "node:assert/strict";

import { handleUploadRoutes, sweepStaleUploadParts, ABANDON_CLEAR_SQL, UPLOAD_TIER_ERROR, UPLOAD_UNKNOWN_ERROR, UPLOAD_INCOMPLETE_ERROR, UPLOAD_ONLY_IMAGES_ERROR, UPLOAD_PART_INVALID_ERROR } from "../api/uploads.mjs";
import { handleMediaRoutes } from "../api/media.mjs";
import { handleMessageRoutes, sendMessageToChannel } from "../api/messages.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  ATTACHMENT_CHUNK_BYTES,
  GC_PLUS_ATTACHMENT_BYTES,
  GC_UPLOAD_CHUNKS_MAX,
  GC_UPLOAD_PART_BYTES,
  GC_UPLOAD_PART_CHUNKS,
  GC_UPLOAD_PART_REQUEST_BYTES,
  GC_UPLOAD_PARTS_MAX,
  GC_UPLOAD_STAGED_CAP,
  GC_UPLOAD_STAGING_TTL_SECONDS,
  MAX_ATTACHMENT_BYTES,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The ordered fake D1: first matching route answers; batch entries record.
function fakeDb(routes = []) {
  const calls = [];
  let nextRowId = 1000;
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => { statement.bound = values; return statement; };
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
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
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
      return results;
    },
  };
  return db;
}

// The in-memory bucket fake (the wave-20 shape: put/get/head/delete,
// draining streams on put so a streamed assembly completes).
function fakeLaneR2() {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    objects,
    async put(key, value) {
      calls.push({ op: "put", key });
      objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
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
      objects.delete(key);
    },
  };
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const PLUS_TIER_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const ATTACHMENT_ROW_TEST = (sql) =>
  sql.includes("SELECT id, uploader_id, status, mime, size_bytes FROM gc_attachments");
// The commit's verification aggregate, ride-distinct (the RELATIONAL arms
// only — the D1 sum arm retired with the byte column).
const STAGING_VERIFY_TEST = (sql) =>
  /SELECT COUNT\(\*\) AS n, MIN\(seq\) AS lo, MAX\(seq\) AS hi FROM gc_upload_parts/.test(sql);
const ROW_BIRTH_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_attachments") && sql.includes("'pending'");
const STAGING_CLEAR_TEST = (sql) =>
  sql === "DELETE FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";
const STAGING_MARKER_TEST = (sql) =>
  sql.startsWith("SELECT 1 FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0");
const IDENTITY_TUPLE_TEST = (sql) =>
  sql.includes("SELECT id FROM gc_attachments WHERE message_id IS NULL");
const PAGE_READ_TEST = (sql) =>
  sql.includes("FROM gc_attachment_chunks WHERE attachment_id = ? AND seq >= ?") && sql.toUpperCase().includes("LIMIT");

async function sessionFixtures(role = "member") {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
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
  return { token, row, headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf } };
}
const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });
// attachmentCapBytes' read: a full-plus term by default here (the lane's rider).
const plusTierRoute = (tier = "plus", renews = nowSeconds() + 3600) => ({
  test: PLUS_TIER_TEST,
  first: async () => ({ renews_until: renews, tier }),
});

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
function pngPart() {
  const part = new Uint8Array(GC_UPLOAD_PART_BYTES);
  part.set(PNG_MAGIC, 0);
  return part;
}
// The lane's window opens at the raised free cap (the small single-buffer
// lanes keep anything at or under it): 24 part-sized parts = 24,576,000
// bytes, clearing 20 MiB.
const LARGE_TOTAL = 24 * GC_UPLOAD_PART_BYTES;
const fullParts = (count) => Array.from({ length: count }, () => pngPart());

// --- pins -------------------------------------------------------------------------

test("the lane's constants: 1 MiB parts as 16 proven chunks, the parts window derived from the tier", () => {
  assert.equal(GC_UPLOAD_PART_CHUNKS, 16);
  assert.equal(GC_UPLOAD_PART_BYTES, 16 * ATTACHMENT_CHUNK_BYTES, "the part is chunks, not a raw number"); // 1,024,000
  assert.equal(GC_UPLOAD_PART_REQUEST_BYTES, GC_UPLOAD_PART_BYTES + 512 * 1024);
  assert.equal(GC_UPLOAD_PARTS_MAX, Math.ceil(GC_PLUS_ATTACHMENT_BYTES / GC_UPLOAD_PART_BYTES),
    "the parts window derives from the 1 GiB tier the lane rides (1049)");
  assert.equal(GC_UPLOAD_CHUNKS_MAX, GC_UPLOAD_PARTS_MAX * GC_UPLOAD_PART_CHUNKS);
  assert.equal(GC_PLUS_ATTACHMENT_BYTES, 1_073_741_824, "the lane ceiling is the tier's own bound");
  assert.equal(MAX_ATTACHMENT_BYTES, 20_971_520, "the free tier rides Discord's Aug-2026 20 MiB raise");
});

test("the tier gate: free and Mini members are refused before any stage write", async () => {
  for (const refusal of [
    // Lapsed or never-bought: no gc_plus_state row is the free cap.
    { tag: "free", route: { test: PLUS_TIER_TEST, first: async () => null } },
    // Mini rides its own, lighter cap — the lane is full-plus-only.
    { tag: "Mini", route: plusTierRoute("mini") },
  ]) {
    const fixture = await sessionFixtures();
    const db = fakeDb([sessionRoute(fixture.row), refusal.route]);
    const response = await dispatchUploads(
      new Request(ORIGIN + "/api/uploads/chunks", {
        method: "POST",
        headers: { Origin: ORIGIN, ...fixture.headers },
        body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
      }),
      envWithLimiters({ GOOBER_DB: db }),
    );
    assert.equal(response.status, 403, "tier " + refusal.tag);
    assert.equal((await response.text()).includes(UPLOAD_TIER_ERROR), true);
    assert.deepEqual(db.calls.filter((call) => call.call === "batch"), [], "a refused member writes nothing");
  }
});

test("the part intake: the payload rides the bucket and one marker row is staged, NO bytes in D1, NO row born yet", async () => {
  const fixture = await sessionFixtures();
  const r2 = fakeLaneR2();
  const db = fakeDb([sessionRoute(fixture.row), plusTierRoute("plus")]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.uploadId, /^[A-Za-z0-9_-]{12}$/);

  // The payload rode the bucket at the lane's own key family.
  assert.deepEqual(
    r2.calls.filter((call) => call.op === "put").map((call) => call.key),
    ["gc-lane-staging/" + body.uploadId + "/0"],
  );
  assert.equal(r2.objects.get("gc-lane-staging/" + body.uploadId + "/0")?.length, GC_UPLOAD_PART_BYTES,
    "the staged payload is the part's own bytes");

  // One staged row per part; the 0025 data column (NOT NULL, no DDL wave)
  // carries the 1-byte marker — never a payload byte.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 1, "one staged row per part");
  const statement = batch.statements[0];
  assert.match(statement.sql, /INSERT OR REPLACE INTO gc_upload_parts/);
  assert.equal(statement.bound[0], body.uploadId);
  assert.equal(statement.bound[1], USER_ID);
  assert.equal(statement.bound[2], 0, "the row's seq is the PART's seq");
  assert.equal(statement.bound[3].length, 1, "the byte column is the marker, not the payload");
  assert.notEqual(statement.bound[3].length, ATTACHMENT_CHUNK_BYTES);

  // The row is BORN AT COMMIT: no gc_attachments write rode part one (its
  // mime could never be a truthful CHECK value yet).
  const rowWrites = db.calls.filter((call) =>
    call.call === "batch" || call.call === "run" ||
    (call.call === "first" && /INSERT INTO gc_attachments/.test(call.sql)));
  assert.equal(rowWrites.length, 1, "the one batch is the staging write; the metadata row never appeared");
  assert.doesNotMatch(statement.sql, /gc_attachments/);
});

test("continuations require the SAME member's staged upload; a foreign id is the shared 404", async () => {
  const fixture = await sessionFixtures();
  const r2 = fakeLaneR2();
  const db = fakeDb([
    sessionRoute(fixture.row),
    plusTierRoute("plus"),
    { test: STAGING_MARKER_TEST, first: async () => ({ "1": 1 }) },
  ]);
  const open = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  const { uploadId } = await open.json();
  assert.equal((await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(1, pngPart(), { uploadId }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  )).status, 200);
  // The continuation stages its own part seq (one row, one object).
  const secondBatch = db.calls.filter((call) => call.call === "batch")[1];
  assert.equal(secondBatch.statements[0].bound[2], 1, "the continuation's row rides PART seq 1");

  // A foreign uploadId (never staged by anyone) 404s and writes nothing: the
  // ownership marker is the staging table's own first row.
  const ghost = fakeDb([sessionRoute(fixture.row), plusTierRoute("plus")]);
  const refused = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(3, pngPart(), { uploadId: "BBBBBBBBBBBB" }),
    }),
    envWithLimiters({ GOOBER_DB: ghost }),
  );
  assert.equal(refused.status, 404);
  assert.equal((await refused.text()).includes(UPLOAD_UNKNOWN_ERROR), true);
  assert.deepEqual(ghost.calls.filter((call) => call.call === "batch"), []);
});

test("the part shape's guards: a 128th part index, an empty body, and an over-part body refuse before anything", async () => {
  const fixture = await sessionFixtures();
  const db = fakeDb([sessionRoute(fixture.row), plusTierRoute("plus")]);
  const env = envWithLimiters({ GOOBER_DB: db });
  const send = (seq, bytes, extra = {}) =>
    dispatchUploads(
      new Request(ORIGIN + "/api/uploads/chunks", {
        method: "POST",
        headers: { Origin: ORIGIN, ...fixture.headers },
        body: chunkForm(seq, bytes, extra),
      }),
      env,
    );

  // Part index GC_UPLOAD_PARTS_MAX is out of the window (0..127); so is -1.
  assert.equal((await send(GC_UPLOAD_PARTS_MAX, pngPart(), { size: String(LARGE_TOTAL) })).status, 400);
  assert.equal((await send(-1, pngPart(), { size: String(LARGE_TOTAL) })).status, 400);
  // An empty part body and one over the part cap (413s, with the 1 MiB copy).
  const empty = await send(0, new Uint8Array(0), { size: String(LARGE_TOTAL) });
  assert.equal(empty.status, 413);
  assert.match(await empty.text(), /empty, or more than 1 MiB/);
  const over = await send(0, new Uint8Array(GC_UPLOAD_PART_BYTES + 1), { size: String(LARGE_TOTAL) });
  assert.equal(over.status, 413);
  assert.match(await over.text(), /more than 1 MiB/);
  assert.equal((await send(0, pngPart(), { size: String(GC_PLUS_ATTACHMENT_BYTES + 1) })).status, 400,
    "a declared total above the tier bound is not a large upload");
  assert.equal((await send(0, pngPart(), { size: String(MAX_ATTACHMENT_BYTES) })).status, 400,
    "the small lanes keep everything at or under the single-buffer cap");
});

test("the COMMIT verifies the relational arms, sniffs from the bucket, births the pending row, and assembles the store-of-record object", async () => {
  const fixture = await sessionFixtures();
  const open = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
    }),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(fixture.row), plusTierRoute("plus")]), GC_MEDIA: fakeLaneR2() }),
  );
  const { uploadId } = await open.json();

  // A lawful 24-part set staged in the bucket: seqs 0..23, the full-chunk
  // grid (a part-sized total leaves no short part), PNG magic in part 0.
  const stagedR2 = fakeLaneR2();
  for (let seq = 0; seq < 24; seq += 1) {
    stagedR2.objects.set("gc-lane-staging/" + uploadId + "/" + seq, pngPart());
  }
  const objectKey = "gc-attachments/4242";
  const commitDb = fakeDb([
    sessionRoute(fixture.row),
    plusTierRoute("plus"),
    { test: STAGING_VERIFY_TEST, first: async () => ({ n: 24, lo: 0, hi: 23 }) },
    { test: ROW_BIRTH_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: IDENTITY_TUPLE_TEST, first: async () => ({ id: 4242 }) },
    { test: STAGING_CLEAR_TEST, run: async () => ({ meta: { changes: 24 } }) },
  ]);
  const commit = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/" + uploadId + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...fixture.headers },
      body: JSON.stringify({ size: LARGE_TOTAL }),
    }),
    envWithLimiters({ GOOBER_DB: commitDb, GC_MEDIA: stagedR2 }),
  );
  assert.equal(commit.status, 201);
  const body = await commit.json();
  assert.equal(body.attachment.status, "pending");
  assert.equal(body.attachment.id, 4242);

  // The one D1 batch: the row born under the folded count arm (the
  // verify→commit gap) — the mime rides the bucket seq-0 sniff.
  const batch = commitDb.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 1);
  assert.match(batch.statements[0].sql, /INSERT INTO gc_attachments/);
  assert.match(batch.statements[0].sql,
    /SELECT NULL, \?, \?, \?, 'pending', NULL, NULL, \?/,
    "eight expressions for eight columns (size_bytes keeps its own bind)");
  assert.match(batch.statements[0].sql,
    /\(SELECT COUNT\(\*\) FROM gc_upload_parts WHERE upload_id = \? AND uploader_id = \?\) = \?/,
    "the count arm is the born row's race guard");
  assert.equal(batch.statements[0].bound[0], USER_ID);
  assert.equal(batch.statements[0].bound[1], "image/png", "the SNIFFED mime is what rides the row");
  assert.equal(batch.statements[0].bound[2], LARGE_TOTAL);
  // The arms' own binds: the pair + expected part count (24).
  assert.deepEqual(batch.statements[0].bound.slice(-3), [uploadId, USER_ID, 24]);

  // The assembled object: the media module's key, the exact streamed sum,
  // the byte order the seqs carried.
  const assembled = stagedR2.objects.get(objectKey);
  assert.ok(assembled, "the store-of-record object landed");
  assert.equal(assembled.length, LARGE_TOTAL);
  assert.equal(assembled[0], PNG_MAGIC[0], "part 0's bytes lead");
  assert.equal(assembled[GC_UPLOAD_PART_BYTES], PNG_MAGIC[0], "part 1's bytes lead");
  assert.equal(assembled[(23 * GC_UPLOAD_PART_BYTES) + 1], PNG_MAGIC[1], "the last part closes");

  // The staging rides the D1 gate and the objects FOLLOWED the rows.
  const clear = commitDb.calls.find((call) => call.call === "run" && STAGING_CLEAR_TEST(call.sql));
  assert.ok(clear, "the staging rows left once the object was durable");
  const deleted = stagedR2.calls.filter((call) => call.op === "delete" && call.key.startsWith("gc-lane-staging/"));
  assert.equal(deleted.length, 24, "every staged part object died with its row");
  assert.ok(stagedR2.objects.get(objectKey), "the store-of-record object survives");

  // No chunk bytes ever re-land in D1.
  assert.equal(commitDb.calls.some((call) => (call.sql || "").includes("gc_attachment_chunks")), false,
    "the byte leg never re-lands in D1");
});

test("the COMMIT's refusals: a hole, a seq stranger, a disputed streamed sum, or a non-image never writes a row", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const commitWith = (aggregate, bucket) =>
    dispatchUploads(
      new Request(ORIGIN + "/api/uploads/BBBBBBBBBBBB/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
        body: JSON.stringify({ size: LARGE_TOTAL }),
      }),
      envWithLimiters({ GOOBER_DB: fakeDb([
        sessionRoute(sessionRows),
        plusTierRoute("plus"),
        { test: STAGING_VERIFY_TEST, first: aggregate ? async () => aggregate : null },
        { test: ROW_BIRTH_TEST, run: async () => ({ meta: { changes: 1 } }) },
        { test: IDENTITY_TUPLE_TEST, first: async () => ({ id: 4242 }) },
      ]), GC_MEDIA: bucket }),
    );
  const seedStaging = (bucket, partBytes) => {
    for (let seq = 0; seq < 24; seq += 1) {
      bucket.objects.set("gc-lane-staging/BBBBBBBBBBBB/" + seq, partBytes(seq));
    }
    return bucket;
  };

  // A hole in the staged run: 23 parts for a 24-part set (the client can
  // retry part 23).
  const hole = await commitWith({ n: 23, lo: 0, hi: 22 }, fakeLaneR2());
  assert.equal(hole.status, 400);
  assert.equal((await hole.text()).includes(UPLOAD_INCOMPLETE_ERROR), true);

  // A contiguity stranger: 24 rows whose seqs ride 1..24.
  const stranger = await commitWith({ n: 24, lo: 1, hi: 24 }, fakeLaneR2());
  assert.equal(stranger.status, 400);

  // The bucket's streamed sum disputes the declared total (the size arm's
  // relocated evidence): a lawful relational spread over short-staged parts
  // whose heads sniff PNG (the sum arm answers, never the sniff).
  const shortPart = () => {
    const part = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
    part.set(PNG_MAGIC, 0);
    return part;
  };
  const shortSum = await commitWith({ n: 24, lo: 0, hi: 23 },
    seedStaging(fakeLaneR2(), shortPart));
  assert.equal(shortSum.status, 400);
  assert.equal((await shortSum.text()).includes(UPLOAD_INCOMPLETE_ERROR), true);

  // Not an image: the sniff rides the bucket's seq-0 object, not a claim.
  const notImage = await commitWith({ n: 24, lo: 0, hi: 23 },
    seedStaging(fakeLaneR2(), () => new Uint8Array(ATTACHMENT_CHUNK_BYTES).fill(7)));
  assert.equal(notImage.status, 400);
  assert.equal((await notImage.text()).includes(UPLOAD_ONLY_IMAGES_ERROR), true);

  // Nobody's id: the aggregate read misses, the shared 404 (never an oracle).
  const nobody = await commitWith(null, fakeLaneR2());
  assert.equal(nobody.status, 404);
  assert.equal((await nobody.text()).includes(UPLOAD_UNKNOWN_ERROR), true);
});

test("a staged set that raced past the verify read: the count arm answers 400 with the staging rows intact", async () => {
  // The lawful aggregate, but the row birth's count arm reads the raced set
  // and refuses (changes 0): no row births, no staging clearance, no bucket
  // traffic, the shared retry-copy answers.
  const { row: sessionRows, headers } = await sessionFixtures();
  const r2 = fakeLaneR2();
  for (let seq = 0; seq < 24; seq += 1) {
    r2.objects.set("gc-lane-staging/CCCCCCCCCCCC/" + seq, pngPart());
  }
  const db = fakeDb([
    sessionRoute(sessionRows),
    plusTierRoute("plus"),
    { test: STAGING_VERIFY_TEST,
      first: async () => ({ n: 24, lo: 0, hi: 23 }) },
    { test: ROW_BIRTH_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/CCCCCCCCCCCC/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ size: LARGE_TOTAL }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes(UPLOAD_INCOMPLETE_ERROR), true);
  // Nothing assembled, no object deleted: the staged set rides untouched for
  // the retry.
  assert.equal(r2.calls.some((call) => call.key === "gc-attachments/4242"), false);
  assert.equal(r2.calls.filter((call) => call.op === "delete").length, 0);
});test("the abandon: one guarded staging delete riding the uploader's own id; a malformed id never queries", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(sessionRows)]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/AAAAAAAAAAAA", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const clear = db.calls.find((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_upload_parts"));
  assert.ok(clear, "the staging rows die with the abandon");
  assert.deepEqual(clear.bound, ["AAAAAAAAAAAA", USER_ID], "the WHERE carries the SAME member's id — never another's rows");

  // A malformed id never reaches the handler at all (the dispatch pattern is
  // the same 12-char grammar): the plain API 404, still zero queries.
  const junkDb = fakeDb([]);
  const junk = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/short", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: junkDb }),
  );
  assert.equal(junk.status, 404);
  assert.deepEqual(junkDb.calls, [], "an unparseable id touches nothing");
});

test("the abandon is the PLAIN owner-scoped delete: a clear with the commit's hold-back shape cannot run at all", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(sessionRows)]);
  await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/BBBBBBBBBBBB", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  const clear = db.calls.find((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_upload_parts"));
  assert.ok(clear, "the staging rows die with the abandon");
  // The commit's clear rides a 6-placeholder hold-back arm (the identity
  // tuple's mime/size/created_at pair); an abandon carrying that shape binds
  // FAR fewer values than the SQL holds — real D1 refuses the statement
  // outright, so rows would never leave. The route's clear has no such arm.
  assert.equal((clear.sql.match(/\?/g) || []).length, clear.bound.length,
    "the clear's placeholder count matches its bind count (D1 would throw otherwise)");
  assert.doesNotMatch(clear.sql, /gc_attachment_chunks/, "no hold-back arm rides the abandon");
});

test("the abandon refuses while a sound-pack clip still references the token (409, zero deletes)", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(sessionRows),
    { test: (sql) => sql.includes("FROM gc_sound_pack_sounds WHERE upload_id = ?"), first: async () => ({ "1": 1 }) },
  ]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/AAAAAAAAAAAA", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 409, "a clip-referenced token's bytes are not the uploader's to abandon");
  assert.equal(
    db.calls.some((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_upload_parts")),
    false, "the reference refusal fires before any delete",
  );
});

test("the staged cap: an uploader at the cap cannot mint a fresh staging, the cap-arm is the constant's shape", async () => {
  // The counter reads the uploader's DISTINCT staging uploads whose token no
  // gc_sound_pack_sounds row references.
  const activeCountRoute = (active) => ({
    test: (sql) => sql.includes("COUNT(DISTINCT upload_id)") && sql.includes("FROM gc_upload_parts"),
    first: async () => ({ active }),
  });
  const firstPart = async (fixtures, db) => dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixtures.headers },
      body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
    }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: fakeLaneR2() }),
  );
  const fixture = await sessionFixtures();
  const fullDb = fakeDb([
    sessionRoute(fixture.row), plusTierRoute("plus"), activeCountRoute(GC_UPLOAD_STAGED_CAP),
  ]);
  const full = await firstPart(fixture, fullDb);
  assert.equal(full.status, 409, "the cap refuses the fresh staging outright");
  assert.equal(
    fullDb.calls.some((call) => call.call === "batch"), false,
    "nothing staged behind the refusal",
  );
  const roomyDb = fakeDb([
    sessionRoute(fixture.row), plusTierRoute("plus"), activeCountRoute(GC_UPLOAD_STAGED_CAP - 1),
  ]);
  const roomy = await firstPart(fixture, roomyDb);
  assert.equal(roomy.status, 201, "one under the cap still opens");
});

test("the sweep arm: a TTL delete that never touches a clip-referenced token", async () => {
  const db = fakeDb([]);
  const at = nowSeconds() + 10_000;
  await sweepStaleUploadParts({ GOOBER_DB: db }, at);
  const clear = db.calls.find((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_upload_parts"));
  assert.ok(clear, "the sweep is one staging DELETE");
  assert.match(clear.sql, /created_at < \?/, "the TTL rides the cutoff arm");
  assert.match(clear.sql, /NOT EXISTS \(SELECT 1 FROM gc_sound_pack_sounds s WHERE s\.upload_id = gc_upload_parts\.upload_id\)/,
    "a candidate/approved clip's tokens are never swept");
  assert.equal(clear.bound.length, 1, "the cutoff is the one bind");
  assert.equal(Number(clear.bound[0]), at - GC_UPLOAD_STAGING_TTL_SECONDS,
    "the cutoff is now minus the TTL constant");
});

test("the abandon's clear carries its own in-SQL clip-reference arm (the check-then-act window closes)", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(sessionRows)]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/AAAAAAAAAAAA", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const clear = db.calls.find((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_upload_parts"));
  assert.ok(clear, "the route's one clear ran");
  assert.ok(
    clear.sql.includes(
      "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE upload_id = gc_upload_parts.upload_id)",
    ),
    "a clip row born between the 409 check and the clear refuses IN THE STATEMENT",
  );
  assert.equal((clear.sql.match(/\?/g) || []).length, clear.bound.length,
    "the arm is correlated — no new binds ride it");
});

test("the clear statement itself refuses a clip-referenced token and still clears an orphan", async () => {
  // The encoded engine: the arm's rule applied at the statement — a token a
  // candidate/approved clip points at deletes nothing, an orphan deletes.
  const REFERENCED = "REFERENCEDAA";
  const db = fakeDb([
    {
      test: (sql) => sql === ABANDON_CLEAR_SQL,
      run: async (bound) => ({ meta: { changes: bound[0] === REFERENCED ? 0 : 1 } }),
    },
  ]);
  const refused = await db.prepare(ABANDON_CLEAR_SQL).bind(REFERENCED, USER_ID).run();
  assert.equal(Number(refused.meta.changes), 0, "the clip-referenced token refuses");
  const orphan = await db.prepare(ABANDON_CLEAR_SQL).bind("ORPHANEDAAAA", USER_ID).run();
  assert.equal(Number(orphan.meta.changes), 1, "an unreferenced token still clears");
});

// The first chunk head the D1 serving path assembles: 64,000 PNG-magic bytes
// (the small-row serving fixtures live on the D1 chunk table, untouched).
function pngChunkHead() {
  const chunk = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
  chunk.set(PNG_MAGIC, 0);
  return chunk;
}

// --- media.mjs's paged large-row serving ------------------------------------------

const LARGE_ROW_ID = 4242;
function stagedChunkRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const data = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
    if (index === 0) data.set(PNG_MAGIC, 0);
    else for (let i = 0; i < data.length; i += 1) data[i] = index;
    return { seq: index, data };
  });
}

async function dispatchMedia(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMediaRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

test("a LARGE lane row streams paged: two 64,000-byte chunks concatenate in order under the same status gate", async () => {
  _resetFilterWordsCacheForTests();
  const { row: sessionRows, headers } = await sessionFixtures();
  const pendingRow = { id: LARGE_ROW_ID, uploader_id: USER_ID, status: "pending", mime: "image/png", size_bytes: LARGE_TOTAL };
  const approvedRow = { ...pendingRow, status: "approved" };
  const servingDb = (attachmentRow, rows) => fakeDb([
    sessionRoute(sessionRows),
    { test: ATTACHMENT_ROW_TEST, first: async () => attachmentRow },
    { test: PAGE_READ_TEST, all: async (bound) => (Number(bound[1]) === 0 ? { results: rows } : { results: [] }) },
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
  ]);

  // The uploader may serve their own pending row (the standing gate).
  const pending = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers }),
    envWithLimiters({ GOOBER_DB: servingDb(pendingRow, stagedChunkRows(2)) }),
  );
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get("Content-Type"), "image/png");
  assert.equal(pending.headers.get("Cache-Control"), "private, max-age=300");
  assert.equal(pending.headers.get("X-Content-Type-Options"), "nosniff");
  const received = new Uint8Array(await pending.arrayBuffer());
  assert.equal(received.length, 2 * ATTACHMENT_CHUNK_BYTES, "the pages concatenate IN ORDER");
  assert.equal(received[0], PNG_MAGIC[0], "the first bytes are the stored ones");
  assert.equal(received[ATTACHMENT_CHUNK_BYTES], 1, "the second page's marker byte rides the stream's tail");
});

test("the paged serving's fail-safes: an empty set, a start gap, and a mime stranger are all the shared 404", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const pendingRow = { id: LARGE_ROW_ID, uploader_id: USER_ID, status: "pending", mime: "image/png", size_bytes: LARGE_TOTAL };
  const servingDb = (rows, rowOverride) => fakeDb([
    sessionRoute(sessionRows),
    { test: ATTACHMENT_ROW_TEST, first: async () => ({ ...pendingRow, ...rowOverride }) },
    { test: PAGE_READ_TEST, all: async (bound) => (Number(bound[1]) === 0 ? { results: rows } : { results: [] }) },
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
  ]);

  const empty = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers }),
    envWithLimiters({ GOOBER_DB: servingDb([]) }),
  );
  assert.equal(empty.status, 404);
  const gapped = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers }),
    envWithLimiters({ GOOBER_DB: servingDb([{ seq: 1, data: pngChunkHead() }]) }),
  );
  assert.equal(gapped.status, 404, "the first page must open at seq 0");
  const stranger = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers }),
    envWithLimiters({ GOOBER_DB: servingDb(stagedChunkRows(2), { mime: "image/webp" }) }),
  );
  assert.equal(stranger.status, 404, "the bytes must carry the row's own mime");
});

test("the status gate precedes every byte: an outsider on a pending row is the shared 404", async () => {
  const { row: sessionRows } = await sessionFixtures();
  const pendingRow = { id: LARGE_ROW_ID, uploader_id: USER_ID, status: "pending", mime: "image/png", size_bytes: LARGE_TOTAL };
  const outsiderToken = randomToken();
  const outsiderRow = { ...sessionRows, token_hash: await sha256Hex(outsiderToken), user_id: 999 };
  const outsider = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers: { Cookie: "goober_session=" + outsiderToken } }),
    envWithLimiters({ GOOBER_DB: fakeDb([
      { test: SESSION_READ_TEST, first: async () => outsiderRow },
      { test: ATTACHMENT_ROW_TEST, first: async () => pendingRow },
    ]) }),
  );
  assert.equal(outsider.status, 404);
});

test("the approved row rides the immutable cache copy", async () => {
  _resetFilterWordsCacheForTests();
  const { row: sessionRows, headers } = await sessionFixtures();
  const approvedRow = { id: LARGE_ROW_ID, uploader_id: USER_ID, status: "approved", mime: "image/png", size_bytes: LARGE_TOTAL };
  const approved = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers }),
    envWithLimiters({ GOOBER_DB: fakeDb([
      sessionRoute(sessionRows),
      { test: ATTACHMENT_ROW_TEST, first: async () => approvedRow },
      { test: PAGE_READ_TEST, all: async (bound) => (Number(bound[1]) === 0 ? { results: stagedChunkRows(2) } : { results: [] }) },
      { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
    ]) }),
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
});

test("the moderation reject runs a bucket-less env: the batch still ends the row, and nothing else was ever consulted", async () => {
  const { row: sessionRows, headers } = await sessionFixtures("admin");
  const db = fakeDb([sessionRoute(sessionRows)]);
  const response = await handleMediaRoutes(
    new Request(ORIGIN + "/api/admin/attachments/88/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    }),
    envWithLimiters({ GOOBER_DB: db }),
    new URL(ORIGIN + "/api/admin/attachments/88/reject"),
    "/api/admin/attachments/88/reject",
    "POST",
    {},
  );
  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch, "the reject batch (chunks delete + status flip) rode the one statement family");
});

// --- the send route's attach-by-id ------------------------------------------------

test("the send route's attach-by-id: the batch re-guards the owned standalone row, and the ref lands with the message", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const attachmentRowId = 55;
  const db = fakeDb([
    sessionRoute(row),
    // The channel access + the plus cap read.
    { test: (sql) => sql.includes("FROM gc_channels c WHERE c.id = ?") && sql.includes("gc_server_members m") && sql.includes("gc_conversation_members cm"),
      first: async () => ({ id: 3, server_id: 1, kind: "text" }) },
    { test: PLUS_TIER_TEST, first: async () => ({ renews_until: nowSeconds() + 3600, tier: "plus" }) },
    // The pre-check's owned read (a lane-bound standalone row, unattached).
    { test: (sql) => sql.includes("SELECT size_bytes FROM gc_attachments WHERE id = ? AND message_id IS NULL AND uploader_id = ?"),
      first: async () => ({ size_bytes: GC_PLUS_ATTACHMENT_BYTES }) },
    // The send's reselect after the batch.
    { test: (sql) => sql.includes("FROM gc_messages m JOIN users u") && sql.includes("client_message_id") && sql.includes("ORDER BY m.id DESC LIMIT 1"),
      run: async () => ({ meta: { changes: 1 }, results: [{ id: 12, author_id: USER_ID, author_name: "wempos", body: "the big one", client_message_id: null, source: null, created_at: 100, edited_at: null }] }) },
  ]);
  const response = await handleMessageRoutes(
    new Request(ORIGIN + "/api/channels/3/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ body: "the big one", attachmentId: attachmentRowId }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
    new URL(ORIGIN + "/api/channels/3/messages"),
    "/api/channels/3/messages",
    "POST",
    {},
  );
  assert.ok(response);
  assert.equal(response.status, 201);
  const batch = db.calls.find((call) => call.call === "batch");
  const reference = batch.statements.find((statement) => statement.sql.startsWith("UPDATE gc_attachments SET message_id"));
  assert.ok(reference, "the batch carries the attach-by-id UPDATE");
  assert.match(reference.sql, /message_id IS NULL AND uploader_id = \? AND size_bytes <= \?/);
  assert.match(reference.sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji/);
  assert.equal(reference.bound[3], attachmentRowId);
  assert.equal(reference.bound[5], 1_073_741_824, "the cap is the caller's own tier read");
});

async function dispatchMessages(request, env, path) {
  let response;
  try {
    response = await handleMessageRoutes(request, env, new URL(request.url), path, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response;
}

test("the attach-by-id refusals: free is the 403, unowned and over-cap rows are the 400 — the cap stays the caller's tier", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const channelRoute = {
    test: (sql) => sql.includes("FROM gc_channels c WHERE c.id = ?") && sql.includes("gc_server_members m") && sql.includes("gc_conversation_members cm"),
    first: async () => ({ id: 3, server_id: 1, kind: "text" }),
  };
  const base = [sessionRoute(row), channelRoute];
  const sendRequest = () =>
    new Request(ORIGIN + "/api/channels/3/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ body: "hi", attachmentId: 55 }),
    });
  const OWNED_TEST = (sql) => sql.includes("SELECT size_bytes FROM gc_attachments WHERE id = ? AND message_id IS NULL AND uploader_id = ?");

  // A lapsed or never-bought caller: the ref never applies under the free cap.
  const free = fakeDb([...base, { test: PLUS_TIER_TEST, first: async () => null }]);
  const freeResponse = await dispatchMessages(sendRequest(), envWithLimiters({ GOOBER_DB: free }), "/api/channels/3/messages");
  assert.equal(freeResponse.status, 403);
  assert.deepEqual(free.calls.filter((call) => call.call === "batch"), []);

  // Not owned (the pre-check's read misses): no batch ever ran.
  const unowned = fakeDb([...base, plusTierRoute("plus"), { test: OWNED_TEST, first: async () => null }]);
  const refused = await dispatchMessages(sendRequest(), envWithLimiters({ GOOBER_DB: unowned }), "/api/channels/3/messages");
  assert.equal(refused.status, 400);
  assert.deepEqual(unowned.calls.filter((call) => call.call === "batch"), []);

  // A Mini member attaching a row over THEIR OWN cap never passes — the
  // pre-check binds size_bytes against the CALLER's cap, so a lane-bound row
  // is simply not visible (still the 400, still no batch). The fake honors
  // the bound cap exactly as the real WHERE clause would.
  const mini = fakeDb([...base, plusTierRoute("mini"), {
    test: OWNED_TEST,
    first: async (bound) => (GC_PLUS_ATTACHMENT_BYTES <= Number(bound[2]) ? { size_bytes: GC_PLUS_ATTACHMENT_BYTES } : null),
  }]);
  const miniResponse = await dispatchMessages(sendRequest(), envWithLimiters({ GOOBER_DB: mini }), "/api/channels/3/messages");
  assert.equal(miniResponse.status, 400);
  assert.deepEqual(mini.calls.filter((call) => call.call === "batch"), []);

  // A malformed reference field is the request-shape 400 before anything.
  const malformed = fakeDb([...base, plusTierRoute("plus")]);
  const junk = await dispatchMessages(
    new Request(ORIGIN + "/api/channels/3/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ body: "hi", attachmentId: "gold" }),
    }),
    envWithLimiters({ GOOBER_DB: malformed }),
    "/api/channels/3/messages",
  );
  assert.equal(junk.status, 400);
  assert.deepEqual(malformed.calls.filter((call) => call.call === "batch"), []);
});

test("the DO path's primitive: a reference rides sendMessageToChannel directly and links inside its one batch", async () => {
  _resetFilterWordsCacheForTests();
  const user = { id: USER_ID, username: "wempos", role: "member" };
  const db = fakeDb([
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
    plusTierRoute("plus"),
    { test: (sql) => sql.includes("SELECT size_bytes FROM gc_attachments WHERE id = ? AND message_id IS NULL AND uploader_id = ?"),
      first: async () => ({ size_bytes: GC_PLUS_ATTACHMENT_BYTES }) },
    { test: (sql) => sql.includes("FROM gc_messages m JOIN users u") && sql.includes("client_message_id") && sql.includes("ORDER BY m.id DESC LIMIT 1"),
      run: async () => ({ meta: { changes: 1 }, results: [{ id: 9, author_id: USER_ID, author_name: "wempos", body: "ref send", client_message_id: null, source: null, created_at: 100, edited_at: null }] }) },
  ]);
  const { message } = await sendMessageToChannel(
    envWithLimiters({ GOOBER_DB: db }),
    user,
    3,
    "ref send",
    null,
    null,
    77,
  );
  assert.equal(message.id, 9);
  const batch = db.calls.find((call) => call.call === "batch");
  const reference = batch.statements.find((statement) => statement.sql.startsWith("UPDATE gc_attachments SET message_id"));
  assert.equal(reference.bound[3], 77);
});
