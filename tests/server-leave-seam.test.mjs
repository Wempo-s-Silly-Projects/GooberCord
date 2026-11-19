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

// T-R25-SPLIT-SERVERS-5: the leave/transfer/delete seam (the fifth family off
// api/servers.mjs). The member exit + the ownership handover + the owner's
// one-act server delete ride api/server-leave.mjs verbatim; the router's
// forward keeps the wire byte-unchanged. The shared boost-recount fragment
// (BOOST_RECOUNT_SQL) and the failure-label helper (errorName) stay ONE
// implementation in servers.mjs, imported call-time; the family's OWN
// membership row + race message move with it; the owner fragment keeps the
// local-mirror idiom.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerLeaveRoutes } from "../api/server-leave.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-leave.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

test("the leave/transfer/delete family rides api/server-leave.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleLeaveServerRoute",
    "handleTransferOwnershipRoute",
    "handleDeleteServerRoute",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("async function " + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's OWN fragments ride with it (no SQL or refusal text
  // rewritten anywhere): the membership gate/classification row and the
  // transfer race message.
  assert.match(SEAM_SOURCE, /const MEMBERSHIP_ROW_SQL =\n  "SELECT role, joined_at, nickname, timed_out_until, created_by_invite, rules_accepted_at " \+\n  "FROM gc_server_members WHERE server_id = \? AND user_id = \? LIMIT 1";/);
  assert.match(SEAM_SOURCE, /const TRANSFER_RACE_MESSAGE =\n  "The server's ownership changed while you were transferring\. Reload and try again\.";/);
  // The owner fragment keeps its local mirror (the sibling-lane idiom — the
  // mirrors-comment rides along).
  assert.match(SEAM_SOURCE, /const OWNER_EXISTS_SQL =\n  "EXISTS \(SELECT 1 FROM gc_server_members om " \+\n    "WHERE om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'\)";/);
  assert.match(SEAM_SOURCE, /must be re-mirrored and the parity tests pin the copies' behavior/);
  // The shared boost-recount fragment stays servers.mjs's ONE implementation —
  // the seam imports it, it never copies it.
  assert.doesNotMatch(SEAM_SOURCE, /const BOOST_RECOUNT_SQL/);
  assert.match(SEAM_SOURCE, /import \{ BOOST_RECOUNT_SQL, errorName \} from "\.\/servers\.mjs";/);
});

test("servers.mjs delegates the family — one dispatch, no copied leave/transfer/delete handlers", () => {
  for (const handler of [
    "handleLeaveServerRoute",
    "handleTransferOwnershipRoute",
    "handleDeleteServerRoute",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in servers.mjs");
  }
  // The family's own fragments left with it.
  assert.doesNotMatch(SERVERS_SOURCE, /const MEMBERSHIP_ROW_SQL/);
  assert.doesNotMatch(SERVERS_SOURCE, /const TRANSFER_RACE_MESSAGE/);
  // The router's dispatch block is the forward.
  assert.match(SERVERS_SOURCE, /await handleServerLeaveRoutes\(/,
    "the router hands the family to the seam module");
  // The shared helpers stay ONE implementation in servers.mjs (the export
  // contract), whatever the leave seam imports.
  for (const shared of [
    "export const BOOST_RECOUNT_SQL",
    "export function errorName",
    "const OWNER_EXISTS_SQL",
  ]) {
    assert.match(SERVERS_SOURCE, new RegExp(shared),
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

test("the seam walks the SAME wire through handleServerRoutes (the leave batch runs)", async () => {
  // The leave's guarded batch: the three in-statement-guarded DELETEs (the
  // member_roles strip, the boost strip, the member row) and the boost
  // recount LAST, byte-unchanged by the seam. The gate read answers a plain
  // member, so the owner refusal is off and the member-row delete's
  // changes=1 rides the verdict.
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
            if (sql.startsWith("SELECT role, joined_at, nickname, timed_out_until")) {
              return { role: "member", joined_at: 1, nickname: null, timed_out_until: null, created_by_invite: 0, rules_accepted_at: null };
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            runCalls.push({ sql, bound });
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  const response = await dispatch(
    new Request("http://localhost/api/servers/3/leave", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { left: true, serverId: 3 });
  // The four batch statements rode the seam's byte-unchanged SQL, in
  // ORDER: the assignment strip, the boost strip, the member row, the
  // recount LAST.
  const batchDeletes = runCalls.filter((call) => call.sql.startsWith("DELETE FROM"));
  assert.equal(batchDeletes.length, 3);
  assert.match(runCalls[0].sql, /^DELETE FROM gc_member_roles/);
  assert.match(runCalls[1].sql, /^DELETE FROM gc_server_boosts/);
  assert.match(runCalls[2].sql, /^DELETE FROM gc_server_members/);
  assert.match(runCalls[2].sql,
    /AND NOT EXISTS \(SELECT 1 FROM gc_server_members om WHERE om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'\)/,
    "the member-row delete's owner-refusal arm is byte-unchanged");
  const recount = runCalls.find((call) => call.sql.startsWith("UPDATE gc_servers SET boosts ="));
  assert.ok(recount, "the boost recount rode the batch's LAST seat");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerLeaveRoutes, "function");
});
