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

// GO-HAYWIRE cycle-9 mod lane (lane-haywire9-mod): the prune/ban boost orphans
// and the private-channel create atomicity. Same fakeDb + recording-limiter
// conventions as the kick/leave tests — the authorization contract lives in
// the query text, so the pins assert the guarded-SQL shapes, the batch ORDER,
// and the bind sequences.
//
// Pins (RED-first shapes):
//   F1 — the prune run's batch is [roles strip, boost strip, member DELETE,
//        recount LAST]: the boost strip carries the SAME candidate predicate +
//        authority guard shapes the roles strip wears (read at
//        api/servers.mjs:2664-2673 before the pin), so a pruned booster's
//        gc_server_boosts row leaves in-batch before the member delete refutes
//        it and the recount derives from the stripped set LAST; the verdict
//        index remaps to the member delete. A refused prune whole-batch
//        no-ops (nothing stripped, one batch, recount only in-batch).
//   F2 — the ban batch is [ban INSERT, boost strip, member DELETE, roles
//        DELETE, recount LAST]: the boost strip rides the SAME ban-row EXISTS
//        arm the two deletes wear, so a banned booster stops counting, a
//        ban-of-non-member mints the ban row but strips nothing, and a
//        refused bans stays the idempotent 200 / shared 403 pair.
//   F4 — the private create is ONE batch: the channel row (bound its
//        PRE-READ literal id — the servers.mjs discipline: no id is ever
//        derived INSIDE a batch) plus the @everyone deny-VIEW row and the
//        per-role allow-VIEW row, so a refused create can never leave
//        overwrite rows behind (nor a public channel that was meant private).
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 1;
const TARGET_ID = 44;
const VIEW = SERVER_PERMISSIONS.VIEW;

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

async function bodyOf(response) {
  return JSON.parse(await response.text());
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
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
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

function envWithRecordingLimiters(db) {
  const env = { GOOBER_DB: db, limiterCalls: [] };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = {
      limit: async ({ key }) => {
        env.limiterCalls.push({ binding, key });
        return { success: true, key };
      },
    };
  }
  return env;
}

// The signed-in shape: a session row behind the vendored readSession SELECT.
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

async function dispatchHandler(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  let response;
  try {
    response = await handleServerRoutes(
      request,
      env,
      url,
      path,
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

async function dispatch(routes, method, path, body) {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const env = envWithRecordingLimiters(db);
  const response = await dispatchHandler(
    request(method, path, body, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
    }),
    env,
  );
  return { db, env, response };
}

// The KICK-holding actor row the prune route's classification read answers.
const ACTOR_CONTEXT_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("AS position") &&
  sql.includes("FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?");

const KICK_ACTOR = async () => ({ role: "member", nickname: null, permissions: "4", position: 5 });

// --- SQL shape routes ------------------------------------------------------------

const PRUNE_ROLES_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_member_roles WHERE server_id = ? AND EXISTS (");
const PRUNE_BOOST_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_boosts WHERE server_id = ? AND EXISTS (");
const PRUNE_MEMBERS_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_members AS m WHERE (");
const RECOUNT_TEST = (sql) => sql.startsWith("UPDATE gc_servers SET boosts");
const BAN_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_server_bans");
const BAN_BOOST_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_boosts WHERE server_id = ? AND user_id = ?");
const BAN_MEMBER_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ?");
const BAN_ROLES_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ?");
const BAN_DIAG_TEST = (sql) =>
  sql.startsWith("SELECT reason, created_at FROM gc_server_bans");
const CHANNEL_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_channels (id,");
const OVERWRITE_DENY_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_channel_overwrites") && sql.includes("SELECT ?, NULL, 0, ? WHERE EXISTS");
const OVERWRITE_ALLOW_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_channel_overwrites") && sql.includes("SELECT ?, id, ?, 0 FROM gc_roles");
const NEXT_CHANNEL_ID_TEST = (sql) => sql.includes("AS next_channel_id");
const CHANNEL_RESELECT_TEST = (sql) =>
  sql.includes("SELECT id, name, kind, position FROM gc_channels WHERE id = ? AND server_id = ?");

function batchOf(db) {
  return db.calls.find((call) => call.call === "batch");
}

// --- F1: the prune run strips the boost row and recounts in-batch ----------------

async function dispatchPrune(changes = 1) {
  return dispatch(
    [
      { test: ACTOR_CONTEXT_TEST, first: KICK_ACTOR },
      { test: PRUNE_ROLES_DELETE_TEST, run: async () => ({ meta: { changes } }) },
      { test: PRUNE_BOOST_DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) },
      { test: PRUNE_MEMBERS_DELETE_TEST, run: async () => ({ meta: { changes } }) },
      { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
    ],
    "POST",
    "/api/servers/" + SERVER_ID + "/prune",
    { days: 7, dry_run: false },
  );
}

test("F1: the prune run is ONE batch of four: roles strip, boost strip, member DELETE, recount LAST", async () => {
  const { response, db } = await dispatchPrune();
  assert.equal(response.status, 200);

  // TWO writes: the batched run, never a standalone recount, plus the
  // audit row's own batch (T-R26-AUDIT — the prune's commit point records).
  const writes = db.calls.filter((call) => call.call === "run" || call.call === "batch");
  assert.equal(writes.length, 2);
  const batch = batchOf(db);
  assert.ok(batch);
  assert.equal(batch.statements.length, 4);

  // Batch ORDER is load-bearing (D1's batch is one sequential transaction):
  // the candidate strips precede the member-row DELETE (their candidate
  // EXISTS arms die the moment that DELETE fires), and the recount derives
  // from the stripped set in-batch.
  assert.match(batch.statements[0].sql, /^DELETE FROM gc_member_roles/);
  assert.match(batch.statements[1].sql, /^DELETE FROM gc_server_boosts/);
  assert.match(batch.statements[2].sql, /^DELETE FROM gc_server_members AS m/);
  assert.match(batch.statements[3].sql, /^UPDATE gc_servers SET boosts =/);

  // Statement 0: the audited roles strip (the mirror anchor) — the SAME
  // candidate predicate + authority guard the roles delete at
  // api/servers.mjs:2664-2667 wears.
  const rolesDelete = batch.statements[0];
  assert.match(rolesDelete.sql, /gc_server_members m WHERE/);
  assert.match(rolesDelete.sql, /m\.role <> 'owner'/);
  assert.match(rolesDelete.sql, /m\.joined_at <= \?/);
  assert.match(rolesDelete.sql, /NOT EXISTS \(SELECT 1 FROM gc_messages pa JOIN gc_channels pc/);

  // Statement 1: the boost strip — the SAME candidate predicate + authority
  // guard shapes as the roles strip (identical WHERE, identical binds), so a
  // pruned booster's row leaves before the member delete refutes it.
  const boostDelete = batch.statements[1];
  assert.match(
    boostDelete.sql,
    /^DELETE FROM gc_server_boosts WHERE server_id = \? AND EXISTS \(SELECT 1 FROM gc_server_members m WHERE /,
  );
  assert.equal(
    boostDelete.sql.slice(boostDelete.sql.indexOf("SELECT 1 FROM gc_server_members")),
    rolesDelete.sql.slice(rolesDelete.sql.indexOf("SELECT 1 FROM gc_server_members")),
    "the boost strip wears the IDENTICAL candidate predicate + guard as the roles strip",
  );
  assert.deepEqual(boostDelete.bound, rolesDelete.bound);
  assert.equal(rolesDelete.bound[0], SERVER_ID, "the strip's own server id leads, then the candidate binds");

  // Statement 2: the aliased member DELETE (the verdict statement) —
  // candidate binds only (no leading server id).
  const memberDelete = batch.statements[2];
  assert.match(memberDelete.sql, /^DELETE FROM gc_server_members AS m WHERE /);
  assert.deepEqual(memberDelete.bound, rolesDelete.bound.slice(1));

  // Statement 3: the recount rides IN-batch LAST, bound (serverId, serverId).
  const recount = batch.statements[3];
  assert.match(recount.sql, /^UPDATE gc_servers SET boosts =/);
  assert.deepEqual(recount.bound, [SERVER_ID, SERVER_ID]);
});

test("F1: a pruned booster stops counting — the strip precedes the member DELETE, the recount derives AFTER", async () => {
  // Sequential-visibility sim (D1's batch = one sequential transaction): the
  // strips' candidate-EXISTS arms (memberSet non-empty) only true before the
  // member DELETE fires; a strip running after it refutes to 0 and the boost
  // row would survive, keep counting via the recount, and re-grant on rejoin.
  let memberAlive = true;
  let boostRows = [TARGET_ID, 99];
  const routes = [
    { test: ACTOR_CONTEXT_TEST, first: KICK_ACTOR },
    {
      test: PRUNE_ROLES_DELETE_TEST,
      run: async () => ({ meta: { changes: memberAlive ? 1 : 0 } }),
    },
    {
      test: PRUNE_BOOST_DELETE_TEST,
      run: async () => {
        if (!memberAlive) return { meta: { changes: 0 } };
        boostRows = boostRows.filter((id) => id !== TARGET_ID);
        return { meta: { changes: 1 } };
      },
    },
    {
      test: PRUNE_MEMBERS_DELETE_TEST,
      run: async () => {
        memberAlive = false;
        return { meta: { changes: 1 } };
      },
    },
    {
      test: RECOUNT_TEST,
      run: async () => {
        const derived = boostRows.length;
        return { meta: { changes: 1, derived } };
      },
    },
  ];
  const { response, db } = await dispatch(routes, "POST",
    "/api/servers/" + SERVER_ID + "/prune", { days: 7, dry_run: false });
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { dry_run: false, kicked: 1 });
  assert.ok(!boostRows.includes(TARGET_ID), "the pruned booster's row is gone");
  assert.deepEqual(boostRows, [99]);
});

test("F1: a refused prune whole-batch no-ops — nothing stripped, recount only in-batch", async () => {
  const seen = { roles: null, boost: null, member: null };
  const routes = [
    { test: ACTOR_CONTEXT_TEST, first: KICK_ACTOR },
    { test: PRUNE_ROLES_DELETE_TEST, run: async () => (seen.roles = 0, { meta: { changes: 0 } }) },
    { test: PRUNE_BOOST_DELETE_TEST, run: async () => (seen.boost = 0, { meta: { changes: 0 } }) },
    { test: PRUNE_MEMBERS_DELETE_TEST, run: async () => (seen.member = 0, { meta: { changes: 0 } }) },
    { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ];
  const { db, response } = await dispatch(routes, "POST",
    "/api/servers/" + SERVER_ID + "/prune", { days: 30, dry_run: false });
  // The run path never classifies a 403 — the authorization rides the batch
  // itself, so a refusal answers the existing 200 with kicked: 0.
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { dry_run: false, kicked: 0 });
  assert.deepEqual(seen, { roles: 0, boost: 0, member: 0 });
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" && RECOUNT_TEST(call.sql)),
    [],
    "the recount is ONLY ever in-batch (no standalone run)",
  );
});

// --- F2: the ban strips the boost row and recounts in-batch ----------------------

async function dispatchBan(changes = 1, { banChanges = null } = {}) {
  return dispatch(
    [
      { test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: banChanges ?? changes } }) },
      { test: BAN_BOOST_DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) },
      { test: BAN_MEMBER_DELETE_TEST, run: async () => ({ meta: { changes: changes } }) },
      { test: BAN_ROLES_DELETE_TEST, run: async () => ({ meta: { changes } }) },
      { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
      { test: BAN_DIAG_TEST, first: async () => ({ reason: "x", created_at: 1 }) },
    ],
    "POST",
    "/api/servers/" + SERVER_ID + "/bans",
    { user_id: TARGET_ID },
  );
}

test("F2: the ban is ONE batch of five: ban INSERT, boost strip, member DELETE, roles DELETE, recount LAST", async () => {
  const { response, db } = await dispatchBan();
  assert.equal(response.status, 201);
  // The existing 201 shape (reason/bannedAt ride the INSERT's own values).
  const banBody = await bodyOf(response);
  assert.equal(banBody.changed, true);
  assert.equal(banBody.ban.serverId, SERVER_ID);
  assert.equal(banBody.ban.userId, TARGET_ID);

  // TWO writes: the batch, never a standalone recount, plus the audit
  // row's own batch (T-R26-AUDIT — the ban's commit point records).
  const writes = db.calls.filter((call) => call.call === "run" || call.call === "batch");
  assert.equal(writes.length, 2);
  const batch = batchOf(db);
  assert.ok(batch);
  assert.equal(batch.statements.length, 5);

  // Batch ORDER is load-bearing: the ban INSERT mints the rider arm, the
  // boost strip + the two deletes ride its ban-row EXISTS arm (alive the
  // moment the INSERT landed), and the recount derives from the stripped set
  // in-batch LAST.
  assert.match(batch.statements[0].sql, /^INSERT INTO gc_server_bans/);
  assert.match(batch.statements[1].sql, /^DELETE FROM gc_server_boosts/);
  assert.match(batch.statements[2].sql, /^DELETE FROM gc_server_members/);
  assert.match(batch.statements[3].sql, /^DELETE FROM gc_member_roles/);
  assert.match(batch.statements[4].sql, /^UPDATE gc_servers SET boosts =/);

  // Statement 1: the boost strip — the SAME ban-row EXISTS arm the member +
  // roles deletes wear, so a refused ban can never strip a booster who
  // stayed.
  const boostDelete = batch.statements[1];
  assert.match(
    boostDelete.sql,
    /^DELETE FROM gc_server_boosts WHERE server_id = \? AND user_id = \? AND EXISTS \(SELECT 1 FROM gc_server_bans gb WHERE gb\.server_id = \? AND gb\.user_id = \?\)/,
  );
  assert.equal(boostDelete.sql.includes("last_insert_rowid"), false);
  assert.deepEqual(boostDelete.bound, [SERVER_ID, TARGET_ID, SERVER_ID, TARGET_ID]);

  // Statement 4: the recount rides IN-batch LAST, bound (serverId, serverId).
  const recount = batch.statements[4];
  assert.match(recount.sql, /^UPDATE gc_servers SET boosts =/);
  assert.deepEqual(recount.bound, [SERVER_ID, SERVER_ID]);
});

test("F2: a banned booster stops counting — the strips precede the member DELETE, the recount derives AFTER", async () => {
  let banRowAlive = false;
  let boostRows = [TARGET_ID, 99];
  let recountDerived = null;
  const routes = [
    {
      test: BAN_INSERT_TEST,
      run: async () => {
        banRowAlive = true;
        return { meta: { changes: 1 } };
      },
    },
    {
      test: BAN_BOOST_DELETE_TEST,
      run: async () => {
        if (!banRowAlive) return { meta: { changes: 0 } };
        boostRows = boostRows.filter((id) => id !== TARGET_ID);
        return { meta: { changes: 1 } };
      },
    },
    {
      test: BAN_MEMBER_DELETE_TEST,
      run: async () => ({ meta: { changes: 1 } }),
    },
    {
      test: BAN_ROLES_DELETE_TEST,
      run: async () => ({ meta: { changes: 1 } }),
    },
    {
      test: RECOUNT_TEST,
      run: async () => {
        recountDerived = boostRows.length;
        return { meta: { changes: 1 } };
      },
    },
  ];
  const { response } = await dispatch(routes, "POST",
    "/api/servers/" + SERVER_ID + "/bans", { user_id: TARGET_ID });
  assert.equal(response.status, 201);
  assert.ok(!boostRows.includes(TARGET_ID), "the banned booster's row is gone");
  assert.deepEqual(boostRows, [99]);
  assert.equal(recountDerived, 1, "the recount derived its value after the strip");
});

test("F2: a ban of a NON-MEMBER still mints the ban row — the strips no-op, the recount rides", async () => {
  const seen = { boost: null, member: null, roles: null };
  const routes = [
    { test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: 1 } }) },
    { test: BAN_BOOST_DELETE_TEST, run: async () => (seen.boost = 0, { meta: { changes: 0 } }) },
    { test: BAN_MEMBER_DELETE_TEST, run: async () => (seen.member = 0, { meta: { changes: 0 } }) },
    { test: BAN_ROLES_DELETE_TEST, run: async () => (seen.roles = 0, { meta: { changes: 0 } }) },
    { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ];
  const { response, db } = await dispatch(routes, "POST",
    "/api/servers/" + SERVER_ID + "/bans", { user_id: TARGET_ID });
  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).changed, true);
  assert.deepEqual(seen, { boost: 0, member: 0, roles: 0 });
  assert.equal(batchOf(db).statements.length, 5);
});

test("F2: a refused ban stays the idempotent 200 / shared 403 pair — recount only in-batch", async () => {
  // Already-banned (the diagnostic read finds the row): idempotent 200.
  const idempotent = await dispatchBan(0, {
    banChanges: 0,
  });
  assert.equal(idempotent.response.status, 200);
  assert.equal((await bodyOf(idempotent.response)).changed, false);

  // One no-op batch; the recount is ONLY ever in-batch (no standalone run).
  assert.equal(idempotent.db.calls.filter((call) => call.call === "batch").length, 1);
  assert.deepEqual(
    idempotent.db.calls.filter((call) => call.call === "run" && RECOUNT_TEST(call.sql)),
    [],
  );

  // Refused outright (no existing ban row behind the diagnostic): shared 403.
  const refusedRoutes = (await dispatch(
    [
      { test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
      { test: BAN_BOOST_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
      { test: BAN_MEMBER_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
      { test: BAN_ROLES_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
      { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
      { test: BAN_DIAG_TEST, first: async () => null },
    ],
    "POST",
    "/api/servers/" + SERVER_ID + "/bans",
    { user_id: TARGET_ID },
  ));
  assert.equal(refusedRoutes.response.status, 403);
});

async function dispatchChannel(body = {}, { channelChanges = 1 } = {}) {
  return dispatch(
    [
      { test: NEXT_CHANNEL_ID_TEST, first: async () => ({ next_channel_id: 90 }) },
      { test: CHANNEL_INSERT_TEST, run: async () => ({ meta: { changes: channelChanges } }) },
      { test: CHANNEL_RESELECT_TEST, first: async () => ({ id: 90, name: "mods-only", kind: "text", position: 3 }) },
    ],
    "POST",
    "/api/servers/" + SERVER_ID + "/channels",
    body,
  );
}

// --- F4: the private create rides ONE atomic batch ---------------------------------

test("F4: a private create is ONE batch of three: channel row + @everyone deny-VIEW + per-role allow-VIEW", async () => {
  const { response, db } = await dispatchChannel({ name: "mods-only", kind: "text", private: true });
  assert.equal(response.status, 201);
  const created = await bodyOf(response);
  assert.deepEqual(created, {
    channel: { id: 90, name: "mods-only", kind: "text", position: 3, private: true },
  });

  // The id was PRE-READ (no id is ever derived INSIDE a batch) and no second
  // overwrite batch follows the create.
  assert.equal(db.calls.filter((call) => call.call === "first" && NEXT_CHANNEL_ID_TEST(call.sql)).length, 1);
  const writes = db.calls.filter((call) => call.call === "run" || call.call === "batch");
  assert.equal(writes.length, 1);
  const batch = batchOf(db);
  assert.ok(batch);
  assert.equal(batch.statements.length, 3);

  // The channel row rides the batch FIRST, bound its pre-read literal id.
  const channelInsert = batch.statements[0];
  assert.match(
    channelInsert.sql,
    /^INSERT INTO gc_channels \(id, server_id, name, kind, position, created_at\)/,
  );
  assert.equal(channelInsert.bound[0], 90);
  assert.equal(channelInsert.bound[1], SERVER_ID);
  assert.equal(channelInsert.sql.includes("last_insert_rowid"), false);
  assert.match(channelInsert.sql, /role IN \('owner','moderator'\)/);

  // The overwrite pair rides the SAME batch, bound the SAME literal id, each
  // gated on the channel's EXISTS (a changes-0 create never aborts a D1
  // batch — zero rows is not an error — so an ungated pair would FK-fail a
  // 500 out of every refused private create; the EXISTS arm no-ops them
  // in-batch instead and the stmt[0] verdict classifies).
  const everyone = batch.statements[1];
  assert.match(
    everyone.sql,
    /^INSERT INTO gc_channel_overwrites \(channel_id, role_id, allow_mask, deny_mask\) SELECT \?, NULL, 0, \? WHERE EXISTS \(SELECT 1 FROM gc_channels WHERE id = \? AND server_id = \?\)/,
  );
  assert.equal(everyone.sql.includes("last_insert_rowid"), false);
  assert.deepEqual(everyone.bound, [90, VIEW, 90, SERVER_ID]);
  const roles = batch.statements[2];
  assert.match(
    roles.sql,
    /^INSERT INTO gc_channel_overwrites \(channel_id, role_id, allow_mask, deny_mask\) SELECT \?, id, \?, 0 FROM gc_roles WHERE server_id = \? AND EXISTS \(SELECT 1 FROM gc_channels WHERE id = \? AND server_id = \?\)/,
  );
  assert.equal(roles.sql.includes("last_insert_rowid"), false);
  assert.deepEqual(roles.bound, [90, VIEW, SERVER_ID, 90, SERVER_ID]);
});

test("F4: a refused private create leaves NO overwrite rows — the EXISTS arm no-ops the pair in-batch", async () => {
  // FK-semantics sim: the overwrite statements answer the channel's EXISTS —
  // a refused create (changes-0 stmt[0]) leaves the channel row absent, so
  // the pair can only ever move 0 rows (real D1 would otherwise throw
  // FOREIGN KEY constraint failed at the ungated inserts).
  const seen = { everyone: null, roles: null };
  const routes = [
    { test: NEXT_CHANNEL_ID_TEST, first: async () => ({ next_channel_id: 90 }) },
    { test: CHANNEL_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    {
      test: OVERWRITE_DENY_TEST,
      run: async () => {
        // The channel row is absent — the EXISTS arm refutes.
        seen.everyone = 0;
        return { meta: { changes: 0 } };
      },
    },
    {
      test: OVERWRITE_ALLOW_TEST,
      run: async () => {
        seen.roles = 0;
        return { meta: { changes: 0 } };
      },
    },
    { test: CHANNEL_RESELECT_TEST, first: async () => ({ id: 90, name: "mods-only", kind: "text", position: 3 }) },
  ];
  const session = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => session.row }, ...routes]);
  const env = envWithRecordingLimiters(db);
  const response = await dispatchHandler(
    request("POST", "/api/servers/" + SERVER_ID + "/channels",
      { name: "mods-only", kind: "text", private: true }, {
        Cookie: "goober_session=" + session.token,
        "X-CSRF-Token": session.csrf,
      }),
    env,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });

  // ONE batch: the overwrite pair rode the create's batch, and the refusal
  // never minted them.
  assert.deepEqual(seen, { everyone: 0, roles: 0 });
  const batch = batchOf(db);
  assert.ok(batch, "the overwrite pair rides the create's OWN batch, not a follow-on");
  assert.equal(batch.statements.length, 3);
  assert.equal(
    batch.statements[0].sql.startsWith("INSERT INTO gc_channels (id,"),
    true,
    "the create is the batch's first statement",
  );
  // The pair is gated: BOTH statements carry the channel EXISTS (the 403/400
  // taxonomy survives off stmt[0]'s changes verdict, never a 500).
  for (const overwrite of batch.statements.slice(1)) {
    assert.match(
      overwrite.sql,
      /EXISTS \(SELECT 1 FROM gc_channels WHERE id = \? AND server_id = \?\)/,
      "the overwrite INSERT rides a channel EXISTS no-op arm",
    );
  }
  assert.ok(
    db.calls.every((call) => call.call !== "run"),
    "no standalone statement ever ran beside the batch",
  );
});

test("F4: a bare (non-private) create is ONE batch of one, bound its pre-read id", async () => {
  const { response, db } = await dispatchChannel({ name: "general", kind: "text" });
  assert.equal(response.status, 201);
  const created = await bodyOf(response);
  assert.equal(created.channel.id, 90);
  assert.equal(created.channel.private, undefined);

  const batch = batchOf(db);
  assert.ok(batch);
  assert.equal(batch.statements.length, 1);
  assert.match(
    batch.statements[0].sql,
    /^INSERT INTO gc_channels \(id, server_id, name, kind, position, created_at\)/,
  );
  assert.equal(batch.statements[0].bound[0], 90);
});
