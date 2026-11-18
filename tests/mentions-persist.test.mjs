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

// The W-B2 mentions lane: the persisted gc_mentions rows (0028) riding the
// send batch, the inbox read, and the read-through DELETE. Same fakeDb +
// pinned-SQL conventions as the mentions gate tests: the authorization
// contract lives in the query text.
import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { handleMessageRoutes } from "../api/messages.mjs";
import { handleMentionRoutes, mentionPersistStatements } from "../api/mentions.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import {
  GC_MENTIONS_MAX_PER_MESSAGE,
  GC_MENTIONS_PAGE_DEFAULT,
  GC_MENTIONS_PAGE_MAX,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const CHANNEL_ID = 3;
const PEER_ID = 9;

const now = Math.floor(nowSeconds() / 1) * 1;

function jsonRequest(method, path, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
  });
}

function postJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
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
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      };
      return statement;
    },
    async batch(statements) {
      // D1's batch answers one result PER statement, in order — the send's
      // created-flag reads results[0] and its row reads the LAST result, so
      // the fake must answer the same way (each route's own run() result,
      // else the default meta-only shape).
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

// The session fixture rides the shape readSession builds from (the hash of
// the token the headers carry answers the binds; the route ignores them).
async function sessionFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
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
  };
  return {
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
    sessionRoute: () => ({
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => row,
    }),
  };
}

const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c WHERE c.id = ?") &&
  sql.includes("gc_server_members m") &&
  sql.includes("gc_conversation_members cm");
const CHANNEL_SERVER_TEST = (sql) =>
  sql.includes("SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1");
const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");
const USER_GATING_TEST = (sql) => sql.includes("FROM user_gating WHERE user_id = ?");
const MESSAGE_RESELECT_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("client_message_id") &&
  sql.includes("ORDER BY m.id DESC LIMIT 1");

const SERVER_ROSTER_TEST = (sql) => sql.includes("FROM gc_server_members sm JOIN users u");
const DM_ROSTER_TEST = (sql) => sql.includes("FROM gc_conversation_members cm JOIN users u");
const MENTION_INSERT_TEST = (sql) => sql.includes("INSERT OR IGNORE INTO gc_mentions");

function messageRow(overrides = {}) {
  return { id: 5, author_id: USER_ID, body: "hi", created_at: now, ...overrides };
}

async function dispatchSend(fixture, routes, body) {
  _resetFilterWordsCacheForTests();
  const db = fakeDb([fixture.sessionRoute(), { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) }, ...routes]);
  const env = envWithLimiters({ GOOBER_DB: db });
  // The REAL dispatch path (the route table keys off the `path` argument —
  // a non-route path answers undefined and never reaches the send pipeline).
  const path = `/api/channels/${CHANNEL_ID}/messages`;
  const response = await handleMessageRoutes(
    postJson(path, { body }, fixture.headers), env, new URL(ORIGIN + "/x"), path, "POST", undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  return { db, response };
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function batchOf(db) {
  return db.calls.filter((call) => call.call === "batch").pop()?.statements || [];
}

// --- the send-side persists ------------------------------------------------------

test("a server-channel send resolves roster mentions and rides ONE in-batch row per member", async () => {
  const fixture = await sessionFixtures();
  const { headers } = fixture;
  const { db } = await dispatchSend(fixture, [
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: 1 }) },
    { test: USER_GATING_TEST, first: async () => null },
    { test: SERVER_ROSTER_TEST, all: async () => ({ results: [
      { id: USER_ID, username: "wempos" },
      { id: PEER_ID, username: "wem" },
    ] }) },
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1 }, results: [messageRow()] }) },
  ], "hey @wem, from @wempos too");
  const mentions = batchOf(db).filter((s) => MENTION_INSERT_TEST(s.sql));
  assert.equal(mentions.length, 2, "one row per resolved member (self mentions persist too)");
  // The send's own second: read from the batch's leading message INSERT
  // (binds 4 = created_at), not the module clock — the handler stamps its own
  // nowSeconds() at send time, and a second boundary between the module's
  // capture and the send must never flake the identical-second pin.
  const sendNow = batchOf(db)[0].bound[4];
  for (const statement of mentions) {
    assert.match(statement.sql, /INSERT OR IGNORE INTO gc_mentions/, "the dedupe spelling");
    assert.match(statement.sql, /gc_messages WHERE channel_id = \? AND author_id = \? AND created_at = \?/,
      "the identity tuple re-derives the batch's own row");
    // The NULL-cid bind shape: channelId, authorId, createdAt, userId, createdAt.
    const binds = statement.bound;
    assert.equal(binds.length, 5);
    assert.equal(binds[0], CHANNEL_ID);
    assert.equal(binds[1], USER_ID, "the identity tuple carries the author");
    assert.equal(binds[2], sendNow);
    assert.equal(binds[4], sendNow, "the row's own created_at mirrors the send's");
  }
  // Classification by the row's OWN user slot (binds[3]) — never by an author
  // arm, which both statements carry.
  assert.deepEqual(mentions.map((s) => s.bound[3]).sort(), [PEER_ID, USER_ID].sort(),
    "the peer's row AND the author's self-mention row ride the batch");
  // Statement order: the message INSERT leads the batch, the mention rows
  // ride after the channel-bump UPDATE, and the reselect stays LAST (the row
  // the route echoes is the batch's own fresh insert, never an older one).
  const batchStatements = batchOf(db);
  assert.equal(batchStatements.length, 5,
    "message INSERT + channel-bump UPDATE + the two mention rows + the reselect");
  assert.match(batchStatements[0].sql, /INSERT INTO gc_messages/, "the message INSERT leads");
  assert.equal(MENTION_INSERT_TEST(batchStatements[0].sql), false);
  assert.equal(MENTION_INSERT_TEST(batchStatements[1].sql), false,
    "the channel-bump UPDATE precedes the mention rows");
  assert.ok(MENTION_INSERT_TEST(batchStatements[2].sql) && MENTION_INSERT_TEST(batchStatements[3].sql),
    "the mention rows ride after the bump, before the reselect");
  assert.equal(MENTION_INSERT_TEST(batchStatements[batchStatements.length - 1].sql), false,
    "the reselect is the batch's last statement, never a mention row");
});

test("a body without '@' costs nothing — not even the roster read", async () => {
  const fixture = await sessionFixtures();
  const { headers } = fixture;
  const { db } = await dispatchSend(fixture, [
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: 1 }) },
    { test: USER_GATING_TEST, first: async () => null },
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1 }, results: [messageRow()] }) },
  ], "a plain hello");
  const mentions = batchOf(db).filter((s) => MENTION_INSERT_TEST(s.sql));
  assert.equal(mentions.length, 0);
  assert.equal(db.calls.filter((call) => SERVER_ROSTER_TEST(call.sql) || DM_ROSTER_TEST(call.sql)).length, 0,
    "no roster query ran");
});

test("a DM send resolves against the conversation roster", async () => {
  const fixture = await sessionFixtures();
  const { headers } = fixture;
  const { db } = await dispatchSend(fixture, [
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: null, kind: "dm" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: null }) },
    { test: USER_GATING_TEST, first: async () => null },
    { test: DM_ROSTER_TEST, all: async () => ({ results: [{ id: PEER_ID, username: "wem" }] }) },
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1 }, results: [messageRow()] }) },
  ], "yo @wem");
  assert.ok(db.calls.some((call) => DM_ROSTER_TEST(call.sql)), "the conversation roster is the read");
  const mentions = batchOf(db).filter((s) => MENTION_INSERT_TEST(s.sql));
  assert.equal(mentions.length, 1);
  assert.ok(mentions[0].bound.includes(PEER_ID));
});

// The MED-3 fix (the reviewer's server-roster gap): the server roster carries
// sm.nickname, so a nickname-only @mention writes the inbox row — a DM roster
// (no nickname column there, per 0006) resolves nothing on it.
test("a nickname-only server @mention resolves through the roster's nickname and writes the inbox row", async () => {
  const fixture = await sessionFixtures();
  const { headers } = fixture;
  const { db, response } = await dispatchSend(fixture, [
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: 1 }) },
    { test: USER_GATING_TEST, first: async () => null },
    { test: SERVER_ROSTER_TEST, all: async () => ({
      results: [
        { id: PEER_ID, username: "wem", nickname: "the boss" },
        { id: 9, username: "other", nickname: null },
      ],
    }) },
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1 }, results: [messageRow()] }) },
  ], "@the boss hi");
  assert.equal(response.status, 201);
  const roster = db.calls.find((call) => SERVER_ROSTER_TEST(call.sql));
  assert.match(roster.sql, /sm\.nickname AS nickname/,
    "the server read carries the nickname column (the DM read does not)");
  const mentions = batchOf(db).filter((s) => MENTION_INSERT_TEST(s.sql));
  assert.equal(mentions.length, 1, "the nickname alone resolved the seat");
  assert.equal(mentions[0].bound[3], PEER_ID);
});

test("repeated tokens dedupe to one row, and the send-side cap is the constant's own 100", async () => {
  const roster = Array.from({ length: GC_MENTIONS_MAX_PER_MESSAGE + 2 },
    (_, i) => ({ id: 100 + i, username: "m" + i }));
  const fixture = await sessionFixtures();
  const { headers } = fixture;
  const { db } = await dispatchSend(fixture, [
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: 1 }) },
    { test: USER_GATING_TEST, first: async () => null },
    { test: SERVER_ROSTER_TEST, all: async () => ({ results: roster }) },
    { test: MESSAGE_RESELECT_TEST, run: async () => ({ meta: { changes: 1 }, results: [messageRow()] }) },
  ], roster.map((member) => "@" + member.username).join(" and "));
  const mentions = batchOf(db).filter((s) => MENTION_INSERT_TEST(s.sql));
  assert.equal(mentions.length, GC_MENTIONS_MAX_PER_MESSAGE,
    "the send-side budget rides the constant, exact");
});

// The direct helper shape: the identity tuple arm rides the CLIENT ID arm a
// cid-carrying send binds (the replay re-resolves the ORIGINAL row).
test("mentionPersistStatements arms the client-id form for cid sends, ignores duplicate rows", async () => {
  const env = { GOOBER_DB: fakeDb([
    { test: SERVER_ROSTER_TEST, all: async () => ({ results: [{ id: PEER_ID, username: "wem" }, { id: 11, username: "wem" }] }) },
  ]) };
  const statements = await mentionPersistStatements(env, 1, CHANNEL_ID, USER_ID, now, "abcdefgh", "hi @wem");
  // BOTH members carry "wem" → ambiguous at ANY width → nobody: the parse's
  // resolved-ids contract, and an empty insert set follows.
  assert.deepEqual(statements, []);

  const envSingle = { GOOBER_DB: fakeDb([
    { test: SERVER_ROSTER_TEST, all: async () => ({ results: [{ id: PEER_ID, username: "wem" }] }) },
  ]) };
  const cidStatements = await mentionPersistStatements(envSingle, 1, CHANNEL_ID, USER_ID, now, "abcdefgh", "hi @wem");
  assert.equal(cidStatements.length, 1);
  const sql = cidStatements[0].sql;
  assert.match(sql, /client_message_id = \? ORDER BY id DESC LIMIT 1/, "the cid arm");
  assert.match(sql, /INSERT OR IGNORE/, "the OR IGNORE replay spelling");
  // The cid bind shape: channelId, authorId, createdAt, cid, userId, createdAt.
  const binds = cidStatements[0].bound;
  assert.deepEqual(
    [binds[0], binds[1], binds[2], binds[3], binds[4], binds[5]],
    [CHANNEL_ID, USER_ID, now, "abcdefgh", PEER_ID, now],
    "the cid arm adds exactly ONE extra bind between the tuple and the row's own user");
});

// --- the inbox routes ------------------------------------------------------------

const MENTION_LIST_TEST = (sql) => sql.includes("FROM gc_mentions gm");
const MENTION_DELETE_TEST = (sql) => sql.includes("DELETE FROM gc_mentions");

async function dispatchMention(method, path, routes, body = undefined) {
  const fixture = await sessionFixtures();
  const { headers } = fixture;
  const db = fakeDb([fixture.sessionRoute(), ...routes]);
  const request = body === undefined
    ? jsonRequest(method, path, headers)
    : new Request(ORIGIN + path, {
      method,
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });
  // The worker composes `path` from the URL's pathname (no query string) —
  // the route table's equality matches never see the search params.
  const url = new URL(ORIGIN + path);
  const response = await handleMentionRoutes(
    request, envWithLimiters({ GOOBER_DB: db }), url, url.pathname, method, undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  return { db, response };
}

test("GET /api/mentions: the viewer's own rows, newest-first, the membership guard riding the WHERE", async () => {
  const inboxRow = {
    message_id: 40, mentioned_at: now, channel_id: CHANNEL_ID, channel_name: "general",
    channel_kind: "text", author_id: PEER_ID, author_username: "wem", body: "hi @wempos", created_at: now,
  };
  const { db, response } = await dispatchMention("GET", "/api/mentions", [
    { test: MENTION_LIST_TEST, all: async () => ({ results: [inboxRow] }) },
  ]);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.mentions, [{
    messageId: 40, channelId: CHANNEL_ID, channelName: "general", channelKind: "text",
    authorId: PEER_ID, authorUsername: "wem", body: "hi @wempos", createdAt: now, mentionedAt: now,
  }]);
  const list = db.calls.find((call) => MENTION_LIST_TEST(call.sql));
  assert.equal(list.bound[0], USER_ID, "the rows are the viewer's own");
  // Balanced parens in the guard: the membership guard is ONE group whose
  // server and conversation arms OR together — an unbalanced spelling is a
  // syntax error at the prepare, not a test failure.
  const opens = (list.sql.match(/\(/g) || []).length;
  const closes = (list.sql.match(/\)/g) || []).length;
  assert.equal(opens, closes, "the membership guard's parens balance");
  assert.match(list.sql, /gc_server_members fsm WHERE fsm\.server_id = c\.server_id AND fsm\.user_id = \?/, "the server-channel guard");
  assert.match(list.sql, /gc_conversation_members fcm WHERE fcm\.channel_id = c\.id AND fcm\.user_id = \?/, "the conversation guard");
  assert.match(list.sql, /ORDER BY gm\.message_id DESC/, "newest-first");
  assert.match(list.sql, /LIMIT 25/, "the default page");
});

test("the inbox limit: the page cap answers 400 past GC_MENTIONS_PAGE_MAX, honors inside it", async () => {
  assert.equal(GC_MENTIONS_PAGE_DEFAULT, 25);
  assert.equal(GC_MENTIONS_PAGE_MAX, 100);
  const { db, response } = await dispatchMention("GET", "/api/mentions?limit=100", [
    { test: MENTION_LIST_TEST, all: async () => ({ results: [] }) },
  ]);
  assert.equal(response.status, 200);
  assert.match(db.calls.find((call) => MENTION_LIST_TEST(call.sql)).sql, /LIMIT 100/);
  const refused = await dispatchMention("GET", "/api/mentions?limit=101", []);
  assert.equal(refused.response.status, 400);
  const junk = await dispatchMention("GET", "/api/mentions?limit=abc", []);
  assert.equal(junk.response.status, 400);
  assert.equal(junk.db.calls.some((call) => MENTION_LIST_TEST(call.sql)), false,
    "a malformed limit never spends the read");
});

test("DELETE /api/mentions/:id: the caller's own row, never someone else's, idempotent", async () => {
  const { db, response } = await dispatchMention("DELETE", "/api/mentions/40", []);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  const del = db.calls.find((call) => MENTION_DELETE_TEST(call.sql) && call.call === "run");
  assert.ok(del);
  assert.deepEqual(del.bound, [40, USER_ID], "the WHERE carries the caller's own guard");
  // The gone-and-gone replay: the default empty-changes meta answers the
  // same 200 (an unpin-idiom idempotent delete).
  const gone = await dispatchMention("DELETE", "/api/mentions/40", []);
  assert.equal(gone.response.status, 200);
});

test("GET /api/mentions survives a real browser's GET: no Origin header (Firefox sends Origin only on CORS GETs)", async () => {
  // The prod-shaped failure the suite missed for exactly one request class:
  // every fixture request carried Origin + CSRF, but the browser's same-origin
  // GET fetch sends neither — a read gate that demanded them 403'd the inbox
  // on every load (live-confirmed against prod 2026-11-17). A read route
  // rides the signed-in read gate, never the CSRF wall.
  const fixture = await sessionFixtures();
  const db = fakeDb([fixture.sessionRoute(), { test: MENTION_LIST_TEST, all: async () => ({ results: [] }) }]);
  const request = new Request(ORIGIN + "/api/mentions", {
    method: "GET",
    headers: { Cookie: fixture.headers.Cookie },
  });
  const response = await handleMentionRoutes(
    request, envWithLimiters({ GOOBER_DB: db }), new URL(ORIGIN + "/api/mentions"), "/api/mentions", "GET", undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  assert.equal(response.status, 200, "a signed-in GET without Origin is a normal read, not a CSRF question");
  // The mutating DELETE keeps the full wall: same no-Origin shape must refuse.
  const deleteRequest = new Request(ORIGIN + "/api/mentions/40", {
    method: "DELETE",
    headers: { Cookie: fixture.headers.Cookie },
  });
  const refused = await handleMentionRoutes(
    deleteRequest, envWithLimiters({ GOOBER_DB: db }), new URL(ORIGIN + "/api/mentions/40"), "/api/mentions/40", "DELETE", undefined,
  ).catch((error) => error instanceof HttpError
    ? json(error.payload || { error: error.message }, error.status) : Promise.reject(error));
  assert.equal(refused.status, 403, "the DELETE keeps its same-origin + CSRF wall");
});

test("the worker chain carries the mention routes (the /api/mentions door wires)", async () => {
  const source = (await import("node:fs")).readFileSync(
    new URL("../worker.mjs", import.meta.url).pathname, "utf8",
  );
  assert.match(source, /import \{ handleMentionRoutes \} from "\.\/api\/mentions\.mjs";/);
  assert.match(source, /handleMentionRoutes,/);
});
