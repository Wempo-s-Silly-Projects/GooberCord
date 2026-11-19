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

// T-R25-SPLIT-SERVERS-6: the server-body seam (the fifth family off
// api/servers.mjs). The server's OWN body — create, list, PATCH settings —
// rides api/server-body.mjs verbatim; the router's ONE forward at the
// create arm's original position (the head arms are contiguous, no interior
// interloper) keeps the wire byte-unchanged. The owner's DELETE teardown
// is NOT in this family: the leave lane (T-R25-SPLIT-SERVERS-5) already
// rode it into api/server-leave.mjs — the double-move was caught at this
// lane's rebase and the copy here was cut in the same land (single home
// per handler). The body family imports The body family imports no shared read
// helpers beyond the coins/media/permissions module functions; the
// owner-guard fragment and the server-name law keep the local-mirror idiom.
//
// The overlap enumeration rides the overlap test: /api/servers (exact) and
// the flat /^\/api\/servers\/:id$/ arm appear in NO sibling seam EXCEPT
// server-leave.mjs, which owns the flat DELETE (the PATCH shape stays
// barred everywhere) — every other family arm carries a segment beyond the
// id.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerBodyRoutes } from "../api/server-body.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-body.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

const ORIGIN = "http://localhost";
const USER_ID = 7;

test("the server-body family rides api/server-body.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleCreateServerRoute",
    "handleListServersRoute",
    "handleUpdateServerRoute",
    "attachmentUrl",
    "errorName",
  ]) {
  // handleDeleteServerRoute is NOT in the list: the owner-teardown DELETE's
  // single home is api/server-leave.mjs (the double-move cut at this lane's
  // rebase); the module-local comment block at the former shaver region
  // records the same ruling.
    assert.match(SEAM_SOURCE, new RegExp("(async function |function )" + handler + "\\("),
      handler + " moved with its family");
  }
  // The owner-guard fragment and the server-name law keep their local
  // mirrors (the sibling-lane idiom — the mirrors-comment rides along).
  assert.match(SEAM_SOURCE, /const OWNER_EXISTS_SQL =\n  "EXISTS \(SELECT 1 FROM gc_server_members om " \+\n    "WHERE om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'\)";/);
  assert.match(SEAM_SOURCE, /const SERVER_NAME_MAX = 100;/);
});

test("servers.mjs delegates the body — one dispatch, no copied body handlers", () => {
  for (const handler of [
    "handleCreateServerRoute",
    "handleListServersRoute",
    "handleUpdateServerRoute",
    "handleDeleteServerRoute",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in servers.mjs");
  }
  assert.doesNotMatch(SERVERS_SOURCE, /const SERVER_NAME_MAX = 100;/);
  // The router's dispatch block is the forward, at the family's arm head.
  assert.match(SERVERS_SOURCE, /await handleServerBodyRoutes\(/,
    "the router hands the body to the seam module");
  // The earlier lanes' export contract holds: the shared helpers stay ONE
  // implementation in servers.mjs.
  for (const shared of [
    "export async function readActorContext",
    "export function moderationGuardSql",
    "export const ROLE_LIST_SQL",
    "export function rolePayload",
    "export function isoTimestamp",
    "export const BOOST_RECOUNT_SQL",
  ]) {
    assert.match(SERVERS_SOURCE, new RegExp(shared.replace("$", "\\$")),
      shared + " stays in servers.mjs");
  }
});

test("no other family's path overlaps a server-body path", () => {
  // No sibling seam module answers the body's shapes: the exact /api/servers
  // arm, or the flat /^\/api\/servers\/:id$/ (PATCH/DELETE). Every sibling
  // family arm carries a path segment beyond the id.
  for (const siblingName of [
    "server-invites.mjs", "server-channels.mjs", "server-roles.mjs",
    "server-mod.mjs", "server-leave.mjs",
  ]) {
    const sibling = readFileSync(join(HERE, "../api", siblingName), "utf8");
    assert.ok(!sibling.includes('path === "/api/servers"'),
      siblingName + " must not answer the exact /api/servers arm");
    if (siblingName === "server-leave.mjs") {
      // The DELETE teardown is server-leave.mjs's by the single-home ruling
      // (T-R25-SPLIT-SERVERS-5 landed it); the PATCH shape stays barred.
      assert.ok(sibling.includes('/^\\/api\\/servers\\/(0|[1-9][0-9]*)$/'),
        "server-leave.mjs owns the flat DELETE arm");
      continue;
    }
    assert.ok(!sibling.includes('/^\\/api\\/servers\\/(0|[1-9][0-9]*)$/'),
      siblingName + " must not answer the flat /:id arm");
  }
  // And no body arm survives in servers.mjs (they all moved).
  for (const literal of ["serverPatchMatch", "serverDeleteMatch"]) {
    assert.doesNotMatch(SERVERS_SOURCE, new RegExp(literal + " ="),
      literal + " moved to the seam");
  }
  assert.doesNotMatch(SERVERS_SOURCE, /path === "\/api\/servers"/,
    "the create/list exact arms moved to the seam");
  // The seam answers every body arm (nothing rides the fall-through).
  assert.match(SEAM_SOURCE, /path === "\/api\/servers" && method === "POST"/);
  assert.match(SEAM_SOURCE, /path === "\/api\/servers" && method === "GET"/);
  assert.ok(SEAM_SOURCE.includes('(method === "PATCH")'), "the seam answers PATCH");
  assert.doesNotMatch(SEAM_SOURCE, /method === "DELETE"/,
    "the DELETE teardown's single home is api/server-leave.mjs (the double-move cut here)");
});

// --- the smoke (the compensated create through handleServerRoutes) ---------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

const { randomToken, sha256Hex, nowSeconds } = await import("../api/core/crypto.mjs");
const authToken = randomToken();
const csrf = randomToken(24);
const sessionRow = {
  token_hash: await sha256Hex(authToken),
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
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
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

test("the seam walks the SAME wire through handleServerRoutes (the compensated create runs)", async () => {
  // The create's opening server INSERT, the build batch (owner membership +
  // the #general text channel), and the #general re-read — byte-unchanged by
  // the seam; the compensate delete only lives on the failure path.
  const runCalls = [];
  const batchCalls = [];
  const firstCalls = [];
  const env = {
    GOOBER_DB: {
      async batch(statements) {
        batchCalls.push(statements.map((statement) => statement.sql));
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.first = async () => {
          if (sql.includes("SELECT id, name, kind, position FROM gc_channels")) firstCalls.push({ sql });
          if (SESSION_READ_TEST(sql)) return sessionRow;
          return null;
        };
        statement.all = async () => ({ results: [] });
        statement.run = async () => {
          runCalls.push({ sql, bound: statement.bound });
          return { meta: { changes: 1, last_row_id: 5 } };
        };
        return statement;
      },
    },
  };
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ name: "GC" }),
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 201);
  const body = JSON.parse(await response.text());
  assert.equal(body.server.id, 5);
  assert.equal(body.server.name, "GC");
  const opener = runCalls.find((call) =>
    call.sql === "INSERT INTO gc_servers (name, owner_user_id, created_at) VALUES (?, ?, ?)");
  assert.ok(opener, "the create rode the seam module's opener under the same route");
  assert.deepEqual(opener.bound.slice(0, 2), ["GC", USER_ID]);
  const build = batchCalls[0];
  assert.ok(build, "the build batch rides");
  assert.equal(build.filter((sql) =>
    sql.startsWith("INSERT INTO gc_server_members (server_id, user_id, role, joined_at)") &&
    sql.includes("VALUES (?, ?, ?, ?)")).length, 1,
    "the owner membership insert rides byte-unchanged");
  assert.equal(build.filter((sql) =>
    sql.startsWith("INSERT INTO gc_channels (server_id, name, kind, position, created_at)") &&
    sql.includes("'general', 'text', 0")).length, 1,
    "the #general insert rides byte-unchanged");
  const generalRead = firstCalls.find((call) =>
    call.sql.startsWith("SELECT id, name, kind, position FROM gc_channels") &&
    call.sql.includes("WHERE server_id = ? AND name = 'general' LIMIT 1"));
  assert.ok(generalRead, "the #general re-read rides");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerBodyRoutes, "function");
});
