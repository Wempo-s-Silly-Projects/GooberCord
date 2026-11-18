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
// see <https://www.gnu.org/licenses/>.

// Migration 0035 scoping (board row FK35): gc_fleet_boosts.forum_post_id
// gains ON DELETE CASCADE — the ecc-security finding (a forum post delete
// at api/posts-write.mjs:444 raising a runtime FK failure against the bare
// NO-ACTION forum_target 0029 shipped). The upgrade the 0029 suite's pin
// shape needed: a REAL enforced-FK regression row (delete the forum post,
// the boost child row must cascade in an FK-ON local runner) riding an
// enforcement live-ness pin, because FK enforcement engages only where the
// seed child tables carry REFERENCES clauses — a runner silently without
// foreign keys would green a cascade pin against a no-op DELETE. Static
// pins cover the five-statement rebuild shape; runtime pins cover both
// engine classes, the surviving index, and the cascade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MIGRATION = readFileSync(
  path.join(ROOT, "migrations", "0035_fleet_boosts_fk_cascade.sql"),
  "utf8",
);
const MIGRATION_0029 = readFileSync(
  path.join(ROOT, "migrations", "0029_fleet_boosts.sql"),
  "utf8",
);

function migrationStatements() {
  const parts = MIGRATION.replace(/--[^\n]*/g, "").split(";");
  return parts.map((p) => p.trim()).filter(Boolean);
}

// --- the static pins -------------------------------------------------------------

test("the file is exactly five statements in the pinned rebuild order", () => {
  const list = migrationStatements();
  assert.equal(list.length, 5, `five statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE gc_fleet_boosts_rebuild \(/);
  assert.match(list[1], /^INSERT INTO gc_fleet_boosts_rebuild\b/);
  assert.match(list[2], /^DROP TABLE gc_fleet_boosts\b/);
  assert.match(list[3], /^ALTER TABLE gc_fleet_boosts_rebuild RENAME TO gc_fleet_boosts\b/);
  assert.match(list[4], /^CREATE UNIQUE INDEX idx_gc_fleet_boosts_mirror_once\b/);
});

test("the rebuilt DDL carries the cascade fix and 0029's unchanged deletion law", () => {
  const create = migrationStatements()[0];
  assert.match(create, /forum_post_id INTEGER NOT NULL REFERENCES posts\(id\) ON DELETE CASCADE/);
  assert.match(create, /author_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(create, /rendered_channel_id INTEGER NULL REFERENCES gc_channels\(id\) ON DELETE SET NULL/);
  assert.match(create, /rendered_message_id INTEGER NULL REFERENCES gc_messages\(id\) ON DELETE SET NULL/);
  assert.equal((create.match(/\bREFERENCES\b/g) || []).length, 4, "exactly the four FKs ride");
  assert.equal((create.match(/CHECK\(/g) || []).length, 0, "no pair CHECK before or after");
});

test("the copy names all eight columns on both sides and the index is recreated verbatim", () => {
  const copy = migrationStatements()[1];
  const columns = [
    "id", "forum_post_id", "author_id", "thread_title", "thread_excerpt",
    "created_at", "rendered_channel_id", "rendered_message_id",
  ];
  assert.match(copy, /INSERT INTO gc_fleet_boosts_rebuild\s+\(id, forum_post_id, author_id, thread_title, thread_excerpt, created_at,\s+rendered_channel_id, rendered_message_id\)/);
  assert.match(copy, /SELECT id, forum_post_id, author_id, thread_title, thread_excerpt, created_at,\s+rendered_channel_id, rendered_message_id\s+FROM gc_fleet_boosts\b/);
  const index = migrationStatements()[4];
  assert.match(index, /ON gc_fleet_boosts\(forum_post_id, rendered_channel_id\)/);
  assert.match(index, /WHERE rendered_message_id IS NOT NULL/);
  // The index is recreated AFTER the rename (the drop takes the old one).
  const dropAt = MIGRATION.indexOf("DROP TABLE gc_fleet_boosts;");
  const renameAt = MIGRATION.indexOf("ALTER TABLE gc_fleet_boosts_rebuild RENAME");
  assert.ok(dropAt !== -1 && renameAt !== -1 && MIGRATION.indexOf("CREATE UNIQUE INDEX") > renameAt && dropAt < renameAt);
});

// --- the runtime pins -------------------------------------------------------------
// Mirrors the 0029 scoping suite's seed (tests/migration-scoping-0029.test.mjs):
// the same child tables the 0029 file's rebuild statements touch, with the
// REFERENCES clauses that make an FK-ON runner actually enforce.

const SEED = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, accent_color TEXT, role TEXT);
  CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
  CREATE TABLE gc_channel_categories (id INTEGER PRIMARY KEY, server_id INTEGER);
  CREATE TABLE gc_messages (id INTEGER PRIMARY KEY, channel_id INTEGER,
    author_id INTEGER, body TEXT, client_message_id TEXT, created_at INTEGER);
  CREATE TABLE gc_mentions (message_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    created_at INTEGER, PRIMARY KEY(message_id, user_id));
  CREATE TABLE gc_message_reactions (message_id INTEGER, user_id INTEGER, value TEXT,
    id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE gc_conversation_members (channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(channel_id, user_id));
  CREATE TABLE gc_channel_overwrites (id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER, allow_mask INTEGER NOT NULL DEFAULT 0, deny_mask INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE gc_filter_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER,
    channel_id INTEGER, message_id INTEGER, user_id INTEGER, created_at INTEGER);
  CREATE TABLE gc_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NULL, uploader_id INTEGER NOT NULL);
  CREATE TABLE gc_channels (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NULL REFERENCES gc_servers(id),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100) DEFAULT 'dm',
    kind TEXT NOT NULL CHECK(kind IN ('text','voice','dm','group')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_message_id INTEGER NULL,
    last_message_at INTEGER NULL
  );
  ALTER TABLE gc_channels ADD COLUMN is_spoiler INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE gc_channels ADD COLUMN category_id INTEGER NULL
    REFERENCES gc_channel_categories(id) ON DELETE SET NULL;
  ALTER TABLE gc_channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE gc_channels ADD COLUMN icon_media_id INTEGER NULL;
`;

function d1ClassRunner() {
  return new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
}

// The chain base: SEED then 0029 (its vendored posts copy is the posts table
// every later arm needs), then the boost rows the arm drives.
function seedChain(db, seedBoosts) {
  db.exec(SEED);
  db.exec(MIGRATION_0029);
  db.exec(`
    INSERT INTO users VALUES (1, 'wempos', NULL, 'member'), (3, 'author', NULL, 'member');
    INSERT INTO gc_servers VALUES (3);
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (12, 3, 'ann', 'text', 0, 1), (13, 3, 'news', 'announcement', 1, 2);
    INSERT INTO gc_messages (id, channel_id, author_id, body, client_message_id, created_at) VALUES
      (101, 13, 3, 'card', 'boost-1-c13', 5);
    INSERT INTO posts (id, author_id, body, created_at) VALUES
      (8, 3, 'kept', 1), (9, 3, 'doomed', 2);
  `);
  db.exec(`
    INSERT INTO gc_fleet_boosts (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at, rendered_channel_id, rendered_message_id)
      VALUES (1, 8, 3, 'kept', 'e', 9, NULL, NULL),
             (2, 9, 3, 'doomed', 'e', 10, 13, 101);
  `);
  if (seedBoosts) seedBoosts(db);
}

test("an enforced-FK runner is actually enforcing (the live-ness pin)", () => {
  const db = new DatabaseSync(":memory:"); // FK ON — the enforced class
  seedChain(db);
  assert.throws(() => db.exec(
    "INSERT INTO gc_fleet_boosts (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at) " +
    "VALUES (9, 999, 3, 'ghost', 'e', 1)",
  ), /FOREIGN KEY constraint failed/);
});

test("deleting the forum post cascades its boost rows in an enforced-FK local D1", () => {
  const db = new DatabaseSync(":memory:"); // FK ON — the enforced class
  seedChain(db);
  db.exec(MIGRATION);
  // Pre-state survives the rebuild whole: both rows, same stamps.
  assert.deepEqual(
    { ...db.prepare("SELECT COUNT(*) AS n FROM gc_fleet_boosts").get() },
    { n: 2 },
  );
  // The regression row: delete the boosted post, the boost row is gone.
  db.exec("DELETE FROM posts WHERE id = 9");
  assert.deepEqual(
    db.prepare("SELECT id, forum_post_id FROM gc_fleet_boosts ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: 1, forum_post_id: 8 }],
  );
  // The untouched post's boost survives the unrelated delete.
  db.exec("DELETE FROM posts WHERE id = 8");
  assert.deepEqual(
    { ...db.prepare("SELECT COUNT(*) AS n FROM gc_fleet_boosts").get() },
    { n: 0 },
  );
});

test("the row copy preserves ids and stamps in BOTH engine classes", () => {
  const d1 = d1ClassRunner();
  seedChain(d1);
  const before29 = () => d1.prepare(
    "PRAGMA table_info(gc_fleet_boosts)",
  ).all().map((c) => c.name);
  const columns = before29();
  d1.exec(MIGRATION);
  assert.deepEqual(d1.prepare("PRAGMA table_info(gc_fleet_boosts)").all().map((c) => c.name), columns);
  const rows = d1.prepare(
    "SELECT id, forum_post_id, author_id, thread_title, thread_excerpt, created_at, rendered_channel_id, rendered_message_id " +
    "FROM gc_fleet_boosts ORDER BY id",
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: 1, forum_post_id: 8, author_id: 3, thread_title: "kept", thread_excerpt: "e", created_at: 9, rendered_channel_id: null, rendered_message_id: null },
    { id: 2, forum_post_id: 9, author_id: 3, thread_title: "doomed", thread_excerpt: "e", created_at: 10, rendered_channel_id: 13, rendered_message_id: 101 },
  ]);
  const on = new DatabaseSync(":memory:"); // FK ON
  seedChain(on);
  on.exec(MIGRATION);
  const onRows = on.prepare(
    "SELECT id, forum_post_id, author_id, thread_title, thread_excerpt, created_at, rendered_channel_id, rendered_message_id " +
    "FROM gc_fleet_boosts ORDER BY id",
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(onRows, rows);
});

test("the partial UNIQUE index survived under its 0029 name and still refuses the second card", () => {
  const db = d1ClassRunner();
  seedChain(db);
  db.exec(MIGRATION);
  const indexes = db.prepare("PRAGMA index_list(gc_fleet_boosts)").all().map((row) => ({ ...row }));
  assert.ok(indexes.some((index) => index.name === "idx_gc_fleet_boosts_mirror_once"));
  // Pending rows never race their own index; a rendered pair does.
  db.exec("UPDATE gc_fleet_boosts SET rendered_channel_id = 13 WHERE id = 1");
  db.exec("UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 77 WHERE id = 1");
  assert.throws(() => db.exec(
    "UPDATE gc_fleet_boosts SET forum_post_id = 9 WHERE id = 1",
  ));
});
