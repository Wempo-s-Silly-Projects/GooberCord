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

// The message-delete R2 rides (lane-r2-sweep): gc_attachments.byte lives in
// the GC_MEDIA bucket keyed gc-attachments/<id> (api/media.mjs), so a doomed
// delete's batch must also empty the doomed rows' objects. The pins: the
// verdict-gated ride (the bucket follows the batch, never leads), the ride's
// ids from the SAME three-tier guarded pre-read the batch's deletes carry,
// the doomed gc_bookmarks sweep riding the same batch behind the same guard,
// the R2-failure never blocking the row verdict, and the local-dev
// no-GC_MEDIA shape scheduling nothing. Same fake conventions as
// tests/messages-module.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { handleMessageRoutes } from "../api/messages.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_ATTACHMENT_OBJECT_PREFIX, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

function jsonRequest(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMessageRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), ctx,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function fakeDb(routes) {
  const calls = [];
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
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      calls.push({
        call: "batch",
        sql: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

function fakeR2({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async delete(key) {
      calls.push({ op: "delete", key });
      if (fail) throw new Error("R2 down");
      return;
    },
  };
}

// A fake execution context: every scheduled ride is collected, then resolved
// by the test — pinning the waitUntil shape.
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

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

async function sessionFixtures(role = "member") {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
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
    token,
    row,
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

const DELETE_TEST = (sql) => sql.includes("DELETE FROM gc_messages");

// The ids pre-read: the doomed attachments, with the SAME three-tier guard
// the batch's chunk/attachment deletes spell (author / channel moderators /
// staff). key "gc-attachments/41".
const DOOMED_IDS_TEST = (sql) =>
  sql.startsWith("SELECT id FROM gc_attachments WHERE message_id = ?") &&
  sql.includes("author_id = ?");

async function deleteMessage(dbRoutes, { r2 = undefined, ctx = undefined } = {}) {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), ...dbRoutes]);
  const env = envWithLimiters({ GOOBER_DB: db, ...(r2 ? { GC_MEDIA: r2 } : {}) });
  const request = jsonRequest("DELETE", "/api/messages/5", undefined, headers);
  return { response: await dispatch(request, env, ctx), db };
}

const doomedRoute = { test: DOOMED_IDS_TEST, all: async () => ({ results: [{ id: 41 }, { id: 42 }] }) };
const deletedMessageRoute = { test: DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) };
const deletedNothingRoute = { test: DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) };

test("a successful message delete rides the doomed attachments' R2 objects", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteMessage([doomedRoute, deletedMessageRoute], { r2, ctx });

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  // The ride follows the verdict: after the batch's changes-1, exactly the
  // two pre-read doomed ids' objects are gone, keyed gc-attachments/<id>.
  await settled(ctx);
  assert.deepEqual(r2.calls, [
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "41" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "42" },
  ]);
});

test("the delete batch is chunks → attachments → bookmarks → message", async () => {
  const { response, db } = await deleteMessage([doomedRoute, deletedMessageRoute]);

  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 4);

  const bookmarksDelete = batch.statements[2];
  // The doomed bookmarks sweep carries the SAME tier guard the batch's other
  // doomed deletions carry — an unauthorized viewer's 404 path strips no
  // bookmark rows either.
  assert.match(
    bookmarksDelete.sql,
    /^DELETE FROM gc_bookmarks WHERE message_id = \? AND \(EXISTS \(SELECT 1 FROM gc_messages m WHERE m\.id = gc_bookmarks\.message_id AND m\.author_id = \?\) OR EXISTS \(SELECT 1 FROM gc_channels c JOIN gc_server_members sm ON sm\.server_id = c\.server_id WHERE c\.id = \(SELECT m2\.channel_id FROM gc_messages m2 WHERE m2\.id = \?\) AND sm\.user_id = \? AND sm\.role IN \('owner','moderator'\)\) OR \? = 1\)$/,
  );
  assert.deepEqual(bookmarksDelete.bound, [5, USER_ID, 5, USER_ID, 0]);
});

test("an R2 delete failure never blocks the row verdict", async () => {
  const r2 = fakeR2({ fail: true });
  const ctx = fakeCtx();
  const { response } = await deleteMessage([doomedRoute, deletedMessageRoute], { r2, ctx });

  // The row deletion is the gate; the failed best-effort ride surfaces only
  // as the ride attempt — never as a 5xx.
  assert.equal(response.status, 200);
  await settled(ctx);
  assert.equal(r2.calls.length, 2);
});

test("the ride goes to the caller's waitUntil, not an awaited leg", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteMessage([doomedRoute, deletedMessageRoute], { r2, ctx });

  // The response is NOT held for the R2 deletes: both ride ctx.waitUntil.
  assert.equal(response.status, 200);
  assert.equal(ctx.tasks.length, 2);
});

test("a 404 delete verdict schedules nothing", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteMessage([doomedRoute, deletedNothingRoute], { r2, ctx });

  assert.equal(response.status, 404);
  await settled(ctx);
  assert.deepEqual(r2.calls, [], "no object death rides a zero-change verdict");
});

test("a delete without the GC_MEDIA binding keeps the batch, rides nothing", async () => {
  const { response, db } = await deleteMessage([doomedRoute, deletedMessageRoute]);

  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 4);
});
