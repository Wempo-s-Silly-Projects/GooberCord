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

// Conversations routes (Phase 1, Task 7): DMs and group chats as server-less
// gc_channels rows (kind 'dm'/'group') with their membership in
// gc_conversation_members — find-or-create for DMs (the canonical pair read
// from the member intersection), always-create for groups, the blocked-pair
// refusal, the read-time computed names, and the leave route. Same fake
// conventions as the messages test module: fakeDb records every statement's
// bound values, with batch() carrying each statement's SQL so tests can pin
// the guarded-SQL shape itself (the authorization lives in the query text,
// so that is what the tests assert).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { handleConversationRoutes } from "../api/conversations.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const SELF_ID = 7;
const OTHER_ID = 9;
const SECOND_ID = 10;

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function postJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

function jsonRequest(method, path, headers = {}) {
  return new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, ...headers } });
}

// Test dispatcher: mirrors worker.mjs's apiError mapping so HttpErrors surface
// as the same JSON responses the worker would return.
async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleConversationRoutes(
      request,
      env,
      url,
      url.pathname,
      request.method.toUpperCase(),
      undefined,
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

// --- session fixtures -----------------------------------------------------------
// A session row exactly as the vendored readSession SELECT joins it, with a
// real cookie/CSRF token pair for the requireUser-routed requests.

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

async function sessionFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: SELF_ID,
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
  };
  return {
    token,
    row,
    headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

// --- fake-route shapes -----------------------------------------------------------

// Every target member must resolve from the forum users table (read-only).
const USER_LOOKUP_TEST = (sql) =>
  sql.includes("FROM users WHERE id IN") && sql.includes("username");

// The blocked-pair read: either direction of the forum blocks pair refuses.
const BLOCKS_TEST = (sql) =>
  sql.includes("FROM blocks") &&
  sql.includes("blocker_id = ? AND blocked_id IN") &&
  sql.includes("blocked_id = ? AND blocker_id IN");

// The DM find-or-create read: kind = 'dm' channels whose member pairs
// intersect the requested two exactly (the member count of the pair channel
// is 2), read before any insert.
const DM_FIND_TEST = (sql) =>
  sql.includes("FROM gc_channels c") &&
  sql.includes("kind = 'dm'") &&
  sql.includes("= 2") &&
  sql.includes("LIMIT 1");

const CHANNEL_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_channels");

// The member rows bind the LITERAL created channel id — last_insert_rowid()
// inside a member batch evaluates AFTER each member insert completes, so any
// member past the first would bind the previous member row's rowid.
const MEMBER_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_conversation_members") && sql.includes("VALUES (?, ?, 0)");

// GET /api/conversations reads: the caller's dm/group channels with the
// unread count derived from their last_read_message_id, the member roster,
// and the last-message preview — each bound to the session user / channel set.
const CONVERSATIONS_LIST_SQL_TEST = (sql) =>
  sql.includes("FROM gc_channels c JOIN gc_conversation_members m") &&
  sql.includes("c.kind IN ('dm','group')") &&
  sql.includes("gm.id > m.last_read_message_id");

const CONVERSATION_MEMBERS_TEST = (sql) =>
  sql.includes("FROM gc_conversation_members m JOIN users u");

const LAST_MESSAGE_TEST = (sql) => sql.includes("c.last_message_id = m.id");

const LEAVE_MEMBERS_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_conversation_members");
const LEAVE_CHANNEL_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_channels");

// --- fake DB ---------------------------------------------------------------------

// Ordered fake DB: the first matching route answers each statement shape.
// Top-level run() calls are recorded individually; batch() is recorded as ONE
// call carrying every statement's SQL + bound values (a real D1 batch executes
// its statements under a single transaction). Unrouted runs default to a
// single-row insert with an incrementing last_row_id, like a real write.
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
      // Batch statements execute without their own call entries: the batch
      // entry alone carries each statement's SQL + bound values.
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

// Overrides come FIRST: fakeDb's find takes the first route whose test matches,
// so a test's specific routes shadow the base fixtures by being prepended.
const USERS = new Map([
  [9, "wempos"],
  [10, "ada"],
  [11, "bean"],
  [12, "dot"],
]);

const userLookupRoute = () => ({
  test: USER_LOOKUP_TEST,
  all: async (bound) => ({
    results: bound
      .filter((id) => USERS.has(Number(id)))
      .map((id) => ({ id: Number(id), username: USERS.get(Number(id)) })),
  }),
});

// Either block direction with any requested member refuses (the fake models
// the pair's presence, whichever arm the SQL matched).
function baseRoutes({ session, blockedIds = [] } = {}) {
  return [
    sessionRoute(session.row),
    userLookupRoute(),
    {
      test: BLOCKS_TEST,
      first: async (bound) => {
        const half = Math.floor((bound.length - 1) / 2);
        const targets = bound.slice(1, 1 + half).map(Number);
        return targets.some((id) => blockedIds.includes(id)) ? { 1: 1 } : null;
      },
    },
  ];
}

// --- tests -----------------------------------------------------------------------

test("POST creates a DM then re-POSTing the same pair returns the SAME channel id without inserting again", async () => {
  const session = await sessionFixtures();
  // The first POST finds nothing and inserts channel id 1; the fake records
  // it so the pair read can return it on the follow-up POST (find-or-create).
  const state = { channelId: null };

  const db = fakeDb([
    {
      test: DM_FIND_TEST,
      first: async () => (state.channelId !== null ? { id: state.channelId } : null),
    },
    {
      test: CHANNEL_INSERT_TEST,
      run: async () => {
        state.channelId = 1;
        return { meta: { changes: 1, last_row_id: 1 } };
      },
    },
    ...baseRoutes({ session }),
  ]);
  const env = { GOOBER_DB: db };

  const first = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID] }, session.headers),
    env,
  );
  assert.equal(first.status, 201);
  const created = await bodyOf(first);
  assert.equal(created.conversation.id, 1);
  assert.equal(created.conversation.kind, "dm");
  assert.equal(created.conversation.name, "wempos"); // the OTHER member's username
  assert.deepEqual(
    created.conversation.members.map((m) => [m.userId, m.username]),
    [[7, "wempos"], [9, "wempos"]],
  );

  // The channel INSERT runs FIRST as its own statement, so the member batch
  // can bind its LITERAL id — the member rows are keyed to the channel by the
  // bound value, never last_insert_rowid() (which each member insert would
  // overwrite for the next one).
  const insertBatch = callsOf(db).find((call) => call.call === "batch");
  const channelInsert = callsOf(db).find((call) => CHANNEL_INSERT_TEST(call.sql));
  assert.ok(channelInsert, "the channel insert ran as its own statement");
  assert.equal(channelInsert.call, "run");
  assert.deepEqual(channelInsert.bound.slice(0, 2), ["dm", "dm"]);
  const memberInserts = insertBatch.statements.filter((s) => MEMBER_INSERT_TEST(s.sql));
  assert.equal(memberInserts.length, 2);
  assert.deepEqual(
    memberInserts.map((s) => [s.bound[0], s.bound[1]]),
    [[1, SELF_ID], [1, OTHER_ID]],
  );
  // The channel insert ran BEFORE the member batch, and the DM pair read ran
  // before both (find-or-create order).
  assert.ok(callsOf(db).indexOf(channelInsert) < callsOf(db).indexOf(insertBatch));
  const findRead = callsOf(db).find((call) => call.call === "first" && DM_FIND_TEST(call.sql));
  assert.ok(findRead, "the DM pair read ran");
  assert.deepEqual(findRead.bound, [SELF_ID, OTHER_ID]);
  assert.ok(callsOf(db).indexOf(findRead) < callsOf(db).indexOf(channelInsert));

  // A second POST against a pair channel the pair read now RESOLVES: it
  // returns that channel id without any insert.
  const secondRoutes = baseRoutes({ session });
  secondRoutes.splice(1, 0, { test: DM_FIND_TEST, first: async () => ({ id: 1 }) });
  const secondDb = fakeDb(secondRoutes);
  const second = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID] }, session.headers),
    { GOOBER_DB: secondDb },
  );
  assert.equal(second.status, 200);
  const found = await bodyOf(second);
  assert.equal(found.conversation.id, 1);
  assert.deepEqual(
    found.conversation.members.map((m) => [m.userId, m.username]),
    [[7, "wempos"], [9, "wempos"]],
  );
  // No channel was inserted on the found path: no batch ran at all.
  assert.equal(callsOf(secondDb).some((call) => call.call === "batch"), false);
});

function callsOf(db) {
  return db.calls;
}

test("the gc_blocks arm of the creation blocks read refuses only the HARD tier", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session }));
  const response = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID] }, session.headers),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 201);
  const arm = callsOf(db).find((call) => call.sql.includes("gc_blocks"));
  assert.ok(arm, "the social blocks read ran");
  assert.match(arm.sql, /AND kind = 'blocked'/,
    "an IGNORE row is the viewer's own cosmetic pref — it never refuses a conversation");
});

test("POST with 2–8 ids always creates a NEW group channel, even when the group already exists", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session }));
  const env = { GOOBER_DB: db };

  const first = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID] }, session.headers),
    env,
  );
  assert.equal(first.status, 201);
  const created = await bodyOf(first);
  assert.equal(created.conversation.kind, "group");

  // Groups always create: there is no pair read at all for them (the DM
  // find-or-create SQL never runs).
  assert.equal(
    callsOf(db).some((call) => call.call === "first" && DM_FIND_TEST(call.sql)),
    false,
  );
  // The channel insert runs alone; the member batch carries ONLY member rows,
  // every one bound to the channel id the create just answered with.
  const firstChannelInsert = callsOf(db).find((call) => CHANNEL_INSERT_TEST(call.sql));
  assert.ok(firstChannelInsert && firstChannelInsert.call === "run");
  const firstBatch = callsOf(db).find((call) => call.call === "batch");
  assert.equal(firstBatch.statements.filter((s) => MEMBER_INSERT_TEST(s.sql)).length, 3);
  for (const statement of firstBatch.statements.filter((s) => MEMBER_INSERT_TEST(s.sql))) {
    assert.equal(statement.bound[0], created.conversation.id);
    assert.ok(Number.isInteger(statement.bound[1]));
  }

  const second = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID] }, session.headers),
    env,
  );
  assert.equal(second.status, 201);
  const again = await bodyOf(second);
  assert.notEqual(again.conversation.id, created.conversation.id);
  // Groups always create: a second standalone channel insert, at a NEW id.
  assert.equal(callsOf(db).filter((call) => CHANNEL_INSERT_TEST(call.sql)).length, 2);
});

// Member-batch failure shapes: the fake's batch() runs every member insert,
// so a route here decides per-bound-value (the doomed member aborts, the
// others succeed) — the same either-shape a real D1 failure lands as.
const failingMemberRoute = ({ failUserId, throw: shouldThrow }) => ({
  test: MEMBER_INSERT_TEST,
  run: async (bound) => {
    if (Number(bound[1]) === failUserId) {
      if (shouldThrow) throw new Error("simulated D1 batch failure");
      return { meta: { changes: 0, last_row_id: 0 } };
    }
    return { meta: { changes: 1, last_row_id: 0 } };
  },
});

// The memberless-window guard: the channel row commits BEFORE the member
// batch, so a member-batch failure must delete the stranded channel row —
// otherwise a memberless gc_channels row survives the failure (invisible to
// every member-join read, but an orphan on the shared DB).
const strandedChannelDelete = (db) =>
  callsOf(db).find((call) => call.call === "run" && LEAVE_CHANNEL_DELETE_TEST(call.sql));

test("a failed member batch deletes the stranded channel row and answers the 500 copy", async () => {
  const session = await sessionFixtures();
  const db = fakeDb([failingMemberRoute({ failUserId: SECOND_ID }), ...baseRoutes({ session })]);
  const env = { GOOBER_DB: db };

  const response = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID] }, session.headers),
    env,
  );
  assert.equal(response.status, 500);
  assert.equal((await bodyOf(response)).error, "The conversation could not be created. Please try again.");

  // The channel insert committed (id 1, the fake's first row); the guard
  // deletes EXACTLY that row bound by its id — and nothing else.
  const deleteCall = strandedChannelDelete(db);
  assert.ok(deleteCall, "the stranded channel row was deleted");
  assert.ok(LEAVE_CHANNEL_DELETE_TEST(deleteCall.sql));
  assert.deepEqual(deleteCall.bound, [1]);
  // The compensating delete, not a member-batch rerun: exactly one batch.
  assert.equal(callsOf(db).filter((call) => call.call === "batch").length, 1);
});

test("a thrown member batch (D1 abort/crash shape) also deletes the stranded channel row", async () => {
  const session = await sessionFixtures();
  const db = fakeDb([
    failingMemberRoute({ failUserId: OTHER_ID, throw: true }),
    ...baseRoutes({ session }),
  ]);
  const env = { GOOBER_DB: db };

  await assert.rejects(
    () => dispatch(
      postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID] }, session.headers),
      env,
    ),
    /simulated D1 batch failure/,
  );

  const deleteCall = strandedChannelDelete(db);
  assert.ok(deleteCall, "the stranded channel row was deleted");
  assert.deepEqual(deleteCall.bound, [1]);
});

test("POST for a blocked pair refuses with the 403 copy and creates nothing", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session, blockedIds: [OTHER_ID] }));

  const response = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID] }, session.headers),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "You can't start a conversation with that member.");
  assert.equal(callsOf(db).some((call) => call.call === "batch"), false);

  // The SQL itself checks both arms: the caller as blocker and the caller as
  // the blocked one, over the same requested member set.
  const blocksRead = callsOf(db).find((call) => BLOCKS_TEST(call.sql));
  assert.ok(blocksRead, "the blocks read ran");
  assert.ok(blocksRead.sql.includes("OR"));

  // A group whose invite carries a block refusal is refused the same way.
  const groupDb = fakeDb(baseRoutes({ session, blockedIds: [SECOND_ID] }));
  const groupResponse = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID] }, session.headers),
    { GOOBER_DB: groupDb },
  );
  assert.equal(groupResponse.status, 403);
  assert.equal((await bodyOf(groupResponse)).error, "You can't start a conversation with that member.");
});

test("POST with a non-existent userId refuses with 400 before any blocks read", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session }));
  const response = await dispatch(
    postJson("/api/conversations", { userIds: [999] }, session.headers),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "One of those members does not exist.");
  // Existence is validated BEFORE the blocks read: no blocks query ran.
  assert.equal(callsOf(db).some((call) => BLOCKS_TEST(call.sql)), false);
  assert.equal(callsOf(db).some((call) => call.call === "batch"), false);
  // The lookup's IN-list bound exactly the requested ids — preceded in
  // textual order by nowSeconds() (the plusActiveExpr badge's bind) and the
  // caller's id (the read carries the caller too, for the member shapes).
  const lookup = callsOf(db).find((call) => USER_LOOKUP_TEST(call.sql));
  assert.equal(typeof lookup.bound[0], "number");
  assert.deepEqual(lookup.bound.slice(1), [SELF_ID, 999]);
});

test("POST rejects a malformed, empty, oversized, or self-referencing member list with 400", async () => {
  const session = await sessionFixtures();
  for (const body of [
    {}, // not an array
    { userIds: "9" }, // not an array
    { userIds: [] }, // nothing to open
    { userIds: [0] }, // not a plausible id
    { userIds: [SELF_ID] }, // you are already a member
    { userIds: Array.from({ length: 10 }, (_, index) => 20 + index) }, // over the group cap
  ]) {
    const db = fakeDb(baseRoutes({ session }));
    const response = await dispatch(postJson("/api/conversations", body, session.headers), {
      GOOBER_DB: db,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    // Refused before any member lookup, blocks read, or write ran.
    assert.equal(callsOf(db).some((call) => USER_LOOKUP_TEST(call.sql) || call.call === "batch"), false);
  }
});

test("GET lists only the caller's dm/group channels with read-time names, lastMessage, and unread", async () => {
  const session = await sessionFixtures();
  const db = fakeDb([
    {
      test: CONVERSATIONS_LIST_SQL_TEST,
      all: async () => ({
        results: [
          {
            id: 40,
            kind: "dm",
            last_message_id: 12,
            last_message_at: 300,
            last_read_message_id: 9,
            unread: 3,
          },
          {
            id: 41,
            kind: "group",
            last_message_id: null,
            last_message_at: null,
            last_read_message_id: 0,
            unread: 0,
          },
        ],
      }),
    },
    {
      test: CONVERSATION_MEMBERS_TEST,
      all: async () => ({
        results: [
          { channel_id: 40, member_id: 7, username: "wempos" },
          { channel_id: 40, member_id: 9, username: "wempos" },
          { channel_id: 41, member_id: 7, username: "wempos" },
          { channel_id: 41, member_id: 10, username: "ada" },
          { channel_id: 41, member_id: 11, username: "bean" },
        ],
      }),
    },
    {
      test: LAST_MESSAGE_TEST,
      all: async () => ({
        results: [{ channel_id: 40, body: "hi there", created_at: 300, author_name: "wempos" }],
      }),
    },
    ...baseRoutes({ session }),
  ]);

  const response = await dispatch(get("/api/conversations", session.headers), { GOOBER_DB: db });
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.deepEqual(payload.conversations, [
    {
      id: 40,
      name: "wempos", // a dm's name is the OTHER member's username, computed at read
      kind: "dm",
      members: [
        { userId: 7, username: "wempos", isPlus: false },
        { userId: 9, username: "wempos", isPlus: false },
      ],
      lastMessage: { body: "hi there", createdAt: "1970-01-01T00:05:00.000Z", authorName: "wempos" },
      unread: 3,
    },
    {
      id: 41,
      name: "ada, bean", // a group's name is the other members, joined
      kind: "group",
      members: [
        { userId: 7, username: "wempos", isPlus: false },
        { userId: 10, username: "ada", isPlus: false },
        { userId: 11, username: "bean", isPlus: false },
      ],
      lastMessage: null,
      unread: 0,
    },
  ]);

  // The member and last-message reads scoped themselves to the LISTED
  // channels only (an IN list over the caller's channels, never the table).
  const rosterRead = callsOf(db).find((call) => CONVERSATION_MEMBERS_TEST(call.sql));
  assert.ok(rosterRead.sql.includes("IN ("));
  // The roster's first bind is the plusActiveExpr badge's `now`.
  assert.equal(typeof rosterRead.bound[0], "number");
  assert.deepEqual(rosterRead.bound.slice(1), [40, 41]);
  const lastRead = callsOf(db).find((call) => LAST_MESSAGE_TEST(call.sql));
  assert.deepEqual(lastRead.bound, [40, 41]);
});

test("GET unread rides the SQL off last_read_message_id; an outsider's list binds the session user", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session }));
  const response = await dispatch(get("/api/conversations", session.headers), { GOOBER_DB: db });
  assert.equal(response.status, 200);
  assert.deepEqual((await bodyOf(response)).conversations, []);

  const listRead = callsOf(db).find((call) => CONVERSATIONS_LIST_SQL_TEST(call.sql));
  assert.ok(listRead, "the conversation list query ran");
  // Outsider safety: the WHERE binds the SESSION user, never request data.
  assert.deepEqual(listRead.bound, [SELF_ID]);
  // The unread count is a parameterless subselect over the member row's cursor.
  assert.ok(listRead.sql.includes("(SELECT COUNT(*) FROM gc_messages gm"));
  assert.ok(listRead.sql.includes("gm.id > m.last_read_message_id"));
  void response;
});

test("DELETE leaves a group channel and deletes it when the caller is the LAST member", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session }));

  const response = await dispatch(jsonRequest("DELETE", "/api/conversations/40", session.headers), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 200);
  assert.equal((await bodyOf(response)).ok, true);

  // Two sequential statements: the member delete runs FIRST, and the channel
  // delete only ever runs after its changes came back 1 (the gate lives in
  // the handler's control flow, not in an unconditional batch).
  const memberDelete = callsOf(db).find((call) => LEAVE_MEMBERS_DELETE_TEST(call.sql));
  const channelDelete = callsOf(db).find((call) => LEAVE_CHANNEL_DELETE_TEST(call.sql));
  assert.ok(memberDelete, "the member delete ran");
  assert.ok(memberDelete.sql.includes("kind = 'group'"));
  assert.deepEqual(memberDelete.bound, [40, SELF_ID, 40]);
  assert.ok(channelDelete, "the channel delete ran after the member delete");
  assert.equal(channelDelete.call, "run");
  assert.ok(channelDelete.sql.includes("kind = 'group'"));
  assert.ok(channelDelete.sql.includes("NOT EXISTS"));
  assert.deepEqual(channelDelete.bound, [40, 40]);
  assert.ok(callsOf(db).indexOf(memberDelete) < callsOf(db).indexOf(channelDelete));
});

test("DELETE when the caller is NOT in the group (or the channel is not a group) answers 404, never 403", async () => {
  const session = await sessionFixtures();
  const db = fakeDb([
    { test: LEAVE_MEMBERS_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
    ...baseRoutes({ session }),
  ]);
  const response = await dispatch(jsonRequest("DELETE", "/api/conversations/40", session.headers), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 404);
  // The member delete's 0-changes result GATES the channel delete: on this
  // 404 path NO channel delete was even prepared or run.
  assert.equal(callsOf(db).some((call) => LEAVE_CHANNEL_DELETE_TEST(call.sql)), false);
});

test("an OUTSIDER targeting a memberless group channel gets only 404 and zero deletions", async () => {
  const session = await sessionFixtures();
  // Real shape of the harm: the channel exists, is a group, and holds no
  // members — the old unconditional batch-delete skipped past its NOT-EXISTS
  // arm and destroyed the channel while the caller was answered 404. The
  // member delete's changes=0 must therefore stop everything.
  const db = fakeDb([
    // A caller who is not a member: their guarded DELETE matches 0 rows.
    { test: LEAVE_MEMBERS_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
    ...baseRoutes({ session }),
  ]);
  const response = await dispatch(jsonRequest("DELETE", "/api/conversations/40", session.headers), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 404);
  assert.equal((await bodyOf(response)).error, "This conversation does not exist or you cannot view it.");
  // Zero deletions: no channel delete statement ran at all.
  assert.equal(callsOf(db).some((call) => LEAVE_CHANNEL_DELETE_TEST(call.sql)), false);
});

test("unknown conversation routes fall through to the dispatcher's 404", async () => {
  const session = await sessionFixtures();
  const db = fakeDb(baseRoutes({ session }));
  const response = await dispatch(jsonRequest("DELETE", "/api/conversations/", session.headers), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 404);
});

// --- real-SQLite create/leave regression (fix round) --------------------------------

// The create batch's channel-id derivation is an SQL/sequencing property the
// fake DB cannot execute: deriving members' channel_id from
// last_insert_rowid() inside the batch is poisoned by the member inserts
// themselves, which became the connection's last insert one by one (real
// SQLite repro: channel id 6 produced member rows (6,7),(3,9),(4,10)). This
// mini-harness runs the route's ACTUAL statements in real SQLite (same
// D1-shaped adapter conventions as messages-module.test.mjs), FKs on.
function sqliteEnv(db) {
  return {
    GOOBER_DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...values) {
            bound = values;
            return this;
          },
          async first() {
            const row = db.prepare(sql).get(...bound);
            return row === undefined || row === null ? null : row;
          },
          async all() {
            return { results: db.prepare(sql).all(...bound) };
          },
          async run() {
            const result = db.prepare(sql).run(...bound);
            return {
              meta: {
                changes: Number(result.changes),
                last_row_id: Number(result.lastInsertRowid ?? 0),
              },
              results: [],
            };
          },
        };
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    },
  };
}

const CONVERSATION_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL,
    bio TEXT NULL, avatar_status TEXT NULL, avatar_mime TEXT NULL,
    avatar_updated_at INTEGER NULL, avatar_version INTEGER NULL,
    totp_enabled INTEGER NULL);
  CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER NOT NULL);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL);
  CREATE TABLE blocks (
    blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id));
  -- The 0009 social objects the route's gates read (the DM request gate +
  -- either-direction blocks union). Minimal shapes, same contracts.
  CREATE TABLE gc_blocks (
    blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL,
    kind TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id));
  CREATE TABLE gc_social_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    accept_requests INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
  CREATE TABLE gc_friends (
    user_a_id INTEGER NOT NULL REFERENCES users(id),
    user_b_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    CHECK (user_a_id < user_b_id),
    PRIMARY KEY (user_a_id, user_b_id));
  CREATE TABLE gc_channels (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100) DEFAULT 'dm',
    kind TEXT NOT NULL CHECK(kind IN ('text','voice','dm','group')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_message_id INTEGER NULL,
    last_message_at INTEGER NULL,
    CHECK((kind IN ('dm','group') AND server_id IS NULL)
          OR (kind IN ('text','voice') AND server_id IS NOT NULL)));
  CREATE TABLE gc_conversation_members (
    channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(channel_id, user_id));
`;

// A live session row per signed-in caller; returns the request headers.
async function signIn(db, userId, username) {
  const token = randomToken();
  const csrf = randomToken(24);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(await sha256Hex(token), userId, csrf, nowSeconds(), nowSeconds() + 3600);
  return { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf, Origin: ORIGIN };
}

function seedUsers(db) {
  db.exec(
    `INSERT INTO users (id, username, role) VALUES` +
      ` (${SELF_ID}, 'wempos', 'member')` +
      `, (${OTHER_ID}, 'ada', 'member')` +
      `, (${SECOND_ID}, 'bean', 'member')` +
      `, (12, 'dot', 'member')`,
  );
}

function memberRows(db) {
  return db
    .prepare("SELECT channel_id, user_id FROM gc_conversation_members ORDER BY user_id")
    .all()
    .map((row) => [Number(row.channel_id), Number(row.user_id)]);
}

test("real-SQLite: a 3-member group create binds EVERY member row to the created channel id", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(CONVERSATION_SCHEMA);
  seedUsers(db);
  const headers = await signIn(db, SELF_ID, "wempos");

  const response = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID, 12] }, headers),
    sqliteEnv(db),
  );
  assert.equal(response.status, 201);
  const created = await bodyOf(response);
  const channelRows = db.prepare("SELECT id, kind FROM gc_channels").all().map((row) => ({ ...row }));
  // Exactly ONE channel row, kind group.
  assert.deepEqual(channelRows.map((row) => row.kind), ["group"]);
  const channelId = Number(channelRows[0].id);
  assert.equal(created.conversation.id, channelId);
  // All FOUR member rows (self + the three invites) carry that channel id.
  assert.deepEqual(memberRows(db), [[channelId, SELF_ID], [channelId, OTHER_ID], [channelId, SECOND_ID], [channelId, 12]]);
});

test("real-SQLite: leave deletes only the caller's row; an outsider deletes NOTHING; the last depart removes the channel", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(CONVERSATION_SCHEMA);
  seedUsers(db);
  const selfHeaders = await signIn(db, SELF_ID, "wempos");
  const otherHeaders = await signIn(db, OTHER_ID, "ada");
  const outsiderHeaders = await signIn(db, 12, "dot");

  // SELF + OTHER open a group; LAST_MESSAGE/unread columns stay untouched.
  const create = await dispatch(
    postJson("/api/conversations", { userIds: [OTHER_ID, SECOND_ID] }, selfHeaders),
    sqliteEnv(db),
  );
  assert.equal(create.status, 201);
  const channel = db.prepare("SELECT id FROM gc_channels WHERE kind = 'group'").get();
  const channelId = Number(channel.id);

  // The OUTSIDER's delete matches zero member rows — and deletes NOTHING.
  const outsider = await dispatch(
    jsonRequest("DELETE", "/api/conversations/" + channelId, outsiderHeaders),
    sqliteEnv(db),
  );
  assert.equal(outsider.status, 404);
  assert.deepEqual(memberRows(db), [
    [channelId, SELF_ID],
    [channelId, OTHER_ID],
    [channelId, SECOND_ID],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_channels WHERE id = ?").get(channelId).n, 1);

  // A real member's leave removes only their own row; the channel survives.
  const leave = await dispatch(
    jsonRequest("DELETE", "/api/conversations/" + channelId, otherHeaders),
    sqliteEnv(db),
  );
  assert.equal(leave.status, 200);
  assert.deepEqual(memberRows(db), [[channelId, SELF_ID], [channelId, SECOND_ID]]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_channels WHERE id = ?").get(channelId).n, 1);

  // The LAST departing member takes the channel with them.
  const last = await dispatch(
    jsonRequest("DELETE", "/api/conversations/" + channelId, selfHeaders),
    sqliteEnv(db),
  );
  assert.equal(last.status, 200);
  assert.deepEqual(memberRows(db), [[channelId, SECOND_ID]]);
  const finalLeave = await dispatch(
    jsonRequest("DELETE", "/api/conversations/" + channelId, await signIn(db, SECOND_ID, "bean")),
    sqliteEnv(db),
  );
  assert.equal(finalLeave.status, 200);
  assert.deepEqual(memberRows(db), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_channels").get().n, 0);
});
