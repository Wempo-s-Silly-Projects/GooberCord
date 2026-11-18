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

// T95 soundboard slot ladder — the ROUTE-level pins, mirroring the sibling
// tests/sticker-ladder.test.mjs shape. The soundboard create path rides its
// OWN dispatch (api/soundboard.mjs's handleSoundboardRoutes — NOT the emoji
// lane's kind gate) but the ONE shared resolver (api/boost-level.mjs): the
// create's cap is `(await serverBoostTier(env, serverId)).caps.soundboard`
// and rides the INSERT itself, so this file pins the SEAM from the soundboard
// side: the create statement arms the LEVEL's blessing (24/36/48), an
// unanswered boost probe arms the base 8, the list payload answers the
// level's effective sounds number with rows riding UNCAPPED (a legacy
// inventory over a SMALLER cap is listed whole, only new creates blocked),
// and a full-inventory create is refused with the cap copy. Idiom: the
// siblings' fakeDb conventions (tests/soundboard-lane.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { handleSoundboardRoutes } from "../api/soundboard.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_BOOST_LEVELS,
  GC_SOUNDBOARD_MAX_PER_SERVER,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const SOUND_ATTACHMENT_ID = 9;

// --- scaffolding (the siblings' fake conventions) --------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const BOOST_READ_TEST = (sql) => sql.includes("SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1");
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
    headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
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

async function dispatchBoard(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleSoundboardRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "MISSING ROUTE" }), { status: 404 });
}

// The JSON create route's chain: session read, write rate limit, the name/id
// JSON validation, the resolver's ONE boost read, the guarded INSERT, the
// created-row re-read. `boosts` IS the lane's knob. `insertChanges` + the
// classifier's state route turn the harness into a full inventory for the
// over-cap classification pin.
function createRoutes({ boosts = 0, insertChanges = 1, soundCount = 0 } = {}) {
  const row = {
    id: 4, server_id: SERVER_ID, name: "dropthebass",
    attachment_id: SOUND_ATTACHMENT_ID, created_at: 900,
  };
  return [
    { test: (sql) => sql.startsWith("INSERT INTO gc_sounds"), run: async () => ({ meta: { changes: insertChanges } }) },
    { test: (sql) => sql.includes("SELECT mime FROM gc_attachments WHERE id = ? AND uploader_id = ?"), first: async () => ({ mime: "audio/mpeg" }) },
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: (sql) => sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1"), first: async () => ({ role: "member" }) },
    { test: (sql) => sql.includes("GROUP_CONCAT(ar.permissions)"), first: async () => ({ permissions: MANAGE_BIT }) },
    {
      test: (sql) => sql.includes("SELECT EXISTS (SELECT 1 FROM gc_attachments a") && sql.includes("soundsUsed"),
      first: async () => ({ ownAttachment: 1, size: 1, messageId: null, soundsUsed: 0, emojiUsed: 0, stickersUsed: 0, count: soundCount }),
    },
    { test: BOOST_READ_TEST, first: async () => ({ boosts }) },
    {
      test: (sql) => sql.includes("WHERE server_id = ? AND name = ? ORDER BY id DESC"),
      first: async () => row,
    },
  ];
}

async function createSound(routes) {
  const { headers } = await SESSION_FIX;
  const db = fakeDb(routes);
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  return { response, db };
}

// --- pins ------------------------------------------------------------------------

test("the owner matrix's soundboard ladder constants: base 8, blessings 24/36/48", () => {
  assert.equal(GC_SOUNDBOARD_MAX_PER_SERVER, 8, "the level-0 base is Discord's REAL 8");
  // The blessings ride GC_BOOST_LEVELS verbatim the way the emoji/sticker pins do.
  assert.deepEqual(
    GC_BOOST_LEVELS.map((entry) => [entry.boosts, entry.soundboard]),
    [[2, 24], [7, 36], [14, 48]],
    "the soundboard blessings ride the L1/L2/L3 rows in the owner's matrix",
  );
});

test("the soundboard CREATE gate answers the LEVEL's cap: 2 boosts arms < 24, 14 arms < 48", async () => {
  const l1 = await createSound(createRoutes({ boosts: 2 }));
  assert.equal(l1.response.status, 201, "an L1 server inventories 24 sounds");
  const l1Insert = l1.db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_sounds"));
  assert.ok(l1Insert, "the guarded INSERT ran");
  assert.match(
    l1Insert.sql,
    /\(SELECT COUNT\(\*\) FROM gc_sounds WHERE server_id = \?\) < 24$/,
    "the create statement carries the L1 blessing, not the base 8",
  );

  const l3 = await createSound(createRoutes({ boosts: 14 }));
  assert.equal(l3.response.status, 201, "an L3 server inventories 48 sounds");
  const l3Insert = l3.db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_sounds"));
  assert.match(l3Insert.sql, /< 48$/, "the L3 blessing rides the create statement");
});

test("an unanswered boost probe arms the BASE 8 — the tier-blind gate's RED control", async () => {
  const { response, db } = await createSound(
    createRoutes().filter((route) => !route.test("SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1")),
  );
  assert.equal(response.status, 201);
  const insert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_sounds"));
  assert.match(
    insert.sql,
    new RegExp("< " + GC_SOUNDBOARD_MAX_PER_SERVER + "$"),
    "a level-0 (missed) probe arms the base 8",
  );
});

test("a full inventory blocks only the NEW create — 400 with the cap copy, rows stay", async () => {
  const { response } = await createSound(createRoutes({ boosts: 0, insertChanges: 0, soundCount: GC_SOUNDBOARD_MAX_PER_SERVER }));
  assert.equal(response.status, 400, "an at-cap server refuses the new sound");
  const body = await response.json();
  assert.match(
    body.error || body.message || JSON.stringify(body),
    new RegExp("already has " + GC_SOUNDBOARD_MAX_PER_SERVER + " sounds"),
    "the refuse copy names the effective cap (the base 8 at level 0)",
  );
});

test("the soundboard list payload answers the LEVEL's effective sounds cap (L2), rows ride UNCAPPED", async () => {
  const rows = [];
  for (let i = 0; i < 50; i += 1) {
    rows.push({
      id: i + 1, server_id: SERVER_ID, name: "sound" + i,
      attachment_id: SOUND_ATTACHMENT_ID, created_at: 900,
    });
  }
  const { headers } = await SESSION_FIX;
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: BOOST_READ_TEST, first: async () => ({ boosts: 7 }) },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_sounds"),
      all: async () => ({ results: rows }),
    },
  ]);
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", { method: "GET", headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.caps, { emoji: 150, stickers: 30, sounds: 36 }, "the L2 effective caps ride the payload");
  // Disabled-not-deleted at the route level: a legacy sound inventory OVER its
  // level's cap (and over the base 8) is READ COMPLETE — never trimmed, never
  // deleted; every tile and future token must still resolve.
  assert.equal(body.sounds.length, 50, "an over-cap legacy inventory lists whole");
});
