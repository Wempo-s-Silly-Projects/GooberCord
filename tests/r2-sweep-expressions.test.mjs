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
// GNU Affero General Public LICENSE for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

// The expression-delete R2 rides (lane-r2-sweep): the soundboard / emoji
// DELETE routes' batch already computes the attachment row's fate (the third
// statement's guard — sole referencer AND standalone), so the object delete
// rides exactly that verdict: a changes-1 third statement schedules one
// gc-attachments/<id> R2 delete; a shared attachment (sibling alive) or a
// no-GC_MEDIA environment rides nothing. Same fake conventions as
// tests/soundboard-lane.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { json } from "../api/core/http.mjs";
import { handleSoundboardRoutes } from "../api/soundboard.mjs";
import { handleExpressionRoutes } from "../api/emoji.mjs";
import { GC_ATTACHMENT_OBJECT_PREFIX, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const ACTOR = 7;
const SERVER_ID = 91;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const SOUND_TARGET_TEST = (sql) =>
  sql.includes("SELECT attachment_id FROM gc_sounds WHERE id = ? AND server_id = ? LIMIT 1");
const SOUND_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_sounds WHERE id = ?");
const EMOJI_TARGET_TEST = (sql) =>
  sql.includes("SELECT attachment_id FROM gc_emoji WHERE id = ? AND server_id = ? LIMIT 1");
const EMOJI_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_emoji WHERE id = ?");

async function sessionFixtures(role = "owner") {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: ACTOR,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role,
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return {
    row,
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf, Origin: ORIGIN },
  };
}

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

function fakeDb(routes) {
  const calls = [];
  let nextRowId = 0;
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        const route = find(sql);
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
  const calls = [];
  return {
    calls,
    async delete(key) {
      calls.push({ op: "delete", key });
      return true;
    },
  };
}

function fakeCtx() {
  const ctx = {
    tasks: [],
    waitUntil(promise) {
      ctx.tasks.push(Promise.resolve(promise).catch(() => {}));
    },
  };
  return ctx;
}

async function settled(ctx) {
  for (const task of ctx.tasks) await task;
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatchRoute(handler, path, method, env, ctx, headers) {
  const url = new URL(path, ORIGIN);
  const request = new Request(ORIGIN + path, { method, headers });
  try {
    return await handler(request, env, url, url.pathname, method, ctx);
  } catch (error) {
    if (error?.status) {
      return json(error.payload || { error: error.message }, error.status, error.headers);
    }
    throw error;
  }
}

const SPECS = {
  soundboard: {
    handler: handleSoundboardRoutes,
    path: `/api/servers/${SERVER_ID}/sounds/12`,
    targetTest: SOUND_TARGET_TEST,
    targetRow: { attachment_id: 71 },
    deleteTest: SOUND_DELETE_TEST,
  },
  emoji: {
    handler: handleExpressionRoutes,
    path: `/api/servers/${SERVER_ID}/emojis/12`,
    targetTest: EMOJI_TARGET_TEST,
    targetRow: { attachment_id: 72 },
    deleteTest: EMOJI_DELETE_TEST,
  },
  sticker: {
    handler: handleExpressionRoutes,
    path: `/api/servers/${SERVER_ID}/stickers/12`,
    targetTest: (sql) => sql.includes("SELECT attachment_id FROM gc_stickers WHERE id = ? AND server_id = ? LIMIT 1"),
    targetRow: { attachment_id: 73 },
    deleteTest: (sql) => sql.startsWith("DELETE FROM gc_stickers WHERE id = ?"),
  },
};

const changesFor = (testFn, changes) => ({ test: testFn, run: async () => ({ meta: { changes } }) });
const CHUNKS_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id = ?");
const ATTACHMENT_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_attachments WHERE id = ?");

async function runExpressionDelete(kind, routes, r2) {
  const spec = SPECS[kind];
  const { row, headers } = await sessionFixtures();
  const ctx = fakeCtx();
  const db = fakeDb([sessionRoute(row), ...routes]);
  const env = envWithLimiters({ GOOBER_DB: db, ...(r2 ? { GC_MEDIA: r2 } : {}) });
  const response = await dispatchRoute(spec.handler, spec.path, "DELETE", env, ctx, headers);
  return { response, db, ctx };
}

test("a soundboard delete rides the attachment's R2 object when the row died", async () => {
  const r2 = fakeR2();
  const { response, ctx } = await runExpressionDelete("soundboard", [
    { test: SPECS.soundboard.targetTest, first: async () => ({ attachment_id: 71 }) },
    changesFor(SPECS.soundboard.deleteTest, 1),
    changesFor(CHUNKS_DELETE_TEST, 1),
    changesFor(ATTACHMENT_DELETE_TEST, 1),
  ], r2);

  assert.equal(response.status, 200);
  await settled(ctx);
  assert.deepEqual(r2.calls, [{ op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "71" }]);
});

test("a shared soundboard attachment (sibling alive) rides nothing", async () => {
  const r2 = fakeR2();
  const { response, ctx } = await runExpressionDelete("soundboard", [
    { test: SPECS.soundboard.targetTest, first: async () => ({ attachment_id: 71 }) },
    changesFor(SPECS.soundboard.deleteTest, 1),
    changesFor(CHUNKS_DELETE_TEST, 1),
    changesFor(ATTACHMENT_DELETE_TEST, 0),
  ], r2);

  assert.equal(response.status, 200);
  await settled(ctx);
  assert.deepEqual(r2.calls, [], "the sole-referencer verdict is the ride's gate");
});

test("an emoji delete rides the attachment's R2 object when the row died", async () => {
  const r2 = fakeR2();
  const { response, ctx } = await runExpressionDelete("emoji", [
    { test: SPECS.emoji.targetTest, first: async () => ({ attachment_id: 72 }) },
    changesFor(SPECS.emoji.deleteTest, 1),
    changesFor(CHUNKS_DELETE_TEST, 1),
    changesFor(ATTACHMENT_DELETE_TEST, 1),
  ], r2);

  assert.equal(response.status, 200);
  await settled(ctx);
  assert.deepEqual(r2.calls, [{ op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "72" }]);
});

test("an emoji delete without the GC_MEDIA binding rides nothing, keeps the batch", async () => {
  const { response, db, ctx } = await runExpressionDelete("emoji", [
    { test: SPECS.emoji.targetTest, first: async () => ({ attachment_id: 72 }) },
    changesFor(SPECS.emoji.deleteTest, 1),
    changesFor(CHUNKS_DELETE_TEST, 1),
    changesFor(ATTACHMENT_DELETE_TEST, 1),
  ], null);

  assert.equal(response.status, 200);
  await settled(ctx);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 3);
});
