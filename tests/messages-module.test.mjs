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

// Messages routes (Phase 1, Task 5): channel history with the bare-id cursor,
// the idempotent send (shared primitive `sendMessageToChannel`), the
// author-only edit, and the three-tier delete — driven against a fake
// GOOBER_DB. Same fake conventions as the servers test module: fakeDb records
// every statement's bound values, with batch() carrying each statement's SQL
// so tests can pin the guarded-SQL shape itself (the authorization contract
// lives in the query text, so that is what the tests assert).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";

import { handleMessageRoutes, sendMessageToChannel } from "../api/messages.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_FREE_MESSAGE_MAX, GC_PLUS_MESSAGE_MAX, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const CHANNEL_ID = 3;

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

// Same JSON shape for the PATCH and DELETE dispatches.
function jsonRequest(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Test dispatcher: mirrors worker.mjs's apiError mapping so HttpErrors surface
// as the same JSON responses the worker would return.
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

// --- session fixtures -----------------------------------------------------------
// A session row exactly as the vendored readSession SELECT joins it, with a
// real cookie/CSRF token pair for the requireUser-routed requests.

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
    role, // the STORED vocabulary, exactly like the D1 row readSession joins
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
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

// --- fake-route shapes -----------------------------------------------------------

// The single-SQL channel access check (both membership tiers in one statement).
const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c WHERE c.id = ?") &&
  sql.includes("gc_server_members m") &&
  sql.includes("gc_conversation_members cm");

const NOT_FOUND = { error: "This channel does not exist or you cannot view it." };

const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");

const MESSAGES_PAGE_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("ORDER BY m.id DESC LIMIT");

const MESSAGE_RESELECT_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("client_message_id") &&
  // The reselect is the triple read ended by the newest-first LIMIT 1 (the
  // page reads use LIMIT <page size>).
  sql.includes("ORDER BY m.id DESC LIMIT 1");

const MESSAGE_BY_ID_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("WHERE m.id = ? LIMIT 1");

const MESSAGE_INSERT_TEST = (sql) =>
  sql.includes("INSERT INTO gc_messages") &&
  sql.includes("ON CONFLICT(channel_id, author_id, client_message_id) DO NOTHING");

const ATTACH_PAGE_TEST = (sql) =>
  sql.includes("FROM gc_attachments") && sql.includes("message_id IN");

const ATTACH_ONE_TEST = (sql) =>
  sql.includes("FROM gc_attachments") && sql.includes("message_id = ?");

const EDIT_UPDATE_TEST = (sql) =>
  sql.includes("UPDATE gc_messages SET body = ?, edited_at = ? WHERE id = ? AND author_id = ?");

const DELETE_TEST = (sql) => sql.includes("DELETE FROM gc_messages");

// Task 6's attachment cleanup, carried by the delete batch: the chunk and
// attachment deletes PRECEDE the message DELETE (the schema's gc_attachments
// FK has no ON DELETE action) and guard themselves with the SAME three tiers.
const ATTACH_CHUNKS_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_attachment_chunks") &&
  sql.includes("FROM gc_attachments a") &&
  sql.includes("author_id = ?");

const ATTACH_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_attachments WHERE message_id = ?") &&
  sql.includes("author_id = ?");

// Message rows exactly as the JOINed SELECT would return them.
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

function publicMessageShape(row, attachmentIds) {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    editedAt:
      row.edited_at === null || row.edited_at === undefined
        ? null
        : new Date(row.edited_at * 1000).toISOString(),
    source: row.source,
    // The Nitro lane (2026-11-17): the boolean badge rides EVERY message.
    isPlus: Boolean(row.is_plus),
    attachmentIds,
  };
}

// --- handler contract -----------------------------------------------------------

test("unknown API paths fall through to the worker's handler loop", async () => {
  const response = await handleMessageRoutes(
    get("/api/nope"),
    envWithLimiters({ GOOBER_DB: fakeDb([]) }),
    new URL(ORIGIN + "/api/nope"),
    "/api/nope",
    "GET",
    undefined,
  );
  assert.equal(response, undefined);
});

test("non-numeric message id paths fall through to the worker's 404", async () => {
  const { row, headers } = await sessionFixtures();
  const response = await handleMessageRoutes(
    jsonRequest("PATCH", "/api/messages/abc", { body: "x" }, headers),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row)]) }),
    new URL(ORIGIN + "/api/messages/abc"),
    "/api/messages/abc",
    "PATCH",
    undefined,
  );
  assert.equal(response, undefined);
});

// --- GET /api/channels/:id/messages ----------------------------------------------

test("(a) an outsider's history read 404s without ever binding a message row", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    // The access check finds NO membership row.
    { test: CHANNEL_ACCESS_TEST, first: async () => null },
  ]);
  const response = await dispatch(
    get(`/api/channels/${CHANNEL_ID}/messages`, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), NOT_FOUND);

  // Only the session read and the access check ever ran — no gc_messages
  // SELECT was bound, no gc_attachments read, no write: the 404-not-403
  // semantics cost zero data reads past the membership check.
  const shapes = db.calls.map((call) => call.sql);
  assert.equal(shapes.filter((sql) => MESSAGES_PAGE_TEST(sql)).length, 0);
  assert.equal(shapes.filter((sql) => ATTACH_PAGE_TEST(sql)).length, 0);
  assert.equal(
    db.calls.filter((call) => call.call === "batch" || call.call === "run").length,
    0,
  );
});

test("history returns the newest rows ordered id DESC with grouped attachment ids", async () => {
  const { row, headers } = await sessionFixtures();
  const rows = [
    messageRow({ id: 5, body: "newest", edited_at: 1000 }),
    messageRow({ id: 3, body: "older", source: "forum-chat" }),
  ];
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: MESSAGES_PAGE_TEST, all: async () => ({ results: rows }) },
    {
      test: ATTACH_PAGE_TEST,
      all: async () => ({ results: [{ id: 21, message_id: 5 }] }),
    },
  ]);
  const response = await dispatch(
    get(`/api/channels/${CHANNEL_ID}/messages`, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    messages: [publicMessageShape(rows[0], [21]), publicMessageShape(rows[1], [])],
    nextAfter: 3,
    // The expression side table (0020): the channel's server inventory —
    // these fixtures carry none, so both arrays ride empty.
    expressions: { emojis: [], stickers: [] },
  });

  // Default page: 50, newest-first, no cursor bound.
  const page = db.calls.find((call) => MESSAGES_PAGE_TEST(call.sql));
  assert.ok(page);
  assert.match(page.sql, /LIMIT 50/);
  assert.doesNotMatch(page.sql, /m\.id < \?/);
});

test("(g) after=<id> returns only older rows with nextAfter of the oldest page", async () => {
  const { row, headers } = await sessionFixtures();
  const rows = [messageRow({ id: 4 }), messageRow({ id: 2 })];
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: MESSAGES_PAGE_TEST, all: async () => ({ results: rows }) },
  ]);
  const response = await dispatch(
    get(`/api/channels/${CHANNEL_ID}/messages?after=5&limit=2`, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    messages: [publicMessageShape(rows[0], []), publicMessageShape(rows[1], [])],
    // nextAfter rides the page's oldest id, so the next request keeps walking
    // the same backward keyset the cursor's `m.id < ?` predicate describes.
    nextAfter: 2,
    // The expression side table rides even an empty inventory (the channel
    // fixture is a server channel; a DM channel's list shape adds nothing).
    expressions: { emojis: [], stickers: [] },
  });

  const page = db.calls.find((call) => MESSAGES_PAGE_TEST(call.sql));
  assert.match(page.sql, /m\.id < \?/);
  // The plusActiveExpr badge's `now` bind precedes the WHERE binds.
  assert.equal(page.bound[1], CHANNEL_ID);
  assert.equal(page.bound[2], 5);
  assert.match(page.sql, /LIMIT 2/);
});

test("history rejects an invalid cursor and an out-of-range limit with 400", async () => {
  const { row, headers } = await sessionFixtures();
  const afterCases = ["?after=0", "?after=abc", "?after=99999999999999999", "?after=007"];
  for (const query of afterCases) {
    const db = fakeDb([sessionRoute(row)]);
    const response = await dispatch(
      get(`/api/channels/${CHANNEL_ID}/messages${query}`, headers),
      envWithLimiters({ GOOBER_DB: db }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), { error: "That message cursor is invalid." });
    assert.equal(db.calls.filter((call) => CHANNEL_ACCESS_TEST(call.sql)).length, 0);
  }

  for (const query of ["?limit=101", "?limit=0", "?limit=abc"]) {
    const db = fakeDb([sessionRoute(row)]);
    const response = await dispatch(
      get(`/api/channels/${CHANNEL_ID}/messages${query}`, headers),
      envWithLimiters({ GOOBER_DB: db }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), { error: "That message limit is invalid." });
  }
});

// --- POST /api/channels/:id/messages ---------------------------------------------

test("(b) an outsider's send 404s without any D1 write", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => null },
  ]);
  const response = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "hello" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), NOT_FOUND);
  // The guarded INSERT never even assembled: no batch, no standalone write.
  assert.deepEqual(
    db.calls.filter((call) => call.call === "batch" || call.call === "run"),
    [],
  );
});

test("sending stores the message and bumps the channel's last_* in ONE batch", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({
        meta: { changes: 1, last_row_id: 11 },
        results: [messageRow({ id: 11, body: "hello" })],
      }),
    },
  ]);
  const response = await dispatch(
    postJson(
      `/api/channels/${CHANNEL_ID}/messages`,
      { body: "hello", clientMessageId: "cccccccc" },
      headers,
    ),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    message: publicMessageShape(messageRow({ id: 11, body: "hello" }), []),
  });

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  // The send's write surface stays ONE batch. The ONLY standalone write after
  // it is 0011's per-message coin grant (guarded by its own caps, and minted
  // only because created=true — an idempotent replay never reaches it).
  const standalone = db.calls.filter((call) => call.call === "run");
  assert.equal(standalone.length, 1);
  assert.match(standalone[0].sql, /INSERT INTO gc_coin_ledger/);

  const [insert, channelUpdate, reselect] = batch.statements.map((s) => s.sql);
  // Scoping pin: the ONLY written row is a gc_message, and the idempotency
  // key rides the ON CONFLICT clause itself (never a read-then-write check).
  assert.match(
    insert,
    /^INSERT INTO gc_messages \(channel_id, author_id, body, client_message_id, created_at\) VALUES \(\?, \?, \?, \?, \?\) ON CONFLICT\(channel_id, author_id, client_message_id\) DO NOTHING$/,
  );
  // The channel bump derives BOTH values from the messages table itself, so an
  // idempotent replay can never move last_message_id/last_message_at backward
  // or stale — the MAX(id) scan is the statement's own guard.
  assert.match(
    channelUpdate,
    /UPDATE gc_channels SET last_message_id = \(SELECT MAX\(id\) FROM gc_messages WHERE channel_id = \?\), last_message_at = \(SELECT created_at FROM gc_messages WHERE channel_id = \? ORDER BY id DESC LIMIT 1\) WHERE id = \?$/,
  );
  assert.deepEqual(batch.statements[1].bound, [CHANNEL_ID, CHANNEL_ID, CHANNEL_ID]);

  // Bindings: channel, author, body, the client id, then the timestamp —
  // never a client-supplied position or id.
  const insertBound = batch.statements[0].bound;
  assert.deepEqual(
    insertBound.slice(0, 4),
    [CHANNEL_ID, USER_ID, "hello", "cccccccc"],
  );
  assert.equal(typeof insertBound[4], "number");

  // The follow-up SELECT resolves the row by the idempotency triple —
  // newest-first, so a cid-less triple can never re-select an older row.
  assert.match(
    reselect,
    /WHERE m\.channel_id = \? AND m\.author_id = \? AND m\.client_message_id = \? ORDER BY m\.id DESC LIMIT 1$/,
  );
  // The reselect's first bind is the plusActiveExpr badge's `now`.
  assert.equal(typeof batch.statements[2].bound[0], "number");
  assert.deepEqual(batch.statements[2].bound.slice(1), [CHANNEL_ID, USER_ID, "cccccccc"]);
});

test("(c) re-posting the same clientMessageId returns the existing row with the same id", async () => {
  const { row, headers } = await sessionFixtures();
  // Stateful fake: the FIRST insert applies (changes 1, row 11); every
  // following identical insert conflicts (DO NOTHING → changes 0) and the
  // follow-up SELECT keeps resolving the ONE existing row.
  const existing = messageRow({ id: 11, body: "hello", client_message_id: "cccccccc" });
  const state = { inserts: 0 };
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    {
      test: MESSAGE_INSERT_TEST,
      run: async () => {
        state.inserts += 1;
        return { meta: { changes: state.inserts === 1 ? 1 : 0, last_row_id: 11 } };
      },
    },
    {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({ meta: { changes: 1, last_row_id: 11 }, results: [existing] }),
    },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db });
  const send = () =>
    dispatch(
      postJson(
        `/api/channels/${CHANNEL_ID}/messages`,
        { body: "hello", clientMessageId: "cccccccc" },
        headers,
      ),
      env,
    );

  const first = await send();
  const second = await send();

  // One row: the second INSERT reported zero changes (the DO NOTHING fired);
  // both responses carry the same stored id.
  assert.equal(state.inserts, 2);
  const firstMessage = (await bodyOf(first)).message;
  const secondMessage = (await bodyOf(second)).message;
  assert.equal(firstMessage.id, 11);
  assert.equal(secondMessage.id, firstMessage.id);
});

test("(e) a filtered word rejects the send with 400 and no D1 write", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "badword", updated_at: 1 }) },
  ]);
  const response = await dispatch(
    postJson(
      `/api/channels/${CHANNEL_ID}/messages`,
      { body: "a wild badword appears" },
      headers,
    ),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That message isn't allowed." });
  // The filter gate sits before the write: the guarded INSERT never ran.
  assert.deepEqual(db.calls.filter((call) => call.call === "batch" || call.call === "run"), []);
});

test("an empty effective list passes everything and beats the FILTERED_WORDS secret", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({
        meta: { changes: 1, last_row_id: 12 },
        results: [messageRow({ id: 12, body: "a wild badword appears" })],
      }),
    },
  ]);
  const response = await dispatch(
    postJson(
      `/api/channels/${CHANNEL_ID}/messages`,
      { body: "a wild badword appears" },
      headers,
    ),
    // The secret would match, but the D1 row (emptied) is the source of truth.
    envWithLimiters({ GOOBER_DB: db, FILTERED_WORDS: "badword" }),
  );

  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).message.body, "a wild badword appears");
});

test("the FILTERED_WORDS secret is the fallback while no site_settings row exists", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: SITE_SETTINGS_TEST, first: async () => null },
  ]);
  const response = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "say blockedword now" }, headers),
    envWithLimiters({ GOOBER_DB: db, FILTERED_WORDS: "blockedword" }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That message isn't allowed." });
  assert.deepEqual(db.calls.filter((call) => call.call === "batch" || call.call === "run"), []);
});

test("send validation: blank bodies, oversized bodies, and short client ids 400 before any write", async () => {
  const { row, headers } = await sessionFixtures();
  const cases = [
    [{ body: "   " }, "Message body must be between 1 and 2000 characters."],
    [{ body: "x".repeat(GC_FREE_MESSAGE_MAX + 1) }, "Message body must be between 1 and 2000 characters."],
    [{ body: "ok", clientMessageId: "short" }, "Client message id must be between 8 and 64 characters."],
    [{ body: "ok", clientMessageId: "x".repeat(65) }, "Client message id must be between 8 and 64 characters."],
  ];
  for (const [payload, expected] of cases) {
    const db = fakeDb([
      sessionRoute(row),
      { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    ]);
    const response = await dispatch(
      postJson(`/api/channels/${CHANNEL_ID}/messages`, payload, headers),
      envWithLimiters({ GOOBER_DB: db }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), { error: expected });
    assert.deepEqual(db.calls.filter((call) => call.call === "batch" || call.call === "run"), []);
  }
});

// --- the 0021 body tiers: free 2000, plus 4000 -------------------------------------

// The gc_plus_state term read rides the send/edit admission now; a route on
// its SQL decides the tier (unmatched reads as free, like a member with no
// row).
const PLUS_TERM_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const plusTermRoute = (renewsUntil) => ({
  test: PLUS_TERM_TEST,
  first: async () => (renewsUntil === null ? null : { renews_until: renewsUntil }),
});
const ACTIVE_PLUS = () => nowSeconds() + 3600;
const LAPSED_PLUS = () => nowSeconds() - 10;

const SEND_ROUTES = [
  { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
];

async function sendBody(routes, body) {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  return dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body }, headers),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute(row), plusTermRoute(null), ...routes]) }),
  );
}

test("0021: a free member sends exactly 2000 and 2001 refuses with the free copy", async () => {
  const admitted = await sendBody(
    [...SEND_ROUTES, {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({
        meta: { changes: 1, last_row_id: 14 },
        results: [messageRow({ id: 14, body: "y".repeat(GC_FREE_MESSAGE_MAX) })],
      }),
    }],
    "y".repeat(GC_FREE_MESSAGE_MAX),
  );
  assert.equal(admitted.status, 201);

  const refused = await sendBody([...SEND_ROUTES], "z".repeat(GC_FREE_MESSAGE_MAX + 1));
  assert.equal(refused.status, 400);
  assert.deepEqual(await bodyOf(refused), {
    error: "Message body must be between 1 and 2000 characters.",
  });
});

test("0021: a plus member sends past 2000 and beyond 4000 refuses with the plus copy", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const base = [sessionRoute(row), plusTermRoute(ACTIVE_PLUS()), ...SEND_ROUTES];
  const admittedDb = fakeDb([...base, {
    test: MESSAGE_RESELECT_TEST,
    run: async () => ({
      meta: { changes: 1, last_row_id: 15 },
      results: [messageRow({ id: 15, body: "p".repeat(3500) })],
    }),
  }]);
  const admitted = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "p".repeat(3500) }, headers),
    envWithLimiters({ GOOBER_DB: admittedDb }),
  );
  assert.equal(admitted.status, 201);

  _resetFilterWordsCacheForTests();
  const refused = await dispatch(
    postJson(`/api/channels/${CHANNEL_ID}/messages`, { body: "p".repeat(GC_PLUS_MESSAGE_MAX + 1) }, headers),
    envWithLimiters({ GOOBER_DB: fakeDb([...base]) }),
  );
  assert.equal(refused.status, 400);
  assert.deepEqual(await bodyOf(refused), {
    error: "Message body must be between 1 and 4000 characters.",
  });
});

test("the edit lane tiers identically: plus admits a 3500-char save, grace stays free", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();

  const plusDb = fakeDb([
    sessionRoute(row),
    plusTermRoute(ACTIVE_PLUS()),
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    { test: EDIT_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: MESSAGE_BY_ID_TEST, first: async () => messageRow({ id: 5, body: "w".repeat(3500), edited_at: 999 }) },
  ]);
  const plusResponse = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "w".repeat(3500) }, headers),
    envWithLimiters({ GOOBER_DB: plusDb }),
  );
  assert.equal(plusResponse.status, 200);
  const update = plusDb.calls.find((call) => EDIT_UPDATE_TEST(call.sql));
  assert.equal(update.bound[0].length, 3500);

  _resetFilterWordsCacheForTests();
  const graceDb = fakeDb([sessionRoute(row), plusTermRoute(LAPSED_PLUS())]);
  const graceResponse = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "w".repeat(2001) }, headers),
    envWithLimiters({ GOOBER_DB: graceDb }),
  );
  assert.equal(graceResponse.status, 400);
  assert.deepEqual(await bodyOf(graceResponse), {
    error: "Message body must be between 1 and 2000 characters.",
  });
  assert.deepEqual(graceDb.calls.filter((call) => EDIT_UPDATE_TEST(call.sql)), [],
    "a lapsed member's over-bound edit never reaches the UPDATE");
});

// The shared primitive, exercised directly: Task 8's Durable Object calls
// sendMessageToChannel(env, user, channelId, body, clientMessageId) with no
// HTTP route in between (channel access is the CALLER's contract there).
test("sendMessageToChannel is callable without a request and keys a null client id on IS NULL", async () => {
  _resetFilterWordsCacheForTests();
  const user = { id: USER_ID, username: "wempos", role: "member" };
  const db = fakeDb([
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({
        meta: { changes: 1, last_row_id: 13 },
        results: [messageRow({ id: 13, body: "primitive hello" })],
      }),
    },
  ]);
  const { message, created } = await sendMessageToChannel(
    { GOOBER_DB: db },
    user,
    CHANNEL_ID,
    "primitive hello",
    null,
  );
  assert.equal(created, true);
  assert.equal(message.id, 13);

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements[0].bound[3], null); // the insert's client id
  assert.match(
    batch.statements[2].sql,
    /client_message_id IS NULL ORDER BY m\.id DESC LIMIT 1$/,
  );
});

// --- PATCH /api/messages/:id ------------------------------------------------------

test("(d) editing by a non-author is a 404, not a 403", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    // The author-guarded UPDATE matches nothing.
    { test: EDIT_UPDATE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "hijack" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "Message not found." });
  // The failure was read AFTER the guarded UPDATE (which alone carried the
  // authorization); no follow-up row read was ever bound.
  assert.deepEqual(db.calls.filter((call) => MESSAGE_BY_ID_TEST(call.sql)), []);
});

test("the author's edit re-filters, sets edited_at, and returns the fresh row", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const edited = messageRow({ id: 5, body: "edited text", edited_at: 999 });
  const db = fakeDb([
    sessionRoute(row),
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    { test: EDIT_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: MESSAGE_BY_ID_TEST, first: async () => edited },
    { test: ATTACH_ONE_TEST, all: async () => ({ results: [{ id: 30, message_id: 5 }] }) },
  ]);
  const response = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "edited text" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { message: publicMessageShape(edited, [30]) });

  const update = db.calls.find((call) => EDIT_UPDATE_TEST(call.sql));
  assert.ok(update);
  // The author guard rides INSIDE the UPDATE (no read-then-write gate);
  // edited_at is a server clock value, never client data.
  assert.equal(update.bound[0], "edited text");
  assert.equal(typeof update.bound[1], "number");
  assert.equal(update.bound[2], 5);
  assert.equal(update.bound[3], USER_ID);
});

test("a filtered word rejects the edit with 400 before the UPDATE runs", async () => {
  _resetFilterWordsCacheForTests();
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "badword", updated_at: 1 }) },
  ]);
  const response = await dispatch(
    jsonRequest("PATCH", "/api/messages/5", { body: "sneaky badword" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That message isn't allowed." });
  assert.deepEqual(db.calls.filter((call) => EDIT_UPDATE_TEST(call.sql)), []);
});

// --- DELETE /api/messages/:id ------------------------------------------------------

test("(f) platform staff can delete a message from a server they never joined", async () => {
  const { row, headers } = await sessionFixtures("admin"); // stored 'admin' → public 'owner'
  const db = fakeDb([
    sessionRoute(row),
    { test: DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    jsonRequest("DELETE", "/api/messages/5", undefined, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  // The whole delete is ONE batch (message + its attachments) — no stray run.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
  const deletion = batch.statements.find((statement) => DELETE_TEST(statement.sql));
  assert.ok(deletion);
  // The three-tier guard rides INSIDE the DELETE: author OR server
  // owner/moderator OR platform staff. The staff tier is a bound JS-side flag
  // derived from the session's PUBLIC role — never request data.
  assert.match(
    deletion.sql,
    /^DELETE FROM gc_messages WHERE id = \? AND \(author_id = \? OR EXISTS \(SELECT 1 FROM gc_channels c JOIN gc_server_members sm ON sm\.server_id = c\.server_id WHERE c\.id = gc_messages\.channel_id AND sm\.user_id = \? AND sm\.role IN \('owner','moderator'\)\) OR \? = 1\)$/,
  );
  assert.deepEqual(deletion.bound, [5, USER_ID, USER_ID, 1]);
});

test("the author deletes their own message; a zero-change delete is a 404", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    // A plain member IS the author here, so the staff flag binds 0 and the
    // DELETE still applies.
    { test: DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    jsonRequest("DELETE", "/api/messages/5", undefined, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  // A non-author plain member on someone else's message: no author match, no
  // staff flag, no membership, so the guarded DELETE changes nothing → 404.
  const miss = fakeDb([
    sessionRoute(row),
    { test: DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const notFound = await dispatch(
    jsonRequest("DELETE", "/api/messages/5", undefined, headers),
    envWithLimiters({ GOOBER_DB: miss }),
  );
  assert.equal(notFound.status, 404);
  assert.deepEqual(await bodyOf(notFound), { error: "Message not found." });
});

test("(6f) history returns attachmentIds for approved rows and the viewer's own pending", async () => {
  const { row, headers } = await sessionFixtures();
  const rows = [messageRow({ id: 5 })];
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 1, kind: "text" }) },
    { test: MESSAGES_PAGE_TEST, all: async () => ({ results: rows }) },
    {
      test: ATTACH_PAGE_TEST,
      all: async () => ({
        results: [
          { id: 21, message_id: 5 }, // whatever the gated SQL returned
          { id: 22, message_id: 5 },
        ],
      }),
    },
  ]);
  const response = await dispatch(
    get(`/api/channels/${CHANNEL_ID}/messages`, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await bodyOf(response)).messages[0].attachmentIds, [21, 22]);

  // The gate itself rides the lookup: approved OR the uploader, with the
  // viewer's id bound first, then the page's message ids.
  const lookup = db.calls.find((call) => ATTACH_PAGE_TEST(call.sql));
  assert.match(
    lookup.sql,
    /WHERE \(status = 'approved' OR uploader_id = \?\) AND message_id IN \(.*\) ORDER BY id$/,
  );
  assert.equal(lookup.bound[0], USER_ID);
});

// Task 6 (review directive from Task 5): gc_attachments.message_id carries no
// ON DELETE action, so a message with an attachment would 500 on the message
// DELETE. The cleanup now rides the SAME guarded batch, ordered chunks →
// attachments → message, each delete carrying the three-tier guard itself.
test("a deleted message takes its attachment chunks and rows with it in the same batch", async () => {
  const { row, headers } = await sessionFixtures(); // the author, staff flag 0
  const db = fakeDb([
    sessionRoute(row),
    { test: DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    jsonRequest("DELETE", "/api/messages/5", undefined, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 3);
  const [chunksDelete, attachmentsDelete, messageDelete] = batch.statements;

  // Chunks first (the FK on chunks allows them to die while the attachment
  // row still stands), each delete GUARDED by the same tier logic the message
  // DELETE itself uses — an unauthorized viewer can never strip a message's
  // attachments with a doomed delete request.
  assert.match(
    chunksDelete.sql,
    /^DELETE FROM gc_attachment_chunks WHERE attachment_id IN \(SELECT a\.id FROM gc_attachments a WHERE a\.message_id = \? AND \(EXISTS \(SELECT 1 FROM gc_messages m WHERE m\.id = a\.message_id AND m\.author_id = \?\) OR EXISTS \(SELECT 1 FROM gc_channels c JOIN gc_server_members sm ON sm\.server_id = c\.server_id WHERE c\.id = \(SELECT m2\.channel_id FROM gc_messages m2 WHERE m2\.id = \?\) AND sm\.user_id = \? AND sm\.role IN \('owner','moderator'\)\) OR \? = 1\)\)$/,
  );
  assert.match(
    attachmentsDelete.sql,
    /^DELETE FROM gc_attachments WHERE message_id = \? AND \(EXISTS \(SELECT 1 FROM gc_messages m WHERE m\.id = gc_attachments\.message_id AND m\.author_id = \?\) OR EXISTS \(SELECT 1 FROM gc_channels c JOIN gc_server_members sm ON sm\.server_id = c\.server_id WHERE c\.id = \(SELECT m2\.channel_id FROM gc_messages m2 WHERE m2\.id = \?\) AND sm\.user_id = \? AND sm\.role IN \('owner','moderator'\)\) OR \? = 1\)$/,
  );
  // Binds: the message id, then the author tier, the moderator tier, and the
  // staff flag — the SAME values the message DELETE binds.
  assert.deepEqual(chunksDelete.bound, [5, USER_ID, 5, USER_ID, 0]);
  assert.deepEqual(attachmentsDelete.bound, [5, USER_ID, 5, USER_ID, 0]);
  assert.deepEqual(messageDelete.bound, [5, USER_ID, USER_ID, 0]);
});

test("a viewer with no tier's authorization destroys nothing when their delete fails", async () => {
  const { row, headers } = await sessionFixtures(); // a plain member, staff flag 0
  const db = fakeDb([
    sessionRoute(row),
    { test: DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    jsonRequest("DELETE", "/api/messages/5", undefined, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "Message not found." });
  // The batch still ran (that is what a batch is), but every statement in it
  // carries the tier guard, so in real D1 the 404 path can only ever have
  // matched zero rows there too.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  for (const statement of batch.statements.slice(0, 2)) {
    assert.match(statement.sql, /author_id = \?/);
    assert.match(statement.sql, /OR \? = 1\)\)?$/);
    assert.equal(statement.bound[4], 0);
  }
});

// Task 6 (read-time gating): the history's attachment lookup returns approved
// rows PLUS the viewer's own pending ones — the predicate lives in the SQL.
// (Tested in the history section above: test "(6f)".)

// --- real-SQLite reselect regression (review round 1) ------------------------------

// The send's triple reselect is an SQL subselect the fake DB cannot execute:
// with a NULL client id a no-ORDER-BY reselect resolves the channel's OLDEST
// NULL-cid row instead of the row the batch just inserted. This mini-harness
// runs the primitive's ACTUAL statements in real SQLite (same D1-shaped
// adapter conventions as media-module.test.mjs).
test("real-SQLite: a plain send with no client id echoes the row just sent", async () => {
  _resetFilterWordsCacheForTests();
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, accent_color TEXT);
    INSERT INTO users (id, username, role) VALUES (${USER_ID}, 'wempos', 'member');

    CREATE TABLE gc_plus_state (user_id INTEGER PRIMARY KEY, renews_until INTEGER NOT NULL);
    CREATE TABLE site_settings (key TEXT, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO site_settings (key, value, updated_at) VALUES ('filtered_words', '', 1);

    CREATE TABLE gc_channels (id INTEGER PRIMARY KEY, server_id INTEGER NULL, kind TEXT NULL, slowmode_seconds INTEGER NOT NULL DEFAULT 0, last_message_id INTEGER, last_message_at INTEGER);
    INSERT INTO gc_channels (id) VALUES (${CHANNEL_ID});

    CREATE TABLE gc_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL, author_id INTEGER NOT NULL,
      body TEXT NOT NULL, client_message_id TEXT, source TEXT,
      created_at INTEGER NOT NULL, edited_at INTEGER,
      UNIQUE(channel_id, author_id, client_message_id));

    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NULL REFERENCES gc_messages(id),
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      width INTEGER NULL, height INTEGER NULL,
      created_at INTEGER NOT NULL, reviewed_by INTEGER NULL, reviewed_at INTEGER NULL);

    CREATE TABLE gc_attachment_chunks (
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000),
      PRIMARY KEY(attachment_id, seq));
  `);
  const env = {
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
            if (/^SELECT/i.test(sql)) {
              return { meta: { changes: 0 }, results: db.prepare(sql).all(...bound) };
            }
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
  const user = { id: USER_ID, username: "wempos", role: "member" };

  const first = await sendMessageToChannel(env, user, CHANNEL_ID, "first", null);
  assert.equal(first.message.id, 1);

  const second = await sendMessageToChannel(env, user, CHANNEL_ID, "second", null);
  // The channel now holds TWO NULL-client-id rows; the primitive must echo the
  // row THE SECOND send inserted, never the oldest one below it.
  assert.equal(second.message.id, 2);
  assert.equal(second.message.body, "second");
  assert.deepEqual(second.message.attachmentIds, []);

  // Both rows exist and the channel bump tracked the newest.
  // Real SQLite rows are null-prototype objects: spread them into plain ones.
  assert.deepEqual(
    db.prepare("SELECT id, body FROM gc_messages ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: 1, body: "first" }, { id: 2, body: "second" }],
  );
  const channel = db.prepare("SELECT last_message_id FROM gc_channels WHERE id = ?").get(CHANNEL_ID);
  assert.equal(channel.last_message_id, 2);
});

// --- vendored filter parity ---------------------------------------------------------

// Ruled (same shape as GooberCord main's 027fc28): the substitution allow-
// list's project-name pair applies gate-locally — the same two named
// constants the contract-parity gate carries, each mapping the other repo's
// name into its own; the content-anchored re-aim lives in contract-parity.
test("api/filter.mjs is the forum's filter matcher verbatim after the ruled substitution", () => {
  const FORUM_PROJECT = "Wempo's Forum";
  const GOOBER_PROJECT = "GooberCord";
  const HERE = path.dirname(new URL(import.meta.url).pathname);
  const goober = readFileSync(path.resolve(HERE, "../api/filter.mjs"), "utf-8");
  const forum = readFileSync("/Users/itswempo/wempos-forum/api/filter.mjs", "utf-8")
    .replaceAll(FORUM_PROJECT, GOOBER_PROJECT);
  assert.equal(goober, forum);
});
