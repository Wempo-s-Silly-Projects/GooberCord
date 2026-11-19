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

// Migration 0018 scoping: the one-time DM import from the forum's shared
// tables. Owner ruling (Nov 16, 2026): DMs ONLY — the site-wide forum chat
// history stays in chat_messages untouched, so this migration must not know
// the table exists. The static pins hold that line (chat_messages appears in
// no statement, forum tables are read sources, every write lands on a gc_
// object), the real-SQLite pins hold the shape (kind-dm channels in the
// dedicated id band, two members each, messages preserved with source
// 'forum-dm', unread zeroed) and the re-run no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statementsOf, classify } from "./migration-scoping.test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(HERE, "..", "migrations", "0018_chat_import.sql");
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const stripped = (s) => s.replace(/--[^\n]*/g, " ").trim();

test("migration 0018 never mentions chat_messages", () => {
  const body = stripped(MIGRATION);
  assert.equal(body.includes("chat_messages"), false,
    "the DMs-only ruling forbids any chat_messages statement, even a read");
});

test("every write targets a gc_ object; forum tables stay read sources", () => {
  const unclassified = [];
  const writes = [];
  for (const statement of statementsOf(MIGRATION)) {
    const text = stripped(statement);
    if (!text) continue;
    const { form, targets } = classify(statement);
    if (form === "unrecognized") { unclassified.push(text.slice(0, 60)); continue; }
    for (const target of targets) assert.match(target, /^gc_/,
      `write target must be gc_-only: ${form} -> ${target}`);
    if (["INSERT INTO", "UPDATE", "DELETE FROM", "CREATE TABLE"].includes(form)) {
      writes.push(text);
    }
  }
  assert.equal(unclassified.length, 0, `unclassified: ${unclassified.join(" | ")}`);
  assert.ok(writes.length > 0, "the import performs writes");
  for (const forum of ["chat_messages", "dm_messages", "dm_threads", "users", "sessions"]) {
    for (const w of writes) {
      const intoTarget = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([\w"'.]+)/i.exec(w)?.[1] ?? "";
      assert.notEqual(intoTarget, forum, `forum table ${forum} is not a write target`);
      assert.doesNotMatch(w, new RegExp(`(?:UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE|CREATE\\s+INDEX)\\s+${forum}\\b`, "i"),
        `forum table ${forum} is never updated or created`);
    }
  }
});

test("one CREATE TABLE: the gc_chat_import_map ledger; channel names carry no sentinel", () => {
  const creates = statementsOf(MIGRATION).map(stripped).filter((s) => /^CREATE TABLE/i.test(s));
  assert.equal(creates.length, 1, "the map ledger is the only created table");
  assert.match(creates[0], /CREATE TABLE IF NOT EXISTS gc_chat_import_map/);
  assert.match(creates[0], /thread_id\s+INTEGER\s+PRIMARY\s+KEY\s+REFERENCES\s+dm_threads/);
  assert.equal(stripped(MIGRATION).includes("'dm-"), false,
    "channels insert as plain 'dm' — a stored sentinel name would surface as a custom name");
  assert.match(stripped(MIGRATION), /INSERT\s+OR\s+IGNORE\s+INTO\s+gc_messages\b[^;]+'import-dm-'\s*\|\|\s*msg\.id/s,
    "dm sentinels ride the (channel_id, author_id, client_message_id) UNIQUE key");
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE dm_threads (
      id INTEGER PRIMARY KEY,
      user_a INTEGER NOT NULL REFERENCES users(id),
      user_b INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      CHECK(user_a < user_b),
      UNIQUE(user_a, user_b));
    CREATE TABLE dm_messages (
      id INTEGER PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
      created_at INTEGER NOT NULL);
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE gc_channels (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NULL,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100) DEFAULT 'dm',
      kind TEXT NOT NULL CHECK(kind IN ('text','voice','dm','group')),
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_message_id INTEGER NULL,
      last_message_at INTEGER NULL);
    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
      client_message_id TEXT NULL CHECK(length(client_message_id) BETWEEN 8 AND 64),
      source TEXT NULL CHECK(source IN ('forum-chat','forum-dm') OR source IS NULL),
      created_at INTEGER NOT NULL,
      edited_at INTEGER NULL,
      UNIQUE(channel_id, author_id, client_message_id));
    CREATE TABLE gc_conversation_members (
      channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id, user_id));
    INSERT INTO users (id) VALUES (2), (3), (4), (5);
    INSERT INTO dm_threads (id, user_a, user_b, created_at) VALUES (5, 2, 3, 1000), (6, 3, 4, 1010);
    INSERT INTO dm_messages (id, thread_id, user_id, body, created_at) VALUES
      (400, 5, 2, 'the forum hello', 1200),
      (401, 5, 3, 'the forum reply', 1250),
      (402, 6, 4, 'untitled thread talk', 1300);
    INSERT INTO chat_messages (id, user_id, body, created_at) VALUES (1, 2, 'chat stays put', 900);
    INSERT INTO gc_channels (id, server_id, name, kind, created_at)
      VALUES (1, NULL, 'dm', 'dm', 500);
    INSERT INTO gc_conversation_members (channel_id, user_id) VALUES (1, 3), (1, 4);
  `);
  return db;
}

const snapshot = (db) => ({
  channels: db.prepare("SELECT * FROM gc_channels ORDER BY id").all().map((r) => ({ ...r })),
  messages: db.prepare("SELECT * FROM gc_messages ORDER BY id").all().map((r) => ({ ...r })),
  members: db.prepare("SELECT * FROM gc_conversation_members WHERE channel_id = 1 ORDER BY user_id").all(),
  map: db.prepare("SELECT * FROM gc_chat_import_map ORDER BY thread_id").all().map((r) => ({ ...r })),
  chatMessages: db.prepare("SELECT * FROM chat_messages ORDER BY id").all(),
  users: db.prepare("SELECT id FROM users ORDER BY id").all(),
});

test("real-SQLite: kind-dm channels in the band, two members, messages preserved as forum-dm, 0 unread", () => {
  const db = fixture();
  db.exec(MIGRATION);

  const imported = db.prepare(
    "SELECT id, server_id, name, kind, created_at, last_message_id, last_message_at FROM gc_channels WHERE id >= 1000000000 ORDER BY id").all();
  assert.deepEqual(
    imported.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind, serverId: r.server_id, createdAt: r.created_at, lastId: r.last_message_id, lastAt: r.last_message_at })),
    [
      { id: 1000000005, name: "dm", kind: "dm", serverId: null, createdAt: 1000, lastId: 2, lastAt: 1250 },
      { id: 1000000006, name: "dm", kind: "dm", serverId: null, createdAt: 1010, lastId: 3, lastAt: 1300 },
    ],
    "(1000000005 holds thread 5's two messages, so its last is the 1250 one; every channel maps by thread id + 1e9)",
  );

  const members = db.prepare(
    "SELECT channel_id AS channel, user_id AS user, last_read_message_id AS cursor FROM gc_conversation_members WHERE channel_id >= 1000000000 ORDER BY channel_id, user_id").all();
  assert.deepEqual(
    members.map((r) => `${r.channel}:${r.user}@${r.cursor}`),
    ["1000000005:2@2", "1000000005:3@2", "1000000006:3@3", "1000000006:4@3"],
    "both members land per channel; the read cursor sits at the channel's last import (0 unread)",
  );

  const msgs = db.prepare("SELECT * FROM gc_messages ORDER BY id").all();
  assert.deepEqual(
    msgs.map((m) => ({ channel: m.channel_id, author: m.author_id, body: m.body, sentinel: m.client_message_id, source: m.source, createdAt: m.created_at })),
    [
      { channel: 1000000005, author: 2, body: "the forum hello", sentinel: "import-dm-400", source: "forum-dm", createdAt: 1200 },
      { channel: 1000000005, author: 3, body: "the forum reply", sentinel: "import-dm-401", source: "forum-dm", createdAt: 1250 },
      { channel: 1000000006, author: 4, body: "untitled thread talk", sentinel: "import-dm-402", source: "forum-dm", createdAt: 1300 },
    ],
    "bodies, authors and created_at ride through with source 'forum-dm'; gc ids stay gc-autoincrement",
  );

  const map = db.prepare("SELECT thread_id AS thread, channel_id AS channel FROM gc_chat_import_map ORDER BY thread_id").all()
    .map((r) => ({ thread: Number(r.thread), channel: Number(r.channel) }));
  assert.deepEqual(map, [
    { thread: 5, channel: 1000000005 },
    { thread: 6, channel: 1000000006 },
  ]);

  // Pre-existing GC dm channel is untouched by the import.
  const live = db.prepare("SELECT id, name, kind FROM gc_channels WHERE id = 1").get();
  assert.equal(live.name, "dm");

  // The ruling: chat_messages is readable by nobody in GC — untouched.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_messages WHERE source = 'forum-chat'").get().n, 0);
  db.close();
});

test("real-SQLite: a full re-run is a no-op", () => {
  const db = fixture();
  db.exec(MIGRATION);
  const before = snapshot(db);
  db.exec(MIGRATION);
  const after = snapshot(db);
  assert.deepEqual(after, before, "re-applying 0018 changes nothing");
  db.close();
});

test("real-SQLite: a crash between channel and map insert backfills, never duplicates", () => {
  const db = fixture();
  db.exec(MIGRATION);
  // Simulate the partial state: the channel survives, the map ledger row is lost.
  db.exec("DELETE FROM gc_chat_import_map WHERE thread_id = 5");
  const before = db.prepare("SELECT COUNT(*) AS n FROM gc_channels WHERE id >= 1000000000").get().n;
  db.exec(MIGRATION);
  const after = db.prepare("SELECT COUNT(*) AS n FROM gc_channels WHERE id >= 1000000000").get().n;
  assert.equal(after, before, "the id-band guard stops a duplicate channel insert");
  const row = db.prepare("SELECT channel_id AS c FROM gc_chat_import_map WHERE thread_id = 5").get();
  assert.equal(Number(row.c), 1000000005, "the map ledger backfills by the deterministic id");
  db.close();
});
