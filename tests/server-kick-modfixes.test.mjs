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

// GO-HAYWIRE cycle-8 kick lane: the moderation family's fixes. Same fakeDb +
// recording-limiter conventions as the leave/transfer tests — the
// authorization contract lives in the query text, so the pins assert the
// guarded-SQL shapes, the batch ORDER, and the bind sequences.
//
// Audit-only note (F6, recorded not fixed): gc_server_invites rows created
// by a member who later leaves or is kicked persist by design — invites carry
// expiry (and the join routes' BANNED case), so the 00-row-scoped cleanup is
// a non-goal; invite behavior is NOT changed here.
//
// Pins (RED-first shapes): kick's batch is [roles strip, boost strip,
// member DELETE, recount-last] with the strips riding BEFORE the member row
// (their membership-EXISTS arms die the moment that delete fires); every
// strip carries the target's membership-EXISTS + role <> 'owner' arm (kick's
// mirror of leave's cycle-7 riders) plus the SAME moderation guard, so a
// refused kick — owner target included — strips nothing; the recount rides
// in-batch LAST; and each moderation route spends a write wall keyed
// servers-<verb>:<serverId>:<userId>.
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 1;
const TARGET_ID = 44;

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

// --- SQL shape routes ------------------------------------------------------------

const MEMBER_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_server_members");
const ROLES_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_member_roles");
const BOOST_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_server_boosts");
const RECOUNT_TEST = (sql) => sql.startsWith("UPDATE gc_servers SET boosts");
const BAN_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_server_bans");
const UNBAN_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_server_bans");
const TIMEOUT_SET_TEST = (sql) =>
  sql.startsWith("UPDATE gc_server_members SET timed_out_until = ?") && sql.includes("role <> 'owner'");
const TIMEOUT_UNSET_TEST = (sql) =>
  sql.startsWith("UPDATE gc_server_members SET timed_out_until = NULL");

// The moderated-arm every kick strip embeds: the target's membership row still
// exists with role <> 'owner' (kick's mirror of setTimeout's arm — the same
// clause is the membership-EXISTS arm, so the strips ride BEFORE the member
// DELETE and refute for an owner target in one clause).
const STRIP_ARM_TEST = (sql) =>
  sql.includes("EXISTS (SELECT 1 FROM gc_server_members ks WHERE ks.server_id = ? AND " +
    "ks.user_id = ? AND ks.role <> 'owner')");

// --- F1: kick's batch strips the boost row and recounts in-batch -----------------

async function dispatchKick(changes, { boosts = [TARGET_ID] } = {}) {
  return dispatch(
    [
      { test: ROLES_DELETE_TEST, run: async () => ({ meta: { changes } }) },
      { test: BOOST_DELETE_TEST, run: async () => ({ meta: { changes } }) },
      { test: MEMBER_DELETE_TEST, run: async () => ({ meta: { changes } }) },
      { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
    ],
    "DELETE",
    "/api/servers/" + SERVER_ID + "/members/" + TARGET_ID,
  );
}

test("a kick is ONE batch of four: roles strip, boost strip, member DELETE, recount LAST", async () => {
  const { response, db } = await dispatchKick(1);
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { kicked: true, serverId: SERVER_ID, userId: TARGET_ID });

  // TWO writes: the guarded batch, never a standalone recount, plus the
  // audit row's own batch (T-R26-AUDIT — the kick's commit point records).
  const writes = db.calls.filter((call) => call.call === "run" || call.call === "batch");
  assert.equal(writes.length, 2);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.equal(batch.statements.length, 4);

  // Batch ORDER is load-bearing: the strips precede the member-row DELETE
  // (their membership-EXISTS arms die the moment that DELETE fires), and the
  // recount derives from the stripped set in-batch.
  assert.match(batch.statements[0].sql, /^DELETE FROM gc_member_roles/);
  assert.match(batch.statements[1].sql, /^DELETE FROM gc_server_boosts/);
  assert.match(batch.statements[2].sql, /^DELETE FROM gc_server_members/);
  assert.match(batch.statements[3].sql, /^UPDATE gc_servers SET boosts =/);

  // Statement 0: the roles strip — the target's membership-EXISTS + owner arm
  // rides FIRST, then the SAME KICK moderation guard the member DELETE wore.
  const rolesDelete = batch.statements[0];
  assert.match(rolesDelete.sql, /^DELETE FROM gc_member_roles WHERE server_id = \? AND user_id = \?/);
  assert.ok(STRIP_ARM_TEST(rolesDelete.sql), "the membership-EXISTS + owner arm rides the roles strip");
  // Guard binds in TEXTUAL order — owner pair, per-bit pair, the hierarchy's
  // actor read, its target read — 8 binds (tests/guard-binds.test.mjs pins
  // the arithmetic; the stale 10-bind shape carried a duplicate actor pair).
  assert.match(rolesDelete.sql, /gc_member_roles gbm4 JOIN gc_roles gbr4/);
  assert.match(rolesDelete.sql, /\(gbr4\.permissions & 4\) <> 0/);
  assert.match(
    rolesDelete.sql,
    /\(SELECT COALESCE\(MAX\(hr\.position\), -1\) FROM gc_member_roles hmr[\s\S]*>[\s\S]*\(SELECT COALESCE\(MAX\(hr\.position\), -1\)/,
  );
  assert.deepEqual(
    rolesDelete.bound,
    [SERVER_ID, TARGET_ID, SERVER_ID, TARGET_ID,
      SERVER_ID, USER_ID, SERVER_ID, USER_ID,
      SERVER_ID, USER_ID, SERVER_ID, TARGET_ID],
  );

  // Statement 1: the boost strip — the SAME shape on gc_server_boosts, so a
  // kicked booster's row leaves in the same breath (no FK/trigger ties it to
  // membership either).
  const boostDelete = batch.statements[1];
  assert.match(boostDelete.sql, /^DELETE FROM gc_server_boosts WHERE server_id = \? AND user_id = \?/);
  assert.ok(STRIP_ARM_TEST(boostDelete.sql), "the membership-EXISTS + owner arm rides the boost strip");
  assert.deepEqual(
    boostDelete.bound,
    [SERVER_ID, TARGET_ID, SERVER_ID, TARGET_ID,
      SERVER_ID, USER_ID, SERVER_ID, USER_ID,
      SERVER_ID, USER_ID, SERVER_ID, TARGET_ID],
  );

  // Statement 2: the member row's guarded DELETE (the verdict statement).
  const memberDelete = batch.statements[2];
  assert.match(
    memberDelete.sql,
    /^DELETE FROM gc_server_members WHERE server_id = \? AND user_id = \? AND role <> 'owner' AND/,
  );
  assert.equal(STRIP_ARM_TEST(memberDelete.sql), false, "statement 2 keeps its own shape — the strips carry the arm");
  assert.deepEqual(
    memberDelete.bound,
    [SERVER_ID, TARGET_ID, SERVER_ID, USER_ID, SERVER_ID, USER_ID,
      SERVER_ID, USER_ID, SERVER_ID, TARGET_ID],
  );

  // Statement 3: the recount rides IN-batch LAST, bound (serverId, serverId).
  const recount = batch.statements[3];
  assert.match(recount.sql, /^UPDATE gc_servers SET boosts =/);
  assert.deepEqual(recount.bound, [SERVER_ID, SERVER_ID]);
});

test("a kicked booster's count drops — the strips precede the member delete, the recount derives AFTER", async () => {
  // Sequential-visibility sim (D1's batch = one sequential transaction): the
  // strips' membership-EXISTS arms (memberRowAlive) only true before the
  // member DELETE fires; a strip running after it refutes to 0 and the boost
  // row would survive, keep counting via the recount, and re-grant on rejoin.
  let memberRowAlive = true;
  let boostRows = [TARGET_ID, 99];
  let rolesChanges = null;
  let recountDerived = null;
  const routes = (deleteChanges) => [
    {
      test: ROLES_DELETE_TEST,
      run: async () => {
        rolesChanges = memberRowAlive ? deleteChanges : 0;
        return { meta: { changes: rolesChanges } };
      },
    },
    {
      test: BOOST_DELETE_TEST,
      run: async () => {
        if (!memberRowAlive) return { meta: { changes: 0 } };
        boostRows = boostRows.filter((id) => id !== TARGET_ID);
        return { meta: { changes: 1 } };
      },
    },
    {
      test: MEMBER_DELETE_TEST,
      run: async () => {
        memberRowAlive = false;
        return { meta: { changes: deleteChanges } };
      },
    },
    {
      test: RECOUNT_TEST,
      run: async () => {
        recountDerived = boostRows.length;
        return { meta: { changes: 1 } };
      },
    },
  ];
  const { response } = await dispatch(routes(1), "DELETE",
    "/api/servers/" + SERVER_ID + "/members/" + TARGET_ID);
  assert.equal(response.status, 200);
  // The strips ran while the member row was alive — both landed.
  assert.equal(rolesChanges, 1);
  assert.ok(!boostRows.includes(TARGET_ID), "the kicked booster's row is gone");
  assert.deepEqual(boostRows, [99]);
  assert.equal(recountDerived, 1, "the recount derived its value after the strip");
});

test("a refused kick (0 changes) 403s, strips nothing, and still recounts in-batch", async () => {
  const { db, response } = await dispatchKick(0);
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  // One no-op batch; the recount is ONLY ever in-batch (no standalone run).
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" && RECOUNT_TEST(call.sql)),
    [],
  );
});

test("F2: a kick refused on an OWNER target strips nothing — roles, boost, and member all 0", async () => {
  // The owner row survives the kick (the member DELETE's role <> 'owner'
  // rider and both strips' role <> 'owner' arm refute), so the
  // roles/boost routes report 0 and only the in-batch recount moves.
  const seen = { roles: null, boost: null, member: null };
  const routes = [
    {
      test: ROLES_DELETE_TEST,
      run: async () => {
        seen.roles = 0;
        return { meta: { changes: 0 } };
      },
    },
    {
      test: BOOST_DELETE_TEST,
      run: async () => {
        seen.boost = 0;
        return { meta: { changes: 0 } };
      },
    },
    {
      test: MEMBER_DELETE_TEST,
      run: async () => {
        seen.member = 0;
        return { meta: { changes: 0 } };
      },
    },
    { test: RECOUNT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ];
  const { db, response } = await dispatch(routes, "DELETE",
    "/api/servers/" + SERVER_ID + "/members/" + TARGET_ID);
  assert.equal(response.status, 403);
  assert.deepEqual(seen, { roles: 0, boost: 0, member: 0 });
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
});

// --- F2's arm rides BOTH strips + the wall key pins ------------------------------

test("the kick rides the write wall keyed servers-kick:<serverId>:<userId>, first after the session", async () => {
  const { db, env, response } = await dispatchKick(1);
  assert.equal(response.status, 200);
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-kick:" + SERVER_ID + ":" + USER_ID),
  }]);
  assert.match(db.calls[0].sql, /FROM sessions/);
});

test("the ban rides the write wall keyed servers-ban:<serverId>:<userId>", async () => {
  const { response, env } = await dispatch(
    [{ test: BAN_INSERT_TEST, run: async () => ({ meta: { changes: 1 } }) }],
    "POST",
    "/api/servers/" + SERVER_ID + "/bans",
    { user_id: TARGET_ID },
  );
  assert.equal(response.status, 201);
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-ban:" + SERVER_ID + ":" + USER_ID),
  }]);
});

test("an unban rides the write wall keyed servers-unban:<serverId>:<userId>", async () => {
  const { response, env } = await dispatch(
    [{ test: UNBAN_DELETE_TEST, run: async () => ({ meta: { changes: 1 } }) }],
    "DELETE",
    "/api/servers/" + SERVER_ID + "/bans/" + TARGET_ID,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { banned: false, serverId: SERVER_ID, userId: TARGET_ID });
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-unban:" + SERVER_ID + ":" + USER_ID),
  }]);
});

test("the setTimeout ride is walled at servers-timeout:<serverId>:<userId>", async () => {
  const { response, env } = await dispatch(
    [{ test: TIMEOUT_SET_TEST, run: async () => ({ meta: { changes: 1 } }) }],
    "PUT",
    "/api/servers/" + SERVER_ID + "/members/" + TARGET_ID + "/timeout",
    { minutes: 10 },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-timeout:" + SERVER_ID + ":" + USER_ID),
  }]);
});

test("the removeTimeout ride is walled at servers-untimeout:<serverId>:<userId>", async () => {
  const { response, env } = await dispatch(
    [{ test: TIMEOUT_UNSET_TEST, run: async () => ({ meta: { changes: 1 } }) }],
    "DELETE",
    "/api/servers/" + SERVER_ID + "/members/" + TARGET_ID + "/timeout",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-untimeout:" + SERVER_ID + ":" + USER_ID),
  }]);
});
