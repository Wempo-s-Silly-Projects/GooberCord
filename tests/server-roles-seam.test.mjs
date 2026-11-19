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

// T-R25-SPLIT-SERVERS-3: the roles/roster seam (the third family off
// api/servers.mjs). The roles CRUD + assignment + roster + nicknames family
// rides api/server-roles.mjs verbatim; the router's forward keeps the wire
// byte-unchanged. The shared read helpers (readActorContext/ROLE_LIST_SQL/
// viewerPayload/rolePayload) and the law constants the channels lane exported
// stay ONE implementation in servers.mjs; the family's own guard fragment
// (roleManageGuardSql) and SQL move with it; the owner/top fragments and
// NICKNAME_MAX keep the local-mirror idiom.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerRolesRoutes } from "../api/server-roles.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-roles.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

test("the roles/roster family rides api/server-roles.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleListRolesRoute",
    "handleCreateRoleRoute",
    "handleUpdateRoleRoute",
    "handleDeleteRoleRoute",
    "handleAssignRoleRoute",
    "handleUnassignRoleRoute",
    "handleRosterRoute",
    "handleSetOwnNicknameRoute",
    "handleSetMemberNicknameRoute",
    "roleManageGuardSql",
    "validateRoleColor",
    "permissionsFromNames",
    "nicknameFromBody",
    "nicknameIsFiltered",
    "avatarUrlOf",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("(async function |function )" + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's SQL fragments ride with it (no SQL text rewritten anywhere).
  assert.match(SEAM_SOURCE, /const ROLE_SELECT_SQL/);
  assert.match(SEAM_SOURCE, /const ASSIGNMENT_SELECT_SQL/);
  // The owner/top fragments and the nickname law keep their local mirrors
  // (the sibling-lane idiom — the mirrors-comment rides along).
  assert.match(SEAM_SOURCE, /const OWNER_EXISTS_SQL =\n  "EXISTS \(SELECT 1 FROM gc_server_members om " \+\n    "WHERE om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'\)";/);
  assert.match(SEAM_SOURCE, /const NICKNAME_MAX = 32;/);
});

test("servers.mjs delegates the family — one dispatch, no copied role handlers", () => {
  for (const handler of [
    "handleListRolesRoute",
    "handleCreateRoleRoute",
    "handleUpdateRoleRoute",
    "handleDeleteRoleRoute",
    "handleAssignRoleRoute",
    "handleUnassignRoleRoute",
    "handleRosterRoute",
    "handleSetOwnNicknameRoute",
    "handleSetMemberNicknameRoute",
    "roleManageGuardSql",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in servers.mjs");
  }
  assert.doesNotMatch(SERVERS_SOURCE, /const ROLE_SELECT_SQL/);
  assert.doesNotMatch(SERVERS_SOURCE, /const ASSIGNMENT_SELECT_SQL/);
  // The router's dispatch block is the forward.
  assert.match(SERVERS_SOURCE, /await handleServerRolesRoutes\(/,
    "the router hands the family to the seam module");
  // The shared helpers stay ONE implementation in servers.mjs (the channels
  // lane's export contract), whatever the roles seam imports.
  for (const shared of [
    "export async function readActorContext",
    "export const ROLE_LIST_SQL",
    "export function viewerPayload",
    "export function rolePayload",
    "export function moderationGuardSql",
    "export function isoTimestamp",
    "export const ROLE_NAME_MAX",
  ]) {
    assert.match(SERVERS_SOURCE, new RegExp(shared.replace("$", "\\$")),
      shared + " stays in servers.mjs");
  }
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

test("the seam walks the SAME wire through handleServerRoutes (the role create INSERT runs)", async () => {
  // The create's guarded INSERT ... SELECT: the owner OR MANAGE_ROLES arm and
  // the per-server cap arm ride INSIDE the statement, byte-unchanged by the
  // seam. The actor-context read answers the owner tier.
  const runCalls = [];
  const env = {
    GOOBER_DB: {
      batch: async (statements) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
      prepare(sql) {
        let bound = [];
        return {
          bind(...values) { bound = values; return this; },
          first: async () => {
            if (sql.includes("FROM sessions s LEFT JOIN users u")) return sessionRow;
            if (sql.includes("AS role, m.nickname AS nickname")) {
              return { role: "owner", nickname: null, permissions: 0, position: -1 };
            }
            if (sql.startsWith("SELECT id, name, color, position, permissions FROM gc_roles WHERE id")) {
              return { id: 9, name: "Mods", color: null, position: 3, permissions: 4 };
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            runCalls.push({ sql, bound });
            return { meta: { changes: 1, last_row_id: 9 } };
          },
        };
      },
    },
  };
  const response = await dispatch(
    new Request("http://localhost/api/servers/3/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ name: "Mods" }),
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 201);
  const insert = runCalls.find((call) =>
    call.sql.startsWith("INSERT INTO gc_roles (server_id, name, color, position, permissions, created_at)"));
  assert.ok(insert, "the create rode the seam module's INSERT under the same route");
  assert.match(insert.sql,
    /WHERE \(EXISTS \(SELECT 1 FROM gc_server_members om WHERE om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'\) OR /,
    "the create's guarded owner arm is byte-unchanged");
  assert.match(insert.sql, /AND \(SELECT COUNT\(\*\) FROM gc_roles WHERE server_id = \?\) <= /,
    "the create's cap arm is byte-unchanged");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerRolesRoutes, "function");
});
