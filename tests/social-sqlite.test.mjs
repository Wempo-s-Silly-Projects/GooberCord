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

// Real-SQLite pin for the social READ shapes: the fakeDb in the module test
// routes on string matching and can answer statements SQLite itself would
// refuse — exactly the /api/friends outage (the friends SELECT carried the
// pending-requests template's `r.created_at` against the pair table's `f`
// alias, so every hub read 500ed at D1's prepared-statement check while the
// fakeDb happily returned rows). These are true node:sqlite runs against the
// applied 0009 schema: every statement below must prepare AND execute, and
// the payloads must match what the friends hub renders.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { handleSocialRoutes } from "../api/social.mjs";
import { sha256Hex } from "../api/core/crypto.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");

// The minimal users shape the FKs need (the vendored 0002's full forum column
// set is not what this pin is about — the social objects are).
const USERS_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    accent_color TEXT, created_at INTEGER NOT NULL, bio TEXT, avatar_status TEXT,
    avatar_mime TEXT, avatar_updated_at INTEGER, avatar_version INTEGER, totp_enabled INTEGER);
  CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER NOT NULL);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER, csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

function applyMigrations(db) {
  db.exec(USERS_SQL);
  for (const statement of readFileSync(path.join(MIGRATIONS_DIR, "0009_social.sql"), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")) {
    if (statement.trim()) db.exec(statement);
  }
}

// The D1-shaped adapter over node:sqlite (prepare → bind → first/all/run and
// batch). This is the ONLY place the handler's exact SQL meets SQLite, so a
// no-such-column regression fails here instead of production.
function d1(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let bound = [];
      return {
        bind(...values) {
          bound = values;
          return this;
        },
        async first() {
          return statement.get(...bound) ?? null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
        async run() {
          const info = statement.run(...bound);
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function readRequest(headers) {
  return new Request("http://localhost/api/friends", { method: "GET", headers });
}

async function handle(request, env) {
  return handleSocialRoutes(request, env, new URL(request.url), new URL(request.url).pathname, "GET", undefined);
}

// A real (40-char, hashed-and-stored) session cookie: requireSignedInRead
// reads it through the SHA-256 lookup exactly as production does.
const SESSION_TOKEN = "g".repeat(40);

function sessionHeaders() {
  return { Cookie: "__Host-goober_session=" + SESSION_TOKEN };
}

test("/api/friends executes against the applied schema and returns the three facets", async () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.exec(
    "INSERT INTO users (id, username, role, created_at) VALUES" +
      " (1, 'wempos', 'member', 1), (2, 'ada', 'member', 1), (3, 'grace', 'member', 1)," +
      " (4, 'linus', 'member', 1);",
  );
  // One accepted pair (1-2), one request sent (1→3), one received (4→1).
  db.exec(
    "INSERT INTO gc_friends (user_a_id, user_b_id, created_at) VALUES (1, 2, 100);" +
      "INSERT INTO gc_friend_requests (requester_id, target_id, created_at) VALUES (1, 3, 200);" +
      "INSERT INTO gc_friend_requests (requester_id, target_id, created_at) VALUES (4, 1, 300);",
  );
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, 1, 'sqlitecsrf', 1, 9e9)")
    .run(await sha256Hex(SESSION_TOKEN));

  const response = await handle(readRequest(sessionHeaders()), { GOOBER_DB: d1(db) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.friends.map((friend) => friend.username), ["ada"]);
  assert.deepEqual(payload.pendingSent.map((friend) => friend.username), ["grace"]);
  assert.deepEqual(payload.pendingReceived.map((friend) => friend.username), ["linus"]);
  for (const row of [...payload.friends, ...payload.pendingSent, ...payload.pendingReceived]) {
    assert.equal(row.createdAt, new Date(row.createdAt).toISOString()); // a real instant
    assert.ok(Number.isInteger(Date.parse(row.createdAt)));
  }
  assert.equal(payload.settings.acceptRequests, true);
});
