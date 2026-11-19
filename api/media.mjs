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

// Image attachments (Phase 1, Task 6): the multipart intake, the gated
// serving, and the staff review pipeline. The bytes work comes from the
// vendored forum image core (api/core/images.mjs — magic-byte sniffing, the
// structural sanitizer, and egress re-verification), the session gates and
// the rate limiter from api/core, and the storage schema from the Task 2
// media tables (gc_attachments + gc_attachment_chunks).
//
// D1 caps one BLOB/row far under an image's size, and the schema CHECKs
// gc_attachment_chunks.data at 64,000 bytes, so the no-binding intake (local
// dev) is split at ATTACHMENT_CHUNK_BYTES and stored as one INSERT per chunk;
// with the R2 binding the bucket holds each upload whole. Moderation
// precedes visibility everywhere: rows sit at status='pending' until a
// reviewer flips them, and rejection removes the bytes in the same batch as
// the status change. The authorization always rides INSIDE the SQL — the
// approve/reject transitions are guarded WHERE status='pending', and a
// non-pending (or unknown) id is a plain 404 that never confirms existence.
import { readSession, requireStaff, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readLimitedBody } from "./core/http.mjs";
import {
  ATTACHMENT_CHUNK_BYTES,
  GC_ATTACHMENT_OBJECT_PREFIX,
  GC_SOUND_INTAKE_MIMES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_REQUEST_BYTES,
} from "../constants.mjs";
import {
  blobToUint8Array,
  imageResponse,
  sanitizeImage,
  sniffImageMime,
} from "./core/images.mjs";
import { securityHeaders } from "./core/http.mjs";
import { audioResponse } from "./core/audio.mjs";

// Intake refusals, shared by the standalone upload and the send-with-image
// variant (the refusals and their reasons must not drift between the two).
// The refusal copy answers the TIER: the free copy is the computed tier
// literal ("20 MiB or smaller." since the 0025 parity pass); a plus-tier
// upload (the 0013-era raised admission bound, superseded by the tier
// constants) carried the 25/50 wordings of its day.
function tooLargeError(maxFileBytes, labelPlural = "Images") {
  return labelPlural + " must be " + Math.round(maxFileBytes / (1024 * 1024)) + " MiB or smaller.";
}
const TOO_LARGE_ERROR = tooLargeError(MAX_ATTACHMENT_BYTES);
const ONLY_IMAGES_ERROR = "Only JPEG, PNG, WebP, and GIF images can be attached.";
const UNREADABLE_ERROR =
  "That image could not be read. Try re-saving it and uploading again.";

// --- R2 rides (the shared wempos-forum-r2 bucket, binding GC_MEDIA) --------------
//
// With the binding present the bucket is the byte store of record: the
// intake's D1 batch carries the ledger row alone, and the awaited put is the
// ONLY byte leg (the chunk write-through is retired — the backfill receipt
// found gc_attachments and gc_attachment_chunks both at 0 rows, so nothing
// legacy needs serving from D1). The moderation delete is still a
// best-effort ride through ctx.waitUntil. The intake put surfaces its own R2
// errors: a failed put rolls the just-inserted byte-less row back and the
// upload rejects — bytes are durable in R2 or the row never survives. Every
// helper stays a no-op without the binding (local dev keeps the D1-only
// chunk intake and serving byte-identically).

const attachmentObjectKey = (attachmentId) => GC_ATTACHMENT_OBJECT_PREFIX + attachmentId;

// The isolate's execution context (routes receive it last; tests may pass a
// stub). A ctx without waitUntil (or none at all) runs the task inline
// detached — its errors are caught either way, never an unhandled rejection.
function scheduleBackgroundTask(ctx, task) {
  const safe = task.catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(safe);
    return;
  }
  void safe;
}

// The store-of-record put, awaited by each intake before its success return:
// the object lands at gc-attachments/<id> keyed by the row the batch just
// committed. R2 errors propagate — the caller owns the fail-closed rollback
// (the put is the only byte leg, so swallowing would strand byte-less rows).
// Re-exported for the send batch's twin (api/messages.mjs), whose own commit
// ordering decides where the put rides.
export async function putAttachmentObject(env, attachmentId, bytes) {
  if (!env.GC_MEDIA) return;
  await env.GC_MEDIA.put(attachmentObjectKey(attachmentId), bytes);
}

// One R2 delete per doomed id, riding the caller's changes==1 verdict — the
// D1 row lifecycle stays the gate; the bucket follows it, never leads.
export function scheduleAttachmentObjectDelete(env, ctx, attachmentId) {
  if (!env.GC_MEDIA) return;
  scheduleBackgroundTask(ctx, env.GC_MEDIA.delete(attachmentObjectKey(attachmentId)));
}

// --- multipart parsing -----------------------------------------------------------

// Reads a task-6 intake body, always returning the uniform { fields, files }
// shape the routes consume:
// - application/json: a client speaking the wrong protocol — refuse 415 (the
//   send route's JSON variant is handled before this ever runs).
//
// Buffering policy (forum readComposedBody parity): a declared Content-Length
// above the request ceiling is rejected 413 BEFORE any body buffering; with a
// declared length, formData() runs directly on the request stream. Without
// one (chunked transfer), the ceiling cannot be asserted from framing, so
// readLimitedBody's counted buffering caps that branch instead.
const IMAGE_FIELD = "image";

// - multipart/form-data: `imageField` file parts validated per file (the size
//   cap FIRST, so (b) trips before any sniffing), all text parts returned as
//   string fields. The refusal copies take the SUBJECT (default the image
//   lane's words, byte-for-byte) — the soundboard's intake passes its own,
//   including a KB-shaped tooLargeCopy the MiB rounding cannot express.
export async function readMultipartWithImage(request, {
  imageField = IMAGE_FIELD,
  maxFileBytes = MAX_ATTACHMENT_BYTES,
  maxRequestBytes = MAX_ATTACHMENT_REQUEST_BYTES,
  tooLargeCopy = null,
  label = "image",
  labelPlural = "Images",
} = {}) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    throw new HttpError(415, "Send this upload as multipart/form-data.");
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  const requestError = tooLargeCopy ?? tooLargeError(maxFileBytes, labelPlural);
  if (declaredLength > maxRequestBytes) {
    throw new HttpError(413, requestError);
  }

  let form;
  if (declaredLength > 0) {
    // The common, framing-backed path: parse straight off the request stream.
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "The upload could not be read.");
    }
  } else {
    try {
      const bufferedBody = await readLimitedBody(request, maxRequestBytes);
      form = await new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: bufferedBody,
      }).formData();
    } catch {
      throw new HttpError(400, "The upload could not be read.");
    }
  }

  const fields = {};
  const files = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      fields[name] = value;
      continue;
    }
    if (name !== imageField) {
      throw new HttpError(400, "Attach the " + label + " in the '" + imageField + "' field.");
    }
    if (value.size > maxFileBytes) {
      throw new HttpError(413, requestError);
    }
    files.push(new Uint8Array(await value.arrayBuffer()));
  }
  return { fields, files };
}

// --- intake ----------------------------------------------------------------------

// The JS side of the schema's two guards, run before anything is written:
// 1 byte..MAX_ATTACHMENT_BYTES (the size_bytes CHECK — the 0022 rebuild's
// 1 GiB floor; the JS intake refuses one byte more FIRST, test (b)), then
// the magic-byte sniff against the four allowed types, then the vendored
// structural sanitizer (drops metadata segments / trailing payloads and
// requires a well-formed file). Returns { mime, bytes } with the CLEAN bytes
// — size_bytes later stores the sanitized length, so the CHECK holds for any
// file, however much the sanitizer removed.
export function prepareAttachmentBytes(fileBytes, maxFileBytes = MAX_ATTACHMENT_BYTES) {
  if (!(fileBytes instanceof Uint8Array) || fileBytes.length < 1) {
    throw new HttpError(400, UNREADABLE_ERROR);
  }
  if (fileBytes.length > maxFileBytes) {
    throw new HttpError(413, tooLargeError(maxFileBytes));
  }
  const mime = sniffImageMime(fileBytes);
  if (!mime) throw new HttpError(400, ONLY_IMAGES_ERROR);
  const sanitized = sanitizeImage(fileBytes);
  if (!sanitized) throw new HttpError(400, UNREADABLE_ERROR);
  return { mime, bytes: sanitized.bytes };
}

// --- intake SQL ------------------------------------------------------------------
//
// The attachment INSERTs resolve their ids INSIDE their own batch, so no
// statement depends on a returned rowid: the metadata row inserts first and
// every chunk INSERT resolves its attachment_id with a scalar subselect over
// the identity the first statement just wrote (uploader + mime + size +
// second, message_id NULL for a standalone upload). Statements run under one
// transaction, so no concurrent write can race the resolution.

const ATTACHMENT_INSERT_SQL =
  "INSERT INTO gc_attachments (message_id, uploader_id, mime, size_bytes, status, width, height, created_at) " +
    "VALUES (NULL, ?, ?, ?, 'pending', NULL, NULL, ?)";

// Dimensions ride the vendored sniffing where it parses them; it does not
// parse any, so both stay NULL for now rather than half-relying on client
// declarations.
const STANDALONE_CHUNK_KEY_SQL =
  "(SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = ? " +
    "AND mime = ? AND size_bytes = ? AND created_at = ? ORDER BY id DESC LIMIT 1)";

const STANDALONE_CHUNK_INSERT_SQL =
  "INSERT INTO gc_attachment_chunks (attachment_id, seq, data) " +
    "SELECT " + STANDALONE_CHUNK_KEY_SQL + ", ?, ?";

export function standaloneAttachmentStatements(env, uploaderId, prepared, now) {
  const size = prepared.bytes.length;
  const statements = [
    env.GOOBER_DB.prepare(ATTACHMENT_INSERT_SQL)
      .bind(uploaderId, prepared.mime, size, now),
  ];
  for (let seq = 0, offset = 0; offset < size; seq += 1, offset += ATTACHMENT_CHUNK_BYTES) {
    statements.push(
      env.GOOBER_DB.prepare(STANDALONE_CHUNK_INSERT_SQL)
        .bind(uploaderId, prepared.mime, size, now, seq, prepared.bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES)),
    );
  }
  return statements;
}

// The standalone upload: one batch, { attachment } result. No idempotency key
// exists here — a double-POST makes two pending rows, each reviewed on its
// own (the queue shows the uploader/size/creation second either way).
const attachmentResult = (id, prepared) => ({
  id,
  status: "pending",
  mime: prepared.mime,
  sizeBytes: prepared.bytes.length,
  width: null,
  height: null,
});

// The 503 copy for the store-of-record put's failure — the upload is
// rejected, the intake asks for a retry, and the copy names the server, not
// the image.
const STORE_FAILED_ERROR =
  "The upload could not be stored right now. Please try again.";

// The fail-closed rollback: only the row the R2-flow batch just wrote (still
// pending, standalone) is swept, so the compensating delete never reaches a
// concurrent reviewer's approval.
const STANDALONE_ROW_DELETE_SQL =
  "DELETE FROM gc_attachments WHERE id = ? AND status = 'pending'";

// The shared standalone intake, after each caller's prepare (the image lane
// and the soundboard's audio lane — the sound IS a gc_attachments row on the
// same machinery): one batch — with GC_MEDIA the ledger row ALONE (no chunk
// write-through; the object key needs the row id, so the put follows the
// commit but precedes the success return), without it the legacy D1 chunk
// intake byte-identically — then the id resolution and, under the binding,
// the AWAITED store-of-record put. A failed put rolls the just-inserted
// byte-less row back and rejects 503: bytes are durable in R2 or no row
// survives (a crash between the two leaves a pending row the empty chunk set
// 404s, and a reviewer's reject removes). The rollback's object delete is the
// same best-effort ride as every other byte-death path — a put that threw
// almost certainly left nothing behind, so it sweeps only the rare
// timeout-after-write object.
// Returns the inserted row's id; each caller keeps its own wire shape.
export async function insertStandaloneAttachment(env, uploaderId, prepared, now, failedInsertErrorCopy) {
  if (env.GC_MEDIA) {
    const results = await env.GOOBER_DB.batch([
      env.GOOBER_DB.prepare(ATTACHMENT_INSERT_SQL)
        .bind(uploaderId, prepared.mime, prepared.bytes.length, now),
    ]);
    const id = Number(results[0]?.meta?.last_row_id);
    if (!Number.isInteger(id) || id < 1) {
      throw new HttpError(500, failedInsertErrorCopy);
    }
    try {
      await putAttachmentObject(env, id, prepared.bytes);
    } catch {
      // Best-effort sweep: a D1 failure in the delete itself must never mask
      // the 503 (worst case is the pending byte-less row the serving path
      // already 404s and the reviewer queue can remove). The row's death
      // rides the same object-delete as every other byte-death path in this
      // module — a put that threw almost certainly left nothing behind, so
      // the common case is a no-op sweep (the rare timeout-after-write
      // object must never orphan).
      try {
        await env.GOOBER_DB.prepare(STANDALONE_ROW_DELETE_SQL).bind(id).run();
      } catch {
        // the 503 below is the contract; the row removal rides best-effort
      }
      scheduleAttachmentObjectDelete(env, undefined, id);
      throw new HttpError(503, STORE_FAILED_ERROR);
    }
    return id;
  }
  // Without the binding (local dev): byte-identical intake of the D1 chunk
  // era — the chunk write-through rides as the legacy byte store.
  const results = await env.GOOBER_DB.batch(
    standaloneAttachmentStatements(env, uploaderId, prepared, now),
  );
  const id = Number(results[0]?.meta?.last_row_id);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpError(500, failedInsertErrorCopy);
  }
  return id;
}

export async function createAttachment(env, uploaderId, fileBytes) {
  const prepared = prepareAttachmentBytes(fileBytes);
  const id = await insertStandaloneAttachment(
    env,
    uploaderId,
    prepared,
    nowSeconds(),
    "That image could not be stored. Please try again.",
  );
  return attachmentResult(id, prepared);
}

// --- send-with-image SQL ---------------------------------------------------------
//
// These statements are appended to sendMessageToChannel's batch AFTER the
// message INSERT (their message_id resolves by the exact idempotency triple,
// so a replayed send links to the SAME message — and the NOT EXISTS guards
// mean the replay adds no second attachment or chunk). `client_message_id IS
// ?` matches both NULL and an id, mirroring the message reselect's read, and
// `ORDER BY id DESC` makes a NULL-cid triple resolve the NEWEST matching row —
// the one the batch just inserted, never an older cid-less send below it.
const TRIPLE_SQL =
  "(SELECT id FROM gc_messages WHERE channel_id = ? AND author_id = ? " +
    "AND client_message_id IS ? ORDER BY id DESC LIMIT 1)";

const ATTACHED_ATTACHMENT_INSERT_SQL =
  "INSERT INTO gc_attachments (message_id, uploader_id, mime, size_bytes, status, width, height, created_at) " +
    "SELECT " + TRIPLE_SQL + ", ?, ?, ?, 'pending', NULL, NULL, ? " +
    "WHERE NOT EXISTS (SELECT 1 FROM gc_attachments WHERE message_id = " + TRIPLE_SQL + ")";

const ATTACHED_CHUNK_KEY_SQL =
  "(SELECT id FROM gc_attachments WHERE message_id = " + TRIPLE_SQL + " " +
    "ORDER BY id DESC LIMIT 1)";

const ATTACHED_CHUNK_INSERT_SQL =
  "INSERT INTO gc_attachment_chunks (attachment_id, seq, data) " +
    "SELECT " + ATTACHED_CHUNK_KEY_SQL + ", ?, ? " +
    "WHERE NOT EXISTS (SELECT 1 FROM gc_attachment_chunks WHERE attachment_id = " +
      ATTACHED_CHUNK_KEY_SQL + " AND seq = ?)";

export function messageAttachmentStatements(env, uploaderId, channelId, clientMessageId, prepared, now) {
  const size = prepared.bytes.length;
  const triple = [channelId, uploaderId, clientMessageId];
  if (env.GC_MEDIA) {
    // The R2 store of record (backfill receipt: 0/0 rows): the send batch
    // carries the attachment row ALONE — no chunk write-through. The put
    // itself rides the caller (the send batch's commit ordering is the
    // message's, and the rollback differs from the standalone intake's: the
    // committed message STAYS, the byte-less attachment row is what the
    // sweep statement below removes — the send then rejects, never a
    // delivered send with an R2-failed attachment).
    return [
      env.GOOBER_DB.prepare(ATTACHED_ATTACHMENT_INSERT_SQL)
        .bind(...triple, uploaderId, prepared.mime, size, now, ...triple),
    ];
  }
  const statements = [
    env.GOOBER_DB.prepare(ATTACHED_ATTACHMENT_INSERT_SQL)
      .bind(...triple, uploaderId, prepared.mime, size, now, ...triple),
  ];
  for (let seq = 0, offset = 0; offset < size; seq += 1, offset += ATTACHMENT_CHUNK_BYTES) {
    statements.push(
      env.GOOBER_DB.prepare(ATTACHED_CHUNK_INSERT_SQL)
        .bind(
          ...triple, seq, prepared.bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES),
          ...triple, seq,
        ),
    );
  }
  return statements;
}

// The send twin's own fail-closed law (api/messages.mjs): the send batch is
// one D1 execute, so the message row is already committed when the put
// settles — the compensating path is the ATTACHMENT's, and this is its sweep
// (every still-pending attachment row the send batch just wrote for the
// committed message; the byte-less rows the R2 put was meant to fill).
export function messageAttachmentSweepStatement(env, messageId) {
  return env.GOOBER_DB.prepare(
    "DELETE FROM gc_attachments WHERE message_id = ? AND status = 'pending'",
  ).bind(messageId);
}

// The send twin's 503 copy (the standalone intake's STORE_FAILED_ERROR,
// re-worded for a message send): the send did NOT deliver — a retry re-rides
// the whole batch, re-inserts the attachment row (the batch's NOT EXISTS
// guard answers the swept row honestly) and re-puts.
export const SEND_ATTACHMENT_STORE_FAILED_ERROR =
  "The attachment could not be stored right now. Please send the message again.";

// --- serving ---------------------------------------------------------------------

// Concatenates an attachment's chunk set in seq order, or returns null when
// the set is empty (callers turn that into the shared 404 — a rejected row
// whose bytes were removed must never serve, fail-safe either way).
async function assembledChunkBytes(env, attachmentId) {
  const result = await env.GOOBER_DB.prepare(
    "SELECT data FROM gc_attachment_chunks WHERE attachment_id = ? ORDER BY seq",
  ).bind(attachmentId).all();
  const chunks = (result.results || []).map((row) => blobToUint8Array(row.data));
  if (chunks.length === 0) return null;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// The LARGE lane's serving shape (the D1-only uploads redesign): a row born
// above the small lanes' single-buffer cap streams paged — SERVING_PAGE_ROWS
// chunk rows per query (64 × 64,000 = 4,096,000 bytes), piped through one
// TransformStream writer, so the 128 MB isolate never holds more than one
// page and a lane-bound file (~125 MiB) needs 32 reads — headroom under the
// free plan's 50-queries-per-invocation row both this comment and
// constants.mjs cite. The page size is spelled as the literal 64 in the SQL
// to stay one constant's truth (SERVING_PAGE_ROWS here).
const SERVING_PAGE_ROWS = 64;

// Returns the streaming Response, or null for a chunk set that is not a
// lawful serving set (callers turn that into the shared 404). Large rows are
// lane-born IMAGES only — the soundboard's audio caps at 512 KiB and never
// exceeds the small cap — so the egress re-verification rides the image
// sniff against the stored first bytes, exactly as the assembled path does.
async function streamChunkedAttachment(env, row) {
  const attachmentId = Number(row.id);
  const page = await env.GOOBER_DB.prepare(
    "SELECT seq, data FROM gc_attachment_chunks WHERE attachment_id = ? AND seq >= ? " +
      "ORDER BY seq LIMIT " + SERVING_PAGE_ROWS,
  ).bind(attachmentId, 0).all();
  const headRows = page.results || [];
  if (headRows.length === 0 || Number(headRows[0].seq) !== 0) return null;
  const head = blobToUint8Array(headRows[0].data);
  if (sniffImageMime(head) !== row.mime) return null;

  const { readable, writable } = new TransformStream();
  const pump = (async () => {
    const writer = writable.getWriter();
    try {
      let cursor = 0;
      let rows = headRows;
      for (;;) {
        for (const entry of rows) {
          await writer.write(blobToUint8Array(entry.data));
        }
        cursor = Number(rows[rows.length - 1].seq) + 1;
        if (rows.length < SERVING_PAGE_ROWS) {
          await writer.close();
          return;
        }
        // The next page never re-serves a row before the cursor (seq >= ?),
        // and a lawful set ends within one page of the cursor either way.
        const nextPage = await env.GOOBER_DB.prepare(
          "SELECT seq, data FROM gc_attachment_chunks WHERE attachment_id = ? AND seq >= ? " +
            "ORDER BY seq LIMIT " + SERVING_PAGE_ROWS,
        ).bind(attachmentId, cursor).all();
        rows = nextPage.results || [];
        if (rows.length === 0) {
          await writer.close();
          return;
        }
      }
    } catch {
      // A truncated stream answers the client's own abort.
      await writer.abort().catch(() => {});
    }
  })();
  void pump;

  const approved = row.status === "approved";
  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": approved ? "public, max-age=31536000, immutable" : "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// The assembled path's egress verdict, shared by the D1 chunk set and the R2
// mirror: imageResponse re-verifies the mime against the bytes and fails safe
// as null — a mismatched or empty set is the shared 404, never a best-guess.
// The soundboard's audio rows ride the SAME path with their own egress
// verifier (the image sniff cannot read audio magic; audioResponse fails
// safe identically). An image-mime claim answered by the image verifier
// first, an audio-mime claim by the audio one: each row's bytes must carry
// their own row's mime, both verifiers answering null otherwise. The W-B0
// tighten (NIT-6): the serving audio family narrows to the intake's admitted
// pair (GC_SOUND_INTAKE_MIMES — one source for both sides). No legacy
// WAV/FLAC rows exist (remote queried 2026-11-17, zero audio rows of any
// kind), so a stale exotic claim is the shared 404 — never a sniff-blessed
// stranger to the intake.
function attachmentEgressResponse(bytes, mime, cache) {
  const admittedAudio = GC_SOUND_INTAKE_MIMES.includes(String(mime || ""));
  return imageResponse(bytes, mime, cache) ??
    (admittedAudio ? audioResponse(bytes, mime, cache) : null);
}

// R2-first serving: when the binding exists, an object at
// gc-attachments/<id> answers the row's own egress verifier with its own
// cache verdict — approved rows stay publicly immutable, pending rows stay
// private. A miss (or a bucket error, or a body the verifier cannot bless)
// answers null and the route falls back to the D1 chunk set — the mirror is
// an optimization, never a serving gate.
// The >MAX streaming lane's egress re-verification (GO-HAYWIRE cycle-3): the
// serving lane trusts the row's stored mime end-to-end, so the object body's
// FIRST bytes now run the same image sniff every egress verifier runs —
// BEFORE anything streams. A sniff that disagrees with the stored
// classification refuses 502 fail-closed (one server-side error surfaced,
// zero bytes served); a passing object streams byte-for-byte as before. The
// head window is the sniff's longest prefix need (12 magic bytes).
const SNIFF_WINDOW_BYTES = 12;

const LANE_STREAM_FAILED_ERROR =
  "The attachment could not be verified for serving. Please try again.";

async function verifiedImageStreamResponse(object, mime, cache) {
  const headers = securityHeaders();
  headers.set("Content-Type", mime);
  headers.set("Cache-Control", cache);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", 'inline; filename="image"');
  if (object.size) headers.set("Content-Length", String(object.size));

  // The verification head: a ReadableStream under the binding; a whole-buffer
  // body (tests, mirrors) walks through its own stream. The head read pulls
  // chunks until the sniff window is met, then the SAME reader pumps the
  // rest verbatim — the head chunk re-emits first, so the served bytes stay
  // byte-for-byte the unverified lane's.
  const source =
    object.body && typeof object.body.getReader === "function"
      ? object.body
      : new Response(object.body).body;
  if (!source || typeof source.getReader !== "function") return null;
  const reader = source.getReader();
  let head = new Uint8Array(0);
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const merged = new Uint8Array(head.length + next.value.byteLength);
    merged.set(head);
    merged.set(next.value, head.length);
    head = merged;
    if (head.length >= SNIFF_WINDOW_BYTES) break;
  }

  const sniffed = sniffImageMime(head);
  if (sniffed !== String(mime)) {
    console.error(
      "Attachment serving refused: the object's head does not match its stored image classification.",
    );
    throw new HttpError(502, LANE_STREAM_FAILED_ERROR);
  }

  const stream = new ReadableStream({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, { status: 200, headers });
}

async function serveAttachmentObject(env, row) {
  if (!env.GC_MEDIA) return null;
  let object = null;
  try {
    object = await env.GC_MEDIA.get(attachmentObjectKey(row.id));
  } catch {
    return null;
  }
  // The >LANE streaming law: a >MAX row's bytes never whole-buffer on the
  // serving path — buffering a 125 MiB lane-max object would push the
  // isolate at its 128 MB floor (the reviewer's MEDIUM against the
  // whole-buffer consult). The intake side verified the EXACT bytes these
  // objects hold, but the lane trusted the stored mime end-to-end — the
  // GO-HAYWIRE cycle-3 fix closes that: the stream's head bytes are
  // sniffed against the stored image/* classification before anything
  // streams (verifiedImageStreamResponse refuses 502 on a mismatch,
  // fail-closed). >MAX rows are image rows (multipart file intake admits
  // images; sound/sound-pack caps sit far under MAX), so the streaming
  // headers mirror imageResponse's shape.
  if (!object) return null;
  if (Number(row.size_bytes) > MAX_ATTACHMENT_BYTES) {
    if (!object.body) return null;
    const cache = row.status === "approved" ? "public, max-age=31536000, immutable" : "private, max-age=300";
    return verifiedImageStreamResponse(object, row.mime, cache);
  }
  if (typeof object.arrayBuffer !== "function") return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length === 0) return null;
  const cache = row.status === "approved" ? "public, max-age=31536000, immutable" : "private, max-age=300";
  return attachmentEgressResponse(bytes, row.mime, cache);
}

async function handleAttachmentServingRoute(request, env, attachmentId) {
  // The read-bucket wall, mirroring every other read route (quests.mjs's
  // shape): the serving GET is the one anonymous-readable endpoint and had
  // none — rate-limit is not auth (Discord-like anonymous parity stays: the
  // gates below are unchanged), keyed per attachment id.
  await rateLimit(request, env, "read", "attachments:" + attachmentId);
  const row = await env.GOOBER_DB.prepare(
    "SELECT id, uploader_id, status, mime, size_bytes FROM gc_attachments WHERE id = ? LIMIT 1",
  ).bind(attachmentId).first();
  if (!row) throw new HttpError(404, "Attachment not found.");

  // Approved rows serve to anyone (immutable public caching). Pending and
  // rejected rows: the uploader or platform staff — else the same 404, never
  // a 403 that would confirm existence. (Session roles are already the PUBLIC
  // vocabulary here: readSession maps the stored PRE-3.1 values.)
  if (row.status !== "approved") {
    const session = await readSession(request, env);
    const viewer = session && session.user;
    const isStaff = Boolean(viewer) && (viewer.role === "owner" || viewer.role === "admin");
    if (!viewer || (Number(row.uploader_id) !== Number(viewer.id) && !isStaff)) {
      throw new HttpError(404, "Attachment not found.");
    }
  }

  // The R2 store of record is consulted FIRST, for every row size: the
  // plus-tier multipart intakes put bytes ONLY in R2 (zero chunk rows), so
  // routing a >MAX size row to the D1 chunk paging before the consult
  // answered the empty set with an eternal 404. A hit serves with the row's
  // own cache verdict; a miss falls through to the lanes below — the LARGE
  // lane's paged stream (its legacy/D1 chunk rows) and the small lanes'
  // assembled chunk fallback — exactly where they served before (the
  // no-binding dev lane keeps byte-identical serving).
  const mirrored = await serveAttachmentObject(env, row);
  if (mirrored) return mirrored;
  if (Number(row.size_bytes) > MAX_ATTACHMENT_BYTES) {
    const streamed = await streamChunkedAttachment(env, row);
    if (!streamed) throw new HttpError(404, "Attachment not found.");
    return streamed;
  }
  const bytes = await assembledChunkBytes(env, row.id);
  if (bytes !== null) {
    const cache = row.status === "approved" ? "public, max-age=31536000, immutable" : "private, max-age=300";
    const response = attachmentEgressResponse(bytes, row.mime, cache);
    if (!response) throw new HttpError(404, "Attachment not found.");
    return response;
  }
  // The chunk set is empty: no bytes exist under the row anywhere — the D1
  // commit births the row AND moves the set in one batch, so an empty set on
  // a lawful row is exactly the old 404, never a best-guess.
  throw new HttpError(404, "Attachment not found.");
}

async function handleUploadAttachmentRoute(request, env, ctx) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "upload", "user:" + session.user.id);
  const files = (await readMultipartWithImage(request)).files;
  if (files.length !== 1) throw new HttpError(400, "Attach exactly one image.");

  const attachment = await createAttachment(env, Number(session.user.id), files[0]);
  return json({ attachment: { id: attachment.id, status: attachment.status } }, 201);
}

// Staff review desk ----------------------------------------------------------------

async function handlePendingQueueRoute(request, env) {
  await requireStaff(request, env, false);
  // The oldest-first queue, bounded like the forum's desk; users.username
  // comes through the JOIN, so the queue never leaks beyond names + metadata.
  const result = await env.GOOBER_DB.prepare(
    "SELECT a.id, a.mime, a.size_bytes, a.created_at, u.username AS uploader_name " +
      "FROM gc_attachments a JOIN users u ON u.id = a.uploader_id " +
      "WHERE a.status = 'pending' ORDER BY a.created_at ASC LIMIT 100",
  ).bind().all();
  return json({
    attachments: (result.results || []).map((row) => ({
      id: Number(row.id),
      uploaderName: row.uploader_name,
      sizeBytes: Number(row.size_bytes),
      mime: row.mime,
      createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
    })),
  });
}

async function handleAttachmentModerationRoute(request, env, attachmentId, action, ctx) {
  const session = await requireStaff(request, env);
  const reviewerId = Number(session.user.id);
  const now = nowSeconds();

  if (action === "approve") {
    // ONE guarded statement: reviewed_by/At ride the guard, so a row that is
    // not pending (unknown, already reviewed) can never be re-labeled.
    const result = await env.GOOBER_DB.prepare(
      "UPDATE gc_attachments SET status = 'approved', reviewed_by = ?, reviewed_at = ? " +
        "WHERE id = ? AND status = 'pending'",
    ).bind(reviewerId, now, attachmentId).run();
    if (Number(result.meta?.changes) !== 1) throw new HttpError(404, "Attachment not found.");
    return json({ approved: true, id: attachmentId });
  }

  // Reject: the bytes die WITH the status flip, in one batch. Both statements
  // guard on the same pending state, so a concurrent approval can never leave
  // an approved attachment whose chunks were already deleted.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachment_chunks WHERE attachment_id IN " +
        "(SELECT id FROM gc_attachments WHERE id = ? AND status = 'pending')",
    ).bind(attachmentId),
    env.GOOBER_DB.prepare(
      "UPDATE gc_attachments SET status = 'rejected', reviewed_by = ?, reviewed_at = ? " +
        "WHERE id = ? AND status = 'pending'",
    ).bind(reviewerId, now, attachmentId),
  ]);
  if (Number(results[1]?.meta?.changes) !== 1) {
    throw new HttpError(404, "Attachment not found.");
  }
  // The bucket follows the D1 verdict: exactly one doomed id's object dies
  // with it, best-effort, after the batch committed.
  scheduleAttachmentObjectDelete(env, ctx, attachmentId);
  return json({ rejected: true, id: attachmentId });
}

export async function handleMediaRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) completes the dispatch loop's
  // handler signature; these routes schedule background work only through
  // it (the R2 moderation delete ride — the intake put is awaited inline).
  // Callers without a ctx (tests, callers that never schedule) run the ride
  // inline-detached, error-caught.
  void url;

  if (method === "POST" && path === "/api/attachments") {
    return handleUploadAttachmentRoute(request, env, ctx);
  }

  const servingMatch = (method === "GET")
    ? path.match(/^\/api\/attachments\/([1-9][0-9]{0,14})$/)
    : null;
  if (servingMatch) {
    return handleAttachmentServingRoute(request, env, Number(servingMatch[1]));
  }

  if (method === "GET" && path === "/api/admin/attachments") {
    return handlePendingQueueRoute(request, env);
  }

  const moderationMatch = method === "POST"
    ? path.match(/^\/api\/admin\/attachments\/([1-9][0-9]{0,14})\/(approve|reject)$/)
    : null;
  if (moderationMatch) {
    return handleAttachmentModerationRoute(
      request, env, Number(moderationMatch[1]), moderationMatch[2], ctx,
    );
  }

  return undefined;
}
