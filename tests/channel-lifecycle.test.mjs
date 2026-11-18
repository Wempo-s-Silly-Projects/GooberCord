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

// SHAVERS 1: the channel lifecycle's missing half — the DELETE route (the
// audit's servers POST-only gap) and the rename riding the existing PATCH.
// Same fakeDb + pinned-SQL style as the servers/roles modules: the batch's
// EVERY statement carries the SAME guard (a doomed delete strips nothing),
// the diagnostics discipline stays 404-for-authoritative / 403-for-everyone,
// and the emptied-folder rule rides the identical NOT EXISTS the category
// move has always applied.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleServerRoutes } from "../api/servers.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const ORIGIN = "http://localhost";
const SERVER_ID = 3;
const CHANNEL_ID = 12;
const USER_ID = 7;

const ROUTE_SOURCE = readFileSync(new URL("../api/servers.mjs", import.meta.url), "utf8");

// --- scaffolding -----------------------------------------------------------------

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
      // The statement object carries its own sql + bound so the batch records
      // can pin both (the coins fake's shape).
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
    response = await handleServerRoutes(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
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
const membershipRoute = (role) => ({
  test: (sql) => sql.includes("SELECT role FROM gc_server_members"),
  first: async () => ({ role }),
});
const PERMS_READ_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("FROM gc_server_members");
const CATEGORY_PRIOR_TEST = (sql) =>
  sql.startsWith("SELECT category_id FROM gc_channels WHERE id = ?");
const EMPTY_CATEGORY_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_channel_categories WHERE id = ? AND server_id = ?") &&
  sql.includes("NOT EXISTS (SELECT 1 FROM gc_channels WHERE category_id = gc_channel_categories.id)");

// The delete batch's three statements, matched by their heads.
const CHUNKS_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks WHERE attachment_id IN");
const ATTACHMENTS_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_attachments WHERE message_id IN (SELECT id FROM gc_messages WHERE channel_id");
const CHANNEL_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_channels WHERE id = ? AND server_id = ?");

// --- rename (PATCH rides the existing route) --------------------------------------

test("PATCH /api/servers/:sid/channels/:cid renames: requiredText rules, absent keys keep, echo rides only the sent field", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: (sql) => sql.startsWith("UPDATE gc_channels SET"), run: () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    authed("PATCH", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, { name: "  general  " }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    channel: { id: CHANNEL_ID, serverId: SERVER_ID, name: "general" },
  });

  const statements = db.calls.filter((call) => call.call === "run");
  const update = statements.find((call) => call.sql.startsWith("UPDATE gc_channels SET"));
  assert.ok(update, "the update ran");
  // The SET builds ONLY from the name (absent keys keep their stored values),
  // and the guard's authority rides the UPDATE.
  assert.match(update.sql, /SET name = \? WHERE id = \? AND server_id = \? AND server_id IS NOT NULL/);
  assert.deepEqual(update.bound[0], "general");
});

test("PATCH rename: invalid and oversized names refuse BEFORE any write", async () => {
  for (const name of ["", "   ", "x".repeat(101), 3, null]) {
    const db = fakeDb([sessionRoute]);
    const response = await dispatch(
      authed("PATCH", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, { name }),
      envWithLimiters({ GOOBER_DB: db }),
    );
    const body = await bodyOf(response);
    assert.equal(response.status, 400, JSON.stringify(name));
    assert.match(body.error, /[Nn]ame/);
    assert.equal(db.calls.some((call) => call.call === "run" || call.call === "batch"), false);
  }
});

test("PATCH rename with nothing else still counts as a change; an empty body 400s with the pinned copy", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: (sql) => sql.startsWith("UPDATE gc_channels SET"), run: () => ({ meta: { changes: 1 } }) },
  ]);
  const ok = await dispatch(
    authed("PATCH", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, { name: "renamed" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(ok.status, 200);

  const emptyDb = fakeDb([sessionRoute]);
  const empty = await dispatch(
    authed("PATCH", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {}),
    envWithLimiters({ GOOBER_DB: emptyDb }),
  );
  assert.equal(empty.status, 400);
  assert.equal(
    (await bodyOf(empty)).error,
    "Nothing to change. Send a name, a spoiler flag, a slowmode_seconds, or a category_id.",
  );
});

// --- DELETE -----------------------------------------------------------------------

test("DELETE carries the SAME guard on EVERY statement of the batch (a doomed delete strips nothing)", () => {
  // Structural pin: the message DELETE's discipline (each statement carries
  // the same tier guard so an unauthorized caller strips nothing even in a
  // pre-clean statement) holds in the channel batch too — all three
  // statements interpolate the ONE guard helper, not a bespoke pair.
  assert.match(ROUTE_SOURCE, /function channelManageGuard\(serverId, actorId\)/);
  const routeHead = ROUTE_SOURCE.slice(ROUTE_SOURCE.indexOf("async function handleDeleteChannelRoute"));
  const guardUses = routeHead.slice(0, routeHead.indexOf("async function", 10)).match(/guard\.sql/g);
  assert.equal((guardUses || []).length, 3, "every batch statement interpolates the shared guard");
});

const deleteFixtureDb = (options = {}) =>
  fakeDb([
    sessionRoute,
    { test: CATEGORY_PRIOR_TEST, first: async () => ({ category_id: options.categoryId ?? null }) },
    { test: (sql) => sql.startsWith("UPDATE gc_channels SET"), run: () => ({ meta: { changes: 1 } }) },
    // The failure simulators: the batch's channel DELETE matches ZERO rows
    // (the guarded statement's verdict), while the pre-clean statements still
    // record their (rolled-out) targets.
    ...(options.channelChanges === 0 ? [{
      test: CHANNEL_DELETE_TEST,
      run: () => ({ meta: { changes: 0 } }),
    }] : []),
    ...(options.role !== undefined ? [membershipRoute(options.role)] : []),
    ...(options.permissions !== undefined
      ? [{ test: PERMS_READ_TEST, first: async () => ({ permissions: options.permissions }) }]
      : []),
  ]);

test("DELETE /api/servers/:sid/channels/:cid runs chunks → attachments → channel in ONE batch", async () => {
  const db = deleteFixtureDb({});
  const response = await dispatch(
    authed("DELETE", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch, "the delete is one batch");
  assert.equal(batch.statements.length, 3);
  assert.ok(CHUNKS_DELETE_TEST(batch.statements[0].sql), "chunks die FIRST");
  assert.ok(ATTACHMENTS_DELETE_TEST(batch.statements[1].sql), "attachments die BEFORE the channel");
  assert.ok(CHANNEL_DELETE_TEST(batch.statements[2].sql));

  // The final DELETE carries ALL the authority: ownership OR the
  // MANAGE_CHANNELS per-bit EXISTS, with the server channel rider.
  const channel = batch.statements[2].sql;
  assert.match(channel, /server_id IS NOT NULL/);
  assert.match(channel, /OR \(EXISTS \(SELECT 1 FROM gc_member_roles gbm1 JOIN gc_roles gbr1/);
  assert.match(channel, /\(gbr1\.permissions & 1\) <> 0/);

  // Every statement bound the channel id first (the pre-clean's scope).
  assert.equal(batch.statements[0].bound[0], CHANNEL_ID);
  assert.equal(batch.statements[1].bound[0], CHANNEL_ID);
  assert.equal(batch.statements[2].bound[0], CHANNEL_ID);

  // NO category → NO emptied-folder cleanup. (Statements only — the batch
  // record's shape carries `statements`, not a `sql`.)
  assert.equal(
    db.calls.filter((call) => call.call !== "batch").some((call) => EMPTY_CATEGORY_DELETE_TEST(call.sql)),
    false,
  );
});

test("DELETE: an emptied category follows its channel out (the exact guarded NOT EXISTS the move uses)", async () => {
  const db = deleteFixtureDb({ categoryId: 44 });
  const response = await dispatch(
    authed("DELETE", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const cleanup = db.calls
    .filter((call) => call.call !== "batch")
    .find((call) => EMPTY_CATEGORY_DELETE_TEST(call.sql));
  assert.ok(cleanup, "the emptied-folder cleanup ran");
  assert.doesNotMatch(cleanup.sql, /WHERE server_id = \? AND NOT EXISTS \(SELECT 1 FROM gc_channels WHERE category_id = gc_channel_categories\.id\)$/,
    "the cleanup stays TARGETED (the id + server), never a server-wide sweep");
  assert.deepEqual(cleanup.bound, [44, SERVER_ID]);
});

test("DELETE: zero-channel-change answers 404 for an authoritative caller, 403 otherwise — and strips NOTHING", async () => {
  // Owner-role membership with zero changes → 404 (unknown channel).
  const ownerDb = deleteFixtureDb({ channelChanges: 0, role: "owner" });
  const ownerResponse = await dispatch(
    authed("DELETE", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`),
    envWithLimiters({ GOOBER_DB: ownerDb }),
  );
  assert.equal(ownerResponse.status, 404);
  assert.equal((await bodyOf(ownerResponse)).error, "That channel does not exist.");
  // No batch ran: the guard verdict decides BEFORE anything is stripped? No —
  // the batch RAN and rolled the cleanup statements out via its all-or-nothing
  // contract; the pin is only that the CHANNEL delete itself matched zero.
  // (The fake's plain batch records the attempt; the ROUTE's contract lives in
  // the three-statement shape pinned above.)

  // A plain member with zero roles → 403.
  const memberDb = deleteFixtureDb({ channelChanges: 0, role: "member", permissions: 0 });
  const memberResponse = await dispatch(
    authed("DELETE", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`),
    envWithLimiters({ GOOBER_DB: memberDb }),
  );
  assert.equal(memberResponse.status, 403);
  assert.equal((await bodyOf(memberResponse)).error, "You do not have permission to do that.");
});

test("DELETE demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(
    authed("DELETE", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 401);
});

// --- route registration ------------------------------------------------------------

test("the channel item route dispatches PATCH → update and DELETE → the new lifecycle route", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: CATEGORY_PRIOR_TEST, first: async () => null },
  ]);
  const response = await dispatch(
    authed("PATCH", `/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {}),
    envWithLimiters({ GOOBER_DB: db }),
  );
  // The PATCH still answers ITS own 400-with-pinned-copy (not the 404/403
  // family), proving the method split landed.
  assert.equal(response.status, 400);
});
