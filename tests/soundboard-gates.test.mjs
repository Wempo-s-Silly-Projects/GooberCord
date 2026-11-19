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

// The GO-HAYWIRE cycle-3 soundboard gates: intake-before-authority (a
// non-member create mints NOTHING), the fall-through sweep of a minted
// pending row, the bound cap, and the GET route's read-bucket rate limit.
import test from "node:test";
import assert from "node:assert/strict";
import { handleSoundboardRoutes } from "../api/soundboard.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { RATE_LIMIT_BINDINGS, GC_SOUNDBOARD_MAX_PER_SERVER, GC_SOUNDBOARD_SOUND_MAX_BYTES } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const MANAGE_BIT = 1 << 11;
const PENDING_ROW_DELETE_TEST = (sql) => sql === "DELETE FROM gc_attachments WHERE id = ? AND status = 'pending'";
const ATTACHMENT_INTAKE_TEST = (sql) => sql.includes("INSERT INTO gc_attachments");
const SOUND_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_sounds");

const ID3_MP3 = (() => {
  const bytes = new Uint8Array(64);
  bytes.set([0x49, 0x44, 0x33, 0x03, 0x00], 0);
  for (let i = 12; i < bytes.length; i += 1) bytes[i] = 0xa5;
  return bytes;
})();

async function sessionFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  return {
    row: {
      token_hash: await sha256Hex(token),
      user_id: USER_ID,
      csrf_token: csrf,
      expires_at: nowSeconds() + 3600,
      username: "wempos",
      role: "member",
      bio: "",
      avatar_status: null,
      avatar_mime: null,
      avatar_updated_at: null,
      avatar_version: null,
      totp_enabled: 0,
    },
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

function fakeDb(routes = []) {
  const calls = [];
  let nextRowId = 100;
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => { statement.bound = values; return statement; };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        return { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

function fakeR2() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    async put(key, value) {
      calls.push({ op: "put", key });
      store.set(key, new Uint8Array(value));
    },
    async delete(key) {
      calls.push({ op: "delete", key });
      return store.delete(key);
    },
  };
}

function limiterEnv(recorder) {
  const env = { GC_MEDIA: fakeR2() };
  for (const [scope, binding] of Object.entries(RATE_LIMIT_BINDINGS)) {
    env[binding] = {
      limit: async ({ key }) => {
        recorder.push(scope);
        return { success: true, key };
      },
    };
  }
  return env;
}

async function dispatchBoard(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleSoundboardRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

const SESSION_FIXTURES = sessionFixtures();
const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const MEMBERSHIP_TEST = (sql) => sql.includes("SELECT 1 AS member FROM gc_server_members");
const ROLE_READ_TEST = (sql) => sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const MERGED_TEST = (sql) => sql.includes("GROUP_CONCAT(ar.permissions)");
const BOOSTS_TEST = (sql) => sql.includes("SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1");

// The common board routes: the session answers, membership per `member`, and
// the boost resolver's row. Insert/authority routes ride per test.
function baseRoutes({
  member = true,
  role = "member",
  permissions = MANAGE_BIT,
  insertChanges = 1,
  insertError = null,
  count = 0,
} = {}) {
  return [
    { test: SESSION_TEST, first: async () => (await SESSION_FIXTURES).row },
    { test: MEMBERSHIP_TEST, first: async () => (member ? { member: 1 } : null) },
    { test: ROLE_READ_TEST, first: async () => (member ? { role } : null) },
    { test: MERGED_TEST, first: async () => ({ permissions }) },
    { test: BOOSTS_TEST, first: async () => ({ boosts: 14 }) },
    { test: SOUND_INSERT_TEST, run: async () => {
      if (insertError) throw insertError;
      return { meta: { changes: insertChanges } };
    } },
    {
      test: (sql) => sql.includes("SELECT EXISTS (SELECT 1 FROM gc_attachments a"),
      first: async () => ({ ownAttachment: 1, count, size: GC_SOUNDBOARD_SOUND_MAX_BYTES, messageId: null, soundsUsed: 0, emojiUsed: 0, stickersUsed: 0 }),
    },
  ];
}

async function multipartCreate(routes, name) {
  const recorder = [];
  const env = limiterEnv(recorder);
  const db = fakeDb(routes);
  env.GOOBER_DB = db;
  const form = new FormData();
  form.append("name", name);
  form.append("sound", new Blob([ID3_MP3]));
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", {
      method: "POST",
      headers: { ...(await SESSION_FIXTURES).headers, Origin: ORIGIN },
      body: form,
    }),
    env,
  );
  return { response, db, recorder, r2: env.GC_MEDIA };
}

// FIX 1: a non-member POST mints NOTHING — no pending attachment row, no R2
// object, no intake at all; the 404 answers before the byte legs.
test("non-member create mints NO pending row and NO R2 object", async () => {
  const { response, db, r2 } = await multipartCreate(baseRoutes({ member: false, insertChanges: 0 }), "dropthebass");
  assert.equal(response.status, 404);
  const intakeCalls = db.calls.filter((entry) =>
    entry.statements ? entry.statements.some((statement) => ATTACHMENT_INTAKE_TEST(statement.sql)) : ATTACHMENT_INTAKE_TEST(entry.sql),
  );
  assert.equal(intakeCalls.length, 0, "intake must never run for a non-member");
  assert.equal(r2.store.size, 0, "no R2 object survives an unauthorized create");
  assert.equal(r2.calls.some((entry) => entry.op === "put"), false, "no R2 put is issued");
});

// FIX 1 belt: a guarded INSERT that fell through (changes!=1) sweeps the
// pending row it just minted and schedules the R2 object's delete.
test("changes!=1 fall-through sweeps the minted pending row and schedules the object delete", async () => {
  const { response, db, r2 } = await multipartCreate(baseRoutes({ insertChanges: 0, count: GC_SOUNDBOARD_MAX_PER_SERVER }), "dropthebass");
  assert.equal(response.status, 400);
  const sweep = db.calls.find((entry) =>
    entry.statements
      ? entry.statements.some((statement) => PENDING_ROW_DELETE_TEST(statement.sql))
      : PENDING_ROW_DELETE_TEST(entry.sql),
  );
  assert.ok(sweep, "the minted pending row is swept");
  const deleteCall = r2.calls.find((entry) => entry.op === "delete");
  assert.ok(deleteCall, "the R2 object delete is scheduled");
});

// The UNIQUE(server_id, name) 409 rides the INSERT's catch BEFORE the
// changes!=1 block — the mint branch's duplicate-name retry (the common
// user-error path) must sweep the just-minted pending row + object too.
test("duplicate-name 409 in the mint branch sweeps the minted pending row and empties the R2 store", async () => {
  const { response, db, r2 } = await multipartCreate(
    baseRoutes({ insertError: new Error("UNIQUE constraint failed: gc_sounds.server_id, gc_sounds.name") }),
    "dropthebass",
  );
  assert.equal(response.status, 409);
  const sweep = db.calls.find((entry) =>
    entry.statements
      ? entry.statements.some((statement) => PENDING_ROW_DELETE_TEST(statement.sql))
      : PENDING_ROW_DELETE_TEST(entry.sql),
  );
  assert.ok(sweep, "the minted pending row is swept despite the UNIQUE 409");
  assert.equal(r2.store.size, 0, "the minted R2 object is gone after the 409");
});

// FIX 2: the resolver's cap is bound, never concatenated into the statement.
test("create statement binds the cap instead of concatenating it", async () => {
  const { db } = await multipartCreate(baseRoutes(), "dropthebass");
  const insertCall = db.calls.find((entry) =>
    entry.statements
      ? entry.statements.some((statement) => SOUND_INSERT_TEST(statement.sql))
      : SOUND_INSERT_TEST(entry.sql),
  );
  assert.ok(insertCall, "the create statement ran");
  const insertSql = insertCall.statements
    ? insertCall.statements.find((statement) => SOUND_INSERT_TEST(statement.sql)).sql
    : insertCall.sql;
  assert.equal(insertSql.includes("< 8"), false, "the cap is not concatenated into the statement");
  assert.ok(insertSql.trim().endsWith("< ?"), "the cap rides a placeholder");
});

// FIX 3: the GET route rate-limits on the shared read bucket.
test("GET sounds rate-limits on the read bucket", async () => {
  const recorder = [];
  const env = limiterEnv(recorder);
  env.GOOBER_DB = fakeDb(baseRoutes());
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", {
      method: "GET",
      headers: (await SESSION_FIXTURES).headers,
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(
    recorder.filter((bucket) => bucket === "read").length,
    1,
    "exactly one read-bucket limit call",
  );
});
