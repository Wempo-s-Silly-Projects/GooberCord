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

// Month-day community anniversaries (the re-coded seat): ONE member, at most
// ONE month-day anniversary; the row is SELF-scoped (PUT/DELETE at /api/users
// /me/anniversary) and the schema carries month+day and NOTHING else — no
// year, no anchored timestamp (LIMIT COLLECTION NOT ACCESS). Validation is
// STRUCTURAL ONLY: month 0-11, day 1-31, no per-month day counts, no leap
// math (Feb 30 is stored verbatim and simply never fires).
//
// The celebrant read rides the Morning Paper's read as its own
// member-scoped join — pinned there in morning-paper-red; here the seat's own
// writes and validation live.
import test from "node:test";
import assert from "node:assert/strict";

import { handlePaperRoutes } from "../api/paper.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 500;

const ROUTE = "/api/users/me/anniversary";

// --- shared scaffolding (paper harness conventions) ------------------------------

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

function request(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handlePaperRoutes(
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

function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function anniversaryDb(options = {}) {
  const existing = options.existing ? new Map(options.existing) : new Map();
  const writes = [];
  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      test: (sql) => sql.startsWith("INSERT INTO gc_user_anniversaries"),
      run: (bound) => {
        const [userId, month, day] = bound;
        writes.push({ userId, month, day });
        existing.set(userId, { month, day });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_user_anniversaries WHERE user_id = ?"),
      run: (bound) => {
        const had = existing.has(bound[0]);
        existing.delete(bound[0]);
        return { meta: { changes: had ? 1 : 0 } };
      },
    },
  ];
  return {
    existing,
    writes,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => (route && route.first ? route.first(statement.bound) : null);
      statement.all = async () => ({ results: [] });
      statement.run = async () => {
        if (!route) return { meta: { changes: 1 } };
        return route.run(statement.bound);
      };
      return statement;
    },
    batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
  };
}

// --- the seat -------------------------------------------------------------------

test("the anniversary is an explicit act: a PUT wants a month (0-11) and a day (1-31)", async () => {
  const db = anniversaryDb();
  const env = envWithLimiters(db);

  const valid = await dispatch(request("PUT", ROUTE, { month: 10, day: 25 }), env);
  assert.equal(valid.status, 200);
  assert.deepEqual(await bodyOf(valid), { month: 10, day: 25 });
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].userId, USER_ID, "the write keys on the session member and nothing else");

  // January is index 0 and December index 11 — both inside the structural
  // range; so is the seat's quiet corner, Feb 30 (stored verbatim, never
  // fires — matching is pure (month, day) equality).
  const february30 = await dispatch(request("PUT", ROUTE, { month: 1, day: 30 }), env);
  assert.equal(february30.status, 200);
});

test("out-of-range or non-integer keys are a 400 and write nothing", async () => {
  const refusals = [
    { month: 12, day: 1 },    // month out of range
    { month: -1, day: 1 },    // month negative
    { month: 1, day: 0 },     // day out of range
    { month: 1, day: 32 },    // day out of range
    { month: 1.5, day: 10 },  // non-integer
    { month: "1", day: 10 },  // non-integer
    { month: 1 },             // day missing
    { day: 10 },              // month missing
  ];
  await Promise.all(refusals.map(async (body) => {
    const db = anniversaryDb();
    const env = envWithLimiters(db);
    const response = await dispatch(request("PUT", ROUTE, body), env);
    assert.equal(response.status, 400, JSON.stringify(body) + " is a 400");
    assert.deepEqual(db.writes, [], "an off-body never writes on anyone's behalf");
  }));
});

test("a re-set overwrites in place — one row per member, no history", async () => {
  const db = anniversaryDb({ existing: [[USER_ID, { month: 3, day: 1 }]] });
  const env = envWithLimiters(db);
  const response = await dispatch(request("PUT", ROUTE, { month: 8, day: 2 }), env);
  assert.equal(response.status, 200);
  assert.equal(db.existing.size, 1, "the PK is the seat: no second row");
  assert.deepEqual(db.existing.get(USER_ID), { month: 8, day: 2 });
  assert.equal(db.writes.length, 1);
});

test("the clear is immediate, total, and idempotent", async () => {
  const db = anniversaryDb({ existing: [[USER_ID, { month: 3, day: 1 }]] });
  const env = envWithLimiters(db);
  const first = await dispatch(request("DELETE", ROUTE), env);
  assert.equal(first.status, 200);
  assert.deepEqual(await bodyOf(first), { month: null, day: null });
  assert.equal(db.existing.size, 0);

  const second = await dispatch(request("DELETE", ROUTE), env);
  assert.equal(second.status, 200, "an untouched member's clear answers its state, never a 404");
  assert.deepEqual(await bodyOf(second), { month: null, day: null });
});

test("the anniversary writes are self-scoped: no route accepts another member's id", async () => {
  const db = anniversaryDb();
  const env = envWithLimiters(db);
  // The route's binds carry only the session member — a foreign id cannot
  // arrive through the body either.
  await dispatch(request("PUT", ROUTE, { month: 1, day: 1, userId: 88 }), env);
  assert.equal(db.writes[0].userId, USER_ID, "the body's userId key is inert");
  const foreign = await dispatch(request("PUT", "/api/users/88/anniversary", { month: 1, day: 1 }), env);
  assert.equal(foreign.status, 404, "someone else's anniversary seat does not exist");
});

test("the anniversary routes are exact — prefix shadows do not swallow them", async () => {
  const env = envWithLimiters(anniversaryDb());
  const stray = await dispatch(request("PUT", ROUTE + "/extra", { month: 1, day: 1 }), env);
  assert.equal(stray.status, 404);
});
