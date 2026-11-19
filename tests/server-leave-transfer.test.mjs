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

// Wave 8 (T-PARITY-LEAVE): the member leave route and the ownership
// transfer route. Same fakeDb + recording-limiter conventions as the
// write-riders lane's tests — the authorization contract lives in the query
// text, so the pins assert the guarded-SQL shapes and the bind sequences.
//
// GO-HAYWIRE cycle-7 pins: the transfer batch promotes FIRST and swaps the
// server-row owner LAST behind a promote-landed rider (a refused promote
// never lets the swap land); both write walls key (serverId + ":" + userId);
// leave strips gc_member_roles in the same batch (kick's shape); a
// successful leave trips the boost recount; and by DESIGN leave keeps
// gc_read_state — read state stays history-kept, matching kick.
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

function postJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// Ordered fake DB: the first matching route answers each statement shape.
// Top-level run() calls are recorded individually; batch() is recorded as ONE
// call carrying every statement's SQL + bound values.
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
        if (route && route.run) return await route.run(statement.bound);
        return { meta: { changes: 1 } };
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

// The membership gate/classification read: role + the row fields the transfer
// demote re-inserts (the pre-roles string tiers; joined_at preserved).
const MEMBERSHIP_ROW_TEST = (sql) =>
  sql.includes("SELECT role, joined_at, nickname, timed_out_until, created_by_invite, rules_accepted_at") &&
  sql.includes("FROM gc_server_members WHERE server_id = ? AND user_id = ?");

async function dispatchPost(routes, path, body) {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const env = envWithRecordingLimiters(db);
  const response = await dispatchHandler(
    postJson(path, body, { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf }),
    env,
  );
  return { db, env, response };
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

// --- routes exist at all ---------------------------------------------------------

test("unknown server subpaths still fall through to the worker's handler loop", async () => {
  const response = await handleServerRoutes(
    postJson("/api/servers/1/leaves", {}),
    { GOOBER_DB: fakeDb([]) },
    new URL(ORIGIN + "/api/servers/1/leaves"),
    "/api/servers/1/leaves",
    "POST",
    undefined,
  );
  assert.equal(response, undefined);
});

// --- POST /api/servers/:id/leave -------------------------------------------------

const MEMBER_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_server_members");
const ROLES_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_member_roles");

async function dispatchLeave(memberRoleFn, deleteChanges = 1) {
  return dispatchPost(
    [
      { test: MEMBERSHIP_ROW_TEST, first: memberRoleFn },
      { test: MEMBER_DELETE_TEST, run: async () => ({ meta: { changes: deleteChanges } }) },
      { test: ROLES_DELETE_TEST, run: async () => ({ meta: { changes: deleteChanges } }) },
    ],
    "/api/servers/" + SERVER_ID + "/leave",
    {},
  );
}

test("a plain member leaves in ONE guarded batch — self member row + role assignments, owner-refusal arm", async () => {
  const { response, db } = await dispatchLeave(async () => ({ role: "member" }), 1);
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { left: true, serverId: SERVER_ID });

  // ONE write: the guarded batch, never a read-then-write gate.
  const writes = db.calls.filter((call) => call.call === "run" || call.call === "batch");
  assert.deepEqual(writes.length, 2); // the batch + the boost recount run
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.deepEqual(batch.statements.length, 2);

  // Statement 0: the member row's guarded DELETE. In-statement arms: the
  // caller's own row is the target, the membership EXISTS arm bound with the
  // same (serverId, userId), and the owner-refusal NOT-EXISTS arm bound with
  // the same pair again.
  const memberDelete = batch.statements[0];
  assert.match(memberDelete.sql, /^DELETE FROM gc_server_members WHERE server_id = \? AND user_id = \?/);
  assert.match(
    memberDelete.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members WHERE server_id = \? AND user_id = \?\)/,
  );
  assert.match(
    memberDelete.sql,
    /AND NOT EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  // Bind sequence: (serverId, self) ×3 — the DELETE pair, then the membership
  // arm's pair, then the owner arm's pair. No client-derived values.
  assert.deepEqual(memberDelete.bound, [SERVER_ID, USER_ID, SERVER_ID, USER_ID, SERVER_ID, USER_ID]);

  // Statement 1: the role-assignment strip — kick's shape, the SAME guard
  // arms on gc_member_roles so a refused leave never strips a member who
  // stayed (rejoin must land a clean RBAC slate).
  const rolesDelete = batch.statements[1];
  assert.match(
    rolesDelete.sql,
    /^DELETE FROM gc_member_roles WHERE server_id = \? AND user_id = \?/,
  );
  assert.match(
    rolesDelete.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members WHERE server_id = \? AND user_id = \?\)/,
  );
  assert.match(
    rolesDelete.sql,
    /AND NOT EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  assert.deepEqual(rolesDelete.bound, [SERVER_ID, USER_ID, SERVER_ID, USER_ID, SERVER_ID, USER_ID]);
});

test("a successful leave trips the boost recount so a booster's departure drops the caps", async () => {
  const { db } = await dispatchLeave(async () => ({ role: "member" }), 1);
  const recounts = db.calls.filter((call) =>
    (call.call === "run" || call.call === "batch") && call.sql.includes("UPDATE gc_servers SET boosts"),
  );
  assert.deepEqual(recounts.length, 1);
  assert.deepEqual(recounts[0].bound, [SERVER_ID, SERVER_ID]);
  // The recount runs AFTER the leave batch landed (route-side await).
  const batchIndex = db.calls.findIndex((call) => call.call === "batch");
  assert.ok(batchIndex >= 0);
  assert.ok(db.calls.indexOf(recounts[0]) > batchIndex);
});

test("a refused leave never trips the boost recount", async () => {
  const { db } = await dispatchLeave(async () => ({ role: "member" }), 0);
  assert.deepEqual(
    db.calls.filter((call) =>
      (call.call === "run" || call.call === "batch") && call.sql.includes("UPDATE gc_servers SET boosts"),
    ),
    [],
  );
});

test("the owner's leave is refused 409 with the transfer pointer and zero writes", async () => {
  const { response, db, env } = await dispatchLeave(async () => ({ role: "owner" }), undefined);
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), {
    error: "Transfer ownership before leaving. POST /api/servers/" + SERVER_ID +
      "/transfer-ownership",
  });
  // Zero statements hit the members table beyond the gate read: the owner
  // refusal is decided before any write, and the write wall still spent.
  assert.equal(
    db.calls.filter((call) =>
      (call.call === "run" || call.call === "batch") &&
      /^(INSERT|UPDATE|DELETE)/.test(call.sql),
    ).length,
    0,
  );
  assert.deepEqual(env.limiterCalls.map((call) => call.binding), ["GC_WRITE_RATE_LIMITER"]);
});

test("a non-member's leave 404s without spending a write", async () => {
  const { response, db } = await dispatchLeave(async () => null, undefined);
  assert.equal(response.status, 404);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("a race-refused leave changes nothing and answers 404 — one batch, no double-delete", async () => {
  // The gate read saw the row; the DELETE found it gone (changes=0): exactly
  // one batch ran, and the classification re-read answered 404.
  const { response, db } = await dispatchLeave(async () => ({ role: "member" }), 0);
  assert.equal(response.status, 404);
  const batches = db.calls.filter((call) => call.call === "batch");
  assert.deepEqual(batches.length, 1);
  assert.deepEqual(batches[0].statements.length, 2);
});

test("leave rides the write wall keyed to server + caller, before the table work", async () => {
  const { db, env, response } = await dispatchLeave(async () => ({ role: "member" }), 1);
  assert.equal(response.status, 200);
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-leave:" + SERVER_ID + ":" + USER_ID),
  }]);
  // Order: the session read leads; the limiter (a non-D1 call) sits between
  // it and the membership gate read.
  assert.match(db.calls[0].sql, /FROM sessions/);
  assert.equal(db.calls.filter((call) => call.call === "first" && MEMBERSHIP_ROW_TEST(call.sql)).length >= 1, true);
});

// --- POST /api/servers/:id/transfer-ownership ------------------------------------

const SERVER_SWAP_TEST = (sql) =>
  sql.startsWith("UPDATE gc_servers SET owner_user_id");

const PROMOTE_TEST = (sql) =>
  sql.startsWith("UPDATE gc_server_members SET role = 'owner'");

const DEMOTE_DELETE_TEST = (sql) =>
  sql.startsWith("DELETE FROM gc_server_members") && sql.includes("AND role = 'owner'");

const DEMOTE_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_server_members") && sql.includes("'member'");

const OWNER_ROW = () => ({
  role: "owner",
  joined_at: 1700000000,
  nickname: "skip",
  timed_out_until: null,
  created_by_invite: "abc123",
  rules_accepted_at: 1700000100,
});

async function dispatchTransfer(memberRoleFn, batchResults, bodyOverride) {
  return dispatchPost(
    [
      { test: MEMBERSHIP_ROW_TEST, first: memberRoleFn },
      { test: PROMOTE_TEST, run: async () => batchResults[0] },
      { test: DEMOTE_DELETE_TEST, run: async () => batchResults[1] },
      { test: DEMOTE_INSERT_TEST, run: async () => batchResults[2] },
      { test: SERVER_SWAP_TEST, run: async () => batchResults[3] },
    ],
    "/api/servers/" + SERVER_ID + "/transfer-ownership",
    { userId: TARGET_ID, ...bodyOverride },
  );
}

// Batch order: promote → demote → re-insert → swap. The swap rides LAST so a
// refused promote (or demote chain) strands it at zero — a departed target
// never ends up holding the server row's owner_user_id.
test("the owner transfers ownership in ONE batch — promote, guarded demote, exact re-insert, swap last", async () => {
  const { response, db } = await dispatchTransfer(
    async () => OWNER_ROW(),
    [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }],
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    transferred: true,
    serverId: SERVER_ID,
    ownerId: TARGET_ID,
  });

  // ONE batch, no standalone writes.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" && /^(INSERT|UPDATE|DELETE)/.test(call.sql)),
    [],
  );
  assert.deepEqual(batch.statements.length, 4);

  // Statement 0: the PROMOTE — target → owner, guarded in-statement by the
  // caller's owner arm AND the target's active-member arm (role NOT NULL).
  // FIRST in the batch so the swap below can ride its landing.
  const promote = batch.statements[0];
  assert.match(promote.sql, /^UPDATE gc_server_members SET role = 'owner' WHERE server_id = \? AND user_id = \?/);
  assert.match(
    promote.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  assert.match(
    promote.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role IS NOT NULL\)/,
  );
  // (serverId, target), (serverId, me) — the target pair first, then the authority arm.
  assert.deepEqual(promote.bound, [SERVER_ID, TARGET_ID, SERVER_ID, USER_ID, SERVER_ID, TARGET_ID]);

  // Statement 1: the DEMOTE delete — only the owner row lands, in-statement
  // owner arm, plus the promote-landed rider.
  const demote = batch.statements[1];
  assert.match(demote.sql, /^DELETE FROM gc_server_members WHERE server_id = \? AND user_id = \? AND role = 'owner'/);
  assert.match(
    demote.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  assert.match(
    demote.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  assert.deepEqual(demote.bound, [SERVER_ID, USER_ID, SERVER_ID, USER_ID, SERVER_ID, TARGET_ID]);

  // Statement 2: the EXACT re-insert — the demoted owner keeps their row as a
  // plain member with their fields preserved (joined_at, nickname, the roster
  // extras), guarded by the row-is-gone rider and the promote-landed rider.
  const reinsert = batch.statements[2];
  assert.match(
    reinsert.sql,
    /^INSERT INTO gc_server_members \(server_id, user_id, role, joined_at, nickname, timed_out_until, created_by_invite, rules_accepted_at\)/,
  );
  assert.match(reinsert.sql, /SELECT \?, \?, 'member', \?, \?, \?, \?, \?/);
  assert.match(
    reinsert.sql,
    /WHERE NOT EXISTS \(SELECT 1 FROM gc_server_members WHERE server_id = \? AND user_id = \?\)/,
  );
  assert.match(
    reinsert.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  assert.deepEqual(
    reinsert.bound,
    [
      SERVER_ID, USER_ID, 1700000000, "skip", null, "abc123", 1700000100,
      SERVER_ID, USER_ID,
      SERVER_ID, TARGET_ID,
    ],
  );

  // Statement 3: the SERVER-BRAIN swap rides LAST, behind the promote-landed
  // rider — a refused promote forces the swap's changes=0, so the server row
  // never hands gc_servers.owner_user_id to a departed target.
  const serverSwap = batch.statements[3];
  assert.match(
    serverSwap.sql,
    /^UPDATE gc_servers SET owner_user_id = \? WHERE id = \? AND owner_user_id = \?/,
  );
  assert.match(
    serverSwap.sql,
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/,
  );
  assert.deepEqual(serverSwap.bound, [TARGET_ID, SERVER_ID, USER_ID, SERVER_ID, TARGET_ID]);
});

test("a departed target's batch never lands the swap — 404 with the swap at zero and the promote-landed rider", async () => {
  // The target left between the gate and the batch: every promote-side arm
  // refuses AND the swap — riding the promote-landed EXISTS rider — is
  // forced to zero, so gc_servers.owner_user_id stays on the caller.
  const { response, db } = await dispatchTransfer(
    async () => OWNER_ROW(),
    [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }],
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "That member is not in this server." });

  const batch = db.calls.find((call) => call.call === "batch");
  const serverSwap = batch.statements[3];
  // Structural pin: the swap's WHERE carries the promote-landed rider on the
  // (serverId, target) 'owner' member row — refusal of the promote can never
  // let the swap land anything (D1 commits zero-changes statements silently,
  // so the rider is the guarantee).
  assert.match(serverSwap.sql, /^UPDATE gc_servers SET owner_user_id = \? WHERE id = \? AND owner_user_id = \?/);
  assert.ok(
    /AND EXISTS \(SELECT 1 FROM gc_server_members \w+ WHERE \w+\.server_id = \? AND \w+\.user_id = \? AND \w+\.role = 'owner'\)/.test(serverSwap.sql),
  );
  const riderBound = serverSwap.bound.slice(3);
  assert.deepEqual(riderBound, [SERVER_ID, TARGET_ID]);
  // Verdict gate: the swap refusing classifies like every other refused arm —
  // never a 200 with the swap landed.
  assert.equal(batch.statements.length, 4);
});

test("a non-owner member's transfer 403s with zero writes", async () => {
  const { response, db } = await dispatchTransfer(
    async () => ({ role: "member", joined_at: 0, nickname: null, timed_out_until: null, created_by_invite: null, rules_accepted_at: null }),
    null,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("a non-member's transfer 404s without spending a write", async () => {
  const { response, db } = await dispatchTransfer(
    async () => null,
    null,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("the owner's self-transfer is an idempotent 200 with zero writes", async () => {
  const { response, db } = await dispatchTransfer(
    async () => OWNER_ROW(),
    [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }],
    { userId: USER_ID },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    transferred: false,
    serverId: SERVER_ID,
    ownerId: USER_ID,
  });
  // No batch, no standalone write: the self-transfer decision is route-side.
  assert.deepEqual(
    db.calls.filter((call) =>
      (call.call === "run" || call.call === "batch") &&
      /^(INSERT|UPDATE|DELETE)/.test(call.sql),
    ).length,
    0,
  );
});

test("the server-row swap refusing gates the 200 the same as the member arms", async () => {
  // The gc_servers.owner_user_id swap is verdict-gated like every other arm —
  // even when the promote chain landed but the swap's own owner_user_id arm
  // refused (a race took the row): the re-read (a member now) shapes the 409 —
  // never a 200 with an unswapped server row, regardless of which arm refused.
  let membershipReads = 0;
  const { response, db } = await dispatchTransfer(
    async () =>
      (membershipReads++ === 0
        ? OWNER_ROW()
        : { role: "member", joined_at: 0, nickname: null, timed_out_until: null, created_by_invite: null, rules_accepted_at: null }),
    [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 0 } }],
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), {
    error: "The server's ownership changed while you were transferring. Reload and try again.",
  });
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
});

test("a transfer to a non-member refuses the batch and the re-read shapes 404", async () => {
  // The promote's target arm refused (changes=0), and every rider kept the
  // demote arms at zero: the batch committed an exact no-op.
  const { response, db } = await dispatchTransfer(
    async () => OWNER_ROW(),
    [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }],
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "That member is not in this server." });
  // The refusal never strips the owner's row — one batch only, and the
  // classification rode a read, never a second write.
  assert.equal(db.calls.filter((call) => call.call === "batch").length, 1);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" && /^(INSERT|UPDATE|DELETE)/.test(call.sql)),
    [],
  );
});

test("a race-lost transfer classifies 409 from the re-read when authority left", async () => {
  // A competing transfer deposed the caller between the gate and the batch:
  // the promote's authority arm refused, and the re-read finds a non-owner
  // (the gate read saw the owner; the classification re-read answers a member).
  let membershipReads = 0;
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: MEMBERSHIP_ROW_TEST,
      first: async () =>
        (membershipReads++ === 0
          ? OWNER_ROW()
          : { role: "member", joined_at: 0, nickname: null, timed_out_until: null, created_by_invite: null, rules_accepted_at: null }),
    },
    {
      test: SERVER_SWAP_TEST,
      run: async () => ({ meta: { changes: 0 } }),
    },
    {
      test: PROMOTE_TEST,
      run: async () => ({ meta: { changes: 0 } }),
    },
    { test: DEMOTE_DELETE_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: DEMOTE_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const env = envWithRecordingLimiters(db);
  const response = await dispatchHandler(
    postJson(
      "/api/servers/" + SERVER_ID + "/transfer-ownership",
      { userId: TARGET_ID },
      { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    env,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), {
    error: "The server's ownership changed while you were transferring. Reload and try again.",
  });
});

test("transfer validates a junk user_id with 400 before any statement", async () => {
  for (const bad of ["12", 0, -3, 4.5]) {
    const { token, csrf, row } = await sessionFixtures();
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const env = envWithRecordingLimiters(db);
    const response = await dispatchHandler(
      postJson(
        "/api/servers/" + SERVER_ID + "/transfer-ownership",
        { userId: bad },
        { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
      ),
      env,
    );
    assert.equal(response.status, 400, "userId " + JSON.stringify(bad) + " must 400");
    assert.deepEqual(
      db.calls.filter((call) =>
        (call.call === "run" || call.call === "batch") &&
        call.call !== "first" && /^(INSERT|UPDATE|DELETE)/.test(call.sql),
      ),
      [],
    );
  }
});

test("transfer rides the write wall keyed to server + caller, before the batch", async () => {
  const { db, env, response } = await dispatchTransfer(
    async () => OWNER_ROW(),
    [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }],
  );
  assert.equal(response.status, 200);
  assert.deepEqual(env.limiterCalls, [{
    binding: "GC_WRITE_RATE_LIMITER",
    key: await sha256Hex("write:servers-transfer:" + SERVER_ID + ":" + USER_ID),
  }]);
  // Order: the session read leads; exactly one limiter rider.
  assert.match(db.calls[0].sql, /FROM sessions/);
  assert.equal(env.limiterCalls.length, 1);
});
