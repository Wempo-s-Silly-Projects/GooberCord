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

// Discovery + invites routes (migration 0004): invite minting/joining, the
// discovery grid + its guard, and the owner-only is_public PATCH, driven
// against the same fakeDb conventions as the servers/accounts test modules —
// every statement's bound values are recorded, and the guarded-SQL shape
// itself is what the tests pin (the authorization contract lives in the
// query text). Kept in its own file so parallel server-settings workers
// can stack regions in api/servers.mjs without colliding on this test.
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

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

// Test dispatcher: mirrors worker.mjs's apiError mapping so HttpErrors surface
// as the same JSON responses the worker would return.
async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleServerRoutes(
      request,
      env,
      url,
      url.pathname,
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

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// Ordered fake DB — same conventions as tests/servers-module.test.mjs.
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

// --- session fixtures -----------------------------------------------------------

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

async function authed(routes) {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const request = (path, body, method = "POST") =>
    method === "GET"
      ? get(path, { Cookie: "__Host-goober_session=" + token })
      : new Request(ORIGIN + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: ORIGIN,
            Cookie: "__Host-goober_session=" + token,
            "X-CSRF-Token": csrf,
          },
          body: method === "GET" ? undefined : JSON.stringify(body),
        });
  return { db, request };
}

const MEMBERSHIP_ROLE_TEST = (sql) =>
  sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?");

// --- POST /api/servers/:id/invites --------------------------------------------------

const INVITE_INSERT_TEST = (sql) =>
  sql.includes(
    "INSERT INTO gc_invites (code, server_id, created_by, created_at, expires_at, max_uses)",
  ) && sql.includes("owner_user_id = ?");

test("an owner mints an 8-char base64url invite through the owner-guarded INSERT", async () => {
  const { db, request } = await authed([]);
  const response = await dispatch(request("/api/servers/3/invites", {}), { GOOBER_DB: db });

  assert.equal(response.status, 201);
  const payload = await bodyOf(response);
  const { code } = payload;
  // randomToken(6) is exactly 8 base64url characters (48 bits -> 8 x 6 bits).
  assert.match(code, /^[A-Za-z0-9_-]{8}$/);
  // The bare mint (no lifecycle knobs sent): the payload echoes both 0017
  // knobs as nulls — the invite keeps its exact pre-0017 behavior.
  assert.deepEqual(payload, { code, expiresAt: null, maxUses: null });

  const insert = db.calls.find((call) => call.call === "run" && INVITE_INSERT_TEST(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /SELECT \?, \?, \?, \?, \?, \? WHERE \(EXISTS \(SELECT 1 FROM gc_servers WHERE id = \? AND owner_user_id = \?\) OR/);
  // The COUNT cap rides the same WHERE — 1000 codes max, so the count must be
  // <= 999 at insert time.
  assert.match(insert.sql, /AND \(SELECT COUNT\(\*\) FROM gc_invites WHERE server_id = \?\) <= 999/);
  // Bindings: code, server, creator, timestamp, the two lifecycle nulls, the
  // owner rider's pair, then the MANAGE_INVITES per-bit pair, then the
  // COUNT-cap's server bind — the owner rider rides INSIDE the INSERT's
  // SELECT, never as a read gate.
  assert.deepEqual(
    insert.bound,
    [code, 3, USER_ID, insert.bound[3], null, null, 3, USER_ID, 3, USER_ID, 3],
  );
  assert.match(insert.sql, /COUNT\(\*\) FROM gc_invites WHERE server_id = \?\) <= 999/);
  assert.equal(typeof insert.bound[3], "number");
});

test("a non-member's invite mint 403s after the changes=0 classification read", async () => {
  const { db, request } = await authed([
    { test: INVITE_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: MEMBERSHIP_ROLE_TEST, first: async () => null },
  ]);
  const response = await dispatch(request("/api/servers/3/invites", {}), { GOOBER_DB: db });
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  assert.ok(db.calls.find((call) => MEMBERSHIP_ROLE_TEST(call.sql)));
});

test("an owner's invite mint on a vanished server 404s", async () => {
  const { db, request } = await authed([
    { test: INVITE_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: MEMBERSHIP_ROLE_TEST, first: async () => ({ role: "owner" }) },
  ]);
  const response = await dispatch(request("/api/servers/3/invites", {}), { GOOBER_DB: db });
  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "That server does not exist." });
});

test("invite minting demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(postJson("/api/servers/3/invites", {}), { GOOBER_DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("non-numeric/unknown invite-mint paths fall through to the worker's 404", async () => {
  const response = await handleServerRoutes(
    postJson("/api/servers/abc/invites", {}),
    { GOOBER_DB: fakeDb([]) },
    new URL(ORIGIN + "/api/servers/abc/invites"),
    "/api/servers/abc/invites",
    "POST",
    undefined,
  );
  assert.equal(response, undefined);
});

// --- POST /api/invites/:code/join ----------------------------------------------------

const INVITE_LOOKUP_TEST = (sql) =>
  sql.includes("FROM gc_invites WHERE code = ?") && sql.includes("LIMIT 1");
// The 0008 join-flow INSERT: attribution + the account-ban rider now ride it.
const INVITE_MEMBER_INSERT_TEST = (sql) =>
  sql.includes(
    "INSERT INTO gc_server_members (server_id, user_id, role, joined_at, created_by_invite)",
  ) && sql.includes("gc_server_bans");
const INVITE_USES_BUMP_TEST = (sql) =>
  sql.includes("UPDATE gc_invites SET uses = uses + 1 WHERE code = ?") &&
  sql.includes("revoked_at IS NULL");
// The refused-join classifier's membership probe (0008's ban classification
// shares it — the ban probe rides another read that these refusals expect).
const MEMBER_PROBE_TEST = (sql) =>
  sql.includes("SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ?");
const BAN_PROBE_TEST = (sql) =>
  sql.includes("SELECT 1 AS banned FROM gc_server_bans WHERE server_id = ? AND user_id = ?");

test("a fresh invite join inserts the member and bumps uses once", async () => {
  const { db, request } = await authed([
    { test: INVITE_LOOKUP_TEST, first: async () => ({ server_id: 3 }) },
    { test: INVITE_MEMBER_INSERT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(request("/api/invites/Goober12/join", {}), { GOOBER_DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { joined: true, serverId: 3 });

  // T10 R1: the INSERT and the uses bump ride ONE batch (one transaction) —
  // a concurrent join serializes behind the first and re-reads the bumped
  // uses, closing the two-joins-pass-`uses < max_uses` window.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const insert = batch.statements.find((statement) => INVITE_MEMBER_INSERT_TEST(statement.sql));
  const bump = batch.statements.find((statement) => INVITE_USES_BUMP_TEST(statement.sql));
  assert.ok(insert);
  assert.ok(bump);
  // The bump's WHERE carries the active predicate AND the fresh-join gate
  // (member row at THIS request's joined_at, the same bind as the INSERT's
  // fourth): only a join that landed in this batch moves uses — a re-join or
  // refused join burns nothing, and a race can never overshoot the tick.
  assert.match(bump.sql, /WHERE code = \? AND revoked_at IS NULL AND \(expires_at IS NULL OR expires_at > \?\) AND \(max_uses IS NULL OR uses < max_uses\)/);
  assert.match(bump.sql, /AND EXISTS \(SELECT 1 FROM gc_server_members ium WHERE ium\.server_id = \? AND ium\.user_id = \? AND ium\.joined_at = \?\)/);
  assert.deepEqual(bump.bound[0], "Goober12");
  // The fresh-join gate binds the SAME seconds the INSERT wrote as joined_at
  // (bind 4 = the INSERT's third bind).
  assert.deepEqual(bump.bound[4], insert.bound[2]);
  assert.equal(typeof bump.bound[1], "number");

  // Membership rides the guarded INSERT with the invite code on the row.
  assert.deepEqual(insert.bound.slice(0, 4), [3, USER_ID, insert.bound[2], "Goober12"]);
  assert.equal(typeof insert.bound[2], "number");
  // The ban rider rides the same WHERE (the invalid-invite taxonomy's BANNED
  // case): the guard is inside the statement, never a read-then-write gate.
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_server_bans/);
});

test("an idempotent re-join answers joined:false without moving uses", async () => {
  const { db, request } = await authed([
    { test: INVITE_LOOKUP_TEST, first: async () => ({ server_id: 3 }) },
    { test: INVITE_MEMBER_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: MEMBER_PROBE_TEST, first: async () => ({ member: 1 }) },
  ]);
  const response = await dispatch(request("/api/invites/Goober12/join", {}), { GOOBER_DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { joined: false, serverId: 3 });
  // Only a fresh join counts: the batch's bump still rides (one transaction
  // with the change-0 INSERT), but its WHERE NEVER matches — the member-row
  // arm is scoped to joined_at = this request's seconds, and the re-join's
  // surviving row predates the request, so uses cannot move. Re-armed from
  // the pre-R1 "no bump ran" pin: the guarantee moved from call-count to
  // in-statement gate.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const bump = batch.statements.find((statement) => INVITE_USES_BUMP_TEST(statement.sql));
  assert.match(bump.sql, /ium\.joined_at = \?/);
});

test("an unknown invite code 404s with zero writes", async () => {
  const { db, request } = await authed([
    { test: INVITE_LOOKUP_TEST, first: async () => null },
  ]);
  const response = await dispatch(request("/api/invites/GoneAway/join", {}), { GOOBER_DB: db });

  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { error: "That invite is no longer valid." });
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("an invite code outside the base64url shape falls through to the worker's 404", async () => {
  const path = "/api/invites/not a code/join";
  const response = await handleServerRoutes(
    postJson(path, {}),
    { GOOBER_DB: fakeDb([]) },
    new URL(ORIGIN + path),
    path,
    "POST",
    undefined,
  );
  assert.equal(response, undefined);
});

test("invite joining demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(postJson("/api/invites/Goober12/join", {}), { GOOBER_DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

// --- GET /api/discover ----------------------------------------------------------------

const DISCOVER_SELECT_TEST = (sql) =>
  sql.includes("FROM gc_servers s") &&
  sql.includes("WHERE s.is_public = 1 AND NOT EXISTS (") &&
  sql.includes("me.server_id = s.id AND me.user_id = ?") &&
  sql.includes("ORDER BY s.id LIMIT 50");

test("GET /api/discover lists public servers server-side-excluding the caller", async () => {
  const { db, request } = await authed([
    {
      test: DISCOVER_SELECT_TEST,
      all: async () => ({
        results: [
          { server_id: 2, server_name: "Beta", member_count: 4 },
          { server_id: 5, server_name: "Gamma", member_count: 1 },
        ],
      }),
    },
  ]);
  const response = await dispatch(request("/api/discover", undefined, "GET"), {
    GOOBER_DB: db,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    servers: [
      { id: 2, name: "Beta", memberCount: 4 },
      { id: 5, name: "Gamma", memberCount: 1 },
    ],
  });

  // The member count is a server-side subquery and the caller's membership
  // exclusion rides NOT EXISTS — the roster never round-trips through the
  // client — with the LIMIT 50 cap.
  const discover = db.calls.find((call) => call.call === "all");
  assert.ok(discover);
  assert.match(discover.sql, /COUNT\(\*\) FROM gc_server_members m WHERE m\.server_id = s\.id/);
  assert.deepEqual(discover.bound, [USER_ID]);
});

test("GET /api/discover demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(get("/api/discover"), { GOOBER_DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(db.calls.filter((call) => call.call === "all"), []);
});

// --- POST /api/discover/:id/join ------------------------------------------------------

const DISCOVER_JOIN_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_server_members (server_id, user_id, role, joined_at)") &&
  sql.includes("is_public = 1");
const DISCOVER_MEMBER_PROBE_TEST = (sql) =>
  sql.includes("SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ?");

test("a discover join rides the is_public = 1 precondition inside the INSERT", async () => {
  const { db, request } = await authed([
    { test: DISCOVER_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(request("/api/discover/3/join", {}), { GOOBER_DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { joined: true, serverId: 3 });

  const insert = db.calls.find((call) => call.call === "run" && DISCOVER_JOIN_INSERT_TEST(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /WHERE EXISTS \(SELECT 1 FROM gc_servers WHERE id = \? AND is_public = 1\)/);
  // 0008: the account-ban rider rides the same WHERE, and the ban pair rides
  // the end of the bind order. The join-count cap rides after it (100 free /
  // 200 friend-passes): the caller's count + the plus tier's pair close the
  // bind order.
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_server_bans djb/);
  assert.match(insert.sql, /COUNT\(\*\) FROM gc_server_members djw WHERE djw\.user_id = \?\) < \(CASE/);
  assert.match(insert.sql, /gc_plus_state djp WHERE djp\.user_id = \? AND djp\.renews_until > \?\)\s+THEN 200 ELSE 100 END/);
  assert.deepEqual(
    insert.bound,
    [3, USER_ID, insert.bound[2], 3, 3, USER_ID, USER_ID, USER_ID, insert.bound[8]],
  );
  assert.equal(typeof insert.bound[2], "number");
});

test("a discover join by an existing member returns joined:false", async () => {
  const { db, request } = await authed([
    { test: DISCOVER_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: DISCOVER_MEMBER_PROBE_TEST, first: async () => ({ member: 1 }) },
  ]);
  const response = await dispatch(request("/api/discover/3/join", {}), { GOOBER_DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { joined: false });
});

test("a discover join closed by the guard 404s with the discovery copy", async () => {
  const { db, request } = await authed([
    { test: DISCOVER_JOIN_INSERT_TEST, run: async () => ({ meta: { changes: 0 } }) },
    { test: DISCOVER_MEMBER_PROBE_TEST, first: async () => null },
  ]);
  const response = await dispatch(request("/api/discover/3/join", {}), { GOOBER_DB: db });

  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), {
    error: "That server is not open for discovery.",
  });
  // Authority rode the INSERT; exactly one guarded write ran (and failed).
  assert.equal(db.calls.filter((call) => call.call === "run").length, 1);
});

test("discover joining demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(postJson("/api/discover/3/join", {}), { GOOBER_DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("PATCH /api/servers/:id demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/3", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ is_public: true }),
    }),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

// --- PATCH /api/servers/:id (merged owner settings: is_public + name + icon) ---------
// The PATCH contract unified with the server-icons work: name + icon + is_public
// all ride ONE guarded UPDATE, a zero-change result is a single 403 with no
// follow-up classification read (no existence oracle), and the response reads
// the merged row back through an owner-guarded SELECT.

const SERVER_PATCH_TEST = (sql) =>
  sql.startsWith("UPDATE gc_servers SET is_public = ?") &&
  sql.includes("WHERE id = ? AND owner_user_id = ?");
const SERVER_PATCH_READBACK_TEST = (sql) =>
  sql.startsWith("SELECT id, name, icon_media_id, is_public, verification_level FROM gc_servers");

test("an owner flips is_public through the owner-ridden UPDATE", async () => {
  const { db, request } = await authed([
    { test: SERVER_PATCH_TEST, run: async () => ({ meta: { changes: 1 } }) },
    {
      test: SERVER_PATCH_READBACK_TEST,
      first: async () => ({ id: 3, name: "Alpha", icon_media_id: null, is_public: 1 }),
    },
  ]);
  const response = await dispatch(
    request("/api/servers/3", { is_public: true }, "PATCH"),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    server: { id: 3, name: "Alpha", isPublic: true, iconUrl: null },
  });

  const update = db.calls.find((call) => call.call === "run" && SERVER_PATCH_TEST(call.sql));
  assert.ok(update);
  assert.deepEqual(update.bound, [1, 3, USER_ID]);
});

test("an owner flipping back to private binds the 0 form", async () => {
  const { db, request } = await authed([
    { test: SERVER_PATCH_TEST, run: async () => ({ meta: { changes: 1 } }) },
    {
      test: SERVER_PATCH_READBACK_TEST,
      first: async () => ({ id: 3, name: "Alpha", icon_media_id: null, is_public: 0 }),
    },
  ]);
  const response = await dispatch(
    request("/api/servers/3", { is_public: false }, "PATCH"),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    server: { id: 3, name: "Alpha", isPublic: false, iconUrl: null },
  });
  assert.deepEqual(update_bound(db), [0, 3, USER_ID]);
});

function update_bound(db) {
  const update = db.calls.find((call) => call.call === "run" && SERVER_PATCH_TEST(call.sql));
  return update ? update.bound : null;
}

test("PATCH is_public is strictly boolean — string/number shapes 400 before any write", async () => {
  for (const bad of ["true", 1, null]) {
    const { db, request } = await authed([]);
    const response = await dispatch(
      request("/api/servers/3", { is_public: bad }, "PATCH"),
      { GOOBER_DB: db },
    );
    assert.equal(response.status, 400, "bad value " + JSON.stringify(bad));
    assert.deepEqual(await bodyOf(response), { error: "is_public must be true or false." });
    assert.deepEqual(
      db.calls.filter((call) => call.call === "run" || call.call === "batch"),
      [],
    );
  }
});

test("PATCH with no editable fields reports 'Nothing to change' before any write", async () => {
  const { db, request } = await authed([]);
  const response = await dispatch(request("/api/servers/3", {}, "PATCH"), { GOOBER_DB: db });
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "Nothing to change. Send a new name and/or a new icon.",
  });
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("a non-owner's PATCH 403s with zero changes and no existence probe", async () => {
  const { db, request } = await authed([
    { test: SERVER_PATCH_TEST, run: async () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    request("/api/servers/3", { is_public: false }, "PATCH"),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  // The unified contract: nothing is queried after the zero-change UPDATE —
  // the old changes=0 classification read is gone (the only earlier `first`
  // call is the session read itself).
  const updateIndex = db.calls.findIndex((call) => SERVER_PATCH_TEST(call.sql));
  assert.ok(updateIndex > 0);
  assert.deepEqual(db.calls.slice(updateIndex), [
    { call: "run", sql: db.calls[updateIndex].sql, bound: db.calls[updateIndex].bound },
  ]);
});
