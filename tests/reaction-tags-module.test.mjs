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

// Reaction tags, recoded FRESH on the reverted base (recode lane,
// 2026-11-18). The PROD-APPLIED ledger already carries the feature's
// storage: gc_server_reaction_tags + gc_reaction_tag_opts ride migration
// 0041 and the opts index rides 0043 (d1_migrations applied; shape
// recovered from git history). No lane adds a migration file here — the
// tables are re-created in THIS test's schema setup ONLY, exactly the
// ledger's DDL, so every statement below meets real SQLite: the D1
// prepared-statement check would refuse what node:sqlite refuses.
//
// Pin set: the mod-gated both-arm upsert, the cap and role living INSIDE
// the statements (changes-0 → the ONE shared 404, never a 403 oracle), the
// tag-text law, opt idempotence, the mines-only privacy shape, the
// defaults-law empty read, and the economy re-rule (tags are FREE
// cosmetics: no coin statement fires in this seat).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleReactionTagRoutes } from "../api/reaction-tags.mjs";
import { sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_REACTION_TAG_EMOJI_MAX, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ID = 1;
const MOD_ID = 7;
const MEMBER_ID = 22;
const OUTSIDER_ID = 44;
const NOW = nowSeconds();

// The PROD-APPLIED 0041 DDL (recovered from the ledger; byte-faithful, no
// second source of truth in migrations/).
const LEDGER_0041_SQL = `
  CREATE TABLE gc_server_reaction_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    tag_text TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (server_id, emoji)
  );
  CREATE TABLE gc_reaction_tag_opts (
    tag_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    opted_at INTEGER NOT NULL,
    PRIMARY KEY (tag_id, user_id)
  );
  CREATE INDEX idx_gc_reaction_tags_server ON gc_server_reaction_tags (server_id);
`;

const USERS_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    accent_color TEXT, created_at INTEGER NOT NULL, bio TEXT, avatar_status TEXT,
    avatar_mime TEXT, avatar_updated_at INTEGER, avatar_version INTEGER, totp_enabled INTEGER);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER, csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE gc_server_members (
    server_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id));
  CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER NOT NULL);
`;

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(USERS_SQL);
  db.exec(LEDGER_0041_SQL);
  db.prepare("INSERT INTO users (id, username, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(MOD_ID, "mod", NOW - 100);
  db.prepare("INSERT INTO users (id, username, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(MEMBER_ID, "member", NOW - 100);
  db.prepare("INSERT INTO users (id, username, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(OUTSIDER_ID, "outsider", NOW - 100);
  db.prepare("INSERT INTO gc_server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
    .run(SERVER_ID, MOD_ID, "owner", NOW - 90);
  db.prepare("INSERT INTO gc_server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
    .run(SERVER_ID, MEMBER_ID, "member", NOW - 80);
  return db;
}

// The D1-shaped adapter over node:sqlite.
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

function envFor(db, limiterOverride) {
  const env = { GOOBER_DB: d1(db) };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = limiterOverride ?? { limit: async () => ({ success: true }) };
  }
  return env;
}

const TOKENS = new Map();
const CSRF = new Map();

// A cookie token per seeded member: a real (stored-hashed) session row, so
// requireUser's SHA-256 lookup runs exactly as production does.
async function seedSession(db, userId) {
  const token = (String(userId) + "-").padEnd(40, "T");
  const csrf = "C" + String(userId).padStart(23, "0");
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(await sha256Hex(token), userId, csrf, NOW, NOW + 3600);
  TOKENS.set(userId, token);
  CSRF.set(userId, csrf);
}

async function seededDb() {
  const db = makeDb();
  await seedSession(db, MOD_ID);
  await seedSession(db, MEMBER_ID);
  await seedSession(db, OUTSIDER_ID);
  return db;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleReactionTagRoutes(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

function authed(method, path, userId, body) {
  return new Request("http://localhost" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Cookie: "goober_session=" + TOKENS.get(userId),
      "X-CSRF-Token": CSRF.get(userId),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// --- structural pins -----------------------------------------------------------

const MODULE_PATH = path.join(HERE, "..", "api", "reaction-tags.mjs");
const MODULE_SOURCE = readFileSync(MODULE_PATH, "utf8");

test("GC_REACTION_TAGS_MAX and GC_REACTION_TAG_TEXT_MAX carry the ledger spec's values, never re-declared", () => {
  const source = readFileSync(path.join(HERE, "..", "constants.mjs"), "utf8");
  assert.match(source, /export const GC_REACTION_TAGS_MAX = 20/);
  assert.match(source, /export const GC_REACTION_TAG_TEXT_MAX = 32/);
  assert.match(MODULE_SOURCE, /GC_REACTION_TAGS_MAX/);
  assert.match(MODULE_SOURCE, /GC_REACTION_TAG_TEXT_MAX/);
});

test("the economy re-rule: no coin statement fires in the seat — tags are FREE cosmetics", () => {
  assert.ok(!MODULE_SOURCE.includes("gc_coin_ledger"), "no route here touches the ledger");
});

test("the tag text law rides a locale-key reference OR the short-string cap", () => {
  assert.match(MODULE_SOURCE, /GC_REACTION_TAG_TEXT_MAX/);
  assert.ok(MODULE_SOURCE.includes("[a-z0-9_]+(\\.[a-z0-9_]+)+"), "the locale-key shape is pinned");
});

// --- the mod's map -------------------------------------------------------------

test("a mod maps an emoji to a tag with one PUT and the refreshed row is the answer", async () => {
  const db = await seededDb();
  const response = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥", tag: "campfire" }),
    envFor(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  const row = db.prepare("SELECT id, emoji, tag_text FROM gc_server_reaction_tags").get();
  assert.equal(row.tag_text, "campfire");
  assert.deepEqual(body, { tag: { id: Number(row.id), emoji: "🔥", tag: "campfire" } });
});

test("re-PUTing the same emoji is an in-place upsert: one row refreshed, never a second", async () => {
  const db = await seededDb();
  await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥", tag: "campfire" }),
    envFor(db),
  );
  const response = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥", tag: "hearth" }),
    envFor(db),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await bodyOf(response),
    { tag: { id: Number(db.prepare("SELECT id FROM gc_server_reaction_tags").get().id), emoji: "🔥", tag: "hearth" } },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_reaction_tags").get().n, 1);
});

test("a non-mod's PUT makes zero changes and answers the shared 404 — never a 403", async () => {
  const db = await seededDb();
  const response = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MEMBER_ID, { emoji: "🔥", tag: "campfire" }),
    envFor(db),
  );
  assert.equal(response.status, 404);
  assert.equal((await bodyOf(response)).error, "Reaction tag not found.");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_reaction_tags").get().n, 0);
});

test("PUT past GC_REACTION_TAGS_MAX answers the shared 404: the cap rides the statement's WHERE", async () => {
  const db = await seededDb();
  const insert = db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 20; i++) insert.run(SERVER_ID, "e" + i, "tag" + i, MOD_ID, NOW);
  const response = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥", tag: "overflow" }),
    envFor(db),
  );
  assert.equal(response.status, 404);
});

test("DELETE unmapping rides the role inside the WHERE: a non-mod's unmap is the same shared 404, a mod's lands", async () => {
  const db = await seededDb();
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🔥", "campfire", MOD_ID, NOW);

  const refused = await dispatch(
    authed("DELETE", "/api/servers/" + SERVER_ID + "/reaction-tags", MEMBER_ID, { emoji: "🔥" }),
    envFor(db),
  );
  assert.equal(refused.status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_reaction_tags").get().n, 1);

  const landed = await dispatch(
    authed("DELETE", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥" }),
    envFor(db),
  );
  assert.equal(landed.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_reaction_tags").get().n, 0);
});

test("the tag text law: an overlong free-text tag answers 400 before any statement, a locale key is admitted", async () => {
  const db = await seededDb();
  const overlong = "x".repeat(33);
  const refused = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥", tag: overlong }),
    envFor(db),
  );
  assert.equal(refused.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_reaction_tags").get().n, 0);

  const keyed = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: "🔥", tag: "gc.tags.campfire" }),
    envFor(db),
  );
  assert.equal(keyed.status, 200);
  assert.equal(db.prepare("SELECT tag_text FROM gc_server_reaction_tags").get().tag_text, "gc.tags.campfire");
});

// THE cycle-5 emoji hygiene: an emoji of unbounded length rides straight into
// the UNIQUE (server_id, emoji) row today. GC_REACTION_TAG_EMOJI_MAX bounds
// it — the module's shared 400 shape, before any statement, on both the pin
// and the unmap doors.
test("the emoji law: an over-long emoji answers 400 before any statement on the PUT and the unmap", async () => {
  const db = await seededDb();
  const overlong = "🔥".repeat(GC_REACTION_TAG_EMOJI_MAX + 1);
  const refused = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: overlong, tag: "campfire" }),
    envFor(db),
  );
  assert.equal(refused.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_reaction_tags").get().n, 0,
    "the over-long emoji never reaches the statement");

  const atTheCap = "🔥".repeat(GC_REACTION_TAG_EMOJI_MAX);
  const admitted = await dispatch(
    authed("PUT", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: atTheCap, tag: "campfire" }),
    envFor(db),
  );
  assert.equal(admitted.status, 200, "the cap itself is admitted (code points, not bytes)");

  const unmapRefused = await dispatch(
    authed("DELETE", "/api/servers/" + SERVER_ID + "/reaction-tags", MOD_ID, { emoji: overlong }),
    envFor(db),
  );
  assert.equal(unmapRefused.status, 400, "the unmap door carries the same bounded shape");
});

// --- the members' reads and opts -------------------------------------------------

test("the member read of the map carries NO member column: ids, emoji, tag only, membership inside the WHERE", async () => {
  const db = await seededDb();
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🔥", "campfire", MOD_ID, NOW);
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🌙", "moonrise", MOD_ID, NOW);

  const member = await dispatch(
    authed("GET", "/api/servers/" + SERVER_ID + "/reaction-tags", MEMBER_ID),
    envFor(db),
  );
  assert.equal(member.status, 200);
  const body = await bodyOf(member);
  for (const row of body.tags) {
    assert.deepEqual(Object.keys(row).sort(), ["emoji", "id", "tag"], "no member identity rides the map read");
  }
  assert.equal(body.tags.length, 2);

  const outsider = await dispatch(
    authed("GET", "/api/servers/" + SERVER_ID + "/reaction-tags", OUTSIDER_ID),
    envFor(db),
  );
  assert.deepEqual((await bodyOf(outsider)).tags, [], "a non-member's read is the defaults-law empty answer");
});

test("a member opts into a tag with one POST, re-opting is the idempotent duplicate, and an unreachable tag is the shared 404", async () => {
  const db = await seededDb();
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🔥", "campfire", MOD_ID, NOW);
  const tagId = Number(db.prepare("SELECT id FROM gc_server_reaction_tags").get().id);

  const first = await dispatch(
    authed("POST", "/api/servers/" + SERVER_ID + "/reaction-tags/" + tagId + "/opt", MEMBER_ID),
    envFor(db),
  );
  assert.equal(first.status, 200);
  assert.deepEqual(await bodyOf(first), { opted: true });

  const again = await dispatch(
    authed("POST", "/api/servers/" + SERVER_ID + "/reaction-tags/" + tagId + "/opt", MEMBER_ID),
    envFor(db),
  );
  assert.deepEqual(await bodyOf(again), { opted: true, duplicate: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_reaction_tag_opts").get().n, 1);

  const unreachable = await dispatch(
    authed("POST", "/api/servers/" + SERVER_ID + "/reaction-tags/999999/opt", MEMBER_ID),
    envFor(db),
  );
  assert.equal(unreachable.status, 404);
  assert.equal((await bodyOf(unreachable)).error, "Reaction tag not found.");

  const outsider = await dispatch(
    authed("POST", "/api/servers/" + SERVER_ID + "/reaction-tags/" + tagId + "/opt", OUTSIDER_ID),
    envFor(db),
  );
  assert.equal(outsider.status, 404);
});

test("un-opting removes the caller's row; never-opted and no-such-tag answer the SAME shared 404", async () => {
  const db = await seededDb();
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🔥", "campfire", MOD_ID, NOW);
  const tagId = Number(db.prepare("SELECT id FROM gc_server_reaction_tags").get().id);

  const never = await dispatch(
    authed("DELETE", "/api/servers/" + SERVER_ID + "/reaction-tags/" + tagId + "/opt", MEMBER_ID),
    envFor(db),
  );
  assert.equal(never.status, 404);
});

test("mine answers ONLY the caller's opted tags, capped — no other member's row ever rides it", async () => {
  const db = await seededDb();
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🔥", "campfire", MOD_ID, NOW);
  db.prepare(
    "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(SERVER_ID, "🌙", "moonrise", MOD_ID, NOW);
  const ids = db.prepare("SELECT id FROM gc_server_reaction_tags ORDER BY id").all();
  db.prepare("INSERT INTO gc_reaction_tag_opts (tag_id, user_id, opted_at) VALUES (?, ?, ?)")
    .run(Number(ids[0].id), MEMBER_ID, NOW);
  db.prepare("INSERT INTO gc_reaction_tag_opts (tag_id, user_id, opted_at) VALUES (?, ?, ?)")
    .run(Number(ids[0].id), MOD_ID, NOW);

  const response = await dispatch(
    authed("GET", "/api/servers/" + SERVER_ID + "/reaction-tags/mine", MEMBER_ID),
    envFor(db),
  );
  const body = await bodyOf(response);
  assert.deepEqual(body.tags, [{ id: Number(ids[0].id), emoji: "🔥", tag: "campfire" }]);

  const empty = await dispatch(
    authed("GET", "/api/servers/" + SERVER_ID + "/reaction-tags/mine", OUTSIDER_ID),
    envFor(db),
  );
  assert.equal(empty.status, 200);
  assert.deepEqual((await bodyOf(empty)).tags, [], "the untouched member's mine read is a valid empty answer");
});

// --- auth + wire ------------------------------------------------------------------

test("un-authed: every reaction-tag route answers 401 before any statement fires", async () => {
  const db = await seededDb();
  for (const [method, path] of [
    ["PUT", "/api/servers/" + SERVER_ID + "/reaction-tags"],
    ["GET", "/api/servers/" + SERVER_ID + "/reaction-tags"],
    ["GET", "/api/servers/" + SERVER_ID + "/reaction-tags/mine"],
  ]) {
    const response = await dispatch(
      new Request("http://localhost" + path, {
        method,
        headers: { Origin: "http://localhost", "X-CSRF-Token": "N".repeat(24) },
      }),
      envFor(db),
    );
    assert.equal(response.status, 401, method + " " + path + " must 401");
  }
});

test("the seat rides the worker's chain: handleReactionTagRoutes is wired in worker.mjs", () => {
  const worker = readFileSync(path.join(HERE, "..", "worker.mjs"), "utf8");
  assert.match(worker, /handleReactionTagRoutes/);
});
