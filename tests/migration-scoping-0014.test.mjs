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

// Migration 0014 scoping + REPAIR pin: the 0013 hazard's repair — the chunk
// table rebuilt onto the live parent. The frozen 0013 left
// gc_attachment_chunks' stored FK referencing the dropped
// "gc_attachments_pre_nitro" (pinned by the 0013 tests), which breaks every
// chunk INSERT on an FK-enforcing engine. This file's contract, verified on
// REAL SQLite across BOTH repair-time shapes:
//   - enforcement-ON at 0013 (production's actual route): the CASCADE ate the
//     chunk rows, so the repair copies an empty table AND repoints the FK —
//     inserts work after (the probe that failed against the broken state),
//   - enforcement-OFF at 0013 (the at-risk general shape): the chunk rows
//     SURVIVED the annihilation (their FK clause dangles instead) — the
//     repair preserves every row (count + value parity) and the CASCADE
//     still rides the live parent after the swap,
//   - and in both, the child's stored FK references the LIVE parent by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statementsOf } from "./migration-scoping.test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPAIR = readFileSync(path.join(HERE, "..", "migrations", "0014_attachment_fk_repair.sql"), "utf8");
const PRE_0013 = readFileSync(path.join(HERE, "..", "migrations", "0013_goober_plus_nitro.sql"), "utf8");

test("migration 0014 only targets gc_-prefixed objects, in the create → copy → rename → rename → drop order", () => {
  const names = [...REPAIR.replace(/--[^\n]*/g, "").matchAll(
    /\b(?:CREATE\s+TABLE|INSERT\s+INTO|FROM|REFERENCES)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/gi,
  )].map((m) => m[1].replace(/^"(.*)"$/, "$1"));
  assert.ok(names.length > 0, "parsed at least one table reference");
  for (const name of names) {
    assert.match(name, /^gc_/, "0014 only touches GooberCord objects: " + name);
  }
  // The repair's schema is the 0001 chunks schema with the LIVE parent FK.
  assert.match(REPAIR, /REFERENCES gc_attachments\(id\) ON DELETE CASCADE/);
  const stripped = REPAIR.replace(/--[^\n]*/g, "");
  for (const needle of [
    "CREATE TABLE gc_attachment_chunks_repair",
    "INSERT INTO gc_attachment_chunks_repair SELECT * FROM gc_attachment_chunks;",
    "ALTER TABLE gc_attachment_chunks RENAME TO gc_attachment_chunks_pre_repair;",
    "ALTER TABLE gc_attachment_chunks_repair RENAME TO gc_attachment_chunks;",
    "DROP TABLE gc_attachment_chunks_pre_repair;",
  ]) {
    assert.ok(stripped.includes(needle), "the repair keeps its step: " + needle);
  }
  assert.ok(stripped.indexOf("INSERT INTO") < stripped.indexOf("ALTER TABLE"), "copy before any rename");
  assert.ok(stripped.indexOf("DROP TABLE") > stripped.lastIndexOf("ALTER TABLE"), "drop is last");
});

// The pre-0013 world. node:sqlite's DatabaseSync enforces FKs (the same
// engine class as D1 — the dangling parent errors at INSERT time exactly the
// way the D1 probe did), so a shape that needs the 0013 drop to run WITHOUT
// enforcement toggles the pragma around the apply.
const BASE_SCHEMA = `
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
`;

// node:sqlite returns null-prototype rows; assert by fields.
function childFkTarget(db) {
  const childSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'gc_attachment_chunks'").get().sql;
  const match = /REFERENCES\s+["'`]?([\w]+)["'`]?/.exec(childSql);
  return { childSql, target: match ? match[1] : null };
}

function brokenPost0013Db({ foreignKeysOn } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA);
  if (foreignKeysOn === false) db.exec("PRAGMA foreign_keys = OFF");
  db.exec(PRE_0013);
  if (foreignKeysOn === false) db.exec("PRAGMA foreign_keys = ON");
  // Precondition pin: the frozen file's second hazard — the child schema now
  // references the dropped shell.
  assert.equal(childFkTarget(db).target, "gc_attachments_pre_nitro", "fixture precondition: the frozen 0013 left the dangling FK");
  return db;
}

function repairDb({ foreignKeysOn } = {}) {
  const db = brokenPost0013Db({ foreignKeysOn });
  db.exec(REPAIR);
  return db;
}

function attachmentRow(db, id) {
  db.prepare(
    "INSERT INTO gc_attachments (id, message_id, uploader_id, mime, size_bytes, created_at) VALUES (?, NULL, 1, 'image/png', 1000, 1)",
  ).run(Number(id));
}

function chunkInsert(db, attachmentId) {
  db.prepare(
    "INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (?, 0, x'AA')",
  ).run(Number(attachmentId));
}

test("real-SQLite (enforcement ON at 0013 — prod's route): the repair repoints the FK and chunk inserts WORK", () => {
  // The CASCADE ate the seeded chunk row under enforcement (the 0013
  // hazard), so the repair copies an EMPTY table here.
  const db = brokenPost0013Db({ foreignKeysOn: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks").get().n, 0, "fixture precondition: the 0013 cascade annihilated the chunks");

  db.exec(REPAIR);
  const { target } = childFkTarget(db);
  assert.equal(target, "gc_attachments", "the child's stored FK references the LIVE parent by name");

  // The probe that FAILED against the broken 0013 state now passes.
  attachmentRow(db, 5);
  chunkInsert(db, 5);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks WHERE attachment_id = 5").get().n, 1,
  );
  // The FK guard is the LIVE parent's, not a lost constraint: a chunk whose
  // attachment id does not exist still refuses.
  assert.throws(() => chunkInsert(db, 424242), /FOREIGN KEY/);
  // The CASCADE still deletes chunks with their parent.
  db.prepare("DELETE FROM gc_attachments WHERE id = 5").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks WHERE attachment_id = 5").get().n, 0,
    "the CASCADE wiring rides the live parent",
  );
  // Nothing dangles anywhere after the repair.
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0, "every FK resolves after the repair");
});

test("real-SQLite (enforcement OFF at 0013 — the at-risk shape): the repair PRESERVES the surviving chunks", () => {
  // With enforcement off at apply time, the 0013 drop annihilates NOTHING:
  // the parent rows copy through and the chunk rows survive with their FK
  // clause dangling at the dropped shell. This is the shape where the copy
  // must actually carry rows across.
  const db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(PRE_0013);
  // The surviving chunks seed while enforcement is OFF — the dangling FK
  // refuses the same writes the moment it is back on.
  db.prepare("INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (1, 0, x'0102')").run();
  db.prepare("INSERT INTO gc_attachment_chunks (attachment_id, seq, data) VALUES (1, 1, x'0304')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks").get().n, 2, "fixture precondition: no cascade with enforcement off");
  db.exec("PRAGMA foreign_keys = ON");
  assert.equal(childFkTarget(db).target, "gc_attachments_pre_nitro", "fixture precondition: the frozen 0013 left the dangling FK");
  db.exec(REPAIR);
  const { target } = childFkTarget(db);
  assert.equal(target, "gc_attachments", "the child's stored FK references the LIVE parent by name");

  // Row + value parity across the copy: both chunk rows, same ids, bytes.
  const rows = db.prepare("SELECT attachment_id, seq, data FROM gc_attachment_chunks ORDER BY seq").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.attachment_id, row.seq]), [[1, 0], [1, 1]]);
  assert.equal(rows[0].data instanceof Uint8Array ? rows[0].data.length : Buffer.from(rows[0].data).length, 2);
  // Nothing dangles anywhere after the repair.
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0, "every FK resolves after the repair");

  // The repaired table still enforces against the live parent.
  assert.throws(() => chunkInsert(db, 424242), /FOREIGN KEY/);
  db.prepare("DELETE FROM gc_attachments WHERE id = 1").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks").get().n, 0,
    "the CASCADE wiring rides the live parent after the copy",
  );
});

test("real-SQLite (empty table — prod's exact shape at apply): the swap repairs and inserts work", () => {
  // No attachment rows at all: the 0013 rebuild leaves everything empty and
  // dangling; the repair is the schema swap the empty production db needed.
  const db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA);   // the seed's message/attachment rows are dropped by
  // the repair-time shapes below only where the test needs them — for the
  // empty case, delete the rows instead of half-parsing the schema.
  db.exec("DELETE FROM gc_attachments; DELETE FROM gc_messages;");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(PRE_0013);
  db.exec("PRAGMA foreign_keys = ON");
  assert.equal(childFkTarget(db).target, "gc_attachments_pre_nitro");
  db.exec(REPAIR);
  assert.equal(childFkTarget(db).target, "gc_attachments", "the empty-table swap still repoints the FK");

  // The probe the 0013 state failed: insert into the repaired child, against
  // a parent row created AFTER the repair (uploads keep working).
  attachmentRow(db, 1);
  chunkInsert(db, 1);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.prepare("DELETE FROM gc_attachments WHERE id = 1").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gc_attachment_chunks WHERE attachment_id = 1").get().n, 0,
    "the CASCADE wiring survives the empty-table repair too",
  );
  void statementsOf;
});
