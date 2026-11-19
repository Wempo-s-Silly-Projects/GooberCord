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

// T-R2-WIPE backfill: every pre-R2 D1 byte row goes into the wempos-forum-r2
// bucket at the exact key scheme the landed T100 intake writes
// (gc-attachments/<gc_attachments.id>; the users avatar columns land at
// avatars/<id> and avatars/pending/<id>), each object VERIFIED by a get-back
// byte compare, and ONLY THEN is the legacy byte storage removed — the
// gc_attachment_chunks rows (never the users columns: users is an auth
// table, and the schema's CHECK law keeps the avatar bytes as the serving
// fallback). LOCAL-ONLY at this seat: the engine speaks plain D1-shaped
// prepare().bind() + an R2-shaped put/get; the CLI wires wrangler's LOCAL
// storage by default, and --remote is the lead's explicit prod gate under
// the full verify ritual. Re-runnable: an existing equal object is verified
// and nulled again without a second put; a verify failure leaves D1
// untouched so the row survives for the next run.
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { attachmentObjectKey } from "../api/media.mjs";
import { avatarObjectKey, pendingAvatarObjectKey } from "../api/avatars.mjs";
import { blobToUint8Array } from "../api/core/images.mjs";
import { ATTACHMENT_CHUNK_BYTES } from "../constants.mjs";

// Engine read page: 64 chunks ≈ 4 MiB of 64 KB chunks — the landed serving
// page, so the isolate never holds one row's full bytes twice.
const PAGE_ROWS = Math.max(1, Math.floor(4 * 1024 * 1024 / ATTACHMENT_CHUNK_BYTES));

function failLog(step, id, error) {
  console.error("backfill " + step + " failed for id " + id + ":", String((error && error.message) || error));
}

// Drivers vary in what a BLOB column looks like: node:sqlite gives a Buffer,
// the D1 JSON surface gives base64 or hex strings. Normalize to bytes.
export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") {
    if (/^[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0) {
      const out = new Uint8Array(value.length / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function drainBody(object, id) {
  try {
    return blobToUint8Array(await new Response(object.body).arrayBuffer());
  } catch (error) {
    failLog("verify-drain", id, error);
    return null;
  }
}

// The R2 verify: get the object back, byte-compare against the source.
async function verifyObject(bucket, key, bytes, id) {
  let object;
  try {
    object = await bucket.get(key);
  } catch (error) {
    failLog("verify-get", id, error);
    return false;
  }
  if (!object || !object.body) {
    console.error("backfill verify-miss for id " + id + ": object " + key + " read back null");
    return false;
  }
  const readBack = await drainBody(object, id);
  if (!bytesEqual(readBack, bytes)) {
    console.error("backfill verify-mismatch for id " + id + ": object " + key +
      " (" + (readBack ? readBack.length : -1) + " vs " + bytes.length + " bytes)");
    return false;
  }
  return true;
}

// One attachment: page-read its chunk set, put it, verify it, null the
// legacy rows. Returns { verdict: "put" | "kept" | "skipped" | "failed",
// nulled }.
async function backfillAttachment(db, bucket, attachmentId, sizeBytes) {
  const chunks = [];
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const page = await db.prepare(
      "SELECT seq, data FROM gc_attachment_chunks WHERE attachment_id = ? " +
        "ORDER BY seq LIMIT ? OFFSET ?",
    ).bind(attachmentId, PAGE_ROWS, offset).all();
    const rows = (page && page.results) || [];
    for (const row of rows) {
      const bytes = toBytes(row.data);
      if (!bytes) {
        console.error("backfill unreadable chunk for attachment " + attachmentId + " (seq " + row.seq + ")");
        return { verdict: "failed", nulled: 0 };
      }
      chunks.push(bytes);
      if (bytes.length > ATTACHMENT_CHUNK_BYTES) {
        console.error("backfill oversize chunk for attachment " + attachmentId + " (seq " + row.seq + ")");
        return { verdict: "failed", nulled: 0 };
      }
    }
    if (rows.length < PAGE_ROWS) break;
  }
  if (chunks.length === 0) return { verdict: "skipped", nulled: 0 };
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  if (sizeBytes !== null && sizeBytes !== undefined && Number(sizeBytes) !== bytes.length) {
    console.error("backfill size mismatch for attachment " + attachmentId + ": " +
      bytes.length + " assembled vs row " + Number(sizeBytes));
    return { verdict: "failed", nulled: 0 };
  }

  const key = attachmentObjectKey(attachmentId);
  const existing = await verifyObject(bucket, key, bytes, attachmentId);
  if (!existing) {
    try {
      await bucket.put(key, bytes);
    } catch (error) {
      failLog("put", attachmentId, error);
      return { verdict: "failed", nulled: 0 };
    }
    if (!(await verifyObject(bucket, key, bytes, attachmentId))) {
      return { verdict: "failed", nulled: 0 };
    }
  }
  // The legacy rows null ONLY on a byte-verified put.
  const result = await db.prepare(
    "DELETE FROM gc_attachment_chunks WHERE attachment_id = ?",
  ).bind(attachmentId).run();
  const nulled = Number(result && result.meta && result.meta.changes) || 0;
  if (nulled !== chunks.length) {
    console.error("backfill null-count mismatch for attachment " + attachmentId + ": " +
      nulled + " rows removed vs " + chunks.length + " read");
    return { verdict: "failed", nulled };
  }
  return { verdict: existing ? "kept" : "put", nulled };
}

// One avatar blob: put + verify only, NO D1 write (users is an auth table —
// the byte columns stay as the serving fallback; the schema CHECK requires
// them beside their mime anyway).
async function backfillAvatarBlob(bucket, userId, key, raw) {
  const bytes = toBytes(raw);
  if (!bytes) {
    console.error("backfill unreadable avatar blob for user " + userId);
    return "failed";
  }
  const verified = await verifyObject(bucket, key, bytes, userId);
  if (verified) return "kept";
  try {
    await bucket.put(key, bytes);
  } catch (error) {
    failLog("avatar-put", userId, error);
    return "failed";
  }
  return (await verifyObject(bucket, key, bytes, userId)) ? "put" : "failed";
}

function bump(tally, verdict) {
  tally.counts[verdict] = (tally.counts[verdict] || 0) + 1;
}

// The engine: db speaks D1's prepare().bind().all()/.run(); bucket speaks
// the binding's put/get. Returns per-surface tallies.
export async function backfillBlobsToR2(db, bucket, options = {}) {
  if (!bucket) throw new Error("backfillBlobsToR2: no GC_MEDIA bucket supplied");
  const progress = typeof options.onProgress === "function" ? options.onProgress : null;

  const attachments = { counts: { put: 0, kept: 0, skipped: 0, failed: 0 }, nulledRows: 0 };
  let cursor = 0;
  for (;;) {
    const page = await db.prepare(
      "SELECT id, size_bytes FROM gc_attachments WHERE id > ? ORDER BY id LIMIT ?",
    ).bind(cursor, 200).all();
    const rows = (page && page.results) || [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = Number(row.id);
      const outcome = await backfillAttachment(db, bucket, id, row.size_bytes);
      bump(attachments, outcome.verdict);
      attachments.nulledRows += outcome.nulled;
      if (progress) progress("attachment", id, outcome.verdict);
    }
    cursor = Number(rows[rows.length - 1].id);
  }

  const avatars = { counts: { put: 0, kept: 0, failed: 0 } };
  const avatarRows = await db.prepare(
    "SELECT id, avatar_mime, avatar_data, pending_avatar_mime, pending_avatar_data " +
      "FROM users WHERE avatar_mime IS NOT NULL OR pending_avatar_mime IS NOT NULL",
  ).bind().all();
  for (const row of ((avatarRows && avatarRows.results) || [])) {
    const id = Number(row.id);
    if (row.avatar_mime && row.avatar_data !== null && row.avatar_data !== undefined) {
      const verdict = await backfillAvatarBlob(bucket, id, avatarObjectKey(id), row.avatar_data);
      bump(avatars, verdict);
      if (progress) progress("avatar", id, verdict);
    }
    if (row.pending_avatar_mime && row.pending_avatar_data !== null && row.pending_avatar_data !== undefined) {
      const verdict = await backfillAvatarBlob(bucket, id, pendingAvatarObjectKey(id), row.pending_avatar_data);
      bump(avatars, verdict);
      if (progress) progress("avatar-pending", id, verdict);
    }
  }

  return { attachments, avatars };
}

// --- local CLI (wrangler wiring) -------------------------------------------------

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("backfill CLI: non-finite bind value");
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return "'" + value.replace(/'/g, "''") + "'";
  const bytes = toBytes(value);
  if (bytes) {
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return "X'" + hex + "'";
  }
  throw new Error("backfill CLI: unsupported bind value " + typeof value);
}

// `wrangler d1 execute --json` answers an ARRAY of batch entries —
// [{ results: [...], meta: { changes } }] — while the engine's D1 shape wants
// a single `{ results }` page and `{ meta: { changes } }` from .all()/.run().
// Entries merge into one flat page; this is the seam that, when left
// unfolded, made the first prod run read an empty DB (a false-green zero,
// not a verified one) — it is pinned by tests/r2-backfill.test.mjs.
export function d1JsonToD1Shape(parsed) {
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
  const results = entries.flatMap((entry) => (Array.isArray(entry.results) ? entry.results : []));
  const metas = entries.map((entry) => entry && entry.meta).filter(Boolean);
  const meta = metas.length > 0 ? metas[metas.length - 1] : { changes: 0 };
  return { results, meta };
}

// The D1-shaped adapter over `wrangler d1 execute` (params interpolated as
// typed SQL literals — every value is fleet data already inside the DB, so
// the escaper's job is shape-only, not trust).
export function d1WranglerAdapter(database, { remote = false, persistTo = null, cwd = null } = {}) {
  const baseFlags = remote ? ["--remote"] : ["--local"];
  if (persistTo) baseFlags.push("--persist-to", persistTo);
  async function d1(args) {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("pnpx", ["wrangler", "d1", "execute", database,
      ...baseFlags, "--json", ...args],
      cwd ? { cwd, maxBuffer: 1024 * 1024 * 256 } : { maxBuffer: 1024 * 1024 * 256 });
    return d1JsonToD1Shape(JSON.parse(out.toString("utf8")).filter(Boolean));
  }
  return {
    prepare(sql) {
      return {
        bind(...values) {
          let index = 0;
          const filled = sql.replace(/\?/g, () => sqlLiteral(values[index++]));
          return {
            all: async () => await d1(["--command", filled]),
            run: async () => await d1(["--command", filled]),
          };
        },
      };
    },
  };
}

// The verb-first arg shape wrangler's `r2 object get|put <bucket>/<key>`
// parser demands: the objectPath is a REQUIRED positional that must precede
// any flags (the flags-first ordering failed all 26 avatar puts on the first
// remote run as "Unknown arguments"). Pinned in tests/r2-backfill.test.mjs.
export function r2ObjectArgs(verb, bucket, key, tmp, baseFlags) {
  return [verb, bucket + "/" + key, "--file", tmp, ...baseFlags];
}

// The R2-shaped adapter over `wrangler r2 object` (put via a temp file, get
// back via one).
export function r2WranglerAdapter(bucket, { remote = false, persistTo = null, cwd = null } = {}) {
  const baseFlags = remote ? ["--remote"] : ["--local"];
  if (persistTo) baseFlags.push("--persist-to", persistTo);
  async function r2(args) {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("pnpx", ["wrangler", "r2", "object", ...args],
      cwd ? { cwd, maxBuffer: 1024 * 1024 * 64 } : { maxBuffer: 1024 * 1024 * 64 });
  }
  let tmpCounter = 0;
  return {
    async put(key, bytes) {
      const tmp = path.join(os.tmpdir(), "gc-r2-backfill-" + process.pid + "-" + (tmpCounter += 1));
      try {
        writeFileSync(tmp, bytes);
        await r2(r2ObjectArgs("put", bucket, key, tmp, baseFlags));
      } finally {
        try { unlinkSync(tmp); } catch { /* already gone */ }
      }
    },
    async get(key) {
      const tmp = path.join(os.tmpdir(), "gc-r2-backfill-" + process.pid + "-" + (tmpCounter += 1));
      try {
        await r2(r2ObjectArgs("get", bucket, key, tmp, baseFlags));
        return { body: new Response(readFileSync(tmp)).body };
      } catch (error) {
        if (/not found|does not exist|no object/i.test(String(error))) return null;
        throw error;
      } finally {
        try { unlinkSync(tmp); } catch { /* nothing written */ }
      }
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      "usage: node scripts/backfill-blobs-to-r2.mjs [--database <name>] [--bucket <name>]\n" +
      "       [--persist-to <dir>] [--remote]\n" +
      "default: LOCAL wrangler storage (the dev lane); --remote is the owner-gated\n" +
      "prod write and refuses with the fleet law unless the verify ritual is done.");
  }
  if (argv.includes("--remote")) {
    throw new Error("--remote writes PROD D1/R2: owner-held gate; run it yourself under the verify ritual.");
  }
  const toml = readFileSync(path.resolve(fileURLToPath(import.meta.url), "../../wrangler.toml"), "utf8");
  const dbName = (argv.includes("--database"))
    ? argv[argv.indexOf("--database") + 1]
    : (/database_name\s*=\s*"([^"]+)"/.exec(toml) || [])[1];
  const bucket = (argv.includes("--bucket"))
    ? argv[argv.indexOf("--bucket") + 1]
    : (/bucket_name\s*=\s*"([^"]+)"/.exec(toml) || [])[1];
  if (!dbName || !bucket) throw new Error("backfill CLI: cannot resolve --database/--bucket (and none in wrangler.toml)");
  const persistIndex = argv.indexOf("--persist-to");
  const opts = { remote: false, persistTo: persistIndex >= 0 ? argv[persistIndex + 1] : null, cwd: path.resolve(fileURLToPath(import.meta.url), "../..") };

  const db = d1WranglerAdapter(dbName, opts);
  const r2 = r2WranglerAdapter(bucket, opts);
  const tallies = await backfillBlobsToR2(db, r2, {
    onProgress: (surface, id, verdict) => console.error("backfill " + surface + " " + id + ": " + verdict),
  });
  console.log(JSON.stringify({ database: dbName, bucket, ...tallies }, null, 2));
  const failed = tallies.attachments.counts.failed + tallies.avatars.counts.failed;
  if (failed > 0) throw new Error(failed + " surface(s) failed verification — D1 left intact, re-run");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
