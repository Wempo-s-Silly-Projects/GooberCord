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

// Welcome cards (lane2-lifecycle recode): the server's own greeting. Mods
// write a short blurb once; every member pulls that blurb exactly once — a
// private, member-self-recorded greeting. The tests ride the EXISTING 0042
// tables (the prod ledger already holds the migration, so no new migration
// ships for this feature): the both-arms mod-gated upsert classified by its
// own changes count, the once-shown ledger keyed on the member's own row,
// and ?repeat=1 as the member's explicit re-show.
import test from "node:test";
import assert from "node:assert/strict";

import { handleWelcomeCardRoutes } from "../api/welcome-card.mjs";
import { GC_WELCOME_CARD_BLURB_MAX } from "../constants.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 12;

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleWelcomeCardRoutes(
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
const CARD_READ_TEST = (sql) => sql.startsWith("SELECT blurb_text FROM gc_welcome_cards");
const VIEW_READ_TEST = (sql) => sql.startsWith("SELECT shown_at FROM gc_welcome_card_views");
const VIEW_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_welcome_card_views");
const CARD_UPSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_welcome_cards");

async function run(method, path, routes = [], payload) {
  const token = randomToken();
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
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
  // Route overrides ride FIRST — a test that pins a miss (the non-member
  // 404) routes the shared statement itself.
  const db = fakeDb([
    ...routes,
    { test: SESSION_READ_TEST, first: () => row },
    { test: MEMBERSHIP_TEST, first: () => membership },
  ]);
  const response = await dispatch(request, okEnv(db));
  return { db, response, body: await bodyOf(response) };
}

const CARD_PATH = "/api/servers/" + SERVER_ID + "/welcome-card";

test("welcome-card PUT by a moderator upserts the blurb and echoes it verbatim", async () => {
  const blurb = "  welcome to the campfire  ";
  const { db, response, body } = await run("PUT", CARD_PATH, [
    { test: CARD_UPSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ], { blurb });
  assert.equal(response.status, 200);
  assert.equal(body.blurb, blurb, "the stored text is exactly what was sent, never trimmed");
  const upsert = db.calls.find((call) => CARD_UPSERT_TEST(call.sql));
  assert.ok(upsert, "the both-arms gated upsert ran");
  assert.equal(upsert.bound[0], SERVER_ID);
  assert.equal(upsert.bound[1], blurb);
  assert.equal(upsert.bound[3], USER_ID);
  assert.equal(upsert.bound[4], SERVER_ID);
  assert.equal(upsert.bound[5], USER_ID,
    "the conflict arm carries the same mod gate as the fresh arm");
});

test("welcome-card PUT by a non-mod answers the shared 404 (changes-0, no oracle)", async () => {
  const { db, response } = await run("PUT", CARD_PATH, [
    { test: CARD_UPSERT_TEST, run: () => ({ meta: { changes: 0 } }) },
  ], { blurb: "hi" });
  assert.equal(response.status, 404);
  assert.equal(db.calls.filter((call) => CARD_UPSERT_TEST(call.sql)).length, 1,
    "the intent fires the statement once and the gate classifies it");
});

test("welcome-card PUT refuses an empty or over-cap blurb before any table statement", async () => {
  for (const blurb of ["", "   ", "x".repeat(GC_WELCOME_CARD_BLURB_MAX + 1)]) {
    const { db, response } = await run("PUT", CARD_PATH, [], { blurb });
    assert.equal(response.status, 400);
    assert.equal(db.calls.filter((call) => call.call === "run").length, 0,
      "validation rides ahead of every seat statement");
  }
});

test("welcome-card PUT 401s a signed-out visitor", async () => {
  const db = fakeDb([]);
  const response = await dispatch(
    new Request(ORIGIN + CARD_PATH, {
      method: "PUT",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ blurb: "hi" }),
    }),
    okEnv(db),
  );
  assert.equal(response.status, 401);
  assert.equal(db.calls.filter((call) => CARD_UPSERT_TEST(call.sql)).length, 0);
});

test("welcome-card GET answers the blurb on first fetch and records the member's own view row", async () => {
  const { db, response, body } = await run("GET", CARD_PATH, [
    { test: CARD_READ_TEST, first: () => ({ blurb_text: "greetings, traveler" }) },
    { test: VIEW_READ_TEST, first: () => null },
    { test: VIEW_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.blurb, "greetings, traveler");
  assert.equal(body.shown, true);
  const insert = db.calls.find((call) => VIEW_INSERT_TEST(call.sql));
  assert.ok(insert, "the once-shown ledger insert ran");
  assert.equal(insert.bound[0], SERVER_ID);
  assert.equal(insert.bound[1], USER_ID);
});

test("welcome-card GET keeps the blurb silent on a second fetch", async () => {
  const { db, response, body } = await run("GET", CARD_PATH, [
    { test: CARD_READ_TEST, first: () => ({ blurb_text: "greetings, traveler" }) },
    { test: VIEW_READ_TEST, first: () => ({ shown_at: nowSeconds() }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.shown, true);
  assert.equal(body.blurb, null);
  assert.equal(db.calls.some((call) => VIEW_INSERT_TEST(call.sql)), false);
});

test("welcome-card GET re-shows on the member's own ?repeat=1", async () => {
  const { db, response, body } = await run("GET", CARD_PATH + "?repeat=1", [
    { test: CARD_READ_TEST, first: () => ({ blurb_text: "greetings, traveler" }) },
    { test: VIEW_READ_TEST, first: () => ({ shown_at: nowSeconds() }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.blurb, "greetings, traveler");
  assert.equal(db.calls.some((call) => VIEW_INSERT_TEST(call.sql)), false,
    "repeat serves the stored blurb without a second ledger write");
});

test("welcome-card GET answers the shared 404 for an unconfigured server", async () => {
  const { db, response } = await run("GET", CARD_PATH, [
    { test: CARD_READ_TEST, first: () => null },
  ]);
  assert.equal(response.status, 404);
  assert.equal(db.calls.some((call) => VIEW_INSERT_TEST(call.sql)), false,
    "no view row is recorded for a server with no card");
});

test("welcome-card GET answers the shared 404 for a non-member", async () => {
  const { response } = await run("GET", CARD_PATH, [
    { test: MEMBERSHIP_TEST, first: () => null },
  ]);
  assert.equal(response.status, 404);
});
