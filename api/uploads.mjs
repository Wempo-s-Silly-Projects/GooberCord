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

// The LARGE-FILE upload lane — D1-ONLY since 2026-11-17 (owner ruling: "no
// park, and no r2"). The object-store design is gone: no binding check, no
// bucket, no key families, no serving fallback. The lane streams a large
// upload through D1 using the proven chunk machinery's pre-commit half —
// each part request slices its ≤1 MiB body into GC_UPLOAD_PART_CHUNKS
// 64,000-byte rows in the gc_upload_parts staging table (migration 0025,
// the same row shape gc_attachment_chunks carries, keyed by the client-held
// upload id instead of an attachment id).
//
// The gc_attachments row is born at COMMIT with the sniffed mime and the
// verified size — never a placeholder the mime CHECK cannot hold — and the
// SAME batch moves the staging set into gc_attachment_chunks (INSERT..SELECT
// over an in-batch identity tuple) and deletes the staging rows. The commit
// verifies the set from one aggregate read: contiguous 0..n-1 chunk seqs,
// every row full-chunked except (at most) the last, and the byte sum equal
// to the declared size. A failed verification leaves the staging rows AS-IS
// — the client can retry the missing parts or abandon — and never writes a
// row. Status rides 'pending' exactly like every other intake (the serving
// gate answers before any bytes move; media.mjs serves large rows paged).
import { requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readLimitedBody } from "./core/http.mjs";
import { blobToUint8Array, sniffImageMime } from "./core/images.mjs";
import { attachmentCapBytes } from "./plus.mjs";
import {
  ATTACHMENT_CHUNK_BYTES,
  GC_UPLOAD_LANE_MAX_BYTES,
  GC_UPLOAD_PART_BYTES,
  GC_UPLOAD_PART_CHUNKS,
  GC_UPLOAD_PART_REQUEST_BYTES,
  GC_UPLOAD_PARTS_MAX,
  GC_STAGING_ROWS_MAX_PER_USER,
  MAX_ATTACHMENT_BYTES,
} from "../constants.mjs";

export const UPLOAD_TIER_ERROR = "Large-file uploads are a full Goober+ perk.";
export const UPLOAD_PART_INVALID_ERROR = "That upload part is invalid.";
export const UPLOAD_UNKNOWN_ERROR = "That upload does not exist.";
export const UPLOAD_INCOMPLETE_ERROR = "The upload did not finish — send it again.";
export const UPLOAD_ONLY_IMAGES_ERROR = "Only image files are accepted.";

const uploadMaxKib = () => Math.ceil(GC_UPLOAD_PART_BYTES / (1024 * 1024));
const PART_TOO_LARGE_ERROR = "That part is more than " + uploadMaxKib() + " MiB.";
const PART_AND_SIZE_ERROR = "That part is empty, or more than " + uploadMaxKib() + " MiB.";

// The multipart shape, mirrored from media.mjs's reader (the declared-length
// pattern: framing asserts the cap, otherwise the counted buffering does).
// The body rides the single file field; the fields carry the part position
// (and, on the FIRST part, the declared total).
const CHUNK_FIELD = "chunk";

async function readChunkMultipart(request) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    throw new HttpError(415, "Send each upload part as multipart/form-data.");
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > GC_UPLOAD_PART_REQUEST_BYTES) {
    throw new HttpError(413, PART_TOO_LARGE_ERROR);
  }
  let form;
  if (declaredLength > 0) {
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "The upload part could not be read.");
    }
  } else {
    let buffered;
    try {
      buffered = await readLimitedBody(request, GC_UPLOAD_PART_REQUEST_BYTES);
    } catch {
      throw new HttpError(413, PART_TOO_LARGE_ERROR);
    }
    try {
      form = await new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: buffered,
      }).formData();
    } catch {
      throw new HttpError(400, "The upload part could not be read.");
    }
  }
  const fields = {};
  let chunk = null;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      fields[name] = value;
      continue;
    }
    if (name !== CHUNK_FIELD || chunk !== null) {
      throw new HttpError(400, "Send one part at a time in the '" + CHUNK_FIELD + "' field.");
    }
    chunk = new Uint8Array(await value.arrayBuffer());
  }
  return { fields, chunk };
}

// One part body becomes the batch of chunk rows: its slice boundaries land
// on the 64,000-byte grid (the last slice of the last part may be short),
// so the commit's framing check — every row full except (at most) the final
// one — reads straight off the aggregate.
function partChunkStatements(env, uploadId, uploaderId, seq, chunk, now) {
  const statements = [];
  for (
    let offset = 0, chunkSeq = seq * GC_UPLOAD_PART_CHUNKS;
    offset < chunk.length;
    offset += ATTACHMENT_CHUNK_BYTES, chunkSeq += 1
  ) {
    statements.push(
      env.GOOBER_DB.prepare(
        "INSERT OR REPLACE INTO gc_upload_parts (upload_id, uploader_id, seq, data, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(uploadId, uploaderId, chunkSeq, chunk.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES), now),
    );
  }
  return statements;
}

// The commit's one-read verification: contiguous 0..n-1 seqs (MIN 0 and
// MAX + 1 = COUNT), byte sum equal to the declared size, and at most one
// short row — the LAST one (MIN of the short rows' seqs is null when every
// row is full, the shared index otherwise).
const STAGING_VERIFY_SQL =
  "SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi, SUM(length(data)) AS totalSize, " +
    "MIN(CASE WHEN length(data) <> " + ATTACHMENT_CHUNK_BYTES + " THEN seq END) AS firstShort " +
    "FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";

const STAGING_HEAD_SQL =
  "SELECT data FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0";

// The identity tuple, the e0ba49c shape media.mjs's standalone INSERT rides
// (no last_insert_rowid dependence): the row is born inside the same batch
// that moves the bytes, and BOTH statements resolve the id the same way.
export const IDENTITY_TUPLE_SQL =
  "(SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = ? " +
    "AND mime = ? AND size_bytes = ? AND created_at = ? ORDER BY id DESC LIMIT 1)";

export const ROW_INSERT_SQL =
  "INSERT INTO gc_attachments (message_id, uploader_id, mime, size_bytes, status, width, height, created_at) " +
    // The row is born ONLY when the staged set still matches the verified
    // aggregate (the count/sum re-check below): a set that moved between the
    // verify read and this batch births nothing — the staging rows stay for
    // a retry, and the route's classification answers the shared copy.
    // Eight expressions for eight columns: size_bytes keeps its own `?` (the
    // identity tuple's third bind) and created_at takes the last one — a
    // 7-for-8 shape throws "7 values for 8 columns" on every commit.
    "SELECT NULL, ?, ?, ?, 'pending', NULL, NULL, ? WHERE ";

// The staged set's own two aggregate arms, folded into BOTH the row insert
// and the move statement (the rider's verify→commit gap): the arms ride
// inside the batch's transaction, so a part set that grew, shrank, or
// re-landed different bytes after the verify read can no longer move.
export const STAGING_ARMS_SQL =
  "(SELECT COUNT(*) FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?) = ? AND " +
    "(SELECT COALESCE(SUM(length(data)), 0) FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?) = ?";

// The arms' binds: the count pair + expected count, the sum pair + expected sum.
function stagingArmsBinds(uploadId, uploaderId, count, size) {
  return [uploadId, uploaderId, count, uploadId, uploaderId, size];
}

// The MOVE: every staging chunk lands in the chunk table under the row the
// batch just birthed, ordered by seq — ONE statement, whatever the size.
export const STAGING_MOVE_SQL =
  "INSERT INTO gc_attachment_chunks (attachment_id, seq, data) " +
    "SELECT " + IDENTITY_TUPLE_SQL + ", seq, data " +
    "FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND " + STAGING_ARMS_SQL;

// The staging clear rides its own hold-back arm: the rows only leave once
// the chunks actually carry the batch's identity (a refused move — the arms
// read the raced set — leaves the staging set EXACTLY as the caller staged
// it, the retry's whole point).
export const STAGING_CLEAR_SQL = "DELETE FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? " +
  "AND EXISTS (SELECT 1 FROM gc_attachment_chunks WHERE attachment_id = " + IDENTITY_TUPLE_SQL + ")";

// --- routes -----------------------------------------------------------------------

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{12}$/;

// The staging flush (T10 F3): ONE self-healing DELETE rides every part
// intake's batch, keeping the caller's gc_upload_parts staging bounded at
// the table's only write point (see constants.mjs
// GC_STAGING_ROWS_MAX_PER_USER — the two-lane bound). The kept window is the
// subselect's ORDER (created_at desc, then seq desc), so zero extra reads:
// the statement is itself the count. A lane the flush consumes surfaces at
// COMMIT as a failed aggregate verification and a client re-upload — never a
// silent truncation.
function stagingFlushStatement(env, uploaderId) {
  return env.GOOBER_DB.prepare(
    "DELETE FROM gc_upload_parts WHERE uploader_id = ? AND (upload_id, seq) NOT IN (" +
      "SELECT upload_id, seq FROM gc_upload_parts WHERE uploader_id = ? " +
      "ORDER BY created_at DESC, seq DESC LIMIT " + GC_STAGING_ROWS_MAX_PER_USER + ")",
  ).bind(uploaderId, uploaderId);
}

export async function handleUploadChunkRoute(request, env) {
  const session = await requireUser(request, env);
  // The READ bucket carries the per-part flow: the UPLOAD limiter's own shape
  // is per-FILE, and a lane-max file is 128 parts.
  await rateLimit(request, env, "read", "uploads-chunks:" + session.user.id);
  const { fields, chunk } = await readChunkMultipart(request);
  const uploaderId = Number(session.user.id);

  const seq = Number(fields.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq >= GC_UPLOAD_PARTS_MAX) {
    throw new HttpError(400, UPLOAD_PART_INVALID_ERROR);
  }
  if (chunk === null || chunk.length < 1 || chunk.length > GC_UPLOAD_PART_BYTES) {
    throw new HttpError(413, PART_AND_SIZE_ERROR);
  }

  // The tier gate: the lane rides ONLY the full-plus cap. attachmentCapBytes
  // answers 'plus' for an active full (or a legacy NULL) term and 'mini' for
  // the lighter one (with the 50 MiB pair) — the tier table's 1 GiB ceiling
  // is a full-plus perk, so Mini and free never reach the lane.
  const caps = await attachmentCapBytes(env, uploaderId, nowSeconds());
  if (caps.tier !== "plus" || caps.fileBytes <= MAX_ATTACHMENT_BYTES) {
    throw new HttpError(403, UPLOAD_TIER_ERROR);
  }

  const now = nowSeconds();
  if (seq > 0) {
    const uploadId = typeof fields.uploadId === "string" ? fields.uploadId : "";
    if (!UPLOAD_ID_RE.test(uploadId)) throw new HttpError(400, UPLOAD_PART_INVALID_ERROR);
    // The ownership marker lives in the staging table now: a continuation
    // answers an upload whose FIRST part the SAME member already wrote — a
    // foreign or finished id is the shared 404, never a 403 that would
    // confirm existence.
    const marker = await env.GOOBER_DB.prepare(
      "SELECT 1 FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0",
    ).bind(uploadId, uploaderId).first();
    if (!marker) throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
    // OR REPLACE: a retried part re-lands its slice honestly (the commit
    // re-verifies the whole set from the aggregate either way). The flush
    // rides the SAME batch, ahead of the part's rows.
    await env.GOOBER_DB.batch([
      stagingFlushStatement(env, uploaderId),
      ...partChunkStatements(env, uploadId, uploaderId, seq, chunk, now),
    ]);
    return json({ ok: true });
  }

  // The FIRST part opens the upload: the declared total must be a size the
  // small lanes do NOT own (they keep their single-buffer contract
  // untouched) and the working lane bound admits (constants.mjs cites the
  // derivation — the 1 GiB tier row is the table's wording, this is the lane).
  const size = Number(fields.size);
  if (!Number.isInteger(size) || size <= MAX_ATTACHMENT_BYTES || size > GC_UPLOAD_LANE_MAX_BYTES) {
    throw new HttpError(400, "That file size is not a large upload.");
  }
  const uploadId = randomToken(12).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  // The flush opens the batch here too — a fresh uploadId is the natural
  // hygiene point (the abandoned lane's rows are the accretion being bounded).
  await env.GOOBER_DB.batch([
    stagingFlushStatement(env, uploaderId),
    ...partChunkStatements(env, uploadId, uploaderId, 0, chunk, now),
  ]);
  // NO gc_attachments row exists yet — the row is born at COMMIT with the
  // sniffed mime and the verified size.
  return json({ uploadId }, 201);
}

export async function handleCommitUploadRoute(request, env, uploadId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "upload", "uploads-commit:" + session.user.id);
  if (!UPLOAD_ID_RE.test(String(uploadId || ""))) {
    throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
  }
  const uploaderId = Number(session.user.id);

  // The tier gate re-check (T10 F2-LOW rider): the intake route's gate and
  // the commit's are ONE invariant, asserted at BOTH write points — a member
  // whose term lapses between the last part and the commit cannot downgrade
  // their staging into a born row. A grace member rides the FREE pair (the
  // strict predicate), exactly like the intake.
  const caps = await attachmentCapBytes(env, uploaderId, nowSeconds());
  if (caps.tier !== "plus" || caps.fileBytes <= MAX_ATTACHMENT_BYTES) {
    throw new HttpError(403, UPLOAD_TIER_ERROR);
  }

  const body = await readJsonCommit(request);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= MAX_ATTACHMENT_BYTES || size > GC_UPLOAD_LANE_MAX_BYTES) {
    throw new HttpError(400, "That file size is not a large upload.");
  }

  // The aggregate verification (one read, the shape in STAGING_VERIFY_SQL's
  // comment): a hole, a short non-final row, or a disputed sum is an
  // unfinished upload — the staging rows stay for a retry, no row is born.
  const spread = await env.GOOBER_DB.prepare(STAGING_VERIFY_SQL).bind(uploadId, uploaderId).first();
  if (!spread || Number(spread.n) < 1) throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
  const count = Number(spread.n);
  const lawful =
    Number(spread.lo) === 0 &&
    Number(spread.hi) === count - 1 &&
    Number(spread.totalSize) === size &&
    (spread.firstShort === null || Number(spread.firstShort) === Number(spread.hi));
  if (!lawful) throw new HttpError(400, UPLOAD_INCOMPLETE_ERROR);

  // The magic re-sniff rides the STORED first chunk (the intake never
  // trusted a client-side claim). The full-file sanitizer stays the SMALL
  // lanes' rider — a lane-max file is re-sniffed, never re-buffered; the
  // bytes landed byte-identical, so egress re-verifies the mime against the
  // stored first bytes exactly as the small lanes do.
  const head = await env.GOOBER_DB.prepare(STAGING_HEAD_SQL).bind(uploadId, uploaderId).first();
  if (!head) throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
  const mime = sniffImageMime(blobToUint8Array(head.data));
  if (!mime) {
    // Not an image: the staging rows stay (nothing wrote yet), the answer is
    // the shared copy.
    throw new HttpError(400, UPLOAD_ONLY_IMAGES_ERROR);
  }

  const now = nowSeconds();
  // ONE atomic batch: the row is born under the folded aggregate arms, the
  // staging set MOVES under it, the staging clears ONLY behind moved chunks.
  // The race the object design carried (a commit tuple read after the write
  // transaction could interleave — the NIT-1 fold-in) died here: the
  // identity tuple resolves inside the batch that moves the bytes, under the
  // one transaction — and a staged set that raced past the verify read
  // (the count/sum arms) writes NOTHING and answers the retry-copy.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(ROW_INSERT_SQL + STAGING_ARMS_SQL)
      .bind(uploaderId, mime, size, now, ...stagingArmsBinds(uploadId, uploaderId, count, size)),
    env.GOOBER_DB.prepare(STAGING_MOVE_SQL)
      .bind(uploaderId, mime, size, now, uploadId, uploaderId,
        ...stagingArmsBinds(uploadId, uploaderId, count, size)),
    env.GOOBER_DB.prepare(STAGING_CLEAR_SQL)
      .bind(uploadId, uploaderId, uploaderId, mime, size, now),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1 || Number(results[1]?.meta?.changes) !== count) {
    // The staged set raced past the verify read: zero rows birthed, the
    // staging rows stay (the clear's own arm held them), the shared copy.
    throw new HttpError(400, UPLOAD_INCOMPLETE_ERROR);
  }
  const row = await env.GOOBER_DB.prepare(
    "SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = ? " +
      "AND mime = ? AND size_bytes = ? AND created_at = ? ORDER BY id DESC LIMIT 1",
  ).bind(uploaderId, mime, size, now).first();
  const attachmentId = Number(row.id);
  return json({ attachment: { id: attachmentId, status: "pending" } }, 201);
}

async function readJsonCommit(request) {
  let value;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "That request body is invalid.");
  }
  return value && typeof value === "object" ? value : {};
}

// The abandon route: delete the uploader's staging rows (a client that gives
// up leaves nothing behind). No staged rows, still a 200 (never an oracle).
// The owner side of the WHERE carries the auth; a malformed id never touches
// the table at all.
export async function handleAbandonUploadRoute(request, env, uploadId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "upload", "uploads-abandon:" + session.user.id);
  if (!UPLOAD_ID_RE.test(String(uploadId || ""))) return json({ ok: true });
  await env.GOOBER_DB.prepare(STAGING_CLEAR_SQL)
    .bind(String(uploadId), Number(session.user.id))
    .run();
  return json({ ok: true });
}

// --- dispatch ------------------------------------------------------------------

export async function handleUploadRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  if (method === "POST" && path === "/api/uploads/chunks") {
    return handleUploadChunkRoute(request, env);
  }

  const commitMatch = method === "POST"
    ? path.match(/^\/api\/uploads\/([A-Za-z0-9_-]{12})\/commit$/)
    : null;
  if (commitMatch) {
    return handleCommitUploadRoute(request, env, commitMatch[1]);
  }

  const abandonMatch = method === "DELETE"
    ? path.match(/^\/api\/uploads\/([A-Za-z0-9_-]{12})$/)
    : null;
  if (abandonMatch) {
    return handleAbandonUploadRoute(request, env, abandonMatch[1]);
  }

  return undefined;
}
