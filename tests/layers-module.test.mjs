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

// Phase-3 channel layers (api/servers.mjs routes + api/messages.mjs gates +
// api/ws.mjs voicing): the categories CRUD, the overwrite PUT/DELETE/GET, the
// slowmode/category PATCH, the private-channel create toggle, the per-channel
// effective-permission payloads, and the resolution-order enforcement — the
// fakeDb + pinned-SQL contract style of the roles/discovery test modules.
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { enforceChannelBits, handleMessageRoutes, sendMessageToChannel } from "../api/messages.mjs";
import { handleWsRoutes } from "../api/ws.mjs";
import {
  ALL_SERVER_PERMISSIONS,
  effectivePermissions,
  permissionNames,
  SERVER_PERMISSIONS,
  SLOWMODE_CHOICES,
} from "../api/permissions.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { GC_CATEGORIES_MAX_PER_SERVER, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const CHANNEL_ID = 90;
const SP = SERVER_PERMISSIONS;
const V = SP.VIEW, SE = SP.SEND, C = SP.CONNECT, SK = SP.SPEAK;

// --- shared scaffolding (same conventions as roles-module) -----------------------

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}
function request(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function dispatchHandler(handler, request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handler(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}
async function bodyOf(response) {
  return JSON.parse(await response.text());
}
async function dispatch(request, env) {
  return dispatchHandler(handleServerRoutes, request, env);
}

function fakeDb(routes) {
  const calls = [];
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
        return { meta: { changes: 1, last_row_id: 41 } };
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

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

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
  return { token, csrf, row };
}

function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

const ACTOR_CONTEXT_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("AS position") &&
  sql.includes("FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?");

function actorContextRoute({ role = "member", permissions = 0, position = -1 } = {}) {
  return {
    test: ACTOR_CONTEXT_TEST,
    first: async () => ({ role, permissions, position, nickname: null }),
  };
}

const MEMBERSHIP_ROLE_TEST = (sql) =>
  sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?");
// The layered module's role-mask read (slowmode bypass + gate context share it
// by SQL text with neither the roleMaskColumnSql fragment's aliasing nor the
// actor context's shape) — the RBAC-audit H1 shape: GROUP_CONCAT + the JS fold.
const LAYER_MASK_TEST = (sql) =>
  sql.includes("SELECT m.role AS role") &&
  sql.includes("GROUP_CONCAT(ar.permissions)");

async function layersSessioned(method, path, body) {
  const { token, csrf, row } = await sessionFixtures();
  const call = (m = method, b = body) =>
    request(m, path, b, { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf });
  return { token, row, call };
}

// --- categories: POST / GET / PATCH / DELETE ---------------------------------------

test("creating a category appends at the bottom inside the owner-OR-manage INSERT", async () => {
  const { row, call } = await layersSessioned("POST", "/api/servers/3/categories", { name: "Text" });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("INSERT INTO gc_channel_categories"),
      run: () => ({ meta: { changes: 1, last_row_id: 60 } }),
    },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, position FROM gc_channel_categories WHERE id = ?"),
      first: async () => ({ id: 60, server_id: 3, name: "Text", position: 2 }),
    },
  ]);
  const response = await dispatch(call("POST"), envWithLimiters(db));
  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    category: { id: 60, serverId: 3, name: "Text", position: 2 },
  });

  const insert = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("INSERT INTO gc_channel_categories"));
  assert.match(insert.sql, /SELECT COALESCE\(MAX\(position\), -1\) \+ 1 FROM gc_channel_categories WHERE server_id = \?\)/);
  // The RBAC audit's H1 repair: the manage rider is the per-bit EXISTS.
  assert.match(insert.sql, /OR \(EXISTS \(SELECT 1 FROM gc_member_roles gbm1 JOIN gc_roles gbr1/);
  // The parity-law category cap rides INSIDE the same INSERT:
  // parity-limits.md: Categories per server 50 (verified 2026-11-17) —
  // COUNT(*) <= 49 lets the row that joins the cap in.
  assert.match(insert.sql, /\(SELECT COUNT\(\*\) FROM gc_channel_categories WHERE server_id = \?\) <= 49/);
  assert.deepEqual(insert.bound, [
    3, "Text", 3, insert.bound[3],
    3, USER_ID, 3, USER_ID,
    3,
  ]);
});

// Stateful category-cap stand-in (the channel family's channelCapRoutes
// shape): the guarded INSERT's authority + COUNT(*) preconditions are real
// SQL, so the fake decides changes=0/1 from a simulated category count, and
// the membership read that classifies a refusal rides the same route key the
// channel create's diagnostic uses.
function categoryCapRoutes(existing) {
  const state = { categories: existing };
  const routes = [
    {
      test: (sql) => sql.includes("INSERT INTO gc_channel_categories"),
      run: () => {
        // D1 evaluates BOTH preconditions (authority and cap) inside the
        // INSERT; the fake refuses anything either would refuse for an owner.
        if (state.categories >= GC_CATEGORIES_MAX_PER_SERVER) {
          return { meta: { changes: 0 } };
        }
        state.categories += 1;
        return { meta: { changes: 1, last_row_id: 60 } };
      },
    },
    { test: MEMBERSHIP_ROLE_TEST, first: async () => ({ role: "owner" }) },
  ];
  return { state, routes };
}

// parity-limits.md: Categories per server 50 (verified 2026-11-17). The cap
// rides the create statement — the 50th category joins, the 51st refuses
// with the limit copy, and the classifying read never gates an admitted row.
test("the owner's 50th category joins and the 51st past the cap 400s with the limit copy", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const post = (body) =>
    request("POST", "/api/servers/3/categories", body,
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf });
  const makeDb = (routes) =>
    fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);

  {
    const { state, routes } = categoryCapRoutes(GC_CATEGORIES_MAX_PER_SERVER - 1);
    const response = await dispatch(post({ name: "last-slot" }), envWithLimiters(makeDb(routes)));
    assert.equal(response.status, 201);
    assert.equal(state.categories, GC_CATEGORIES_MAX_PER_SERVER);
  }
  {
    const { state, routes } = categoryCapRoutes(GC_CATEGORIES_MAX_PER_SERVER);
    const db = makeDb(routes);
    const response = await dispatch(post({ name: "one-too-many" }), envWithLimiters(db));
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), {
      error: "That server has reached its category limit.",
    });
    assert.equal(state.categories, GC_CATEGORIES_MAX_PER_SERVER); // nothing was created
    // The cap precondition rode INSIDE the same INSERT (authority joined it).
    const insert = db.calls.find(
      (entry) => entry.call === "run" && entry.sql.includes("INSERT INTO gc_channel_categories"),
    );
    assert.ok(insert);
    assert.match(
      insert.sql,
      /\(SELECT COUNT\(\*\) FROM gc_channel_categories WHERE server_id = \?\) <= 49/,
    );
  }
});

test("category create validates the name before any statement and 403s on refusal", async () => {  {
    const { row, call } = await layersSessioned("POST", "/api/servers/3/categories", { name: "" });
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("POST"), envWithLimiters(db));
    assert.equal(response.status, 400);
    assert.deepEqual(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"), []);
  }
  {
    const { row, call } = await layersSessioned("POST", "/api/servers/3/categories", { name: "Cat" });
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: (sql) => sql.includes("INSERT INTO gc_channel_categories"), run: () => ({ meta: { changes: 0 } }) },
    ]);
    const response = await dispatch(call("POST"), envWithLimiters(db));
    assert.equal(response.status, 403);
    assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  }
});

test("GET categories is membership-gated and lists position-first", async () => {
  const { token, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "member", permissions: 0 }),
    {
      test: (sql) =>
        sql.includes("FROM gc_channel_categories") && sql.includes("ORDER BY position, id"),
      all: async () => ({
        results: [
          { id: 60, server_id: 3, name: "B", position: 1 },
          { id: 61, server_id: 3, name: "A", position: 1 },
        ],
      }),
    },
  ]);
  const response = await dispatchHandler(
    handleServerRoutes,
    request("GET", "/api/servers/3/categories", undefined, { Cookie: "__Host-goober_session=" + token }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    categories: [
      { id: 60, serverId: 3, name: "B", position: 1 },
      { id: 61, serverId: 3, name: "A", position: 1 },
    ],
    viewer: { owner: false, permissions: [], topPosition: -1 },
  });

  // Without membership: the shared 403, no oracle.
  const memberless = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: ACTOR_CONTEXT_TEST, first: async () => null },
  ]);
  const refused = await dispatchHandler(
    handleServerRoutes,
    request("GET", "/api/servers/3/categories", undefined, { Cookie: "__Host-goober_session=" + token }),
    envWithLimiters(memberless),
  );
  assert.equal(refused.status, 403);
});

test("renaming a category rides the guarded UPDATE; the position ceiling 400s", async () => {
  {
    const { row, call } = await layersSessioned("PATCH", "/api/servers/3/categories/60", { name: "Renamed" });
    // One SELECT route, re-read after the write: the fakeDb answers by call
    // order, so the fixture is switched on the UPDATE's arrival.
    let current = { id: 60, server_id: 3, name: "Old", position: 0 };
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
      {
        test: (sql) => sql.includes("SELECT id, server_id, name, position FROM gc_channel_categories"),
        first: async () => current,
      },
      {
        test: (sql) => sql.startsWith("UPDATE gc_channel_categories SET name = ?"),
        run: () => {
          current = { id: 60, server_id: 3, name: "Renamed", position: 0 };
          return { meta: { changes: 1 } };
        },
      },
    ]);
    const response = await dispatch(call("PATCH"), envWithLimiters(db));
    assert.equal(response.status, 200);
    assert.deepEqual((await bodyOf(response)).category.name, "Renamed");
  }
  {
    const { row, call } = await layersSessioned("PATCH", "/api/servers/3/categories/60", { position: 9 });
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
      {
        test: (sql) => sql.includes("SELECT id, server_id, name, position FROM gc_channel_categories"),
        first: async () => ({ id: 60, server_id: 3, name: "Old", position: 0 }),
      },
      {
        test: (sql) => sql.includes("FROM gc_channel_categories WHERE server_id = ?"),
        first: async () => ({ max_position: 2 }),
      },
    ]);
    const response = await dispatch(call("PATCH"), envWithLimiters(db));
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), { error: "position must be between 0 and 2." });
  }
});

test("moving a category to an occupied slot is a batched, same-guard swap", async () => {
  const { row, call } = await layersSessioned("PATCH", "/api/servers/3/categories/60", { position: 1 });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, position FROM gc_channel_categories"),
      first: async () => ({ id: 60, server_id: 3, name: "B", position: 0 }),
    },
    {
      test: (sql) => sql.includes("COALESCE(MAX(position), -1) AS max_position FROM gc_channel_categories"),
      first: async () => ({ max_position: 2 }),
    },
    {
      test: (sql) => sql.includes("SELECT id FROM gc_channel_categories WHERE server_id = ? AND position = ? AND id <> ?"),
      first: async () => ({ id: 61 }),
    },
    {
      test: (sql) => sql.includes("UPDATE gc_channel_categories SET position = ?"),
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, position FROM gc_channel_categories"),
      first: async () => ({ id: 60, server_id: 3, name: "B", position: 1 }),
    },
  ]);
  const response = await dispatch(call("PATCH"), envWithLimiters(db));
  assert.equal(response.status, 200);
  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.equal(batch.statements.length, 2, "the target moves and the partner takes the old slot");
  assert.deepEqual(batch.statements[0].bound.slice(0, 4), [1, 60, 3, 0]);
  assert.deepEqual(batch.statements[1].bound.slice(0, 4), [0, 61, 3, 1]);
});

test("deleting a category carries the guard and needs no follow-up clean-up", async () => {
  const { row, call } = await layersSessioned("DELETE", "/api/servers/3/categories/60", undefined);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_channel_categories WHERE id = ? AND server_id = ?"),
      run: () => ({ meta: { changes: 1 } }),
    },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { deleted: true, categoryId: 60 });

  const remove = db.calls.find((entry) => entry.call === "run" && entry.sql.startsWith("DELETE FROM gc_channel_categories"));
  assert.ok(
    remove.sql.includes("OR (EXISTS (SELECT 1 FROM gc_member_roles gbm1 JOIN gc_roles gbr1"),
    "the manage-arms ride the guard",
  );
  // categoryId, serverId — then the owner-OR manage-arms (owner pair +
  // per-bit pair; the mask binds folded into the SQL literals).
  assert.deepEqual(remove.bound, [
    60, 3,
    3, USER_ID, 3, USER_ID,
  ]);

  const refused = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.startsWith("DELETE FROM gc_channel_categories"), run: () => ({ meta: { changes: 0 } }) },
  ]);
  const denied = await dispatch(call("DELETE"), envWithLimiters(refused));
  assert.equal(denied.status, 403);
});

// --- channel PATCH: slowmode + category move ---------------------------------------

const LAYERED_PATCH_TEST = (sql) =>
  sql.startsWith("UPDATE gc_channels SET") && sql.includes("server_id IS NOT NULL");

test("slowmode_seconds accepts exactly the filed menu values and 400s otherwise", async () => {
  for (const seconds of SLOWMODE_CHOICES) {
    const { row, call } = await layersSessioned("PATCH", "/api/servers/3/channels/90", { slowmode_seconds: seconds });
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: LAYERED_PATCH_TEST, run: () => ({ meta: { changes: 1 } }) },
    ]);
    const response = await dispatch(call("PATCH"), envWithLimiters(db));
    assert.equal(response.status, 200, "value " + String(seconds));
    assert.deepEqual(await bodyOf(response), {
      channel: { id: 90, serverId: 3, slowmodeSeconds: seconds },
    });
  }
  {
    const { row, call } = await layersSessioned("PATCH", "/api/servers/3/channels/90", { slowmode_seconds: 60 });
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PATCH"), envWithLimiters(db));
    assert.equal(response.status, 400);
    assert.deepEqual(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"), []);
  }
});

test("a nothing-to-change channel PATCH 400s; the spoiler-only shape is unchanged", async () => {
  {
    const { row, call } = await layersSessioned("PATCH", "/api/servers/3/channels/90", {});
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PATCH"), envWithLimiters(db));
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), {
      // The rename's field rides the same PATCH block (SHAVERS 1), so the
      // pinned copy grew the name arm.
      error: "Nothing to change. Send a name, a spoiler flag, a slowmode_seconds, or a category_id.",
    });
  }
  {
    const { row, call } = await layersSessioned("PATCH", "/api/servers/3/channels/90", { is_spoiler: true });
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: LAYERED_PATCH_TEST, run: () => ({ meta: { changes: 1 } }) },
    ]);
    const response = await dispatch(call("PATCH"), envWithLimiters(db));
    assert.equal(response.status, 200);
    assert.deepEqual(await bodyOf(response), { channel: { id: 90, serverId: 3, isSpoiler: true } });
  }
});

test("a category move carries the target-guard and re-claims the emptied source folder", async () => {
  const { row, call } = await layersSessioned(
    "PATCH", "/api/servers/3/channels/90", { category_id: 61 },
  );
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      // The source read (before the write — only clean-up targeting).
      test: (sql) => sql.includes("SELECT category_id FROM gc_channels WHERE id = ? AND server_id = ?"),
      first: async () => ({ category_id: 60 }),
    },
    { test: LAYERED_PATCH_TEST, run: () => ({ meta: { changes: 1 } }) },
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_channel_categories"),
      run: (bound) => {
        // The NOT EXISTS rider is the auto-delete's own truth: an empty
        // folder leaves, a populated one stays.
        return Number(bound[0]) === 60
          ? { meta: { changes: 1 } }
          : { meta: { changes: 0 } };
      },
    },
  ]);
  const response = await dispatch(call("PATCH"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { channel: { id: 90, serverId: 3, categoryId: 61 } });

  const update = db.calls.find((entry) => entry.call === "run" && LAYERED_PATCH_TEST(entry.sql));
  assert.match(update.sql, /UPDATE gc_channels SET category_id = \? WHERE id = \? AND server_id = \?/);
  assert.match(update.sql, /EXISTS \(SELECT 1 FROM gc_channel_categories WHERE id = \? AND server_id = \?\)/);
  assert.deepEqual(update.bound, [
    61, 90, 3,
    3, USER_ID, 3, USER_ID,
    61, 3,
  ]);
  const reclaim = db.calls.find((entry) => entry.call === "run" && entry.sql.startsWith("DELETE FROM gc_channel_categories"));
  assert.match(reclaim.sql, /NOT EXISTS \(SELECT 1 FROM gc_channels WHERE category_id = gc_channel_categories\.id\)/);
  assert.deepEqual(reclaim.bound, [60, 3]);
});

test("a move to no-category skips the reclaim when the source folder keeps channels", async () => {
  const { row, call } = await layersSessioned("PATCH", "/api/servers/3/channels/90", { category_id: null });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("SELECT category_id FROM gc_channels WHERE id = ? AND server_id = ?"),
      first: async () => ({ category_id: 60 }),
    },
    { test: LAYERED_PATCH_TEST, run: () => ({ meta: { changes: 1 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_channel_categories"), run: () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("PATCH"), envWithLimiters(db));
  assert.equal(response.status, 200);
  const reclaim = db.calls.find((entry) => entry.call === "run" && entry.sql.startsWith("DELETE FROM gc_channel_categories"));
  assert.ok(reclaim, "the empty-folder check still ran (the SQL rules kept the populated folder)");
  assert.deepEqual(reclaim.bound, [60, 3]);
});

// --- channel create: category/slowmode/private --------------------------------------

test("a layered create rides the extended INSERT with the category EXISTS rider", async () => {
  const { row, call } = await layersSessioned("POST", "/api/servers/3/channels", {
    name: "lounge", kind: "voice", category_id: 60, slowmode_seconds: 900,
  });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("INSERT INTO gc_channels (server_id, name, kind, position, created_at, category_id, slowmode_seconds)"),
      run: () => ({ meta: { changes: 1, last_row_id: 90 } }),
    },
    {
      test: (sql) => sql.includes("SELECT id, name, kind, position FROM gc_channels WHERE id = ? AND server_id = ?"),
      first: async () => ({ id: 90, name: "lounge", kind: "voice", position: 2 }),
    },
    {
      test: (sql) => sql.includes("SELECT category_id, slowmode_seconds FROM gc_channels WHERE id = ?"),
      first: async () => ({ category_id: 60, slowmode_seconds: 900 }),
    },
  ]);
  const response = await dispatch(call("POST"), envWithLimiters(db));
  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    channel: { id: 90, name: "lounge", kind: "voice", position: 2, categoryId: 60, slowmodeSeconds: 900 },
  });

  const insert = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("category_id, slowmode_seconds"));
  // The same owner/role-bit/cap WHERE, plus the category rider.
  assert.match(insert.sql, /role IN \('owner','moderator'\)/);
  assert.match(insert.sql, /AND \(\? IS NULL OR EXISTS \(SELECT 1 FROM gc_channel_categories WHERE id = \? AND server_id = \?\)\)/);
  assert.deepEqual(insert.bound.filter((value, index) => index !== 4), [
    3, "lounge", "voice", 3, 60, 900,
    3, USER_ID, 3, USER_ID,
    3, 60, 60, 3,
  ]);
});

test("the PRIVATE toggle writes the @everyone deny-VIEW plus one allow row per role", async () => {
  const { row, call } = await layersSessioned("POST", "/api/servers/3/channels", {
    name: "mods-only", kind: "text", private: true,
  });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("INSERT INTO gc_channels (server_id, name, kind, position, created_at)"),
      run: () => ({ meta: { changes: 1, last_row_id: 91 } }),
    },
    {
      test: (sql) => sql.includes("SELECT id, name, kind, position FROM gc_channels WHERE id = ? AND server_id = ?"),
      first: async () => ({ id: 91, name: "mods-only", kind: "text", position: 3 }),
    },
  ]);
  const response = await dispatch(call("POST"), envWithLimiters(db));
  assert.equal(response.status, 201);
  assert.deepEqual((await bodyOf(response)).channel, {
    id: 91, name: "mods-only", kind: "text", position: 3, private: true,
  });

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "the private toggle is the create's second batch");
  assert.equal(batch.statements.length, 2);
  const [everyone, roles] = batch.statements.map((statement) => statement);
  // BOTH rows bind the LITERAL channel id (the create's own .run() verdict
  // precedes the batch; last_insert_rowid() never rides a batch statement —
  // remote D1 resets the rowid across a batch, the live-verified hazard).
  assert.match(everyone.sql, /INSERT INTO gc_channel_overwrites \(channel_id, role_id, allow_mask, deny_mask\) VALUES \(\?, NULL, 0, \?\)/);
  assert.equal(everyone.sql.includes("last_insert_rowid"), false);
  assert.deepEqual(everyone.bound, [91, SP.VIEW]);
  // One allow-VIEW row per gc_role in the server (the filed creation shortcut).
  assert.match(roles.sql, /SELECT \?, id, \?, 0 FROM gc_roles WHERE server_id = \?/);
  assert.equal(roles.sql.includes("last_insert_rowid"), false);
  assert.deepEqual(roles.bound, [91, SP.VIEW, 3]);
});

test("a private toggle with a non-boolean value 400s before any statement", async () => {
  const { row, call } = await layersSessioned("POST", "/api/servers/3/channels", {
    name: "mods-only", kind: "text", private: "yes",
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(call("POST"), envWithLimiters(db));
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "private must be true or false." });
  assert.deepEqual(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"), []);
});

// --- overwrites: PUT / DELETE / GET -------------------------------------------------

const OVERWRITE_PUT_BATCH = (batch) =>
  Boolean(batch && batch.statements && batch.statements[0] &&
    batch.statements[0].sql.startsWith("DELETE FROM gc_channel_overwrites"));

function overwriteInsertRoutes({ changes = 1 } = {}) {
  return [
    { test: (sql) => sql.startsWith("DELETE FROM gc_channel_overwrites"), run: () => ({ meta: { changes: changes } }) },
    { test: (sql) => sql.includes("INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask)"), run: () => ({ meta: { changes: changes } }) },
  ];
}

test("PUT overwrites/everyone is a two-statement batch with the identical guard", async () => {
  const { row, call } = await layersSessioned("PUT", "/api/servers/3/channels/90/overwrites/everyone", {
    allow_mask: [], deny_mask: ["VIEW"],
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...overwriteInsertRoutes()]);
  const response = await dispatch(call("PUT"), envWithLimiters(db));
  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    overwrite: { channelId: 90, roleId: null, allow: [], deny: ["VIEW"] },
  });

  const batch = db.calls.find((entry) => OVERWRITE_PUT_BATCH(entry));
  const [remove, insert] = batch.statements;
  assert.match(remove.sql, /DELETE FROM gc_channel_overwrites WHERE channel_id = \? AND role_id IS \? AND/);
  assert.match(remove.sql, /EXISTS \(SELECT 1 FROM gc_channels gc WHERE gc\.id = \? AND gc\.server_id = \? AND gc\.kind IN \('text','voice'\)\)/);
  assert.match(insert.sql, /INSERT INTO gc_channel_overwrites \(channel_id, role_id, allow_mask, deny_mask\) SELECT \?, \?, \?, \? WHERE /);
  // The classification rides the INSERT's changes; both carry the same WHERE.
  assert.deepEqual(insert.bound.slice(0, 4), [90, null, 0, SP.VIEW]);
  assert.equal(
    remove.sql.includes("gc_channels gc WHERE gc.id = ?") ===
    insert.sql.includes("gc_channels gc WHERE gc.id = ?"),
    true,
    "the same channel/authority guard on both statements",
  );
});

test("a role-targeted overwrite carries the MANAGE_ROLES + position arm inside both statements", async () => {
  const { row, call } = await layersSessioned("PUT", "/api/servers/3/channels/90/overwrites/4", {
    allow_mask: ["SEND"], deny_mask: ["VIEW"],
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...overwriteInsertRoutes()]);
  const response = await dispatch(call("PUT"), envWithLimiters(db));
  assert.equal(response.status, 201);
  assert.deepEqual((await bodyOf(response)).overwrite, {
    channelId: 90, roleId: 4, allow: ["SEND"], deny: ["VIEW"],
  });

  const batch = db.calls.find((entry) => OVERWRITE_PUT_BATCH(entry));
  const insert = batch.statements[1];
  // The manage-arms are per-bit EXISTS forms: MANAGE_CHANNELS admits
  // alone, MANAGE_ROLES admits only below the actor's top role.
  assert.match(insert.sql,
    /OR \(EXISTS \(SELECT 1 FROM gc_member_roles gbm1 JOIN gc_roles gbr1[\s\S]*\(gbr1\.permissions & 1\) <> 0\)\)?/);
  assert.match(insert.sql,
    /OR \(\(EXISTS \(SELECT 1 FROM gc_member_roles gbm2 JOIN gc_roles gbr2[\s\S]*\(gbr2\.permissions & 2\) <> 0\)\) AND \(SELECT position FROM gc_roles WHERE id = \? AND server_id = \?\) < \(SELECT COALESCE\(MAX\(hr\.position\), -1\)/);
  // Binds after the values: the channel rider, the role rider, the owner arm,
  // the two per-bit arms, then the position compare and the hierarchy read.
  assert.deepEqual(insert.bound, [
    90, 4, SP.SEND, SP.VIEW,
    // the shared guard
    90, 3, 4, 3,
    3, USER_ID,
    3, USER_ID, 4, 3, 3, USER_ID,
  ]);
});

test("overwrite PUTs validate the named bits and refuse empty masks", async () => {
  for (const body of [
    { allow_mask: ["NOT_A_BIT"], deny_mask: [] },
    { allow_mask: ["MANAGE_CHANNELS"], deny_mask: [] }, // not an overwrite bit
    { allow_mask: [], deny_mask: [] },
    {},
  ]) {
    const { row, call } = await layersSessioned("PUT", "/api/servers/3/channels/90/overwrites/everyone", body);
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PUT"), envWithLimiters(db));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"), []);
  }
});

test("a refused PUT answers the shared 403 with both statements inert", async () => {
  const { row, call } = await layersSessioned("PUT", "/api/servers/3/channels/90/overwrites/everyone", {
    allow_mask: ["VIEW"], deny_mask: [],
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...overwriteInsertRoutes({ changes: 0 })]);
  const response = await dispatch(call("PUT"), envWithLimiters(db));
  assert.equal(response.status, 403);
});

test("DELETE overwrites/everyone removes the layer row under the same guard", async () => {
  const { row, call } = await layersSessioned("DELETE", "/api/servers/3/channels/90/overwrites/everyone", undefined);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.startsWith("DELETE FROM gc_channel_overwrites"), run: () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { deleted: true, channelId: 90, roleId: null });

  const remove = db.calls.find((entry) => entry.call === "run" && entry.sql.startsWith("DELETE FROM gc_channel_overwrites"));
  assert.match(remove.sql, /role_id IS \?/);
  // A zero-changes delete (already inherit) answers the same shared 403 as
  // any other refusal — one answer, no oracle.
  const bare = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.startsWith("DELETE FROM gc_channel_overwrites"), run: () => ({ meta: { changes: 0 } }) },
  ]);
  const denied = await dispatch(call("DELETE"), envWithLimiters(bare));
  assert.equal(denied.status, 403);
});

test("GET overwrites lists the rows beside the roles and the viewer block", async () => {
  const { token, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
    {
      test: (sql) => sql.includes("SELECT id, server_id FROM gc_channels WHERE id = ? AND server_id = ?"),
      first: async () => ({ id: 90, server_id: 3 }),
    },
    {
      test: (sql) =>
        sql.includes("SELECT id, channel_id, role_id, allow_mask, deny_mask FROM gc_channel_overwrites"),
      all: async () => ({
        results: [
          { id: 1, channel_id: 90, role_id: null, allow_mask: SE, deny_mask: V },
          { id: 2, channel_id: 90, role_id: 4, allow_mask: V, deny_mask: 0 },
        ],
      }),
    },
    {
      test: (sql) => sql.includes("SELECT id, name, color, position, permissions FROM gc_roles"),
      all: async () => ({
        results: [{ id: 4, name: "Mods", color: null, position: 3, permissions: SK }],
      }),
    },
  ]);
  const response = await dispatchHandler(
    handleServerRoutes,
    request("GET", "/api/servers/3/channels/90/overwrites", undefined, { Cookie: "__Host-goober_session=" + token }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    channel: { id: 90, serverId: 3 },
    overwrites: [
      { id: 1, channelId: 90, roleId: null, allow: ["SEND"], deny: ["VIEW"] },
      { id: 2, channelId: 90, roleId: 4, allow: ["VIEW"], deny: [] },
    ],
    roles: [{ id: 4, name: "Mods", color: null, position: 3, permissions: ["SPEAK"] }],
    viewer: { owner: true, permissions: permissionNames(ALL_SERVER_PERMISSIONS), topPosition: -1 },
  });
});

// --- the list payload: per-channel effective permissions + categories ---------------

const LIST_SELECT_TEST = (sql) =>
  sql.includes("FROM gc_server_members m") && sql.includes("ORDER BY s.id, c.position, c.id");
const VIEWER_ROLES_LIST_TEST = (sql) =>
  sql.includes("FROM gc_member_roles gmr JOIN gc_roles r ON r.id = gmr.role_id") &&
  sql.includes("WHERE gmr.user_id = ?") && sql.includes("as server_id FROM") === false;
const CATEGORIES_READ_TEST = (sql) =>
  sql.includes("SELECT id, server_id, name, position FROM gc_channel_categories");
const OVERWRITES_READ_TEST = (sql) =>
  sql.includes("SELECT channel_id, category_id, role_id, allow_mask, deny_mask FROM gc_channel_overwrites");

async function serverListDb({ membershipRole = "member", roleRows = [], categories = [], categoriesForViewer = [], overwrites = [], channelRows = null }) {
  const { token, row } = await sessionFixtures();
  const serverRows = channelRows ?? [
    { server_id: 3, server_name: "Alpha", server_is_public: 1, server_icon_media_id: null, role: membershipRole, server_boosts: 0, boosted_by_me: 0,
      channel_id: 90, channel_name: "lounge", channel_kind: "text", channel_position: 0, channel_is_spoiler: 0,
      channel_category_id: categories.length ? 60 : null, channel_slowmode_seconds: 900 },
  ];
  return fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: LIST_SELECT_TEST, all: async () => ({ results: serverRows }) },
    {
      test: (sql) => sql.includes("FROM gc_member_roles gmr") && sql.includes("JOIN gc_roles r ON r.id = gmr.role_id"),
      all: async () => ({ results: roleRows }),
    },
    { test: CATEGORIES_READ_TEST, all: async () => ({ results: categories }) },
    { test: OVERWRITES_READ_TEST, all: async () => ({ results: overwrites }) },
  ]);
}

test("an overwrite-free server's list payload stays byte-identical (graceful default)", async () => {
  const { token, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: LIST_SELECT_TEST,
      all: async () => ({
        results: [
          { server_id: 3, server_name: "Alpha", server_is_public: 1, server_icon_media_id: null, role: "member", server_boosts: 0, boosted_by_me: 0,
            channel_id: 90, channel_name: "general", channel_kind: "text", channel_position: 0, channel_is_spoiler: 0,
            channel_category_id: null, channel_slowmode_seconds: 0 },
        ],
      }),
    },
  ]);
  const response = await dispatchHandler(
    handleServerRoutes,
    request("GET", "/api/servers", undefined, { Cookie: "__Host-goober_session=" + token }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.servers[0], {
    id: 3, name: "Alpha", isPublic: true, role: "member", iconUrl: null,
    boosts: 0, boostedByMe: false,
    channels: [{ id: 90, name: "general", kind: "text", position: 0, isSpoiler: false }],
  }, "no categories key, no effectivePermissions, no slowmodeSeconds");
});

test("an overlaid server's list carries categories, the layer columns, and effective permissions", async () => {
  const db = await serverListDb({
    roleRows: [{ server_id: 3, id: 5, permissions: V }],
    categories: [{ id: 60, server_id: 3, name: "Text", position: 0 }],
    overwrites: [
      { channel_id: 90, category_id: null, role_id: null, allow_mask: 0, deny_mask: SE | C },
      { channel_id: null, category_id: 60, role_id: 5, allow_mask: SE, deny_mask: 0 },
    ],
  });
  const { token } = await sessionFixtures();
  const response = await dispatchHandler(
    handleServerRoutes,
    request("GET", "/api/servers", undefined, { Cookie: "__Host-goober_session=" + token }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.servers[0].categories, [
    { id: 60, name: "Text", position: 0 },
  ]);
  // The resolution walk applies the layers in order: the category-layer role
  // allow re-grants SEND, but the CHANNEL layer's @everyone deny applies LAST
  // — it strips SEND (and CONNECT) back off. A plain member reads VIEW.
  // the deny strips SEND and CONNECT; ADD_REACTIONS was never named, so the
  // implicit base keeps it (the deny list is the only thing ever removed).
  assert.deepEqual(body.servers[0].channels[0].effectivePermissions,
    ["VIEW", "ADD_REACTIONS"]);
  assert.deepEqual({ ...body.servers[0].channels[0] }, {
    id: 90, name: "lounge", kind: "text", position: 0, isSpoiler: false,
    categoryId: 60, slowmodeSeconds: 900,
    effectivePermissions: ["VIEW", "ADD_REACTIONS"],
  });

  // A channel-layer role allow re-grants what the @everyone deny took —
  // exactly the private/announcement shape the sidebar vanish rule rides.
  const again = await dispatchHandler(
    handleServerRoutes,
    request("GET", "/api/servers", undefined, { Cookie: "__Host-goober_session=" + (await sessionFixtures()).token }),
    envWithLimiters(await serverListDb({
      roleRows: [{ server_id: 3, id: 5, permissions: 0 }],
      overwrites: [
        { channel_id: 90, category_id: null, role_id: null, allow_mask: 0, deny_mask: SE },
        { channel_id: 90, category_id: null, role_id: 5, allow_mask: SE, deny_mask: 0 },
      ],
    })),
  );
  assert.equal(again.status, 200);
  assert.deepEqual(
    (await bodyOf(again)).servers[0].channels[0].effectivePermissions,
    ["VIEW", "SEND", "ADD_REACTIONS"],
  );
});

test("the owner's list carries the full mask; a plain member rides the walk", async () => {
  for (const role of ["owner", "member"]) {
    const db = await serverListDb({
      membershipRole: role,
      overwrites: [{ channel_id: 90, category_id: null, role_id: null, allow_mask: 0, deny_mask: SE }],
    });
    const { token } = await sessionFixtures();
    const response = await dispatchHandler(
      handleServerRoutes,
      request("GET", "/api/servers", undefined, { Cookie: "__Host-goober_session=" + token }),
      envWithLimiters(db),
    );
    const channel = (await bodyOf(response)).servers[0].channels[0];
    if (role === "owner") {
      assert.deepEqual(channel.effectivePermissions, permissionNames(ALL_SERVER_PERMISSIONS));
    } else {
      assert.deepEqual(channel.effectivePermissions, ["VIEW", "ADD_REACTIONS"],
        "the deny took SEND (ADD_REACTIONS stays implicit)");
    }
  }
});

// --- history/send enforcement (api/messages.mjs) ------------------------------------

async function messageDispatch(request, env) {
  return dispatchHandler(handleMessageRoutes, request, env);
}

async function messageSession(method, path, body) {
  const { token, csrf, row } = await sessionFixtures();
  return {
    token,
    row,
    call: (m = method, b = body) =>
      request(m, path, b, { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf }),
  };
}

const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c WHERE c.id = ?") && sql.includes("gc_server_members m");
const LAYER_MEMBERSHIP_TEST = (sql) =>
  sql.startsWith("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const LAYER_ROLES_TEST = (sql) =>
  sql.includes("SELECT r.id AS id, r.permissions AS permissions FROM gc_member_roles");
const LAYER_CHAIN_TEST = (sql) => sql.includes("FROM gc_channel_overwrites o ");
const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");
const LAYER_SLOWMODE_TEST = (sql) =>
  sql.includes("SELECT server_id, slowmode_seconds FROM gc_channels WHERE id = ?");

// gateRoutes builds the three gate reads. The chain rows are REAL shapes —
// channel-layer rows carry channel_id, category-layer rows carry category_id —
// because the evaluator classifies them BY SHAPE.
const channelChainRow = (roleId, allowBits, denyBits) => ({
  channel_id: 90, category_id: null, role_id: roleId, allow_mask: allowBits, deny_mask: denyBits,
});

function gateRoutes({ membership = { role: "member" }, roleRows = [], chainRows = [] } = {}) {
  return {
    membershipRoute: { test: LAYER_MEMBERSHIP_TEST, first: async () => membership },
    rolesRoute: { test: LAYER_ROLES_TEST, all: async () => ({ results: roleRows }) },
    chainRoute: { test: LAYER_CHAIN_TEST, all: async () => ({ results: chainRows }) },
  };
}

test("a VIEW-denied member's history reads 404 — the channel vanishes, no oracle", async () => {
  const { call, row } = await messageSession("GET", "/api/channels/90/messages");
  const gates = gateRoutes({ chainRows: [channelChainRow(null, 0, V)] });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "text" }) },
    gates.membershipRoute,
    gates.rolesRoute,
    gates.chainRoute,
  ]);
  const response = await messageDispatch(call("GET"), envWithLimiters(db));
  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), {
    error: "This channel does not exist or you cannot view it.",
  });
  // The page query never ran: the gate answered before it.
  assert.deepEqual(db.calls.filter((entry) => entry.sql.includes("WHERE m.channel_id = ?")), []);
});

test("a SEND-denied but VIEW-allowed member can still read history", async () => {
  const { call, row } = await messageSession("GET", "/api/channels/90/messages");
  const gates = gateRoutes({ chainRows: [channelChainRow(null, 0, SE)] });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "text" }) },
    gates.membershipRoute,
    gates.rolesRoute,
    gates.chainRoute,
    {
      test: (sql) => sql.includes("FROM gc_messages m JOIN users u ON u.id = m.author_id"),
      all: async () => ({ results: [] }),
    },
  ]);
  const response = await messageDispatch(call("GET"), envWithLimiters(db));
  assert.equal(response.status, 200);
});

test("a SEND-denied member's send 403s with the shared message", async () => {
  const { call, row } = await messageSession("POST", "/api/channels/90/messages", { body: "hi" });
  const gates = gateRoutes({ chainRows: [channelChainRow(null, 0, SE)] });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "text" }) },
    gates.membershipRoute,
    gates.rolesRoute,
    gates.chainRoute,
  ]);
  const response = await messageDispatch(call("POST", { body: "hi" }), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  // The gate sits before any write.
  assert.deepEqual(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"), []);
});

test("a deny for a role the viewer doesn't hold never gates (the graceful default)", async () => {
  const { call, row } = await messageSession("POST", "/api/channels/90/messages", { body: "hi" });
  const gates = gateRoutes({
    roleRows: [{ id: 5, permissions: 0 }],
    chainRows: [channelChainRow(9, 0, SE | V)],
  });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "text" }) },
    gates.membershipRoute,
    gates.rolesRoute,
    gates.chainRoute,
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    {
      test: (sql) => sql.includes("INSERT INTO gc_messages") &&
        sql.includes("ON CONFLICT(channel_id, author_id, client_message_id) DO NOTHING"),
      run: () => ({ meta: { changes: 1, last_row_id: 5 } }),
    },
    {
      test: (sql) => sql.includes("UPDATE gc_channels SET"),
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      test: (sql) =>
        sql.includes("FROM gc_messages m JOIN users u ON u.id = m.author_id") &&
        sql.includes("ORDER BY m.id DESC LIMIT 1"),
      run: () => ({ meta: { changes: 1 }, results: [{
        id: 5, author_id: USER_ID, author_name: "wempos", body: "hi",
        client_message_id: null, source: null, created_at: nowSeconds(), edited_at: null,
      }] }),
    },
  ]);
  const response = await messageDispatch(
    call("POST", { body: "hi", clientMessageId: "gc-abc12345" }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201, "the send sails through: no deny touches this viewer");
  assert.deepEqual((await bodyOf(response)).message.body, "hi");
});

function slowmodeDb(bypassRow, lastMessage, results = { inserts: 0 }, insertChanges = 1) {
  const now = nowSeconds();
  return envWithLimiters(fakeDb([
    { test: LAYER_SLOWMODE_TEST, first: async () => ({ server_id: 3, slowmode_seconds: 900 }) },
    { test: LAYER_MASK_TEST, first: async () => bypassRow },
    {
      test: (sql) => sql.includes("SELECT id, created_at, client_message_id FROM gc_messages"),
      first: async () => lastMessage,
    },
    {
      test: (sql) => sql.includes("INSERT INTO gc_messages") &&
        sql.includes("ON CONFLICT(channel_id, author_id, client_message_id) DO NOTHING"),
      run: () => {
        results.inserts += 1;
        return { meta: { changes: insertChanges, last_row_id: 6 } };
      },
    },
    { test: (sql) => sql.includes("UPDATE gc_channels SET"), run: () => ({ meta: { changes: 1 } }) },
    {
      test: (sql) =>
        sql.includes("FROM gc_messages m JOIN users u ON u.id = m.author_id") &&
        sql.includes("ORDER BY m.id DESC LIMIT 1"),
      run: () => ({ meta: { changes: 1 }, results: [{
        id: 6, author_id: USER_ID, author_name: "wempos", body: "third",
        client_message_id: null, source: null, created_at: now, edited_at: null,
      }] }),
    },
  ]));
}

test("slowmode rejects a second send inside the cooldown window with a 429", async () => {
  const now = nowSeconds();
  const results = { inserts: 0 };
  const env = slowmodeDb({ role: "member", mask: 0 }, { id: 5, created_at: now - 60, client_message_id: "gc-old00001" }, results);
  await assert.rejects(
    () => sendMessageToChannel(env, { id: USER_ID, username: "wempos" }, 90, "third", "gc-new00001"),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 429);
      assert.match(error.message, /Slowmode is on — wait \d+s before sending again\./);
      // headers is the plain object HttpError carries (never a Response).
      assert.ok(Number(error.headers["Retry-After"]) <= 840, "the remaining window rides the header");
      assert.ok(Number(error.headers["Retry-After"]) > 0);
      assert.equal(results.inserts, 0, "nothing was written");
      return true;
    },
  );
});

test("the same clientMessageId replay is never its own cooldown breaker", async () => {
  const now = nowSeconds();
  const results = { inserts: 0 };
  const env = slowmodeDb(
    { role: "member", mask: 0 },
    { id: 5, created_at: now - 1, client_message_id: "gc-abc12345" },
    results,
    0, // the stored row already holds the key: DO NOTHING reports changes 0
  );
  const { message, created } = await sendMessageToChannel(
    env, { id: USER_ID, username: "wempos" }, 90, "third", "gc-abc12345",
  );
  assert.equal(created, false, "the replay confirmed the stored row, never a fresh write");
  assert.equal(message.body, "third", "no 429");
  assert.equal(results.inserts, 1, "the ON CONFLICT write still rode the batch (DO NOTHING)");
});

test("the slowmode bypass: owner tier, string moderator, and the two role bits", async () => {
  for (const bypass of [
    { role: "owner", mask: 0 },
    { role: "moderator", mask: 0 },
    { role: "member", mask: SP.KICK_MEMBERS },
    { role: "member", mask: SP.BYPASS_SLOWMODE },
  ]) {
    const now = nowSeconds();
    const results = { inserts: 0 };
    const env = slowmodeDb(bypass, { id: 5, created_at: now - 5, client_message_id: "gc-old00001" }, results);
    const { created } = await sendMessageToChannel(
      env, { id: USER_ID, username: "wempos" }, 90, "third", "gc-new00002",
    );
    assert.equal(created, true, "bypass case " + JSON.stringify(bypass));
    assert.equal(results.inserts, 1);
  }
});

test("a slowmode-less channel never reaches the cooldown reads at all", async () => {
  const now = nowSeconds();
  const env = envWithLimiters(fakeDb([
    { test: LAYER_SLOWMODE_TEST, first: async () => null },
    { test: (sql) => sql.includes("INSERT INTO gc_messages"), run: () => ({ meta: { changes: 1, last_row_id: 7 } }) },
    { test: (sql) => sql.includes("UPDATE gc_channels SET"), run: () => ({ meta: { changes: 1 } }) },
    {
      test: (sql) =>
        sql.includes("FROM gc_messages m JOIN users u ON u.id = m.author_id") &&
        sql.includes("ORDER BY m.id DESC LIMIT 1"),
      run: () => ({ meta: { changes: 1 }, results: [{
        id: 7, author_id: USER_ID, author_name: "wempos", body: "third",
        client_message_id: null, source: null, created_at: now, edited_at: null,
      }] }),
    },
  ]));
  // Not even a membership/bypass read: the channel's slowmode 0 answers first.
  await sendMessageToChannel(
    env, { id: USER_ID, username: "wempos" }, 90, "third", "gc-new00003",
  );
  assert.deepEqual(
    env.GOOBER_DB.calls.filter((entry) => LAYER_MASK_TEST(entry.sql) ||
      entry.sql.includes("SELECT id, created_at, client_message_id FROM gc_messages")),
    [],
  );
});

// --- the ws upgrade gate (voice CONNECT/SPEAK, text VIEW/SEND) ------------------------

async function wsDispatch(request, env) {
  return dispatchHandler(handleWsRoutes, request, env);
}

const WS_VOICE_CHAIN = (denyBits, allowBits = 0) => [
  { role_id: null, category_id: null, allow_mask: allowBits, deny_mask: denyBits },
];

test("a CONNECT-denied voice viewer's upgrade refuses with the shared 403", async () => {
  const { token, row } = await sessionFixtures();
  const gates = gateRoutes({ chainRows: WS_VOICE_CHAIN(C) });
  const env = {
    GOOBER_DB: fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "voice" }) },
      gates.membershipRoute, gates.rolesRoute, gates.chainRoute,
    ]),
  };
  const response = await wsDispatch(
    request("GET", "/api/ws?channel=90", undefined, { Cookie: "__Host-goober_session=" + token }),
    env,
  );
  assert.equal(response.status, 403);
});

test("an SPEAK-denied voice viewer equally refuses at the door (out-of-scope enforcement)", async () => {
  const { token, row } = await sessionFixtures();
  const gates = gateRoutes({ chainRows: WS_VOICE_CHAIN(SK) });
  const env = {
    GOOBER_DB: fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "voice" }) },
      gates.membershipRoute, gates.rolesRoute, gates.chainRoute,
    ]),
  };
  const response = await wsDispatch(
    request("GET", "/api/ws?channel=90", undefined, { Cookie: "__Host-goober_session=" + token }),
    env,
  );
  assert.equal(response.status, 403);
});

test("an un-denied voice channel still forwards the upgrade to the channel DO", async () => {
  const { token, row } = await sessionFixtures();
  const gates = gateRoutes({ chainRows: [] });
  const env = {
    GOOBER_DB: fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind: "voice" }) },
      gates.membershipRoute, gates.rolesRoute, gates.chainRoute,
    ]),
    ROOMS: {
      names: [],
      idFromName(name) {
        this.names.push(name);
        return { name };
      },
      get(id) {
        return { fetch: async () => ({ status: 101 }) };
      },
    },
  };
  const response = await wsDispatch(
    request("GET", "/api/ws?channel=90", undefined, { Cookie: "__Host-goober_session=" + token }),
    env,
  );
  assert.equal(response.status, 101);
  assert.deepEqual(env.ROOMS.names, ["channel:90"]);
});

test("a text channel's gate is the VIEW/SEND pair; the owner bypasses the chain", async () => {
  for (const [kind, membershipRole] of [["text", "member"], ["voice", "owner"]]) {
    const { token, row } = await sessionFixtures();
    const gates = gateRoutes({
      membership: { role: membershipRole },
      // Even denies exist: the owner bypasses; the member's text channel is
      // only gated when their own denies touch them.
      chainRows: WS_VOICE_CHAIN(C),
    });
    const env = {
      GOOBER_DB: fakeDb([
        { test: SESSION_READ_TEST, first: async () => row },
        { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: 90, server_id: 3, kind }) },
        gates.membershipRoute, gates.rolesRoute, gates.chainRoute,
      ]),
      ROOMS: {
        names: [],
        idFromName(name) {
          this.names.push(name);
          return { name };
        },
        get() {
          return { fetch: async () => ({ status: 101 }) };
        },
      },
    };
    const response = await wsDispatch(
      request("GET", "/api/ws?channel=90", undefined, { Cookie: "__Host-goober_session=" + token }),
      env,
    );
    assert.equal(response.status, 101, kind + " / " + membershipRole);
    assert.deepEqual(env.ROOMS.names, ["channel:90"]);
  }
});

// The evaluator + gate contract shared with the routes: one final sanity read.
test("the route enforcement agrees with the pure evaluator on the private shape", async () => {
  const chain = [
    { channel_id: 90, category_id: null, role_id: null, allow_mask: 0, deny_mask: V },
    { channel_id: 90, category_id: null, role_id: 5, allow_mask: V, deny_mask: 0 },
  ];
  const holder = effectivePermissions([{ id: 5, permissions: 0 }], chain);
  const stranger = effectivePermissions([{ id: 6, permissions: 0 }], chain);
  assert.ok(holder & V, "the role holder reads");
  assert.ok(!(stranger & V), "the plain member gets the 404 at the history gate");
});

test("the gate chain read carries channel_id (the evaluator classifies rows by shape)", async () => {
  // The evaluator separates a channel layer from a category layer BY SHAPE
  // (channel-layer rows: channel_id set, category_id null) — the gate's own
  // SELECT must ship that column or its channel rows would arrive as neither
  // and silently drop out of the walk (the gate and the list payload would
  // resolve differently — the exact drift the shared evaluator exists to
  // prevent).
  const captured = [];
  const db = {
    prepare(sql) {
      captured.push(sql);
      return {
        bind: () => ({
          first: async () => (sql.startsWith("SELECT role FROM gc_server_members")
            ? { role: "member" }
            : null),
          all: async () => ({ results: [] }),
        }),
      };
    },
  };
  await enforceChannelBits({ GOOBER_DB: db }, { id: 90, server_id: 3, kind: "text" }, 7, ["SEND"]);
  const chain = captured.find((sql) => sql.includes("FROM gc_channel_overwrites o "));
  assert.match(chain, /SELECT o\.channel_id AS channel_id/,
    "a channel-layer row keeps its shape through the gate's own read");
  const roles = captured.find((sql) => sql.includes("FROM gc_member_roles gmr"));
  assert.match(roles, /SELECT r\.id AS id, r\.permissions AS permissions/, "the role rows ride too");
});
