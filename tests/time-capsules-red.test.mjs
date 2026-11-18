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

// T82 Time Capsules — RED rows (spec: docs/drafts/t82-time-capsules-spec.md).
// RED today BY CONSTRUCTION: api/capsules.mjs and the gc_time_capsules table
// do not exist yet, so this file's import fails before a single row runs —
// the ERR_MODULE_NOT_FOUND below IS the raw RED error. The GREEN lane lands
// the module + migration and these rows flip one by one; extending the fake
// during GREEN is expected and allowed.
//
// Idiom: the coins-module fakeDb + pinned-SQL contract style. The fake
// encodes the capsule row's shape (author/table) so each row pins a LAW:
//   * opt-in — nothing is read or written before the member acts;
//   * deletable-until-reveal — the delete carries reveal_at > ? in its arm;
//   * reveal gate — one time comparison in the row (no timers anywhere);
//   * privacy — every read carries its author (or view) seat INSIDE the SQL.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCapsuleRoutes } from "../api/capsules.mjs";
import {
  GC_CAPSULE_BODY_MAX,
  GC_CAPSULE_MIN_AHEAD_SECONDS,
  GC_CAPSULE_MAX_AHEAD_SECONDS,
  GC_CAPSULES_MAX_OPEN_PER_MEMBER,
} from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const STRANGER_ID = 9;
const SERVER_ID = 1;
const CHANNEL_ID = 12;
const NOW = nowSeconds();

// --- scaffolding (coins-module idiom, trimmed to the capsule needs) -----------

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

const AUTHORED = [
  // A self-seal, still sealed.
  { id: 1, author_id: USER_ID, server_id: SERVER_ID, channel_id: null,
    body: "dear future me", reveal_at: NOW + 60, created_at: NOW - 100 },
  // A channel letter, already revealed.
  { id: 2, author_id: USER_ID, server_id: SERVER_ID, channel_id: CHANNEL_ID,
    body: "the room remembers", reveal_at: NOW - 10, created_at: NOW - 200 },
  // A stranger's sealed capsule — unreachable by every surface below.
  { id: 3, author_id: STRANGER_ID, server_id: SERVER_ID, channel_id: CHANNEL_ID,
    body: "not yours yet", reveal_at: NOW + 60, created_at: NOW - 5 },
];

function capsuleDb(options = {}) {
  const capsules = (options.capsules || AUTHORED).map((row) => ({ ...row }));
  const users = options.users || [{ id: USER_ID, username: "wempos" }];
  const calls = [];
  const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
  const AUTHOR_READ_TEST = (sql) =>
    sql.startsWith("SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules");
  const MINE_TEST = (sql) =>
    sql.startsWith("SELECT id, channel_id, reveal_at FROM gc_time_capsules");
  const MEMBERSHIP_TEST = (sql) => sql.includes("gc_server_members");

  const routes = [
    { test: SESSION_TEST, first: async () => SESSION_ROW },
    // The author seat rides INSIDE the read: the fake answers only rows whose
    // author matches the bound seat (a GREEN statement without the seat
    // answers the stranger's row here and the row FAILS the pin).
    {
      test: MINE_TEST,
      all: async (bound) => ({
        results: capsules.filter((row) =>
          Number(row.author_id) === Number(bound[0]) &&
          Number(row.server_id) === Number(bound[1])),
      }),
    },
    // The reveal gate's non-author view read (GREEN: the unfiltered by-id
    // read, still with NO body column). Precise prefix so the author read
    // ("... WHERE id = ? AND author_id = ?") falls through to the next route.
    {
      test: (sql) => sql.startsWith(
        "SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules WHERE id = ? LIMIT 1"),
      first: async (bound) =>
        capsules.find((row) => Number(row.id) === Number(bound[0])) || null,
    },
    {
      test: AUTHOR_READ_TEST,
      first: async (bound) =>
        capsules.find((row) =>
          Number(row.id) === Number(bound[0]) &&
          Number(row.author_id) === Number(bound[1])) || null,
    },
    { test: MEMBERSHIP_TEST, first: async () => ({ role: "member" }) },
    { test: () => true, run: (bound) => { const n = capsules.length; capsules.splice(0, n); return { meta: { changes: 1 } }; },
      first: async (bound) =>
        capsules.find((row) => Number(row.id) === Number(bound[0])) || null },
  ];

  const db = {
    calls,
    capsules,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound, call: "first" });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound, call: "all" });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound, call: "run" });
        return route && route.run ? route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({ call: "batch", statements: statements.map((s) => ({ sql: s.sql, bound: s.bound })) });
      return results;
    },
  };
  return db;
}

function envWithLimiters(db, overrides = {}) {
  const env = { GOOBER_DB: db, ...overrides };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleCapsuleRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(
    JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 },
  );
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

// --- rows -------------------------------------------------------------------

test("the capsule constants exist with the spec's caps", () => {
  assert.equal(GC_CAPSULE_BODY_MAX, 2000);
  assert.equal(GC_CAPSULE_MIN_AHEAD_SECONDS, 300);
  assert.equal(GC_CAPSULE_MAX_AHEAD_SECONDS, 30 * 86400);
  assert.equal(GC_CAPSULES_MAX_OPEN_PER_MEMBER, 10);
});

test("the create answers the ACTING member a sealed letter — nothing default-on", async () => {
  const db = capsuleDb({ capsules: [] });
  const response = await dispatch(
    authed("POST", `/api/servers/${SERVER_ID}/capsules`,
      { body: "dear future me", revealAt: NOW + GC_CAPSULE_MIN_AHEAD_SECONDS + 10 }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201, "the capsule exists because a member acted");
  const body = await bodyOf(response);
  assert.equal(body.sealed, true, "the fresh letter is sealed, not live");
  assert.equal(body.revealAt, NOW + GC_CAPSULE_MIN_AHEAD_SECONDS + 10);
});

test("the member's list answers ONLY their own capsules", async () => {
  const db = capsuleDb();
  const response = await dispatch(authed("GET", `/api/servers/${SERVER_ID}/capsules/mine`), envWithLimiters(db));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  const ids = (body.capsules || []).map((row) => row.id);
  assert.deepEqual(ids, [1, 2],
    "the author seat rides the read: the stranger's row never leaves the table");
});

test("a capsule is deletable UNTIL its reveal — the row is gone, hard", async () => {
  const db = capsuleDb();
  const response = await dispatch(authed("DELETE", `/api/servers/${SERVER_ID}/capsules/1`), envWithLimiters(db));
  assert.equal(response.status, 200);
  const deleteStatement = db.calls.find((call) =>
    call.call === "run" && call.sql?.startsWith("DELETE FROM gc_time_capsules"));
  assert.ok(deleteStatement, "the delete is a hard row delete (the GDPR shape)");
  // The delete gate rides its arm: reveal_at > ? is INSIDE the statement.
  assert.ok(deleteStatement.sql.includes("reveal_at > ?"),
    "the deletable-until-reveal law rides the statement, not the route's filter");
  assert.equal(db.capsules.length, 0, "nothing survives the author's delete");
});

test("after the reveal the letter is LOCKED — the author's control ends at the postmark", async () => {
  const db = capsuleDb();
  // Row 2 is past its reveal: the gate answers the same refusal either way
  // (the route's arm classifies; the fake's run answers changes 0).
  const response = await dispatch(authed("DELETE", `/api/servers/${SERVER_ID}/capsules/2`), envWithLimiters(db));
  assert.equal(response.status, 409, "a revealed letter stays where it was posted");
  const body = await bodyOf(response);
  assert.match(body.error, /revealed/i);
});

test("the reveal gate is 404 before the postmark for a non-author — no oracle", async () => {
  const response = await dispatch(authed("GET", `/api/servers/${SERVER_ID}/capsules/3`), envWithLimiters(capsuleDb()));
  // The stranger's sealed capsule: the unknown shape — not 200, not 403
  // (nobody learns the letter exists).
  assert.equal(response.status, 404);
});

test("the gate OPENS at the postmark — a channel member reads the revealed letter", async () => {
  const response = await dispatch(authed("GET", `/api/servers/${SERVER_ID}/capsules/2`), envWithLimiters(capsuleDb()));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.sealed, false);
  assert.equal(body.body, "the room remembers", "the revealed body rides the read");
});

test("a SELF-SEAL never leaves its author — 404 for everyone, revealed or not", async () => {
  // Row 1 is sealed-to-self: even after ITS reveal moment passes, row 1's
  // body rides only to USER_ID (the fake's author seat answers the shape).
  const db = capsuleDb({
    capsules: [{
      id: 1, author_id: STRANGER_ID, server_id: SERVER_ID, channel_id: null,
      body: "hidden", reveal_at: NOW - 10, created_at: NOW - 100,
    }],
  });
  const response = await dispatch(authed("GET", `/api/servers/${SERVER_ID}/capsules/1`), envWithLimiters(db));
  assert.equal(response.status, 404,
    "a self-seal is the author's alone — no channel view gate can open it");
});
