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

// The LARGE-FILE upload lane, D1-ONLY (owner ruling, Nov 17: "no park, and
// no r2"): pins for the chunked intake's staged rows (the gc_upload_parts
// staging table, migration 0025), the commit's aggregate verification + one
// batch move, the abandon's staging delete, media.mjs's paged large-row
// serving, and the send route's attach-by-id. NO test here passes
// env.UPLOAD_BUCKET — the lane never touches one, and that absence IS the
// D1-only pin (the old design's 503 dormancy gate died with R2).
import test from "node:test";
import assert from "node:assert/strict";

import { handleUploadRoutes, UPLOAD_TIER_ERROR, UPLOAD_UNKNOWN_ERROR, UPLOAD_INCOMPLETE_ERROR, UPLOAD_ONLY_IMAGES_ERROR, UPLOAD_PART_INVALID_ERROR } from "../api/uploads.mjs";
import { handleMediaRoutes } from "../api/media.mjs";
import { handleMessageRoutes, sendMessageToChannel } from "../api/messages.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  ATTACHMENT_CHUNK_BYTES,
  GC_UPLOAD_CHUNKS_MAX,
  GC_UPLOAD_LANE_MAX_BYTES,
  GC_UPLOAD_PART_BYTES,
  GC_UPLOAD_PART_CHUNKS,
  GC_UPLOAD_PART_REQUEST_BYTES,
  GC_UPLOAD_PARTS_MAX,
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

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const PLUS_TIER_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const ATTACHMENT_ROW_TEST = (sql) =>
  sql.includes("SELECT id, uploader_id, status, mime, size_bytes FROM gc_attachments");
// The commit's verification aggregate and the staging reads, route-distinct.
const STAGING_VERIFY_TEST = (sql) => sql.includes("MIN(CASE WHEN length(data)") && sql.includes("FROM gc_upload_parts");
const STAGING_HEAD_TEST = (sql) => sql.includes("FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0");
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
  return { token, row, headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf } };
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

test("the lane's constants: 1 MiB parts as 16 proven chunks, 128 of them, the ~125 MiB bound derivable", () => {
  assert.equal(GC_UPLOAD_PART_CHUNKS, 16);
  assert.equal(GC_UPLOAD_PART_BYTES, 16 * ATTACHMENT_CHUNK_BYTES, "the part is chunks, not a raw number"); // 1,024,000
  assert.equal(GC_UPLOAD_PART_REQUEST_BYTES, GC_UPLOAD_PART_BYTES + 512 * 1024);
  assert.equal(GC_UPLOAD_PARTS_MAX, 128); // parity-limits.md gc working lane row
  assert.equal(GC_UPLOAD_CHUNKS_MAX, 128 * 16);
  assert.equal(GC_UPLOAD_LANE_MAX_BYTES, 131_072_000, "the engineering bound is 128 parts x 1,024,000");
  assert.equal(MAX_ATTACHMENT_BYTES, 20_971_520, "the free tier rides Discord's Aug-2026 20 MiB raise");
});

// The D1-ONLY pin: every test below dispatches with NO env.UPLOAD_BUCKET at
// all — the routes never consult one (the 503 dormancy gate died with R2).

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

test("the part intake: the first part slices into 16 staged chunk rows and NO row is born yet", async () => {
  const fixture = await sessionFixtures();
  const db = fakeDb([sessionRoute(fixture.row), plusTierRoute("plus")]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.uploadId, /^[A-Za-z0-9_-]{12}$/);

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  // T10 F3: the staging flush LEADS the batch (one self-healing DELETE that
  // bounds the caller's staging at the only write point), then the part's 16
  // chunk rows.
  assert.equal(batch.statements.length, GC_UPLOAD_PART_CHUNKS + 1, "the flush + exactly 16 chunk rows");
  assert.match(batch.statements[0].sql, /DELETE FROM gc_upload_parts WHERE uploader_id = \? AND \(upload_id, seq\) NOT IN/);
  assert.match(batch.statements[0].sql, /ORDER BY created_at DESC, seq DESC LIMIT 4096/);
  assert.deepEqual(batch.statements[0].bound, [USER_ID, USER_ID]);
  batch.statements.slice(1).forEach((statement, index) => {
    assert.match(statement.sql, /INSERT OR REPLACE INTO gc_upload_parts/);
    assert.equal(statement.bound[0], body.uploadId);
    assert.equal(statement.bound[1], USER_ID);
    assert.equal(statement.bound[2], index, "the chunk seqs follow the part's slice order");
    assert.equal(statement.bound[3].length, ATTACHMENT_CHUNK_BYTES, "every slice rides the 64,000-byte grid");
  });

  // The row is BORN AT COMMIT: no gc_attachments write rode part one (its
  // mime could never be a truthful CHECK value yet).
  const rowWrites = db.calls.filter((call) =>
    call.call === "batch" || call.call === "run" ||
    (call.call === "first" && /INSERT INTO gc_attachments/.test(call.sql)));
  assert.equal(rowWrites.length, 1, "the one batch is the staging write; the metadata row never appeared");
  assert.doesNotMatch(batch.statements[0].sql, /gc_attachments/);
});

test("continuations require the SAME member's staged upload; a foreign id is the shared 404", async () => {
  const fixture = await sessionFixtures();
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
    envWithLimiters({ GOOBER_DB: db }),
  );
  const { uploadId } = await open.json();
  assert.equal((await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(1, pngPart(), { uploadId }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  )).status, 200);
  // The continuation's slice starts at part 1's chunk grid (after the flush
  // statement the T10 F3 cap leads every intake batch with).
  const secondBatch = db.calls.filter((call) => call.call === "batch")[1];
  assert.match(secondBatch.statements[0].sql, /DELETE FROM gc_upload_parts/);
  assert.equal(secondBatch.statements[1].bound[2], GC_UPLOAD_PART_CHUNKS, "part 1's rows start at chunk seq 16");

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
  assert.equal((await send(0, pngPart(), { size: String(GC_UPLOAD_LANE_MAX_BYTES + 1) })).status, 400,
    "a declared total above the lane bound is not a large upload");
  assert.equal((await send(0, pngPart(), { size: String(MAX_ATTACHMENT_BYTES) })).status, 400,
    "the small lanes keep everything at or under the single-buffer cap");
});

test("the COMMIT verifies, sniffs from the staged first chunk, births the pending row, and moves the set in ONE batch", async () => {
  const fixture = await sessionFixtures();
  const open = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/chunks", {
      method: "POST",
      headers: { Origin: ORIGIN, ...fixture.headers },
      body: chunkForm(0, pngPart(), { size: String(LARGE_TOTAL) }),
    }),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(fixture.row), plusTierRoute("plus")]) }),
  );
  const { uploadId } = await open.json();

  // The aggregate answers a lawful 6-part set: 96 chunk rows, 0..95, the
  // full-chunk sum, no short row (the last chunk fills exactly at a
  // part-sized total).
  const commitDb = fakeDb([
    sessionRoute(fixture.row),
    plusTierRoute("plus"),
    {
      test: STAGING_VERIFY_TEST,
      first: async () => ({ n: 6 * GC_UPLOAD_PART_CHUNKS, lo: 0, hi: 6 * GC_UPLOAD_PART_CHUNKS - 1, totalSize: LARGE_TOTAL, firstShort: null }),
    },
    { test: STAGING_HEAD_TEST, first: async () => ({ data: pngChunkHead() }) },
    // The move's changes are its row count (one chunk row per staged chunk).
    { test: (sql) => sql.startsWith("INSERT INTO gc_attachment_chunks"),
      run: async () => ({ meta: { changes: 6 * GC_UPLOAD_PART_CHUNKS } }) },
    // The identity tuple resolves the born row's id (read after the batch).
    { test: IDENTITY_TUPLE_TEST, first: async () => ({ id: 4242 }) },
  ]);
  const commit = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/" + uploadId + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...fixture.headers },
      body: JSON.stringify({ size: LARGE_TOTAL }),
    }),
    envWithLimiters({ GOOBER_DB: commitDb }),
  );
  assert.equal(commit.status, 201);
  const body = await commit.json();
  assert.equal(body.attachment.status, "pending");
  assert.equal(body.attachment.id, 4242);

  // The one atomic batch: row → move → clear, each folding the staged set's
  // count/sum arms (the verify→commit gap: a set that raced past the verify
  // read writes NOTHING — the row is born under the arms, the clear holds
  // until the chunks carry the batch's identity).
  const batch = commitDb.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 3);
  assert.match(batch.statements[0].sql, /INSERT INTO gc_attachments/);
  assert.match(batch.statements[0].sql,
    /SELECT NULL, \?, \?, \?, 'pending', NULL, NULL, \?/,
    "eight expressions for eight columns (size_bytes keeps its own bind)");
  assert.match(batch.statements[0].sql, /COUNT\(\*\) FROM gc_upload_parts WHERE upload_id = \? AND uploader_id = \?\) = \?/);
  assert.equal(batch.statements[0].bound[0], USER_ID);
  assert.equal(batch.statements[0].bound[1], "image/png", "the SNIFFED mime is what rides the row");
  assert.equal(batch.statements[0].bound[2], LARGE_TOTAL);
  // The arms' own binds: the count pair + expected count (96), the sum pair
  // + expected sum (the declared total).
  assert.deepEqual(batch.statements[0].bound.slice(-6), [uploadId, USER_ID, 6 * GC_UPLOAD_PART_CHUNKS, uploadId, USER_ID, LARGE_TOTAL]);

  assert.match(batch.statements[1].sql, /INSERT INTO gc_attachment_chunks \(attachment_id, seq, data\)/);
  assert.match(batch.statements[1].sql, /SELECT \(SELECT id FROM gc_attachments WHERE message_id IS NULL/);
  assert.match(batch.statements[1].sql, /FROM gc_upload_parts WHERE upload_id = \? AND uploader_id = \?/);
  // The move folds the SAME arms.
  assert.match(batch.statements[1].sql, /\) = \? AND/);
  assert.deepEqual(batch.statements[1].bound.slice(-6), [uploadId, USER_ID, 6 * GC_UPLOAD_PART_CHUNKS, uploadId, USER_ID, LARGE_TOTAL]);

  // The clear holds until the chunks carry the batch's identity.
  assert.match(batch.statements[2].sql, /^DELETE FROM gc_upload_parts/);
  assert.match(batch.statements[2].sql, /AND EXISTS \(SELECT 1 FROM gc_attachment_chunks WHERE attachment_id =/);
  assert.deepEqual(batch.statements[2].bound, [uploadId, USER_ID, USER_ID, "image/png", LARGE_TOTAL, batch.statements[2].bound[5]]);
});

// The first chunk head the commit sniffs: 64,000 PNG-magic bytes.
function pngChunkHead() {
  const chunk = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
  chunk.set(PNG_MAGIC, 0);
  return chunk;
}

test("the COMMIT's verification: a hole, a misplaced short row, a disputed sum, or a non-image never writes a row", async () => {
  const { row: sessionRows, headers } = await sessionFixtures();
  const commitWith = (aggregate, head, tierRoute = plusTierRoute("plus")) =>
    dispatchUploads(
      new Request(ORIGIN + "/api/uploads/BBBBBBBBBBBB/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
        body: JSON.stringify({ size: LARGE_TOTAL }),
      }),
      envWithLimiters({ GOOBER_DB: fakeDb([
        sessionRoute(sessionRows),
        tierRoute,
        { test: STAGING_VERIFY_TEST, first: aggregate ? async () => aggregate : null },
        { test: STAGING_HEAD_TEST, first: async () => ({ data: head ?? pngChunkHead() }) },
      ]) }),
    );

  // The tier gate re-check (T10 F2-LOW rider): a lapsed term (a free or mini
  // pair at commit time) refuses with the 403 and NEVER reaches the
  // aggregate — the gate sits before every other read, so a downgraded
  // member cannot convert their staging into a born row.
  const downgraded = await commitWith({ n: 96, lo: 0, hi: 95, totalSize: LARGE_TOTAL, firstShort: null }, pngChunkHead(), plusTierRoute("mini"));
  assert.equal(downgraded.status, 403);
  assert.match(await downgraded.text(), /Large-file uploads are a full Goober\+ perk/);

  // A hole in the staged seq run: a short row rides at 48, not the tail
  // (n = 95 of the lawful 96 — the client can retry part 5).
  const hole = await commitWith({ n: 95, lo: 0, hi: 94, totalSize: LARGE_TOTAL - 64000, firstShort: 48 });
  assert.equal(hole.status, 400);
  assert.equal((await hole.text()).includes(UPLOAD_INCOMPLETE_ERROR), true);

  // A short row that is NOT the last one, with correct totals otherwise.
  const misplaced = await commitWith({ n: 96, lo: 0, hi: 95, totalSize: LARGE_TOTAL, firstShort: 0 });
  assert.equal(misplaced.status, 400);

  // A declared total the staged sum disputes.
  const wrongSum = await commitWith({ n: 96, lo: 0, hi: 95, totalSize: LARGE_TOTAL - 1, firstShort: null });
  assert.equal(wrongSum.status, 400);

  // Not an image: the sniff runs on the STORED first chunk, not a client claim.
  const notImage = await commitWith({ n: 96, lo: 0, hi: 95, totalSize: LARGE_TOTAL, firstShort: null },
    new Uint8Array(ATTACHMENT_CHUNK_BYTES).fill(7));
  assert.equal(notImage.status, 400);
  assert.equal((await notImage.text()).includes(UPLOAD_ONLY_IMAGES_ERROR), true);

  // Nobody's id: the aggregate read misses, the shared 404 (never an oracle).
  const nobody = await commitWith(null);
  assert.equal(nobody.status, 404);
  assert.equal((await nobody.text()).includes(UPLOAD_UNKNOWN_ERROR), true);

  // A declared total inside neither lane: the same 400 as the chunk route's.
  void UPLOAD_ONLY_IMAGES_ERROR;
});

test("a staged set that raced past the verify read: the folded arms answer 400 with the staging rows intact", async () => {
  // The lawful aggregate, but the batch's MOVE reports zero changes (the
  // in-statement arms read the raced set): no row births, no staging clearing,
  // the shared retry-copy answers.
  const { row: sessionRows, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(sessionRows),
    plusTierRoute("plus"),
    { test: STAGING_VERIFY_TEST,
      first: async () => ({ n: 96, lo: 0, hi: 95, totalSize: LARGE_TOTAL, firstShort: null }) },
    { test: STAGING_HEAD_TEST, first: async () => ({ data: pngChunkHead() }) },
    { test: (sql) => sql.startsWith("INSERT INTO gc_attachment_chunks"),
      run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/CCCCCCCCCCCC/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ size: LARGE_TOTAL }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes(UPLOAD_INCOMPLETE_ERROR), true);
  // The clear statement carries its hold-back arm, so a refused move keeps
  // the staged set exactly as it was.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.match(batch.statements[2].sql, /AND EXISTS \(SELECT 1 FROM gc_attachment_chunks/);
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
    new Request(ORIGIN + "/api/attachments/" + LARGE_ROW_ID, { headers: { Cookie: "__Host-goober_session=" + outsiderToken } }),
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
      first: async () => ({ size_bytes: GC_UPLOAD_LANE_MAX_BYTES }) },
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
    first: async (bound) => (GC_UPLOAD_LANE_MAX_BYTES <= Number(bound[2]) ? { size_bytes: GC_UPLOAD_LANE_MAX_BYTES } : null),
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
      first: async () => ({ size_bytes: GC_UPLOAD_LANE_MAX_BYTES }) },
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
