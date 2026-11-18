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

// T96 server-wide upload boost — the ROUTE-level pins (the ladder's numbers
// ride constants.mjs GC_BOOST_LEVELS uploadBytes exactly as shipped; this
// file pins the SEAM the send-with-image intake rides, the one attachment
// intake that knows its DESTINATION). Idiom: the sibling fakeDb conventions
// (tests/emoji-ladder.test.mjs, tests/uploads-lane.test.mjs). The law under
// test: a server boost level's upload blessing merges GREEDIER-of into the
// enforced seat — a level never lowers a cap, and a DM/group channel (no
// server row) keeps the account-tier seat the route has always enforced,
// byte-for-byte, with no gc_servers read at all. Wave-7 (T-AUD-H1): the
// buffered lane clamps the lifted frame at GC_BUFFERED_FRAME_CEILING (25 MiB —
// the multipart parse buffers the whole body inside the isolate), so L2/L3
// answer the ceiling on this route; the tier raises ride the staged lane.
import test from "node:test";
import assert from "node:assert/strict";

import { handleMessageRoutes } from "../api/messages.mjs";
import { serverUploadBytesCap, greedierUploadFileBytes } from "../api/boost-level.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  GC_BOOST_LEVELS,
  GC_BUFFERED_FRAME_CEILING,
  MAX_ATTACHMENT_BYTES,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const CHANNEL_ID = 11;

const MIB = 1024 * 1024;

// The frame refusal's filed copy shape (media.mjs tooLargeError): "Images
// must be N MiB or smaller."
const tooLargeCopy = (miB) => "Images must be " + miB + " MiB or smaller.";
const UNREADABLE_COPY =
  "That image could not be read. Try re-saving it and uploading again.";

// --- scaffolding (the siblings' fake conventions) --------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("SELECT c.id, c.server_id, c.kind FROM gc_channels c");
const LAYER_MEMBER_TEST = (sql) =>
  sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?");
const LAYER_ROLE_ROWS_TEST = (sql) => sql.includes("JOIN gc_roles r ON r.id = gmr.role_id");
const LAYER_CHAIN_TEST = (sql) => sql.includes("FROM gc_channel_overwrites o");
const PLUS_TIER_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const BOOST_READ_TEST = (sql) => sql.includes("SELECT boosts FROM gc_servers");

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

// The ordered fake D1, first-matching-route answers (tests/uploads-lane.test.mjs).
function fakeDb(routes = []) {
  const calls = [];
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
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
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
    response = await handleMessageRoutes(request, env, url, url.pathname, "POST", {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "MISSING ROUTE" }), { status: 404 });
}

// The lane's body: one text field + one `image` file field of the given bytes.
function imageForm(bytes) {
  const form = new FormData();
  form.append("body", "hello");
  form.append("image", new Blob([bytes]), "big.png");
  return form;
}

// A PNG-headered buffer whose inner bytes are garbage: the frame's cap check
// (value.size) runs BEFORE any sniffing, so a refusal pin reads the FRAME's
// number, and a frame-passing pin surfaces the intake's 400 (the vendor
// sanitizer refuses the garbage body) — the two outcomes are the seam's
// either/or and never collide.
function oversizedProbe(bytes) {
  const probe = new Uint8Array(bytes);
  probe.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return probe;
}

// The send-with-image route's chain down to the frame: session read, the
// channel access read, the graceful-default layer reads, the member's tier
// pair, and — for a server channel — exactly ONE boost read. `boosts` and
// `tier` are the lane's knobs.
function sendImageRoutes({ serverId = SERVER_ID, boosts = 0, tier = null } = {}) {
  return [
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: PLUS_TIER_TEST, first: async () => tier },
    { test: BOOST_READ_TEST, first: async () => ({ boosts }) },
    {
      test: CHANNEL_ACCESS_TEST,
      first: async () => ({ id: CHANNEL_ID, server_id: serverId, kind: serverId === null ? "dm" : "text" }),
    },
    { test: LAYER_MEMBER_TEST, first: async () => ({ role: "member" }) },
    { test: LAYER_ROLE_ROWS_TEST, all: async () => ({ results: [] }) },
    { test: LAYER_CHAIN_TEST, all: async () => ({ results: [] }) },
  ];
}

async function sendImage(routes, bytes, declaredLength = null) {
  const { headers } = await SESSION_FIX;
  const db = fakeDb(routes);
  // A DECLARED Content-Length (undici rides one through) is the framing the
  // intake's pre-buffer refusal keys on (media.mjs declaredLength branch) —
  // probes over the frame's request ceiling must declare, or the counted
  // chunked buffering refuses first and the harness reads the generic copy.
  const declared =
    declaredLength === null ? headers : { ...headers, "Content-Length": String(declaredLength) };
  const response = await dispatch(
    new Request(ORIGIN + "/api/channels/" + CHANNEL_ID + "/messages", {
      method: "POST",
      headers: { ...declared, Origin: ORIGIN },
      body: imageForm(bytes),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  return { response, body: await response.text(), db };
}

// --- pins -------------------------------------------------------------------------

test("the owner matrix's upload ladder rides GC_BOOST_LEVELS verbatim: L1 10 MiB, L2 50 MiB, L3 100 MiB", () => {
  // constants.mjs GC_BOOST_LEVELS uploadBytes (the owner's blessed Nov 16
  // 2026 matrix — the slate T96 row's numbers, byte-for-byte). This pin
  // catches any silent edit of the ladder bytes.
  assert.deepEqual(
    GC_BOOST_LEVELS.map((entry) => [entry.boosts, entry.uploadBytes]),
    [[2, 10 * MIB], [7, 50 * MIB], [14, 100 * MIB]],
  );
});

test("the resolver exposes the level's upload blessing through the ONE shared read", async () => {
  // The ladder's floors: below 2 boosts is level 0 = NO blessing (0 — the
  // merge's identity), 2/7/14 answer the level rows.
  for (const [boosts, expected] of [[0, 0], [2, 10 * MIB], [7, 50 * MIB], [14, 100 * MIB]]) {
    const db = fakeDb([{ test: BOOST_READ_TEST, first: async () => ({ boosts }) }]);
    const cap = await serverUploadBytesCap({ GOOBER_DB: db }, SERVER_ID);
    assert.equal(cap, expected, "boosts " + boosts);
  }
  // A MISSED probe (a null first is the real miss) answers 0 — a lapsed
  // recount lifts nothing.
  const missed = fakeDb([]);
  assert.equal(await serverUploadBytesCap({ GOOBER_DB: missed }, SERVER_ID), 0);
});

test("a DM/group channel NEVER reads the ladder: null serverId answers 0 without a gc_servers read", async () => {
  const db = fakeDb([{ test: BOOST_READ_TEST, first: async () => ({ boosts: 14 }) }]);
  assert.equal(await serverUploadBytesCap(db, null), 0);
  assert.equal(await serverUploadBytesCap(db, undefined), 0);
  assert.deepEqual(
    db.calls.filter((call) => call.sql.includes("SELECT boosts FROM gc_servers")),
    [],
    "a destination-less seat stays free — the account tier governs DMs",
  );
});

test("the GREEDIER-of merge: a level never lowers a cap, and 0 is the identity", () => {
  assert.equal(greedierUploadFileBytes(20 * MIB, 0), 20 * MIB, "level 0 / DM: the account seat unchanged");
  assert.equal(greedierUploadFileBytes(20 * MIB, 10 * MIB), 20 * MIB, "L1 under the free pair lifts nothing");
  assert.equal(greedierUploadFileBytes(50 * MIB, 100 * MIB), 100 * MIB, "the blessing can lift a lighter tier");
  assert.equal(
    greedierUploadFileBytes(1024 * MIB, 100 * MIB),
    1024 * MIB,
    "the merge is maximization — a level can never LOWER a cap",
  );
});

test("the L1 blessing is UNDER the free pair — the greedy merge lifts nothing (20 MiB + 1 still refuses)", async () => {
  const { response, body } = await sendImage(sendImageRoutes({ boosts: 2 }), oversizedProbe(20 * MIB + 1));
  assert.equal(response.status, 413, "a level never lowers: L1's 10 MiB blessing stays under the free 20 MiB seat");
  assert.ok(body.includes(tooLargeCopy(20)), "the frame is the free pair, never the lower blessing: " + body);
});

test("the frame LIFTS past the free 20 MiB pair inside an L2 server (a free member rides 50 MiB)", async () => {
  // The tier here is NULL (free): 20 MiB + 1 is over EVERY account-free
  // bound, so the probe's survival of the frame IS the boost wiring — it
  // reaches the intake's own 400 (garbage body) and never the frame's 413.
  const { response, body } = await sendImage(sendImageRoutes({ boosts: 7 }), oversizedProbe(20 * MIB + 1));
  assert.equal(response.status, 400, "past the L2 frame, the garbage body loses at the sanitizer");
  assert.ok(body.includes(UNREADABLE_COPY), "the survival reads the intake 400: " + body);
});

test("the L3 arm CLAMPS on the buffered lane: 100 MiB + 1 refuses 25 MiB-sized", async () => {
  // The buffered intake buffers the whole body (media.mjs readMultipartWithImage),
  // so the frame answers GC_BUFFERED_FRAME_CEILING — the blessing's 100 MiB arm
  // rides the staged large-file lane instead (the tier raise's seat).
  const { response, body } = await sendImage(
    sendImageRoutes({ boosts: 14 }),
    oversizedProbe(100 * MIB + 1),
    100 * MIB + 1,
  );
  assert.equal(response.status, 413);
  assert.ok(body.includes(tooLargeCopy(25)), "the refusal names the clamped frame: " + body);
});

test("a level-0 server changes nothing: 10 MiB + 1 is under the untouched free frame", async () => {
  const { response, body } = await sendImage(sendImageRoutes({ boosts: 0 }), oversizedProbe(10 * MIB + 1));
  assert.equal(response.status, 400, "the probe sails past the free 20 MiB frame to the sanitizer");
  assert.ok(body.includes(UNREADABLE_COPY), "the non-raise reads the intake 400: " + body);
});

test("a DM/group channel keeps the account frame byte-for-byte — and reads the ladder ZERO times", async () => {
  // Over the untouched 20 MiB pair: the frame refuses exactly as it always
  // has, no matter what the member's other servers look like.
  const refused = await sendImage(sendImageRoutes({ serverId: null, boosts: 14 }), oversizedProbe(20 * MIB + 1));
  assert.equal(refused.response.status, 413, "the DM frame never rides a boost");
  assert.ok(refused.body.includes(tooLargeCopy(20)), "the DM refusal is the DEFAULT pair: " + refused.body);
  assert.deepEqual(
    refused.db.calls.filter((call) => call.sql.includes("SELECT boosts FROM gc_servers")),
    [],
    "a DM send consults the ladder NEVER",
  );

  // And UNDER it, 10 MiB + 1 sails through (no lift, no refusal): the DM's
  // enforced seat is the accounted default pair, unchanged.
  const passed = await sendImage(sendImageRoutes({ serverId: null, boosts: 14 }), oversizedProbe(10 * MIB + 1));
  assert.equal(passed.response.status, 400, "the probe survives the DM frame to the sanitizer");
  assert.ok(passed.body.includes(UNREADABLE_COPY));

  assert.deepEqual(
    passed.db.calls.filter((call) => call.sql.includes("SELECT boosts FROM gc_servers")),
    [],
    "a DM send consults the ladder NEVER",
  );
  assert.ok(
    passed.db.calls.every((call) => !call.sql.includes("SELECT boosts FROM gc_servers")),
    "every DM-arm read is ladder-blind",
  );
});

test("the L2 arm clamps on the buffered lane, and the shared read stays ONE per send", async () => {
  const { response, body, db } = await sendImage(
    sendImageRoutes({ boosts: 7 }),
    oversizedProbe(50 * MIB + 1),
    50 * MIB + 1,
  );
  assert.equal(response.status, 413);
  assert.ok(body.includes(tooLargeCopy(25)), "the 50 MiB blessing clamps to the buffered ceiling: " + body);
  assert.equal(
    db.calls.filter((call) => call.sql.includes("SELECT boosts FROM gc_servers")).length,
    1,
    "ONE boost read answers the seat (the shared resolver's single-lookup law)",
  );
});

test("the route's frame constants: the MAX_ATTACHMENT_BYTES pair stays the free seat the merge maximizes from", () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 20_971_520, "the free pair the DM arm keeps byte-for-byte");
  assert.equal(
    GC_BUFFERED_FRAME_CEILING,
    25 * 1024 * 1024,
    "the buffered lane's memory-safe ceiling rides constants.mjs (the clamped frame's number)",
  );
});

test("the buffered ceiling is the BINDING frame: 25 MiB + 1 refuses on its number, 25 MiB - 1 passes", async () => {
  // L2's blessing (50 MiB) lifts the frame, the ceiling clamps it back to
  // exactly 25 MiB — the boundary answers ON the ceiling's number (the probe
  // sits under the ceiling's request bound, so the frame itself renders the
  // copy, not the pre-buffer declared-length refusal).
  const clamped = await sendImage(sendImageRoutes({ boosts: 7 }), oversizedProbe(25 * MIB + 1));
  assert.equal(clamped.response.status, 413, "the ceiling binds inside a blessing");
  assert.ok(clamped.body.includes(tooLargeCopy(25)), "the 413 names the ceiling: " + clamped.body);

  // One byte under sails the clamped frame to the sanitizer — the ceiling is
  // never LOWER than its number (the blessing still lifts free's 20 MiB arm).
  const under = await sendImage(sendImageRoutes({ boosts: 7 }), oversizedProbe(25 * MIB - 1));
  assert.equal(under.response.status, 400, "the probe survives the clamped frame to the sanitizer");
  assert.ok(under.body.includes(UNREADABLE_COPY));

  // The FREE arm is unchanged on its own number: outside a server blessing, the
  // frame is still 20 MiB even for a body the ceiling would admit.
  const freeArm = await sendImage(sendImageRoutes({ boosts: 0 }), oversizedProbe(25 * MIB + 1), 25 * MIB + 1);
  assert.equal(freeArm.response.status, 413, "no blessing, no lift: the free frame stands at 20 MiB");
  assert.ok(freeArm.body.includes(tooLargeCopy(20)), "the free arm keeps its own number: " + freeArm.body);
});

test("auth-before-body (T96's reorder): a body to a channel the member cannot address refuses before any read", async () => {
  // The channel access read is the ONLY answered gate — the 404 lands before
  // the multipart parse, so even an over-every-frame body cannot buy a parse.
  const { response } = await sendImage(
    [{ test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row }],
    oversizedProbe(20 * MIB + 1),
  );
  assert.equal(response.status, 404, "the channel vanishes before the body is touched");
});
