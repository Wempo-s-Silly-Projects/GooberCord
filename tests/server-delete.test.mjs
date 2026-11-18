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

// Server DELETE (the one-act shaver): the owner-only guarded teardown. The
// batch's SQL text IS the contract (every statement carries the owner
// exist-guard in its own WHERE; the FK ordering rides the statement order;
// the two icon statements answer to `NOT EXISTS (a server still pointing)`
// instead of the guard, which is why they sit AFTER the server-row delete).
// Same fake conventions as the messages module: the first matching route
// answers each statement, batch() records every statement's SQL + binds,
// and unrouted runs default to changes: 1.
import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { json } from "../api/core/http.mjs";
import { handleServerRoutes } from "../api/servers.mjs";

const ORIGIN = "http://localhost";
const ACTOR = 7;
const SERVER_ID = 91;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const EMOJI_IDS_TEST = (sql) => sql.includes("SELECT attachment_id FROM gc_emoji WHERE server_id = ?");
const STICKER_IDS_TEST = (sql) => sql.includes("SELECT attachment_id FROM gc_stickers WHERE server_id = ?");
const ICON_TEST = (sql) => sql.includes("SELECT icon_media_id FROM gc_servers WHERE id = ?");
const SERVER_ROW_TEST = (sql) => sql.startsWith("DELETE FROM gc_servers");
const GUARD_TEST = (sql) => sql.includes("om.role = 'owner'");
const ICON_CLEAN_TEST = (sql) => sql.includes("NOT EXISTS (SELECT 1 FROM gc_servers WHERE icon_media_id");

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
    // A mutating request is gated twice (assertSameOrigin + requireCsrf): the
    // browser's fetch carries the Origin header, so the fixture does too.
    headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf, Origin: ORIGIN },
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

async function dispatch(request, env) {
  const url = new URL(request.url);
  try {
    return await handleServerRoutes(request, env, url, url.pathname, request.method, undefined);
  } catch (error) {
    // The worker's apiError mapping: HttpErrors answer as their status.
    if (error?.status) {
      return json(error.payload || { error: error.message }, error.status, error.headers);
    }
    throw error;
  }
}

async function deleteServer(routes, role = "owner") {
  const { row, headers } = await sessionFixtures(role);
  const request = new Request(ORIGIN + "/api/servers/" + SERVER_ID, { method: "DELETE", headers });
  const env = { GOOBER_DB: fakeDb([sessionRoute(row), ...routes]) };
  return { response: await dispatch(request, env), env };
}

const EMPTY_RUN = { test: (sql) => !SESSION_READ_TEST(sql) && !EMOJI_IDS_TEST(sql) && !STICKER_IDS_TEST(sql), run: async () => ({ meta: { changes: 0 } }) };

// Two emoji attachments + one sticker: 81/82/83 as the batch's literal list.
const EXPRESSION_READS = [
  { test: EMOJI_IDS_TEST, all: async () => ({ results: [{ attachment_id: 81 }, { attachment_id: 82 }] }) },
  { test: STICKER_IDS_TEST, all: async () => ({ results: [{ attachment_id: 83 }] }) },
];
const ICON_READ = { test: ICON_TEST, first: async () => ({ icon_media_id: 57 }) };

test("the owner's delete strips the whole server in one batch and counts its tables", async () => {
  const { response, env } = await deleteServer([
    ...EXPRESSION_READS,
    ICON_READ,
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id IN (SELECT"), run: async () => ({ meta: { changes: 6 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachments WHERE message_id IN (SELECT"), run: async () => ({ meta: { changes: 3 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id IN (?, ?, ?)"), run: async () => ({ meta: { changes: 30 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_emoji WHERE server_id = ?"), run: async () => ({ meta: { changes: 2 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_stickers WHERE server_id = ?"), run: async () => ({ meta: { changes: 1 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachments WHERE id IN (?, ?, ?)"), run: async () => ({ meta: { changes: 3 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_member_roles"), run: async () => ({ meta: { changes: 4 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_roles"), run: async () => ({ meta: { changes: 5 } }) },
    { test: SERVER_ROW_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id = ?"), run: async () => ({ meta: { changes: 3 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachments WHERE id = ? AND message_id IS NULL"), run: async () => ({ meta: { changes: 1 } }) },
  ]);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    deleted: {
      messageAttachmentChunks: 6,
      messageAttachments: 3,
      expressionAttachmentChunks: 30,
      emoji: 2,
      stickers: 1,
      expressionAttachments: 3,
      memberRoles: 4,
      roles: 5,
      servers: 1,
      iconAttachmentChunks: 3,
      iconAttachments: 1,
    },
  });

  // ONE batch, and the FK graph IS its statement order: attachments before
  // the expression rows (RESTRICT), roles before the server row, the server
  // row before the icon statements (their NOT EXISTS has no server left to
  // point out of the dying one — only a live sharer keeps the bytes).
  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.deepEqual(env.GOOBER_DB.calls.filter((call) => call.call === "run"), []);
  const sqls = batch.statements.map((statement) => statement.sql);
  const at = (needle) => sqls.findIndex((sql) => sql.startsWith(needle));
  assert.ok(at("DELETE FROM gc_attachment_chunks") < at("DELETE FROM gc_attachments WHERE message_id"));
  assert.ok(at("DELETE FROM gc_attachments WHERE message_id") < at("DELETE FROM gc_emoji WHERE server_id"));
  assert.ok(at("DELETE FROM gc_emoji WHERE server_id") < at("DELETE FROM gc_attachments WHERE id IN"));
  assert.ok(at("DELETE FROM gc_member_roles") < at("DELETE FROM gc_roles"));
  assert.ok(at("DELETE FROM gc_roles") < at("DELETE FROM gc_servers"));
  assert.ok(at("DELETE FROM gc_servers") < sqls.findIndex((sql) => ICON_CLEAN_TEST(sql)));
  assert.deepEqual(env.GOOBER_DB.calls.filter((call) => call.call === "first"),
    [], "only the pre-reads read; the delete's verdict is the guarded statement's changes");

  // The guard rides EVERY delete's own WHERE (the doomed-delete discipline).
  assert.equal(batch.statements.filter((statement) => SERVER_ROW_TEST(statement.sql) || GUARD_TEST(statement.sql)).length,
    batch.statements.length - 2, "every statement but the two icon cleans carries the owner exist-guard");

  // The literal-id lesson: the pre-reads hand the batch every id, no
  // last_insert_rowid() anywhere in the statement text.
  assert.equal(sqls.some((sql) => sql.includes("last_insert_rowid")), false);
  const exprChunks = batch.statements.find((statement) => statement.sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id IN (?, ?, ?)"));
  assert.deepEqual(exprChunks.bound, [81, 82, 83, SERVER_ID, ACTOR],
    "the literal id list, then the owner guard's (server, actor) pair");
  const servers = batch.statements.find((statement) => SERVER_ROW_TEST(statement.sql));
  assert.equal(servers.sql, "DELETE FROM gc_servers WHERE id = ? AND EXISTS (SELECT 1 FROM gc_server_members om WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')");
  assert.deepEqual(servers.bound, [SERVER_ID, SERVER_ID, ACTOR]);
});

test("a plain member 403s and the batch strips nothing", async () => {
  const { response, env } = await deleteServer([EMPTY_RUN], "member");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "You do not have permission to do that." });
  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  // Every destructive statement answered changes: 0 through its own guard.
  assert.equal(batch.statements.length > 3, true);
  assert.deepEqual(
    batch.statements.filter((statement) => !ICON_CLEAN_TEST(statement.sql)),
    batch.statements.filter((statement) => GUARD_TEST(statement.sql)),
    "the guard text rides every doomed statement",
  );
});

test("the server's owner pointing at an unknown id 404s", async () => {
  const { response } = await deleteServer([
    // Route order matters: the membership read must answer BEFORE the
    // zero-changes catch-all sweeps the rest.
    { test: (sql) => sql.startsWith("SELECT role FROM gc_server_members"), first: async () => ({ role: "owner" }) },
    EMPTY_RUN,
  ], "owner");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "That server does not exist." });
});

test("an icon shared with another server keeps its bytes (the NOT EXISTS order)", async () => {
  const { response, env } = await deleteServer([
    ICON_READ,
    { test: SERVER_ROW_TEST, run: async () => ({ meta: { changes: 1 } }) },
    EMPTY_RUN,
  ]);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted.iconAttachmentChunks, 0);
  assert.equal(body.deleted.iconAttachments, 0);
  const batch = env.GOOBER_DB.calls.find((call) => call.call === "batch");
  const iconStmts = batch.statements.filter((statement) => statement.sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id = ?") || statement.sql.startsWith("DELETE FROM gc_attachments WHERE id = ?"));
  assert.deepEqual(iconStmts.map((statement) => statement.bound), [[57, 57], [57, 57]]);
});
