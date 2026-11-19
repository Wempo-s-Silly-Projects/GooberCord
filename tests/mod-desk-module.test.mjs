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

// Phase-3 mod desk (routes in api/servers.mjs, gates in api/messages.mjs,
// pure contracts in api/permissions.mjs): the members page cluster — bans,
// timeouts, the member prune, the verification level, join attribution, and
// the roster's mod-desk extension. Same fakeDb + pinned-SQL contract style as
// the roles/layers modules: every write's guard rides INSIDE the SQL, and a
// failed write is classified afterwards by one diagnostic read that only
// picks an error message.
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { enforceMemberGates, enforceMemberGatesForChannel } from "../api/messages.mjs";
import { TIMEOUT_MINUTE_CHOICES } from "../api/permissions.mjs";
import { nowSeconds, randomToken, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;

// --- shared scaffolding (same conventions as the roles/layers modules) ----------

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

function envWithLimiters(db, overrides = {}) {
  const env = { GOOBER_DB: db, ...overrides };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function authed(path, actor = {}) {
  const { token, csrf, row } = await sessionFixtures();
  return {
    row,
    routes: [
      { test: SESSION_READ_TEST, first: async () => row },
      { test: ACTOR_CONTEXT_TEST, first: async () => ({
          role: "member", nickname: null,
          permissions: 0, position: -1,
          ...actor,
        }) },
    ],
    call: (method, body, headers = {}) =>
      request(method, path, body, {
        Cookie: "goober_session=" + token,
        "X-CSRF-Token": csrf,
        ...headers,
      }),
  };
}

// --- SQL shape pins --------------------------------------------------------------

const ACTOR_CONTEXT_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("AS position") &&
  sql.includes("FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?");

// The moderation-guard arm every KICK-family write embeds: the owner row, OR
// the merged KICK mask with the strictly-below position rule (the owner row is
// immune by the statement's own role <> 'owner' rider).

// --- bans -------------------------------------------------------------------------
//
// POST /api/servers/:id/bans — the invalid-invite taxonomy's BANNED case: kick
// + a ban flag the join routes check, guarded by KICK_MEMBERS + the position
// rule, in ONE batch whose fan-out deletes ride a "a ban row now exists"
// rider (a refused ban can never kick the member who stayed).

const BAN_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_server_bans (server_id, user_id, created_by, reason, created_at)") &&
  sql.includes("NOT EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)");
const BAN_MEMBER_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ?") &&
  sql.includes("EXISTS (SELECT 1 FROM gc_server_bans gb");
const BAN_ROLES_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ?") &&
  sql.includes("EXISTS (SELECT 1 FROM gc_server_bans gb");
const UNBAN_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_bans WHERE server_id = ? AND user_id = ?");

test("a KICK_MEMBERS moderator bans a member as ONE batch: the flag and the kick leave together", async () => {
  const { routes, call } = await authed("/api/servers/3/bans", {
    permissions: 4, position: 5, // KICK_MEMBERS, top position 5
  });
  const db = fakeDb(routes);
  const response = await dispatch(
    call("POST", { user_id: TARGET_ID }), envWithLimiters(db),
  );

  assert.equal(response.status, 201);
  const body = await bodyOf(response);
  assert.equal(body.changed, true);
  assert.equal(body.ban.serverId, 3);
  assert.equal(body.ban.userId, TARGET_ID);
  assert.equal(body.ban.reason, null);
  assert.match(body.ban.bannedAt, /Z$/);

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "the whole ban is one batch");
  const inserts = batch.statements.filter((statement) => BAN_INSERT_TEST(statement.sql));
  assert.equal(inserts.length, 1);
  const insert = inserts[0];
  // Bind order: the row, then the user EXISTS pair, then the ban NOT EXISTS
  // pair, then the guard's binds (server/actor pairs, the mask pair, the
  // actor's position pair, the target sentinel).
  assert.deepEqual(insert.bound.slice(0, 7), [3, TARGET_ID, USER_ID, null, insert.bound[4], TARGET_ID, 3]);
  assert.equal(typeof insert.bound[4], "number");
  assert.match(insert.sql, /EXISTS \(SELECT 1 FROM users bu WHERE bu\.id = \?\)/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_server_bans/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_server_members tb.*?tb\.role = 'owner'\)/,
    "the owner row is immune");
  assert.match(insert.sql, /om\.role = 'owner'\)/, "the owner arm rides the INSERT");
  assert.match(insert.sql, /gc_member_roles gbm4 JOIN gc_roles gbr4.*?\(gbr4\.permissions & 4\) <> 0/s,
    "the KICK bit arm rides the INSERT (the H1 per-bit EXISTS)");
  assert.match(
    insert.sql,
    /JOIN gc_roles hr ON hr\.id = hmr\.role_id WHERE hmr\.server_id = \? AND hmr\.user_id = \?\) > \(SELECT COALESCE\(MAX\(hr\.position\), -1\)/,
    "the strictly-below position rule rides the INSERT",
  );
  // The fan-out deletes ride the rider, never the guard alone — a refused ban
  // can never evict anyone.
  assert.equal(batch.statements.filter((statement) => BAN_MEMBER_DELETE_TEST(statement.sql)).length, 1);
  assert.equal(batch.statements.filter((statement) => BAN_ROLES_DELETE_TEST(statement.sql)).length, 1);
});

test("an idempotent repeat ban answers changed:false and reads the standing row", async () => {
  const { routes, call } = await authed("/api/servers/3/bans", {
    permissions: 4, position: 5,
  });
  const db = fakeDb([
    ...routes,
    { test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    {
      test: (sql) => sql.includes("SELECT reason, created_at FROM gc_server_bans"),
      first: async () => ({ reason: "spam", created_at: nowSeconds() - 60 }),
    },
  ]);
  const response = await dispatch(
    call("POST", { user_id: TARGET_ID, reason: "spam" }),
    envWithLimiters(db),
  );

  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.changed, false);
  assert.equal(body.ban.reason, "spam");
  assert.match(body.ban.bannedAt, /Z$/);
});

test("a plain member's ban 403s through the changes=0 classification read", async () => {
  const { routes, call } = await authed("/api/servers/3/bans", {
    permissions: 0, position: -1,
  });
  const db = fakeDb([
    ...routes,
    { test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("POST", { user_id: TARGET_ID }), envWithLimiters(db));

  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  // Exactly one batch ran and failed; the only other call classified it.
  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  const probe = db.calls.find((entry) =>
    entry.call === "first" &&
    entry.sql.includes("SELECT reason, created_at FROM gc_server_bans"));
  assert.ok(probe, "one diagnostic read picks the message");
});

test("a ban cannot come from the actor's own position: an equal-or-higher target 403s", async () => {
  // The moderation guard's position rule rides the INSERT; a refused statement
  // is the same 403 with no further probing.
  const { routes, call } = await authed("/api/servers/3/bans", {
    permissions: 4, position: 5,
  });
  const db = fakeDb([
    ...routes,
    { test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("POST", { user_id: 99 }), envWithLimiters(db));
  assert.equal(response.status, 403);
});

test("a ban body is validated before any statement runs", async () => {
  for (const bad of [
    { user_id: 0 },
    { user_id: -3 },
    { user_id: "22" },
    {},
  ]) {
    const { routes, call } = await authed("/api/servers/3/bans", { permissions: 4, position: 5 });
    const db = fakeDb(routes);
    const response = await dispatch(call("POST", bad), envWithLimiters(db));
    assert.equal(response.status, 400, "bad body " + JSON.stringify(bad));
    assert.deepEqual(
      db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
      [],
      "no write for " + JSON.stringify(bad),
    );
  }
});

test("a ban reason is optional, trimmed, and capped at 280", async () => {
  const { routes, call } = await authed("/api/servers/3/bans", { permissions: 4, position: 5 });
  const db = fakeDb(routes);
  const response = await dispatch(
    call("POST", { user_id: TARGET_ID, reason: "  " }), envWithLimiters(db),
  );
  assert.equal(response.status, 400, "an all-space reason is not a reason");
  assert.equal(
    (db.calls.find((entry) => entry.call === "batch") || null),
    null,
  );

  const long = "x".repeat(281);
  const badRoutes = await authed("/api/servers/3/bans", { permissions: 4, position: 5 });
  const badDb = fakeDb(badRoutes.routes);
  const badResponse = await dispatch(badRoutes.call("POST", { user_id: TARGET_ID, reason: long }), envWithLimiters(badDb));
  assert.equal(badResponse.status, 400);
  assert.equal(
    (badDb.calls.find((entry) => entry.call === "batch") || null),
    null,
  );
});

test("you cannot ban yourself (that is what leaving is for)", async () => {
  const { routes, call } = await authed("/api/servers/3/bans", { permissions: 4, position: 5 });
  const db = fakeDb(routes);
  const response = await dispatch(call("POST", { user_id: USER_ID }), envWithLimiters(db));
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "You cannot ban yourself." });
  assert.deepEqual(
    db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
    [],
  );
});

test("un-banning is one owner-or-KICK-guarded DELETE", async () => {
  const { routes, call } = await authed("/api/servers/3/bans/" + TARGET_ID, {
    permissions: 4, position: 5,
  });
  const db = fakeDb(routes);
  const response = await dispatch(call("DELETE", {}), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { banned: false, serverId: 3, userId: TARGET_ID });

  const unbans = db.calls.filter((entry) => entry.call === "run" && UNBAN_DELETE_TEST(entry.sql));
  assert.equal(unbans.length, 1);
  assert.match(unbans[0].sql, /om\.role = 'owner'\)/);
  assert.match(unbans[0].sql, /gc_member_roles gbm4 JOIN gc_roles gbr4.*?\(gbr4\.permissions & 4\) <> 0/s);
  // Binds: the row, then the owner arm's pair, then the per-bit pair.
  assert.deepEqual(unbans[0].bound, [3, TARGET_ID, 3, USER_ID, 3, USER_ID]);
});

test("an un-ban that matched nothing shares the one 403 (no ban oracle)", async () => {
  const { routes, call } = await authed("/api/servers/3/bans/" + TARGET_ID, {
    permissions: 0, position: -1,
  });
  const db = fakeDb([
    ...routes,
    { test: UNBAN_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("DELETE", {}), envWithLimiters(db));
  assert.equal(response.status, 403);
});

test("mod-desk dispatch: unknown ban shapes fall through", async () => {
  for (const [method, path, body] of [
    ["GET", "/api/servers/3/bans", undefined],
    ["PATCH", "/api/servers/3/bans", {}],
    ["PUT", "/api/servers/3/bans/22", {}],
    ["POST", "/api/servers/3/bans/22", {}],
    ["GET", "/api/servers/3/bans/22", undefined],
  ]) {
    const result = await handleServerRoutes(
      request(method, path, body), { GOOBER_DB: fakeDb([]) },
      new URL(ORIGIN + path), path, method, undefined,
    );
    assert.equal(result, undefined, method + " " + path + " falls through");
  }
});

// --- timeouts ---------------------------------------------------------------------

const TIMEOUT_SET_TEST = (sql) =>
  sql.startsWith("UPDATE gc_server_members SET timed_out_until = ? WHERE server_id = ? AND user_id = ?");
const TIMEOUT_REMOVE_TEST = (sql) =>
  sql.startsWith("UPDATE gc_server_members SET timed_out_until = NULL WHERE server_id = ? AND user_id = ?");

test("the PUT body must ride the filed duration menu", async () => {
  for (const bad of [0, 15, -1, "10", null, 10081, 1.5]) {
    const { routes, call } = await authed(
      "/api/servers/3/members/" + TARGET_ID + "/timeout", { permissions: 4, position: 5 },
    );
    const db = fakeDb(routes);
    const response = await dispatch(call("PUT", { minutes: bad }), envWithLimiters(db));
    assert.equal(response.status, 400, "minutes " + JSON.stringify(bad));
    assert.deepEqual(
      db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
      [],
    );
  }
});

test("a KICK_MEMBERS mod times out a member: the expiry is computed server-side", async () => {
  const { routes, call } = await authed(
    "/api/servers/3/members/" + TARGET_ID + "/timeout", { permissions: 4, position: 5 },
  );
  const db = fakeDb(routes);
  const before = nowSeconds();
  const response = await dispatch(call("PUT", { minutes: 10 }), envWithLimiters(db));

  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(body.member, {
    serverId: 3,
    userId: TARGET_ID,
    timedOutUntil: new Date((before + 600) * 1000).toISOString(),
  });

  const updates = db.calls.filter((entry) => entry.call === "run" && TIMEOUT_SET_TEST(entry.sql));
  assert.equal(updates.length, 1);
  // The expiry never rides the request: it is now seconds + minutes * 60.
  assert.ok(Math.abs(updates[0].bound[0] - (before + 600)) < 5, "the expiry is server-computed");
  assert.deepEqual(updates[0].bound.slice(1, 3), [3, TARGET_ID]);
  assert.equal(updates[0].bound.at(-1), TARGET_ID, "the guard's target sentinel rides last");
  assert.deepEqual(updates[0].bound.slice(3, 5), [3, USER_ID], "the guard's binds ride after the row");
  // The owner row is immune (the role <> 'owner' rider) and the moderation
  // guard (owner OR KICK + the position rule) rides the same statement.
  assert.match(updates[0].sql, /AND role <> 'owner' AND/);
  assert.match(updates[0].sql, /om\.role = 'owner'/);
});

test("the owner row is immune to timeouts: changes=0 is the shared 403", async () => {
  const { routes, call } = await authed(
    "/api/servers/3/members/" + TARGET_ID + "/timeout", { permissions: 0, position: -1 },
  );
  const db = fakeDb([
    ...routes,
    { test: TIMEOUT_SET_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("PUT", { minutes: 60 }), envWithLimiters(db));
  assert.equal(response.status, 403);
});

test("removing a timeout NULLs the column under the same guarded statement", async () => {
  const { routes, call } = await authed(
    "/api/servers/3/members/" + TARGET_ID + "/timeout", { permissions: 4, position: 5 },
  );
  const db = fakeDb(routes);
  const response = await dispatch(call("DELETE", undefined), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    member: { serverId: 3, userId: TARGET_ID, timedOutUntil: null },
  });
  const updates = db.calls.filter((entry) => entry.call === "run" && TIMEOUT_REMOVE_TEST(entry.sql));
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /AND role <> 'owner' AND/);
});

test("timeout dispatch: GET on the timeout route falls through", async () => {
  const path = "/api/servers/3/members/22/timeout";
  const result = await handleServerRoutes(
    get(path), { GOOBER_DB: fakeDb([]) },
    new URL(ORIGIN + path), path, "GET", undefined,
  );
  assert.equal(result, undefined);
});

// --- the member prune --------------------------------------------------------------

const PRUNE_COUNT_TEST = (sql) =>
  sql.includes("SELECT COUNT(*) AS count") && sql.includes("AS authorized");
const PRUNE_ROLES_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_member_roles WHERE server_id = ? AND EXISTS (");
const PRUNE_MEMBERS_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_members AS m WHERE m.server_id = ?");

const KICK_ACTOR = { permissions: 4, position: 5 };

test("the prune body validates days, dry_run, and role_filter_id before any statement", async () => {
  for (const bad of [
    { days: 30 },
    { dry_run: false },
    { days: 7 },
    { days: 8, dry_run: true },
    { days: 30, dry_run: true, role_filter_id: 0 },
    { days: 30, dry_run: true, role_filter_id: "four" },
  ]) {
    const pruned = await authed("/api/servers/3/prune", KICK_ACTOR);
    const db = fakeDb(pruned.routes);
    const response = await dispatch(pruned.call("POST", bad), envWithLimiters(db));
    assert.equal(response.status, 400, "bad body " + JSON.stringify(bad));
    assert.deepEqual(
      db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
      [],
    );
  }
});

test("the dry-run preview is ONE COUNT and the authorization rides the SELECT list", async () => {
  const pruned = await authed("/api/servers/3/prune", KICK_ACTOR);
  const db = fakeDb([
    ...pruned.routes,
    { test: PRUNE_COUNT_TEST, first: async () => ({ count: 4, authorized: 1 }) },
  ]);
  const response = await dispatch(
    pruned.call("POST", { days: 7, dry_run: true }), envWithLimiters(db),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { dry_run: true, count: 4 });

  const counts = db.calls.filter((entry) => entry.call === "first" && PRUNE_COUNT_TEST(entry.sql));
  assert.equal(counts.length, 1, "one preview COUNT — cheap and kind");
  const count = counts[0];
  // The authorized column rides the SELECT (the guard, in bind order) BEFORE
  // the candidate predicate's binds: the owner arm's pair, the per-bit pair,
  // then server id, the cutoff, the activity's server id, then the position
  // pair.
  assert.match(count.sql, /, \(EXISTS \(SELECT 1 FROM gc_server_members om/);
  assert.match(count.sql, /AS authorized/);
  // The candidates: pre-cutoff joins, message-inactivity (the NOT EXISTS over
  // the server's own channels), never the owner row, and the non-owner actor's
  // strictly-below position rule.
  assert.match(count.sql, /m\.joined_at <= \?/);
  assert.match(count.sql, /NOT EXISTS \(SELECT 1 FROM gc_messages pa JOIN gc_channels pc/);
  assert.match(count.sql, /m\.role <> 'owner'/);
  assert.match(count.sql, /NOT EXISTS \(SELECT 1 FROM gc_member_roles pm JOIN gc_roles pr/);
  assert.match(count.sql, /gc_member_roles gbm4 JOIN gc_roles gbr4/);
  const [serverId, actorId, kickServer, kickActor] = count.bound;
  assert.deepEqual(
    [serverId, actorId, kickServer, kickActor],
    [3, USER_ID, 3, USER_ID],
  );
  // Then the candidates' own binds (the cutoff first).
  assert.equal(typeof count.bound[4], "number");
});

test("the dry-run answers the shared 403 when the authorized column says 0", async () => {
  const pruned = await authed("/api/servers/3/prune", { permissions: 0, position: -1 });
  const db = fakeDb(pruned.routes);
  const response = await dispatch(
    pruned.call("POST", { days: 30, dry_run: true }), envWithLimiters(db),
  );
  assert.equal(response.status, 403);
});

test("the run executes the batch: the assignments leave FIRST, the memberships LAST", async () => {
  const pruned = await authed("/api/servers/3/prune", KICK_ACTOR);
  const db = fakeDb([
    ...pruned.routes,
    { test: PRUNE_ROLES_DELETE_TEST, run: async () => ({ meta: { changes: 3 } }) },
    { test: PRUNE_MEMBERS_DELETE_TEST, run: async () => ({ meta: { changes: 3 } }) },
  ]);
  const response = await dispatch(
    pruned.call("POST", { days: 7, dry_run: false }), envWithLimiters(db),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { dry_run: false, kicked: 3 });

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 2);
  assert.equal(batch.statements[0].sql.startsWith("DELETE FROM gc_member_roles"), true,
    "the roles (whose predicate joins the membership row) go first");
  assert.equal(batch.statements[1].sql.startsWith("DELETE FROM gc_server_members AS m"), true);
  // Both statements carry the IDENTICAL candidate predicate and guard, with
  // the same bind order behind the roles statement's own server id.
  assert.match(batch.statements[0].sql, /m\.role <> 'owner'/);
  assert.match(batch.statements[1].sql, /m\.role <> 'owner'/);
  assert.deepEqual(batch.statements[1].bound, batch.statements[0].bound.slice(1));
});

test("the owner actor prunes below the crown: no position guard, no mask arm", async () => {
  const pruned = await authed("/api/servers/3/prune", { role: "owner", permissions: 0, position: -1 });
  const db = fakeDb([
    ...pruned.routes,
    { test: PRUNE_COUNT_TEST, first: async () => ({ count: 6, authorized: 1 }) },
  ]);
  const response = await dispatch(
    pruned.call("POST", { days: 30, dry_run: true }), envWithLimiters(db),
  );
  assert.equal(response.status, 200);

  const count = db.calls.find((entry) => entry.call === "first" && PRUNE_COUNT_TEST(entry.sql));
  assert.ok(count);
  // The position rule is skipped for the crown (roleless candidates are the
  // crown's to prune), and the guard is the owner arm alone.
  assert.doesNotMatch(count.sql, /NOT EXISTS \(SELECT 1 FROM gc_member_roles pm/);
  assert.match(count.sql, /om\.role = 'owner'\)\) AS authorized/);
});

test("the role filter narrows the candidates to that role's holders", async () => {
  const pruned = await authed("/api/servers/3/prune", KICK_ACTOR);
  const db = fakeDb([
    ...pruned.routes,
    { test: PRUNE_COUNT_TEST, first: async () => ({ count: 2, authorized: 1 }) },
  ]);
  const response = await dispatch(
    pruned.call("POST", { days: 7, dry_run: true, role_filter_id: 12 }), envWithLimiters(db),
  );
  assert.equal(response.status, 200);

  const count = db.calls.find((entry) => entry.call === "first" && PRUNE_COUNT_TEST(entry.sql));
  assert.ok(count);
  // The filter is an EXISTS of the role's holders inside the candidate WHERE —
  // never a client-side trim after a broader run.
  assert.match(count.sql, /EXISTS \(SELECT 1 FROM gc_member_roles fm JOIN gc_roles fr/);
  const tail = count.bound.slice(-2);
  assert.deepEqual(tail, [3, 12], "the filter binds the (server, role) pair last");
});

test("the prune limiter rides the write tier with the prune identity", async () => {
  const pruned = await authed("/api/servers/3/prune", KICK_ACTOR);
  const db = fakeDb(pruned.routes);
  const keys = [];
  const env = envWithLimiters(db, {
    [RATE_LIMIT_BINDINGS.write]: {
      limit: async ({ key }) => { keys.push(key); return { success: true }; },
    },
  });
  await dispatch(pruned.call("POST", { days: 7, dry_run: true }), env);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], await sha256Hex("write:prune:3:" + USER_ID));

  // A missing write limiter 503s before any statement at all.
  const bareDb = fakeDb(pruned.routes);
  const bareResponse = await dispatch(
    pruned.call("POST", { days: 7, dry_run: true }), { GOOBER_DB: bareDb },
  );
  assert.equal(bareResponse.status, 503);
  assert.deepEqual(
    bareDb.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
    [],
  );
});

// --- join attribution + the account-ban refusals ------------------------------------

const INVITE_JOIN_INSERT_TEST = (sql) =>
  sql.includes("INSERT INTO gc_server_members (server_id, user_id, role, joined_at, created_by_invite)");
const INVITE_LOOKUP_TEST = (sql) =>
  sql.includes("FROM gc_invites WHERE code = ?") && sql.includes("LIMIT 1");
// 0017's active predicate rides the bump's WHERE (expiry/cap/revoke can't be
// out-raced by the tick).
const INVITE_USES_BUMP_TEST = (sql) =>
  sql.includes("UPDATE gc_invites SET uses = uses + 1 WHERE code = ?") &&
  sql.includes("revoked_at IS NULL");
const DISCOVER_JOIN_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_server_members (server_id, user_id, role, joined_at)") &&
  sql.includes("is_public = 1");
const MEMBER_PROBE_TEST = (sql) =>
  sql.includes("SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ?");
const BAN_PROBE_TEST = (sql) =>
  sql.includes("SELECT 1 AS banned FROM gc_server_bans WHERE server_id = ? AND user_id = ?");

test("a fresh join carries the invite code on the membership row (join attribution)", async () => {
  const code = randomToken(6);
  const { row, call } = await authed("/api/invites/" + code + "/join");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: INVITE_LOOKUP_TEST, first: async () => ({ server_id: 3 }) },
    { test: INVITE_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(call("POST", {}), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { joined: true, serverId: 3 });

  const insert = db.calls.find((entry) => entry.call === "run" && INVITE_JOIN_INSERT_TEST(entry.sql));
  assert.ok(insert);
  // Binds: server, user, now, the attribution, the invite-exists pair's code,
  // then the two guard pairs.
  assert.deepEqual(insert.bound.slice(0, 4), [3, USER_ID, insert.bound[2], code]);
  assert.equal(typeof insert.bound[2], "number");
  // The join-cap rider (7eac8e0's parity-P0) binds AFTER the guard pairs:
  // the roster count pair (user, user) then the CASE's renews-now — the
  // guard pairs stay, the tail is the cap's own now mirror.
  assert.equal(insert.bound.at(-1), insert.bound[2]);
  assert.deepEqual(insert.bound.slice(10), [USER_ID, USER_ID, insert.bound[2]]);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_server_bans ijb/);
  assert.match(insert.sql, /COUNT\(\*\) FROM gc_server_members ijw WHERE ijw\.user_id = \?\) < \(CASE/);
  assert.ok(db.calls.find((entry) => INVITE_USES_BUMP_TEST(entry.sql)), "the uses counter moved");
});

test("a banned account joining by a VALID invite is refused with the banned copy", async () => {
  const code = randomToken(6);
  const { row, call } = await authed("/api/invites/" + code + "/join");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: INVITE_LOOKUP_TEST, first: async () => ({ server_id: 3 }) },
    { test: INVITE_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: MEMBER_PROBE_TEST, first: async () => null },
    { test: BAN_PROBE_TEST, first: async () => ({ banned: 1 }) },
  ]);
  const response = await dispatch(call("POST", {}), envWithLimiters(db));

  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You are banned from that server." });
  // The guard rode the INSERT; nothing was written.
  assert.deepEqual(
    db.calls.filter((entry) => entry.call === "batch"),
    [],
  );
  assert.equal(db.calls.filter((entry) => entry.call === "run").length, 1);
});

test("a discovery join refuses a banned account with the same copy", async () => {
  const { row, call } = await authed("/api/discover/3/join");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: DISCOVER_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: MEMBER_PROBE_TEST, first: async () => null },
    { test: BAN_PROBE_TEST, first: async () => ({ banned: 1 }) },
  ]);
  const response = await dispatch(call("POST", {}), envWithLimiters(db));

  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You are banned from that server." });
});

test("the discovery join's ban rider binds the (server, user) pair last", async () => {
  const { row, call } = await authed("/api/discover/3/join");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: DISCOVER_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(call("POST", {}), envWithLimiters(db));
  assert.equal(response.status, 200);

  const insert = db.calls.find((entry) => entry.call === "run" && DISCOVER_JOIN_INSERT_TEST(entry.sql));
  assert.ok(insert);
  // The guard pairs bind first, the join-cap's (user, user, now) rider last.
  assert.deepEqual(insert.bound.slice(0, 6), [3, USER_ID, insert.bound[2], 3, 3, USER_ID]);
  assert.deepEqual(insert.bound.slice(6), [USER_ID, USER_ID, insert.bound[2]]);
  assert.match(insert.sql, /COUNT\(\*\) FROM gc_server_members djw WHERE djw\.user_id = \?\) < \(CASE/);
});

// --- the roster's mod-desk extension -------------------------------------------------

const ROSTER_MEMBERS_TEST = (sql) => sql.includes("m.joined_at AS joined_at") &&
  sql.includes("m.timed_out_until AS timed_out_until") &&
  sql.includes("m.created_by_invite AS created_by_invite");
const ROSTER_BANS_TEST = (sql) =>
  sql.includes("FROM gc_server_bans b JOIN users u ON u.id = b.user_id");
const SERVER_LEVEL_TEST = (sql) =>
  sql.includes("SELECT verification_level, rules_text IS NOT NULL AS rules_on FROM gc_servers WHERE id = ? LIMIT 1");

function rosterDb({
  actor = { role: "member", permissions: 4, position: 5 },
  verification_level = null,
  members = null,
  bans = null,
} = {}) {
  return sessionFixtures().then(({ token, row }) => {
    const memberRows = members || [
      { id: 10, username: "ada", membership_role: "owner", nickname: null,
        avatar_mime: null, avatar_version: null, joined_at: 100, account_created_at: 50,
        timed_out_until: null, created_by_invite: null },
      { id: 11, username: "newbie", membership_role: "member", nickname: null,
        avatar_mime: null, avatar_version: null, joined_at: nowSeconds() - 60,
        account_created_at: nowSeconds() - 120, timed_out_until: nowSeconds() + 3600, created_by_invite: "GooberAA" },
    ];
    return {
      db: fakeDb([
        { test: SESSION_READ_TEST, first: async () => row },
        { test: ACTOR_CONTEXT_TEST, first: async () => ({ nickname: null, ...actor }) },
        { test: ROSTER_MEMBERS_TEST, all: async () => ({ results: memberRows }) },
        {
          test: (sql) => sql.includes("SELECT id, name, color, position, permissions FROM gc_roles"),
          all: async () => ({ results: [
            { id: 4, name: "Mods", color: null, position: 3, permissions: 4 },
          ] }),
        },
        {
          test: (sql) => sql.includes("SELECT user_id, role_id FROM gc_member_roles WHERE server_id = ?"),
          all: async () => ({ results: [] }),
        },
        { test: SERVER_LEVEL_TEST, first: async () => (
          verification_level === null ? null : { verification_level, rules_on: null }) },
        { test: ROSTER_BANS_TEST, all: async () => ({ results: bans || [] }) },
      ]),
      getRequest: new Request(ORIGIN + "/api/servers/3/roster", {
        headers: { Cookie: "goober_session=" + token },
      }),
    };
  });
}

test("the roster carries the mod desk columns: joined/account ISO, timeout and invite only when set", async () => {
  const { db, getRequest } = await rosterDb({ verification_level: null });
  const response = await dispatch(getRequest, envWithLimiters(db));

  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.members.length, 2);
  const ownerRow = body.members[0];
  const freshRow = body.members[1];

  // Always-present: joinedAt and the account-age source, as ISO.
  assert.equal(ownerRow.joinedAt, new Date(100 * 1000).toISOString());
  assert.equal(ownerRow.accountCreatedAt, new Date(50 * 1000).toISOString());
  // Present only when relevant: a null timeout and no invite attribution ride
  // no field at all on the owner's row.
  assert.equal(ownerRow.timedOutUntil, undefined);
  assert.equal(ownerRow.createdByInvite, undefined);
  assert.match(freshRow.timedOutUntil, /Z$/);
  assert.equal(freshRow.createdByInvite, "GooberAA");
});

test("the roster resolves verification eligibility per member (mods bypass, fresh members fail)", async () => {
  const { db, getRequest } = await rosterDb({ verification_level: 4 });
  const response = await dispatch(getRequest, envWithLimiters(db));
  assert.equal(response.status, 200);

  const body = await bodyOf(response);
  // The level rides the server object only when on.
  assert.equal(body.server.verificationLevel, 4);
  // The owner bypasses; the fresh member (a KICK_MEMBERS holder, 60 seconds
  // old, on a 7-day account) fails both gates — resolved server-side.
  assert.equal(body.members[0].verificationEligible, true);
  assert.equal(body.members[1].verificationEligible, false);
});

test("the roster's verification question disappears at level 0 (graceful default)", async () => {
  const { db, getRequest } = await rosterDb({ verification_level: 0 });
  const response = await dispatch(getRequest, envWithLimiters(db));
  const body = await bodyOf(response);
  assert.equal(body.server.verificationLevel, undefined);
  assert.equal(body.members[0].verificationEligible, undefined);
  assert.equal(body.members[1].verificationEligible, undefined);
});

test("the bans array rides the roster only for the mod-desk viewer class", async () => {
  const { db, getRequest } = await rosterDb({
    bans: [{ user_id: 30, username: "banned-user", reason: "spam", created_at: 123 }],
  });
  const response = await dispatch(getRequest, envWithLimiters(db));
  const body = await bodyOf(response);
  assert.deepEqual(body.bans, [{
    id: 30, username: "banned-user", reason: "spam", bannedAt: new Date(123 * 1000).toISOString(),
  }]);

  // A plain member without the bit: no bans array at all.
  const plain = await rosterDb({ actor: { role: "member", permissions: 0, position: -1 } });
  const plainBody = await bodyOf(await dispatch(plain.getRequest, envWithLimiters(plain.db)));
  assert.equal(plainBody.bans, undefined);
});

// --- the verification level PATCH + the server list payload -------------------------

const VERIFICATION_PATCH_TEST = (sql) =>
  sql.startsWith("UPDATE gc_servers SET verification_level = ? ") &&
  sql.includes("WHERE id = ? AND owner_user_id = ?");

test("PATCH verification_level rides the same owner-ridden UPDATE and echoes the level", async () => {
  const { row, call } = await authed("/api/servers/3");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: VERIFICATION_PATCH_TEST, run: async () => ({ meta: { changes: 1 } }) },
    {
      test: (sql) => sql.includes("SELECT id, name, icon_media_id, is_public, verification_level FROM gc_servers"),
      first: async () => ({ id: 3, name: "Alpha", icon_media_id: null, is_public: 1, verification_level: 3 }),
    },
  ]);
  const response = await dispatch(call("PATCH", { verification_level: 3 }), envWithLimiters(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    server: { id: 3, name: "Alpha", isPublic: true, iconUrl: null, verificationLevel: 3 },
  });

  const update = db.calls.find((entry) => entry.call === "run" && VERIFICATION_PATCH_TEST(entry.sql));
  assert.ok(update);
  assert.deepEqual(update.bound, [3, 3, USER_ID]);
});

test("PATCH verification_level is strictly the filed ladder — junk 400s with zero writes", async () => {
  for (const bad of [5, -1, "2", null, 2.5]) {
    const { row, call } = await authed("/api/servers/3");
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(call("PATCH", { verification_level: bad }), envWithLimiters(db));
    assert.equal(response.status, 400, "bad level " + JSON.stringify(bad));
    assert.deepEqual(
      db.calls.filter((entry) => entry.call === "run" || entry.call === "batch"),
      [],
    );
  }
});

test("a non-owner's verification PATCH 403s (owner-only, the SERVER-WIDE one-column call)", async () => {
  const { row, call } = await authed("/api/servers/3");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: VERIFICATION_PATCH_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(call("PATCH", { verification_level: 1 }), envWithLimiters(db));
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
});

test("the server list payload carries verificationLevel only when the owner turned it on", async () => {
  const serverListRoute = (verification_level) => ({
    test: (sql) => sql.includes("s.verification_level AS server_verification_level"),
    all: async () => ({
      results: [{
        server_id: 3, server_name: "Alpha", server_is_public: 1,
        server_icon_media_id: null, role: "owner", server_boosts: 0,
        boosted_by_me: 0, server_verification_level: verification_level,
        channel_id: null, channel_name: null, channel_kind: null,
        channel_position: null, channel_is_spoiler: null,
        channel_category_id: null, channel_slowmode_seconds: null,
      }],
    }),
  });
  const quietPhaseRoutes = [
    { test: (sql) => sql.includes("gc_member_roles gmr JOIN gc_roles r"), all: async () => ({ results: [] }) },
    { test: (sql) => sql.includes("FROM gc_channel_categories"), all: async () => ({ results: [] }) },
    { test: (sql) => sql.includes("FROM gc_channel_overwrites"), all: async () => ({ results: [] }) },
  ];

  const listServers = async (verification_level) => {
    const { token, row } = await sessionFixtures();
    const db = fakeDb(
      [{ test: SESSION_READ_TEST, first: async () => row }, serverListRoute(verification_level), ...quietPhaseRoutes],
    );
    const response = await dispatch(
      get("/api/servers", { Cookie: "goober_session=" + token }), envWithLimiters(db),
    );
    return bodyOf(response);
  };

  assert.equal(
    (await listServers(2)).servers[0].verificationLevel,
    2,
    "a turned-on level rides the list",
  );
  assert.equal(
    (await listServers(0)).servers[0].verificationLevel,
    undefined,
    "level 0 (and a pre-0008 row shape) is the same none the payload always carried",
  );
});

// --- the member-state gates (send + voice join) -------------------------------------

const MEMBER_GATE_SQL_TEST = (sql) =>
  sql.includes("SELECT m.timed_out_until AS timed_out_until") &&
  sql.includes("FROM gc_server_members m JOIN users u ON u.id = m.user_id");
const MEMBER_GATE_CHANNEL_SQL_TEST = (sql) =>
  sql.includes("SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1");
const SERVER_LEVEL_SQL_TEST = (sql) =>
  sql.includes("SELECT verification_level, rules_text FROM gc_servers WHERE id = ? LIMIT 1");

function gateRoutes({
  timed_out_until = null, role = "member", permissions = 0,
  account_created_at = 100, joined_at = 100,
  verification_level = null,
} = {}) {
  return [
    {
      test: MEMBER_GATE_SQL_TEST,
      first: async () => ({ timed_out_until, role, permissions, account_created_at, joined_at }),
    },
    { test: MEMBER_GATE_CHANNEL_SQL_TEST, first: async () => ({ server_id: 3 }) },
    { test: SERVER_LEVEL_SQL_TEST, first: async () => (
      verification_level === null ? null : { verification_level, rules_text: null }) },
  ];
}

test("a timed-out member is refused with the filed ISO wording", async () => {
  const db = fakeDb(gateRoutes({ timed_out_until: nowSeconds() + 3600 }));
  await assert.rejects(
    () => enforceMemberGates(envWithLimiters(db), 3, USER_ID),
    (error) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal(error.status, 403);
      assert.match(error.message, /^You are timed out until \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z\.$/);
      return true;
    },
  );
});

test("an expired (or absent) timeout is not a gate at all", async () => {
  const expired = fakeDb(gateRoutes({ timed_out_until: nowSeconds() - 5, verification_level: 0 }));
  await enforceMemberGates(envWithLimiters(expired), 3, USER_ID);
  const none = fakeDb(gateRoutes({ timed_out_until: null, verification_level: 0 }));
  await enforceMemberGates(envWithLimiters(none), 3, USER_ID);
});

test("the owner and the KICK_MEMBERS holders bypass the verification gate", async () => {
  const ownerDb = fakeDb(gateRoutes({ role: "owner", verification_level: 4,
    account_created_at: nowSeconds() - 5, joined_at: nowSeconds() - 5 }));
  await enforceMemberGates(envWithLimiters(ownerDb), 3, USER_ID);
  const modDb = fakeDb(gateRoutes({
    permissions: 4, verification_level: 4,
    account_created_at: nowSeconds() - 5, joined_at: nowSeconds() - 5,
  }));
  await enforceMemberGates(envWithLimiters(modDb), 3, USER_ID);
  // The server's verification read never even happened for them.
  for (const db of [ownerDb, modDb]) {
    assert.equal(db.calls.find((entry) => SERVER_LEVEL_SQL_TEST(entry.sql)), undefined);
  }
});

test("a nonzero verification level gates the fresh account/member with the shared 403", async () => {
  const now = nowSeconds();
  const db = fakeDb(gateRoutes({
    verification_level: 4, account_created_at: now - 60, joined_at: now - 10,
  }));
  await assert.rejects(
    () => enforceMemberGates(envWithLimiters(db), 3, USER_ID),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, "You do not meet this server's verification level yet.");
      return true;
    },
  );

  // The exact filed boundary (account 7 days ago, member 10 minutes ago) passes.
  const passDb = fakeDb(gateRoutes({
    verification_level: 4, account_created_at: now - 7 * 86400, joined_at: now - 600,
  }));
  await enforceMemberGates(envWithLimiters(passDb), 3, USER_ID);
});

test("level 3 skips the account gate; level 2 skips the member gate", async () => {
  const now = nowSeconds();
  const level3 = fakeDb(gateRoutes({
    verification_level: 3, account_created_at: now - 5, joined_at: now - 600,
  }));
  await enforceMemberGates(envWithLimiters(level3), 3, USER_ID);

  const level2 = fakeDb(gateRoutes({
    verification_level: 2, account_created_at: now - 5, joined_at: now - 5,
  }));
  await assert.rejects(() => enforceMemberGates(envWithLimiters(level2), 3, USER_ID),
    { status: 403 });
});

test("the channel wrapper passes dm/group channels (and non-channels) through untouched", async () => {
  const dm = fakeDb([
    { test: MEMBER_GATE_CHANNEL_SQL_TEST, first: async () => ({ server_id: null }) },
  ]);
  await enforceMemberGatesForChannel(envWithLimiters(dm), 90, USER_ID);
  assert.equal(dm.calls.find((entry) => MEMBER_GATE_SQL_TEST(entry.sql)), undefined,
    "no member read for a conversation channel");

  const missing = fakeDb([
    { test: MEMBER_GATE_CHANNEL_SQL_TEST, first: async () => null },
  ]);
  await enforceMemberGatesForChannel(envWithLimiters(missing), 404, USER_ID);
  assert.equal(missing.calls.find((entry) => MEMBER_GATE_SQL_TEST(entry.sql)), undefined);
});

test("the mod desk's selects are the house shape: no oracle for a non-member", async () => {
  // enforceMemberGates stays silent for a non-member (null membership row) —
  // the caller's own channel gate answers, so no oracle is handed out here.
  const db = fakeDb([
    { test: MEMBER_GATE_SQL_TEST, first: async () => null },
  ]);
  await enforceMemberGates(envWithLimiters(db), 3, USER_ID);
  assert.equal(db.calls.find((entry) => SERVER_LEVEL_SQL_TEST(entry.sql)), undefined,
    "a non-member never reaches the verification read");
});

// --- the members page's client-side filter -------------------------------------------



