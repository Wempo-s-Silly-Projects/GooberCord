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

// T-R25-SPLIT-SERVERS-2: the channels seam (wave-25's second family off
// api/servers.mjs). The channels + categories family rode three distant
// regions (the create ~819, the PATCH/DELETE ~2405, the categories +
// overwrites ~3120); it now rides api/server-channels.mjs verbatim, with the
// router's forward keeping the wire byte-unchanged. The shared read helpers
// (readActorContext/viewerPayload/rolePayload/ROLE_LIST_SQL) stay ONE
// implementation in servers.mjs, exported for the seam.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerChannelsRoutes } from "../api/server-channels.mjs";
import { CHANNEL_NAME_MAX, ROLE_NAME_MAX } from "../api/servers.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-channels.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

test("the channels family rides api/server-channels.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleCreateChannelRoute",
    "handleUpdateChannelRoute",
    "handleDeleteChannelRoute",
    "handleCreateCategoryRoute",
    "handleListCategoriesRoute",
    "handleUpdateCategoryRoute",
    "handleDeleteCategoryRoute",
    "handlePutOverwriteRoute",
    "handleDeleteOverwriteRoute",
    "handleListOverwritesRoute",
    "channelManageGuard",
    "overwriteGuardSql",
    "categoryPayload",
    "overwritePayload",
    "slowmodeFrom",
    "categoryIdFrom",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("(async function |function )" + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's SQL fragments ride with it (no SQL text rewritten anywhere).
  assert.match(SEAM_SOURCE, /const CAP_CHANNEL_INSERT_SQL/);
  assert.match(SEAM_SOURCE, /const LAYERED_CHANNEL_INSERT_SQL/);
  assert.match(SEAM_SOURCE, /const NEXT_CHANNEL_ID_SQL/);
  assert.match(SEAM_SOURCE, /const CATEGORY_SELECT_SQL/);
});

test("servers.mjs delegates the family — one dispatch, no copied channel handlers", () => {
  for (const handler of [
    "handleCreateChannelRoute",
    "handleUpdateChannelRoute",
    "handleDeleteChannelRoute",
    "handleCreateCategoryRoute",
    "handleDeleteCategoryRoute",
    "handlePutOverwriteRoute",
    "handleListOverwritesRoute",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in servers.mjs");
  }
  assert.doesNotMatch(SERVERS_SOURCE, /const CAP_CHANNEL_INSERT_SQL/);
  // The router's dispatch block is the forward.
  assert.match(SERVERS_SOURCE, /await handleServerChannelsRoutes\(/,
    "the router hands the family to the seam module");
  // The shared helpers stay ONE implementation here, exported for the seam.
  assert.match(SERVERS_SOURCE, /export async function readActorContext\(/);
  assert.match(SERVERS_SOURCE, /export function viewerPayload\(/);
  assert.match(SERVERS_SOURCE, /export function rolePayload\(/);
  assert.match(SERVERS_SOURCE, /export const ROLE_LIST_SQL/);
  assert.match(SERVERS_SOURCE, /export const CHANNEL_NAME_MAX = 100/);
  assert.match(SERVERS_SOURCE, /export const ROLE_NAME_MAX = 100/);
  assert.equal(CHANNEL_NAME_MAX, 100);
  assert.equal(ROLE_NAME_MAX, 100);
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

test("the seam walks the SAME wire through handleServerRoutes (the channel create INSERT runs)", async () => {
  // The mod-gated create INSERT (channel-lifecycle.test.mjs's pinned shape):
  // the member-manage arm and the per-server cap arm ride INSIDE the INSERT,
  // byte-unchanged by the seam.
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
            if (sql.includes("AS next_channel_id")) return { next_channel_id: 90 };
            if (sql.startsWith("SELECT id, name, kind, position FROM gc_channels")) {
              return { id: 90, name: "general", kind: "text", position: 5 };
            }
            return null;
          },
          run: async () => {
            insertCalls.push({ sql, bound });
            return { meta: { changes: 1 } };
          },
          all: async () => ({ results: [] }),
        };
      },
    },
  };
  const response = await dispatch(
    new Request("http://localhost/api/servers/3/channels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ name: "general", kind: "text" }),
    }),
    env,
  );
  assert.equal(response.status, 201);
  const create = insertCalls.find((call) =>
    call.sql.startsWith("INSERT INTO gc_channels (id, server_id, name, kind, position, created_at)"));
  assert.ok(create, "the create rode the seam module's INSERT under the same route");
  assert.match(create.sql, /AND \(SELECT COUNT\(\*\) FROM gc_channels WHERE server_id = \?\) <= /,
    "the create's guarded cap arm is byte-unchanged");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerChannelsRoutes, "function");
});
