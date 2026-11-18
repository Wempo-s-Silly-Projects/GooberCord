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

// SHAVERS 2: the group-DM management routes (rename + icon on the channel
// PATCH, the members subresource, and the single-conversation read). Same
// fakeDb + pinned-SQL style as the channel-lifecycle tests: membership rides
// INSIDE the statement (outsiders are 404, never a 403 existence oracle), dm
// channels are excluded right beside it, and every response echoes the STORED
// row.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleConversationRoutes } from "../api/conversations.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const OTHER_ID = 9;
const GROUP_ID = 40;
const DM_ID = 44;

const ROUTE_SOURCE = readFileSync(new URL("../api/conversations.mjs", import.meta.url), "utf8");

// --- scaffolding -------------------------------------------------------------------

const SESSION_TOKEN = "A".repeat(40);
const SESSION_ROW = {
  token_hash: await sha256Hex(SESSION_TOKEN),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
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

function fakeDb(routes) {
  const calls = [];
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
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleConversationRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(
    JSON.stringify({ error: "That API endpoint does not exist." }),
    { status: 404 },
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function authed(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "__Host-goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const sessionRoute = { test: SESSION_TEST, first: async () => SESSION_ROW };

const GROUP_GATE_TEST = (sql) =>
  sql.startsWith("SELECT c.id, c.kind, c.name AS stored_name, c.icon_media_id AS icon_media_id") &&
  sql.includes("AS members");
const GROUP_GATE_ROUTE = (channel) => ({
  test: GROUP_GATE_TEST,
  first: async () => channel,
});
const GROUP_ROW = { id: GROUP_ID, kind: "group", stored_name: "group", icon_media_id: null, members: 2 };
const DM_ROW = { id: DM_ID, kind: "dm", stored_name: "dm", icon_media_id: null, members: 2 };

const LIST_READ_TEST = (sql) =>
  sql.startsWith("SELECT c.id, c.name AS stored_name, c.icon_media_id AS icon_media_id, c.kind");

// The stored-row echo read.
const CHANNEL_ECHO_TEST = (sql) =>
  sql.startsWith("SELECT id, name AS stored_name, icon_media_id AS icon_media_id, kind FROM gc_channels WHERE id = ? LIMIT 1");

const GROUP_UPDATE_TEST = (sql) => sql.startsWith("UPDATE gc_channels SET");
const MEMBERS_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_conversation_members (channel_id, user_id, last_read_message_id) SELECT *, ?, 0 WHERE")
  || (sql.startsWith("INSERT INTO gc_conversation_members") && sql.includes("SELECT ?, ?, 0 WHERE"));
const TARGET_READ_TEST = (sql) =>
  sql.startsWith("SELECT id, username") && sql.includes("FROM users WHERE id = ? LIMIT 1");
const ROSTER_IDS_TEST = (sql) =>
  sql.startsWith("SELECT user_id FROM gc_conversation_members WHERE channel_id = ?");
const BLOCKS_TEST = (sql) =>
  sql.includes("FROM blocks") && sql.includes("UNION ALL");
const MEMBER_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_conversation_members WHERE channel_id = ? AND user_id = ?") &&
  sql.includes("op.user_id = ?");
const CHANNEL_LAST_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_channels WHERE id = ? AND kind = 'group' AND NOT EXISTS");

// --- the single read (GET) ---------------------------------------------------------

test("GET /api/conversations/:cid: the member's stored view", async () => {
  const db = fakeDb([
    sessionRoute,
    // The read route's own member gate.
    {
      test: (sql) =>
        sql.startsWith("SELECT c.id, c.kind, c.name AS stored_name, c.icon_media_id AS icon_media_id") &&
        sql.includes("me.user_id = ?"),
      first: async () => ({ id: GROUP_ID, kind: "group", stored_name: "Movie night", icon_media_id: 33 }),
    },
    {
      test: (sql) => sql.startsWith("SELECT m.channel_id, m.user_id AS member_id, u.username"),
      all: async () => ({ results: [
        { channel_id: GROUP_ID, member_id: USER_ID, username: "wempos" },
        { channel_id: GROUP_ID, member_id: OTHER_ID, username: "ada" },
      ] }),
    },
  ]);
  const response = await dispatch(authed("GET", `/api/conversations/${GROUP_ID}`), envWithLimiters({ GOOBER_DB: db }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    conversation: {
      id: GROUP_ID,
      name: "Movie night",
      iconUrl: "/api/attachments/33",
      kind: "group",
      members: [
        { userId: USER_ID, username: "wempos", isPlus: false },
        { userId: OTHER_ID, username: "ada", isPlus: false },
      ],
    },
  });

  const outsider = await dispatch(
    authed("GET", "/api/conversations/999"), envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute]) }),
  );
  assert.equal(outsider.status, 404);
});

// --- rename + icon (PATCH) ----------------------------------------------------------

test("PATCH renames a group: gated read, guarded UPDATE, stored-row echo", async () => {
  const db = fakeDb([
    sessionRoute,
    GROUP_GATE_ROUTE({ ...GROUP_ROW }),
    {
      test: GROUP_UPDATE_TEST,
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      test: CHANNEL_ECHO_TEST,
      first: async () => ({ id: GROUP_ID, stored_name: "Movie night", icon_media_id: null, kind: "group" }),
    },
  ]);
  const response = await dispatch(
    authed("PATCH", `/api/conversations/${GROUP_ID}`, { name: "  Movie night  " }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    conversation: { id: GROUP_ID, name: "Movie night", kind: "group", members: 2 },
  });

  const update = db.calls.find((call) => call.call === "run" && GROUP_UPDATE_TEST(call.sql));
  // The SET builds ONLY from the name; the guard carries the group kind, the
  // server-less rider and the caller's membership INSIDE the statement.
  assert.match(update.sql, /SET name = \? WHERE id = \? AND kind = 'group' AND server_id IS NULL AND EXISTS/);
  assert.deepEqual(update.bound[0], "Movie night");
  assert.equal(update.bound[1], GROUP_ID);
});

test("PATCH: a dm is refused (400), an outsider is 404, and invalid names refuse before any write", async () => {
  const dmDb = fakeDb([sessionRoute, GROUP_GATE_ROUTE({ ...DM_ROW })]);
  const dm = await dispatch(
    authed("PATCH", `/api/conversations/${DM_ID}`, { name: "nope" }),
    envWithLimiters({ GOOBER_DB: dmDb }),
  );
  assert.equal(dm.status, 400);
  assert.equal((await bodyOf(dm)).error, "Group chats only. A dm IS its member list.");
  assert.equal(dmDb.calls.some((call) => call.call === "run"), false);

  const outsider = await dispatch(
    authed("PATCH", "/api/conversations/999", { name: "x" }),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute]) }),
  );
  assert.equal(outsider.status, 404);

  for (const name of ["", "   ", "x".repeat(101)]) {
    const db = fakeDb([sessionRoute, GROUP_GATE_ROUTE({ ...GROUP_ROW })]);
    const response = await dispatch(
      authed("PATCH", `/api/conversations/${GROUP_ID}`, { name }),
      envWithLimiters({ GOOBER_DB: db }),
    );
    assert.equal(response.status, 400, JSON.stringify(name));
    assert.equal(db.calls.some((call) => call.call === "run" && GROUP_UPDATE_TEST(call.sql)), false);
  }
});

test("PATCH with nothing to change 400s with the pinned copy", async () => {
  const db = fakeDb([sessionRoute, GROUP_GATE_ROUTE({ ...GROUP_ROW })]);
  const response = await dispatch(
    authed("PATCH", `/api/conversations/${GROUP_ID}`, {}),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "Nothing to change. Send a name or an icon.");
});

test("the icon slot only ever takes the CALLER'S OWN attachment (the guard rides the UPDATE)", async () => {
  const db = fakeDb([
    sessionRoute,
    GROUP_GATE_ROUTE({ ...GROUP_ROW }),
    { test: GROUP_UPDATE_TEST, run: () => ({ meta: { changes: 1 } }) },
    {
      test: CHANNEL_ECHO_TEST,
      first: async () => ({ id: GROUP_ID, stored_name: "group", icon_media_id: 55, kind: "group" }),
    },
  ]);
  const response = await dispatch(
    authed("PATCH", `/api/conversations/${GROUP_ID}`, { iconMediaId: 55 }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const update = db.calls.find((call) => call.call === "run" && GROUP_UPDATE_TEST(call.sql));
  // The SET builds from what was sent — with only an icon there is no name
  // clause — and the membership + uploader guards ride the WHERE.
  assert.match(update.sql, /SET icon_media_id = \? WHERE id = \? AND kind = 'group' AND server_id IS NULL AND EXISTS/);
  assert.match(update.sql, /me\.channel_id = gc_channels\.id AND me\.user_id = \?/);
  assert.match(update.sql, /EXISTS \(SELECT 1 FROM gc_attachments WHERE id = \? AND uploader_id = \?\)/);
  assert.deepEqual(update.bound, [55, GROUP_ID, USER_ID, 55, USER_ID]);
  assert.deepEqual(await bodyOf(response), {
    conversation: { id: GROUP_ID, name: null, iconUrl: "/api/attachments/55", kind: "group", members: 2 },
  });

  // An invalid (non-ownable) shape refuses before anything runs.
  const junkDb = fakeDb([sessionRoute, GROUP_GATE_ROUTE({ ...GROUP_ROW })]);
  const junk = await dispatch(
    authed("PATCH", `/api/conversations/${GROUP_ID}`, { iconMediaId: -3 }),
    envWithLimiters({ GOOBER_DB: junkDb }),
  );
  assert.equal(junk.status, 400);
  assert.equal(junkDb.calls.some((call) => call.call === "run"), false);
});

// --- the members subresource ---------------------------------------------------------

test("POST members: the guarded INSERT carries every arm, and the echo carries the badge", async () => {
  const db = fakeDb([
    sessionRoute,
    GROUP_GATE_ROUTE({ ...GROUP_ROW, members: 2 }),
    {
      test: TARGET_READ_TEST,
      first: async () => ({ id: OTHER_ID, username: "ada", is_plus: 1 }),
    },
    { test: ROSTER_IDS_TEST, all: async () => ({ results: [{ user_id: USER_ID }, { user_id: 12 }] }) },
    { test: BLOCKS_TEST, first: async () => null },
    { test: MEMBERS_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    authed("POST", `/api/conversations/${GROUP_ID}/members`, { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    member: { userId: OTHER_ID, username: "ada", isPlus: true },
  });

  const insert = db.calls.find((call) => call.call === "run" && MEMBERS_INSERT_TEST(call.sql));
  // The guard arms: group kind + server-less, caller membership, target
  // existence, the NOT-EXISTS duplicate arm.
  assert.match(insert.sql, /EXISTS \(SELECT 1 FROM gc_channels c WHERE c\.id = \? AND c\.kind = 'group' AND c\.server_id IS NULL\)/);
  assert.match(insert.sql, /EXISTS \(SELECT 1 FROM gc_conversation_members me WHERE me\.channel_id = \? AND me\.user_id = \?\)/);
  assert.match(insert.sql, /EXISTS \(SELECT 1 FROM users u WHERE u\.id = \?\)/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_conversation_members tm WHERE tm\.channel_id = \? AND tm\.user_id = \?\)/);

  // The blocks read ran from the ADDED member's seat (their id bound FIRST in
  // every pair group, against the existing roster's ids).
  const blocks = db.calls.find((call) => BLOCKS_TEST(call.sql));
  assert.equal(blocks.bound[0], OTHER_ID);
  assert.deepEqual(blocks.bound.slice(1, 3), [USER_ID, 12]);
});

test("POST members: full group 409s, a dm 400s, an outsider 404s, missing member 400s, duplicate 409s", async () => {
  const fullDb = fakeDb([sessionRoute, GROUP_GATE_ROUTE({ ...GROUP_ROW, members: 10 })]);
  const full = await dispatch(
    authed("POST", `/api/conversations/${GROUP_ID}/members`, { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: fullDb }),
  );
  assert.equal(full.status, 409);
  assert.match((await bodyOf(full)).error, /full/);

  const dmDb = fakeDb([sessionRoute, GROUP_GATE_ROUTE({ ...DM_ROW })]);
  const dm = await dispatch(
    authed("POST", `/api/conversations/${DM_ID}/members`, { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: dmDb }),
  );
  assert.equal(dm.status, 400);
  assert.equal(dmDb.calls.some((call) => call.call === "run"), false);

  const outsider = await dispatch(
    authed("POST", "/api/conversations/999/members", { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: fakeDb([sessionRoute]) }),
  );
  assert.equal(outsider.status, 404);

  const missingDb = fakeDb([
    sessionRoute,
    GROUP_GATE_ROUTE({ ...GROUP_ROW }),
    { test: TARGET_READ_TEST, first: async () => null },
  ]);
  const missing = await dispatch(
    authed("POST", `/api/conversations/${GROUP_ID}/members`, { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: missingDb }),
  );
  assert.equal(missing.status, 400);

  const dupDb = fakeDb([
    sessionRoute,
    GROUP_GATE_ROUTE({ ...GROUP_ROW }),
    { test: TARGET_READ_TEST, first: async () => ({ id: OTHER_ID, username: "ada", is_plus: 0 }) },
    { test: ROSTER_IDS_TEST, all: async () => ({ results: [{ user_id: USER_ID }] }) },
    { test: BLOCKS_TEST, first: async () => null },
    { test: MEMBERS_INSERT_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  const dup = await dispatch(
    authed("POST", `/api/conversations/${GROUP_ID}/members`, { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: dupDb }),
  );
  assert.equal(dup.status, 409);

  // A blocked pair refuses before any write.
  const blockedDb = fakeDb([
    sessionRoute,
    GROUP_GATE_ROUTE({ ...GROUP_ROW }),
    { test: TARGET_READ_TEST, first: async () => ({ id: OTHER_ID, username: "ada", is_plus: 0 }) },
    { test: ROSTER_IDS_TEST, all: async () => ({ results: [{ user_id: USER_ID }] }) },
    { test: BLOCKS_TEST, first: async () => ({ x: 1 }) },
  ]);
  const blocked = await dispatch(
    authed("POST", `/api/conversations/${GROUP_ID}/members`, { userId: OTHER_ID }),
    envWithLimiters({ GOOBER_DB: blockedDb }),
  );
  assert.equal(blocked.status, 403);
  assert.equal(blockedDb.calls.some((call) => call.call === "run"), false);
});

test("DELETE members: the member-row delete carries the caller's ownership of the action, then the last-member rule", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: MEMBER_DELETE_TEST, run: () => ({ meta: { changes: 1 } }) },
    { test: CHANNEL_LAST_DELETE_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    authed("DELETE", `/api/conversations/${GROUP_ID}/members/${OTHER_ID}`),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  const memberDelete = db.calls.find((call) => call.call === "run" && MEMBER_DELETE_TEST(call.sql));
  // The guard arms: caller membership (op.user_id), group kind, server-less.
  assert.match(memberDelete.sql, /op\.user_id = \?\)/);
  assert.match(memberDelete.sql, /c\.kind = 'group' AND c\.server_id IS NULL/);
  assert.deepEqual(memberDelete.bound, [GROUP_ID, OTHER_ID, GROUP_ID, USER_ID]);

  // The last-member rule rode the leave route's own guard.
  const last = db.calls.find((call) => call.call === "run" && CHANNEL_LAST_DELETE_TEST(call.sql));
  assert.ok(last);
  assert.deepEqual(last.bound, [GROUP_ID, GROUP_ID]);
});

test("DELETE members: zero changes is the 404 outsider shape and the channel delete never ran", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: MEMBER_DELETE_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    authed("DELETE", `/api/conversations/${GROUP_ID}/members/${OTHER_ID}`),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 404);
  assert.deepEqual((await bodyOf(response)).error, "This conversation does not exist or you cannot view it.");
  assert.equal(db.calls.some((call) => CHANNEL_LAST_DELETE_TEST(call.sql) && call.call === "run"), false);
});

// --- the list's name/icon rules ------------------------------------------------------

test("the list prefers a renamed group's stored name and grows the icon key only when set", () => {
  // Structural pins of the read-time name discriminator.
  assert.match(ROUTE_SOURCE, /function customName\(storedName, kind\)/);
  assert.match(ROUTE_SOURCE, /storedName !== kind/);
  // The name comes from the STORED column (customName), the echo's icon key
  // sits beside it, and the list SELECT carries the stored name + media id.
  assert.match(ROUTE_SOURCE, /name: customName\(row\.stored_name, row\.kind\)/);
  assert.match(ROUTE_SOURCE, /icon_media_id !== null && row\.icon_media_id !== undefined/);
  assert.match(ROUTE_SOURCE, /c\.name AS stored_name, c\.icon_media_id AS icon_media_id/);
});
