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

// The GO-HAYWIRE cycle-6 emoji gates: intake-before-authority (a non-member
// multipart create mints NOTHING), the fall-through sweep of a minted pending
// row on every changes!=1 / UNIQUE-409 / FK-rethrow path, and the per-body
// expression-token cap (a crafted body answers refusal, never a >100-bind
// statement). Same fake conventions as soundboard-gates.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { handleExpressionRoutes, enforceExpressionTokenAccess } from "../api/emoji.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_EXPRESSION_TOKENS_MAX,
  GC_EMOJI_MAX_PER_SERVER,
  GC_EMOJI_FILE_MAX,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const MANAGE_BIT = 1 << 11;

const PENDING_ROW_DELETE_TEST = (sql) => sql === "DELETE FROM gc_attachments WHERE id = ? AND status = 'pending'";
const ATTACHMENT_INTAKE_TEST = (sql) => sql.includes("INSERT INTO gc_attachments");
const EMOJI_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_emoji");

// A structurally valid PNG the intake's sanitizer keeps (emoji-sticker's
// pngChunk shape): signature + IHDR + IEND, no CRC verification.
function pngLike(payloadBytes = 0) {
  const chunk = (type, data = new Uint8Array(0)) => {
    const out = new Uint8Array(12 + data.length);
    out[0] = (data.length >>> 24) & 0xff;
    out[1] = (data.length >>> 16) & 0xff;
    out[2] = (data.length >>> 8) & 0xff;
    out[3] = data.length & 0xff;
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  };
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", new Uint8Array(13)),
    chunk("IDAT", new Uint8Array(payloadBytes)),
    chunk("IEND"),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

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

async function dispatchEmoji(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleExpressionRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
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

// The common emoji routes: the session answers, membership per `member`, the
// authority pair, the boost resolver row. Insert/insert-routes ride per test.
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
    { test: EMOJI_INSERT_TEST, run: async () => {
      if (insertError) throw insertError;
      return { meta: { changes: insertChanges } };
    } },
    {
      test: (sql) => sql.includes("SELECT EXISTS (SELECT 1 FROM gc_attachments a"),
      first: async () => ({ ownAttachment: 1, count, size: GC_EMOJI_FILE_MAX, messageId: null, emojiUsed: 0, stickersUsed: 0, soundsUsed: 0 }),
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
  form.append("image", new Blob([pngLike(64)]));
  let response = null;
  let thrown = null;
  try {
    response = await dispatchEmoji(
      new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", {
        method: "POST",
        headers: { ...(await SESSION_FIXTURES).headers, Origin: ORIGIN },
        body: form,
      }),
      env,
    );
  } catch (error) {
    // A non-HttpError rethrow escapes the dispatcher; the db/R2 context
    // still rides back so the rethrow arms stay observable.
    thrown = error;
  }
  return { response, db, recorder, r2: env.GC_MEDIA, thrown };
}

const anyIntake = (db) => db.calls.some((entry) =>
  entry.statements
    ? entry.statements.some((statement) => ATTACHMENT_INTAKE_TEST(statement.sql))
    : ATTACHMENT_INTAKE_TEST(entry.sql));

const anySweep = (db) => db.calls.some((entry) =>
  entry.statements
    ? entry.statements.some((statement) => PENDING_ROW_DELETE_TEST(statement.sql))
    : PENDING_ROW_DELETE_TEST(entry.sql));

// FIX 1: a non-member multipart POST mints NOTHING — no pending attachment
// row, no R2 object, no intake at all; the 404 answers before the byte legs.
test("non-member multipart emoji create mints NO pending row and NO R2 object", async () => {
  const { response, db, r2 } = await multipartCreate(baseRoutes({ member: false, insertChanges: 0 }), "partyparrot");
  assert.equal(response.status, 404);
  assert.equal(anyIntake(db), false, "intake must never run for a non-member");
  assert.equal(r2.store.size, 0, "no R2 object survives an unauthorized create");
  assert.equal(r2.calls.some((entry) => entry.op === "put"), false, "no R2 put is issued");
});

// FIX 1 belt: a non-authoritative MEMBER (no MANAGE_EMOJI bit) mints nothing
// either — the authority arm answers before the intake, mirroring soundboard.
test("non-authoritative member multipart emoji create mints NO pending row and NO R2 object", async () => {
  const { response, db, r2 } = await multipartCreate(baseRoutes({ permissions: 0, insertChanges: 0 }), "partyparrot");
  assert.equal(response.status, 403);
  assert.equal(anyIntake(db), false, "intake must never run for a non-authoritative caller");
  assert.equal(r2.store.size, 0, "no R2 object survives an unauthorized create");
});

// FIX 1 belt: a guarded INSERT that fell through (changes!=1) sweeps the
// pending row it just minted and schedules the R2 object's delete.
test("changes!=1 fall-through sweeps the minted pending row and schedules the object delete", async () => {
  const { response, db, r2 } = await multipartCreate(baseRoutes({ insertChanges: 0, count: GC_EMOJI_MAX_PER_SERVER }), "partyparrot");
  assert.equal(response.status, 400);
  assert.ok(anySweep(db), "the minted pending row is swept");
  const deleteCall = r2.calls.find((entry) => entry.op === "delete");
  assert.ok(deleteCall, "the R2 object delete is scheduled");
});

// A pre-existing (JSON-branch) own asset is NEVER swept — the sweep rides the
// minted flag, so the JSON branch's fall-through keeps its attachment.
test("the JSON branch's fall-through never sweeps the caller's own pre-existing asset", async () => {
  const recorder = [];
  const env = limiterEnv(recorder);
  const db = fakeDb(baseRoutes({ insertChanges: 0, count: GC_EMOJI_MAX_PER_SERVER }));
  env.GOOBER_DB = db;
  const { headers } = await SESSION_FIXTURES;
  const response = await dispatchEmoji(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "partyparrot", attachmentId: 9 }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(anySweep(db), false, "the pre-existing own asset is never swept");
  assert.equal(env.GC_MEDIA.calls.some((entry) => entry.op === "delete"), false, "no object delete is scheduled");
});

// The UNIQUE(server_id, name) 409 rides the INSERT's catch BEFORE the
// changes!=1 block — the mint branch's duplicate-name retry must sweep the
// just-minted pending row + object too.
test("duplicate-name 409 in the mint branch sweeps the minted pending row and empties the R2 store", async () => {
  const { response, db, r2 } = await multipartCreate(
    baseRoutes({ insertError: new Error("UNIQUE constraint failed: gc_emoji.server_id, gc_emoji.name") }),
    "partyparrot",
  );
  assert.equal(response.status, 409);
  assert.ok(anySweep(db), "the minted pending row is swept despite the UNIQUE 409");
  assert.equal(r2.store.size, 0, "the minted R2 object is gone after the 409");
});

// The generic rethrow arm (a non-UNIQUE D1 error — e.g. the FOREIGN KEY
// constraint the RESTRICT arm answers with a raw 500) leaves the catch the
// same way: the minted pending row + object must never survive it.
test("a non-UNIQUE INSERT rethrow in the mint branch also sweeps the minted row and empties the R2 store", async () => {
  const { thrown, db, r2 } = await multipartCreate(
    baseRoutes({ insertError: new Error("FOREIGN KEY constraint failed") }),
    "partyparrot",
  );
  assert.ok(thrown, "the generic rethrow surfaces (not an HttpError)");
  assert.equal(thrown.message, "FOREIGN KEY constraint failed");
  assert.ok(anySweep(db), "the minted pending row is swept despite the generic rethrow");
  assert.equal(r2.store.size, 0, "the minted R2 object is gone after the rethrow");
});

// FIX 2: the per-body token cap. A body over GC_EXPRESSION_TOKENS_MAX unique
// ids is REFUSED (400) before any bind — never a statement over the 100-bind
// law; a body at the cap still evaluates (its unknown ids stay plain text).
const tokenBody = (count) =>
  Array.from({ length: count }, (_, i) => "<e:aa" + i + ":" + (i + 1) + ">").join(" ");

async function gateCall(env, serverId, text) {
  return enforceExpressionTokenAccess(env, USER_ID, serverId, text);
}

function gateEnv({ emojiRows = [] } = {}) {
  return {
    GOOBER_DB: {
      prepare(sql) {
        const route = sql.startsWith("SELECT id, server_id FROM gc_emoji WHERE id IN");
        return {
          bind: (...bound) => ({
            all: async () => (route ? { results: emojiRows(bound) } : { results: [] }),
            first: async () => null,
          }),
        };
      },
    },
  };
}

test("a body over the token cap is refused (400), never bound over the 100-bind law", async () => {
  const env = gateEnv();
  await assert.rejects(
    () => gateCall(env, SERVER_ID, tokenBody(GC_EXPRESSION_TOKENS_MAX + 1)),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test("a crafted 500-token body answers refusal, not an over-bind statement", async () => {
  const env = gateEnv();
  await assert.rejects(
    () => gateCall(env, SERVER_ID, tokenBody(500)),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test("a body at the token cap still evaluates: every IN bind list stays at or under the cap", async () => {
  const seenBinds = [];
  const env = {
    GOOBER_DB: {
      prepare(sql) {
        const route = sql.startsWith("SELECT id, server_id FROM gc_emoji WHERE id IN");
        return {
          bind: (...bound) => {
            if (route) seenBinds.push(bound.length);
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
            };
          },
        };
      },
    },
  };
  await assert.doesNotReject(() => gateCall(env, SERVER_ID, tokenBody(GC_EXPRESSION_TOKENS_MAX)));
  for (const count of seenBinds) {
    assert.ok(count <= 100, "every bind list stays under the 100-bind law");
    assert.ok(count <= GC_EXPRESSION_TOKENS_MAX, "no bind list exceeds the token cap");
  }
  assert.ok(seenBinds.length > 0, "the gate still read the emoji table");
});
