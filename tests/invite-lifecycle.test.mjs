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

// Invite lifecycle (SHAVERS 3, migration 0017): the three bare columns on
// gc_invites and the ONE active predicate the join lookup, the join INSERT's
// guard, and the uses-bump's WHERE all share. The mint grows optional
// lifecycle knobs (maxAgeSeconds / maxUses — absent keeps the pre-0017
// never/unlimited behavior); the mod desk gains the list (owner OR
// MANAGE_INVITES guarded INSIDE the SELECT) and the soft tombstone revoke.
// Same fakeDb + pinned-SQL conventions as the servers-discovery module.
import test from "node:test";
import assert from "node:assert/strict";

import {
  handleServerRoutes,
  INVITE_LIST_LIMIT,
  INVITE_MAX_AGE_MAX,
  INVITE_MAX_AGE_MIN,
  INVITE_MAX_USES_MAX,
} from "../api/servers.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

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
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
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
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

// One fixture per request — the session row answers THIS token's hash.
async function authedRequest({ method, path, body }) {
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
  const request = new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "__Host-goober_session=" + token,
      "X-CSRF-Token": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { row, request };
}

async function run(routes, args) {
  const { row, request } = await authedRequest(args);
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  return { db, response: await dispatch(request, { GOOBER_DB: db }) };
}

const INVITE_INSERT_TEST = (sql) =>
  sql.includes(
    "INSERT INTO gc_invites (code, server_id, created_by, created_at, expires_at, max_uses)",
  );
const INVITE_LOOKUP_TEST = (sql) =>
  sql.includes("FROM gc_invites WHERE code = ? AND revoked_at IS NULL") &&
  sql.includes("LIMIT 1");
const INVITE_USES_BUMP_TEST = (sql) =>
  sql.startsWith("UPDATE gc_invites SET uses = uses + 1 WHERE code = ? AND");
const INVITE_LIST_TEST = (sql) =>
  sql.startsWith("SELECT i.code, i.created_by") &&
  sql.includes("FROM gc_invites i JOIN users u ON u.id = i.created_by");
const INVITE_REVOKE_TEST = (sql) =>
  sql.startsWith("UPDATE gc_invites SET revoked_at = ? WHERE code = ?");
const INVITE_ROW_PROBE_TEST = (sql) =>
  sql.includes("SELECT revoked_at FROM gc_invites WHERE code = ?");
const AUTHORITY_PROBE_TEST = (sql) =>
  sql.includes("SELECT 1 AS allowed FROM gc_servers s");

// --- the mint's lifecycle knobs -----------------------------------------------------

test("the mint carries OPTIONAL expiry + use cap knobs (shelves honored)", async () => {
  for (const [maxAgeSeconds, maxUses] of [[3600, 5], [2592000, 100]]) {
    const { db, response } = await run([{ test: INVITE_INSERT_TEST }], {
      method: "POST", path: "/api/servers/3/invites", body: { maxAgeSeconds, maxUses },
    });
    assert.equal(response.status, 201, String(maxAgeSeconds));
    const payload = await bodyOf(response);
    const insert = db.calls.find((call) => call.call === "run" && INVITE_INSERT_TEST(call.sql));
    // expires_at rides into the statement as an absolute epoch (now + shelf);
    // maxUses binds verbatim. The mint echoes both to the caller.
    assert.equal(insert.bound[5], maxUses);
    assert.equal(payload.expiresAt, insert.bound[4]);
    assert.equal(payload.maxUses, insert.bound[5]);
    // The shelf: the absolute expiry is now + maxAgeSeconds within a beat.
    const nowBound = insert.bound[3];
    assert.ok(Math.abs(payload.expiresAt - (nowBound + maxAgeSeconds)) < 2);
  }

  // The named shelves (pinned constants).
  assert.equal(INVITE_MAX_AGE_MIN, 60);
  assert.equal(INVITE_MAX_AGE_MAX, 2592000); // the 30-day shelf
  assert.equal(INVITE_MAX_USES_MAX, 100);
});

test("out-of-range knob values refuse BEFORE any statement (0 normalizes to unlimited/never)", async () => {
  for (const body of [
    { maxAgeSeconds: 59 },
    { maxAgeSeconds: "tomorrow" },
    { maxAgeSeconds: INVITE_MAX_AGE_MAX + 1 },
    { maxUses: 101 },
    { maxUses: 1.5 },
  ]) {
    const { db, response } = await run([], {
      method: "POST", path: "/api/servers/3/invites", body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(db.calls.some((call) => call.call === "run"), false, JSON.stringify(body));
  }

  // The 0 forms ride the same statement shape as the bare mint (all nulls).
  const { db, response } = await run([{ test: INVITE_INSERT_TEST }], {
    method: "POST", path: "/api/servers/3/invites", body: { maxAgeSeconds: 0, maxUses: 0 },
  });
  assert.equal(response.status, 201);
  const insert = db.calls.find((call) => call.call === "run" && INVITE_INSERT_TEST(call.sql));
  assert.deepEqual(insert.bound.slice(4, 6), [null, null]);
  const zeroed = await bodyOf(response);
  assert.deepEqual(zeroed, { code: zeroed.code, expiresAt: null, maxUses: null });
});

// --- the three-armed active predicate on the join lane ------------------------------

const ACTIVE_ARMS =
  /revoked_at IS NULL AND \(expires_at IS NULL OR expires_at > \?\) AND \(max_uses IS NULL OR uses < max_uses\)/;

for (const [label, story] of [
  ["expired", "an expired invite answers the flat 404 with zero writes"],
  ["maxed", "a maxed-out invite answers the flat 404 with zero writes"],
  ["revoked", "a revoked invite answers the flat 404 with zero writes"],
]) {
  test(story, async () => {
    // The fixture returns NO invite row: server-side the predicate filtered
    // the invite out, which is exactly what a null lookup means. The pin
    // below proves the LOOKUP carried the predicate, so the null models the
    // arm and not a bare code hit.
    const { db, response } = await run([], {
      method: "POST", path: "/api/invites/Goober12/join",
    });
    assert.equal(response.status, 404, label);
    assert.deepEqual(await bodyOf(response), { error: "That invite is no longer valid." });
    assert.equal(
      db.calls.filter((call) => call.call === "run" || call.call === "batch").length,
      0, "the refused join never writes",
    );
    const lookup = db.calls.find((call) => INVITE_LOOKUP_TEST(call.sql));
    assert.ok(lookup, "the lookup ran");
    assert.match(lookup.sql, ACTIVE_ARMS);
    // Binds: the code, then the predicate's own now.
    assert.equal(lookup.bound[0], "Goober12");
    assert.equal(typeof lookup.bound[1], "number");
  });
}

// --- the list (mod desk) -------------------------------------------------------------

test("GET /api/servers/:sid/invites lists the mod-desk history with the computed active gate", async () => {
  const now = nowSeconds();
  const { db, response } = await run([
    {
      test: INVITE_LIST_TEST,
      all: async () => ({
        results: [
          { code: "LiveOnex1", created_by: 9, created_at: now - 10, uses: 2, max_uses: 10, expires_at: null, revoked_at: null, created_by_name: "wempos" },
          { code: "PastG0ne", created_by: 9, created_at: now - 900, uses: 4, max_uses: 4, expires_at: null, revoked_at: null, created_by_name: "wempos" },
          { code: "Revokd01", created_by: 9, created_at: now - 800, uses: 0, max_uses: null, expires_at: null, revoked_at: now - 100, created_by_name: "wempos" },
          { code: "Expird12", created_by: 9, created_at: now - 800, uses: 0, max_uses: null, expires_at: now - 50, revoked_at: null, created_by_name: "wempos" },
        ],
      }),
    },
  ], { method: "GET", path: "/api/servers/3/invites" });
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    invites: [
      { code: "LiveOnex1", createdBy: 9, createdByName: "wempos", createdAt: now - 10, uses: 2, maxUses: 10, expiresAt: null, revokedAt: null, active: true },
      { code: "PastG0ne", createdBy: 9, createdByName: "wempos", createdAt: now - 900, uses: 4, maxUses: 4, expiresAt: null, revokedAt: null, active: false },
      { code: "Revokd01", createdBy: 9, createdByName: "wempos", createdAt: now - 800, uses: 0, maxUses: null, expiresAt: null, revokedAt: now - 100, active: false },
      { code: "Expird12", createdBy: 9, createdByName: "wempos", createdAt: now - 800, uses: 0, maxUses: null, expiresAt: now - 50, revokedAt: null, active: false },
    ],
  });

  const list = db.calls.find((call) => call.call === "all" && INVITE_LIST_TEST(call.sql));
  // The authority predicate rides INSIDE the SELECT (owner OR MANAGE_INVITES);
  // the row order is the pinned newest-first and the LIMIT uses the named cap.
  assert.match(list.sql, /i\.server_id = \? AND \(EXISTS \(SELECT 1 FROM gc_server_members om/);
  assert.match(list.sql, new RegExp("ORDER BY i\\.created_at DESC, i\\.code LIMIT " + INVITE_LIST_LIMIT + "$"));
});

test("an outsider's (or a roleless member's) list answers the empty read — never a 403 oracle", async () => {
  const { response } = await run([], { method: "GET", path: "/api/servers/3/invites" });
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { invites: [] });
});

// --- the revoke (soft tombstone) -------------------------------------------------------

test("DELETE revokes with the tombstone UPDATE and the guard inside the statement", async () => {
  const { db, response } = await run([
    { test: INVITE_REVOKE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ], { method: "DELETE", path: "/api/servers/3/invites/Goober12" });
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  const revoke = db.calls.find((call) => call.call === "run" && INVITE_REVOKE_TEST(call.sql));
  // The WHERE carries the code+server pair AND the owner-or-bit authority.
  assert.match(
    revoke.sql,
    /WHERE code = \? AND server_id = \? AND \(EXISTS \(SELECT 1 FROM gc_server_members om/,
  );
  // No DELETE ever rides this lane — revoked rows stay visible to the list.
  assert.equal(
    db.calls.some((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_invites")),
    false,
  );
});

for (const [label, rowAnswer, authorityAnswer, expectedStatus] of [
  ["an unknown (or off-server) code classifies to the invite 404", null, undefined, 404],
  ["a live-but-guard-failing call classifies to the invite 404 (no existence oracle)", { revoked_at: null }, null, 404],
  ["an already-revoked row with the guard OK is the idempotent ok", { revoked_at: 123 }, { allowed: 1 }, 200],
]) {
  test(`revoke classification: ${label}`, async () => {
    const routes = [
      { test: INVITE_REVOKE_TEST, run: async () => ({ meta: { changes: 0 } }) },
      { test: INVITE_ROW_PROBE_TEST, first: async () => rowAnswer },
    ];
    if (authorityAnswer !== undefined) {
      routes.push({ test: AUTHORITY_PROBE_TEST, first: async () => authorityAnswer });
    }
    const { db, response } = await run(routes, {
      method: "DELETE", path: "/api/servers/3/invites/Goober12",
    });
    assert.equal(response.status, expectedStatus);
    if (expectedStatus === 200) {
      assert.deepEqual(await bodyOf(response), { ok: true });
    } else {
      assert.deepEqual(await bodyOf(response), { error: "That invite does not exist." });
      // The classification is diagnostic-only: no write accompanied it.
      assert.equal(
        db.calls.filter((call) => call.call === "run" && call.sql.startsWith("UPDATE gc_invites SET revoked_at")).length,
        1,
      );
    }
  });
}
