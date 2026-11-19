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

// Phase-3 social layer (api/social.mjs + the gates it shares): the friend
// graph, the two-tier block table, message reactions, and the DM gates the
// filed bullets demand. Same fakeDb + pinned-SQL contract style as the roles/
// mod-desk modules: every write's guard rides INSIDE the SQL, a refused write
// changes zero rows, and the exact filed error copies are pinned verbatim.
import test from "node:test";
import assert from "node:assert/strict";

import { handleSocialRoutes } from "../api/social.mjs";
import { handleMessageRoutes, sendMessageToChannel, UNSENDABLE_DM_COPY } from "../api/messages.mjs";
import { handleConversationRoutes } from "../api/conversations.mjs";
import { nowSeconds, randomToken, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_PLUS_REACTIONS, RATE_LIMIT_BINDINGS } from "../constants.mjs";

// The super-reaction tier (0020): one of the blessed sparkle set as the test
// subject, plus the strict perk predicate read the ADD route runs for one.
const SUPER_REACTION = GC_PLUS_REACTIONS[0];
const PLUS_READ_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;
const THIRD_ID = 33;
const MESSAGE_ID = 555;
const CHANNEL_ID = 401;

// --- shared scaffolding (same conventions as the other modules) ------------------

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function request(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatchVia(handlers, request, env) {
  const url = new URL(request.url);
  let response;
  for (const handler of handlers) {
    try {
      response = await handler(
        request, env, url, url.pathname, request.method.toUpperCase(), undefined,
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response = json(error.payload || { error: error.message }, error.status, error.headers);
    }
    if (response) return response;
  }
  return new Response(
    JSON.stringify({ error: "That API endpoint does not exist." }),
    { status: 404 },
  );
}

const dispatchSocial = (req, env) => dispatchVia([handleSocialRoutes], req, env);
// The worker chain order (messages first, social fall-through): the reaction
// routes live on /api/messages/:id/reactions, which the messages dispatch
// hands to handleSocialRoutes exactly like the real routeApi loop.
const dispatchMessages = (req, env) =>
  dispatchVia([handleMessageRoutes, handleSocialRoutes], req, env);
const dispatchConversations = (req, env) =>
  dispatchVia([handleConversationRoutes], req, env);

async function bodyOf(response) {
  return JSON.parse(await response.text());
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
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
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

function callsOf(db) {
  return db.calls;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

let SESSION = null;
async function session() {
  if (!SESSION) {
    const token = randomToken();
    const csrf = randomToken(24);
    SESSION = {
      token,
      csrf,
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
  return SESSION;
}

function envWithLimiters(db, overrides = {}) {
  const env = { GOOBER_DB: db, ...overrides };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// --- the SQL shapes the tests pin ------------------------------------------------

const USER_ROW_READ_TEST = (sql) =>
  sql.includes("FROM users WHERE") && (sql.includes("username = ?") || sql.includes("id = ?")) &&
  sql.includes("role");

const FRIENDSHIP_READ_TEST = (sql) =>
  sql.includes("FROM gc_friends") && sql.includes("user_a_id = ? AND user_b_id = ?");
const PENDING_PAIR_READ_TEST = (sql) =>
  sql.includes("FROM gc_friend_requests") && sql.includes("OR (requester_id = ?") &&
  sql.includes("LIMIT 1");
const REQUEST_GATE_READ_TEST = (sql) =>
  sql.includes("gc_social_prefs") && sql.includes("COALESCE");
const BLOCKED_PAIR_READ_TEST = (sql) =>
  sql.includes("FROM gc_blocks") && sql.includes("blocker_id = ? AND blocked_id = ?");
const PENDING_SENT_COUNT_TEST = (sql) =>
  sql.includes("COUNT(*)") && sql.includes("FROM gc_friend_requests WHERE requester_id = ?");
// docs/parity-limits.md: Friends 1000 — the sender's own graph both-sides sum.
const FRIENDS_COUNT_TEST = (sql) =>
  sql.includes("(SELECT COUNT(*) FROM gc_friends WHERE user_a_id = ?)") &&
  sql.includes("(SELECT COUNT(*) FROM gc_friends WHERE user_b_id = ?)");

const REQUEST_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_friend_requests") && sql.includes("DO NOTHING");
const FRIEND_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_friends");
const FRIEND_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_friends");
const REQUEST_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_friend_requests");

const BLOCK_WRITE_BATCH_START = "INSERT INTO gc_blocks";
const BLOCK_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_blocks");

const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c") && sql.includes("gc_conversation_members cm");
const CHANNEL_SHAPE_TEST = (sql) =>
  sql.includes("SELECT kind, server_id FROM gc_channels");
const MEMBER_GATE_TEST = (sql) =>
  sql.includes("FROM gc_server_members m JOIN users u") && sql.includes("timed_out_until");
const REACTION_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_message_reactions");
const REACTION_DELETE_OWN_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_message_reactions") && !sql.includes("role = 'owner'");
const REACTION_DELETE_MOD_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_message_reactions") && sql.includes("role = 'owner'");
const REACTION_GROUPED_TEST = (sql) =>
  sql.includes("FROM gc_message_reactions r JOIN users u ON u.id = r.user_id") &&
  sql.includes("ORDER BY");
const SERVER_OF_CHANNEL_TEST = (sql) =>
  sql.includes("SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1");
const MESSAGE_READ_TEST = (sql) =>
  sql.includes("FROM gc_messages m WHERE m.id = ? LIMIT 1");
const WORD_FILTER_TEST = (sql) =>
  sql.includes("site_settings") && sql.includes("filtered_words");
const MESSAGE_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_messages");

// One dm-channel message with member access granted; `timedOut` models the
// mod desk's member gate, `kind` the channel shape read both gates share,
// and `insertChanges`/`held` model the folded unique-reaction ceiling
// (docs/parity-limits.md: unique emoji per message 20): the INSERT's own
// WHERE arm decides, a zero-change run classifies by one EXISTS re-read (the
// caller's already-held emoji replays 201, a fresh emoji at cap answers the
// filed 400).
const REACTION_HELD_TEST = (sql) =>
  sql.startsWith("SELECT 1 AS held FROM gc_message_reactions");

function reactionRoutes({
  timedOut = false, kind = "dm", serverId = null, insertChanges = 1, held = false,
} = {}) {
  const row = SESSION.row;
  return [
    { test: SESSION_READ_TEST, first: async () => row },
    { test: MESSAGE_READ_TEST, first: async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID }) },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: serverId, kind }) },
    { test: CHANNEL_SHAPE_TEST, first: async () => ({ kind, server_id: serverId }) },
    // The folded cap INSERT (its WHERE arm decides) + the zero-change
    // classification re-read.
    { test: REACTION_INSERT_TEST, run: async () => ({ meta: { changes: insertChanges } }) },
    { test: REACTION_HELD_TEST, first: async () => (held ? { held: 1 } : null) },
    // The send / react gates' own server resolution (server channels only).
    ...(serverId !== null
      ? [{ test: SERVER_OF_CHANNEL_TEST, first: async () => ({ server_id: serverId }) }]
      : []),
    {
      test: MEMBER_GATE_TEST,
      first: async () => (timedOut
        ? { timed_out_until: nowSeconds() + 600, role: "member", joined_at: 1,
            account_created_at: 1, permissions: 0 }
        : { timed_out_until: null, role: "member", joined_at: 1,
            account_created_at: 1, permissions: 0 }),
    },
  ];
}

// --- friends -----------------------------------------------------------------------

test("POST /api/friends/requests by exact username resolves the target and inserts one row", async () => {
  const row = (await session()).row;
  const headers = (await session()).headers;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  const body = await bodyOf(response);
  assert.equal(body.request.userId, TARGET_ID);
  assert.equal(body.request.username, "ada");
  assert.equal(body.request.direction, "sent");

  const insert = callsOf(db).find((call) => REQUEST_INSERT_TEST(call.sql));
  assert.ok(insert, "the request INSERT ran");
  assert.deepEqual(insert.bound.slice(0, 2), [USER_ID, TARGET_ID]);
});

test("POST /api/friends/requests for a miss answers the filed miss copy with 400 and writes nothing", async () => {
  const row = (await session()).row;
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "no-such-name" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await bodyOf(response)).error,
    "That request didn't work. Double check that the username is correct.",
    "the filed miss copy, verbatim",
  );
  assert.equal(callsOf(db).some((call) => call.call === "run" || call.call === "batch"), false);
});

test("POST /api/friends/requests to yourself refuses with the miss copy", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: USER_ID, username: "wempos", role: "member" }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "wempos" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await bodyOf(response)).error,
    "That request didn't work. Double check that the username is correct.",
  );
});

test("POST /api/friends/requests when already friends answers 400 before the gate reads", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: FRIENDSHIP_READ_TEST, first: async () => ({ 1: 1 }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "You're already friends with that user.");
  assert.equal(callsOf(db).some((call) => REQUEST_GATE_READ_TEST(call.sql)), false);
  assert.equal(callsOf(db).some((call) => BLOCKED_PAIR_READ_TEST(call.sql)), false);
});

test("POST /api/friends/requests with a pending pair answers 400", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: FRIENDSHIP_READ_TEST, first: async () => null },
    { test: PENDING_PAIR_READ_TEST, first: async () => ({ 1: 1 }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "That friend request is already pending.");
});

test("POST /api/friends/requests honors the target's closed requests with the filed copy", async () => {
  const row = (await session()).row;
  const callOrder = [];
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: FRIENDSHIP_READ_TEST, first: async () => null },
    { test: PENDING_PAIR_READ_TEST, first: async () => null },
    {
      test: REQUEST_GATE_READ_TEST,
      first: async () => {
        callOrder.push("gate");
        return { accept_requests: 0 };
      },
    },
    {
      test: BLOCKED_PAIR_READ_TEST,
      first: async () => {
        callOrder.push("blocks");
        return null;
      },
    },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await bodyOf(response)).error,
    "This user isn't accepting friend requests right now.",
    "the filed Everyone-vs-OFF copy",
  );
  assert.deepEqual(callOrder, ["gate"], "the prefs gate is read BEFORE the blocks pair");
});

test("POST /api/friends/requests refuses a blocked pair (either direction) with 400", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: FRIENDSHIP_READ_TEST, first: async () => null },
    { test: PENDING_PAIR_READ_TEST, first: async () => null },
    { test: REQUEST_GATE_READ_TEST, first: async () => ({ accept_requests: 1 }) },
    { test: BLOCKED_PAIR_READ_TEST, first: async () => ({ 1: 1 }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "You can't send a friend request to that user.");
  assert.equal(callsOf(db).some((call) => call.call === "batch"), false);
});

test("POST /api/friends/requests refuses an oversized pending-request list (the cheap cap)", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: FRIENDSHIP_READ_TEST, first: async () => null },
    { test: PENDING_PAIR_READ_TEST, first: async () => null },
    { test: REQUEST_GATE_READ_TEST, first: async () => ({ accept_requests: 1 }) },
    { test: BLOCKED_PAIR_READ_TEST, first: async () => null },
    { test: PENDING_SENT_COUNT_TEST, first: async () => ({ n: 20 }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /pending/i);
});

// docs/parity-limits.md: Friends 1000 (verified 2026-11-17) — the mirror
// constant rode Discord's real row, and the ceiling read is the sender's own
// graph both sides summed.
test("POST /api/friends/requests at the 1000-friend ceiling refuses with the full-list copy", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: PENDING_SENT_COUNT_TEST, first: async () => ({ n: 0 }) },
    { test: FRIENDS_COUNT_TEST, first: async () => ({ n: 1000 }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "Your friends list is full.");
  assert.equal(callsOf(db).some((call) => REQUEST_INSERT_TEST(call.sql)), false);
});

test("POST /api/friends/requests accepts the userId form and refuses ambiguous bodies", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
  ]);
  const body = await bodyOf(await dispatchSocial(
    request("POST", "/api/friends/requests", { userId: TARGET_ID }, (await session()).headers),
    envWithLimiters(db),
  ));
  assert.equal(body.request.userId, TARGET_ID);
  const lookup = callsOf(db).find((call) => USER_ROW_READ_TEST(call.sql));
  assert.deepEqual(lookup.bound, [TARGET_ID]);

  for (const bad of [{}, { username: "ada", userId: TARGET_ID }, { userId: 0 }]) {
    const refused = await dispatchSocial(
      request("POST", "/api/friends/requests", bad, (await session()).headers),
      envWithLimiters(fakeDb([{ test: SESSION_READ_TEST, first: async () => row }])),
    );
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
});

test("friend request decisions are TARGET-side only and accept installs the canonical pair", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("FROM users WHERE id = ?") && sql.includes("username"),
      first: async () => ({ username: "ada" }),
    },
  ]);
  // Accept a request from a HIGHER user id: the pair must store (min, max).
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests/accept", { userId: THIRD_ID }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.decision, "accepted");
  assert.equal(body.friend.userId, THIRD_ID);

  const insert = callsOf(db).find((call) => FRIEND_INSERT_TEST(call.sql));
  assert.ok(insert, "accept installs the friendship");
  assert.deepEqual(insert.bound.slice(0, 2), [USER_ID, THIRD_ID], "canonical pair: user_a_id < user_b_id");

  const removed = callsOf(db).find((call) => REQUEST_DELETE_TEST(call.sql));
  assert.deepEqual(removed.bound, [THIRD_ID, USER_ID], "the target side deletes the row");
});

test("decline deletes the request and never inserts a friendship", async () => {
  const row = (await session()).row;
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests/decline", { userId: TARGET_ID }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  assert.equal((await bodyOf(response)).decision, "declined");
  assert.equal(callsOf(db).some((call) => FRIEND_INSERT_TEST(call.sql)), false);
});

test("a non-target (or the requester) can never settle someone else's pending row", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    // The target-side DELETE changes zero rows for an outsider.
    { test: REQUEST_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests/accept", { userId: TARGET_ID }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 404);
  assert.equal((await bodyOf(response)).error, "That friend request doesn't exist.");
  assert.equal(callsOf(db).some((call) => FRIEND_INSERT_TEST(call.sql)), false);
});

test("the outgoing cancel deletes only the caller's own sent row", async () => {
  const row = (await session()).row;
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatchSocial(
    request("DELETE", "/api/friends/requests/" + TARGET_ID, undefined, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const removed = callsOf(db).find((call) => REQUEST_DELETE_TEST(call.sql));
  assert.deepEqual(removed.bound, [USER_ID, TARGET_ID], "requester = caller, target = the route id");
});

test("DELETE /api/friends/:id unfriends with the canonical pair binds (either side)", async () => {
  const row = (await session()).row;
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatchSocial(
    request("DELETE", "/api/friends/" + THIRD_ID, undefined, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const removed = callsOf(db).find((call) => FRIEND_DELETE_TEST(call.sql));
  assert.deepEqual(removed.bound, [USER_ID, THIRD_ID, THIRD_ID, USER_ID]);
});

test("unfriend / cancel answer 404 when zero rows changed", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: FRIEND_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: REQUEST_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  assert.equal((await dispatchSocial(
    request("DELETE", "/api/friends/" + TARGET_ID, undefined, (await session()).headers),
    envWithLimiters(db),
  )).status, 404);
  assert.equal((await dispatchSocial(
    request("DELETE", "/api/friends/requests/" + TARGET_ID, undefined, (await session()).headers),
    envWithLimiters(db),
  )).status, 404);
});

test("GET /api/friends returns the four-facet hub payload with the COALESCE'd default", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("FROM gc_friends f JOIN users u"),
      all: async () => ({
        results: [{ user_id: TARGET_ID, username: "ada", created_at: nowSeconds() }],
      }),
    },
    {
      test: (sql) => sql.includes("FROM gc_friend_requests r JOIN users u ON u.id = r.target_id"),
      all: async () => ({ results: [{ user_id: THIRD_ID, username: "bean", created_at: nowSeconds() }] }),
    },
    {
      test: (sql) => sql.includes("FROM gc_friend_requests r JOIN users u ON u.id = r.requester_id"),
      all: async () => ({ results: [] }),
    },
    { test: REQUEST_GATE_READ_TEST, first: async () => null },
  ]);
  const response = await dispatchSocial(get("/api/friends", (await session()).headers), envWithLimiters(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.friends.length, 1);
  assert.equal(body.friends[0].userId, TARGET_ID);
  assert.equal(body.pendingSent.length, 1);
  assert.equal(body.pendingReceived.length, 0);
  assert.equal(body.settings.acceptRequests, true, "an absent prefs row reads as the open default");
});

test("PUT /api/friends/settings upserts the binary accept_requests value", async () => {
  const row = (await session()).row;
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatchSocial(
    request("PUT", "/api/friends/settings", { acceptRequests: false }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await bodyOf(response)).settings, { acceptRequests: false });
  const upsert = callsOf(db).find((call) => call.sql.includes("INSERT INTO gc_social_prefs"));
  assert.deepEqual(upsert.bound.slice(0, 2), [USER_ID, 0]);
  assert.equal(typeof upsert.bound[2], "number", "updated_at rides the upsert");
  assert.match(upsert.sql, /ON CONFLICT\(user_id\) DO UPDATE/);

  const refused = await dispatchSocial(
    request("PUT", "/api/friends/settings", { acceptRequests: "maybe" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(refused.status, 400);
});

// --- blocks ------------------------------------------------------------------------

test("PUT /api/blocks/:userId refuses self, unknown targets, staff, and bad kinds", async () => {
  const row = (await session()).row;
  const base = [
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
  ];
  assert.equal((await dispatchSocial(
    request("PUT", "/api/blocks/" + USER_ID, { kind: "blocked" }, (await session()).headers),
    envWithLimiters(fakeDb(base)),
  )).status, 400, "self-target");

  assert.equal((await dispatchSocial(
    request("PUT", "/api/blocks/" + TARGET_ID, { kind: "muted" }, (await session()).headers),
    envWithLimiters(fakeDb(base)),
  )).status, 400, "bad kind");

  // The override comes FIRST: fakeDb takes the first route whose test matches.
  assert.equal((await dispatchSocial(
    request("PUT", "/api/blocks/" + TARGET_ID, { kind: "blocked" }, (await session()).headers),
    envWithLimiters(fakeDb([
      { test: USER_ROW_READ_TEST, first: async () => null },
      ...base,
    ])),
  )).status, 400, "unknown target");

  assert.equal((await dispatchSocial(
    request("PUT", "/api/blocks/" + TARGET_ID, { kind: "blocked" }, (await session()).headers),
    envWithLimiters(fakeDb([
      { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "owner", role: "owner" }) },
      ...base,
    ])),
  )).status, 400, "the platform-staff tier is never the target");
});

test("PUT /api/blocks/:userId with kind blocked dissolves the pair IN THE SAME BATCH", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: THIRD_ID, username: "bean", role: "member" }) },
  ]);
  const response = await dispatchSocial(
    request("PUT", "/api/blocks/" + THIRD_ID, { kind: "blocked" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.block.kind, "blocked");
  assert.equal(body.block.userId, THIRD_ID);

  const batch = callsOf(db).find((call) => call.call === "batch");
  assert.ok(batch, "the dissolve rides the upsert's batch");
  const sqls = batch.statements.map((statement) => statement.sql);
  assert.ok(sqls.some((sql) => sql.startsWith(BLOCK_WRITE_BATCH_START) && sql.includes("DO UPDATE")));
  assert.ok(sqls.some((sql) => FRIEND_DELETE_TEST(sql)), "the friendship row is dissolved");
  assert.ok(sqls.some((sql) => REQUEST_DELETE_TEST(sql)), "pending requests are dissolved");
  const friendDelete = batch.statements.find((statement) => FRIEND_DELETE_TEST(statement.sql));
  assert.deepEqual(friendDelete.bound, [USER_ID, THIRD_ID, THIRD_ID, USER_ID]);
  // The upsert is the kind-switch contract (block <-> ignore is a PUT away).
  assert.match(
    batch.statements[0].sql,
    /ON CONFLICT\(blocker_id, blocked_id\) DO UPDATE SET kind = excluded\.kind/,
  );
});

test("PUT /api/blocks/:userId with kind ignored changes NOTHING else (the soft tier)", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: THIRD_ID, username: "bean", role: "member" }) },
  ]);
  const response = await dispatchSocial(
    request("PUT", "/api/blocks/" + THIRD_ID, { kind: "ignored" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const batch = callsOf(db).find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 1, "no friendship/request delete rides an ignore");
});

test("DELETE /api/blocks/:userId deletes the caller's own row only", async () => {
  const row = (await session()).row;
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatchSocial(
    request("DELETE", "/api/blocks/" + TARGET_ID, undefined, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const removed = callsOf(db).find((call) => BLOCK_DELETE_TEST(call.sql));
  assert.deepEqual(removed.bound, [USER_ID, TARGET_ID]);

  const missing = await dispatchSocial(
    request("DELETE", "/api/blocks/" + TARGET_ID, undefined, (await session()).headers),
    envWithLimiters(fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: BLOCK_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
    ])),
  );
  assert.equal(missing.status, 404);
});

test("GET /api/blocks maps the rows to the combined two-tier list", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("FROM gc_blocks b LEFT JOIN users u"),
      all: async () => ({
        results: [
          { blocked_id: TARGET_ID, kind: "blocked", username: "ada", created_at: nowSeconds() },
          { blocked_id: THIRD_ID, kind: "ignored", username: "bean", created_at: nowSeconds() },
        ],
      }),
    },
  ]);
  const body = await bodyOf(await dispatchSocial(
    get("/api/blocks", (await session()).headers), envWithLimiters(db),
  ));
  assert.deepEqual(body.blocked.map((entry) => [entry.userId, entry.kind]), [
    [TARGET_ID, "blocked"],
    [THIRD_ID, "ignored"],
  ]);
});

// --- reactions ---------------------------------------------------------------------

test("PUT /api/messages/:id/reactions inserts the toggle-on row after the gates", async () => {
  const db = fakeDb(reactionRoutes());
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).reaction.emoji, "🔥");

  const insert = callsOf(db).find((call) => REACTION_INSERT_TEST(call.sql));
  assert.ok(insert, "the toggle-on INSERT ran");
  assert.equal(insert.bound[0], MESSAGE_ID);
  assert.equal(insert.bound[1], USER_ID);
  assert.equal(insert.bound[2], "🔥");

  // The gate order: channel access, then the member gates, then the INSERT —
  // the unique-reaction ceiling rides the INSERT's own WHERE arm (the
  // verifier's race fold), and the classification re-read runs only after a
  // zero-change run (never here).
  const accessIndex = callsOf(db).findIndex((call) => CHANNEL_ACCESS_TEST(call.sql));
  const gateIndex = callsOf(db).findIndex((call) => MEMBER_GATE_TEST(call.sql));
  const insertIndex = callsOf(db).findIndex((call) => REACTION_INSERT_TEST(call.sql));
  assert.ok(accessIndex < insertIndex && gateIndex < insertIndex);
  // The cap arms live in the INSERT, verbatim shapes: the caller's already-
  // held emoji replays, and the distinct-emoji ceiling < 20 with the parity
  // law's exact number (unique emoji per message 20, error 30010).
  assert.match(insert.sql, /WHERE EXISTS \(SELECT 1 FROM gc_message_reactions/);
  assert.match(insert.sql, /OR \(SELECT COUNT\(DISTINCT emoji\) FROM gc_message_reactions WHERE message_id = \?\) < /);
  assert.ok(
    insert.sql.includes("OR (SELECT COUNT(DISTINCT emoji) FROM gc_message_reactions WHERE message_id = ?) < 20"),
  );
  assert.deepEqual(insert.bound.slice(4, 8), [MESSAGE_ID, USER_ID, "🔥", MESSAGE_ID]);
});

// parity-limits.md: unique emoji per message (reactions) 20, error 30010
// (verified 2026-11-17) — the 21st NEW emoji's folded WHERE arm refuses the
// INSERT (zero changes); the classification re-read answers the filed 400
// copy verbatim, and the per-emoji reactor count is unlimited.
test("the 21st distinct emoji at the ceiling 400s without writing a reaction row", async () => {
  const db = fakeDb(reactionRoutes({ insertChanges: 0 }));
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🎉" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "This message already has 20 different reactions.",
  });
  const insert = callsOf(db).find((call) => REACTION_INSERT_TEST(call.sql));
  assert.ok(insert, "the capped INSERT itself carries the ceiling (and wrote zero rows)");
  assert.equal(insert.call, "run");
  assert.ok(callsOf(db).some((call) => REACTION_HELD_TEST(call.sql)),
    "the zero-change run is classified by the EXISTS re-read");
});

test("the ceiling does NOT refuse the caller's own emoji repeat (the re-read replays 201)", async () => {
  const db = fakeDb(reactionRoutes({ insertChanges: 0, held: true }));
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🎉" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).reaction.mine, true);
});

test("under the ceiling every new emoji inserts as before", async () => {
  const db = fakeDb(reactionRoutes({ insertChanges: 1 }));
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🎉" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  assert.equal(callsOf(db).some((call) => REACTION_HELD_TEST(call.sql)), false,
    "a one-change INSERT classifies directly — no re-read");
});

test("a timed-out member CANNOT ADD a reaction (403, the mod desk's reaction gate note)", async () => {
  // The gate rides the message's channel's SERVER membership (timeouts are a
  // server concept); a dm/group channel passes untouched.
  const db = fakeDb(reactionRoutes({ timedOut: true, kind: "text", serverId: 5 }));
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.match((await bodyOf(response)).error, /You are timed out until /);
  assert.equal(callsOf(db).some((call) => REACTION_INSERT_TEST(call.sql)), false);
});

test("a timed-out member CAN still remove their own reaction (the removal runs no gate)", async () => {
  const db = fakeDb(reactionRoutes({ timedOut: true, kind: "text", serverId: 5 }));
  const response = await dispatchMessages(
    request("DELETE", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  assert.equal(callsOf(db).some((call) => MEMBER_GATE_TEST(call.sql)), false);
});

test("PUT /api/messages/:id/reactions refuses an empty or oversized emoji with 400", async () => {
  const db = fakeDb(reactionRoutes());
  for (const emoji of ["", "   ", "x".repeat(33)]) {
    const response = await dispatchMessages(
      request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji }, (await session()).headers),
      envWithLimiters(db),
    );
    assert.equal(response.status, 400, JSON.stringify(emoji));
  }
  assert.equal(callsOf(db).some((call) => REACTION_INSERT_TEST(call.sql)), false);
});

test("reaction routes answer 404 for a message the viewer cannot reach", async () => {
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await session()).row },
    { test: MESSAGE_READ_TEST, first: async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID }) },
    { test: CHANNEL_ACCESS_TEST, first: async () => null },
  ]);
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 404, "a non-member's reaction never 403s");
});

test("DELETE without user_id removes only the caller's own row and 404s otherwise", async () => {
  const db = fakeDb(reactionRoutes());
  const response = await dispatchMessages(
    request("DELETE", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const removed = callsOf(db).find((call) => REACTION_DELETE_OWN_TEST(call.sql));
  assert.deepEqual(removed.bound, [MESSAGE_ID, USER_ID, "🔥"]);
  assert.equal(removed.sql.includes("role = 'owner'"), false, "the own-removal carries NO guard");

  const missing = await dispatchMessages(
    request("DELETE", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(fakeDb([
      ...reactionRoutes(),
      { test: REACTION_DELETE_OWN_TEST, run: async () => ({ meta: { changes: 0 } }) },
    ])),
  );
  assert.equal(missing.status, 404);
});

test("DELETE with user_id refuses a dm-channel target (no moderation tier in a DM)", async () => {
  const db = fakeDb(reactionRoutes());
  const response = await dispatchMessages(
    request(
      "DELETE",
      "/api/messages/" + MESSAGE_ID + "/reactions?user_id=" + TARGET_ID,
      { emoji: "🔥" },
      (await session()).headers,
    ),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "Only the author can remove that reaction.");
});

test("DELETE with user_id on a server channel carries the moderation guard (DELETE_MESSAGES class)", async () => {
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await session()).row },
    { test: MESSAGE_READ_TEST, first: async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID }) },
    { test: CHANNEL_SHAPE_TEST, first: async () => ({ kind: "text", server_id: 5 }) },
    { test: SERVER_OF_CHANNEL_TEST, first: async () => ({ server_id: 5 }) },
  ]);
  const response = await dispatchMessages(
    request(
      "DELETE",
      "/api/messages/" + MESSAGE_ID + "/reactions?user_id=" + TARGET_ID,
      { emoji: "🔥" },
      (await session()).headers,
    ),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);

  const removed = callsOf(db).find((call) => REACTION_DELETE_MOD_TEST(call.sql));
  assert.ok(removed, "the guarded mod DELETE ran");
  // The guard fragments replicate api/servers.mjs's moderationGuardSql, in
  // its H1 (RBAC audit) per-bit-EXISTS form: the string-tier owner arm + the
  // exact role-bit EXISTS (no SUM — a SUM carried 2×bit into phantom higher
  // bits) + the two positions.
  assert.match(removed.sql, /role = 'owner'/);
  assert.match(removed.sql, /gc_member_roles gbm16 JOIN gc_roles gbr16/);
  assert.match(removed.sql, /\(gbr16\.permissions & 16\) <> 0/);
  assert.match(removed.sql, /COALESCE\(MAX\(hr\.position\), -1\)/);
  // DELETE_MESSAGES = 1 << 4: the per-bit EXISTS binds exactly the (server,
  // actor) pair — no mask pair rides anywhere.
  assert.equal(removed.bound.includes(16), false, "no bit constants ride as binds");
  assert.deepEqual(removed.bound.slice(0, 3), [MESSAGE_ID, TARGET_ID, "🔥"]);
});

test("DELETE with user_id answers 403 when the guard refuses (position-rule parity)", async () => {
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await session()).row },
    { test: MESSAGE_READ_TEST, first: async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID }) },
    { test: CHANNEL_SHAPE_TEST, first: async () => ({ kind: "text", server_id: 5 }) },
    { test: SERVER_OF_CHANNEL_TEST, first: async () => ({ server_id: 5 }) },
    { test: REACTION_DELETE_MOD_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatchMessages(
    request(
      "DELETE",
      "/api/messages/" + MESSAGE_ID + "/reactions?user_id=" + TARGET_ID,
      { emoji: "🔥" },
      (await session()).headers,
    ),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "You do not have permission to do that.");
});

test("GET /api/messages/:id/reactions returns the per-emoji user lists", async () => {
  const db = fakeDb([
    ...reactionRoutes(),
    {
      test: REACTION_GROUPED_TEST,
      all: async () => ({
        results: [
          { emoji: "🔥", user_id: USER_ID, username: "wempos" },
          { emoji: "🔥", user_id: TARGET_ID, username: "ada" },
          { emoji: "🙂", user_id: THIRD_ID, username: "bean" },
        ],
      }),
    },
  ]);
  const response = await dispatchMessages(
    get("/api/messages/" + MESSAGE_ID + "/reactions", (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.reactions.map((entry) => [entry.emoji, entry.users.length]), [
    ["🔥", 2],
    ["🙂", 1],
  ]);
});

// --- the DM send gate (the block side effect, shared REST + DO) ----------------------

test("a BLOCKED member's DM send is refused with the unsendable-DM copy", async () => {
  const db = fakeDb([
    { test: WORD_FILTER_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    { test: CHANNEL_SHAPE_TEST, first: async () => ({ kind: "dm", server_id: null }) },
    {
      test: (sql) => sql.includes("FROM gc_conversation_members om JOIN gc_blocks b"),
      first: async () => ({ 1: 1 }),
    },
  ]);
  const env = envWithLimiters(db);
  await assert.rejects(
    () => sendMessageToChannel(env, { id: USER_ID, username: "wempos", role: "member" },
      CHANNEL_ID, "hello", "cccccccc"),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.message, UNSENDABLE_DM_COPY);
      return true;
    },
  );
  assert.equal(
    callsOf(db).some((call) => MESSAGE_INSERT_TEST(call.sql)),
    false,
    "a refused send leaves no row behind",
  );
});

test("the send gate reads the channel shape first and skips the block read on server channels", async () => {
  const sentRow = {
    id: MESSAGE_ID, author_id: USER_ID, author_name: "wempos", body: "hello",
    client_message_id: null, source: null, created_at: nowSeconds(), edited_at: null,
    author_accent: null,
  };
  const reselectTest = (sql) => sql.includes("SELECT m.id, m.author_id");
  const db = fakeDb([
    { test: WORD_FILTER_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    { test: CHANNEL_SHAPE_TEST, first: async () => ({ kind: "text", server_id: 5 }) },
    {
      test: MEMBER_GATE_TEST,
      first: async () => ({ timed_out_until: null, role: "owner", joined_at: 1,
        account_created_at: 1, permissions: 0 }),
    },
    { test: (sql) => sql.startsWith("INSERT INTO gc_messages") },
    { test: (sql) => sql.includes("UPDATE gc_channels SET"), run: async () => ({ meta: { changes: 1 } }) },
    {
      test: reselectTest,
      // The reselect runs INSIDE the batch: a batch statement's `run` answers
      // with the resolved row.
      run: async () => ({ meta: { changes: 1 }, results: [sentRow] }),
      all: async () => ({ results: [sentRow] }),
    },
  ]);
  const env = { ...envWithLimiters(db), PASSWORD_PEPPER: "" };
  const result = await sendMessageToChannel(
    env, { id: USER_ID, username: "wempos", role: "member" }, CHANNEL_ID, "hello", null,
  );
  assert.equal(result.created, true);
  assert.equal(
    callsOf(db).some((call) => call.sql.includes("FROM gc_conversation_members om JOIN gc_blocks b")),
    false,
    "a server channel's send never runs the DM block read",
  );
});

test("the unsendable copy carries the delivered-block reason (the filed Clyde wording)", async () => {
  assert.match(UNSENDABLE_DM_COPY, /^Your message could not be delivered\./);
});

// --- the DM thread gate (conversation creation) --------------------------------------

function conversationRoutes({ gate = null } = {}) {
  const row = SESSION.row;
  return [
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("FROM users WHERE id IN") && sql.includes("username"),
      all: async (bound) => ({
        results: bound.filter((id) => Number(id) !== USER_ID)
          .map((id) => ({ id: Number(id), username: "user" + id })),
      }),
    },
    {
      test: (sql) => sql.includes("FROM blocks") || sql.includes("FROM gc_blocks"),
      first: async () => null,
    },
    { test: REQUEST_GATE_READ_TEST, first: async () => gate },
  ];
}

test("creating a DM to a requests-closed NON-FRIEND is refused (403, no channel insert)", async () => {
  const row = (await session()).row;
  const db = fakeDb(conversationRoutes({
    gate: { accept_requests: 0, friends: 0 },
  }));
  const response = await dispatchConversations(
    request("POST", "/api/conversations", { userIds: [TARGET_ID] }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "That member only accepts messages from friends.");
  assert.equal(
    callsOf(db).some((call) => call.sql.startsWith("INSERT INTO gc_channels")),
    false,
    "a refused thread creates nothing",
  );
});

test("a requests-closed target who IS a friend still admits the DM thread", async () => {
  const row = (await session()).row;
  const db = fakeDb(conversationRoutes({ gate: { accept_requests: 0, friends: 1 } }));
  const response = await dispatchConversations(
    request("POST", "/api/conversations", { userIds: [TARGET_ID] }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  const channelInsert = callsOf(db).find((call) => call.sql.startsWith("INSERT INTO gc_channels"));
  assert.equal(channelInsert.bound[0], "dm", "the friend pair's DM rides the dm kind");
});

test("group creation is NOT gated by a member's closed requests (GC's everyone-can-DM stands)", async () => {
  const row = (await session()).row;
  const db = fakeDb(conversationRoutes({ gate: { accept_requests: 0, friends: 0 } }));
  const response = await dispatchConversations(
    request("POST", "/api/conversations", { userIds: [TARGET_ID, THIRD_ID] }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  const channelInsert = callsOf(db).find((call) => call.sql.startsWith("INSERT INTO gc_channels"));
  assert.equal(channelInsert.bound[0], "group");
  // The gate never even ran for a group.
  assert.equal(callsOf(db).some((call) => REQUEST_GATE_READ_TEST(call.sql)), false);
});

test("the social block tier refuses thread creation alongside the forum blocks read", async () => {
  const row = (await session()).row;
  const db = fakeDb(conversationRoutes({ gate: { accept_requests: 1, friends: 1 } }));
  // Patch the blocks read to refuse (a gc_blocks pair).
  const refusing = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("FROM users WHERE id IN"),
      all: async (bound) => ({ results: [{ id: TARGET_ID, username: "user" + TARGET_ID }] }),
    },
    {
      test: (sql) => sql.includes("FROM blocks") && sql.includes("UNION ALL") &&
        sql.includes("FROM gc_blocks"),
      first: async () => ({ 1: 1 }),
    },
  ]);
  const response = await dispatchConversations(
    request("POST", "/api/conversations", { userIds: [TARGET_ID] }, (await session()).headers),
    envWithLimiters(refusing),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "You can't start a conversation with that member.");
  void db;
});

// --- the list payload's reaction groups (+ the pure helpers) --------------------------

test("the message list payload pins reactions as grouped per-emoji user lists", async () => {
  const row = (await session()).row;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: null, kind: "dm" }) },
    { test: (sql) => sql.includes("FROM gc_messages m"), all: async () => ({
      results: [{ id: MESSAGE_ID, author_id: TARGET_ID, author_name: "ada", body: "hi",
        client_message_id: null, source: null, created_at: nowSeconds(), edited_at: null,
        author_accent: null }],
    }) },
    { test: (sql) => sql.includes("FROM gc_message_reactions r JOIN users u ON u.id = r.user_id"), all: async () => ({
      results: [
        { message_id: MESSAGE_ID, emoji: "🔥", user_id: USER_ID, username: "wempos" },
        { message_id: MESSAGE_ID, emoji: "🔥", user_id: THIRD_ID, username: "bean" },
      ],
    }) },
    { test: (sql) => sql.includes("FROM gc_attachments"), all: async () => ({ results: [] }) },
  ]);
  const response = await dispatchMessages(
    get("/api/channels/" + CHANNEL_ID + "/messages", (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.messages[0].reactions, [
    { emoji: "🔥", users: [{ id: USER_ID, username: "wempos" }, { id: THIRD_ID, username: "bean" }] },
  ]);
});





// --- the soft tier never gates (the filed ignore contract) -------------------------

test("the friend-request blocks read refuses only the HARD tier (kind = 'blocked' in the SQL)", async () => {
  const row = (await session()).row;
  // The read itself answers null (the pair is unrelated), so the route walks
  // on to its insert; the PIN is the SQL text, not the fake's verdict.
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: USER_ROW_READ_TEST, first: async () => ({ id: TARGET_ID, username: "ada", role: "member" }) },
    { test: FRIENDSHIP_READ_TEST, first: async () => null },
    { test: PENDING_PAIR_READ_TEST, first: async () => null },
    { test: REQUEST_GATE_READ_TEST, first: async () => ({ accept_requests: 1 }) },
    { test: BLOCKED_PAIR_READ_TEST, first: async () => null },
  ]);
  const response = await dispatchSocial(
    request("POST", "/api/friends/requests", { username: "ada" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  const pairRead = callsOf(db).find((call) => BLOCKED_PAIR_READ_TEST(call.sql));
  assert.ok(pairRead, "the blocks read ran");
  assert.match(pairRead.sql, /kind = 'blocked'/,
    "an IGNORE row is cosmetic — it never refuses a friend request either direction");
});

test("the DM send gate carries the hard tier only (an ignored row's DMs stay deliverable)", async () => {
  // The gate read itself models a BLOCKED pair (found), so the send stops at
  // the gate — the refused send leaves no row behind.
  const db = fakeDb([
    { test: WORD_FILTER_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    { test: CHANNEL_SHAPE_TEST, first: async () => ({ kind: "dm", server_id: null }) },
    {
      test: (sql) => sql.includes("gc_conversation_members om JOIN gc_blocks b"),
      first: async () => ({ 1: 1 }),
    },
  ]);
  await assert.rejects(
    () => sendMessageToChannel(
      envWithLimiters(db), { id: USER_ID, username: "wempos", role: "member" }, CHANNEL_ID, "hello", null,
    ),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.message, UNSENDABLE_DM_COPY);
      return true;
    },
  );
  const gateRead = callsOf(db).find(
    (call) => call.sql.includes("gc_conversation_members om JOIN gc_blocks b"),
  );
  assert.ok(gateRead, "the DM gate read ran");
  assert.match(gateRead.sql, /AND b\.kind = 'blocked'/,
    "the filed soft tier keeps their text deliverable (you can still DM them)");
});

// --- the ADD_REACTIONS bit (the reactions feature's own mask vocabulary) -----------

test("a channel deny layer that strips ADD_REACTIONS refuses the toggle-on with 403", async () => {
  const AR_BIT = 1024;
  const headers = (await session()).headers;
  const layerRoutes = (chainRows) => [
    ...reactionRoutes({ kind: "text", serverId: 5 }),
    // readLayerContext's three reads: membership, the held roles, the chain.
    {
      test: (sql) => sql.includes("SELECT role FROM gc_server_members") &&
        !sql.includes("timed_out_until"),
      first: async () => ({ role: "member" }),
    },
    { test: (sql) => sql.includes("FROM gc_member_roles gmr"), all: async () => ({ results: chainRows.roles }) },
    {
      test: (sql) => sql.includes("FROM gc_channel_overwrites"),
      all: async () => ({ results: chainRows.overwrites }),
    },
  ];
  const db = fakeDb(layerRoutes({
    roles: [],
    overwrites: [
      { channel_id: CHANNEL_ID, category_id: null, role_id: null, allow_mask: 0, deny_mask: AR_BIT },
    ],
  }));
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403,
    JSON.stringify(callsOf(db).map((c) => c.call + ":" + c.sql.slice(0, 90))));
  assert.equal((await bodyOf(response)).error, "You do not have permission to do that.");
  assert.equal(callsOf(db).some((call) => REACTION_INSERT_TEST(call.sql)), false);

  // A deny that never names ADD_REACTIONS leaves it standing (the graceful
  // default — an @everyone SEND deny in this channel cannot mute reactions
  // here): the same chain denying only SEND keeps the insert's road open.
  const lenient = envWithLimiters(fakeDb(layerRoutes({
    roles: [],
    overwrites: [
      { channel_id: CHANNEL_ID, category_id: null, role_id: null, allow_mask: 0, deny_mask: 64 },
    ],
  })));
  const allowed = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, headers),
    lenient,
  );
  assert.equal(allowed.status, 201);
});

test("an ADD_REACTIONS allow re-grants the toggle-on after a deny", async () => {
  const headers = (await session()).headers;
  const db = fakeDb([
    ...reactionRoutes({ kind: "text", serverId: 5 }),
    {
      test: (sql) => sql.includes("SELECT role FROM gc_server_members") &&
        !sql.includes("timed_out_until"),
      first: async () => ({ role: "member" }),
    },
    {
      test: (sql) => sql.includes("FROM gc_member_roles gmr"),
      all: async () => ({ results: [{ id: 9, permissions: 1024 }] }),
    },
    {
      test: (sql) => sql.includes("FROM gc_channel_overwrites"),
      all: async () => ({ results: [
        { channel_id: CHANNEL_ID, category_id: null, role_id: null, allow_mask: 0, deny_mask: 1024 },
        { channel_id: CHANNEL_ID, category_id: null, role_id: 9, allow_mask: 1024, deny_mask: 0 },
      ] }),
    },
  ]);
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201, "the holder's role allow re-grants reactions");
});

// --- the clients' pure helpers (the member-list + one-time surfaces) ---------------






// --- super reactions (0020): the plus-gated tier on the reaction stack --------

test("PUT /api/messages/:id/reactions: a super reaction without an active plus term is refused before the insert", async () => {
  const db = fakeDb([
    ...reactionRoutes({ kind: "dm", serverId: null }),
    { test: PLUS_READ_TEST, first: async () => ({ renews_until: 0 }) },
  ]);
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: SUPER_REACTION }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.match((await bodyOf(response)).error, /Super reactions are a Goober\+ perk\./);
  assert.equal(callsOf(db).some((call) => REACTION_INSERT_TEST(call.sql)), false,
    "nothing is stored for a refused super reaction");
});

test("an ACTIVE plus term records the super reaction exactly like a plain one", async () => {
  const db = fakeDb([
    ...reactionRoutes({ kind: "dm", serverId: null }),
    { test: PLUS_READ_TEST, first: async () => ({ renews_until: nowSeconds() + 3600 }) },
  ]);
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: SUPER_REACTION }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).reaction.emoji, SUPER_REACTION);
});

test("the super tier rides the STRICT perk predicate: a grace-window member is refused", async () => {
  const db = fakeDb([
    ...reactionRoutes({ kind: "dm", serverId: null }),
    { test: PLUS_READ_TEST, first: async () => ({ renews_until: nowSeconds() - 1 }) },
  ]);
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: SUPER_REACTION }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.equal(callsOf(db).some((call) => REACTION_INSERT_TEST(call.sql)), false);
});

test("a plain reaction never runs the plus read (the tier is set-membership, not a default gate)", async () => {
  const db = fakeDb(reactionRoutes({ kind: "dm", serverId: null }));
  const response = await dispatchMessages(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, (await session()).headers),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  assert.equal(callsOf(db).some((call) => PLUS_READ_TEST(call.sql)), false);
});

