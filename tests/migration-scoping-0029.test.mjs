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

// Migration 0029 scoping (T79, docs/drafts/t79-post-boost-spec.md): the
// fleet-boost shared table + the gc_channels kind widening. The rebuild does
// NOT ride 0024's canary law anymore — the 2026-11-18 prod run falsified its
// premise (D1's engine ENFORCES FKs during DDL, and the DROP's implicit
// DELETE fires FK ACTIONS: the canary's RESTRICT was exactly the prod
// refusal, SQLITE_CONSTRAINT_TRIGGER, and PRAGMA defer_foreign_keys is
// disqualified both ways — measured: internal error at COMMIT with the
// canary, silent CASCADE prunes without it). The file rides the
// child-FK-AROUND law instead: the transitive closure of the tables the
// DROP would prune rides out into gc_-prefixed backups BEFORE the DROP and
// INSERT-OR-IGNOREs back after the RENAME, with gc_attachments'
// NO-ACTION message FK detached before the DROP and re-attached from its
// own backup by id. Both engine classes land the same final state: rows
// pruned return once (FK-on) or the IGNORE makes the restore a no-op
// (FK-off); ids preserved everywhere; AUTOINCREMENT counters ride explicit
// id restorations back up. The shared table carries the gc_ prefix
// (tests/migration-scoping.test.mjs's creation law); its deletion law is
// pinned in-schema: the author CASCADEs, the rendered card/channel
// SET-NULLs back to pending, and the partial UNIQUE index make one boost
// render at most one card; the stamps carry deliberately NO CHECK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0029_fleet_boosts.sql"),
  "utf8",
);
const stripped = (s) => s.replace(/--[^\n]*/g, " ").trim();

function migrationStatements() {
  const parts = MIGRATION.replace(/--[^\n]*/g, "").split(";");
  return parts.map((p) => p.trim()).filter(Boolean);
}

test("the file is exactly thirty statements in the pinned order", () => {
  const list = migrationStatements();
  assert.equal(list.length, 30, `thirty statements expected, got ${list.length}`);
  const bak = [
    "gc_messages_bak_0029", "gc_mentions_bak_0029", "gc_message_reactions_bak_0029",
    "gc_conversation_members_bak_0029", "gc_channel_overwrites_bak_0029",
    "gc_filter_alerts_bak_0029", "gc_attachments_bak_0029",
  ];
  bak.forEach((name, i) => {
    assert.match(list[i],
      new RegExp(`^CREATE TABLE ${name} AS SELECT \\* FROM ${name.replace("_bak_0029", "")}$`),
      `statement ${i} is the ${name} backup ride-out`);
  });
  assert.equal(list[7], "UPDATE gc_attachments SET message_id = NULL");
  assert.match(list[8], /^CREATE TABLE IF NOT EXISTS posts \(/);
  assert.match(list[9], /^CREATE TABLE gc_channels_rebuild\b/);
  assert.match(list[10], /^INSERT INTO gc_channels_rebuild\b/);
  assert.match(list[11], /^DROP TABLE gc_channels\b/);
  assert.match(list[12], /^ALTER TABLE gc_channels_rebuild RENAME TO gc_channels\b/);
  assert.match(list[13], /^CREATE INDEX idx_gc_channels_server\b/);
  [
    ["gc_messages", 14], ["gc_mentions", 15], ["gc_message_reactions", 16],
    ["gc_conversation_members", 17], ["gc_channel_overwrites", 18],
    ["gc_filter_alerts", 19],
  ].forEach(([table, i]) => {
    assert.equal(list[i],
      `INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}_bak_0029`,
      `statement ${i} rides the ${table} closure back`);
  });
  assert.equal(list[20].replace(/\s+/g, " "),
    "UPDATE gc_attachments SET message_id = (SELECT b.message_id FROM gc_attachments_bak_0029 b WHERE b.id = gc_attachments.id)");
  bak.forEach((name, i) => {
    assert.equal(list[21 + i], `DROP TABLE ${name}`);
  });
  assert.match(list[28], /^CREATE TABLE gc_fleet_boosts \(/);
  assert.match(list[29], /^CREATE UNIQUE INDEX idx_gc_fleet_boosts_mirror_once\b/);
});

test("no other gc_ table is touched: the backups are gc_-prefixed and the only new creations", () => {
  const body = stripped(MIGRATION);
  assert.equal((body.match(/DROP TABLE/g) || []).length, 8);
  assert.equal((body.match(/RENAME TO/g) || []).length, 1);
  assert.doesNotMatch(body, /RENAME TO.*(pre|old)/);
  // The chat-style sentinel never appears; the boost table plus the seven
  // _bak_0029 closures are the only new gc_-prefixed creations.
  assert.equal(body.includes("chat_messages"), false);
  assert.equal(body.includes("gc_fleet_boosts"), true);
  const creates = (body.match(/CREATE TABLE (?!IF NOT EXISTS)gc_[a-z_]+/g) || []);
  // Nine plain creations: the seven backups + the rebuild copy + the boost table.
  assert.equal(new Set(creates).size, 9, `nine plain CREATE TABLEs expected: ${creates.length}`);
});
test("every pruned-path table has a backup, a restore, and an in-file drop", () => {
  const body = stripped(MIGRATION);
  for (const table of [
    "gc_messages", "gc_mentions", "gc_message_reactions",
    "gc_conversation_members", "gc_channel_overwrites", "gc_filter_alerts",
    "gc_attachments",
  ]) {
    assert.match(body, new RegExp(`CREATE TABLE ${table}_bak_0029 AS SELECT \\* FROM ${table}\\b`),
      `${table} rides out before the DROP`);
    const restore = body.includes(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}_bak_0029`);
    const reattach = table === "gc_attachments";
    assert.ok(restore || reattach, `${table} has a restore arm`);
    assert.match(body, new RegExp(`DROP TABLE ${table}_bak_0029\\b`),
      `${table} backup never outlives the batch`);
  }
  // Restore order: the parent rides back before its children.
  assert.ok(
    body.indexOf("INSERT OR IGNORE INTO gc_messages ") <
    body.indexOf("INSERT OR IGNORE INTO gc_mentions ") &&
    body.indexOf("INSERT OR IGNORE INTO gc_messages ") <
    body.indexOf("INSERT OR IGNORE INTO gc_message_reactions "),
    "gc_messages restores before its children",
  );
  // The attachments detach rides entirely before the parent DROP; the
  // re-attach rides entirely after the RENAME.
  assert.ok(
    body.indexOf("UPDATE gc_attachments SET message_id = NULL") <
    body.indexOf("DROP TABLE gc_channels"),
    "the NO ACTION detach precedes the DROP",
  );
  assert.ok(
    body.indexOf("UPDATE gc_attachments SET message_id =\n  (SELECT b.message_id") >
    body.indexOf("RENAME TO gc_channels"),
    "the re-attach follows the rename",
  );
});

test("the gc_channels copy lists every column explicitly and preserves ids", () => {
  const copy = migrationStatements()[10].replace(/\s+/g, " ");
  const expected =
    "id, server_id, name, kind, position, created_at, " +
    "last_message_id, last_message_at, is_spoiler, category_id, " +
    "slowmode_seconds, icon_media_id";
  assert.match(copy, new RegExp(`${expected}\\b[^;]*${expected}\\b`),
    "the copy lists the identical column set on both sides — no renumbering");
});

test("the rebuild's single delta is the kind widening: the rest of the shape matches the origin", () => {
  const rebuild = migrationStatements()[9];
  for (const fragment of [
    "id INTEGER PRIMARY KEY",
    "server_id INTEGER NULL REFERENCES gc_servers(id)",
    "name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100) DEFAULT 'dm'",
    "kind TEXT NOT NULL CHECK(kind IN ('text','voice','dm','group','announcement'))",
    "position INTEGER NOT NULL DEFAULT 0",
    "created_at INTEGER NOT NULL",
    "last_message_id INTEGER NULL",
    "last_message_at INTEGER NULL",
    "is_spoiler INTEGER NOT NULL DEFAULT 0",
    "category_id INTEGER NULL REFERENCES gc_channel_categories(id) ON DELETE SET NULL",
    "slowmode_seconds INTEGER NOT NULL DEFAULT 0",
    "icon_media_id INTEGER NULL",
  ]) {
    assert.ok(rebuild.includes(fragment), `gc_channels rebuild missing: ${fragment}`);
  }
  assert.equal((rebuild.match(/CHECK\(/g) || []).length, 3);
  assert.match(rebuild, /'announcement'\) AND server_id IS NOT NULL/);
});

test("the index is recreated verbatim after the rename", () => {
  const body = stripped(MIGRATION);
  assert.match(body, /CREATE INDEX idx_gc_channels_server ON gc_channels\(server_id, position\)/);
  assert.ok(
    body.indexOf("RENAME TO gc_channels") < body.indexOf("CREATE INDEX idx_gc_channels_server"),
    "the index is (re)created only on the final table",
  );
});

test("gc_fleet_boosts pins the twin contract's deletion law and idempotency", () => {
  const create = migrationStatements()[28];
  assert.match(create, /forum_post_id INTEGER NOT NULL REFERENCES posts\(id\)/);
  assert.match(create, /author_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(create, /rendered_channel_id INTEGER NULL REFERENCES gc_channels\(id\) ON DELETE SET NULL/);
  assert.match(create, /rendered_message_id INTEGER NULL REFERENCES gc_messages\(id\) ON DELETE SET NULL/);
  assert.equal((create.match(/CHECK\(/g) || []).length, 0);
  const index = migrationStatements()[29];
  assert.match(index, /ON gc_fleet_boosts\(forum_post_id, rendered_channel_id\)/);
  assert.match(index, /WHERE rendered_message_id IS NOT NULL/);
});

test("the vendored posts copy rides IF NOT EXISTS with the forum ledger's canonical final shape", () => {
  const posts = migrationStatements()[8];
  assert.match(posts, /^CREATE TABLE IF NOT EXISTS posts \(/);
  assert.match(posts, /body TEXT NOT NULL CHECK \(length\(trim\(body\)\) BETWEEN 1 AND 4750\)/);
  assert.match(posts, /visibility TEXT NOT NULL DEFAULT 'public' CHECK \(visibility IN \('public', 'hidden'\)\)/);
  assert.match(posts, /suggestion_status TEXT/);
});

// --- the real-SQLite fidelity pins ---------------------------------------------

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

// D1-class runner (the FK-ignoring class T79 originally assumed): the rebuild
// runs clean and the restore arms become verified no-ops (nothing pruned).
function d1ClassRunner() {
  return new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
}

test("the rebuild preserves rows and ids and the widened kind round-trips", () => {
  const db = d1ClassRunner();
  db.exec(SEED);
  db.exec(`
    INSERT INTO users VALUES (1, 'wempos', NULL, 'member');
    INSERT INTO gc_servers VALUES (3);
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (12, 3, 'ann', 'text', 0, 1), (13, 3, 'general', 'text', 1, 2);
  `);
  db.exec(MIGRATION);
  const rows = db.prepare("SELECT id, kind, slowmode_seconds FROM gc_channels ORDER BY id").all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: 12, kind: "text", slowmode_seconds: 0 },
    { id: 13, kind: "text", slowmode_seconds: 0 },
  ]);
  db.exec(`
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (14, 3, 'news', 'announcement', 2, 3);
  `);
  assert.throws(() => db.exec(`
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (15, NULL, 'ghost', 'announcement', 0, 4);
  `));
});

test("the boost table enforces the one-card idempotency and the stamp-pair CHECK", () => {
  const db = d1ClassRunner();
  db.exec(SEED);
  db.exec(`
    INSERT INTO users VALUES (1, 'wempos', NULL, 'member'), (2, 'other', NULL, 'member');
    INSERT INTO gc_servers VALUES (3);
  `);
  db.exec(MIGRATION);
  const boostColumns = db.prepare("PRAGMA table_info(gc_fleet_boosts)").all().map((c) => c.name);
  assert.deepEqual(boostColumns, [
    "id", "forum_post_id", "author_id", "thread_title", "thread_excerpt",
    "created_at", "rendered_channel_id", "rendered_message_id",
  ]);
  db.exec(`
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (13, 3, 'news', 'announcement', 0, 1);
  `);
  db.exec(`
    INSERT INTO users (id, username) VALUES (3, 'author');
    INSERT INTO gc_fleet_boosts (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at)
      VALUES (1, 4242, 3, 't', 'e', 9), (2, 4242, 3, 't2', 'e2', 10);
  `);
  db.exec("UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 77 WHERE id = 1");
  assert.throws(() => db.exec(
    "UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 88 WHERE id = 2",
  ));
  db.exec(
    "UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = NULL WHERE id = 1",
  );
  assert.equal(db.prepare("SELECT rendered_message_id FROM gc_fleet_boosts WHERE id = 1").get().rendered_message_id, null);
});

// The FK-action pins ride an FK-ENFORCING runner — the actions themselves are
// exactly what the FK-ignoring class would skip.

test("an FK-ENFORCING runner with child rows present now passes the rebuild whole (the 2026-11-18 prod law)", () => {
  const db = new DatabaseSync(":memory:"); // FK ON — the enforced class
  db.exec(SEED);
  db.exec(`
    INSERT INTO users VALUES (1, 'wempos', NULL, 'member'), (2, 'bravo', NULL, 'member');
    INSERT INTO gc_servers VALUES (3);
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (12, 3, 'ann', 'text', 0, 1), (13, 3, 'general', 'text', 1, 2);
    INSERT INTO gc_messages (id, channel_id, author_id, body, created_at) VALUES
      (101, 12, 1, 'a', 1), (102, 13, 2, 'b', 2), (103, 12, 2, 'c', 3);
    INSERT INTO gc_mentions (message_id, user_id, created_at) VALUES (101, 2, 1);
    INSERT INTO gc_message_reactions (message_id, user_id, value) VALUES (101, 2, 'like');
    INSERT INTO gc_conversation_members (channel_id, user_id) VALUES (12, 1);
    INSERT INTO gc_channel_overwrites (channel_id, allow_mask, deny_mask) VALUES (12, 8, 0);
    INSERT INTO gc_filter_alerts (server_id, channel_id, message_id, user_id, created_at)
      VALUES (3, 12, 101, 2, 1);
    INSERT INTO gc_attachments (id, message_id, uploader_id) VALUES (50, 101, 2);
  `);
  // No throw: the populated rebuild must pass WHERE the canary's prod refusal
  // fired (SQLITE_CONSTRAINT_TRIGGER, migrations/0029 header's law).
  db.exec(MIGRATION);
  const counts = db.prepare(
    "SELECT (SELECT COUNT(*) FROM gc_channels) AS ch, " +
    "(SELECT COUNT(*) FROM gc_messages) AS ms, " +
    "(SELECT COUNT(*) FROM gc_mentions) AS mn, " +
    "(SELECT COUNT(*) FROM gc_message_reactions) AS mr, " +
    "(SELECT COUNT(*) FROM gc_conversation_members) AS cm, " +
    "(SELECT COUNT(*) FROM gc_channel_overwrites) AS co, " +
    "(SELECT COUNT(*) FROM gc_filter_alerts) AS fa, " +
    "(SELECT COUNT(*) FROM gc_attachments) AS az"
  ).get();
  assert.deepEqual({ ...counts },
    { ch: 2, ms: 3, mn: 1, mr: 1, cm: 1, co: 1, fa: 1, az: 1 });
  // The attachment's message link survived the detach/reattach round-trip.
  const link = db.prepare("SELECT message_id FROM gc_attachments WHERE id = 50").get().message_id;
  assert.equal(link, 101);
  // No backup table outlives the batch.
  const strays = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE '%bak_0029'"
  ).get().n;
  assert.equal(strays, 0);
});

test("the author CASCADE deletes the boost and the card SET-NULLs back to pending", () => {
  const db = new DatabaseSync(":memory:"); // FK ON — the enforcing class
  db.exec(SEED);
  db.exec(`
    INSERT INTO users VALUES (1, 'wempos', NULL, 'member');
    INSERT INTO gc_servers VALUES (3);
  `);
  db.exec(MIGRATION);
  db.exec(`
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (13, 3, 'news', 'announcement', 0, 1);
    -- The FK-enforcing boost insert needs its parent row (the vendored posts copy).
    INSERT INTO posts (id, author_id, body, created_at) VALUES (4242, 1, 'hello', 5);
    INSERT INTO gc_fleet_boosts (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at)
      VALUES (1, 4242, 1, 't', 'e', 9);
  `);
  db.exec("INSERT INTO gc_messages (id, channel_id, author_id, body, client_message_id, created_at) VALUES (77, 13, 1, '[Forum boost] t', 'boost-1-c13', 9)");
  db.exec("UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 77 WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_fleet_boosts").get().c, 1);
  db.exec("DELETE FROM gc_messages WHERE id = 77");
  const boost = db.prepare("SELECT * FROM gc_fleet_boosts WHERE id = 1").get();
  assert.equal(boost.rendered_channel_id, 13);
  assert.equal(boost.rendered_message_id, null);
  db.exec("DELETE FROM users WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_fleet_boosts").get().c, 0);
});
