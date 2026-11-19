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

// Phase-3 role foundation (routes in api/servers.mjs, helpers in
// api/permissions.mjs): the fakeDb + pinned-SQL contract style of the
// servers/discovery test modules. Roles ADD moderation powers only — the
// graceful-default promise (a server with no roles row behaves exactly like
// today) is pinned by the channel-create/invite tests riding BOTH kinds of
// guard in one statement each.
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import {
  ALL_SERVER_PERMISSIONS,
  canActOnMember,
  canManageRoleAt,
  hasAllPermissions,
  hasPermission,
  highestPosition,
  permissionNames,
  SERVER_PERMISSIONS,
} from "../api/permissions.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { MAX_CHANNELS_PER_SERVER, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;

// --- shared fake/db/session scaffolding (same conventions as servers-module) ----

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function request(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleServerRoutes(
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

// A signed-in env with every limiter accepting (the per-route limiter tests
// build one WITHOUT the binding instead).
function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function authed(path) {
  const { token, csrf, row } = await sessionFixtures();
  const call = (method, body, headers = {}) =>
    request(method, path, body, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
      ...headers,
    });
  return { token, csrf, row, call };
}

// --- api/permissions.mjs: the pure hierarchy layer ------------------------------

test("SERVER_PERMISSIONS pins the named bits and the owner mask", () => {
  assert.deepEqual(permissionNames(ALL_SERVER_PERMISSIONS).sort(), [
    "ADD_REACTIONS", "BYPASS_SLOWMODE", "CONNECT", "DELETE_MESSAGES", "KICK_MEMBERS",
    "MANAGE_CHANNELS", "MANAGE_EMOJI", "MANAGE_INVITES", "MANAGE_ROLES", "MENTION_EVERYONE",
    "SEND", "SPEAK", "VIEW",
  ].sort());
  assert.equal(SERVER_PERMISSIONS.MANAGE_CHANNELS, 1);
  assert.equal(SERVER_PERMISSIONS.MANAGE_ROLES, 2);
  assert.equal(SERVER_PERMISSIONS.KICK_MEMBERS, 4);
  assert.equal(SERVER_PERMISSIONS.MANAGE_INVITES, 8);
  assert.equal(SERVER_PERMISSIONS.DELETE_MESSAGES, 16);
  assert.equal(SERVER_PERMISSIONS.VIEW, 32);
  assert.equal(SERVER_PERMISSIONS.ADD_REACTIONS, 1024);
  assert.equal(SERVER_PERMISSIONS.MANAGE_EMOJI, 2048,
    "the emoji CRUD bit slots right after the reactions bit, server-scope only");
  assert.equal(SERVER_PERMISSIONS.MENTION_EVERYONE, 4096,
    "the mentions bit takes the next free position, server-scope only (the @everyone gate)");
  // A named-bit wire form survives re-orders; unknown names never pass.
  assert.deepEqual(permissionNames(0), []);
});

test("hasPermission / hasAllPermissions: the owner tier satisfies any bit, members need it set", () => {
  assert.equal(hasPermission("owner", 0, SERVER_PERMISSIONS.MANAGE_ROLES), true);
  assert.equal(hasAllPermissions("owner", 0, [4, 2]), true);
  // A plain member with no roles: no extra powers.
  assert.equal(hasPermission("member", 0, SERVER_PERMISSIONS.KICK_MEMBERS), false);
  // The bits may ride different roles — the merged mask is what counts.
  assert.equal(hasPermission("member", 4 | 2, SERVER_PERMISSIONS.KICK_MEMBERS), true);
  assert.equal(hasAllPermissions("member", 4, [4, 2]), false, "two-bit tools need BOTH bits");
  assert.equal(hasAllPermissions("member", 4 | 2, [4, 2]), true);
});

test("highestPosition: -1 for a roleless/absent member, the max across rows otherwise", () => {
  assert.equal(highestPosition([]), -1);
  assert.equal(highestPosition(undefined), -1);
  assert.equal(highestPosition([{ position: 3 }, { position: 9 }, { position: 1 }]), 9);
  assert.equal(highestPosition([{}]), -1);
});

test("canManageRoleAt: strictly-below-your-top, owners bypass", () => {
  assert.equal(canManageRoleAt(false, 5, 4), true);
  assert.equal(canManageRoleAt(false, 5, 5), false, "equal position is out of reach");
  assert.equal(canManageRoleAt(false, 5, 6), false);
  assert.equal(canManageRoleAt(false, -1, 0), false, "the roleless manage nothing");
  assert.equal(canManageRoleAt(true, -1, 99), true, "the owner bypasses everything");
});

test("canActOnMember: KICK/MANAGE acts only on strictly lower positions", () => {
  assert.equal(canActOnMember(false, 3, 2), true);
  assert.equal(canActOnMember(false, 3, 3), false, "no acting on peers");
  assert.equal(canActOnMember(false, 3, -1), true, "a positioned moderator outranks the roleless");
  assert.equal(canActOnMember(false, -1, -1), false, "two roleless members share no hierarchy");
  assert.equal(canActOnMember(true, -1, 99), true);
});

// --- SQL shape pins -------------------------------------------------------------

const ACTOR_CONTEXT_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("AS position") &&
  sql.includes("FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?");

const ROLE_SELECT_TEST = (sql) =>
  sql.includes("SELECT id, name, color, position, permissions FROM gc_roles WHERE id = ? AND server_id = ?");

const ROLE_LIST_TEST = (sql) =>
  sql.includes("SELECT id, name, color, position, permissions FROM gc_roles") &&
  sql.includes("WHERE server_id = ?") && sql.includes("ORDER BY position DESC, id DESC");

function actorContextRoute({ role = "member", permissions = 0, position = -1, nickname = null } = {}) {
  return {
    test: ACTOR_CONTEXT_TEST,
    first: async () => ({ role, permissions, position, nickname }),
  };
}

// --- GET /api/servers/:id/roles ---------------------------------------------------

test("GET roles hands the strongest-first list plus the viewer's named bits", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "member", permissions: SERVER_PERMISSIONS.MANAGE_ROLES, position: 5 }),
    {
      test: ROLE_LIST_TEST,
      all: async () => ({
        results: [
          { id: 4, name: "Mods", color: "#397357", position: 3, permissions: 4 },
          { id: 5, name: "DJ", color: null, position: 1, permissions: 0 },
        ],
      }),
    },
  ]);
  const response = await dispatch(call("GET"), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    roles: [
      { id: 4, name: "Mods", color: "#397357", position: 3, permissions: ["KICK_MEMBERS"] },
      { id: 5, name: "DJ", color: null, position: 1, permissions: [] },
    ],
    // The roster/roles viewer block: named bits survive schema re-orders.
    viewer: { owner: false, permissions: ["MANAGE_ROLES"], topPosition: 5 },
  });
});

test("GET roles demands membership (one shared 403, no server-existence oracle)", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: ACTOR_CONTEXT_TEST, first: async () => null },
  ]);
  const response = await dispatch(call("GET"), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
});

test("the roles read rides a server-scoped read limiter (server + user identity)", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const identities = [];
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: ACTOR_CONTEXT_TEST,
      first: async () => ({ role: "owner", permissions: 0, position: -1 }),
    },
    { test: ROLE_LIST_TEST, all: async () => ({ results: [] }) },
  ]);
  const env = {
    GOOBER_DB: db,
    [RATE_LIMIT_BINDINGS.read]: { limit: async ({ key }) => { identities.push(key); return { success: true }; } },
  };
  await dispatch(call("GET"), env);
  // The limiter ran BEFORE any membership read: the identity is hashed, so
  // only its presence can be asserted — one call, after zero DB statements.
  assert.equal(identities.length, 1);
  assert.equal(db.calls.find((entry) => entry.call === "first") !== undefined, true);
});

test("GET roles 503s when its read limiter is not configured", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: ACTOR_CONTEXT_TEST, first: async () => null },
  ]);
  const response = await dispatch(call("GET"), { GOOBER_DB: db });
  assert.equal(response.status, 503);
  // The limiter runs before any membership read: the fake DB answered nothing.
  assert.deepEqual(db.calls.filter((entry) => entry.call !== "first"), []);
});

// --- POST /api/servers/:id/roles -------------------------------------------------

test("creating a role appends at the bottom inside one guarded INSERT ... SELECT", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("INSERT INTO gc_roles"),
      run: (bound) => {
        // The guard carried INSIDE the INSERT: a MANAGE_ROLES mask member at
        // any position may create (assignment stays hierarchy-ruled).
        const serverId = bound[0];
        if (Number(serverId) !== 3 || Number(bound[7]) !== USER_ID) {
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 1, last_row_id: 30 } };
      },
    },
    {
      test: ROLE_SELECT_TEST,
      first: async () => ({
        id: 30, name: "DJ", color: "#f3cf67", position: 2,
        permissions: SERVER_PERMISSIONS.MANAGE_INVITES,
      }),
    },
  ]);

  const response = await dispatch(
    call("POST", { name: "DJ", color: "#f3cf67", permissions: ["MANAGE_INVITES"] }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  // Colors ride in exactly as sent — the wire's strict-lowercase #rrggbb
  // contract (uppercase 400s in the validation test below).
  assert.deepEqual(await bodyOf(response), {
    role: { id: 30, name: "DJ", color: "#f3cf67", position: 2, permissions: ["MANAGE_INVITES"] },
  });

  const insert = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("INSERT INTO gc_roles"));
  assert.match(insert.sql, /INSERT INTO gc_roles \(server_id, name, color, position, permissions, created_at\)/);
  assert.match(insert.sql, /SELECT COALESCE\(MAX\(position\), -1\) \+ 1 FROM gc_roles WHERE server_id = \?\)/);
  // The RBAC audit's H1 repair: the manage rider is the per-bit EXISTS (exact
  // OR semantics — SUM carried 2×MANAGE_ROLES into a phantom KICK_MEMBERS).
  assert.match(insert.sql, /OR \(EXISTS \(SELECT 1 FROM gc_member_roles gbm2 JOIN gc_roles gbr2/);
  assert.match(insert.sql, /\(gbr2\.permissions & 2\) <> 0/);
  // The new role's permissions arrive as the merged INTEGER mask.
  assert.equal(insert.bound[4], SERVER_PERMISSIONS.MANAGE_INVITES);
  // The owner rider + the per-bit rider, both inside the WHERE — then the
  // parity-P0 role-cap arm's server bind (the count precondition rides the
  // same INSERT, so the cap gates the owner too).
  assert.match(insert.sql, /AND \(SELECT COUNT\(\*\) FROM gc_roles WHERE server_id = \?\) <= /);
  assert.deepEqual(insert.bound.slice(6), [3, USER_ID, 3, USER_ID, 3]);
});

test("role create validates the name and color before any statement runs", async () => {
  for (const body of [
    { name: "   " },
    { name: "DJ", color: "red" },
    { name: "DJ", color: "#FFAA00" },
    { name: "DJ", permissions: ["NOT_A_BIT"] },
    { color: "#397357" },
  ]) {
    const { row, call } = await authed("/api/servers/3/roles");
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("POST", body), envWithLimiters(db));
    assert.equal(response.status, 400, JSON.stringify(body) + " must 400");
    assert.deepEqual(
      db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
      [],
    );
  }
});

// parity-limits.md: Role name length 1–100 (verified 2026-11-17, migration
// 0024 widened both gc_roles' and gc_channel_categories' 32-char CHECKs to
// match) — the ROUTE bound mirrors the widened CHECK so an oversized name
// 400s instead of 500-ing on the constraint, and the 100th character is
// lawful end to end.
test("role names ride the parity law's 1–100 bound (32-char names long legal, 101 refused)", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("INSERT INTO gc_roles"),
      run: () => ({ meta: { changes: 1, last_row_id: 30 } }),
    },
    {
      test: ROLE_SELECT_TEST,
      first: async () => ({ id: 30, name: "r".repeat(100), color: null, position: 2, permissions: 0 }),
    },
  ]);
  const accepted = await dispatch(call("POST", { name: "r".repeat(100) }), envWithLimiters(db));
  assert.equal(accepted.status, 201);
  assert.equal((await bodyOf(accepted)).role.name, "r".repeat(100));

  const refusedDb = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const refused = await dispatch(call("POST", { name: "s".repeat(101) }), envWithLimiters(refusedDb));
  assert.equal(refused.status, 400);
  assert.deepEqual(await bodyOf(refused), {
    error: "Role name must be between 1 and 100 characters.",
  });
  assert.deepEqual(
    refusedDb.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
    [],
    "an oversized name refuses before any statement runs",
  );
});

test("a non-privileged creator's role INSERT 403s with zero changes", async () => {
  const { row, call } = await authed("/api/servers/3/roles");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.includes("INSERT INTO gc_roles"), run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("POST", { name: "DJ" }), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
});

// --- PATCH /api/servers/:id/roles/:role_id ----------------------------------------

const ROLE_UPDATE_TEST = (sql) =>
  sql.includes("UPDATE gc_roles") && sql.includes("gc_roles.position <");

async function roleUpdateRoutes({ roleRow, actor }) {
  return [
    actorContextRoute(actor),
    { test: ROLE_SELECT_TEST, first: async () => roleRow },
    {
      test: ROLE_UPDATE_TEST,
      run: (bound) => ({ meta: { changes: 1 } }),
    },
    { test: ROLE_SELECT_TEST, first: async () => roleRow },
  ];
}

test("renaming a role rides the position-guarded UPDATE (old position < caller top)", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const routes = await roleUpdateRoutes({
    roleRow: { id: 4, name: "Mods", color: null, position: 3, permissions: 4 },
    actor: { role: "member", permissions: SERVER_PERMISSIONS.MANAGE_ROLES, position: 5 },
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const response = await dispatch(
    call("PATCH", { name: "Moderators", color: "#f3cf67" }),
    envWithLimiters(db),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    role: { id: 4, name: "Mods", color: null, position: 3, permissions: ["KICK_MEMBERS"] },
  });

  const update = db.calls.find((entry) => entry.call === "run" && ROLE_UPDATE_TEST(entry.sql));
  assert.match(update.sql, /UPDATE gc_roles SET name = \?, color = \? WHERE id = \? AND server_id = \?/);
  // The guard inside the WHERE: owner OR (mask & MANAGE_ROLES = MANAGE_ROLES
  // AND the row's position strictly below the caller's top).
  assert.match(update.sql, /EXISTS \(SELECT 1 FROM gc_server_members om/);
  assert.match(update.sql, /gc_roles\.position < \(SELECT COALESCE\(MAX\(hr\.position\), -1\)/);
  assert.deepEqual(update.bound, ["Moderators", "#f3cf67", 4, 3, 3, USER_ID, 3, USER_ID, 3, USER_ID]);

  // No write batch on a rename: one guarded UPDATE, no fan-out.
  assert.deepEqual(db.calls.filter((entry) => entry.call === "batch"), []);
});

test("a role above the caller's top position cannot be renamed (even with MANAGE_ROLES)", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const routes = await roleUpdateRoutes({
    roleRow: { id: 4, name: "High", color: null, position: 9, permissions: 0 },
    actor: { role: "member", permissions: SERVER_PERMISSIONS.MANAGE_ROLES, position: 5 },
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const response = await dispatch(call("PATCH", { name: "Renamed" }), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(
    db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
    [],
  );
});

test("the owner may act on any role position", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const routes = await roleUpdateRoutes({
    roleRow: { id: 4, name: "High", color: null, position: 99, permissions: 0 },
    actor: { role: "owner", permissions: 0, position: -1 },
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const response = await dispatch(call("PATCH", { name: "Renamed" }), envWithLimiters(db));
  assert.equal(response.status, 200);
});

test("moving a role to an occupied slot is a batched, position-guarded swap", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
    { test: ROLE_SELECT_TEST, first: async () => ({ id: 4, name: "A", color: null, position: 1, permissions: 0 }) },
    {
      test: (sql) => sql.includes("SELECT COALESCE(MAX(position), -1) AS max_position FROM gc_roles"),
      first: async () => ({ max_position: 3 }),
    },
    {
      test: (sql) => sql.includes("SELECT id FROM gc_roles WHERE server_id = ? AND position = ? AND id <> ?"),
      first: async () => ({ id: 8 }),
    },
    { test: ROLE_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: ROLE_SELECT_TEST, first: async () => ({ id: 4, name: "A", color: null, position: 2, permissions: 0 }) },
  ]);
  const response = await dispatch(call("PATCH", { position: 2 }), envWithLimiters(db));
  assert.equal(response.status, 200);

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  const sqls = batch.statements.map((stmt) => stmt.sql);
  assert.match(sqls[0], /UPDATE gc_roles SET position = \? WHERE id = \? AND server_id = \? AND position = \?/);
  assert.match(sqls[0], /gc_roles\.position < /);
  assert.match(sqls[1], /UPDATE gc_roles SET position = \? WHERE id = \? AND server_id = \? AND position = \?/);
  // Statement 1: target moves UP to the partner's slot; its bindings carry
  // (newPos, targetId, serverId, oldPos) then the guard's owns.
  assert.deepEqual(
    batch.statements[0].bound.slice(0, 4), [2, 4, 3, 1],
  );
  // Statement 2: the partner takes the target's old slot.
  assert.deepEqual(
    batch.statements[1].bound.slice(0, 4), [1, 8, 3, 2],
  );
});

test("a move past the position ceiling 400s before any batch", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
    { test: ROLE_SELECT_TEST, first: async () => ({ id: 4, name: "A", color: null, position: 1, permissions: 0 }) },
    {
      test: (sql) => sql.includes("SELECT COALESCE(MAX(position), -1) AS max_position FROM gc_roles"),
      first: async () => ({ max_position: 3 }),
    },
  ]);
  const response = await dispatch(call("PATCH", { position: 4 }), envWithLimiters(db));
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "position must be between 0 and 3." });
  assert.deepEqual(db.calls.filter((entry) => entry.call === "batch"), []);
});

test("an unknown role PATCH 404s (classified after the membership read)", async () => {
  const { row, call } = await authed("/api/servers/3/roles/99");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "owner", permissions: 0, position: -1 }),
    { test: ROLE_SELECT_TEST, first: async () => null },
  ]);
  const response = await dispatch(call("PATCH", { name: "Nope" }), envWithLimiters(db));
  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "That role does not exist." });
});

// --- DELETE /api/servers/:id/roles/:role_id ---------------------------------------

test("deleting a role deletes the row and fans its assignments out in ONE batch", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "member", permissions: SERVER_PERMISSIONS.MANAGE_ROLES, position: 5 }),
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { deleted: true, roleId: 4 });

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  const sqls = batch.statements.map((stmt) => stmt.sql);
  assert.match(sqls[0], /DELETE FROM gc_roles WHERE id = \? AND server_id = \? AND/);
  assert.match(sqls[0], /gc_member_roles gbm2 JOIN gc_roles gbr2/);
  assert.match(sqls[0], /gc_roles\.position < /);
  assert.match(
    sqls[1],
    /DELETE FROM gc_member_roles WHERE role_id = \? AND server_id = \? AND NOT EXISTS[\s\S]*SELECT 1 FROM gc_roles WHERE id = \? AND server_id = \?/s,
  );
  // The assignment fan-out only touches rows once the role row VANISHED —
  // a refused delete can never strip assignments ahead of itself.
  assert.deepEqual(
    batch.statements[1].bound,
    [4, 3, 4, 3],
  );
});

test("deleting a role above the caller's top position 403s with zero changes", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    actorContextRoute({ role: "member", permissions: SERVER_PERMISSIONS.MANAGE_ROLES, position: 1 }),
    {
      test: (sql) => sql.includes("DELETE FROM gc_roles"),
      run: async () => ({ meta: { changes: 0 } }),
    },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 403);
  // The batch still ran (both statements carried the same guard), but the
  // first refused, so nothing was assigned away.
  assert.equal(db.calls.find((entry) => entry.call === "batch") !== undefined, true);
});

// --- PUT/DELETE /api/servers/:id/roles/:role_id/members/:user_id -------------------

const ASSIGN_INSERT_TEST = (sql) =>
  sql.includes("INSERT OR IGNORE INTO gc_member_roles (server_id, user_id, role_id)");
const ASSIGNMENT_SELECT_TEST = (sql) =>
  sql.includes("SELECT role_id FROM gc_member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?");
const UNASSIGN_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?");

function assignmentRoutes({ roleRow, assignments = [], memberExists = true, position = -1 } = {}) {
  return [
    {
      test: ROLE_SELECT_TEST,
      first: async () => roleRow,
    },
    {
      test: (sql) =>
        sql.includes("FROM gc_member_roles hmr JOIN gc_roles hr ON hr.id = hmr.role_id") &&
        sql.includes("FROM gc_server_members WHERE server_id = ?"),
      first: async () => (memberExists ? { position } : null),
    },
    { test: ASSIGNMENT_SELECT_TEST, first: async () => (assignments.includes(roleRow?.id) ? { role_id: roleRow.id } : null) },
  ];
}

test("PUT assignment re-asserts the whole rule inside the INSERT ... SELECT", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    ...assignmentRoutes({ roleRow: { id: 4, name: "Mods", color: null, position: 3, permissions: 4 } }),
  ]);

  const response = await dispatch(call("PUT"), envWithLimiters(db));
  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    assigned: true, changed: true, roleId: 4, userId: TARGET_ID,
  });

  const insert = db.calls.find((entry) => entry.call === "run" && ASSIGN_INSERT_TEST(entry.sql));
  assert.match(insert.sql, /WHERE EXISTS \(SELECT 1 FROM gc_server_members tm WHERE tm\.server_id = \? AND tm\.user_id = \?\)/);
  // The position rule pinned INSIDE the statement: the role's position is
  // strictly below the ASSIGNER's top position.
  assert.match(insert.sql, /\(SELECT position FROM gc_roles WHERE id = \? AND server_id = \?\) < \(SELECT COALESCE\(MAX\(hr\.position\), -1\)/);
  // Bindings, in fragment order: the SELECT triple, the target-membership
  // pair, the owner rider, the merged-mask rider, then the position compare.
  assert.deepEqual(insert.bound, [
    3, TARGET_ID, 4,
    3, TARGET_ID,
    3, USER_ID, 3, USER_ID,
    4, 3, 3, USER_ID,
  ]);
});

test("re-assigning an existing role is idempotent (changes nothing, 200)", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    ...assignmentRoutes({
      roleRow: { id: 4, name: "Mods", color: null, position: 3, permissions: 4 },
      assignments: [4],
    }),
  ]);
  const response = await dispatch(call("PUT"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    assigned: true, changed: false, roleId: 4, userId: TARGET_ID,
  });
  assert.equal(db.calls.find((entry) => entry.call === "run" || entry.call === "batch"), undefined);
});

test("PUT assignment 404s for a role outside this server and for a non-member target", async () => {
  {
    const { row, call } = await authed("/api/servers/3/roles/99/members/" + TARGET_ID);
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: ROLE_SELECT_TEST, first: async () => null },
    ]);
    const response = await dispatch(call("PUT"), envWithLimiters(db));
    assert.equal(response.status, 404);
    assert.deepEqual(await bodyOf(response), { error: "That role does not exist." });
  }
  {
    const { row, call } = await authed("/api/servers/3/roles/4/members/" + TARGET_ID);
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      {
        test: ROLE_SELECT_TEST,
        first: async () => ({ id: 4, name: "Mods", color: null, position: 3, permissions: 4 }),
      },
      {
        test: (sql) => sql.includes("FROM gc_server_members WHERE server_id = ? AND user_id = ?"),
        first: async () => null,
      },
    ]);
    const response = await dispatch(call("PUT"), envWithLimiters(db));
    assert.equal(response.status, 404);
    assert.deepEqual(await bodyOf(response), { error: "That member is not in this server." });
  }
});

test("a refused assignment INSERT 403s (the guard rode the statement)", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    ...assignmentRoutes({ roleRow: { id: 4, name: "Mods", color: null, position: 3, permissions: 4 } }),
    { test: ASSIGN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("PUT"), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
});

test("DELETE unassignment carries the same guard inside the DELETE", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: UNASSIGN_DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { assigned: false, roleId: 4, userId: TARGET_ID });

  const remove = db.calls.find((entry) => entry.call === "run" && UNASSIGN_DELETE_TEST(entry.sql));
  assert.match(remove.sql, /\(SELECT position FROM gc_roles WHERE id = \? AND server_id = \?\) < /);
  assert.match(remove.sql, /gc_member_roles gbm2 JOIN gc_roles gbr2/);
  assert.deepEqual(remove.bound, [
    3, TARGET_ID, 4,
    3, USER_ID, 3, USER_ID,
    4, 3, 3, USER_ID,
  ]);
});

test("unassigning a role the caller cannot act on 403s without touching the assignment", async () => {
  const { row, call } = await authed("/api/servers/3/roles/4/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: UNASSIGN_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 403);
});

// --- GET /api/servers/:id/roster ---------------------------------------------------

const ROSTER_MEMBERS_TEST = (sql) => sql.includes("JOIN users u ON u.id = m.user_id");
const ROSTER_ASSIGN_TEST = (sql) =>
  sql.includes("SELECT user_id, role_id FROM gc_member_roles WHERE server_id = ?");

async function rosterDb({ role = "member", nickname = null } = {}) {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: ACTOR_CONTEXT_TEST,
      first: async () => ({ role, permissions: role === "owner" ? 0 : 4, position: role === "owner" ? -1 : 3, nickname }),
    },
    {
      test: ROSTER_MEMBERS_TEST,
      all: async () => ({
        results: [
          { id: 10, username: "ada", membership_role: "owner", nickname: "Chief", avatar_mime: "image/png", avatar_version: 2 },
          { id: 11, username: "grace", membership_role: "member", nickname: null, avatar_mime: null, avatar_version: null },
          { id: 12, username: "linus", membership_role: "member", nickname: null, avatar_mime: null, avatar_version: null },
        ],
      }),
    },
    {
      test: ROLE_LIST_TEST,
      all: async () => ({
        results: [
          { id: 4, name: "Mods", color: "#397357", position: 3, permissions: 4 },
          { id: 5, name: "DJ", color: null, position: 1, permissions: 0 },
        ],
      }),
    },
    {
      test: ROSTER_ASSIGN_TEST,
      all: async () => ({
        results: [
          { user_id: 11, role_id: 4 },
          { user_id: 11, role_id: 5 },
          { user_id: 12, role_id: 5 },
        ],
      }),
    },
  ]);
  const getRequest = new Request(ORIGIN + "/api/servers/3/roster", {
    headers: { Cookie: "goober_session=" + token },
  });
  return { db, getRequest };
}

test("the roster payload carries ids, names, nicknames, avatars, roleIds (strongest first), and colors", async () => {
  const { db, getRequest } = await rosterDb();
  const response = await dispatch(getRequest, envWithLimiters(db));

  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.server.id, 3);
  assert.deepEqual(body.viewer, { owner: false, permissions: ["KICK_MEMBERS"], topPosition: 3 });
  // The 0008 mod-desk columns ride the same members payload: joinedAt and the
  // account-age source (ISO, null when the row shape predates them), the
  // timeout and the invite attribution ONLY when set, and the verification
  // eligibility only when the server has a level on (this fixture: none).
  assert.deepEqual(body.members, [
    {
      id: 10, username: "ada", nickname: "Chief", avatarUrl: "/api/avatars/10?v=2",
      membershipRole: "owner", isPlus: false, roleIds: [], color: null, topPosition: -1,
      joinedAt: null, accountCreatedAt: null,
    },
    {
      id: 11, username: "grace", nickname: null, avatarUrl: null,
      membershipRole: "member", isPlus: false, roleIds: [4, 5], color: "#397357", topPosition: 3,
      joinedAt: null, accountCreatedAt: null,
    },
    {
      id: 12, username: "linus", nickname: null, avatarUrl: null,
      membershipRole: "member", isPlus: false, roleIds: [5], color: null, topPosition: 1,
      joinedAt: null, accountCreatedAt: null,
    },
  ]);
  assert.deepEqual(body.roles[0], {
    id: 4, name: "Mods", color: "#397357", position: 3, permissions: ["KICK_MEMBERS"],
  });
  // The mod-desk viewer class (owner OR KICK_MEMBERS) gets the bans array —
  // an empty one on a server with no rows.
  assert.deepEqual(body.bans, []);
});

test("the roster read rides the server-scoped limiter (and refuses when absent)", async () => {
  // The limiter runs BEFORE any membership read: one hashed identity per
  // (server, user) pair, never a shared pool with another server's reads.
  const { db, getRequest } = await rosterDb();
  const identities = [];
  const env = {
    GOOBER_DB: db,
    [RATE_LIMIT_BINDINGS.read]: {
      limit: async ({ key }) => { identities.push(key); return { success: true }; },
    },
  };
  await dispatch(getRequest, env);
  assert.equal(identities.length, 1, "one rate-limit key per roster read");

  // Missing membership answers the shared 403 even with the limiter present.
  const actorless = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await sessionFixtures()).row },
    { test: ACTOR_CONTEXT_TEST, first: async () => null },
  ]);
  const refused = await dispatch(getRequest, envWithLimiters(actorless));
  assert.equal(refused.status, 403);

  // Without the read limiter at all: 503 before any roster statement.
  const bareGet = fakeDb([{ test: SESSION_READ_TEST, first: async () => (await sessionFixtures()).row }]);
  const unconfigured = await dispatch(getRequest, { GOOBER_DB: bareGet });
  assert.equal(unconfigured.status, 503, "the read limiter is required, not best-effort");
});

// --- DELETE /api/servers/:id/members/:user_id (kick) --------------------------------

const KICK_MEMBERS_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ?");
const KICK_ROLES_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ?");

test("a kick is ONE batch: roles + boost strips, member row, recount — the same guard", async () => {
  const { row, call } = await authed("/api/servers/3/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { kicked: true, serverId: 3, userId: TARGET_ID });

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 4);
  // Batch ORDER: [roles strip, boost strip, member DELETE, recount] — the
  // strips ride BEFORE the member row (their membership-EXISTS arms die the
  // moment it fires) and the recount rides LAST, in-batch (the leave shape).
  assert.match(batch.statements[0].sql, /^DELETE FROM gc_member_roles/);
  assert.match(batch.statements[1].sql, /^DELETE FROM gc_server_boosts/);
  assert.match(batch.statements[2].sql, /^DELETE FROM gc_server_members/);
  assert.match(batch.statements[3].sql, /^UPDATE gc_servers SET boosts =/);
  // The strips carry the target's membership-EXISTS + role <> 'owner' arm
  // (a refused kick — owner target included — strips nothing) plus the SAME
  // guard the member DELETE wore.
  for (const index of [0, 1]) {
    assert.match(
      batch.statements[index].sql,
      /EXISTS \(SELECT 1 FROM gc_server_members ks WHERE ks\.server_id = \? AND ks\.user_id = \? AND ks\.role <> 'owner'\)/,
    );
  }
  const [assignments, boosts, membership, recount] = batch.statements.map((stmt) => stmt.sql);
  // The owner row can never be kicked away.
  assert.match(membership, /DELETE FROM gc_server_members WHERE server_id = \? AND user_id = \? AND role <> 'owner' AND/);
  // The RBAC audit's H1 repair: the exact-KICK test is the per-bit EXISTS.
  assert.match(membership, /gc_member_roles gbm4 JOIN gc_roles gbr4/);
  assert.match(membership, /\(gbr4\.permissions & 4\) <> 0/);
  assert.match(membership, /\(SELECT COALESCE\(MAX\(hr\.position\), -1\) FROM gc_member_roles hmr[\s\S]*>[\s\S]*\(SELECT COALESCE\(MAX\(hr\.position\), -1\)/);
  // IDENTICAL guard on the assignment half — a refused kick can never strip
  // a member who stayed.
  // IDENTICAL guard on the assignment half — a refused kick can never strip
  // a member who stayed (the strip's tail is the guard's OWNER-or-KICK arm
  // closing; the membership arm sits ahead of it).
  assert.match(assignments, /DELETE FROM gc_member_roles WHERE server_id = \? AND user_id = \?/);
  assert.match(assignments, /EXISTS \(SELECT 1 FROM gc_server_members ks WHERE ks\.server_id = \? AND ks\.user_id = \? AND ks\.role <> 'owner'\) AND \(EXISTS/);
  assert.equal(recount.includes("DELETE"), false);
  // Each guarded statement carries the KICK-membership guard (the per-bit
  // EXISTS pair) plus the position compares; the strips prepend their own
  // (serverId, targetId) pair, and the recount binds (serverId, serverId).
  const guardBinds = [
    3, USER_ID, 3, USER_ID, 3, USER_ID, 3, USER_ID, 3, TARGET_ID,
  ];
  for (const statement of batch.statements.slice(0, 3)) {
    assert.deepEqual(statement.bound.slice(-10), guardBinds);
  }
  assert.deepEqual(batch.statements[0].bound.slice(0, 4), [3, TARGET_ID, 3, TARGET_ID]);
  assert.deepEqual(batch.statements[1].bound.slice(0, 4), [3, TARGET_ID, 3, TARGET_ID]);
  assert.deepEqual(batch.statements[2].bound.slice(0, 2), [3, TARGET_ID]);
  assert.deepEqual(batch.statements[3].bound, [3, 3]);
});

test("a refused kick 403s without a diagnostic read (no existence oracle)", async () => {
  const { row, call } = await authed("/api/servers/3/members/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: KICK_MEMBERS_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: KICK_ROLES_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("DELETE"), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
});

// --- PATCH /api/servers/:id/nick and /nick/:user_id ----------------------------------

const NICK_SELF_TEST = (sql) =>
  sql.startsWith("UPDATE gc_server_members SET nickname = ? WHERE server_id = ? AND user_id = ?") &&
  !sql.includes("role <> 'owner'");

test("PATCH nick is self-serve: one unchecked UPDATE plus the write-tier limiter", async () => {
  const { row, call } = await authed("/api/servers/3/nick");
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(call("PATCH", { nickname: "Wempos of Goober" }), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    member: { serverId: 3, userId: USER_ID, nickname: "Wempos of Goober" },
  });

  const update = db.calls.find((entry) => entry.call === "run" && NICK_SELF_TEST(entry.sql));
  assert.equal(update.sql, "UPDATE gc_server_members SET nickname = ? WHERE server_id = ? AND user_id = ?");
  assert.deepEqual(update.bound, ["Wempos of Goober", 3, USER_ID]);
});

test("PATCH nick accepts null/empty as a CLEAR and bounds the value at 32 chars", async () => {
  {
    const { row, call } = await authed("/api/servers/3/nick");
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PATCH", { nickname: null }), envWithLimiters(db));
    assert.equal(response.status, 200);
    const update = db.calls.find((entry) => NICK_SELF_TEST(entry.sql));
    assert.equal(update.bound[0], null);
  }
  {
    const { row, call } = await authed("/api/servers/3/nick");
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PATCH", { nickname: "x".repeat(33) }), envWithLimiters(db));
    assert.equal(response.status, 400);
    assert.deepEqual(await bodyOf(response), {
      error: "Nickname must be between 1 and 32 characters.",
    });
  }
});

test("PATCH nick requires the write limiter like every other mutation", async () => {
  const { row, call } = await authed("/api/servers/3/nick");
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(call("PATCH", { nickname: "Wempos" }), { GOOBER_DB: db });
  assert.equal(response.status, 503);
});

test("PATCH nick/:user_id is the MANAGE-NICKNAME tool: KICK+MANAGE_ROLES inside the UPDATE", async () => {
  const { row, call } = await authed("/api/servers/3/nick/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) =>
        sql.startsWith("UPDATE gc_server_members SET nickname = ?") &&
        sql.includes("role <> 'owner'"),
      run: async () => ({ meta: { changes: 1 } }),
    },
  ]);
  const response = await dispatch(call("PATCH", { nickname: "Renamed" }), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    member: { serverId: 3, userId: TARGET_ID, nickname: "Renamed" },
  });

  const update = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("role <> 'owner'"));
  // The filed split: Manage-Nickname = KICK_MEMBERS + MANAGE_ROLES, in the
  // H1 per-bit-EXISTS form (one EXISTS arm per bit), with the position rule
  // and the owner-row protection inside the statement.
  assert.match(update.sql, /UPDATE gc_server_members SET nickname = \? WHERE server_id = \? AND user_id = \? AND role <> 'owner' AND/);
  assert.match(update.sql, /gc_member_roles gbm4 JOIN gc_roles gbr4/);
  assert.match(update.sql, /\(gbr4\.permissions & 4\) <> 0/);
  assert.match(update.sql, /gc_member_roles gbm2 JOIN gc_roles gbr2/);
  assert.match(update.sql, /\(gbr2\.permissions & 2\) <> 0/);
  assert.match(update.sql, /\(SELECT COALESCE\(MAX\(hr\.position\), -1\)[\s\S]*>[\s\S]\(SELECT COALESCE\(MAX\(hr\.position\), -1\)/);
  // The per-bit pair binds (server, actor) per bit — no mask pair rides.
  assert.deepEqual(update.bound, [
    "Renamed", 3, TARGET_ID,
    3, USER_ID, 3, USER_ID, 3, USER_ID, 3, USER_ID, 3, USER_ID, 3, TARGET_ID,
  ]);
});

test("PATCH nick/:user_id refuses a non-permitted rename with zero changes", async () => {
  const { row, call } = await authed("/api/servers/3/nick/" + TARGET_ID);
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.startsWith("UPDATE gc_server_members SET nickname = ?"),
      run: async () => ({ meta: { changes: 0 } }),
    },
  ]);
  const response = await dispatch(call("PATCH", { nickname: "Renamed" }), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
});

// --- PATCH /api/servers/:id/channels/:channel_id (spoiler flag) -----------------------

const SPOILER_UPDATE_TEST = (sql) =>
  sql.startsWith("UPDATE gc_channels SET is_spoiler = ? WHERE id = ? AND server_id = ?");

test("the spoiler flag PATCH carries owner OR MANAGE_CHANNELS inside the UPDATE", async () => {
  for (const value of [true, false]) {
    const { row, call } = await authed("/api/servers/3/channels/9");
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PATCH", { is_spoiler: value }), envWithLimiters(db));
    assert.equal(response.status, 200, "value " + String(value));
    assert.deepEqual(await bodyOf(response), {
      channel: { id: 9, serverId: 3, isSpoiler: value },
    });

    const update = db.calls.find((entry) => entry.call === "run" && SPOILER_UPDATE_TEST(entry.sql));
    assert.match(update.sql, /UPDATE gc_channels SET is_spoiler = \? WHERE id = \? AND server_id = \? AND server_id IS NOT NULL AND \(/);
    assert.match(update.sql, /EXISTS \(SELECT 1 FROM gc_server_members om/);
    // The 0/1 flag, channel, server, then the owner rider's binds and the
    // H1 per-bit EXISTS pair (MANAGE_CHANNELS = 1).
    assert.match(update.sql, /gc_member_roles gbm1 JOIN gc_roles gbr1/);
    assert.match(update.sql, /\(gbr1\.permissions & 1\) <> 0/);
    assert.deepEqual(update.bound, [
      value ? 1 : 0, 9, 3,
      3, USER_ID, 3, USER_ID,
    ]);
  }
});

test("a spoiler PATCH with a non-boolean flag 400s before any statement", async () => {
  const { row, call } = await authed("/api/servers/3/channels/9");
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(call("PATCH", { is_spoiler: "yes" }), envWithLimiters(db));
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "is_spoiler must be true or false." });
  assert.deepEqual(db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"), []);
});

test("a refused spoiler PATCH 404s for channel-authorized callers, 403 for the rest", async () => {
  {
    // A moderator string-tier member: an unknown channel is a 404 for them.
    const { row, call } = await authed("/api/servers/3/channels/9");
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: SPOILER_UPDATE_TEST, run: async () => ({ meta: { changes: 0 } }) },
      {
        test: (sql) => sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?"),
        first: async () => ({ role: "moderator", permissions: undefined }),
      },
    ]);
    const response = await dispatch(call("PATCH", { is_spoiler: true }), envWithLimiters(db));
    assert.equal(response.status, 404);
    assert.deepEqual(await bodyOf(response), { error: "That channel does not exist." });
  }
  {
    // A plain member: same refusal, same shared permission answer.
    const { row, call } = await authed("/api/servers/3/channels/9");
    const db = fakeDb([
      { test: SESSION_READ_TEST, first: async () => row },
      { test: SPOILER_UPDATE_TEST, run: async () => ({ meta: { changes: 0 } }) },
      {
        test: (sql) => sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?"),
        first: async () => ({ role: "member", permissions: 0 }),
      },
    ]);
    const response = await dispatch(call("PATCH", { is_spoiler: true }), envWithLimiters(db));
    assert.equal(response.status, 403);
    assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  }
});

// --- the graceful default: the existing guards EXTEND, never gate ----------------------

const CHANNEL_INSERT_TEST = (sql) =>
  sql.includes("INSERT INTO gc_channels") && sql.includes("(SELECT COUNT(*) FROM gc_channels");

test("the channel-create guard gains the gc_roles OR-clause beside the string tiers", async () => {
  const { row, call } = await authed("/api/servers/3/channels");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    // The create's id, PRE-READ (no id is ever derived INSIDE a batch).
    { test: (sql) => sql.includes("AS next_channel_id"), first: async () => ({ next_channel_id: 90 }) },
    {
      test: CHANNEL_INSERT_TEST,
      run: async () => ({ meta: { changes: 1, last_row_id: 90 } }),
    },
    {
      test: (sql) => sql.includes("SELECT id, name, kind, position FROM gc_channels WHERE id = ?"),
      first: async () => ({ id: 90, name: "lounge", kind: "voice", position: 4 }),
    },
  ]);
  const response = await dispatch(
    call("POST", { name: "lounge", kind: "voice" }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);

  const batch = db.calls.find((entry) => entry.call === "batch");
  const insert = batch.statements.find((statement) => CHANNEL_INSERT_TEST(statement.sql));
  // The string-tier precondition is UNCHANGED (the graceful default) — the
  // role-bit clause rides beside it as the H1 per-bit EXISTS.
  assert.match(insert.sql, /role IN \('owner','moderator'\)/);
  assert.match(insert.sql, /OR \(EXISTS \(SELECT 1 FROM gc_member_roles gbm1 JOIN gc_roles gbr1/);
  // The cap literal rides MAX_CHANNELS_PER_SERVER - 1 (parity-limits.md:
  // Channels per server 500).
  assert.match(
    insert.sql,
    new RegExp(`AND \\(SELECT COUNT\\(\\*\\) FROM gc_channels WHERE server_id = \\?\\) <= ${MAX_CHANNELS_PER_SERVER - 1}`),
  );
});

test("the invite-mint guard gains the MANAGE_INVITES OR-clause beside the owner rider", async () => {
  const { row, call } = await authed("/api/servers/3/invites");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("INSERT INTO gc_invites"),
      run: async () => ({ meta: { changes: 1 } }),
    },
  ]);
  const response = await dispatch(call("POST"), envWithLimiters(db));
  assert.equal(response.status, 201);

  const insert = db.calls.find((entry) => entry.call === "run" && entry.sql.includes("INSERT INTO gc_invites"));
  // The parity-P0 cap's paren wrap puts the OR-group inside the count arm.
  assert.match(insert.sql, /WHERE \(EXISTS \(SELECT 1 FROM gc_servers WHERE id = \? AND owner_user_id = \?\) OR/);
  assert.match(insert.sql, /AND \(SELECT COUNT\(\*\) FROM gc_invites WHERE server_id = \?\) <= 999/);
  assert.match(insert.sql, /gc_member_roles gbm8 JOIN gc_roles gbr8/);
  assert.match(insert.sql, /\(gbr8\.permissions & 8\) <> 0/);
});

// --- ui-helpers: member grouping, display precedence, spoiler acks ---------------------

function fakeStorage(entries = []) {
  const map = new Map(entries);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}





