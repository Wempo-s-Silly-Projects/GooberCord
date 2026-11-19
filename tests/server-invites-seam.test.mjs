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

// T-R25-SPLIT-SERVERS: the invites/discovery seam (wave-25's area-3 major).
// api/servers.mjs rode 4111 lines (5.1x the 800-line ceiling); the cleanest
// ONE-family seam is the invites + discovery block (its handlers, SQL
// fragments, and knobs are one contiguous region with ONE external guard
// fragment — OWNER_EXISTS_SQL). This pin holds the seam's three facts:
// the family lives in api/server-invites.mjs, servers.mjs DELEGATES (no
// copy), and the route walks through unchanged via handleServerRoutes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerInviteRoutes } from "../api/server-invites.mjs";
import {
  INVITE_LIST_LIMIT,
  INVITE_MAX_AGE_MAX,
  INVITE_MAX_AGE_MIN,
  INVITE_MAX_USES_MAX,
} from "../api/servers.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-invites.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

test("the invite family lives in api/server-invites.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleCreateInviteRoute",
    "handleInviteJoinRoute",
    "handleListInvitesRoute",
    "handleRevokeInviteRoute",
    "handleDiscoverRoute",
    "handleDiscoverJoinRoute",
    "classifyRefusedJoin",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("async function " + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's SQL fragments ride with it (no SQL text rewritten anywhere).
  assert.match(SEAM_SOURCE, /const INVITE_ACTIVE_SQL/);
  assert.match(SEAM_SOURCE, /const INVITE_LIST_SQL/);
  assert.match(SEAM_SOURCE, /const DISCOVER_SELECT_SQL/);
  // The knobs seat here (the ui-settings source pin reads them here now).
  assert.match(SEAM_SOURCE, /export const INVITE_MAX_AGE_MIN = 60/);
  assert.match(SEAM_SOURCE, /export const INVITE_MAX_AGE_MAX = 2592000/);
  assert.match(SEAM_SOURCE, /export const INVITE_MAX_USES_MAX = 100/);
  assert.match(SEAM_SOURCE, /export const INVITE_LIST_LIMIT = 500/);
});

test("servers.mjs delegates the family — one dispatch, no copied invite handlers", () => {
  // The moved handlers' definitions are GONE (a copy would be two sources
  // of truth for one wire contract).
  for (const handler of [
    "handleCreateInviteRoute",
    "handleInviteJoinRoute",
    "handleListInvitesRoute",
    "handleRevokeInviteRoute",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in servers.mjs");
  }
  // The INVITE_ACTIVE fragment rides only in the seam module.
  assert.doesNotMatch(SERVERS_SOURCE, /const INVITE_ACTIVE_SQL/);
  // The router's dispatch block is the forward (an await + the undefined
  // fall-through — the seam's shape in servers.mjs).
  assert.match(SERVERS_SOURCE, /await handleServerInviteRoutes\(/,
    "the router hands the family to the seam module");
  // The family-facing exports keep resolving through servers.mjs (the
  // existing consumers' import — tests/invite-lifecycle.test.mjs's import —
  // is untouched by the seam).
  assert.equal(INVITE_MAX_AGE_MIN, 60);
  assert.equal(INVITE_MAX_AGE_MAX, 2592000);
  assert.equal(INVITE_MAX_USES_MAX, 100);
  assert.equal(INVITE_LIST_LIMIT, 500);
});

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

test("the seam walks the SAME wire through handleServerRoutes (the mint INSERT runs)", async () => {
  // The mint's guarded INSERT (servers-discovery.test.mjs's pinned shape):
  // the owner-rider pair, the MANAGE_INVITES pair, the 999 cap arm — inside
  // the INSERT, byte-unchanged by the seam. Session auth rides the same
  // fixtures shape the family's existing tests use.
  const { randomToken: token, sha256Hex, nowSeconds: seconds } =
    await import("../api/core/crypto.mjs");
  const authToken = token();
  const csrf = token(24);
  const sessionRow = {
    token_hash: await sha256Hex(authToken),
    user_id: 7,
    csrf_token: csrf,
    expires_at: seconds() + 3600,
    username: "wempos",
    role: "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  const insertCalls = [];
  const env = {
    GOOBER_DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...values) { bound = values; return this; },
          first: async () => {
            if (sql.includes("FROM sessions s LEFT JOIN users u")) return sessionRow;
            if (sql.includes("SELECT role FROM gc_server_members")) return { role: "owner" };
            return null;
          },
          run: async () => {
            insertCalls.push(sql);
            return { meta: { changes: 1 } };
          },
          batch: async (statements) => statements.map(() => ({ meta: { changes: 1 } })),
        };
      },
    },
  };
  const response = await dispatch(
    new Request("http://localhost/api/servers/3/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
      body: '{}',
    }),
    env,
  );
  assert.equal(response.status, 201);
  const mint = insertCalls.find((sql) =>
    sql.startsWith("INSERT INTO gc_invites (code, server_id, created_by, created_at, expires_at, max_uses)"));
  assert.ok(mint, "the mint rode the seam module's INSERT under the same route");
  assert.match(mint, /AND \(SELECT COUNT\(\*\) FROM gc_invites WHERE server_id = \?\) <= 999/,
    "the mint's guarded arm is byte-unchanged");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerInviteRoutes, "function");
});
