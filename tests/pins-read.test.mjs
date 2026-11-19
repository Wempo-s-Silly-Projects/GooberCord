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

// The 0026 read-parity routes: the pins lane (PUT/DELETE
// /api/messages/:id/pin + GET /api/channels/:id/pins) and the read markers
// (POST /api/conversations/:id/read + the history tail's auto-advance).
// Fake-db tests: the classifier reads' route answers decide every shape
// (unknown, unauthorized, own, staff, bit-granted), and the write verdicts
// ride the runs' recorded meta.
import test from "node:test";
import assert from "node:assert/strict";

import { handleMessageRoutes } from "../api/messages.mjs";
import { handleConversationRoutes } from "../api/conversations.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_PINS_MAX_PER_CHANNEL, RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function fakeDb(routes = []) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => { statement.bound = values; return statement; };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        if (route && route.run) return route.run(statement.bound);
        const row = routes.find((entry) => entry.test(sql));
        if (row && row.runMeta) return row.runMeta(statement.bound);
        return { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      calls.push({ call: "batch", statements: statements.map((s) => ({ sql: s.sql, bound: s.bound })) });
      return results;
    },
  };
  return db;
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
  return { token, row, headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf } };
}
const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

const CLASSIFIER_TEST = (sql) =>
  sql.includes("SELECT m.author_id AS author_id, m.is_pinned AS is_pinned") &&
  sql.includes("FROM gc_messages m JOIN gc_channels c");
const MANAGER_TEST = (sql) =>
  sql.includes("FROM gc_server_members sm WHERE sm.server_id = ? AND sm.user_id = ?") &&
  sql.includes("GROUP_CONCAT");
const PIN_UPDATE_TEST = (sql) => sql.startsWith("UPDATE gc_messages SET is_pinned");
const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("SELECT c.id, c.server_id, c.kind FROM gc_channels c WHERE c.id = ?");

async function dispatchMessages(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMessageRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

// The classifier's answer set: the message exists (id 42), riding a server
// channel (id 1), already pinned per the override, whose author defaults to
// the CALLER (the own-message arm).
const messageRow = (isPinned, serverId = 1, author = USER_ID) =>
  ({ test: CLASSIFIER_TEST, first: async () => ({ author_id: author, is_pinned: isPinned, server_id: serverId }) });
const managerRoute = (mask, tier = "member") => ({
  test: MANAGER_TEST,
  first: async () => ({ tier, mask }),
});

test("pin PUT: the author pins without any role bit, the write rides one guarded UPDATE with the cap arm", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), messageRow(0)]);
  const response = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", {
      method: "PUT",
      headers: { Origin: ORIGIN, ...headers },
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { pinned: true, id: 42 });
  const update = db.calls.find((call) => call.call === "run" && PIN_UPDATE_TEST(call.sql));
  assert.ok(update, "the guarded UPDATE carried the pin");
  assert.match(update.sql, /is_pinned = 1 WHERE id = \? AND/);
  assert.match(update.sql, /\(SELECT COUNT\(\*\) FROM gc_messages WHERE channel_id =/);
  assert.deepEqual(update.bound, [42, 42, GC_PINS_MAX_PER_CHANNEL], "the cap is the cited constant, never a literal");
});

test("pin PUT: already-pinned is a no-op 200; unauthorized is the 403; unknown is the 404", async () => {
  const { row, headers } = await sessionFixtures();
  // Already pinned (the classifier answers 1): the route never UPDATEs.
  const repeatDb = fakeDb([sessionRoute(row), messageRow(1), managerRoute(0)]);
  const repeat = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: repeatDb }),
  );
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeatDb.calls.filter((call) => call.call === "run" && PIN_UPDATE_TEST(call.sql)), [],
    "the repeat never wrote");

  // A stranger's message without any grant: the shared 403, no write.
  const denied = fakeDb([sessionRoute(row), messageRow(0, 1, 99), managerRoute(0)]);
  const refused = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: denied }),
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(denied.calls.filter((call) => call.call === "run"), [], "an unauthorized caller wrote nothing");

  // A stray on a DM channel: own-or-staff only, same 403 (the manage read
  // never even fires — server_id is null).
  const dmDenied = fakeDb([sessionRoute(row), messageRow(0, null, 99)]);
  const dmRefused = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: dmDenied }),
  );
  assert.equal(dmRefused.status, 403);

  // Unknown id → the shared 404, no membership read, no write.
  const unknown = fakeDb([sessionRoute(row)]);
  const miss = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/999/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: unknown }),
  );
  assert.equal(miss.status, 404);
  assert.deepEqual(unknown.calls.filter((call) => call.call === "run"), []);
});

test("pin PUT: the DELETE_MESSAGES bit (the Aug-2025 patch's cited reuse) grants the manage-pin; the cap 400s with its copy", async () => {
  const { row, headers } = await sessionFixtures();
  const bit = Number(SERVER_PERMISSIONS.DELETE_MESSAGES);

  // A role aggregate holding the bit gates the stranger's pin.
  const granted = fakeDb([sessionRoute(row), messageRow(0, 1, 99), managerRoute(bit)]);
  const allowed = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: granted }),
  );
  assert.equal(allowed.status, 200, "a bit-holding member pins another's message");

  // The string moderator tier gates without the bit.
  const tiered = fakeDb([sessionRoute(row), messageRow(0, 1, 99), managerRoute(0, "moderator")]);
  const moderator = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: tiered }),
  );
  assert.equal(moderator.status, 200);

  // At the cap the UPDATE changes nothing — the shared copy names the
  // constant's number, 30010-style. The cap arm binds the caller's OWN
  // message (id 42, author = USER_ID), the author-arm-authorized shape.
  const over = fakeDb([
    sessionRoute(row),
    messageRow(0),
    managerRoute(bit),
    { test: PIN_UPDATE_TEST, runMeta: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "PUT", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: over }),
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), new RegExp(`already has ${GC_PINS_MAX_PER_CHANNEL} pins`));
});

test("pin DELETE: authorized and idempotent, unauthorized is the 403", async () => {
  const { row, headers } = await sessionFixtures();
  const own = fakeDb([sessionRoute(row), messageRow(1)]);
  const response = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: own }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { pinned: false, id: 42 });
  const update = own.calls.find((call) => call.call === "run" && PIN_UPDATE_TEST(call.sql));
  assert.match(update.sql, /is_pinned = 0/);

  // An unpinned row's unpin rides the same idempotent 200 (changes 0 is the
  // reaction remove precedent — never a second oracle read).
  const already = fakeDb([sessionRoute(row), messageRow(0)]);
  const plain = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: already }),
  );
  assert.equal(plain.status, 200);

  const denied = fakeDb([sessionRoute(row), messageRow(1, 1, 99), managerRoute(0)]);
  const refused = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }),
    envWithLimiters({ GOOBER_DB: denied }),
  );
  assert.equal(refused.status, 403);
});

// --- GET /api/channels/:id/pins ----------------------------------------------------

const plusNow = nowSeconds();
void plusNow;
const pinRow = (id) => ({
  id,
  author_id: 99,
  author_name: "wempos",
  body: "pinned " + id,
  client_message_id: null,
  source: null,
  created_at: 100 + id,
  edited_at: null,
  author_accent: null,
  is_plus: 0,
});

test("channel pins GET, wired fake: newest-first payload, the grouped reads, the cap as the LIMIT", async () => {
  const { row } = await sessionFixtures();
  const token = randomToken();
  const session = { ...row, token_hash: await sha256Hex(token) };
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => session },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 3, server_id: 1, kind: "text" }) },
    { test: (sql) => sql.includes("FROM gc_messages m JOIN users u") && sql.includes("ORDER BY m.id DESC"),
      all: async (bound) => {
        assert.equal(bound[0] > 0, true, "the now binding rides MESSAGE_SELECT's own is-plus arm first");
        assert.equal(bound[1], 3);
        return { results: [pinRow(12), pinRow(9)] };
      } },
    { test: (sql) => sql.includes("FROM gc_attachments") && sql.includes("message_id IN"),
      all: async (bound) => {
        assert.deepEqual(bound.slice(1), [12, 9], "the one grouped read carries both pin ids");
        return { results: [{ id: 55, message_id: 12 }] };
      } },
    { test: (sql) => sql.includes("FROM gc_message_reactions r JOIN users u"),
      all: async () => ({ results: [{ message_id: 12, emoji: "🔥", user_id: 7, username: "wempos" }] }) },
  ]);
  const readLayer = { limit: async ({ key }) => ({ success: true, key }) };
  const env = envWithLimiters({ GOOBER_DB: db });
  void readLayer;
  const response = await handleMessageRoutes(
    new Request(ORIGIN + "/api/channels/3/pins", { headers: { Cookie: "goober_session=" + token } }),
    env,
    new URL(ORIGIN + "/api/channels/3/pins"),
    "/api/channels/3/pins",
    "GET",
    {},
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.messages.map((m) => m.id), [12, 9], "newest-first");
  assert.deepEqual(body.messages[0].attachmentIds, [55]);
  assert.deepEqual(body.messages[1].attachmentIds, []);
  assert.equal(body.messages[0].reactions[0].emoji, "🔥");
  const pageRead = db.calls.find((call) => call.call === "all" && call.sql.includes("m.is_pinned = 1"));
  assert.ok(pageRead, "the page read carries the pinned filter");
  assert.match(pageRead.sql, new RegExp(`LIMIT ${GC_PINS_MAX_PER_CHANNEL}`));
});

// --- read markers -------------------------------------------------------------------

const CONVERSATION_MEMBER_TEST = (sql) =>
  sql.includes("SELECT last_read_message_id AS last_read FROM gc_conversation_members");
const MARKER_UPDATE_TEST = (sql) =>
  sql.startsWith("UPDATE gc_conversation_members SET last_read_message_id");

async function dispatchConversations(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleConversationRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

test("read marker POST: the member's own row advances forward-only onto a thread-held id", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CONVERSATION_MEMBER_TEST, first: async () => ({ last_read: 10 }) },
  ]);
  const response = await dispatchConversations(
    new Request(ORIGIN + "/api/conversations/5/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ messageId: 20 }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { lastReadMessageId: 20 });
  const update = db.calls.find((call) => call.call === "run" && MARKER_UPDATE_TEST(call.sql));
  assert.ok(update);
  assert.match(update.sql, /WHERE channel_id = \? AND user_id = \? AND last_read_message_id < \?/);
  assert.match(update.sql, /\? <= \(SELECT COALESCE\(MAX\(id\), 0\) FROM gc_messages WHERE channel_id = \?\)/);
  assert.deepEqual(update.bound, [20, 5, USER_ID, 20, 20, 5],
    "self-only (the WHERE carries the member row), forward-only, thread-held");
});

test("read marker POST: behind is the 400, thread-foreign is the 400, non-member is the 404, junk is the 400", async () => {
  const { row, headers } = await sessionFixtures();
  const behind = fakeDb([
    sessionRoute(row),
    { test: CONVERSATION_MEMBER_TEST, first: async () => ({ last_read: 10 }) },
  ]);
  const refused = await dispatchConversations(
    new Request(ORIGIN + "/api/conversations/5/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ messageId: 9 }),
    }),
    envWithLimiters({ GOOBER_DB: behind }),
  );
  assert.equal(refused.status, 400);
  assert.match((await refused.text()), /behind the current one/);
  assert.deepEqual(behind.calls.filter((call) => call.call === "run"), [], "never behind, never a write");

  const held = fakeDb([
    sessionRoute(row),
    { test: CONVERSATION_MEMBER_TEST, first: async () => ({ last_read: 10 }) },
    { test: MARKER_UPDATE_TEST, runMeta: async () => ({ meta: { changes: 0 } }) },
  ]);
  const foreign = await dispatchConversations(
    new Request(ORIGIN + "/api/conversations/5/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ messageId: 999 }),
    }),
    envWithLimiters({ GOOBER_DB: held }),
  );
  assert.equal(foreign.status, 400);
  assert.match((await foreign.text()), /not part of this thread/);

  const outsider = fakeDb([sessionRoute(row)]);
  const missing = await dispatchConversations(
    new Request(ORIGIN + "/api/conversations/5/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ messageId: 20 }),
    }),
    envWithLimiters({ GOOBER_DB: outsider }),
  );
  assert.equal(missing.status, 404, "the outsider keeps the module's shared shape");
  assert.deepEqual(outsider.calls.filter((call) => call.call === "run"), []);

  const junk = fakeDb([sessionRoute(row)]);
  const malformed = await dispatchConversations(
    new Request(ORIGIN + "/api/conversations/5/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify({ messageId: "gold" }),
    }),
    envWithLimiters({ GOOBER_DB: junk }),
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(
    junk.calls.filter((call) => call.call === "first" && CONVERSATION_MEMBER_TEST(call.sql)),
    [],
    "a junk body never read a member row",
  );
});

// --- the history tail's auto-advance ------------------------------------------------

test("the history tail acks: GET without a cursor advances the caller's marker to the page's newest id", async () => {
  const { row } = await sessionFixtures();
  const token = randomToken();
  const session = { ...row, token_hash: await sha256Hex(token) };
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => session },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 5, server_id: null, kind: "dm" }) },
    { test: (sql) => sql.includes("FROM gc_messages m JOIN users u") && sql.includes("ORDER BY m.id DESC"),
      all: async () => ({ results: [pinRow(30), pinRow(25), pinRow(20)] }) },
    { test: (sql) => sql.includes("FROM gc_attachments") && sql.includes("message_id IN"),
      all: async () => ({ results: [] }) },
    { test: (sql) => sql.includes("FROM gc_message_reactions r JOIN users u"),
      all: async () => ({ results: [] }) },
  ]);
  const response = await handleMessageRoutes(
    new Request(ORIGIN + "/api/channels/5/messages", { headers: { Cookie: "goober_session=" + token } }),
    envWithLimiters({ GOOBER_DB: db }),
    new URL(ORIGIN + "/api/channels/5/messages"),
    "/api/channels/5/messages",
    "GET",
    {},
  );
  assert.equal(response.status, 200);
  const ack = db.calls.find((call) => call.call === "run" && MARKER_UPDATE_TEST(call.sql));
  assert.ok(ack, "the tail read carries the ack");
  // forward-only AND thread-held: the /read route's `? <= COALESCE(MAX(id),0)`
  // arm rides here too — a concurrent hard delete can never strand the
  // marker on an id the thread no longer holds.
  assert.match(ack.sql, /\? <= \(SELECT COALESCE\(MAX\(id\), 0\) FROM gc_messages WHERE channel_id = \?\)/);
  assert.deepEqual(ack.bound, [30, 5, USER_ID, 30, 30, 5],
    "the newest page id, the caller's own row, forward-only, thread-held");
});

test("a cursor read (a history walk) never acks, and an empty tail acks nothing", async () => {
  const { row } = await sessionFixtures();
  const token = randomToken();
  const session = { ...row, token_hash: await sha256Hex(token) };
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => session },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 5, server_id: null, kind: "dm" }) },
    { test: (sql) => sql.includes("FROM gc_messages m JOIN users u") && sql.includes("ORDER BY m.id DESC"),
      all: async () => ({ results: [pinRow(12), pinRow(9)] }) },
    { test: (sql) => sql.includes("FROM gc_attachments") && sql.includes("message_id IN"),
      all: async () => ({ results: [] }) },
    { test: (sql) => sql.includes("FROM gc_message_reactions r JOIN users u"),
      all: async () => ({ results: [] }) },
  ]);
  const response = await handleMessageRoutes(
    new Request(ORIGIN + "/api/channels/5/messages?after=20", { headers: { Cookie: "goober_session=" + token } }),
    envWithLimiters({ GOOBER_DB: db }),
    new URL(ORIGIN + "/api/channels/5/messages?after=20"),
    "/api/channels/5/messages",
    "GET",
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" && MARKER_UPDATE_TEST(call.sql)),
    [],
    "a cursor walk is history, not an ack",
  );

  const empty = fakeDb([
    { test: SESSION_READ_TEST, first: async () => session },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 5, server_id: null, kind: "dm" }) },
    { test: (sql) => sql.includes("FROM gc_messages m JOIN users u") && sql.includes("ORDER BY m.id DESC"),
      all: async () => ({ results: [] }) },
  ]);
  const emptyTail = await handleMessageRoutes(
    new Request(ORIGIN + "/api/channels/5/messages", { headers: { Cookie: "goober_session=" + token } }),
    envWithLimiters({ GOOBER_DB: empty }),
    new URL(ORIGIN + "/api/channels/5/messages"),
    "/api/channels/5/messages",
    "GET",
    {},
  );
  assert.equal(emptyTail.status, 200);
  assert.deepEqual(
    empty.calls.filter((call) => call.call === "run" && MARKER_UPDATE_TEST(call.sql)),
    [],
    "an empty page has no newest id to ack",
  );
});
