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

// One-shot R2 backfill: reassembles every attachment's bytes from the
// gc_attachment_chunks D1 rows and mirrors them at the exact serving key the
// worker reads (api/media.mjs's GC_MEDIA.get), byte-for-byte.
//
// D1 is strictly READ-ONLY here (SELECTs only). R2 is the only writer, and
// idempotent: a key already present is skipped when its bytes match
// (sha256-verified); a mismatch is REPORTED, never overwritten silently, and
// nothing is ever deleted. Zero-byte payloads and ledger-vs-assembled size
// mismatches are skipped and listed, not guessed around.
//
// Avatars ride the same mirror logic at avatars/<user_id> sourced from
// users.avatar_data (api/avatars.mjs serves GC_MEDIA-first with the D1 bytes
// as the fallback; the forum-side lifecycle's own rides are write-once of
// these same bytes, so a sha-verified put here cannot fight it). D1 stays
// strictly read-only; only R2 is written.
//
// Usage: node scripts/r2-backfill.mjs
// (Wrangler resolves from node_modules/.bin/wrangler — pnpm-installed.)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_BIN = path.join(REPO_ROOT, "node_modules/.bin/wrangler");

const DATABASE = "wempo-forum-data";
const BUCKET = "wempos-forum-r2";
// The serving keys, pinned to constants.mjs's values (the script stays
// standalone; assertConstantsAgreement checks the worker's constants agree).
const ATTACHMENT_OBJECT_PREFIX = "gc-attachments/";
const AVATAR_OBJECT_PREFIX = "avatars/";
const MAX_SPAWN_BYTES = 1 << 30;

// --- wrangler plumbing --------------------------------------------------------

function assertConstantsAgreement() {
  const constants = readFileSyncSafe(path.join(REPO_ROOT, "constants.mjs"));
  if (!constants) return;
  for (const [name, literal] of [
    ["GC_ATTACHMENT_OBJECT_PREFIX", ATTACHMENT_OBJECT_PREFIX],
    ["GC_AVATAR_OBJECT_PREFIX", AVATAR_OBJECT_PREFIX],
  ]) {
    if (!constants.includes(`export const ${name} = ${JSON.stringify(literal)}`)) {
      throw new Error(`constants.mjs disagrees with the pinned ${name}`);
    }
  }
}

function readFileSyncSafe(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`WARN: ${filePath} unreadable (${error.message}); prefix pin skipped.`);
    return null;
  }
}

function runWrangler(args) {
  const result = spawnSync(WRANGLER_BIN, args, { cwd: REPO_ROOT, maxBuffer: MAX_SPAWN_BYTES });
  if (result.error) throw new Error(`wrangler spawn failed: ${result.error.message}`);
  return result;
}

function d1Query(sql) {
  const result = runWrangler([
    "d1", "execute", DATABASE, "--remote", "--json", "--command", sql,
  ]);
  if (result.status !== 0) {
    throw new Error(`D1 query failed (exit ${result.status}): ${sql}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout)[0].results ?? [];
}

function r2Get(key) {
  const result = runWrangler([
    "r2", "object", "get", `${BUCKET}/${key}`, "--pipe", "--remote",
  ]);
  if (result.status !== 0) {
    if (/not ?found/i.test(String(result.stderr)) || /404/i.test(String(result.stderr))
      || /does not exist/i.test(String(result.stderr))) return null;
    throw new Error(`R2 get ${key} failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function r2Put(key, sourcePath) {
  const result = runWrangler([
    "r2", "object", "put", `${BUCKET}/${key}`, "--remote", "--file", sourcePath,
  ]);
  if (result.status !== 0) {
    throw new Error(`R2 put ${key} failed (exit ${result.status}): ${result.stderr}`);
  }
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- attachments -------------------------------------------------------------

function backfillAttachments(scratchDir) {
  const rows = d1Query("SELECT id, size_bytes FROM gc_attachments ORDER BY id");
  const report = {
    totalRows: rows.length,
    uploadedNow: [],
    alreadyPresentVerified: [],
    presentButDifferent: [],
    emptyPayload: [],
    ledgerMismatch: [],
    errors: [],
  };

  for (const row of rows) {
    const attachmentId = Number(row.id);
    try {
      const { outcome, detail } = mirrorAttachment(attachmentId, scratchDir);
      report[outcome].push(detail ?? attachmentId);
    } catch (error) {
      report.errors.push(`attachment ${attachmentId}: ${error.message}`);
    }
  }
  return report;
}

function mirrorAttachment(attachmentId, scratchDir) {
  const detail = mirrorAttachmentBytes(attachmentId);
  if (detail.assembled.length === 0) {
    return { outcome: "emptyPayload", detail: { id: attachmentId, ...detail.summary } };
  }
  if (detail.ledgerSize !== null && detail.ledgerSize !== detail.assembled.length) {
    return {
      outcome: "ledgerMismatch",
      detail: { id: attachmentId, ledgerSize: detail.ledgerSize, assembledSize: detail.assembled.length },
    };
  }

  const scratchFile = path.join(scratchDir, `attachment-${attachmentId}`);
  writeFileSync(scratchFile, detail.assembled);
  const objectKey = ATTACHMENT_OBJECT_PREFIX + attachmentId;
  const existingBytes = r2Get(objectKey);
  if (existingBytes === null) {
    r2Put(objectKey, scratchFile);
    return { outcome: "uploadedNow", detail: { id: attachmentId, ...detail.summary } };
  }
  if (existingBytes.length === detail.assembled.length
    && sha256Hex(existingBytes) === sha256Hex(detail.assembled)) {
    return { outcome: "alreadyPresentVerified", detail: { id: attachmentId, ...detail.summary } };
  }
  return {
    outcome: "presentButDifferent",
    detail: { id: attachmentId, objectSize: existingBytes.length, assembledSize: detail.assembled.length },
  };
}

function mirrorAttachmentBytes(attachmentId) {
  const ledgerRows = d1Query(
    `SELECT size_bytes FROM gc_attachments WHERE id = ${attachmentId} LIMIT 1`,
  );
  const ledgerSize = ledgerRows.length === 0 ? null : Number(ledgerRows[0].size_bytes);
  const chunkRows = d1Query(
    `SELECT hex(data) AS hex FROM gc_attachment_chunks WHERE attachment_id = ${attachmentId} ORDER BY seq`,
  );
  const chunks = chunkRows.map((row) => Buffer.from(row.hex, "hex"));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const assembled = Buffer.concat(chunks, total);
  return {
    ledgerSize,
    assembled,
    summary: {
      chunks: chunks.length,
      size: assembled.length,
      ledgerSize,
      sha256: assembled.length === 0 ? null : sha256Hex(assembled),
    },
  };
}

// --- avatars --------------------------------------------------------------------

function mirrorAvatars(scratchDir) {
  const rows = d1Query(
    "SELECT id, avatar_mime FROM users " +
      "WHERE avatar_mime IS NOT NULL AND avatar_data IS NOT NULL AND length(avatar_data) > 0",
  );
  const report = {
    totalRows: rows.length,
    uploadedNow: [],
    alreadyPresentVerified: [],
    presentButDifferent: [],
    emptyPayload: [],
    errors: [],
  };
  for (const row of rows) {
    const userId = Number(row.id);
    try {
      const { outcome, detail } = mirrorAvatar(userId, scratchDir);
      report[outcome].push(detail ?? userId);
    } catch (error) {
      report.errors.push(`avatar ${userId}: ${error.message}`);
    }
  }
  return report;
}

function mirrorAvatar(userId, scratchDir) {
  const byteRows = d1Query(
    `SELECT hex(avatar_data) AS hex FROM users WHERE id = ${userId} AND avatar_data IS NOT NULL`,
  );
  const bytes = Buffer.from(byteRows[0].hex, "hex");
  if (bytes.length === 0) {
    return { outcome: "emptyPayload", detail: { id: userId } };
  }
  writeFileSync(path.join(scratchDir, `avatar-${userId}`), bytes);
  const objectKey = AVATAR_OBJECT_PREFIX + userId;
  const existingBytes = r2Get(objectKey);
  if (existingBytes === null) {
    r2Put(objectKey, path.join(scratchDir, `avatar-${userId}`));
    return { outcome: "uploadedNow", detail: { id: userId, size: bytes.length, sha256: sha256Hex(bytes) } };
  }
  if (existingBytes.length === bytes.length && sha256Hex(existingBytes) === sha256Hex(bytes)) {
    return { outcome: "alreadyPresentVerified", detail: { id: userId, size: bytes.length } };
  }
  return {
    outcome: "presentButDifferent",
    detail: { id: userId, objectSize: existingBytes.length, d1Size: bytes.length },
  };
}

// --- main ---------------------------------------------------------------------

let scratchDirCache = null;

async function main() {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "r2-backfill-"));
  scratchDirCache = scratchDir;
  assertConstantsAgreement();

  const attachments = backfillAttachments(scratchDir);
  const avatars = mirrorAvatars(scratchDir);

  console.log(`=== NAME-PRESENCE REPORT: attachments (gc_attachments -> ${ATTACHMENT_OBJECT_PREFIX}<id>) ===`);
  console.log(`total attachment rows in D1: ${attachments.totalRows}`);
  console.log(`uploaded now: ${attachments.uploadedNow.length}` +
    (attachments.uploadedNow.length ? ` ${JSON.stringify(attachments.uploadedNow)}` : ""));
  console.log(`already present, sha-verified, skipped: ${attachments.alreadyPresentVerified.length}` +
    (attachments.alreadyPresentVerified.length ? ` ${JSON.stringify(attachments.alreadyPresentVerified)}` : ""));
  console.log(`present but different (NOT overwritten): ${attachments.presentButDifferent.length}` +
    (attachments.presentButDifferent.length ? ` ${JSON.stringify(attachments.presentButDifferent)}` : ""));
  console.log(`zero/empty payload (skipped, listed): ${attachments.emptyPayload.length}` +
    (attachments.emptyPayload.length ? ` ${JSON.stringify(attachments.emptyPayload)}` : ""));
  console.log(`ledger-vs-assembled size mismatch (skipped): ${attachments.ledgerMismatch.length}` +
    (attachments.ledgerMismatch.length ? ` ${JSON.stringify(attachments.ledgerMismatch)}` : ""));
  console.log(`errors: ${attachments.errors.length}` +
    (attachments.errors.length ? `\n${attachments.errors.join("\n")}` : ""));

  console.log(`\n=== NAME-PRESENCE REPORT: avatars (users.avatar_data -> ${AVATAR_OBJECT_PREFIX}<user_id>) ===`);
  console.log(`avatar rows with bytes in D1: ${avatars.totalRows}`);
  console.log(`uploaded now: ${avatars.uploadedNow.length}` +
    (avatars.uploadedNow.length ? ` ${JSON.stringify(avatars.uploadedNow)}` : ""));
  console.log(`already present, sha-verified, skipped: ${avatars.alreadyPresentVerified.length}` +
    (avatars.alreadyPresentVerified.length ? ` ${JSON.stringify(avatars.alreadyPresentVerified)}` : ""));
  console.log(`present but different (NOT overwritten): ${avatars.presentButDifferent.length}` +
    (avatars.presentButDifferent.length ? ` ${JSON.stringify(avatars.presentButDifferent)}` : ""));
  console.log(`zero/empty payload (skipped, listed): ${avatars.emptyPayload.length}` +
    (avatars.emptyPayload.length ? ` ${JSON.stringify(avatars.emptyPayload)}` : ""));
  console.log(`errors: ${avatars.errors.length}` +
    (avatars.errors.length ? `\n${avatars.errors.join("\n")}` : ""));

  const failures = attachments.errors.length + attachments.presentButDifferent.length
    + attachments.ledgerMismatch.length + avatars.errors.length
    + avatars.emptyPayload.length + avatars.presentButDifferent.length;
  if (failures > 0) process.exitCode = 1;
}

process.on("exit", () => {
  if (scratchDirCache) rmSync(scratchDirCache, { recursive: true, force: true });
});

await main();
