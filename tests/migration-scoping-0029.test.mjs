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
// fleet-boost shared table rides the 0024 canary law for its one rebuild —
// the gc_channels kind widening (a CHECK cannot be ALTERed) rebuilds through
// the RESTRICT canary's loud refusal on an FK-enforcing runner, the copy
// lists every column explicitly with ids preserved, the DROP sits by the
// ORIGINAL name after the copy and the final RENAME after the drop (the
// 0013→0014 hazard stays dead: children are never rewritten), and the 0001
// index is recreated verbatim on the final table. The shared table carries
// the gc_ prefix (tests/migration-scoping.test.mjs's creation law) and its
// deletion law is pinned in-schema: the author CASCADEs, the rendered
// card/channel SET-NULLs back to pending, and the partial UNIQUE index plus
// the both-or-neither stamp CHECK make one boost render at most one card.
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

test("the file is exactly eleven statements in the pinned rebuild order", () => {
  const list = migrationStatements();
  assert.equal(list.length, 11, `eleven statements expected, got ${list.length}`);
  assert.match(list[0], /^CREATE TABLE IF NOT EXISTS posts \(/);
  assert.match(list[1], /^CREATE TABLE gc_channels_fk_canary_0029 \(/);
  assert.match(list[2],
    /^INSERT INTO gc_channels_fk_canary_0029 \(channel_id\)\s+SELECT MIN\(id\) FROM gc_channels HAVING COUNT\(\*\) > 0$/);
  assert.match(list[3], /^CREATE TABLE gc_channels_rebuild\b/);
  assert.match(list[4], /^INSERT INTO gc_channels_rebuild\b/);
  assert.match(list[5], /^DROP TABLE gc_channels\b/);
  assert.match(list[6], /^ALTER TABLE gc_channels_rebuild RENAME TO gc_channels\b/);
  assert.match(list[7], /^CREATE INDEX idx_gc_channels_server\b/);
  assert.match(list[8], /^DROP TABLE gc_channels_fk_canary_0029/);
  assert.match(list[9], /^CREATE TABLE gc_fleet_boosts \(/);
  assert.match(list[10], /^CREATE UNIQUE INDEX idx_gc_fleet_boosts_mirror_once\b/);
  // The canary RESTRICTs (the loud-refusal lever on an FK-enforcing runner —
  // D1's engine silently fires CASCADE actions on DROP otherwise, verified
  // 2026-11-17) and it leaves with the rebuild.
  assert.match(list[1], /REFERENCES gc_channels\(id\) ON DELETE RESTRICT/);
});

test("no other gc_ table is touched and every DROP/RENAME operates on the rebuild pair", () => {
  const body = stripped(MIGRATION);
  assert.equal((body.match(/DROP TABLE/g) || []).length, 2);
  assert.equal((body.match(/RENAME TO/g) || []).length, 1);
  assert.doesNotMatch(body, /RENAME TO.*(pre|old)/);
  // The chat-style sentinel never appears; the boost table is the only new
  // gc_-prefixed creation.
  assert.equal(body.includes("chat_messages"), false);
  assert.equal(body.includes("gc_fleet_boosts"), true);
});

test("the gc_channels copy lists every column explicitly and preserves ids", () => {
  const copy = migrationStatements()[4];
  const expected =
    "id, server_id, name, kind, position, created_at, " +
    "last_message_id, last_message_at, is_spoiler, category_id, " +
    "slowmode_seconds, icon_media_id";
  assert.match(copy, new RegExp(`${expected}\\b[^;]*${expected}\\b`, "s"),
    "the copy lists the identical column set on both sides — no renumbering");
});

test("the rebuild's single delta is the kind widening: the rest of the shape matches the origin", () => {
  const rebuild = migrationStatements()[3];
  for (const fragment of [
    "id INTEGER PRIMARY KEY",
    "server_id INTEGER NULL REFERENCES gc_servers(id)",
    "name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100) DEFAULT 'dm'",
    // The widened row: 'announcement' joins the server-scoped kinds.
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
  // Exactly the two original CHECKs, both carrying the widened kind (the
  // kind CHECK and the paired scope CHECK) — no third constraint rides along.
  assert.equal((rebuild.match(/CHECK\(/g) || []).length, 2);
  assert.match(rebuild, /'announcement' AND server_id IS NOT NULL/);
  // The canary carries no CHECK of its own.
  const canary = migrationStatements()[1];
  assert.equal((canary.match(/CHECK\(/g) || []).length, 0);
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
  const create = migrationStatements()[9];
  assert.match(create, /forum_post_id INTEGER NOT NULL REFERENCES posts\(id\)/);
  assert.match(create, /author_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(create, /rendered_channel_id INTEGER NULL REFERENCES gc_channels\(id\) ON DELETE SET NULL/);
  assert.match(create, /rendered_message_id INTEGER NULL REFERENCES gc_messages\(id\) ON DELETE SET NULL/);
  assert.match(create, /CHECK\(\(rendered_channel_id IS NULL\) = \(rendered_message_id IS NULL\)/);
  const index = migrationStatements()[10];
  assert.match(index, /ON gc_fleet_boosts\(forum_post_id, rendered_channel_id\)/);
  assert.match(index, /WHERE rendered_message_id IS NOT NULL/);
});

test("the vendored posts copy rides IF NOT EXISTS with the forum ledger's canonical final shape", () => {
  const posts = migrationStatements()[0];
  assert.match(posts, /^CREATE TABLE IF NOT EXISTS posts \(/);
  // The body cap row is forum 0034's canonical final form (never re-widened
  // here — the forum ledger owns posts' shape truth).
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

// D1-class runner (0034-verified: D1's migrator does not enforce FKs during
// DDL), so the rebuild runs clean; the enforcing-runner refusal is its own pin.
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
  const rows = db.prepare("SELECT id, kind, slowmode_seconds FROM gc_channels ORDER BY id").all();
  assert.deepEqual(rows, [
    { id: 12, kind: "text", slowmode_seconds: 0 },
    { id: 13, kind: "text", slowmode_seconds: 0 },
  ]);
  // The widened kind round-trips through the rebuilt table's own CHECK.
  db.exec(`
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (14, 3, 'news', 'announcement', 2, 3);
  `);
  // A server-scoped kind can never take a NULL server.
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
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (13, 3, 'news', 'announcement', 0, 1);
  `);
  db.exec(MIGRATION);
  const boostColumns = db.prepare("PRAGMA table_info(gc_fleet_boosts)").all().map((c) => c.name);
  assert.deepEqual(boostColumns, [
    "id", "forum_post_id", "author_id", "thread_title", "thread_excerpt",
    "created_at", "rendered_channel_id", "rendered_message_id", "rendered_at",
  ]);
  db.exec(`
    INSERT INTO users (id, username) VALUES (3, 'author');
    INSERT INTO gc_fleet_boosts (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at)
      VALUES (1, 4242, 3, 't', 'e', 9), (2, 4242, 3, 't2', 'e2', 10);
  `);
  db.exec("UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 77, rendered_at = 10 WHERE id = 1");
  // A SECOND boost claiming the same (post, channel) render is un-representable.
  assert.throws(() => db.exec(
    "UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 88, rendered_at = 11 WHERE id = 2",
  ));
  // A ragged stamp (message cleared, timestamps left) is un-representable.
  assert.throws(() => db.exec(
    "UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = NULL, rendered_at = 10 WHERE id = 1",
  ));
});

// The FK-action pins ride an FK-ENFORCING runner — the actions themselves are
// exactly what the FK-ignoring class would skip. They need an EMPTY
// gc_channels at apply time (the canary's HAVING keeps the canary empty, so
// the enforced DROP passes cleanly); the announcement channel rides in after
// the rebuild.
const SEED_FK_ACTIVE = SEED.replace(
  "INSERT INTO gc_channels",
  "-- gc_channels intentionally empty at apply:\n    -- INSERT INTO gc_channels",
);

test("the author CASCADE deletes the boost and the card SET-NULLs back to pending", () => {
  const db = new DatabaseSync(":memory:"); // FK ON — the enforcing class
  db.exec(SEED_FK_ACTIVE);
  db.exec(`
    INSERT INTO users VALUES (1, 'wempos', NULL, 'member');
    INSERT INTO gc_servers VALUES (3);
  `);
  db.exec(MIGRATION);
  db.exec(`
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (13, 3, 'news', 'announcement', 0, 1);
    INSERT INTO gc_fleet_boosts (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at)
      VALUES (1, 4242, 1, 't', 'e', 9);
  `);
  db.exec("UPDATE gc_fleet_boosts SET rendered_channel_id = 13, rendered_message_id = 77, rendered_at = 10 WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_fleet_boosts").get().c, 1);
  // The card dies → the stamp SET-NULLs: the boost is pending again, never ghosting.
  db.exec("DELETE FROM gc_messages WHERE id = 77");
  const boost = db.prepare("SELECT * FROM gc_fleet_boosts WHERE id = 1").get();
  assert.equal(boost.rendered_channel_id, null);
  assert.equal(boost.rendered_message_id, null);
  assert.equal(boost.rendered_at, null);
  // The author dies → the boost dies with them (t64 §2 idiom).
  db.exec("DELETE FROM users WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM gc_fleet_boosts").get().c, 0);
});

test("an FK-enforcing runner refuses the populated DROP loudly (the canary's job)", () => {
  const db = new DatabaseSync(":memory:"); // FK ON — the enforcing class
  db.exec(SEED);
  db.exec(`
    INSERT INTO gc_servers VALUES (3);
    INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)
      VALUES (12, 3, 'ann', 'text', 0, 1);
  `);
  assert.throws(() => db.exec(MIGRATION), /FOREIGN KEY constraint failed/);
});
