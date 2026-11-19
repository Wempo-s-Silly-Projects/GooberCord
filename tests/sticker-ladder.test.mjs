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

// T94 sticker slot ladder — the ROUTE-level pins, mirroring the sibling
// tests/emoji-ladder.test.mjs shape. The sticker create path rides the ONE
// kind-parameterized gate at api/emoji.mjs, so this file pins the SEAM from
// the sticker side: the create statement arms the LEVEL's blessing
// (15/30/60), an unanswered boost probe arms the base 5, the list payload
// answers the level's effective numbers with rows riding UNCAPPED
// (disabled-not-deleted: an over-cap legacy inventory is listed whole, only
// new creates blocked), and a full-inventory create is refused with the cap
// copy. Idiom: the sibling fakeDb conventions (tests/emoji-sticker.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { handleExpressionRoutes } from "../api/emoji.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_BOOST_LEVELS,
  GC_EMOJI_MAX_PER_SERVER,
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

// The sticker create route's chain: session read, manage guard (role read +
// merged mask), the resolver's ONE boost read, the guarded INSERT, the
// created-row re-read. `boosts` IS the lane's knob. `insertChanges` + the
// state/authority routes turn the harness into a full inventory for the
// over-cap classification pin.
function createRoutes({ boosts = 0, insertChanges = 1, stickerCount = 0 } = {}) {
  const row = {
    id: 4, server_id: SERVER_ID, name: "wumpus",
    attachment_id: ATTACHMENT_ID, created_at: 900,
  };
  return [
    { test: (sql) => sql.startsWith("INSERT INTO gc_stickers"), run: async () => ({ meta: { changes: insertChanges } }) },
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: (sql) => sql.includes("SELECT role FROM gc_server_members"), first: async () => ({ role: "member" }) },
    { test: (sql) => sql.includes("GROUP_CONCAT(ar.permissions)"), first: async () => ({ permissions: MANAGE_BIT }) },
    { test: (sql) => sql.includes("ownAttachment"), first: async () => ({ ownAttachment: 1, size: 1, messageId: null, emojiUsed: 0, stickersUsed: 0, soundsUsed: 0, count: stickerCount }) },
    { test: BOOST_READ_TEST, first: async () => ({ boosts }) },
    {
      test: (sql) => sql.includes("WHERE server_id = ? AND name = ? ORDER BY id DESC"),
      first: async () => row,
    },
  ];
}

async function createSticker(routes) {
  const { headers } = await SESSION_FIX;
  const db = fakeDb(routes);
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/stickers", {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "wumpus", attachmentId: ATTACHMENT_ID }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  return { response, db };
}

// --- pins ------------------------------------------------------------------------

test("the owner matrix's sticker ladder constants: base 5, blessings 15/30/60", () => {
  assert.equal(GC_STICKER_MAX_PER_SERVER, 5, "the level-0 base is the 0025 parity-pass correction");
  assert.equal(GC_EMOJI_MAX_PER_SERVER, 50);
  // The blessings ride GC_BOOST_LEVELS verbatim the way the emoji pins do.
  assert.deepEqual(
    GC_BOOST_LEVELS.map((entry) => [entry.boosts, entry.stickers]),
    [[2, 15], [7, 30], [14, 60]],
    "the sticker blessings ride the L1/L2/L3 rows in the owner's matrix",
  );
});

test("the sticker CREATE gate answers the LEVEL's cap: 2 boosts arms < 15, 14 arms < 60", async () => {
  const l1 = await createSticker(createRoutes({ boosts: 2 }));
  assert.equal(l1.response.status, 201, "an L1 server inventories 15 stickers");
  const l1Insert = l1.db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_stickers"));
  assert.ok(l1Insert, "the guarded INSERT ran");
  assert.match(
    l1Insert.sql,
    /\(SELECT COUNT\(\*\) FROM gc_stickers WHERE server_id = \?\) < 15$/,
    "the create statement carries the L1 blessing, not the base 5",
  );

  const l3 = await createSticker(createRoutes({ boosts: 14 }));
  assert.equal(l3.response.status, 201, "an L3 server inventories 60 stickers");
  const l3Insert = l3.db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_stickers"));
  assert.match(l3Insert.sql, /< 60$/, "the L3 blessing rides the create statement");
});

test("an unanswered boost probe arms the BASE 5 — the tier-blind gate's RED control", async () => {
  const { response, db } = await createSticker(
    createRoutes().filter((route) => !route.test("SELECT boosts FROM gc_servers")),
  );
  assert.equal(response.status, 201);
  const insert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_stickers"));
  assert.match(
    insert.sql,
    new RegExp("< " + GC_STICKER_MAX_PER_SERVER + "$"),
    "a level-0 (missed) probe arms the base 5",
  );
});

test("a full inventory blocks only the NEW create — 400 with the cap copy, rows stay", async () => {
  const { response } = await createSticker(createRoutes({ boosts: 0, insertChanges: 0, stickerCount: 5 }));
  assert.equal(response.status, 400, "an at-cap server refuses the new sticker");
  const body = await response.json();
  assert.match(
    body.error || body.message || JSON.stringify(body),
    /5 sticker/,
    "the refuse copy names the effective cap (the base 5 at level 0)",
  );
});

test("the sticker list caps payload answers the LEVEL's effective numbers (L2), rows ride UNCAPPED", async () => {
  const rows = [];
  for (let i = 0; i < 70; i += 1) {
    rows.push({
      id: i + 1, server_id: SERVER_ID, name: "wumpus" + i,
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
      all: async () => ({ results: [] }),
    },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_stickers"),
      all: async () => ({ results: rows }),
    },
  ]);
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/stickers", { method: "GET", headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.caps, { emoji: 150, stickers: 30, sounds: 36 }, "the L2 effective caps ride the payload");
  // Disabled-not-deleted at the route level: a legacy sticker inventory OVER
  // its level's cap (and over the base 5) is READ COMPLETE — never trimmed,
  // never deleted; every <s:name:id> token must still resolve.
  assert.equal(body.stickers.length, 70, "an over-cap legacy inventory lists whole");
});
