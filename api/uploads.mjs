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

// The LARGE-FILE upload lane — the byte leg rides GC_MEDIA (R2 revival
// order, owner 2026-11-18: ALL D1 blob/byte storage to the shared bucket;
// newer by date than the lane's 2026-11-17 "no park, and no r2" ruling).
// Each part request puts its ≤-part-sized body at
// gc-lane-staging/<uploadId>/<seq> in the bucket (the awaited put is the
// only byte leg: a failed put is a failed part — the shared store-failure
// family, nothing staged) while the gc_upload_parts staging row keeps its
// relational arms (upload_id, uploader_id, seq, created_at; the 0025 data
// column is NOT NULL, so the row write carries a 1-byte marker — never a
// payload byte; a later migration may drop the column). D1 rows stay the
// lifecycle gate; the bucket follows them, never leads (media.mjs:108 law).
//
// The gc_attachments row is born at COMMIT with the sniffed mime — sniffed
// from the bucket's first staged part, never a placeholder the mime CHECK
// cannot hold — and never a byte moves back into D1: the commit assembles
// the store-of-record object at the media module's gc-attachments/<id> key,
// streaming the staged part objects seq-by-seq (the isolate never holds
// more than one part). The commit's gate: the staging rows' RELATIONAL
// arms (contiguous 0..n-1 part seqs, the count equal to the declared
// size's part grid) plus the ASSEMBLY's streamed sum, which must equal the
// declared size exactly. A failed verification leaves the staging rows AND
// objects AS-IS — the client can retry the missing parts or abandon. A
// failed assembly rolls the just-born pending row back (the media intake's
// fail-closed shape) and keeps the staging for a retry. Status rides
// 'pending' exactly like every other intake (the serving gate answers
// before any bytes move; the >MAX rows stream from R2, media.mjs).
import { requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readLimitedBody } from "./core/http.mjs";
import { attachmentObjectKey, STORE_FAILED_ERROR } from "./media.mjs";
import { sniffImageMime } from "./core/images.mjs";
import { attachmentCapBytes } from "./plus.mjs";
import {
  GC_PLUS_ATTACHMENT_BYTES,
  GC_UPLOAD_PART_BYTES,
  GC_UPLOAD_PART_REQUEST_BYTES,
  GC_UPLOAD_PARTS_MAX,
  GC_UPLOAD_STAGED_CAP,
  GC_UPLOAD_STAGING_TTL_SECONDS,
  MAX_ATTACHMENT_BYTES,
} from "../constants.mjs";

export const UPLOAD_TIER_ERROR = "Large-file uploads are a full Goober+ perk.";
export const UPLOAD_PART_INVALID_ERROR = "That upload part is invalid.";
export const UPLOAD_UNKNOWN_ERROR = "That upload does not exist.";
export const UPLOAD_INCOMPLETE_ERROR = "The upload did not finish — send it again.";
export const UPLOAD_ONLY_IMAGES_ERROR = "Only image files are accepted.";
export const UPLOAD_CLIP_LOCKED_ERROR =
  "Those bytes belong to a sound-pack clip — drop the clip to release them.";
export const UPLOAD_STAGED_CAP_ERROR =
  "You already have " + GC_UPLOAD_STAGED_CAP + " uploads staged.";

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

// The lane staging key family: one object per part, keyed by the client-held
// upload id and the part's seq. Attachment keys (gc-attachments/<id>) belong
// to the media module — a staging key never collides with them.
const LANE_STAGING_PREFIX = "gc-lane-staging/";
const laneStagingKey = (uploadId, seq) => LANE_STAGING_PREFIX + uploadId + "/" + seq;

// The staged row's byte-column marker: the payload rides the bucket; the row
// keeps its relational arms and the 0025 schema's NOT NULL column (no DDL
// this wave) carries this 1-byte marker — never a payload byte.
const STAGING_ROW_MARKER = new Uint8Array(1);

// One staged row per part: the row is the relational lifecycle gate (the
// commit's count/contiguity arms, the staged cap, the abandon/sweep arms);
// its data binds the marker.
function partStatement(env, uploadId, uploaderId, seq, now) {
  return env.GOOBER_DB.prepare(
    "INSERT OR REPLACE INTO gc_upload_parts (upload_id, uploader_id, seq, data, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(uploadId, uploaderId, seq, STAGING_ROW_MARKER, now);
}

// The commit's one-read verification: contiguous 0..n-1 PART seqs (MIN 0 and
// MAX + 1 = COUNT). The size arm rides the ASSEMBLY's streamed sum (the
// bucket's own evidence); the count must equal the declared size's part grid.
const STAGING_VERIFY_SQL =
  "SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi " +
    "FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";

// The PER-UPLOADER STAGED CAP's read (GO-HAYWIRE cycle-3): the uploader's
// DISTINCT staging tokens, EXCLUDING tokens an approved gc_sound_pack_sounds
// clip points at (the pack's own bytes are not a pending staging). The read
// rides the first-part path only, right before the fresh uploadId is minted.
const STAGED_ACTIVE_SQL =
  "SELECT COUNT(DISTINCT upload_id) AS active FROM gc_upload_parts " +
  "WHERE uploader_id = ? AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds s " +
  "WHERE s.upload_id = gc_upload_parts.upload_id AND s.status = 'approved')";

// The identity tuple, the e0ba49c shape media.mjs's standalone INSERT rides
// (no last_insert_rowid dependence): the row is born under the count arm and
// the read resolves it the same way.
export const IDENTITY_TUPLE_SQL =
  "(SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = ? " +
    "AND mime = ? AND size_bytes = ? AND created_at = ? ORDER BY id DESC LIMIT 1)";

export const ROW_INSERT_SQL =
  "INSERT INTO gc_attachments (message_id, uploader_id, mime, size_bytes, status, width, height, created_at) " +
    // The row is born ONLY when the staged set still matches the verified
    // aggregate (the count re-check below): a set that moved between the
    // verify read and this batch births nothing — the staging rows stay for
    // a retry, and the route's classification answers the shared copy.
    // Eight expressions for eight columns: size_bytes keeps its own `?` (the
    // identity tuple's third bind) and created_at takes the last one — a
    // 7-for-8 shape throws "7 values for 8 columns" on every commit.
    "SELECT NULL, ?, ?, ?, 'pending', NULL, NULL, ? WHERE ";

// The staged set's own count arm, folded into the row insert (the rider's
// verify→commit gap): the arm rides inside the batch's transaction, so a
// part set that grew or shrank after the verify read births nothing. (The
// old sum arm — SUM(length(data)) — retired with the byte column: the rows'
// data binds the marker; the size arm rides the assembled object.)
export const STAGING_ARMS_SQL =
  "(SELECT COUNT(*) FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?) = ?";

// The arm's binds: the count pair + expected part count.
function stagingArmsBinds(uploadId, uploaderId, count) {
  return [uploadId, uploaderId, count];
}

// The clear rides AFTER the store-of-record put settled (not in a batch with
// the row birth): the staged rows — and their objects — are the retry's
// whole point, so they leave only once the bytes are durable elsewhere.
export const STAGING_CLEAR_SQL = "DELETE FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";

// The commit's stream assembly: the staged part objects pipe seq-by-seq into
// the store-of-record object (gc-attachments/<id>, the media module's key)
// — the isolate never holds more than one part. The streamed sum IS the
// size arm: a set whose parts re-sum to a different total refuses, and the
// route rolls the row back (bytes durable or no row survives).
async function assembleLaneAttachment(env, uploadId, attachmentId, size, count) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const settled = env.GC_MEDIA.put(attachmentObjectKey(attachmentId), readable)
    .catch((error) => {
      writer.abort().catch(() => {});
      throw error;
    });
  let total = 0;
  const fail = async (error) => {
    await writer.abort().catch(() => {});
    await settled.catch(() => {});
    throw error;
  };
  for (let seq = 0; seq < count; seq += 1) {
    let part;
    try {
      part = await env.GC_MEDIA.get(laneStagingKey(uploadId, seq));
    } catch (error) {
      await fail(error);
    }
    if (!part || typeof (part.body && part.body.getReader) !== "function") {
      await fail(new Error("staged part object missing"));
    }
    const reader = part.body.getReader();
    for (;;) {
      let next;
      try {
        next = await reader.read();
      } catch (error) {
        reader.cancel().catch(() => {});
        await fail(error);
      }
      if (next.done) break;
      total += next.value.byteLength;
      await writer.write(next.value);
    }
  }
  if (total !== size) {
    await fail(new Error("assembled sum disputes the declared size"));
  }
  await writer.close();
  await settled;
}

// The magic re-sniff's head window (the sniff's longest prefix need).
const LANE_SNIFF_WINDOW_BYTES = 12;
async function laneHeadSniff(body) {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const merged = new Uint8Array(head.length + next.value.byteLength);
    merged.set(head);
    merged.set(next.value, head.length);
    head = merged;
    if (head.length >= LANE_SNIFF_WINDOW_BYTES) break;
  }
  reader.cancel().catch(() => {});
  return head;
}

// --- routes -----------------------------------------------------------------------

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{12}$/;

export async function handleUploadChunkRoute(request, env) {
  const session = await requireUser(request, env);
  // The READ bucket carries the per-part flow: the UPLOAD limiter's own shape
  // is per-FILE, and a tier-ceiling file is 1049 parts.
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
  // The staged PUT is the byte leg: awaited, fail-closed — a failed put is a
  // failed part (the store-failure family answers, nothing is D1-staged).
  const stagePart = async (uploadId, seq) => {
    const key = laneStagingKey(uploadId, seq);
    try {
      await env.GC_MEDIA.put(key, chunk);
    } catch {
      throw new HttpError(503, STORE_FAILED_ERROR);
    }
    // OR REPLACE: a retried part re-lands its slice honestly (the commit
    // re-verifies the whole set either way). A refused row sweep never
    // orphans the object (bucket follows, never leads).
    try {
      await env.GOOBER_DB.batch([partStatement(env, uploadId, uploaderId, seq, now)]);
    } catch (error) {
      await env.GC_MEDIA.delete(key).catch(() => {});
      throw error;
    }
  };
  if (seq > 0) {
    const uploadId = typeof fields.uploadId === "string" ? fields.uploadId : "";
    if (!UPLOAD_ID_RE.test(uploadId)) throw new HttpError(400, UPLOAD_PART_INVALID_ERROR);
    // The ownership marker lives in the staging table: a continuation
    // answers an upload whose FIRST part the SAME member already wrote — a
    // foreign or finished id is the shared 404, never a 403 that would
    // confirm existence.
    const marker = await env.GOOBER_DB.prepare(
      "SELECT 1 FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0",
    ).bind(uploadId, uploaderId).first();
    if (!marker) throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
    // The bucket is the lane's only byte leg (the R2 revival order — the D1
    // staging carries markers, never bytes): without the binding the
    // continuation cannot stage anything.
    if (!env.GC_MEDIA) throw new HttpError(503, STORE_FAILED_ERROR);
    await stagePart(uploadId, seq);
    return json({ ok: true });
  }

  // The FIRST part opens the upload: the declared total must be a size the
  // small lanes do NOT own (they keep their single-buffer contract
  // untouched) and the tier's own ceiling admits (constants.mjs cites the
  // derivation — the lane rides GC_PLUS_ATTACHMENT_BYTES exactly, wave-20).
  const size = Number(fields.size);
  if (!Number.isInteger(size) || size <= MAX_ATTACHMENT_BYTES || size > GC_PLUS_ATTACHMENT_BYTES) {
    throw new HttpError(400, "That file size is not a large upload.");
  }
  // The bucket is the lane's only byte leg (the R2 revival order — the D1
  // staging carries markers, never bytes): without the binding the intake
  // cannot stage anything.
  if (!env.GC_MEDIA) {
    throw new HttpError(503, STORE_FAILED_ERROR);
  }
  // The staged cap: an uploader holding the cap's worth of active stagings
  // (the fresh random uploadId would mint a ninth) answers the clean refusal.
  const active = await env.GOOBER_DB.prepare(STAGED_ACTIVE_SQL).bind(uploaderId).first();
  if (Number(active?.active) >= GC_UPLOAD_STAGED_CAP) {
    throw new HttpError(409, UPLOAD_STAGED_CAP_ERROR);
  }
  const uploadId = randomToken(12).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  await stagePart(uploadId, 0);
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

  const body = await readJsonCommit(request);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= MAX_ATTACHMENT_BYTES || size > GC_PLUS_ATTACHMENT_BYTES) {
    throw new HttpError(400, "That file size is not a large upload.");
  }

  // THE COMMIT-SIDE TIER RE-CHECK (c26 LOW T-LANE-TIER-COMMIT-RECHECK, one
  // gate = this block: the size arm above plus this arm): the staging rows
  // prove nothing about the term — a Mini or lapsed member cannot commit a
  // staging into a pending row, whatever the staged seqs say.
  if ((await attachmentCapBytes(env, uploaderId, nowSeconds())).tier !== "plus") {
    throw new HttpError(403, UPLOAD_TIER_ERROR);
  }
  // The bucket is the byte leg's only home (no D1 chunk move rides behind it).
  if (!env.GC_MEDIA) {
    throw new HttpError(503, STORE_FAILED_ERROR);
  }

  // The aggregate verification (one read, the shape in STAGING_VERIFY_SQL's
  // comment): a hole, a seq stranger, or a count that disputes the declared
  // size's part grid is an unfinished upload — the staging rows AND objects
  // stay for a retry, no row is born.
  const spread = await env.GOOBER_DB.prepare(STAGING_VERIFY_SQL).bind(uploadId, uploaderId).first();
  if (!spread || Number(spread.n) < 1) throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
  const count = Number(spread.n);
  const expectedParts = Math.ceil(size / GC_UPLOAD_PART_BYTES);
  const lawful =
    Number(spread.lo) === 0 &&
    Number(spread.hi) === count - 1 &&
    count === expectedParts;
  if (!lawful) throw new HttpError(400, UPLOAD_INCOMPLETE_ERROR);

  // The magic re-sniff rides the bucket's first staged part (the intake never
  // trusted a client-side claim). The full-file sanitizer stays the SMALL
  // lanes' rider — a lane file is re-sniffed, never re-buffered; the egress
  // verifier re-checks the mime against the object's first bytes (media.mjs's
  // streaming lane) exactly as the small lanes do.
  let head = null;
  try {
    head = await env.GC_MEDIA.get(laneStagingKey(uploadId, 0));
  } catch {
    head = null; // a bucket read failure is an unfinished set (the retry copy)
  }
  if (!head || typeof (head.body && head.body.getReader) !== "function") {
    throw new HttpError(400, UPLOAD_INCOMPLETE_ERROR);
  }
  const mime = sniffImageMime(await laneHeadSniff(head.body));
  if (!mime) {
    // Not an image: the staging rows AND objects stay (nothing wrote yet),
    // the answer is the shared copy.
    throw new HttpError(400, UPLOAD_ONLY_IMAGES_ERROR);
  }

  const now = nowSeconds();
  // The row is born under the folded count arm (the verify→commit gap: a
  // staged set that raced past the verify read births nothing and answers
  // the retry copy); the bytes assemble from the bucket AFTER the birth, so
  // the fail-closed rollback (below) is the committed row's compensating
  // path — the media intake's own shape (api/media.mjs insertStandalone-
  // Attachment: the object key needs the born row's id, so the durable put
  // follows the birth and precedes the success return; bytes are durable in
  // R2 or the row does not survive). The row itself carries NO byte payload:
  // its binds are the scalar mime/size/created_at tuple and the count arm's
  // three-fold pair — the gc_attachment_chunks move arm retired with the
  // byte leg (wave-20).
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(ROW_INSERT_SQL + STAGING_ARMS_SQL)
      .bind(uploaderId, mime, size, now, ...stagingArmsBinds(uploadId, uploaderId, count)),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) {
    // The staged set raced past the verify read: zero rows birthed, the
    // staging rows AND objects stay, the shared copy.
    throw new HttpError(400, UPLOAD_INCOMPLETE_ERROR);
  }
  const row = await env.GOOBER_DB.prepare(
    "SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = ? " +
      "AND mime = ? AND size_bytes = ? AND created_at = ? ORDER BY id DESC LIMIT 1",
  ).bind(uploaderId, mime, size, now).first();
  const attachmentId = Number(row.id);

  // THE ASSEMBLY: the staged parts stream seq-by-seq into the
  // store-of-record object; the streamed sum IS the size arm. A failure
  // rolls the just-born row back and clears the partial object — the
  // staging rows AND objects stay for a retry, the verbatim retry copy.
  try {
    await assembleLaneAttachment(env, uploadId, attachmentId, size, count);
  } catch {
    await env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachments WHERE id = ? AND status = 'pending'",
    ).bind(attachmentId).run().catch(() => {});
    await env.GC_MEDIA.delete(attachmentObjectKey(attachmentId)).catch(() => {});
    throw new HttpError(400, UPLOAD_INCOMPLETE_ERROR);
  }

  // The staging set leaves once the final object is durable (bucket follows,
  // never leads): the rows clear first, then each deleted row's object dies
  // with it, best-effort.
  await env.GOOBER_DB.prepare(STAGING_CLEAR_SQL).bind(uploadId, uploaderId).run();
  for (let seq = 0; seq < count; seq += 1) {
    await env.GC_MEDIA.delete(laneStagingKey(uploadId, seq)).catch(() => {});
  }
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
// the table at all. TWO cycle-3 arms:
//   - the clear is the PLAIN owner-scoped DELETE — the commit's hold-back
//     arm is COMMIT-SHAPED (its identity tuple binds mime/size/created_at the
//     route can never know; the old shape bound 2 of 6 placeholders and real
//     D1 refuses every run), and an abandon wants no hold-back anyway;
//   - a token a gc_sound_pack_sounds clip still references (a pending
//     candidate's staged bytes, an approved clip's bytes) answers 409 — the
//     clip's rows are dropped or cleared server-side, never abandoned — and
//     the clear ALSO carries the arm in-SQL: a clip row born between the 409
//     check and the DELETE refuses IN THE STATEMENT (the check-then-act
//     window), correlated, no new binds.
export const ABANDON_CLEAR_SQL =
  "DELETE FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? " +
  "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE upload_id = gc_upload_parts.upload_id)";
// The doomed seqs' pre-read: the SAME arms the clear carries (owner + clip),
// so the objects deleted below are exactly the cleared rows', never a clip's.
export const ABANDON_SEQLIST_SQL =
  "SELECT seq FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE upload_id = gc_upload_parts.upload_id)";
const CLIP_REFERENCE_SQL = "SELECT 1 FROM gc_sound_pack_sounds WHERE upload_id = ? LIMIT 1";

export async function handleAbandonUploadRoute(request, env, uploadId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "upload", "uploads-abandon:" + session.user.id);
  const id = String(uploadId || "");
  if (!UPLOAD_ID_RE.test(id)) return json({ ok: true });
  const uploaderId = Number(session.user.id);
  const reference = await env.GOOBER_DB.prepare(CLIP_REFERENCE_SQL).bind(id).first();
  if (reference) throw new HttpError(409, UPLOAD_CLIP_LOCKED_ERROR);
  const doomed = await env.GOOBER_DB.prepare(ABANDON_SEQLIST_SQL).bind(id, uploaderId).all();
  await env.GOOBER_DB.prepare(ABANDON_CLEAR_SQL).bind(id, uploaderId).run();
  // The bucket follows the rows (media.mjs:108): each cleared row's staged
  // object dies with it, best-effort — never blocking the 200.
  if (env.GC_MEDIA) {
    for (const entry of doomed.results || []) {
      await env.GC_MEDIA.delete(laneStagingKey(id, Number(entry.seq))).catch(() => {});
    }
  }
  return json({ ok: true });
}

// The orphan sweep (GO-HAYWIRE cycle-3): staging rows survive the client's
// abandon route whenever a tab dies mid-upload — no TTL existed anywhere.
// The arm deletes rows older than GC_UPLOAD_STAGING_TTL_SECONDS, never a row
// any gc_sound_pack_sounds clip (candidate or approved) still references —
// those rows ARE the clip's bytes. The doomed rows' pre-read (the SAME arms)
// rides ahead so the sweeping objects follow: a swept row's staged object
// dies with it, best-effort, after the DELETE (bucket follows, never leads).
// WIRING LANE: worker.mjs carries no scheduled handler today (no export, no
// crons route in wrangler.toml), so the sweep ships exported+tested and its
// first cron export calls it; until then the abandon route and the staged
// cap bound the same orphans.
export async function sweepStaleUploadParts(env, nowArg) {
  const now = Number.isInteger(nowArg) ? nowArg : nowSeconds();
  const cutoff = now - GC_UPLOAD_STAGING_TTL_SECONDS;
  const doomed = await env.GOOBER_DB.prepare(UPLOAD_SWEEP_SEQLIST_SQL).bind(cutoff).all();
  await env.GOOBER_DB.prepare(UPLOAD_PARTS_SWEEP_SQL).bind(cutoff).run();
  if (!env.GC_MEDIA) return;
  for (const entry of doomed.results || []) {
    await env.GC_MEDIA.delete(laneStagingKey(entry.upload_id, Number(entry.seq))).catch(() => {});
  }
}

// The doomed seqs' pre-read (the SAME arms the sweep DELETE carries).
export const UPLOAD_SWEEP_SEQLIST_SQL =
  "SELECT upload_id, seq FROM gc_upload_parts WHERE created_at < ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds s " +
    "WHERE s.upload_id = gc_upload_parts.upload_id)";

export const UPLOAD_PARTS_SWEEP_SQL =
  "DELETE FROM gc_upload_parts WHERE created_at < ? " +
  "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds s " +
  "WHERE s.upload_id = gc_upload_parts.upload_id)";

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
