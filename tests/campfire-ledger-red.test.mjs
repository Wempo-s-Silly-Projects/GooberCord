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

// The Campfire ledger (the re-coded economy event ledger): the fire's books
// are open to the server's members. The books are the COMMUNITY'S AGGREGATE
// over the gc_coin_ledger rows the economy already mints (no new table, no
// new write anywhere on the schema): a 30-day, server-keyed window, grouped
// per (source, direction). Flow-class labels only — no coin holder is
// nameable, never a top-list, never a per-member page.
import test from "node:test";
import assert from "node:assert/strict";

import { handleCampfireRoutes } from "../api/campfire.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { GC_CAMPFIRE_LEDGER_WINDOW_SECONDS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 500;
const NOW = nowSeconds();
const ROUTE = "/api/servers/" + SERVER_ID + "/ledger";

// --- shared scaffolding (coins-module conventions) ------------------------------

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

function request(method, path) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleCampfireRoutes(
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

// --- the stateful fake -----------------------------------------------------------

// The seed rows are REAL ledger rows (the shape gc_coin_ledger already
// stores: user-keyed, signed delta, source, created_at). The flow read's
// handler re-derives the aggregates from them; no write route exists anywhere
// in this module, and the fake throws if one ever tries.
function ledgerDb(options = {}) {
  const members = (options.members || [{ server_id: SERVER_ID, user_id: USER_ID, role: "member" }]);
  const ledger = (options.ledger || []).map((row) => ({ ...row }));
  const calls = [];
  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      test: (sql) =>
        sql.startsWith("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?"),
      first: async (bound) =>
        members.find((row) => row.server_id === bound[0] && row.user_id === bound[1]) || null,
    },
    {
      // The ONE read: derived per (source, direction) over the window, among
      // the server's members, with NO member column selected.
      test: (sql) => sql.includes("GROUP BY le.source"),
      all: async (bound) => {
        const [serverId, startSeconds] = bound;
        const memberIds = new Set(
          members.filter((row) => row.server_id === serverId).map((row) => row.user_id),
        );
        const aggregates = new Map();
        for (const row of ledger) {
          if (!memberIds.has(row.user_id)) continue; // foreign members contribute nothing
          if (row.created_at < startSeconds) continue;
          const direction = row.delta > 0 ? "in" : "out";
          const magnitude = Math.abs(row.delta);
          const key = row.source + "|" + direction;
          if (!aggregates.has(key)) {
            aggregates.set(key, { source: row.source, direction, amount: 0, count: 0 });
          }
          const aggregate = aggregates.get(key);
          aggregate.amount += direction === "in" ? magnitude : -magnitude;
          aggregate.count += 1;
        }
        return {
          results: [...aggregates.values()].sort(
            (left, right) => left.source.localeCompare(right.source) ||
              left.direction.localeCompare(right.direction),
          ),
        };
      },
    },
  ];

  return {
    calls,
    ledger,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound });
        return route && route.first ? await route.first(statement.bound, sql) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound });
        return route && route.all ? await route.all(statement.bound, sql) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound });
        throw new Error("the ledger mints nothing: the fake refuses every run-statement");
      };
      return statement;
    },
    batch: async () => {
      throw new Error("the ledger rides in no batch: the fake refuses every batch");
    },
  };
}

// --- the numbers -----------------------------------------------------------------

test("the ledger's window rides constants.mjs — thirty days, named once", () => {
  assert.equal(GC_CAMPFIRE_LEDGER_WINDOW_SECONDS, 2592000);
});

// --- the books are open -----------------------------------------------------------

test("the ledger is members-only; a non-member shares the unknown-server 404", async () => {
  const env = envWithLimiters(ledgerDb({
    members: [{ server_id: SERVER_ID, user_id: 88, role: "member" }],
  }));
  const response = await dispatch(request("GET", ROUTE), env);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /does not exist or you cannot view it/);
});

test("the books are open: flow lines per (source, direction) over the 30-day window", async () => {
  const ledger = [
    // In-flow earns across sources, members of the server:
    { user_id: USER_ID, delta: 2, source: "message", created_at: NOW - 10 },
    { user_id: 22, delta: 3, source: "rollup", created_at: NOW - 20 },
    { user_id: 22, delta: 25, source: "daily", created_at: NOW - 30 },
    // One out-flow sink:
    { user_id: 22, delta: -100, source: "cosmetic", created_at: NOW - 40 },
    // Outside the window:
    { user_id: 22, delta: 25, source: "daily", created_at: NOW - GC_CAMPFIRE_LEDGER_WINDOW_SECONDS - 1 },
    // Members of ANOTHER server contribute nothing to these books:
    { user_id: 44, delta: 50, source: "server", created_at: NOW - 5 },
  ];
  const db = ledgerDb({
    ledger,
    members: [
      { server_id: SERVER_ID, user_id: USER_ID, role: "member" },
      { server_id: SERVER_ID, user_id: 22, role: "member" },
      { server_id: 501, user_id: 44, role: "member" },
    ],
  });
  const env = envWithLimiters(db);

  const response = await dispatch(request("GET", ROUTE), env);
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);

  // The window is the trailing named span, server-keyed.
  assert.equal(payload.window.endSeconds - payload.window.startSeconds, GC_CAMPFIRE_LEDGER_WINDOW_SECONDS);
  const readCall = db.calls.find((call) => call.sql.includes("GROUP BY le.source"));
  assert.equal(readCall.bound[0], SERVER_ID, "the WHERE keys the aggregate to this server");
  assert.equal(readCall.bound[1], payload.window.startSeconds);

  // Aggregates: the stale-window row and the foreign member's row contribute
  // nothing — each (source, direction) pair earns exactly one flow line.
  assert.deepEqual(payload.flows, [
    { source: "cosmetic", direction: "out", amount: -100, count: 1 },
    { source: "daily", direction: "in", amount: 25, count: 1 },
    { source: "message", direction: "in", amount: 2, count: 1 },
    { source: "rollup", direction: "in", amount: 3, count: 1 },
  ]);
});

test("an empty window still serves the books — an empty flows list is the honest shape", async () => {
  const env = envWithLimiters(ledgerDb({ ledger: [] }));
  const response = await dispatch(request("GET", ROUTE), env);
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.deepEqual(payload.flows, []);
  assert.deepEqual(Object.keys(payload).sort(), ["flows", "window"]);
});

// --- the no-attribution laws -----------------------------------------------------

test("the read is pure: zero write statements may fire anywhere in the module", async () => {
  const db = ledgerDb({
    ledger: [{ user_id: USER_ID, delta: 2, source: "message", created_at: NOW - 10 }],
  });
  const env = envWithLimiters(db);
  await dispatch(request("GET", ROUTE), env);
  for (const call of db.calls) {
    assert.match(call.sql, /^SELECT/i, "a ledger read never runs a write statement");
  }
});

test("no member is nameable in the books: flow-line payloads carry labels only", async () => {
  const db = ledgerDb({
    ledger: [
      { user_id: USER_ID, delta: 2, source: "message", created_at: NOW - 10 },
      { user_id: 22, delta: -100, source: "cosmetic", created_at: NOW - 40 },
    ],
    members: [
      { server_id: SERVER_ID, user_id: USER_ID, role: "member" },
      { server_id: SERVER_ID, user_id: 22, role: "member" },
    ],
  });
  const env = envWithLimiters(db);
  const payload = await bodyOf(await dispatch(request("GET", ROUTE), env));
  assert.equal(payload.flows.length, 2);
  for (const flow of payload.flows) {
    assert.deepEqual(Object.keys(flow).sort(), ["amount", "count", "direction", "source"]);
  }
  assert.doesNotMatch(JSON.stringify(payload), /user/i, "no userId, no username, no ranking");

  // The pinned SQL itself carries no member column outside the
  // membership-scoping join.
  const readCall = db.calls.find((call) => call.sql.includes("GROUP BY le.source"));
  assert.doesNotMatch(readCall.sql, /username/u);
  assert.match(readCall.sql, /SELECT le\.source/);
});

test("the ledger module owns only its path — strangers fall through the dispatch", async () => {
  const env = envWithLimiters(ledgerDb());
  assert.equal(
    await handleCampfireRoutes(
      request("POST", ROUTE), env, new URL(ORIGIN + ROUTE), ROUTE, "POST",
    ),
    undefined,
  );
  assert.equal(
    await handleCampfireRoutes(
      request("GET", "/api/servers/" + SERVER_ID + "/paper"),
      env, new URL(ORIGIN), "/api/servers/" + SERVER_ID + "/paper", "GET",
    ),
    undefined,
  );
});
