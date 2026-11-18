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

// The server rules gate (0012): the shared member gate's third arm (the
// timeout + verification gates' sibling), the routes' trio in api/rules.mjs
// (member read, self-accept, manual verify), the owner's rules_text PATCH
// field block, and the DO relay's gate pointer on the send_failed frame.
// Same fakeDb + pinned-SQL contract style as the mod-desk module: every
// write's guard rides INSIDE the SQL, and a failed write is classified
// afterwards by one diagnostic read that only picks an error message.
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleRulesRoutes } from "../api/rules.mjs";
import {
  enforceMemberGates,
  enforceMemberGatesForChannel,
  sendMessageToChannel,
  RulesGateError,
} from "../api/messages.mjs";
import { ChatRoom } from "../api/rooms.mjs";
import { RULES_GATE_MESSAGE, GC_RULES_MAX, RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { nowSeconds, randomToken, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;
const CHANNEL_ID = 12;
const NOW = nowSeconds();

// --- shared scaffolding (same conventions as the mod-desk module) ----------------

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

async function dispatch(handler, request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handler(
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

// A sessioned request (cookie + CSRF header, the requireUser/read pair).
async function authedRequest(method, path, body) {
  const { token, csrf, row } = await sessionFixtures();
  return {
    row,
    request: request(method, path, body, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
    }),
    readRequest: get(path, { Cookie: "goober_session=" + token }),
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

// --- SQL shape pins ---------------------------------------------------------------

// The gate's membership read carries all three arms' columns.
const MEMBER_GATE_SQL_TEST = (sql) =>
  sql.includes("SELECT m.timed_out_until AS timed_out_until") &&
  sql.includes("m.rules_accepted_at AS rules_accepted_at") &&
  sql.includes("FROM gc_server_members m JOIN users u ON u.id = m.user_id");
// The two server-side switches share ONE row read.
const SERVER_GATE_SQL_TEST = (sql) =>
  sql.includes("SELECT verification_level, rules_text FROM gc_servers WHERE id = ? LIMIT 1");

function gateRoutes({
  timed_out_until = null, rules_accepted_at = null, role = "member", permissions = 0,
  account_created_at = 100, joined_at = 100, server_id = 3,
  rules_text = null, verification_level = null,
} = {}) {
  return [
    {
      test: MEMBER_GATE_SQL_TEST,
      first: async () => ({
        timed_out_until, rules_accepted_at, role, permissions, account_created_at, joined_at,
      }),
    },
    // The voice-join door's channel wrapper asks this before the member read.
    {
      test: (sql) => sql.includes("SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1"),
      first: async () => ({ server_id }),
    },
    {
      test: SERVER_GATE_SQL_TEST,
      first: async () => ({ rules_text, verification_level }),
    },
  ];
}

// --- the shared gate (send + voice): the 0012 arm ----------------------------------

test("a NULL rules_text is the gate OFF — the pre-0012 behavior, no acceptance ever asked", async () => {
  const db = fakeDb(gateRoutes({ rules_accepted_at: null, rules_text: null }));
  await enforceMemberGates(envWithLimiters(db), 3, USER_ID);
  assert.ok(db.calls.find((entry) => SERVER_GATE_SQL_TEST(entry.sql)),
    "the OFF state is read off the same one server row the ladder uses");
});

test("an on gate holds an un-accepted member at the shared 403 carrying the rules pointer", async () => {
  const rules = "Rule one. Rule two.";
  const db = fakeDb(gateRoutes({ rules_accepted_at: null, rules_text: rules }));
  await assert.rejects(
    () => enforceMemberGates(envWithLimiters(db), 3, USER_ID),
    (error) => {
      assert.ok(error instanceof RulesGateError);
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.message, RULES_GATE_MESSAGE);
      // The payload is the ONE shared 403 shape: message + server + document.
      assert.deepEqual(error.payload, { error: RULES_GATE_MESSAGE, serverId: 3, rules });
      return true;
    },
  );
});

test("a member who accepted passes the rules gate in both transports (send + voice join)", async () => {
  const accepted = fakeDb(gateRoutes({ rules_accepted_at: NOW, rules_text: "Be kind." }));
  await enforceMemberGates(envWithLimiters(accepted), 3, USER_ID);

  const voice = fakeDb(gateRoutes({ rules_accepted_at: NOW, rules_text: "Be kind." }));
  await enforceMemberGatesForChannel(envWithLimiters(voice), CHANNEL_ID, USER_ID);
});

async function sendFixture({ accepted, rules_text } = {}) {
  _resetFilterWordsCacheForTests();
  const { headers } = await sessionFixtures();
  const db = fakeDb([
    channelAccessRoute(),
    ...gateRoutes({ rules_accepted_at: accepted ? NOW : null, rules_text, server_id: CHANNEL_ID }),
    // The filter's own row: no site settings row → the FILTERED_WORDS
    // fallback (a list whose only word never touches these bodies).
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => null },
    {
      test: (sql) => sql.includes("INSERT INTO gc_messages"),
      run: () => ({ meta: { changes: 1, last_row_id: 40 } }),
    },
    { test: (sql) => sql.includes("UPDATE gc_channels SET"), run: () => ({ meta: { changes: 1 } }) },
    {
      test: (sql) =>
        sql.includes("FROM gc_messages m JOIN users u ON u.id = m.author_id") &&
        sql.includes("ORDER BY m.id DESC LIMIT 1"),
      run: () => ({ meta: { changes: 1 }, results: [{
        id: 40, author_id: USER_ID, author_name: "wempos", body: "hello there",
        client_message_id: "gc-x0000001", source: null, created_at: NOW, edited_at: null, author_accent: null,
      }] }),
    },
  ]);
  return { db, env: envWithLimiters(db, { FILTERED_WORDS: "forbidden" }) };
}

function channelAccessRoute(server_id = CHANNEL_ID) {
  return {
    test: (sql) => sql.includes("FROM gc_channels c WHERE c.id = ? AND (") &&
      sql.includes("FROM gc_server_members m"),
    first: async () => ({ id: CHANNEL_ID, server_id, kind: "text" }),
  };
}

test("the rules gate blocks the SEND primitive before any write and before slowmode", async () => {
  const { env, db } = await sendFixture({ rules_text: "Be kind.", accepted: false });
  await assert.rejects(
    () => sendMessageToChannel(env, { id: USER_ID, username: "wempos" }, CHANNEL_ID, "hello there", "gc-x0000001"),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, RULES_GATE_MESSAGE);
      assert.equal(error.payload.rules, "Be kind.");
      return true;
    },
  );
  // Gate first: nothing was written and no slowmode read ever ran.
  assert.deepEqual(
    db.calls.filter((entry) =>
      entry.call === "batch" ||
      (entry.call === "run" && entry.sql.includes("INSERT INTO gc_messages"))),
    [],
  );
  assert.deepEqual(
    db.calls.filter((entry) => entry.sql.includes("slowmode_seconds")),
    [],
  );
});

test("an accepted member's send passes the gate and lands", async () => {
  const { env } = await sendFixture({ rules_text: "Be kind.", accepted: true });
  const { message, created } = await sendMessageToChannel(
    env, { id: USER_ID, username: "wempos" }, CHANNEL_ID, "hello there", "gc-x0000001",
  );
  assert.equal(created, true);
  assert.equal(message.body, "hello there");
});

// --- gate ORDER: timeout, then bypass, then rules, then verification ---------------

test("the timeout ALWAYS answers first — even with the gate pending on the same member", async () => {
  const db = fakeDb(gateRoutes({
    timed_out_until: nowSeconds() + 3600,
    rules_accepted_at: null,
    rules_text: "Be kind.",
  }));
  await assert.rejects(
    () => enforceMemberGates(envWithLimiters(db), 3, USER_ID),
    (error) => {
      assert.equal(error.status, 403);
      // The filed ISO wording, not the rules message.
      assert.match(error.message, /^You are timed out until \d{4}-\d{2}-\d{2}T/);
      return true;
    },
  );
  // The timeout never even reached the server-row read.
  assert.equal(db.calls.find((entry) => SERVER_GATE_SQL_TEST(entry.sql)), undefined);
});

test("owner and KICK_MEMBERS bypass the rules gate (and never read the server row)", async () => {
  for (const { role, permissions } of [
    { role: "owner", permissions: 0 },
    { role: "member", permissions: SERVER_PERMISSIONS.KICK_MEMBERS },
  ]) {
    const db = fakeDb(gateRoutes({ role, permissions, rules_accepted_at: null, rules_text: "Be kind." }));
    await enforceMemberGates(envWithLimiters(db), 3, USER_ID);
    assert.equal(
      db.calls.find((entry) => SERVER_GATE_SQL_TEST(entry.sql)),
      undefined,
      role + ": no server read for the bypass tiers",
    );
  }
});

test("the rules gate answers BEFORE the verification ladder — the one a member clears themselves", async () => {
  const db = fakeDb(gateRoutes({
    rules_accepted_at: null,
    rules_text: "Be kind.",
    verification_level: 4,
    account_created_at: NOW - 60,
    joined_at: NOW - 10,
  }));
  await assert.rejects(
    () => enforceMemberGates(envWithLimiters(db), 3, USER_ID),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, RULES_GATE_MESSAGE, "not the verification 403");
      return true;
    },
  );
});

test("an accepted member still rides the verification ladder under the same read", async () => {
  const db = fakeDb(gateRoutes({
    rules_accepted_at: NOW,
    rules_text: "Be kind.",
    verification_level: 4,
    account_created_at: NOW - 60,
    joined_at: NOW - 10,
  }));
  await assert.rejects(() => enforceMemberGates(envWithLimiters(db), 3, USER_ID), {
    status: 403,
    message: "You do not meet this server's verification level yet.",
  });
});

// --- the rules routes (api/rules.mjs) ----------------------------------------------

function rulesRoutes({
  rules_text = null, accepted_at = null,
  membership = true, updateChanges = 1, target = null, row,
} = {}) {
  return [
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("s.rules_text AS rules_text") && sql.includes("EXISTS"),
      first: async () => (membership ? { rules_text, accepted_at } : null),
    },
    {
      test: (sql) => sql.includes("UPDATE gc_server_members SET rules_accepted_at = COALESCE"),
      run: () => ({ meta: { changes: updateChanges, last_row_id: 1 } }),
    },
    {
      test: (sql) => sql.includes("SELECT rules_accepted_at AS accepted_at, role FROM gc_server_members"),
      first: async () => target,
    },
    {
      test: (sql) => sql.includes("SELECT rules_accepted_at AS accepted_at FROM gc_server_members"),
      first: async () => (membership ? { accepted_at } : null),
    },
  ];
}

test("GET rules reads the document and the caller's own acceptance; a non-member is the shared 403", async () => {
  const { row, readRequest } = await authedRequest("GET", "/api/servers/3/rules");
  // A gate-off server (rules null) answers the same shaped payload.
  const db = fakeDb(rulesRoutes({ row }));
  const response = await dispatch(handleRulesRoutes, readRequest, envWithLimiters(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    serverId: 3, rules: null, acceptedAt: null,
  });

  // The read preconditions the membership inside the WHERE (the EXISTS arm).
  const read = db.calls.find((entry) => entry.sql.includes("s.rules_text AS rules_text"));
  assert.ok(read);
  assert.ok(read.sql.includes("EXISTS (SELECT 1 FROM gc_server_members gm"));
  assert.deepEqual(read.bound, [USER_ID, 3, USER_ID]);

  // Not a member (the EXISTS matches nothing): the shared 403, no oracle.
  const nonMember = fakeDb(rulesRoutes({ row, membership: false }));
  const refused = await dispatch(handleRulesRoutes, readRequest, envWithLimiters(nonMember));
  assert.equal(refused.status, 403);
});

test("POST rules/accept: a fresh member records first-accept; a replay is the idempotent no-change", async () => {
  const { row, request: accept } = await authedRequest("POST", "/api/servers/3/rules/accept");
  const db = fakeDb(rulesRoutes({ row }));
  const fresh = await dispatch(handleRulesRoutes, accept, envWithLimiters(db));
  assert.equal(fresh.status, 201);
  const freshBody = await bodyOf(fresh);
  assert.equal(freshBody.accepted, true);
  assert.equal(freshBody.changed, true);
  const write = db.calls.find((entry) =>
    entry.call === "run" && entry.sql.includes("COALESCE(rules_accepted_at, ?)"));
  assert.ok(write);
  assert.equal(write.bound[1], 3);
  assert.equal(write.bound[2], USER_ID);

  // The replay (zero changes): the diagnostic read picks the idempotent
  // answer — the FIRST accepted_at survives, never re-stamped.
  const replayAuthed = await authedRequest("POST", "/api/servers/3/rules/accept");
  const replayDb = fakeDb(rulesRoutes({ row: replayAuthed.row, updateChanges: 0, accepted_at: 1234 }));
  const replay = await dispatch(handleRulesRoutes, replayAuthed.request, envWithLimiters(replayDb));
  assert.equal(replay.status, 200);
  assert.deepEqual(await bodyOf(replay), {
    accepted: true, changed: false, acceptedAt: new Date(1234 * 1000).toISOString(),
  });

  // A non-member: zero changes and no membership row → the shared 403.
  const strangerAuthed = await authedRequest("POST", "/api/servers/3/rules/accept");
  const strangerDb = fakeDb(rulesRoutes({ row: strangerAuthed.row, updateChanges: 0, membership: false }));
  const stranger = await dispatch(handleRulesRoutes, strangerAuthed.request, envWithLimiters(strangerDb));
  assert.equal(stranger.status, 403);
});

test("POST rules-verify: owner/KICK authority flips a member; the owner row and refused authority are the 403", async () => {
  const { row, request: verify } = await authedRequest(
    "POST", "/api/servers/3/members/" + TARGET_ID + "/rules-verify",
  );
  const db = fakeDb(rulesRoutes({ row }));
  const fresh = await dispatch(handleRulesRoutes, verify, envWithLimiters(db));
  assert.equal(fresh.status, 200);
  const freshBody = await bodyOf(fresh);
  assert.equal(freshBody.changed, true);
  assert.equal(freshBody.userId, TARGET_ID);

  // The owner-immunity rider inside the WHERE, and the moderation guard
  // (owner OR KICK_MEMBERS, in the H1 per-bit-EXISTS form, with the
  // strictly-below position rule).
  const write = db.calls.find((entry) =>
    entry.call === "run" && entry.sql.includes("role <> 'owner'"));
  assert.ok(write, "the owner row is immune inside the WHERE");
  assert.ok(write.sql.includes("om.role = 'owner'"));
  assert.ok(
    write.sql.includes("gc_member_roles gbm4 JOIN gc_roles gbr4") &&
      write.sql.includes("(gbr4.permissions & 4) <> 0"),
    "the KICK bit rides the guard's per-bit EXISTS arm",
  );
  assert.equal(
    write.bound.includes(SERVER_PERMISSIONS.KICK_MEMBERS), false,
    "no bit constants ride as binds",
  );

  // An already-accepted target is the idempotent no-change.
  const replayAuthed = await authedRequest(
    "POST", "/api/servers/3/members/" + TARGET_ID + "/rules-verify");
  const replayDb = fakeDb(rulesRoutes({
    row: replayAuthed.row, updateChanges: 0, target: { accepted_at: 1234, role: "member" },
  }));
  const replay = await dispatch(handleRulesRoutes, replayAuthed.request, envWithLimiters(replayDb));
  assert.equal(replay.status, 200);
  assert.equal((await bodyOf(replay)).changed, false);

  // The owner ROW target (immune) is a refusal even for the owner's own call.
  const ownerAuthed = await authedRequest(
    "POST", "/api/servers/3/members/" + TARGET_ID + "/rules-verify");
  const ownerTargetDb = fakeDb(rulesRoutes({
    row: ownerAuthed.row, updateChanges: 0, target: { accepted_at: null, role: "owner" },
  }));
  const ownerTarget = await dispatch(handleRulesRoutes, ownerAuthed.request, envWithLimiters(ownerTargetDb));
  assert.equal(ownerTarget.status, 403);

  // Refused authority / no such member: the shared 403.
  const refusedAuthed = await authedRequest(
    "POST", "/api/servers/3/members/" + TARGET_ID + "/rules-verify");
  const refusedDb = fakeDb(rulesRoutes({ row: refusedAuthed.row, updateChanges: 0, target: null }));
  const refused = await dispatch(handleRulesRoutes, refusedAuthed.request, envWithLimiters(refusedDb));
  assert.equal(refused.status, 403);
});

// --- the owner's rules_text PATCH field (api/servers.mjs) ---------------------------

async function patchRules(body, { role = "owner", updateChanges = 1 } = {}) {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("UPDATE gc_servers SET"),
      run: () => ({ meta: { changes: updateChanges, last_row_id: 3 } }),
    },
    {
      test: (sql) =>
        sql.includes("SELECT id, name, icon_media_id, is_public, verification_level FROM gc_servers"),
      first: async () => ({ id: 3, name: "Alpha", icon_media_id: null, is_public: 1, verification_level: 0 }),
    },
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => null },
  ]);
  const response = await dispatch(
    handleServerRoutes,
    request("PATCH", "/api/servers/3", body, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
    }),
    envWithLimiters(db, { FILTERED_WORDS: "forbidden" }),
  );
  return { response, db };
}

// NOTE: the fake UPDATE answers whatever the route fixture says — the session
// role does NOT gate it, so the non-owner case pins the SQL's owner_user_id
// WHERE by setting the fake to the guard's refused (zero-changes) outcome.
test("the owner sets and clears the rules document through the guarded server PATCH", async () => {
  _resetFilterWordsCacheForTests();
  const set = await patchRules({ rules_text: "  Be kind to each other.  " });
  assert.equal(set.response.status, 200);
  const update = set.db.calls.find(
    (entry) => entry.call === "run" && entry.sql.includes("rules_text = ?"));
  assert.ok(update);
  assert.equal(update.bound[0], "Be kind to each other.", "the document stores trimmed");
  assert.ok(update.sql.includes("owner_user_id = ?"), "owner-only WHERE");

  const clear = await patchRules({ rules_text: null });
  assert.equal(clear.response.status, 200);
  const clearUpdate = clear.db.calls.find(
    (entry) => entry.call === "run" && entry.sql.includes("rules_text = ?"));
  assert.deepEqual(clearUpdate.bound[0], null, "null is the gate OFF");
});

test("the rules PATCH refuses a guard-miss, an over-limit text, and a filtered document before any write", async () => {
  _resetFilterWordsCacheForTests();

  const nonOwner = await patchRules({ rules_text: "Be kind." }, { updateChanges: 0 });
  assert.equal(nonOwner.response.status, 403);
  assert.equal(
    (await bodyOf(nonOwner.response)).error,
    "You do not have permission to do that.",
    "the shared 403, no oracle",
  );
  // The guard-miss answer carries NO diagnostic read AFTER the write: the
  // ONE guarded UPDATE's zero changes is the whole refusal (the session read
  // and the word-filter row read happened at collection time, before it).
  const refusedUpdate = nonOwner.db.calls.find(
    (entry) => entry.call === "run" && entry.sql.includes("rules_text = ?"));
  assert.ok(refusedUpdate.sql.includes("owner_user_id = ?"));
  assert.equal(refusedUpdate.bound[0], "Be kind.");
  const writesIndex = nonOwner.db.calls.findIndex((entry) => entry.call === "run");
  assert.deepEqual(
    nonOwner.db.calls.slice(writesIndex + 1).map((entry) => entry.call),
    [],
  );

  const oversized = await patchRules({ rules_text: "a".repeat(GC_RULES_MAX + 1) });
  assert.equal(oversized.response.status, 400);

  const blank = await patchRules({ rules_text: "   " });
  assert.equal(blank.response.status, 400);

  const filtered = await patchRules({ rules_text: "say forbidden please" });
  assert.equal(filtered.response.status, 400);
  assert.equal((await bodyOf(filtered.response)).error, "That rules text isn't allowed.");

  for (const [db, name] of [
    [oversized.db, "oversized"], [blank.db, "blank"], [filtered.db, "filtered"],
  ]) {
    assert.equal(
      db.calls.find((entry) => entry.call === "run" && entry.sql.includes("rules_text = ?")),
      undefined,
      name + ": no write ever ran",
    );
  }
});

// --- the DO relay's gate pointer on the send_failed frame ---------------------------

function fakeCtx() {
  const accepted = [];
  return {
    accepted,
    acceptWebSocket(ws) { accepted.push(ws); },
    getWebSockets() { return accepted.slice(); },
  };
}

// The M3 (RBAC audit) fan-in door's own reads, for the DO tests: the channel
// shape and the member EXISTS (plain `SELECT 1` — distinct from the layer
// gate's `SELECT role`).
const FANIN_CHANNEL_DOOR_TEST = (sql) =>
  sql.includes("SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1");
const FANIN_MEMBER_DOOR_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");

test("the DO relays the rules pointer on the send_failed frame the REST 403 carries", async () => {
  const ctx = fakeCtx();
  const room = new ChatRoom(ctx, {
    GOOBER_DB: fakeDb([
      { test: FANIN_CHANNEL_DOOR_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 3, kind: "text" }) },
      { test: FANIN_MEMBER_DOOR_TEST, first: async () => ({ 1: 1 }) },
    ]),
    __sendMessageToChannel: async () => {
      throw new RulesGateError(3, "Be kind.");
    },
  });

  const upgrade = new Request(
    "https://chat.internal/api/ws?channel=" + CHANNEL_ID + "&userId=" + USER_ID +
      "&username=wempos&channelKind=text",
    { headers: { Upgrade: "websocket" } },
  );
  const response = await room.fetch(upgrade);
  assert.equal(response.status, 101);

  await room.webSocketMessage(
    ctx.accepted[0],
    JSON.stringify({ type: "msg", body: "hi", clientMessageId: "gc-ws00001" }),
  );
  // The connect itself emitted the roster frame; the gate reply is the next —
  // the ONE error frame — for this socket.
  const frames = ctx.accepted[0].sent
    .map((frame) => JSON.parse(frame))
    .filter((frame) => frame.type !== "roster");
  assert.deepEqual(frames, [{
    type: "error",
    code: "send_failed",
    message: RULES_GATE_MESSAGE,
    serverId: 3,
    rules: "Be kind.",
  }]);
});

// --- the client half's pure detectors ------------------------------------------------


