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

// T-R2-WIPE delete rides — CALL-SHAPE pins (the board row's three laws):
// every ride fires ONLY on its delete's own changes==1 verdict, a 0-changes
// delete fires nothing, and a best-effort ride failure never breaks the D1
// result. Five lanes, the board list verbatim: message attachments
// (messages.mjs), the channel + server shavers (servers.mjs), the
// emoji/sticker delete (emoji.mjs), the soundboard delete + intake put
// (soundboard.mjs). Fakes mirror the landed r2-binding lane: a route-
// predicate fakeDb, a Map-backed GC_MEDIA, and a waitUntil-recording ctx.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { handleMessageRoutes } from "../api/messages.mjs";
import { handleServerRoutes } from "../api/servers.mjs";
import { handleExpressionRoutes } from "../api/emoji.mjs";
import { handleSoundboardRoutes } from "../api/soundboard.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

function fakeR2({ failDeletes = false } = {}) {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async put(key, value) { objects.set(key, value); },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { body: new Response(bytes).body } : null;
    },
    async head() { return null; },
    async delete(key) {
      calls.push({ op: "delete", key });
      if (failDeletes) throw new Error("stub delete outage");
      objects.delete(key);
    },
  };
}

function fakeCtx() {
  const waits = [];
  return {
    waits,
    waitUntil(promise) {
      waits.push(promise);
      promise.then(() => {}, () => {});
    },
  };
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// A route is a predicate function: (sql) => { first|all|run } | null.
function fakeDb(routes = []) {
  const match = (sql) => {
    for (const route of routes) {
      const found = route(sql);
      if (found) return found;
    }
    return null;
  };
  return {
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        const route = match(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        const route = match(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        const route = match(sql);
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      return results;
    },
  };
}

const SESSION_SQL = "FROM sessions s LEFT JOIN users u";
const sessionRoute = (row) => (sql) =>
  sql.includes(SESSION_SQL) ? { first: async () => row } : null;

async function sessionFixtures(role = "member", userId = USER_ID) {
  const token = randomToken();
  const csrf = "csrf" + randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: userId,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role,
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_data: null,
    avatar_updated_at: null,
    avatar_version: null,
    pending_avatar_mime: null,
    pending_avatar_data: null,
    totp_enabled: 0,
  };
  return { row, headers: {
    Origin: ORIGIN,
    Cookie: "__Host-goober_session=" + token,
    "X-CSRF-Token": csrf,
  } };
}

const envFor = (row, routes, bucket) => envWithLimiters({
  GOOBER_DB: fakeDb([sessionRoute(row), ...routes]),
  GC_MEDIA: bucket,
});

async function dispatch(routeFn, request, env, ctx, method = "DELETE") {
  const url = new URL(request.url);
  try {
    return await routeFn(request, env, url, url.pathname, method, ctx);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(error.payload || { error: error.message }, error.status, error.headers);
  }
}

async function settle(waits) {
  await Promise.all(waits.map((wait) => new Promise((resolve) => wait.then(resolve, resolve))));
}

// --- messages -----------------------------------------------------------------------

test("message delete rides the R2 object deletes through ctx, only on changes==1", async () => {
  const { row, headers } = await sessionFixtures();
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, [
    (sql) => (sql.includes("SELECT id FROM gc_attachments WHERE message_id = ?")
      ? { all: async () => ({ results: [{ id: 22 }, { id: 23 }] }) } : null),
  ], bucket);

  const response = await dispatch(handleMessageRoutes,
    new Request(ORIGIN + "/api/messages/101", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200, "the D1 delete stands");
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [
    { op: "delete", key: "gc-attachments/22" },
    { op: "delete", key: "gc-attachments/23" },
  ]);
});

test("a 0-changes message delete (404) fires no R2 ride", async () => {
  const { row, headers } = await sessionFixtures();
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, [
    (sql) => (sql.includes("SELECT id FROM gc_attachments WHERE message_id = ?")
      ? { all: async () => ({ results: [{ id: 22 }] }) } : null),
    (sql) => (sql.startsWith("DELETE FROM gc_messages") ? { run: async () => ({ meta: { changes: 0 } }) } : null),
  ], bucket);

  const response = await dispatch(handleMessageRoutes,
    new Request(ORIGIN + "/api/messages/101", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 404);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [], "nothing doomed, nothing rode");
});

test("a failed R2 ride never breaks the message delete result", async () => {
  const { row, headers } = await sessionFixtures();
  const bucket = fakeR2({ failDeletes: true });
  const ctx = fakeCtx();
  const env = envFor(row, [
    (sql) => (sql.includes("SELECT id FROM gc_attachments WHERE message_id = ?")
      ? { all: async () => ({ results: [{ id: 22 }] }) } : null),
  ], bucket);

  const response = await dispatch(handleMessageRoutes,
    new Request(ORIGIN + "/api/messages/101", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200, "the D1 truth delete stands through the outage");
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [{ op: "delete", key: "gc-attachments/22" }]);
});

// --- channel + server shavers ---------------------------------------------------------

const channelDoomed = [{ id: 44 }];

const channelRoutes = (doomedIds) => [
  (sql) => (
    sql.includes("FROM gc_attachments a WHERE a.message_id IN (SELECT id FROM gc_messages WHERE channel_id = ?)") &&
    !sql.includes("server_id")
  ) ? { all: async () => ({ results: doomedIds }) } : null,
];

test("channel delete rides its attachments' objects through ctx", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, channelRoutes(channelDoomed), bucket);

  const response = await dispatch(handleServerRoutes,
    new Request(ORIGIN + "/api/servers/2/channels/30", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [{ op: "delete", key: "gc-attachments/44" }]);
});

test("a 0-changes channel delete fires no ride", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, [
    ...channelRoutes(channelDoomed),
    (sql) => (sql.startsWith("DELETE FROM gc_channels WHERE id = ?") ? { run: async () => ({ meta: { changes: 0 } }) } : null),
    (sql) => (sql.startsWith("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1")
      ? { first: async () => ({ role: "owner" }) } : null),
  ], bucket);

  const response = await dispatch(handleServerRoutes,
    new Request(ORIGIN + "/api/servers/2/channels/30", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 404);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, []);
});

const serverDoomed = { emojiIds: [61], soundIds: [62], messageIds: [63] };

const serverRoutes = ({ emojiIds, soundIds, messageIds, serverChanges = 1 }) => [
  (sql) => (sql.startsWith("SELECT attachment_id FROM gc_emoji WHERE server_id = ?")
    ? { all: async () => ({ results: emojiIds.map((id) => ({ attachment_id: id })) }) } : null),
  (sql) => (sql.startsWith("SELECT attachment_id FROM gc_stickers WHERE server_id = ?")
    ? { all: async () => ({ results: [] }) } : null),
  (sql) => (sql.startsWith("SELECT attachment_id FROM gc_sounds WHERE server_id = ?")
    ? { all: async () => ({ results: soundIds.map((id) => ({ attachment_id: id })) }) } : null),
  (sql) => (
    sql.includes("WHERE a.message_id IN (SELECT id FROM gc_messages WHERE channel_id IN (SELECT id FROM gc_channels WHERE server_id = ?))") &&
    sql.startsWith("SELECT a.id")
  ) ? { all: async () => ({ results: messageIds.map((id) => ({ id })) }) } : null,
  (sql) => (sql.startsWith("DELETE FROM gc_servers WHERE id = ?")
    ? { run: async () => ({ meta: { changes: serverChanges } }) } : null),
  (sql) => (sql.startsWith("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1")
    ? { first: async () => ({ role: "owner" }) } : null),
];

test("server delete purges the doomed attachment objects beside the shaver gate", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, serverRoutes(serverDoomed), bucket);

  const response = await dispatch(handleServerRoutes,
    new Request(ORIGIN + "/api/servers/2", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [
    { op: "delete", key: "gc-attachments/61" },
    { op: "delete", key: "gc-attachments/62" },
    { op: "delete", key: "gc-attachments/63" },
  ]);
});

test("a 0-changes server delete fires no ride", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, serverRoutes({ ...serverDoomed, serverChanges: 0 }), bucket);

  const response = await dispatch(handleServerRoutes,
    new Request(ORIGIN + "/api/servers/2", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 404);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, []);
});

// --- emoji + stickers ------------------------------------------------------------------

const expressionRoutes = ({ target = 71, rowChanges = 1, attachmentChanges = 1, table = "gc_emoji" } = {}) => [
  (sql) => (sql.includes("FROM " + table + " WHERE id = ? AND server_id = ? LIMIT 1")
    ? { first: async () => ({ attachment_id: target }) } : null),
  (sql) => (sql.startsWith("DELETE FROM " + table + " WHERE id = ? AND server_id = ?")
    ? { run: async () => ({ meta: { changes: rowChanges } }) } : null),
  (sql) => (sql.startsWith("DELETE FROM gc_attachments WHERE id = ?")
    ? { run: async () => ({ meta: { changes: attachmentChanges } }) } : null),
];

test("emoji delete rides the object only when the attachment row itself died", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, expressionRoutes(), bucket);
  const response = await dispatch(handleExpressionRoutes,
    new Request(ORIGIN + "/api/servers/2/emojis/5", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [{ op: "delete", key: "gc-attachments/71" }]);

  // shared: the attachment row kept its sibling, its changes stayed 0 → no ride
  const sharedBucket = fakeR2();
  const sharedCtx = fakeCtx();
  const sharedEnv = envFor(row, expressionRoutes({ attachmentChanges: 0 }), sharedBucket);
  const sharedResponse = await dispatch(handleExpressionRoutes,
    new Request(ORIGIN + "/api/servers/2/emojis/5", { method: "DELETE", headers }),
    sharedEnv, sharedCtx);
  assert.equal(sharedResponse.status, 200);
  await settle(sharedCtx.waits);
  assert.deepEqual(sharedBucket.calls, []);
});

test("sticker delete rides through the same lane", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, expressionRoutes({ table: "gc_stickers" }), bucket);
  const response = await dispatch(handleExpressionRoutes,
    new Request(ORIGIN + "/api/servers/2/stickers/5", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [{ op: "delete", key: "gc-attachments/71" }]);
});

test("a failed R2 ride never breaks the emoji delete result", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2({ failDeletes: true });
  const ctx = fakeCtx();
  const env = envFor(row, expressionRoutes(), bucket);
  const response = await dispatch(handleExpressionRoutes,
    new Request(ORIGIN + "/api/servers/2/emojis/5", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200, "the D1 truth delete stands through the outage");
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [{ op: "delete", key: "gc-attachments/71" }],
    "the ride fired; its miss was logged, not raised");
});

// --- soundboard -----------------------------------------------------------------------

const soundRoutes = (attachmentChanges) => [
  (sql) => (sql.includes("FROM gc_sounds WHERE id = ? AND server_id = ? LIMIT 1")
    ? { first: async () => ({ attachment_id: 81 }) } : null),
  (sql) => (sql.startsWith("DELETE FROM gc_attachments WHERE id = ?")
    ? { run: async () => ({ meta: { changes: attachmentChanges } }) } : null),
];

test("soundboard delete rides the object only when the attachment row died", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, soundRoutes(1), bucket);
  const response = await dispatch(handleSoundboardRoutes,
    new Request(ORIGIN + "/api/servers/2/sounds/5", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, [{ op: "delete", key: "gc-attachments/81" }]);
});

test("a soundboard delete whose attachment kept a sibling fires no ride", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const bucket = fakeR2();
  const ctx = fakeCtx();
  const env = envFor(row, soundRoutes(0), bucket);
  const response = await dispatch(handleSoundboardRoutes,
    new Request(ORIGIN + "/api/servers/2/sounds/5", { method: "DELETE", headers }), env, ctx);
  assert.equal(response.status, 200);
  await settle(ctx.waits);
  assert.deepEqual(bucket.calls, []);
});

// --- soundboard intake put --------------------------------------------------------------

test("soundboard intake: the multipart create rides the R2 put and the delete rides the wipe", async () => {
  const soundboard = readFileSync(fileURLToPath(new URL("../api/soundboard.mjs", import.meta.url)), "utf8");
  assert.match(soundboard, /deleteAttachmentObject,\n  exportAttachmentObject,/);
  assert.match(soundboard, /await exportAttachmentObject\(env, ctx, id, prepared\.bytes\);/);
  assert.match(soundboard, /createSoundAttachment\(env, actorId, files\[0\], ctx\)/);
  assert.match(soundboard, /Number\(results\[2\]\?\.meta\?\.changes\) === 1/);
  assert.match(soundboard, /await deleteAttachmentObject\(env, ctx, Number\(target\.attachment_id\)\)/);
});
