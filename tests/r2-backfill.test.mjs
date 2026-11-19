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

// T-R2-WIPE backfill engine pins: scripts/backfill-blobs-to-r2.mjs's
// backfillBlobsToR2 rides a D1-shaped adapter over real node:sqlite and a
// Map-backed fake R2 (the r2-binding lane's fakes) — every pin asserts the
// law, not the wiring: the object lands at the T100 key scheme, the legacy
// chunk rows null ONLY on a byte-verified put (a verify failure leaves D1
// intact), a re-run verifies an existing equal object without a second put,
// empty chunk sets skip, and the users avatar blobs land WITHOUT any D1
// write (auth table).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { backfillBlobsToR2, toBytes, bytesEqual } from "../scripts/backfill-blobs-to-r2.mjs";

const PAGE_ROWS = Math.max(1, Math.floor(4 * 1024 * 1024 / 64000));

function fixture(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY, uploader_id INTEGER, mime TEXT,
      size_bytes INTEGER, status TEXT, created_at INTEGER);
    CREATE TABLE gc_attachment_chunks (
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id),
      seq INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (attachment_id, seq));
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL,
      avatar_mime TEXT, avatar_data BLOB,
      pending_avatar_mime TEXT, pending_avatar_data BLOB);
  `);
  for (const [sql, values] of rows) {
    if (values) db.prepare(sql).run(...values);
    else db.prepare(sql).run();
  }
  return db;
}

// D1 shape over the real engine: prepare().bind().all() answers
// { results }, .run() answers { meta: { changes } }.
function d1(sqlite) {
  return {
    prepare: (sql) => {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...args) => ({
          all: async () => ({ results: stmt.all(...args) }),
          run: async () => {
            const info = stmt.run(...args);
            return { meta: { changes: info.changes } };
          },
        }),
      };
    },
  };
}

function fakeR2({ corruptSuffix = 0, alwaysMissVerify = false } = {}) {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async put(key, value) {
      calls.push({ op: "put", key });
      const stored = corruptSuffix > 0 ? value.slice(0, value.length - corruptSuffix) : value;
      objects.set(key, stored);
    },
    async get(key) {
      calls.push({ op: "get", key });
      const bytes = objects.get(key);
      if (!bytes || alwaysMissVerify) return null;
      return { body: new Response(bytes).body };
    },
  };
}

function chunkRows(id, count, fill) {
  const out = [];
  for (let seq = 0; seq < count; seq += 1) {
    out.push([
      "INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (?, ?, ?)",
      [id, seq, new Uint8Array(8).fill(fill + seq)],
    ]);
  }
  return out;
}

const FULL_BYTES = (count, fill) => {
  const bytes = new Uint8Array(count * 8);
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < 8; j += 1) bytes[i * 8 + j] = fill + i;
  }
  return bytes;
};

test("backfill puts a chunked attachment at the T100 key, verifies, and nulls the legacy rows", async () => {
  const db = fixture([
    ["INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (5, 'image/png', ?)", [40]],
    ...chunkRows(5, 5, 0x10),
  ]);
  const bucket = fakeR2();

  const tallies = await backfillBlobsToR2(d1(db), bucket);
  assert.deepEqual(tallies.attachments.counts, { put: 1, kept: 0, skipped: 0, failed: 0 });
  assert.equal(tallies.attachments.nulledRows, 5);
  assert.deepEqual(tallies.avatars.counts, { put: 0, kept: 0, failed: 0 });

  assert.deepEqual(browserSafe(bucket.objects.get("gc-attachments/5")), browserSafe(FULL_BYTES(5, 0x10)));
  const left = db.prepare("SELECT COUNT(*) AS c FROM gc_attachment_chunks").get();
  assert.equal(left.c, 0, "the legacy rows null only after the verified put");
  // THE call shape: verify get → put → verify get (→ null = delete-on-D1).
  assert.deepEqual(bucket.calls, [
    { op: "get", key: "gc-attachments/5" },
    { op: "put", key: "gc-attachments/5" },
    { op: "get", key: "gc-attachments/5" },
  ]);
});

test("backfill pages beyond one engine page", async () => {
  const count = PAGE_ROWS + 7;
  const db = fixture([
    ["INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (9, 'audio/mpeg', ?)", [count * 8]],
    ...chunkRows(9, count, 0x40),
  ]);
  const bucket = fakeR2();
  const tallies = await backfillBlobsToR2(d1(db), bucket);
  assert.deepEqual(tallies.attachments.counts, { put: 1, kept: 0, skipped: 0, failed: 0 });
  assert.equal(tallies.attachments.nulledRows, count);
  assert.deepEqual(bucket.objects.get("gc-attachments/9"), FULL_BYTES(count, 0x40));
});

test("a verify failure leaves D1 intact — the put does not null the rows", async () => {
  const db = fixture([
    ["INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (5, 'image/png', ?)", [16]],
    ...chunkRows(5, 2, 0x10),
    ["INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (6, 'image/png', ?)", [16]],
    ...chunkRows(6, 2, 0x20),
  ]);
  const bucket = fakeR2({ corruptSuffix: 1 });

  const tallies = await backfillBlobsToR2(d1(db), bucket);
  assert.equal(tallies.attachments.counts.failed, 2);
  assert.equal(tallies.attachments.counts.put, 0);
  assert.equal(tallies.attachments.nulledRows, 0);
  const left = db.prepare("SELECT COUNT(*) AS c FROM gc_attachment_chunks").get();
  assert.equal(left.c, 4, "every legacy row survives for the re-run");
  assert.ok(bucket.objects.get("gc-attachments/5"), "the corrupt put still landed for the next run to overwrite");
});

test("a re-run verifies an already-equal object without a second put and re-nulls", async () => {
  const db = fixture([
    ["INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (5, 'image/png', ?)", [16]],
    ...chunkRows(5, 2, 0x10),
  ]);
  const bucket = fakeR2();
  bucket.objects.set("gc-attachments/5", FULL_BYTES(2, 0x10));

  const tallies = await backfillBlobsToR2(d1(db), bucket);
  assert.deepEqual(tallies.attachments.counts, { put: 0, kept: 1, skipped: 0, failed: 0 });
  assert.equal(tallies.attachments.nulledRows, 2);
  assert.deepEqual(bucket.calls, [{ op: "get", key: "gc-attachments/5" }], "no redundant put");
});

test("an empty chunk set skips, an avatar set lands at the avatar keys with NO D1 write", async () => {
  const db = fixture([
    ["INSERT INTO gc_attachments (id, mime, size_bytes) VALUES (7, 'image/png', 0)", []],
    [
      "INSERT INTO users (id, username, avatar_mime, avatar_data, pending_avatar_mime, pending_avatar_data) " +
        "VALUES (3, 'wempos', 'image/png', ?, 'image/png', ?)",
      [new Uint8Array(4).fill(0x0a), new Uint8Array(4).fill(0x0b)],
    ],
    [
      "INSERT INTO users (id, username, pending_avatar_mime, pending_avatar_data) " +
        "VALUES (4, 'pendingonly', 'image/png', ?)",
      [new Uint8Array(4).fill(0x0c)],
    ],
  ]);
  const bucket = fakeR2();

  const tallies = await backfillBlobsToR2(d1(db), bucket);
  assert.deepEqual(tallies.attachments.counts, { put: 0, kept: 0, skipped: 1, failed: 0 });
  assert.deepEqual(tallies.avatars.counts, { put: 3, kept: 0, failed: 0 });
  assert.deepEqual(bucket.calls.map((call) => call.op + " " + call.key), [
    "get avatars/3", "put avatars/3", "get avatars/3",
    "get avatars/pending/3", "put avatars/pending/3", "get avatars/pending/3",
    "get avatars/pending/4", "put avatars/pending/4", "get avatars/pending/4",
  ]);
  const user3 = db.prepare(
    "SELECT length(avatar_data) AS len FROM users WHERE id = 3",
  ).get();
  assert.ok(user3.len > 0, "the avatar byte columns stay (auth table)");
});

test("toBytes normalizes both buffer and driver encodings", () => {
  assert.deepEqual(browserSafe(toBytes(new Uint8Array([1, 2, 3]))), [1, 2, 3]);
  assert.deepEqual(browserSafe(toBytes("0102ef")), [1, 2, 0xef],
    "hex strings (the d1-JSON shape) decode");
  assert.deepEqual(browserSafe(toBytes(Buffer.from("/wED", "base64"))), [0xff, 0x01, 0x03]);
  assert.equal(toBytes(null), null);
});

function browserSafe(bytes) {
  return bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
}

test("bytesEqual answers the byte-compare law", () => {
  const bytes = toBytes(new Uint8Array([0xaa, 0xbb]));
  assert.equal(bytesEqual(bytes, bytes), true);
  assert.equal(bytesEqual(bytes, null), false);
  assert.equal(bytesEqual(bytes, new Uint8Array([0xaa, 0xbc])), false);
});
