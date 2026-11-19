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

// T93 emoji slot ladder — the ROUTE-level pins (the resolver's own caps are
// unit-pinned in tests/boost-level.test.mjs; this file pins the SEAM the
// emoji create gate rides). Idiom: the sibling fakeDb conventions
// (tests/emoji-sticker.test.mjs) — every guard arm is ENCODED in the fake so
// a GREEN implementation that loses the boost read fails here. The totals-only
// ruling rides these pins too: gc_emoji carries NO animated/static split
// (totals-only until a receipt pins Discord's per-level animated-slot shape),
// so the create columns and the payload row must expose NO such key.
import test from "node:test";
import assert from "node:assert/strict";

import { handleExpressionRoutes } from "../api/emoji.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_BOOST_LEVELS,
  GC_EMOJI_MAX_PER_SERVER,
  GC_SOUNDBOARD_MAX_PER_SERVER,
  GC_STICKER_MAX_PER_SERVER,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const ATTACHMENT_ID = 9;

// --- scaffolding (the siblings' fake conventions) --------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const BOOST_READ_TEST = (sql) => sql.includes("SELECT boosts FROM gc_servers");
const MEMBERSHIP_TEST = (sql) => sql.includes("SELECT 1 AS member FROM gc_server_members");
const MANAGE_BIT = 1 << 11;

async function session() {
  const token = randomToken();
  const csrf = randomToken(24);
  return {
    row: {
      token_hash: await sha256Hex(token),
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
    },
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const SESSION_FIX = session();

function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        if (route === undefined) return { meta: { changes: 1 } };
        return await route.run(statement.bound);
      };
      return statement;
    },
  };
  return db;
}

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
    response = await handleExpressionRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "MISSING ROUTE" }), { status: 404 });
}

// The create route's chain: session read, manage guard (role read + merged
// mask), the resolver's ONE boost read, the guarded INSERT, the created-row
// re-read. `boosts` IS the lane's knob — the fake answers the resolver's
// SELECT boosts probe with exactly that.
function createRoutes({ boosts = 0 } = {}) {
  const row = {
    id: 4, server_id: SERVER_ID, name: "partyparrot",
    attachment_id: ATTACHMENT_ID, created_at: 900,
  };
  return [
    { test: (sql) => sql.startsWith("INSERT INTO gc_emoji"), run: async () => ({ meta: { changes: 1 } }) },
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: (sql) => sql.includes("SELECT role FROM gc_server_members"), first: async () => ({ role: "member" }) },
    { test: (sql) => sql.includes("GROUP_CONCAT(ar.permissions)"), first: async () => ({ permissions: MANAGE_BIT }) },
    { test: BOOST_READ_TEST, first: async () => ({ boosts }) },
    {
      test: (sql) => sql.includes("WHERE server_id = ? AND name = ? ORDER BY id DESC"),
      first: async () => row,
    },
  ];
}

async function createEmoji(routes) {
  const { headers } = await SESSION_FIX;
  const db = fakeDb(routes);
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "partyparrot", attachmentId: ATTACHMENT_ID }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  return { response, db };
}

// --- pins ------------------------------------------------------------------------

test("the owner matrix's ladder constants: L0 base 50, floors 2/7/14, emoji 100/150/250", () => {
  assert.equal(GC_EMOJI_MAX_PER_SERVER, 50, "the level-0 base is the owner's corrected 50");
  assert.equal(GC_STICKER_MAX_PER_SERVER, 5);
  assert.equal(GC_SOUNDBOARD_MAX_PER_SERVER, 8);
  // The caps the lane wires ride GC_BOOST_LEVELS verbatim — the resolver's
  // max-of-base-and-level shape lifts them; this pin catches any silent edit.
  assert.deepEqual(
    GC_BOOST_LEVELS.map((entry) => [entry.boosts, entry.emoji]),
    [[2, 100], [7, 150], [14, 250]],
    "the emoji blessings ride the L1/L2/L3 rows in the owner's matrix",
  );
});

test("the emoji CREATE gate answers the LEVEL's cap: 2 boosts insert-arms < 100", async () => {
  const { response, db } = await createEmoji(createRoutes({ boosts: 2 }));
  assert.equal(response.status, 201, "an L1 server inventories 100");
  const insert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_emoji"));
  assert.ok(insert, "the guarded INSERT ran");
  assert.match(
    insert.sql,
    /\(SELECT COUNT\(\*\) FROM gc_emoji WHERE server_id = \?\) < 100$/,
    "the create statement carries the L1 blessing, not the base 50",
  );
});

test("the emoji CREATE gate at L3 arms < 250 — and a tier-blind chain falls back to the base 50", async () => {
  const l3 = await createEmoji(createRoutes({ boosts: 14 }));
  assert.equal(l3.response.status, 201, "an L3 server inventories 250");
  const l3Insert = l3.db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_emoji"));
  assert.match(l3Insert.sql, /< 250$/, "the L3 blessing rides the create statement");

  // The NEGATIVE control: the same harness with the boost probe unanswered
  // (a null first IS the real miss) — the gate must arm the BASE cap, which
  // is exactly how a dropped/lapsed level reads. This is the pin's RED
  // evidence against a tier-blind gate: swap the resolver's read for a miss
  // and the armed number changes from the level's blessing to the base.
  const l0 = await createEmoji(createRoutes().filter((route) => !route.test("SELECT boosts FROM gc_servers")));
  assert.equal(l0.response.status, 201);
  const l0Insert = l0.db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_emoji"));
  assert.match(
    l0Insert.sql,
    new RegExp("< " + GC_EMOJI_MAX_PER_SERVER + "$"),
    "a level-0 (missed) probe arms the base 50",
  );
});

test("the list caps payload answers the LEVEL's effective numbers (L2), rows ride UNCAPPED", async () => {
  const rows = [];
  for (let i = 0; i < 160; i += 1) {
    rows.push({
      id: i + 1, server_id: SERVER_ID, name: "parrot" + i,
      attachment_id: ATTACHMENT_ID, created_at: 900,
    });
  }
  const { headers } = await SESSION_FIX;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: BOOST_READ_TEST, first: async () => ({ boosts: 7 }) },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_emoji"),
      all: async () => ({ results: rows }),
    },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_stickers"),
      all: async () => ({ results: [] }),
    },
  ]);
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", { method: "GET", headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.caps, { emoji: 150, stickers: 30, sounds: 36 }, "the L2 effective caps ride the payload");
  // Disabled-not-deleted at the route level: a legacy inventory OVER the
  // level's cap (and over the base) is READ COMPLETE — never trimmed, never
  // deleted; every token must still resolve.
  assert.equal(body.emojis.length, 160, "an over-cap legacy inventory lists whole");
});

test("totals-only ruling pin: the create columns and the payload row carry NO animated/static split", async () => {
  const { response, db } = await createEmoji(createRoutes({ boosts: 2 }));
  assert.equal(response.status, 201);
  const insert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_emoji"));
  assert.match(
    insert.sql,
    /INSERT INTO gc_emoji \(server_id, name, attachment_id, created_by, created_at\)/,
    "the create stays the five-column shape — no animated column until a receipt rules the split",
  );
  const body = await response.json();
  assert.deepEqual(
    Object.keys(body.emoji).sort(),
    ["createdAt", "id", "name", "serverId", "url"],
    "the payload row exposes the totals shape only",
  );
});
