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

// T-R25-SPLIT-SERVERS-4: the mod desk seam (the fourth family off
// api/servers.mjs). The AutoMod desk (filter rules + alerts) and its
// enforcement arm (kicks, bans, timeouts, prune) ride api/server-mod.mjs
// verbatim; the router's forward keeps the wire byte-unchanged (the search
// arm stays home between the alerts and kick arms). The shared read helpers
// (readActorContext/moderationGuardSql/isoTimestamp) stay ONE implementation
// in servers.mjs; the family's guard fragments (OWNER_EXISTS_SQL,
// TOP_POSITION_SELECT) and the ban-reason law (BAN_REASON_MAX) keep the
// local-mirror idiom.
//
// The ban route paths sit at a segment count no other family arm shares:
// DELETE /members/:target (kick) is one segment shy of the roles lane's
// /roles/:rid/members/:uid and one deeper than invite/roster/search; the
// enumeration rides the seam test file.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleServerRoutes } from "../api/servers.mjs";
import { handleServerModRoutes } from "../api/server-mod.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/server-mod.mjs"), "utf8");
const SERVERS_SOURCE = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");

const ORIGIN = "http://localhost";
const USER_ID = 7;
const TARGET_ID = 22;

test("the mod desk family rides api/server-mod.mjs — one single-purpose module", () => {
  for (const handler of [
    "handleListFilterRulesRoute",
    "handleCreateFilterRuleRoute",
    "handleUpdateFilterRuleRoute",
    "handleDeleteFilterRuleRoute",
    "handleListFilterAlertsRoute",
    "handleKickMemberRoute",
    "handleBanMemberRoute",
    "handleUnbanMemberRoute",
    "handleSetTimeoutRoute",
    "handleRemoveTimeoutRoute",
    "handlePruneRoute",
    "filterRulesGuardParams",
    "filterRuleBodyFrom",
    "validExemptIds",
    "ruleFromRow",
    "pruneActivitySql",
    "pruneRoleFilterSql",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("(async function |function )" + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's SQL fragments ride with it (no SQL text rewritten anywhere).
  assert.match(SEAM_SOURCE, /const FILTER_RULE_CREATE_SQL/);
  assert.match(SEAM_SOURCE, /const FILTER_RULE_SELECT_SQL/);
  // The owner/top fragments and the ban-reason law keep their local mirrors
  // (the sibling-lane idiom — the mirrors-comment rides along).
  assert.match(SEAM_SOURCE, /const OWNER_EXISTS_SQL =\n  "EXISTS \(SELECT 1 FROM gc_server_members om " \+\n    "WHERE om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'\)";/);
  assert.match(SEAM_SOURCE, /const TOP_POSITION_SELECT =/);
  assert.match(SEAM_SOURCE, /const BAN_REASON_MAX = 280;/);
});

test("servers.mjs delegates the desk — one dispatch, no copied mod handlers", () => {
  for (const handler of [
    "handleListFilterRulesRoute",
    "handleCreateFilterRuleRoute",
    "handleUpdateFilterRuleRoute",
    "handleDeleteFilterRuleRoute",
    "handleListFilterAlertsRoute",
    "handleKickMemberRoute",
    "handleBanMemberRoute",
    "handleUnbanMemberRoute",
    "handleSetTimeoutRoute",
    "handleRemoveTimeoutRoute",
    "handlePruneRoute",
    "validExemptIds",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in servers.mjs");
  }
  assert.doesNotMatch(SERVERS_SOURCE, /const FILTER_RULE_CREATE_SQL/);
  assert.doesNotMatch(SERVERS_SOURCE, /const FILTER_RULE_SELECT_SQL/);
  // The router's dispatch block is the forward, and the search arm (the
  // interloper between the alerts and kick arms) stays home.
  assert.match(SERVERS_SOURCE, /await handleServerModRoutes\(/,
    "the router hands the desk to the seam module");
  assert.match(SERVERS_SOURCE, /const searchMatch = method === "GET"/,
    "the search arm keeps its place in servers.mjs");
  assert.match(SERVERS_SOURCE, /handleSearchServerRoute\(/,
    "the search handler stays in servers.mjs");
  // The shared helpers stay ONE implementation in servers.mjs (the earlier
  // lanes' export contract), whatever the mod seam imports.
  for (const shared of [
    "export async function readActorContext",
    "export function moderationGuardSql",
    "export function isoTimestamp",
  ]) {
    assert.match(SERVERS_SOURCE, new RegExp(shared.replace("$", "\\$")),
      shared + " stays in servers.mjs");
  }
});

// The overlap enumeration: /members/:target appears in three families —
// the kick's DELETE /api/servers/:id/members/:target is the ONLY arm on that
// exact shape (the roles lane's assignment arm rides /roles/:rid/members/:uid,
// one segment deeper with a roles prefix; timeout's
// /members/:target/timeout carries the timeout segment; nothing on /bans,
// /prune, or /filter/* exists anywhere else).
test("no other family's path overlaps a mod desk path", () => {
  // No sibling seam module claims any mod-desk path segment.
  for (const siblingName of ["server-invites.mjs", "server-channels.mjs", "server-roles.mjs"]) {
    const sibling = readFileSync(join(HERE, "../api", siblingName), "utf8");
    for (const segment of ["/filter/", "/bans", "prune"]) {
      assert.ok(!sibling.includes(segment),
        siblingName + " must not answer a " + segment + " path");
    }
  }
  // And no mod-desk arm survives in servers.mjs (they all moved — the
  // remaining source must not carry any of the desk's literals).
  for (const literal of [
    "filterRulesMatch", "filterRuleItemMatch", "filterAlertsMatch",
    "kickMatch", "banMatch", "unbanMatch", "timeoutMatch", "pruneMatch",
  ]) {
    assert.doesNotMatch(SERVERS_SOURCE, new RegExp(literal),
      literal + " moved to the seam");
  }
  // The seam pins every arm it answers (nothing rides the fall-through by
  // accident — the arm regexes' escaped slashes are the source shape).
  for (const fragment of [
    "\\/filter\\/rules$", "\\/filter\\/rules\\/", "\\/filter\\/alerts$",
    "\\/members\\/(0", "/bans$", "/bans\\/", "/timeout$", "/prune$",
  ]) {
    assert.ok(SEAM_SOURCE.includes(fragment), "the seam answers " + fragment);
  }
});

// --- the smoke (the ban route through handleServerRoutes, same fixture
// contract as tests/mod-desk-module.test.mjs) ------------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const ACTOR_CONTEXT_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("AS position") &&
  sql.includes("FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?");
const BAN_INSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_server_bans (server_id, user_id, created_by, reason, created_at)") &&
  sql.includes("NOT EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)");

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

test("the seam walks the SAME wire through handleServerRoutes (the guarded ban INSERT runs)", async () => {
  // The ban's ONE batch: the guarded INSERT (the owner OR KICK bit arm and
  // the strictly-below position rule) rides INSIDE the statement, byte-
  // unchanged by the seam; the fan-out deletes ride the ban-exists rider.
  const runCalls = [];
  const batchCalls = [];
  const env = {
    GOOBER_DB: {
      async batch(statements) {
        batchCalls.push(statements.map((s) => s.sql));
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        Object.assign(statement, {
          first: async () => {
            if (SESSION_READ_TEST(sql)) return sessionRow;
            if (ACTOR_CONTEXT_TEST(sql)) {
              return { role: "member", nickname: null, permissions: 4, position: 5 };
            }
            if (sql.includes("SELECT reason, created_at FROM gc_server_bans")) {
              return null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            runCalls.push({ sql, bound: statement.bound });
            return { meta: { changes: 1, last_row_id: 1 } };
          },
        });
        return statement;
      },
    },
  };
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/3/bans", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ user_id: TARGET_ID }),
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 201);
  const batch = batchCalls[0];
  assert.ok(batch, "the whole ban is one batch");
  const insert = batch.find(BAN_INSERT_TEST);
  assert.ok(insert, "the ban rode the seam module's guarded INSERT under the same route");
  assert.match(insert, /EXISTS \(SELECT 1 FROM users bu WHERE bu\.id = \?\)/);
  assert.match(insert, /NOT EXISTS \(SELECT 1 FROM gc_server_bans/);
  assert.match(insert, /NOT EXISTS \(SELECT 1 FROM gc_server_members tb.*?tb\.role = 'owner'\)/,
    "the owner row is immune (byte-unchanged by the seam)");
  assert.match(insert, /gc_member_roles gbm4 JOIN gc_roles gbr4.*?\(gbr4\.permissions & 4\) <> 0/s,
    "the KICK bit arm rides the INSERT (byte-unchanged by the seam)");
  assert.match(
    insert,
    /JOIN gc_roles hr ON hr\.id = hmr\.role_id WHERE hmr\.server_id = \? AND hmr\.user_id = \?\) > \(SELECT COALESCE\(MAX\(hr\.position\), -1\)/,
    "the strictly-below position rule rides the INSERT (byte-unchanged by the seam)",
  );
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleServerModRoutes, "function");
});

test("the filter desk's read arm rides the seam too (one authed list through the forward)", async () => {
  const rulesRow = {
    id: 4, server_id: 3, name: "swears", terms: JSON.stringify([]),
    actions: JSON.stringify(["block"]), block_message: null, timeout_minutes: null,
    exempt_role_ids: "[]", exempt_channel_ids: "[]",
    is_care: 0, check_names: 0, created_by: 7,
    created_at: nowSeconds() - 60, updated_at: nowSeconds() - 60,
  };
  const env = {
    GOOBER_DB: {
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        Object.assign(statement, {
          first: async () => {
            if (SESSION_READ_TEST(sql)) return sessionRow;
            if (ACTOR_CONTEXT_TEST(sql)) {
              return { role: "member", nickname: null, permissions: 4, position: 5 };
            }
            return null;
          },
          all: async () => ({ results: [rulesRow] }),
        });
        return statement;
      },
    },
  };
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/3/filter/rules", {
      method: "GET",
      headers: {
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
        Origin: ORIGIN,
      },
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].id, 4);
  assert.equal(body.rules[0].name, "swears");
});
