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

// The mentions wave (owner direct ask): plain-text @everyone / @here /
// @username in message bodies. Pins: the pure parse (flag tokens
// case-insensitive and word-bounded; the roster matcher's longest-first,
// nickname-before-username, ambiguous = nobody), the send/edit gate
// (memberships read ONLY when the flag is present; the MENTION_EVERYONE bit
// or the owner/moderator tier admits, everyone else gets the 403, DM/group
// and @user never gate), and the bit's place in permissions.mjs (next free
// position, server-wide only, out of the overwrite vocabulary). NO storage
// change, no payload key, no bell table — the contract is additive-free.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { handleMessageRoutes } from "../api/messages.mjs";
import { handleMentionRoutes, matchRosterMentions, mentionsEveryoneFlag } from "../api/mentions.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { MENTION_EVERYONE } from "../api/permissions.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const CHANNEL_ID = 3;

// --- the pure parse -------------------------------------------------------------

test("the flag parse: exact and case forms hit, word-bounded look-alikes are plain text", () => {
  for (const hit of [
    "@everyone",
    "@Everyone is welcome",
    "hi @EVERYONE",
    "@here",
    "check @HERE now",
    "(@here)",
    "ping @everyone",
  ]) {
    assert.equal(mentionsEveryoneFlag(hit), true, hit);
  }
  for (const miss of [
    "hello to everyone",
    "@everyonehere",
    "mail@everyone.com",
    "not@heretoday",
    "here@there",
    "at@x",
    "no flag at all",
  ]) {
    assert.equal(mentionsEveryoneFlag(miss), false, miss);
  }
});

test("the roster matcher: nickname before username, case-insensitive, ambiguous = nobody", () => {
  const roster = [
    { id: 1, username: "wempo", nickname: "the boss" },
    { id: 2, username: "wem", nickname: null },
    { id: 3, username: "other", nickname: "wempo two" },
  ];

  // Nickname hit, with trailing words collected and walked down.
  assert.deepEqual(matchRosterMentions("the @wempo two rode again", roster), [3],
    "the display's full seam wins over the shorter username a prefix could have caught");
  assert.deepEqual(matchRosterMentions("@the boss hi", roster), [1]);
  // Username hit, case-insensitive.
  assert.deepEqual(matchRosterMentions("hey @WEM!", roster), [2]);
  // Ambiguity: a nickname on one member colliding with another's username —
  // both widths resolve to nobody (no shortening rescue).
  const tangled = [
    { id: 4, username: "a", nickname: "same" },
    { id: 5, username: "same", nickname: null },
  ];
  assert.deepEqual(matchRosterMentions("@same @a", tangled), [],
    "@same is ambiguous at its full width and never rescued by shortening (the greedy collection "
      + "runs 'same @a' through the seams, and the one-char @a never collects a candidate of its own)");
  const split = [
    { id: 6, username: "sam", nickname: null },
    { id: 7, username: "b", nickname: "sam" },
  ];
  assert.deepEqual(matchRosterMentions("hi @sam!", split), [],
    "the token-bounded twin: one width, two owners, nobody");
  // No hit anywhere; the gate never learns a name.
  assert.deepEqual(matchRosterMentions("@nobody here", roster), []);
  assert.deepEqual(matchRosterMentions("plain text", roster), []);
  assert.deepEqual(matchRosterMentions("@wempo two", null), [],
    "a rosterless caller (a DM's payload) resolves nothing");
  // Repeated tokens stay repeated (the count is the sender's punctuation).
  assert.deepEqual(matchRosterMentions("@wem and @WEM again", roster), [2, 2]);
});

// --- the gate's bit pin ----------------------------------------------------------

test("MENTION_EVERYONE takes the next free bit position and stays out of the overwrite vocabulary", async () => {
  const constants = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "api", "permissions.mjs"),
    "utf8",
  );
  assert.equal(MENTION_EVERYONE, 1 << 12, "the next free position after MANAGE_EMOJI (1<<11)");
  assert.match(constants, /MENTION_EVERYONE: 1 << 12/);
  // Like MANAGE_EMOJI: a server-wide role bit, never a channel overwrite.
  const overwriteLine = constants.match(/OVERWRITE_BITS = Object\.freeze\(\[([^]*?)\]\)/);
  assert.ok(overwriteLine);
  assert.doesNotMatch(overwriteLine[1], /MENTION_EVERYONE/);
  // The implicit base (VIEW/SEND/ADD_REACTIONS) never carried it — mentioning
  // everyone is a granted power, not a starting one.
  const implicitLine = constants.match(/IMPLICIT_BASE_PERMISSIONS =[^;]*;/);
  assert.ok(implicitLine);
  assert.doesNotMatch(implicitLine[0], /MENTION_EVERYONE/);
});

// --- the route gate ---------------------------------------------------------------

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

function jsonRequest(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMessageRoutes(
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
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
    headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const sessionRoute = (row) => ({
  test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
  first: async () => row,
});

const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c WHERE c.id = ?") &&
  sql.includes("gc_server_members m") &&
  sql.includes("gc_conversation_members cm");

const CHANNEL_SERVER_TEST = (sql) =>
  sql.includes("SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1");

const EDITED_CHANNEL_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id");

// The M2 (RBAC audit) edit-lane gates' standing reads: the door's membership
// EXISTS, the layer gate's own membership read, the member-state trio read,
// and the AutoMod server resolution.
const EDIT_DOOR_MEMBER_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const EDIT_GATE_MEMBER_TEST = (sql) =>
  sql.includes("FROM gc_server_members m JOIN users u") && sql.includes("timed_out_until");
const EDIT_RULES_SERVER_TEST = (sql) =>
  sql.includes("SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1");
const editLaneRoutes = (tiers = {}) => [
  ...(tiers.member !== null ? [{ test: EDIT_DOOR_MEMBER_TEST, first: async () => ({ 1: 1 }) }] : []),
  {
    test: EDIT_GATE_MEMBER_TEST,
    first: async () => ({ timed_out_until: null, role: "member",
      joined_at: 1, account_created_at: 1, permissions: 0 }),
  },
  { test: EDIT_RULES_SERVER_TEST, first: async () => ({ server_id: 1 }) },
];

const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");

const MESSAGE_RESELECT_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("client_message_id") &&
  sql.includes("ORDER BY m.id DESC LIMIT 1");

const MESSAGE_BY_ID_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("WHERE m.id = ? LIMIT 1");

const EDIT_UPDATE_TEST = (sql) =>
  sql.includes("UPDATE gc_messages SET body = ?, edited_at = ? WHERE id = ? AND author_id = ?");

const MENTION_TIER_TEST = (sql) =>
  sql.includes("SELECT role AS role") &&
  sql.includes("GROUP_CONCAT(ar.permissions)") &&
  sql.includes("FROM gc_server_members WHERE server_id = ? AND user_id = ?");

// The membership tier row the mention gate (and the filter gate) read.
const mentionTierRoute = (row) => ({ test: MENTION_TIER_TEST, first: async () => row });
const PLAIN_MEMBER = () => ({ role: "member", permissions: 0 });
const BIT_HOLDER = () => ({ role: "member", permissions: MENTION_EVERYONE });

function messageRow(overrides = {}) {
  return {
    id: 5,
    author_id: USER_ID,
    author_name: "wempos",
    body: "hello",
    client_message_id: null,
    source: null,
    created_at: 100,
    edited_at: null,
    ...overrides,
  };
}

// The send lanes' standing routes: the channel exists (a SERVER channel), the
// plus term reads null (free), the filter list is empty.
const SEND_BASE = (serverId) => [
  { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: serverId, kind: "text" }) },
  { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: serverId }) },
];

async function sendBody(routes, body) {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  return dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body }, headers),
    envWithLimiters({
      GOOBER_DB: fakeDb([sessionRoute(row), { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) }, ...routes]),
    }),
  );
}

test("a plain member's @everyone send is refused with the 403 and no write", async () => {
  const routes = [
    ...SEND_BASE(1),
    mentionTierRoute(PLAIN_MEMBER()),
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1 }, results: [messageRow()] }) },
  ];
  const response = await sendBody(routes, "hi @everyone");
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You can't mention everyone here." });
});

// The refusal's cost probe: the gate reads the tier row and writes NOTHING.
test("the refusal costs one tier read and never reaches the insert batch", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), ...SEND_BASE(1), mentionTierRoute(PLAIN_MEMBER())]);
  const response = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "hi @here" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "You can't mention everyone here.");
  assert.equal(db.calls.filter((call) => MENTION_TIER_TEST(call.sql)).length, 1,
    "the flag answered first; the tier read is the gate's one cost");
  assert.deepEqual(db.calls.filter((call) => call.call === "batch" || call.call === "run"), [],
    "a refused mention send stores nothing");
});

test("a send WITHOUT the flag never reads a membership tier (the parse answers first)", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), ...SEND_BASE(1), { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1, last_row_id: 6 }, results: [messageRow({ body: "hi everyone" })] }) }]);
  const response = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "hi everyone" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 201);
  assert.equal(db.calls.filter((call) => MENTION_TIER_TEST(call.sql)).length, 0);
});

test("the mention tiers: the bit admits the plain member, owner and moderator bypass, DM gates not", async () => {
  // The bit holder's send stores.
  const bitStored = await sendBody(
    [...SEND_BASE(1), mentionTierRoute(BIT_HOLDER()), { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1, last_row_id: 7 }, results: [messageRow({ id: 7, body: "hi @everyone" })] }) }],
    "hi @everyone",
  );
  assert.equal(bitStored.status, 201);

  // The owner tier bypasses structurally.
  const ownerStored = await sendBody(
    [...SEND_BASE(1), mentionTierRoute({ role: "owner", permissions: 0 }), { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1, last_row_id: 8 }, results: [messageRow({ id: 8, body: "hi @everyone" })] }) }],
    "hi @everyone",
  );
  assert.equal(ownerStored.status, 201);

  // The moderator tier bypasses structurally.
  const modStored = await sendBody(
    [...SEND_BASE(1), mentionTierRoute({ role: "moderator", permissions: 0 }), { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1, last_row_id: 9 }, results: [messageRow({ id: 9, body: "hi @here" })] }) }],
    "hi @here",
  );
  assert.equal(modStored.status, 201);

  // A DM channel (server_id NULL) reads no tier row at all.
  const { row, headers } = await sessionFixtures();
  const dmDb = fakeDb([
    sessionRoute(row),
    ...SEND_BASE(null),
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1, last_row_id: 10 }, results: [messageRow({ id: 10, body: "hi @everyone" })] }) },
  ]);
  _resetFilterWordsCacheForTests();
  const dmStored = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "hi @everyone" }, headers),
    envWithLimiters({ GOOBER_DB: dmDb }),
  );
  assert.equal(dmStored.status, 201);
  assert.equal(dmDb.calls.filter((call) => MENTION_TIER_TEST(call.sql)).length, 0,
    "a DM's @everyone gated not — the null server never reaches the bit read");

  // A @user mention gates not for any member (roster resolution is
  // render-side; the server stores the plain text).
  const userStored = await sendBody(
    [...SEND_BASE(1), { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1, last_row_id: 11 }, results: [messageRow({ id: 11, body: "@wempos hi" })] }) }],
    "@wempos hi",
  );
  assert.equal(userStored.status, 201,
    "a @user mention gates not for any member — the server stores the plain text; the roster resolution is render-side");
});

test("the edit lane gates identically: an author can never introduce an @everyone they couldn't send", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const refusedDb = fakeDb([
    sessionRoute(row),
    { test: EDITED_CHANNEL_TEST, first: async () => ({ id: 5, server_id: 1, kind: "text" }) },
    ...editLaneRoutes(),
    mentionTierRoute(PLAIN_MEMBER()),
  ]);
  const refused = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "now @everyone" }, headers),
    envWithLimiters({ GOOBER_DB: refusedDb }),
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(await bodyOf(refused), { error: "You can't mention everyone here." });
  assert.deepEqual(refusedDb.calls.filter((call) => EDIT_UPDATE_TEST(call.sql)), [],
    "a refused edit never reaches the UPDATE");

  // A moderator's edit stores.
  _resetFilterWordsCacheForTests();
  const modDb = fakeDb([
    sessionRoute(row),
    { test: EDITED_CHANNEL_TEST, first: async () => ({ id: 5, server_id: 1, kind: "text" }) },
    ...editLaneRoutes(),
    mentionTierRoute({ role: "moderator", permissions: 0 }),
    { test: EDIT_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: MESSAGE_BY_ID_TEST, first: async () => messageRow({ body: "now @everyone", edited_at: 999 }) },
  ]);
  const modStored = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "now @everyone" }, headers),
    envWithLimiters({ GOOBER_DB: modDb }),
  );
  assert.equal(modStored.status, 200);

  // An edit with no flag never reads the tier row.
  _resetFilterWordsCacheForTests();
  const plainDb = fakeDb([
    sessionRoute(row),
    { test: EDITED_CHANNEL_TEST, first: async () => ({ id: 5, server_id: 1, kind: "text" }) },
    ...editLaneRoutes(),
    { test: EDIT_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: MESSAGE_BY_ID_TEST, first: async () => messageRow({ edited_at: 999 }) },
  ]);
  const plain = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "same old body" }, headers),
    envWithLimiters({ GOOBER_DB: plainDb }),
  );
  assert.equal(plain.status, 200);
  assert.equal(plainDb.calls.filter((call) => MENTION_TIER_TEST(call.sql)).length, 0);
});

// The schema pin at the tail: the messages module's mention gate rides the
// shared FILTER_MEMBER_TIER_SQL shape, so its SQL is byte-stable.
test("the gate's tier read is the shared filter membership shape", async () => {
  const source = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "api", "messages.mjs"),
    "utf8",
  );
  assert.match(source, /enforceMentionGate\(env, serverId, userId, text\)/);
  assert.match(source, /You can't mention everyone here\./);
  assert.match(source, /FILTER_MEMBER_TIER_SQL/,
    "the gate reads the same one-statement tier shape the filter gate reads");
});

// --- the inbox routes (MED-4: the delete rides a write bucket) ---------------------

async function dispatchMentions(request, env) {
  const url = new URL(request.url);
  try {
    return await handleMentionRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(error.payload || { error: error.message }, error.status, error.headers);
  }
}

test("DELETE /api/mentions/:id rides a WRITE limiter and deletes the caller's own row only", async () => {
  const { row, headers } = await sessionFixtures();
  const keys = [];
  const env = envWithLimiters({ GOOBER_DB: fakeDb([
    sessionRoute(row),
    { test: (sql) => sql.startsWith("DELETE FROM gc_mentions WHERE message_id = ? AND user_id = ?"),
      run: async () => ({ meta: { changes: 1 } }) },
  ]) });
  // The limiter stands record: every binding's limit() logs its bucket key.
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => { keys.push(key); return { success: true, key }; } };
  }
  const response = await dispatchMentions(
    jsonRequest("DELETE", "/api/mentions/5", null, headers),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { deleted: true });
  // The limiter's wire key is the scope:actor pair, hashed (the vendored
  // shape — every route rides it).
  assert.equal(keys.length, 1);
  assert.equal(keys[0], await sha256Hex("write:mentions:" + USER_ID),
    "the delete owns its write bucket, keyed to the caller");
});
