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

// The channel/server purge R2 rides + orphan sweeps (lane-r2-sweep): a
// channel's or a server's doomed gc_attachments rows must drag their
// GC_MEDIA objects with them (the bucket follows the guarded batch's
// verdict, never leads), and the sweep-needed orphan tables (gc_bookmarks,
// the welcome card pair, the reaction-tag pair — none of which carry a
// CASCADE FK to their doomed parents, see tests/r2-sweep-fk-pins.test.mjs)
// ride the same guarded batch. Same fake conventions as
// tests/server-delete.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { json } from "../api/core/http.mjs";
import { handleServerRoutes } from "../api/servers.mjs";
import { GC_ATTACHMENT_OBJECT_PREFIX, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const ACTOR = 7;
const SERVER_ID = 91;
const CHANNEL_ID = 55;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const CHANNEL_ROW_TEST = (sql) => sql.startsWith("DELETE FROM gc_channels");
const GUARD_TEST = (sql) => sql.includes("om.role = 'owner'");
const SERVER_ROW_TEST = (sql) => sql.startsWith("DELETE FROM gc_servers");
const SERVER_DOOMED_IDS_TEST = (sql) =>
  sql.startsWith("SELECT a.id FROM gc_attachments a") &&
  sql.includes("gc_channels WHERE server_id = ?");
const CHANNEL_DOOMED_IDS_TEST = (sql) =>
  sql.startsWith("SELECT id FROM gc_attachments WHERE message_id IN");
const CHANNEL_BOOKMARKS_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_bookmarks WHERE message_id IN") && sql.includes("channel_id = ?");
const SERVER_BOOKMARKS_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_bookmarks") && sql.includes("gc_channels WHERE server_id = ?");
const WELCOME_CARDS_TEST = (sql) => sql.startsWith("DELETE FROM gc_welcome_cards");
const WELCOME_VIEWS_TEST = (sql) => sql.startsWith("DELETE FROM gc_welcome_card_views");
const REACTION_TAGS_TEST = (sql) => sql.startsWith("DELETE FROM gc_server_reaction_tags");
const REACTION_OPTS_TEST = (sql) => sql.startsWith("DELETE FROM gc_reaction_tag_opts");
const EXPRESSION_SURVIVOR_TEST = (sql) =>
  sql.includes("UNION SELECT attachment_id FROM gc_stickers");
const ICON_SURVIVOR_TEST = (sql) =>
  sql.includes("SELECT icon_media_id FROM gc_servers WHERE icon_media_id = ?");

async function sessionFixtures(role = "owner") {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: ACTOR,
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
    row,
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf, Origin: ORIGIN },
  };
}

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

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
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        const route = find(sql);
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  try {
    return await handleServerRoutes(request, env, url, url.pathname, request.method, ctx);
  } catch (error) {
    if (error?.status) {
      return json(error.payload || { error: error.message }, error.status, error.headers);
    }
    throw error;
  }
}

function fakeR2() {
  const calls = [];
  return {
    calls,
    async delete(key) {
      calls.push({ op: "delete", key });
      return true;
    },
  };
}

function fakeCtx() {
  const ctx = {
    tasks: [],
    waitUntil(promise) {
      ctx.tasks.push(Promise.resolve(promise).catch(() => {}));
    },
  };
  return ctx;
}

async function settled(ctx) {
  for (const task of ctx.tasks) await task;
}

async function buildEnv(routes, r2) {
  const env = { GOOBER_DB: fakeDb(routes), ...(r2 ? { GC_MEDIA: r2 } : {}) };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function deleteChannel(routes, { r2 = null, ctx = null, role = "owner" } = {}) {
  const { row, headers } = await sessionFixtures(role);
  const request = new Request(
    ORIGIN + `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`,
    { method: "DELETE", headers },
  );
  const env = await buildEnv([sessionRoute(row), ...routes], r2);
  return { response: await dispatch(request, env, ctx), env };
}

async function deleteServer(routes, { r2 = null, ctx = null, role = "owner" } = {}) {
  const { row, headers } = await sessionFixtures(role);
  const request = new Request(ORIGIN + "/api/servers/" + SERVER_ID, { method: "DELETE", headers });
  const env = await buildEnv([sessionRoute(row), ...routes], r2);
  return { response: await dispatch(request, env, ctx), env };
}

const changesRoute = (testFn, changes) => ({ test: testFn, run: async () => ({ meta: { changes } }) });
const ALL_CHANGES_1 = { test: () => true, run: async () => ({ meta: { changes: 1 } }) };
const CHANNEL_DOOMED_ROUTE = {
  test: CHANNEL_DOOMED_IDS_TEST,
  all: async () => ({ results: [{ id: 51 }, { id: 52 }, { id: 53 }] }),
};

test("a successful channel delete rides the channel's doomed attachments' R2 objects", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response, env } = await deleteChannel(
    [
      { test: (sql) => sql.includes("SELECT category_id FROM gc_channels"), first: async () => ({ category_id: null }) },
      CHANNEL_DOOMED_ROUTE,
      changesRoute(CHANNEL_ROW_TEST, 1),
    ],
    { r2, ctx },
  );

  assert.equal(response.status, 200);

  // The doomed ids ARE the pre-read's answer — the bucket follows the verdict.
  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  await settled(ctx);
  assert.deepEqual(r2.calls, [
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "51" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "52" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "53" },
  ]);
});

test("a zero-change channel delete verdict rides nothing", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteChannel(
    [
      { test: (sql) => sql.includes("SELECT category_id FROM gc_channels"), first: async () => ({ category_id: null }) },
      CHANNEL_DOOMED_ROUTE,
      changesRoute(CHANNEL_ROW_TEST, 0),
      { test: (sql) => sql.includes("SELECT role FROM gc_server_members"), first: async () => ({ role: "owner" }) },
    ],
    { r2, ctx, role: "owner" },
  );

  assert.equal(response.status, 404);
  await settled(ctx);
  assert.deepEqual(r2.calls, [], "no object death rides a zero-change verdict");
});

test("the channel delete batch sweeps the doomed bookmarks behind the shared guard", async () => {
  const { response, env } = await deleteChannel(
    [
      { test: (sql) => sql.includes("SELECT category_id FROM gc_channels"), first: async () => ({ category_id: null }) },
      ALL_CHANGES_1,
    ],
  );

  assert.equal(response.status, 200);
  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 4);
  const bookmarksDelete = batch.statements[2];
  assert.ok(CHANNEL_BOOKMARKS_TEST(bookmarksDelete.sql), "bookmarks die with the channel's messages");
  assert.ok(GUARD_TEST(bookmarksDelete.sql), "the sweep carries the shared channel-guard");
  assert.match(bookmarksDelete.sql, /DELETE FROM gc_bookmarks WHERE message_id IN \(SELECT id FROM gc_messages WHERE channel_id = \?\) AND /);
  assert.ok(CHANNEL_ROW_TEST(batch.statements[3].sql), "the channel DELETE stays last (its cascade takes the messages)");

  // Each sweep statement bound the channel id first (the pre-clean's scope).
  assert.deepEqual(batch.statements[2].bound[0], CHANNEL_ID);
});

// The full server shape, exercised for the ride pins: the doomed-ids
// pre-reads answer (emoji 81/82, sticker 83, icon 57, messages 61/62), the
// verdict row is changes-1, and the post-batch survivor read answers a live
// cross-server referencer for attachment 81 (exactly 81's object survives).
const SERVER_PRE_READS = [
  { test: (sql) => sql.includes("SELECT attachment_id FROM gc_emoji WHERE server_id = ?"), all: async () => ({ results: [{ attachment_id: 81 }, { attachment_id: 82 }] }) },
  { test: (sql) => sql.includes("SELECT attachment_id FROM gc_stickers WHERE server_id = ?"), all: async () => ({ results: [{ attachment_id: 83 }] }) },
  { test: (sql) => sql.includes("SELECT attachment_id FROM gc_sounds WHERE server_id = ?"), all: async () => ({ results: [] }) },
  { test: (sql) => sql.includes("SELECT icon_media_id FROM gc_servers WHERE id = ?"), first: async () => ({ icon_media_id: 57 }) },
  { test: SERVER_DOOMED_IDS_TEST, all: async () => ({ results: [{ id: 61 }, { id: 62 }] }) },
];

test("a successful server delete rides the doomed ids' R2 objects minus the survivors", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteServer(
    [
      { test: EXPRESSION_SURVIVOR_TEST, all: async () => ({ results: [{ attachment_id: 81 }] }) },
      { test: ICON_SURVIVOR_TEST, all: async () => ({ results: [] }) },
      ...SERVER_PRE_READS,
      ALL_CHANGES_1,
    ],
    { r2, ctx },
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).deleted.servers, 1);

  await settled(ctx);
  // The dead bucket set (the doomed list's own order: expressions, then the
  // icon, then the message attachments): 82/83, 57, 61/62 — every doomed id
  // but survivor 81.
  assert.deepEqual(r2.calls, [
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "82" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "83" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "57" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "61" },
    { op: "delete", key: GC_ATTACHMENT_OBJECT_PREFIX + "62" },
  ]);
});

test("a shared icon keeps its object (the NOT EXISTS survivor law)", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteServer(
    [
      { test: EXPRESSION_SURVIVOR_TEST, all: async () => ({ results: [] }) },
      { test: ICON_SURVIVOR_TEST, all: async () => ({ results: [{ icon_media_id: 57 }] }) },
      ...SERVER_PRE_READS,
      ALL_CHANGES_1,
    ],
    { r2, ctx },
  );

  assert.equal(response.status, 200);
  await settled(ctx);
  assert.deepEqual(
    r2.calls.filter((call) => call.key === GC_ATTACHMENT_OBJECT_PREFIX + "57"),
    [],
    "another server still pointing keeps the icon's bytes",
  );
});

test("a zero-change server delete verdict rides nothing", async () => {
  const r2 = fakeR2();
  const ctx = fakeCtx();
  const { response } = await deleteServer(
    [
      ...SERVER_PRE_READS,
      changesRoute(SERVER_ROW_TEST, 0),
      { test: (sql) => sql.includes("SELECT role FROM gc_server_members"), first: async () => ({ role: "member" }) },
    ],
    { r2, ctx, role: "member" },
  );

  assert.equal(response.status, 403);
  await settled(ctx);
  assert.deepEqual(r2.calls, [], "the 403 path stripped nothing, rode nothing");
});

test("the server delete batch sweeps bookmarks, welcome cards, views and the reaction-tag pair", async () => {
  const { response, env } = await deleteServer(SERVER_PRE_READS, {});

  assert.equal(response.status, 200);
  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  assert.ok(batch);

  const bookmarks = batch.statements.find((statement) => SERVER_BOOKMARKS_TEST(statement.sql));
  assert.ok(bookmarks, "the server's doomed messages' bookmarks die with it");
  assert.ok(GUARD_TEST(bookmarks.sql), "the bookmarks sweep carries the shared owner-exist guard");
  assert.match(bookmarks.sql, /DELETE FROM gc_bookmarks WHERE message_id IN \(SELECT id FROM gc_messages WHERE channel_id IN \(SELECT id FROM gc_channels WHERE server_id = \?\)\) AND /);

  for (const [testFn, label] of [
    [WELCOME_VIEWS_TEST, "welcome card views"],
    [WELCOME_CARDS_TEST, "welcome cards"],
    [REACTION_OPTS_TEST, "reaction tag opts"],
    [REACTION_TAGS_TEST, "reaction tags"],
  ]) {
    const statement = batch.statements.find((candidate) => testFn(candidate.sql));
    assert.ok(statement, `the server's ${label} rows die with it`);
    assert.ok(GUARD_TEST(statement.sql), `the ${label} sweep carries the shared owner-exist guard`);
  }

  // The opts rows die BEFORE their tag rows (an opts→tag FK would RESTRICT).
  assert.ok(batch.statements.findIndex((s) => REACTION_OPTS_TEST(s.sql)) <
    batch.statements.findIndex((s) => REACTION_TAGS_TEST(s.sql)));
});
