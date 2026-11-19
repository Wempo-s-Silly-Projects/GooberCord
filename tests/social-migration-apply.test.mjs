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

// Real-SQLite apply probe for migration 0009: the social batch under the
// shared-ledger contract. Two paths are pinned — the production order
// (0001 → … → 0008 → 0009) and the INDEPENDENCE order (0006 → 0009 → 0007 →
// 0008, the later-migrations independence the file's header claims). The
// CHECKs and the prefs-row default are live constraints, not just doc text.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statementsOf } from "./migration-scoping.test.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// The gc_-prefixed migrations' apply order (the vendored forum-side files
// carry tables this probe does not need; users/gc_channels/gc_messages ride
// 0001/0002's CREATEs and 0002's users shape is skipped entirely).
const PROBE_FILES = [
  "0001_initial_goobercord.sql",
  "0006_roles.sql",
  "0007_layers.sql",
  "0008_mod_desk.sql",
];

function apply(db, files, extra = null) {
  for (const file of files) {
    for (const statement of statementsOf(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))) {
      db.exec(statement);
    }
  }
  if (extra) {
    for (const statement of statementsOf(readFileSync(path.join(MIGRATIONS_DIR, extra), "utf8"))) {
      db.exec(statement);
    }
  }
}

// The minimal users shape the FKs need (the vendored 0002's users carries the
// full forum columns; this probe pins the SOCIAL objects, not those).
const USERS_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL,
    accent_color TEXT, created_at INTEGER NOT NULL);
`;

test("0009 applies after the full ledger and its CHECKs are live", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(USERS_SQL);
  apply(db, PROBE_FILES, "0009_social.sql");
  db.exec(
    "INSERT INTO users (id, username, role, created_at) VALUES" +
      " (1, 'a', 'member', 1), (2, 'b', 'member', 1), (3, 'c', 'member', 1);",
  );
  // The canonical-pair CHECK: (2, 1) is refused; (1, 2) stores.
  assert.throws(() => db.exec(
    "INSERT INTO gc_friends (user_a_id, user_b_id, created_at) VALUES (2, 1, 1);",
  ));
  db.exec("INSERT INTO gc_friends (user_a_id, user_b_id, created_at) VALUES (1, 2, 5);");
  assert.equal(db.prepare("SELECT created_at FROM gc_friends").get().created_at, 5);
  // The two-kind CHECK + the block row's PK pair.
  assert.throws(() => db.exec(
    "INSERT INTO gc_blocks (blocker_id, blocked_id, kind, created_at) VALUES (1, 2, 'muted', 1);",
  ));
  db.exec("INSERT INTO gc_blocks (blocker_id, blocked_id, kind, created_at) VALUES (1, 2, 'ignored', 6);");
  // The reaction cap: a 33-char emoji is refused (the schema never carries it).
  assert.throws(() => db.exec(
    "INSERT INTO gc_message_reactions (message_id, user_id, emoji, created_at) " +
      "VALUES (1, 1, '" + "x".repeat(33) + "', 1);",
  ));
  // The prefs default: an absent row COALESCEs to 1, a stored 0 reads back 0.
  db.exec("INSERT INTO gc_social_prefs (user_id, accept_requests, updated_at) VALUES (2, 0, 7);");
  const rows = db.prepare(
    "SELECT COALESCE((SELECT accept_requests FROM gc_social_prefs WHERE user_id = ?), 1) AS v",
  );
  assert.equal(rows.get(3).v, 1);
  assert.equal(rows.get(2).v, 0);
});

test("0009 is independent of the later migrations: it applies right after 0006 too", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(USERS_SQL);
  // 0006, then 0009, then 0007 and 0008 — a database that has never seen the
  // layer chain or the mod desk still takes the social batch cleanly.
  apply(db, ["0001_initial_goobercord.sql", "0006_roles.sql"], null);
  db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0009_social.sql"), "utf8"));
  apply(db, ["0007_layers.sql", "0008_mod_desk.sql"]);
  db.exec("INSERT INTO users (id, username, role, created_at) VALUES (1, 'a', 'member', 1);");
  db.exec(
    "INSERT INTO gc_friend_requests (requester_id, target_id, created_at) VALUES (1, 1, 1);",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_friend_requests").get().n, 1);
});
