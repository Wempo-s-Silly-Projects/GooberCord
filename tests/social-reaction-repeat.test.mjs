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

// Real-SQLite pin for the repeat reaction PUT (GO-HAYWIRE cycle 2, fix 2):
// the add route's INSERT..SELECT admitted the caller's already-held emoji
// through its EXISTS arm, and the composite PK (message_id, user_id, emoji)
// threw UNIQUE on real SQLite — every repeat PUT 500ed and the held-replay
// branch after the batch was unreachable. The fix rewrites the write as
// INSERT OR IGNORE + one re-read: changes = 1 then truly means a FRESH add
// (the burst verdict's premise), a held replay answers 201 without ever
// touching the cap arm, and a genuine cap refusal still answers the filed
// 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { handleSocialRoutes } from "../api/social.mjs";
import { sha256Hex } from "../api/core/crypto.mjs";
import { HttpError } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS, GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE } from "../constants.mjs";
import { statementsOf } from "./migration-scoping.test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");

// One standing session backed by the REAL hash the gate reads (the cookie
// token is hashed through the same SHA-256 lookup production uses).
const SESSION_TOKEN = "A".repeat(40);
const TOKEN_HASH = await sha256Hex(SESSION_TOKEN);
const SESSION_COOKIE = "goober_session=" + SESSION_TOKEN;

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

function statements(file) {
  return statementsOf(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
}

function seedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(USERS_SQL);
  for (const file of ["0001_initial_goobercord.sql", "0009_social.sql", "0056_gc_cosmetic_inventory.sql", "0057_message_fx_burst.sql"]) {
    for (const statement of statements(file)) db.exec(statement);
  }
  db.exec(
    "INSERT INTO users (id, username, role, created_at) VALUES (7, 'wempos', 'member', 1), (8, 'ada', 'member', 1)",
  );
  db.exec(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES ('" +
    TOKEN_HASH + "', 7, 'c', 1, 9999999999)",
  );
  // A dm channel both members sit in, with one message to react on.
  db.exec("INSERT INTO gc_channels (id, server_id, kind, created_at) VALUES (100, NULL, 'dm', 1)");
  db.exec("INSERT INTO gc_conversation_members (channel_id, user_id) VALUES (100, 7), (100, 8)");
  db.exec(
    "INSERT INTO gc_messages (id, channel_id, author_id, body, created_at) VALUES (500, 100, 7, 'hey', 1)",
  );
  return db;
}

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

function envOf(db) {
  const env = { GOOBER_DB: d1(db) };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async () => ({ success: true }) };
  }
  return env;
}

function putReaction(emoji) {
  return new Request("http://localhost/api/messages/500/reactions", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "http://localhost", "X-CSRF-Token": "c", Cookie: SESSION_COOKIE },
    body: JSON.stringify({ emoji }),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleSocialRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = Response.json({ error: error.message }, { status: error.status });
  }
  if (response === undefined) throw new Error("no social route matched the reaction PUT");
  return response;
}

const reactionCount = (db) =>
  db.prepare("SELECT COUNT(*) AS n FROM gc_message_reactions WHERE message_id = 500").get().n;

test("a repeat PUT of the held emoji answers the 201 replay — never a UNIQUE throw", async () => {
  const db = seedDb();
  const env = envOf(db);
  const first = await dispatch(putReaction("🔥"), env);
  assert.equal(first.status, 201, "the fresh add lands 201");
  assert.equal(reactionCount(db), 1, "exactly one row holds the add");

  // The pre-fix statement threw UNIQUE on the composite PK — this very call.
  const second = await dispatch(putReaction("🔥"), env);
  assert.equal(second.status, 201, "the held replay rides the re-read, idempotent");
  const body = await second.text();
  assert.equal(JSON.parse(body).reaction.mine, true, "the replay still names the row as mine");
  assert.equal(JSON.parse(body).reaction.fxBurst, undefined,
    "the replay is NOT a fresh add — the burst verdict must never run for it");
  assert.equal(reactionCount(db), 1, "the replay minted no second row");
});

test("the burst verdict keys on changes = 1: only a FRESH add spends, the replay never does", async () => {
  const db = seedDb();
  const env = envOf(db);
  const firstBody = await (await dispatch(putReaction("🔥"), env)).json();
  assert.equal(firstBody.reaction.fxBurst, undefined,
    "no pack is equipped here — but the fresh-add gate itself ran (row holds mine)");
  const replayBody = await (await dispatch(putReaction("🔥"), env)).json();
  assert.deepEqual(replayBody, firstBody,
    "the replay echoes the same payload shape with no burst field");
});

test("the cap arm survives the rewrite: a new emoji below cap adds, at cap refuses, the held one replays", async () => {
  const db = seedDb();
  const env = envOf(db);
  // Seed cap - 1 distinct reactors (one row per emoji, distinct emoji only —
  // the held-repeat rows never count toward DISTINCT).
  const seed = db.prepare(
    "INSERT INTO gc_message_reactions (message_id, user_id, emoji, created_at) VALUES (500, 8, ?, 1)",
  );
  for (let index = 0; index < GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE - 1; index += 1) {
    seed.run("E" + String(index).padStart(2, "0"));
  }

  const twentieth = await dispatch(putReaction("🔥"), env);
  assert.equal(twentieth.status, 201, "the cap-minus-one add lands");
  assert.equal(reactionCount(db), GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE);

  const beyond = await dispatch(putReaction("👍"), env);
  assert.equal(beyond.status, 400, "the next NEW emoji at cap is refused by the folded arm");

  const heldAtCap = await dispatch(putReaction("🔥"), env);
  assert.equal(heldAtCap.status, 201, "the caller's own held emoji replays 201 even at cap");

  // The 400's own row was INSERT OR IGNOREd — nothing landed past the cap.
  assert.equal(reactionCount(db), GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE,
    "the refused emoji minted no row");
});
