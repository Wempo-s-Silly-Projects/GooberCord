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

// T-R25-SPLIT-SERVERS-7: the search seam (the sixth family off
// api/servers.mjs). The server's message search rides api/server-search.mjs
// verbatim: the three LIKE/search SQL consts + handleSearchServerRoute + the
// ONE router arm. The forward sits at the search arm's ORIGINAL position —
// its interloper seat between the mod desk's forward and the invites
// dispatch, preserved EXACTLY — with the undefined fall-through keeping
// route order semantically byte-unchanged. The VIEW gate stays ONE
// implementation (viewerCanViewChannel in messages.mjs — imported, never
// copied); the search family keeps no guard mirrors (no module-scope guard
// fragment of its own — the gates ride the SQL texts).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerSearchRoutes } from "../api/server-search.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-search.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

const ORIGIN = "http://localhost";
const USER_ID = 7;

test("the search family rides api/server-search.mjs — one single-purpose module", () => {
  assert.match(SEAM_SOURCE, /async function handleSearchServerRoute\(/,
    "the handler moved with its family");
  // The family's SQL fragments ride with it (no SQL text rewritten anywhere).
  assert.match(SEAM_SOURCE, /const SERVER_SEARCH_MEMBERSHIP_SQL/);
  assert.match(SEAM_SOURCE, /const SERVER_SEARCH_OVERWRITES_SQL/);
  assert.match(SEAM_SOURCE, /const SERVER_SEARCH_SQL/);
  // The VIEW gate stays ONE implementation — imported from messages.mjs,
  // never copied (the export contract the messages gate's own tests pin).
  assert.match(SEAM_SOURCE, /import \{ viewerCanViewChannel \} from "\.\/messages\.mjs";/);
  assert.doesNotMatch(SEAM_SOURCE, /async function viewerCanViewChannel\(/,
    "the VIEW gate must NOT be copied into the seam");
});

test("servers.mjs delegates the search — one dispatch, no copied search handler", () => {
  assert.doesNotMatch(SERVERS_SOURCE, /async function handleSearchServerRoute\(/,
    "the handler must NOT remain defined in servers.mjs");
  assert.doesNotMatch(SERVERS_SOURCE, /const SERVER_SEARCH_MEMBERSHIP_SQL/);
  assert.doesNotMatch(SERVERS_SOURCE, /const SERVER_SEARCH_SQL/);
  assert.doesNotMatch(SERVERS_SOURCE, /const searchMatch = method === "GET"/,
    "the arm moved into the seam's dispatcher");
  // The router's dispatch block is the forward.
  assert.match(SERVERS_SOURCE, /await handleServerSearchRoutes\(/,
    "the router hands the search to the seam module");
  // The messages seam import carries url through (the arm rides searchParams).
  assert.match(SEAM_SOURCE, /export async function handleServerSearchRoutes\(request, env, url, path, method\)/);
});

test("no other family's path overlaps the search path", () => {
  // The /search shape appears in NO sibling seam module (the flat /:id arms,
  // the sub-segment arms — nothing carries a /search segment).
  for (const siblingName of [
    "server-invites.mjs", "server-channels.mjs", "server-roles.mjs",
    "server-mod.mjs", "server-body.mjs", "server-leave.mjs",
  ]) {
    const sibling = readFileSync(join(HERE, "../api", siblingName), "utf8");
    assert.ok(!sibling.includes("searchMatch"),
      siblingName + " must not answer a search arm");
    assert.ok(!sibling.includes("\\/search\\$"),
      siblingName + " must not carry the /search path literal");
  }
  // The seam pins the arm it answers (nothing rides the fall-through by
  // accident).
  assert.match(SEAM_SOURCE, /\\\/search\$/, "the seam answers /search");
});

// --- the smoke (the search route through handleServerRoutes) ---------------------

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

test("the seam walks the SAME wire through handleServerRoutes (the search SELECT runs)", async () => {
  // The member-gate read, the LIKE SELECT (escape discipline intact), and
  // the overwrites question — byte-unchanged by the seam. No overwrites →
  // the graceful default admits every hit without the per-hit gate.
  const firstCalls = [];
  const allCalls = [];
  const env = {
    GOOBER_DB: {
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.first = async () => {
          firstCalls.push({ sql, bound: statement.bound });
          if (SESSION_READ_TEST(sql)) return sessionRow;
          if (sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1")) {
            return { 1: 1 };
          }
          if (sql.includes("AS any_overwrites")) return { any_overwrites: 0 };
          return null;
        };
        statement.all = async () => {
          allCalls.push({ sql: statement.sql, bound: statement.bound });
          return {
            results: [{
              id: 900, channel_id: 12, channel_name: "general", server_id: 3,
              author_id: 22, author_username: "wempos",
              body: "hi zorp there", created_at: 4600,
            }],
          };
        };
        return statement;
      },
    },
  };
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/3/search?q=zorp", {
      method: "GET",
      headers: {
        Cookie: "goober_session=" + authToken,
        Origin: ORIGIN,
        "X-CSRF-Token": csrf,
      },
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, 900);
  assert.equal(body.results[0].channelName, "general");
  const searchSelect = allCalls.find((call) =>
    call.sql.startsWith("SELECT m.id AS id, m.channel_id AS channel_id") &&
    call.sql.includes("m.body LIKE ? ESCAPE '\\'"));
  assert.ok(searchSelect, "the search rode the seam module's LIKE SELECT under the same route");
  assert.deepEqual(searchSelect.bound.slice(0, 3), [3, "%zorp%", USER_ID],
    "the escape discipline binds server/term/user in order (no wildcards in the term)");
  assert.equal(searchSelect.bound.length, 3,
    "no channel filter → no 4th placeholder, no 4th bind");
  const overwritesRead = firstCalls.find((call) => call.sql.includes("AS any_overwrites"));
  assert.ok(overwritesRead, "the overwrites question rides byte-unchanged");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerSearchRoutes, "function");
});
