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

// Time capsules (lane2-lifecycle recode, migration 0052): the scheduled
// future-reveal letter. One schedule, one reveal, ZERO timers — the reveal
// is a row property compared against now at read time. The privacy pin runs
// through every pre-reveal arm: the letter's body rides EXACTLY ONE read
// (the post-reveal body read), so the tests assert both the payload shape
// and the absence of any body-bearing statement before the reveal.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCapsuleRoutes } from "../api/capsules.mjs";
import {
  GC_CAPSULE_BODY_MAX,
  GC_CAPSULE_MIN_AHEAD_SECONDS,
  GC_CAPSULE_MAX_AHEAD_SECONDS,
  GC_CAPSULES_MAX_OPEN_PER_MEMBER,
} from "../constants.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 12;

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleCapsuleRoutes(
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
const MEMBERSHIP_TEST = (sql) =>
  sql.includes("FROM gc_server_members") && sql.includes("server_id = ? AND user_id = ?");
const CAPSULE_CREATE_TEST = (sql) => sql.startsWith("INSERT INTO gc_time_capsules");
const CAPSULES_MINE_TEST = (sql) =>
  sql.startsWith("SELECT id, channel_id, reveal_at") && sql.includes("ORDER BY reveal_at");
const CAPSULE_AUTHOR_READ_TEST = (sql) =>
  sql.startsWith("SELECT id, author_id, channel_id, reveal_at") && sql.includes("author_id = ?");
const CAPSULE_BODY_READ_TEST = (sql) => sql.startsWith("SELECT body FROM gc_time_capsules");
const CAPSULE_VIEW_READ_TEST = (sql) =>
  sql.startsWith("SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules WHERE id = ?");
const CAPSULE_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_time_capsules");
const CHANNEL_ACCESS_TEST = (sql) =>
  sql.startsWith("SELECT c.id, c.server_id, c.kind FROM gc_channels");

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
  const membership = { role: "member" };
  const baseRoutes = [
    { test: SESSION_READ_TEST, first: () => row },
    { test: MEMBERSHIP_TEST, first: () => membership },
  ];
  const db = fakeDb([...routes, ...baseRoutes]);
  const response = await dispatch(request, okEnv(db));
  return { db, response, body: await bodyOf(response) };
}

test("capsule create seals a letter and answers the sealed shape", async () => {
  const revealAt = nowSeconds() + 3600;
  const { db, response, body } = await run("POST", "/api/servers/" + SERVER_ID + "/capsules", [
    {
      test: CAPSULE_CREATE_TEST,
      run: () => ({ meta: { changes: 1, last_row_id: 42 } }),
    },
  ], { body: "see you next year", revealAt });
  assert.equal(response.status, 201);
  assert.equal(body.id, 42);
  assert.equal(body.sealed, true);
  assert.equal("body" in body, false);
  const insert = db.calls.find((call) => CAPSULE_CREATE_TEST(call.sql));
  assert.ok(insert, "the guarded INSERT ran");
  assert.equal(insert.bound[0], USER_ID);
});

test("capsule create refuses a body outside the cap without storing anything", async () => {
  for (const raw of ["", "   ", "x".repeat(GC_CAPSULE_BODY_MAX + 1)]) {
    const outcome = await run("POST", "/api/servers/" + SERVER_ID + "/capsules", [],
      { body: raw, revealAt: nowSeconds() + 3600 });
    assert.equal(outcome.response.status, 400);
    assert.equal(outcome.db.calls.filter((call) => call.call === "run").length, 0);
  }
});

test("capsule create refuses a reveal_at outside the schedule window", async () => {
  for (const revealAt of [nowSeconds() + GC_CAPSULE_MIN_AHEAD_SECONDS - 1, nowSeconds() + GC_CAPSULE_MAX_AHEAD_SECONDS + 1]) {
    const outcome = await run("POST", "/api/servers/" + SERVER_ID + "/capsules", [],
      { body: "later", revealAt });
    assert.equal(outcome.response.status, 400);
  }
});

test("capsule create answers 409 when the open-cap gate changes zero rows", async () => {
  const { response, body } = await run("POST", "/api/servers/" + SERVER_ID + "/capsules", [
    { test: CAPSULE_CREATE_TEST, run: () => ({ meta: { changes: 0 } }) },
  ], { body: "later", revealAt: nowSeconds() + 3600 });
  assert.equal(response.status, 409);
  assert.match(body.error, /capsule/i);
});

test("capsule create 404s for a non-member without any table write", async () => {
  const { db, response } = await run("POST", "/api/servers/" + SERVER_ID + "/capsules", [
    { test: MEMBERSHIP_TEST, first: () => null },
  ], { body: "later", revealAt: nowSeconds() + 3600 });
  assert.equal(response.status, 404);
  assert.equal(db.calls.filter((call) => call.call === "run").length, 0);
});

test("capsule mine maps sealed per the row's reveal_at against now", async () => {
  const future = nowSeconds() + 600;
  const past = nowSeconds() - 600;
  const { response, body } = await run("GET", "/api/servers/" + SERVER_ID + "/capsules/mine", [
    {
      test: CAPSULES_MINE_TEST,
      all: () => ({
        results: [
          { id: 1, channel_id: null, reveal_at: future },
          { id: 2, channel_id: 55, reveal_at: past },
        ],
      }),
    },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.capsules[0].sealed, true);
  assert.equal("body" in body.capsules[0], false);
  assert.equal(body.capsules[1].sealed, false);
  assert.equal(body.capsules[1].channelId, 55);
});

test("capsule delete removes the author's open letter and answers ok", async () => {
  const { db, response, body } = await run("DELETE", "/api/servers/" + SERVER_ID + "/capsules/9", [
    {
      test: CAPSULE_AUTHOR_READ_TEST,
      first: () => ({ id: 9, author_id: USER_ID, channel_id: null, reveal_at: nowSeconds() + 600 }),
    },
    { test: CAPSULE_DELETE_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  const deleteCall = db.calls.find((call) => CAPSULE_DELETE_TEST(call.sql));
  assert.ok(deleteCall, "the guarded DELETE ran");
});

test("capsule delete answers 409 once the reveal has passed", async () => {
  const { db, response } = await run("DELETE", "/api/servers/" + SERVER_ID + "/capsules/9", [
    {
      test: CAPSULE_AUTHOR_READ_TEST,
      first: () => ({ id: 9, author_id: USER_ID, channel_id: null, reveal_at: nowSeconds() - 600 }),
    },
  ]);
  assert.equal(response.status, 409);
  assert.equal(db.calls.filter((call) => CAPSULE_DELETE_TEST(call.sql)).length, 0);
});

test("capsule delete answers 404 for a non-author (no oracle)", async () => {
  // The author seat rides the statement's WHERE (id = ? AND author_id = ?):
  // for a different viewer the shared author read simply misses.
  const outcome = await run("DELETE", "/api/servers/" + SERVER_ID + "/capsules/9", [
    { test: CAPSULE_AUTHOR_READ_TEST, first: () => null },
  ], undefined, 8);
  assert.equal(outcome.response.status, 404);
  assert.equal(outcome.db.calls.filter((call) => CAPSULE_DELETE_TEST(call.sql)).length, 0);
});

test("capsule reveal for the author pre-reveal answers sealed with NO body read anywhere", async () => {
  const { db, response, body } = await run("GET", "/api/servers/" + SERVER_ID + "/capsules/9", [
    {
      test: CAPSULE_AUTHOR_READ_TEST,
      first: () => ({ id: 9, author_id: USER_ID, channel_id: null, reveal_at: nowSeconds() + 600 }),
    },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.sealed, true);
  assert.equal("body" in body, false);
  assert.equal(db.calls.some((call) => CAPSULE_BODY_READ_TEST(call.sql)), false);
});

test("capsule reveal for the author post-reveal answers the letter body", async () => {
  const { response, body } = await run("GET", "/api/servers/" + SERVER_ID + "/capsules/9", [
    {
      test: CAPSULE_AUTHOR_READ_TEST,
      first: () => ({ id: 9, author_id: USER_ID, channel_id: null, reveal_at: nowSeconds() - 600 }),
    },
    { test: CAPSULE_BODY_READ_TEST, first: () => ({ body: "hello from the past" }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.sealed, false);
  assert.equal(body.body, "hello from the past");
});

test("capsule reveal for a non-author pre-reveal answers 404 and never reads a body", async () => {
  const outcome = await run("GET", "/api/servers/" + SERVER_ID + "/capsules/9", [
    { test: CAPSULE_AUTHOR_READ_TEST, first: () => null },
    { test: CAPSULE_VIEW_READ_TEST, first: () => null },
  ]);
  assert.equal(outcome.response.status, 404);
  assert.equal(outcome.db.calls.some((call) => CAPSULE_BODY_READ_TEST(call.sql)), false);
});

test("capsule reveal of a revealed channel letter rides the channel's VIEW gate", async () => {
  const { db, response, body } = await run("GET", "/api/servers/" + SERVER_ID + "/capsules/9", [
    { test: CAPSULE_AUTHOR_READ_TEST, first: () => null },
    {
      test: CAPSULE_VIEW_READ_TEST,
      first: () => ({ id: 9, author_id: 8, channel_id: 55, reveal_at: nowSeconds() - 600 }),
    },
    { test: CHANNEL_ACCESS_TEST, first: () => ({ id: 55, server_id: SERVER_ID, kind: "text" }) },
    { test: CAPSULE_BODY_READ_TEST, first: () => ({ body: "shared letter" }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.body, "shared letter");
  const channelRead = db.calls.find((call) => CHANNEL_ACCESS_TEST(call.sql));
  assert.ok(channelRead, "the channel gate read ran");
});

test("capsule reveal of a channel letter outside the viewer's membership answers 404", async () => {
  const { db, response } = await run("GET", "/api/servers/" + SERVER_ID + "/capsules/9", [
    { test: CAPSULE_AUTHOR_READ_TEST, first: () => null },
    {
      test: CAPSULE_VIEW_READ_TEST,
      first: () => ({ id: 9, author_id: 8, channel_id: 55, reveal_at: nowSeconds() - 600 }),
    },
    { test: CHANNEL_ACCESS_TEST, first: () => null },
    { test: CAPSULE_BODY_READ_TEST, first: () => ({ body: "shared letter" }) },
  ]);
  assert.equal(response.status, 404);
  assert.equal(db.calls.some((call) => CAPSULE_BODY_READ_TEST(call.sql)), false);
});
