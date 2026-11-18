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

// The W-B2 server search lane: GET /api/servers/:id/search — the LIKE read
// over the server's text-channel bodies, member-gated with the per-hit VIEW
// gate riding the layer machinery, the LIKE escape riding the SQL's own
// ESCAPE arm, and the GC-shaped page cap (GC_SEARCH_PAGE_MAX 25). Same
// fakeDb + pinned-SQL conventions as the mentions lane's tests.
import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { handleServerRoutes } from "../api/servers.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { GC_SEARCH_PAGE_MAX, GC_SEARCH_TERM_MAX, RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 1;
const CHANNEL_ID = 3;

const CSRF = "the-csrf-token";
// readSession's cookie shape: the session token is 40-50 chars of
// [A-Za-z0-9_-] — a shorter cookie never reaches the DB read at all.
const SESSION_TOKEN = randomToken();

function jsonRequest(path) {
  return new Request(ORIGIN + path, {
    method: "GET",
    // requireUser's mutating trio: same-origin + the session's CSRF header +
    // the cookie (the search route is a USER route, not a read).
    headers: {
      Origin: ORIGIN,
      "X-CSRF-Token": CSRF,
      Cookie: "goober_session=" + SESSION_TOKEN,
    },
  });
}

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
        return { meta: { changes: 1, last_row_id: ++nextRowId }, results: [] };
      };
      return statement;
    },
  };
  return db;
}

function envWithRecordingLimiters(db) {
  const env = { GOOBER_DB: db, limiterCalls: [] };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = {
      limit: async ({ key }) => {
        env.limiterCalls.push({ binding, key });
        return { success: true, key };
      },
    };
  }
  return env;
}

// The session fixture rides the shape readSession builds from (the hash of
// the token the headers carry answers the binds; the route ignores them).
async function makeFixture(role = "member") {
  const row = {
    token_hash: await sha256Hex(SESSION_TOKEN),
    user_id: USER_ID,
    csrf_token: CSRF,
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
    test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
    first: async () => row,
  };
}

function hitRow(overrides = {}) {
  return {
    id: 40, channel_id: CHANNEL_ID, channel_name: "general", server_id: SERVER_ID,
    author_id: 9, author_username: "wem", body: "hello world", created_at: nowSeconds(),
    ...overrides,
  };
}

async function dispatchSearch(query, routes, sessionRoute) {
  _resetFilterWordsCacheForTests();
  const db = fakeDb([sessionRoute, ...routes]);
  const env = envWithRecordingLimiters(db);
  const path = "/api/servers/" + SERVER_ID + "/search" + query;
  const url = new URL(ORIGIN + path);
  const response = await handleServerRoutes(
    jsonRequest(path), env, url, url.pathname, "GET", undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  return { db, env, response };
}

const SEARCH_LIST_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN gc_channels c") && sql.includes("LIKE ? ESCAPE");
const MEMBERSHIP_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const OVERWRITES_EXIST_TEST = (sql) =>
  sql.includes("SELECT EXISTS(SELECT 1 FROM gc_channel_overwrites o JOIN gc_channels c");
const LAYER_MEMBERSHIP_TEST = (sql) =>
  sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const LAYER_ROLE_ROWS_TEST = (sql) =>
  sql.includes("FROM gc_member_roles gmr JOIN gc_roles r ON r.id = gmr.role_id");
const LAYER_CHAIN_TEST = (sql) =>
  sql.includes("FROM gc_channel_overwrites o") && sql.includes("o.channel_id = ? OR o.category_id");

// --- the page + the escape -----------------------------------------------------

test("a search answers the mapped hit shape, the GC-shaped 25 cap riding the SQL", async () => {
  const sessionRoute = await makeFixture();
  const { db, env, response } = await dispatchSearch("?q=hello", [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [hitRow()] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 0 }) },
  ], sessionRoute);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.results, [{
    id: 40, channelId: CHANNEL_ID, channelName: "general",
    authorId: 9, authorUsername: "wem", body: "hello world",
    createdAt: payload.results[0].createdAt,
  }]);
  const list = db.calls.find((call) => SEARCH_LIST_TEST(call.sql));
  assert.match(list.sql, /LIMIT 25/, "the page cap rides the LIMIT itself");
  assert.match(list.sql, /ORDER BY m\.id DESC/, "newest-first");
  assert.equal(list.bound[2], USER_ID, "the member-side EXISTS guard carries the caller");
  assert.equal(env.limiterCalls.length, 1, "one limiter call for the read");
  assert.equal(env.limiterCalls[0].binding, "GC_READ_RATE_LIMITER");
  // The limiter's own convention (the vendor's): the key is the SHA-256 of
  // "scope:actor" — the route handed it "read" + "user:7".
  assert.equal(env.limiterCalls[0].key, await sha256Hex("read:user:7"));
  assert.ok(db.calls.findIndex((call) => call.call === "first" && MEMBERSHIP_TEST(call.sql)) <
    db.calls.findIndex((call) => SEARCH_LIST_TEST(call.sql)),
    "the membership gate reads before any search");
});

test("the LIKE escape literalizes the user's % and _ (the ESCAPE arm)", async () => {
  const sessionRoute = await makeFixture();
  const { db, response } = await dispatchSearch("?q=hello%5Fworld%25", [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 0 }) },
  ], sessionRoute);
  assert.equal(response.status, 200);
  const search = db.calls.find((call) => SEARCH_LIST_TEST(call.sql));
  assert.equal(search.bound[1], "%hello\\_world\\%%",
    "every metacharacter is LITERALIZED, never a wildcard");
  assert.match(search.sql, /ESCAPE '\\'/, "the SQL's own ESCAPE arm carries the discipline");
});

test("the optional channel filter narrows via one more placeholder, never one extra bind", async () => {
  const sessionRoute = await makeFixture();
  const { db, response } = await dispatchSearch("?q=hello&channel=" + CHANNEL_ID, [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [hitRow()] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 0 }) },
  ], sessionRoute);
  assert.equal(response.status, 200);
  const list = db.calls.find((call) => SEARCH_LIST_TEST(call.sql));
  assert.match(list.sql, /AND c\.id = \?/, "the channel arm rode the SQL");
  assert.equal(list.bound.length, 4, "one bind per placeholder — exactly");
  assert.equal(list.bound[3], CHANNEL_ID);
});

// --- the shape errors ----------------------------------------------------------

test("the request shape: a missing, blank, oversized term or junk channel 400s and never reads", async () => {
  const sessionRoute = await makeFixture();
  assert.equal(GC_SEARCH_TERM_MAX, 100);
  const routes = [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 0 }) },
  ];
  const cases = [
    "", "?q=", "?q=" + "x".repeat(GC_SEARCH_TERM_MAX + 1), "?q=hello&channel=abc", "?q=hello&channel=0",
  ];
  for (const query of cases) {
    const { db, response } = await dispatchSearch(query, routes, sessionRoute);
    assert.equal(response.status, 400, query);
    assert.equal(db.calls.some((call) => SEARCH_LIST_TEST(call.sql)), false,
      "a malformed request never spends the search read");
  }
});

test("a non-member keeps the shared 403 (no existence oracle, no search read)", async () => {
  const sessionRoute = await makeFixture();
  const { db, response } = await dispatchSearch("?q=hello", [
    { test: MEMBERSHIP_TEST, first: async () => null },
  ], sessionRoute);
  assert.equal(response.status, 403);
  assert.equal(db.calls.some((call) => SEARCH_LIST_TEST(call.sql)), false);
});

// --- the per-hit VIEW gate -----------------------------------------------------

test("a server with no overwrites runs the graceful default — no per-hit reads at all", async () => {
  const sessionRoute = await makeFixture();
  const { db, response } = await dispatchSearch("?q=hello", [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [hitRow(), hitRow({ id: 41 })] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 0 }) },
  ], sessionRoute);
  const payload = await response.json();
  assert.equal(payload.results.length, 2, "both hits pass, ungated");
  assert.equal(db.calls.filter((call) => LAYER_MEMBERSHIP_TEST(call.sql)).length, 0,
    "the layer question never ran for a clean server");
});

test("with overwrites, an owner viewer keeps every hit; a VIEW-denied viewer's hits drop", async () => {
  // The owner half: readLayerContext's membership says owner → the bypass.
  const ownerRoute = await makeFixture("owner");
  const { response: ownerResponse } = await dispatchSearch("?q=hello", [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [hitRow()] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 1 }) },
    { test: LAYER_MEMBERSHIP_TEST, first: async () => ({ role: "owner" }) },
  ], ownerRoute);
  const ownerPayload = await ownerResponse.json();
  assert.equal(ownerPayload.results.length, 1, "the owner bypasses, the hit stays");
  assert.deepEqual(ownerPayload.results[0].id, 40);

  // The denied half: an @everyone deny-VIEW with no held role rows → the
  // effective mask loses VIEW → the hit DROPS (a dropped hit, never a thrown
  // 404 that would kill the whole page).
  const memberRoute = await makeFixture();
  const { response: deniedResponse, db: deniedDb } = await dispatchSearch("?q=hello", [
    { test: MEMBERSHIP_TEST, first: async () => ({ "1": 1 }) },
    { test: SEARCH_LIST_TEST, all: async () => ({ results: [hitRow()] }) },
    { test: OVERWRITES_EXIST_TEST, first: async () => ({ any_overwrites: 1 }) },
    { test: LAYER_MEMBERSHIP_TEST, first: async () => ({ role: "member" }) },
    { test: LAYER_ROLE_ROWS_TEST, all: async () => ({ results: [] }) },
    { test: LAYER_CHAIN_TEST, all: async () => ({ results: [
      { channel_id: CHANNEL_ID, role_id: null, category_id: null,
        allow_mask: 0, deny_mask: SERVER_PERMISSIONS.VIEW },
    ] }) },
  ], memberRoute);
  const deniedPayload = await deniedResponse.json();
  assert.deepEqual(deniedPayload.results, [], "the VIEW-denied channel's hit is dropped");
  assert.equal(deniedDb.calls.filter((call) => call.call === "first" && LAYER_MEMBERSHIP_TEST(call.sql)).length, 1,
    "the per-hit gate ran for the single candidate");
});
