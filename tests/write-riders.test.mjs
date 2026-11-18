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

// The review NIT-1 riders (W-B2): the pin PUT/DELETE routes and the
// conversation read-marker route carry the WRITE bucket's limiter, keyed to
// the caller, riding BEFORE any table work. Same fakeDb + recording-limiter
// conventions as the search lane's tests.
import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { handleMessageRoutes } from "../api/messages.mjs";
import { handleConversationRoutes } from "../api/conversations.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const MESSAGE_ID = 40;
const CONVERSATION_ID = 3;

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

async function sessionRoute(role = "member") {
  const token = randomToken();
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: "csrf-" + USER_ID,
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
  const headers = {
    Origin: ORIGIN,
    "X-CSRF-Token": "csrf-" + USER_ID,
    Cookie: "goober_session=" + token,
  };
  return {
    headers,
    route: {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => row,
    },
  };
}

async function dispatchPin(method, session) {
  const db = fakeDb([
    session.route,
    // The classifier read: the message's own state + its channel's server.
    // The author IS the caller — the own-message pin right, the simplest
    // route through pinRights (the grants read still runs on a server
    // channel, so the fixture answers it).
    {
      test: (sql) => sql.includes("FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id") &&
        sql.includes("m.is_pinned"),
      first: async () => ({ author_id: USER_ID, is_pinned: 0, server_id: 1 }),
    },
    // The pin rights' grants read (rides even when the own-message right wins).
    {
      test: (sql) => sql.includes("AS tier") && sql.includes("AS mask"),
      first: async () => ({ tier: "member", mask: 0 }),
    },
  ]);
  const env = envWithRecordingLimiters(db);
  const path = "/api/messages/" + MESSAGE_ID + "/pin";
  const response = await handleMessageRoutes(
    new Request(ORIGIN + path, { method, headers: session.headers }), env, new URL(ORIGIN + path), path, method, undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  return { db, env, response };
}

test("PUT /pin rides the write bucket, keyed to the caller, before the table work", async () => {
  const session = await sessionRoute();
  const { db, env, response } = await dispatchPin("PUT", session);
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:pin:" + USER_ID),
  }]);
  const firstDbCall = db.calls[0];
  assert.equal(firstDbCall.call, "first");
  assert.match(firstDbCall.sql, /FROM sessions/, "the session read precedes everything");
  assert.ok(db.calls.findIndex((call) => call.call === "first") >= 0 &&
    db.calls.some((call) => call.call === "run" && call.sql.includes("UPDATE gc_messages")),
    "the pin update is the route's write");
});

test("DELETE /pin rides the same write bucket (the rider serves both pin verbs)", async () => {
  const session = await sessionRoute();
  const { env } = await dispatchPin("DELETE", session);
  assert.deepEqual(env.limiterCalls.map((call) => call.binding), ["GC_WRITE_RATE_LIMITER"]);
});

// --- the read-marker rider -------------------------------------------------------

async function dispatchReadMarker(session, body) {
  const db = fakeDb([
    session.route,
    // The member row: the gate + the classifier's current marker.
    {
      test: (sql) => sql.includes("SELECT last_read_message_id AS last_read FROM gc_conversation_members"),
      first: async () => ({ last_read: 10 }),
    },
  ]);
  const env = envWithRecordingLimiters(db);
  const path = "/api/conversations/" + CONVERSATION_ID + "/read";
  const response = await handleConversationRoutes(
    new Request(ORIGIN + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...session.headers },
      body: JSON.stringify(body),
    }), env, new URL(ORIGIN + path), path, "POST", undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  return { db, env, response };
}

test("POST /conversations/:id/read rides the write bucket before the member read", async () => {
  const session = await sessionRoute();
  const { db, env, response } = await dispatchReadMarker(session, { messageId: 11 });
  assert.equal(response.status, 200, await response.text());
  // The settled position is the marker route's response shape (0026).
  const payload = await dispatchReadMarker(session, { messageId: 11 }).then((r) => r.response.json());
  assert.deepEqual(payload, { lastReadMessageId: 11 });
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:read-marker:" + USER_ID),
  }]);
  // Order: the session read is the route's first D1 read (the limiter rides
  // between the session answer and the member read — it is not a D1 call,
  // so the member read being db.calls[1] with exactly one limiter entry is
  // the order pin).
  assert.match(db.calls[0].sql, /FROM sessions/, "the session read leads");
  assert.match(db.calls[1].sql, /last_read_message_id AS last_read/,
    "the member read is the marker route's next D1 read, the limiter between");
  assert.equal(env.limiterCalls.length, 1, "one rider call, exactly");
});

test("the rider fires before the shape classifier — a junk body still spends the limiter", async () => {
  const session = await sessionRoute();
  const { db, env, response } = await dispatchReadMarker(session, { messageId: "junk" });
  assert.equal(response.status, 400);
  assert.equal(env.limiterCalls.length, 1, "the limiter rode before the shape read");
  assert.equal(db.calls.some((call) => call.sql.includes("last_read_message_id AS last_read")), false,
    "a malformed body never reaches the member read");
});
