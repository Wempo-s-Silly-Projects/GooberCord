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

// Bookmarks (lane2-lifecycle recode, migration 0053): the private reading
// queue. A bookmark is a THIN POINTER — owner_user_id, message_id,
// saved_at, and NOTHING else (no text copy, no read-state, no note). The
// contract the tests pin: the idempotent statement-gated save (a duplicate
// save rides the owner's OWN duplicate read, never a cross-member oracle),
// the owner-scoped newest-first list, and the delete whose wrong-owner and
// wrong-id shapes answer one shared 404 with no existence oracle.
import test from "node:test";
import assert from "node:assert/strict";

import { handleBookmarkRoutes } from "../api/bookmarks.mjs";
import { GC_BOOKMARKS_LIST_MAX } from "../constants.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleBookmarkRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
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
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

// The limiter stubs (the worker-dispatch okEnv idiom): a limiter map without
// the binding fails the route 503, so every fake env here carries the two
// pass-through limiters the routes ride.
const okEnv = (db) => ({
  GOOBER_DB: db,
  GC_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
  GC_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
});

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const BOOKMARK_SAVE_TEST = (sql) => sql.startsWith("INSERT INTO gc_bookmarks");
const BOOKMARK_DUPLICATE_TEST = (sql) =>
  sql.includes("FROM gc_bookmarks") && sql.includes("owner_user_id = ?") &&
  sql.includes("LIMIT 1");
const BOOKMARK_LIST_TEST = (sql) =>
  sql.startsWith("SELECT id, message_id, saved_at FROM gc_bookmarks");
const BOOKMARK_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_bookmarks");

async function run(method, path, routes = [], payload, viewerId = USER_ID) {
  const token = randomToken();
  const row = {
    token_hash: await sha256Hex(token),
    user_id: viewerId,
    csrf_token: "csrf-" + token,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role: "member",
  };
  const request = new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": "csrf-" + token,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const baseRoutes = [{ test: SESSION_READ_TEST, first: () => row }];
  const db = fakeDb([...routes, ...baseRoutes]);
  const response = await dispatch(request, okEnv(db));
  return { db, response, body: await bodyOf(response) };
}

test("bookmark save answers the saved shape with the statement gate", async () => {
  const { db, response, body } = await run("POST", "/api/messages/101/bookmark", [
    { test: BOOKMARK_SAVE_TEST, run: () => ({ meta: { changes: 1, last_row_id: 3 } }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.saved, true);
  assert.equal("duplicate" in body, false);
  const save = db.calls.find((call) => BOOKMARK_SAVE_TEST(call.sql));
  assert.ok(save, "the gated INSERT ran");
  assert.equal(save.bound[0], USER_ID);
  assert.equal(save.bound[1], 101);
});

test("bookmark save is idempotent through the owner-scoped duplicate read", async () => {
  const { db, response, body } = await run("POST", "/api/messages/101/bookmark", [
    { test: BOOKMARK_SAVE_TEST, run: () => ({ meta: { changes: 0 } }) },
    { test: BOOKMARK_DUPLICATE_TEST, all: () => ({ results: [{ one: 1 }] }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.saved, true);
  assert.equal(body.duplicate, true);
  const duplicate = db.calls.find((call) => BOOKMARK_DUPLICATE_TEST(call.sql));
  assert.equal(duplicate.bound[0], USER_ID, "the duplicate read is owner-scoped");
});

test("bookmark save answers the shared message 404 for an unreachable message", async () => {
  const { db, response } = await run("POST", "/api/messages/101/bookmark", [
    { test: BOOKMARK_SAVE_TEST, run: () => ({ meta: { changes: 0 } }) },
    { test: BOOKMARK_DUPLICATE_TEST, all: () => ({ results: [] }) },
  ]);
  assert.equal(response.status, 404);
  assert.equal(db.calls.filter((call) => BOOKMARK_SAVE_TEST(call.sql)).length, 1,
    "classification rides the gate result, never a pre-read");
});

test("bookmark list answers the caller's own pointers newest-first", async () => {
  const { db, response, body } = await run("GET", "/api/bookmarks", [
    {
      test: BOOKMARK_LIST_TEST,
      all: () => ({
        results: [
          { id: 3, message_id: 55, saved_at: 900 },
          { id: 1, message_id: 40, saved_at: 800 },
        ],
      }),
    },
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(body.bookmarks, [
    { id: 3, messageId: 55, savedAt: 900 },
    { id: 1, messageId: 40, savedAt: 800 },
  ]);
  const list = db.calls.find((call) => BOOKMARK_LIST_TEST(call.sql));
  assert.equal(list.bound[0], USER_ID, "the list read is owner-scoped");
  assert.match(list.sql, /ORDER BY saved_at DESC, id DESC/,
    "newest-first ordering lives in the read, not the mapper");
  assert.match(list.sql, new RegExp("LIMIT " + GC_BOOKMARKS_LIST_MAX));
});

test("bookmark list answers the valid empty shape for a member with none", async () => {
  const { response, body } = await run("GET", "/api/bookmarks");
  assert.equal(response.status, 200);
  assert.deepEqual(body.bookmarks, []);
});

test("bookmark unsave answers ok when the owner's own row changes", async () => {
  const { db, response, body } = await run("DELETE", "/api/bookmarks/3", [
    { test: BOOKMARK_DELETE_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  const remove = db.calls.find((call) => BOOKMARK_DELETE_TEST(call.sql));
  assert.equal(remove.bound[0], 3);
  assert.equal(remove.bound[1], USER_ID, "ownership rides INSIDE the WHERE");
});

test("bookmark unsave answers 404 for a wrong owner or a wrong id alike", async () => {
  const { response } = await run("DELETE", "/api/bookmarks/3", [
    { test: BOOKMARK_DELETE_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  assert.equal(response.status, 404);
});

test("bookmark save 401s a signed-out visitor", async () => {
  const db = fakeDb([]);
  const response = await dispatch(
    new Request(ORIGIN + "/api/messages/101/bookmark", {
      method: "POST",
      headers: { Origin: ORIGIN }, // no cookie, no CSRF token
    }),
    okEnv(db),
  );
  assert.equal(response.status, 401);
  assert.equal(db.calls.filter((call) => BOOKMARK_SAVE_TEST(call.sql)).length, 0);
});
