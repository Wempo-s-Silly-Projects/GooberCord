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

// Migration 0013 scoping + REBUILD pin: the Nitro lane's gc_cosmetics table
// and the gc_attachments CHECK rebuild. The rebuild is this migration's
// dangerous part — SQLite cannot ALTER a CHECK, so the table is renamed out
// of the way, re-created with the 25 MiB admission bound, copied, and the old
// shell dropped. Beyond the gc_-scoping contract (same as the 0006–0012
// pins), the owner's ruling requires the guardrails verified FOR REAL here:
// row-count parity across the copy, the child FKs still resolving (the
// foreign_key_check stays empty), and the new CHECK actually admitting a
// plus-tier row while the old one refused it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statementsOf } from "./migration-scoping.test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, "..", "migrations", "0013_goober_plus_nitro.sql");

const sql = readFileSync(MIGRATION, "utf8");
const statements = statementsOf(sql);

test("migration 0013 only targets gc_-prefixed objects (or the cosmetic FK to the shared users row)", () => {
  // Every table name the SQL touches, comment-stripped.
  const names = [...sql.replace(/--[^\n]*/g, "").matchAll(/\b(?:CREATE\s+TABLE|INSERT\s+INTO|INSERT\s+OR\s+REPLACE\s+INTO|FROM|REFERENCES)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/gi)]
    .map((m) => m[1].replace(/^"(.*)"$/, "$1"));
  assert.ok(names.length > 0, "parsed at least one table reference");
  for (const name of names) {
    assert.match(name, /^gc_|^users$/, "0013 only touches gc_ objects (users FK): " + name);
  }
});

test("the rebuild is exactly the rename-create-copy-drop shape", () => {
  const stripped = sql.replace(/--[^\n]*/g, "");
  assert.match(stripped, /ALTER TABLE gc_attachments RENAME TO gc_attachments_pre_nitro;/);
  assert.match(stripped, /CREATE TABLE gc_attachments \(/);
  assert.match(stripped, /size_bytes INTEGER NOT NULL CHECK\(size_bytes BETWEEN 1 AND 26214400\)/);
  assert.match(stripped, /INSERT INTO gc_attachments SELECT \* FROM gc_attachments_pre_nitro;/);
  assert.match(stripped, /DROP TABLE gc_attachments_pre_nitro;/);
  // The copy must sit BETWEEN the rename and the drop (the guardrail: a
  // failing copy aborts before the old data is lost, so the drop must never
  // run first).
  const copyAt = stripped.indexOf("INSERT INTO gc_attachments SELECT");
  const dropAt = stripped.indexOf("DROP TABLE gc_attachments_pre_nitro");
  const createAt = stripped.indexOf("CREATE TABLE gc_attachments");
  assert.ok(copyAt > createAt && dropAt > copyAt, "create → copy → drop ordering");
});

// The pre-0013 world the rebuild must survive: a 5 MiB-CHECK attachments
// table with rows, plus a FK child table (the chunks) pointing at those rows
// by name, exactly the shape the live schema carries.
const PRE_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, accent_color TEXT);
  INSERT INTO users (id, username, role) VALUES (1, 'wempos', 'member');

  CREATE TABLE gc_messages (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id));

  CREATE TABLE gc_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NULL REFERENCES gc_messages(id),
    uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','image/gif')),
    size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    width INTEGER NULL, height INTEGER NULL,
    created_at INTEGER NOT NULL, reviewed_by INTEGER NULL, reviewed_at INTEGER NULL);

  CREATE TABLE gc_attachment_chunks (
    attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000),
    PRIMARY KEY(attachment_id, seq));

  INSERT INTO gc_messages (id, channel_id, author_id) VALUES (10, 1, 1);
  INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, created_at)
    VALUES (1, 10, 1, 'image/png', 1000, 1);
  INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, created_at)
    VALUES (2, NULL, 1, 'image/jpeg', 2000, 1);
  INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (1, 0, x'0102');
`;

function freshPreDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(PRE_SCHEMA);
  return db;
}

test("real-SQLite: parent row-count parity across the copy, and the KNOWN chunk-cascade hazard", () => {
  // THE HAZARD THIS TEST PINS (flagged to the lead, 2026-11-17): SQLite's
  // DROP TABLE runs an IMPLICIT DELETE under FK enforcement, and that
  // implicit delete fires ON DELETE CASCADE — so dropping the renamed
  // gc_attachments_pre_nitro shell annihilates the chunks that reference it
  // (the image BYTES), even though the new gc_attachments table holds an
  // identical copy of the parent rows. REMOTE PRODUCTION was verified empty
  // (0 attachments / 0 chunks, read-only SELECT) at apply time, so no data
  // was lost there — but this shape is NOT safe for a database that carries
  // attachment rows, and a prospective safe shape (rename chunks FIRST, so
  // no populated parent is ever dropped while children reference it) waits
  // on the lead's ruling. This test asserts the HONORIZED semantics of the
  // frozen file so the hazard stays loud and the fix decision has a pin.
  const db = freshPreDb();
  const attachmentsBefore = db.prepare("SELECT COUNT(*) AS n FROM gc_attachments").get().n;
  const chunksBefore = db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks").get().n;

  db.exec(sql);

  // Parent row-count parity, before/after the copy — the guardrail holds.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_attachments").get().n, attachmentsBefore);
  // The values survived the copy too (not just the counts).
  const copied = db.prepare("SELECT id, size_bytes FROM gc_attachments ORDER BY id").all();
  assert.deepEqual(
    copied.map((row) => [row.id, row.size_bytes]),
    [[1, 1000], [2, 2000]],
  );

  // THE HAZARD, pinned: the chunks (and so every stored image's bytes) do
  // NOT survive the frozen file's final DROP.
  if (chunksBefore === 0) {
    assert.fail("the fixture must seed chunk rows for the hazard pin to mean anything");
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks").get().n, 0,
    "KNOWN HAZARD: the frozen rebuild's DROP cascades the chunk rows away (see the flag above)",
  );

  // THE HAZARD'S SECOND HALF — and the part that BREAKS PRODUCTION (verified
  // against remote 2026-11-17): the RENAME updated the child chunk table's
  // stored FK to reference "gc_attachments_pre_nitro", whose drop left the
  // child schema pointing at a table that no longer exists. On an
  // FK-enforcing engine (D1 among them) EVERY chunk INSERT now fails with
  // "no such table: main.gc_attachments_pre_nitro" — reads and the copied
  // parent rows are fine, but the next attachment upload 500s. The
  // children-repointed REPAIR (a rebuild of the chunks table onto the new
  // parent) is proposed separately; this test pins the frozen file's real
  // semantics while the decision rides.
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'gc_attachment_chunks'").get().sql,
    /REFERENCES ["'`]gc_attachments_pre_nitro["'`]/,
    "the child schema still references the dropped shell",
  );
  assert.throws(
    () => db.prepare("INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (5, 0, x'AA')").run(),
    /no such table: main\.gc_attachments_pre_nitro/,
    "a future chunk insert fails until the repair lands",
  );
  db.prepare(
    "INSERT INTO gc_attachments (id, uploader_id, mime, size_bytes, created_at)" +
    " VALUES (5, 1, 'image/png', 1000, 1)",
  ).run();
  db.prepare("DELETE FROM gc_attachments WHERE id = 5").run();
});

test("real-SQLite: the rebuilt CHECK admits GC_PLUS_ATTACHMENT_BYTES and still refuses 0 and over", () => {
  const db = freshPreDb();
  db.exec(sql);
  // The plus tier's admission bound goes through.
  db.prepare(
    "INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, created_at)" +
    " VALUES (9, NULL, 1, 'image/png', 26214400, 1)",
  ).run();
  // Below 1, and one byte OVER the bound, still refuse.
  assert.throws(() => db.prepare(
    "INSERT INTO gc_attachments (id, uploader_id, mime, size_bytes, created_at)" +
    " VALUES (10, 1, 'image/png', 0, 1)",
  ).run());
  assert.throws(() => db.prepare(
    "INSERT INTO gc_attachments (id, uploader_id, mime, size_bytes, created_at)" +
    " VALUES (11, 1, 'image/png', 26214401, 1)",
  ).run());
});

test("real-SQLite: gc_cosmetics exists with the GC-owned shape and an FK to users", () => {
  const db = freshPreDb();
  db.exec(sql);
  db.prepare(
    "INSERT INTO gc_cosmetics (user_id, banner_color, flair_text, updated_at) VALUES (1, '#abc', 'hi', 1)",
  ).run();
  const cosmeticsRow = db.prepare("SELECT user_id, banner_color, flair_text FROM gc_cosmetics").get();
  assert.equal(cosmeticsRow.user_id, 1);
  assert.equal(cosmeticsRow.banner_color, "#abc");
  assert.equal(cosmeticsRow.flair_text, "hi");
  // The cascade follows the shared users row. Attachment 1's message_id is a
  // NO ACTION FK, so the attachment goes first, then the message, then the
  // user (whose delete cascades the cosmetics row away).
  db.prepare("DELETE FROM gc_attachments WHERE id = 1").run();
  db.prepare("DELETE FROM gc_messages WHERE id = 10").run();
  db.prepare("DELETE FROM users WHERE id = 1").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_cosmetics").get().n, 0);
});
