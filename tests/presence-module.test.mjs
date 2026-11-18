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

// PresenceHub DO + custom status (Phase 1, Task 9): the hub is an in-memory
// DO at the pinned name "hub" whose frames ride stub fetches ({"type":
// "connect"|"heartbeat"|"leave"|"list"}), never a D1 write — plus the two REST
// routes (GET /api/presence, PATCH /api/me/status). Same fake conventions as
// rooms-relay.test.mjs: a fake ctx/env, fake sockets for the ChatRoom relay
// plumbing, and fakeDb statements routed by SQL text with real token fixtures.
import test from "node:test";
import assert from "node:assert/strict";

import { PresenceHub } from "../api/presence.mjs";
import { handlePresenceRoutes } from "../api/presence.mjs";
import { ChatRoom } from "../api/rooms.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const MEMBER_ID = 7;

// --- fake hub state --------------------------------------------------------------
// The one workerd-only call PresenceHub makes at construction. Recording it
// keeps the hibernation-native pin observable under node --test.

// A fake room ctx for the ChatRoom relay plumbing, identical to the
// rooms-relay fake.
function fakeCtx() {
  const accepted = [];
  return {
    accepted,
    acceptWebSocket(ws) {
      accepted.push(ws);
    },
    getWebSockets() {
      return accepted.slice();
    },
    webSocketClosed(ws) {
      const index = accepted.indexOf(ws);
      if (index >= 0) accepted.splice(index, 1);
    },
  };
}

function fakeServerSocket() {
  return {
    sent: [],
    send(frame) {
      this.sent.push(frame);
    },
    serializeAttachment(value) {
      this.attachment = value;
    },
    deserializeAttachment() {
      if (this.attachment === undefined) {
        throw new Error("No socket attachment.");
      }
      return this.attachment;
    },
    close() {
      this.closed = true;
    },
  };
}

function makeRoom(env) {
  const ctx = fakeCtx();
  return { room: new ChatRoom(ctx, env), ctx };
}

async function connect(room, ctx, query) {
  const request = new Request(
    `https://chat.internal/api/ws?channel=3&userId=${query.userId}` +
      `&username=${encodeURIComponent(query.username)}&channelKind=${query.channelKind}`,
    { headers: { Upgrade: "websocket" } },
  );
  const response = await room.fetch(request);
  assert.equal(response.status, 101);
  return ctx.accepted[ctx.accepted.length - 1];
}

function sentFrames(socket) {
  return socket.sent.map((frame) => JSON.parse(frame));
}
function clearFrames(socket) {
  socket.sent.length = 0;
}

// --- fake DO env for the REST routes ---------------------------------------------

// The fake hub env PRESENCE: idFromName("hub") recorded, stub fetches record
// their received frame and answer with a presence payload. Both arrays are
// caller-provided (ChatRoom relay tests watch `frames`; REST tests shape
// `online`), so a push and an assertion can never land on different arrays.
function fakePresenceBinding({ frames = [], online = [] } = {}) {
  return {
    frames,
    names: [],
    idFromName(name) {
      this.names.push(name);
      return { name };
    },
    get(stubId) {
      return {
        fetch: async (request) => {
          frames.push(JSON.parse(await request.text()));
          return new Response(JSON.stringify({ type: "presence", online }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      };
    },
  };
}

// Fake D1: statements route by SQL text; gc_member_status writes are recorded
// (the pinned SQL shape + binds), session reads carry the real fixture row.
function fakeDb(routes) {
  const writes = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    writes,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => ({ results: [] });
      statement.run = async () => {
        writes.push({ sql, bound: statement.bound });
        const route = find(sql);
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

async function sessionFixtures(username, userId = MEMBER_ID) {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: userId,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username,
    role: "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return {
    token,
    csrf,
    row,
    headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf, Origin: ORIGIN },
  };
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handlePresenceRoutes(
      request,
      env,
      url,
      url.pathname,
      request.method.toUpperCase(),
      undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

async function hubFrame(hub, payload) {
  const response = await hub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
  return response.json();
}

// --- PresenceHub DO ---------------------------------------------------------------

test("hub construction pins a ping/pong auto-response so presence pings hibernate", () => {
  const autoResponses = [];
  const state = {
    setWebSocketAutoResponse(pair) {
      autoResponses.push(pair);
    },
  };
  new PresenceHub(state, {});
  assert.equal(autoResponses.length, 1);
  assert.equal(autoResponses[0].ping, "ping");
  assert.equal(autoResponses[0].pong, "pong");
});

test("heartbeat upserts the sender and answers presence including everyone else", async () => {
  const hub = new PresenceHub({ setWebSocketAutoResponse() {} }, {});

  const aliceFrame = await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  assert.deepEqual(aliceFrame, {
    type: "presence",
    online: [{ userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null }],
  });

  // The upsert: bob's heartbeat must answer with him AND alice, in id order.
  const bobFrame = await hubFrame(hub, { type: "heartbeat", userId: 2, username: "bob" });
  assert.deepEqual(bobFrame, {
    type: "presence",
    online: [
      { userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null },
      { userId: 2, username: "bob", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null },
    ],
  });

  // Heartbeating again never duplicates an entry.
  await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  const again = await hubFrame(hub, { type: "list" });
  assert.equal(again.online.length, 2);
});

test("leave removes the user and echoes presence; unknown leaves are harmless", async () => {
  const hub = new PresenceHub({ setWebSocketAutoResponse() {} }, {});
  await hubFrame(hub, { type: "connect", userId: 1, username: "alice" });
  await hubFrame(hub, { type: "heartbeat", userId: 2, username: "bob" });

  const response = await hub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify({ type: "leave", userId: 2 }),
    }),
  );
  assert.deepEqual(JSON.parse(await response.text()), {
    type: "presence",
    online: [{ userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null }],
  });

  await hubFrame(hub, { type: "leave", userId: 999 });
  const final = await hubFrame(hub, { type: "list" });
  assert.equal(final.online.length, 1);
});

test("heartbeat overlays the persisted status; a statusUntil in the past is hidden", async () => {
  const now = nowSeconds();
  let rowFactory = () => null;
  const db = {
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        if (sql.includes("gc_member_status")) {
          return rowFactory(statement.bound[0]);
        }
        return null;
      };
      statement.run = async () => ({ meta: { changes: 1, last_row_id: 1 } });
      return statement;
    },
    async batch() {
      return [];
    },
  };
  const hub = new PresenceHub({ setWebSocketAutoResponse() {} }, { GOOBER_DB: db });

  // No status row → nulls.
  const plain = await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  assert.deepEqual(plain.online, [{ userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null }]);

  // A live status overlay flows straight through.
  rowFactory = () => ({ status_text: "gone soon", status_until: now + 600 });
  const live = await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  assert.deepEqual(live.online, [
    { userId: 1, username: "alice", statusText: "gone soon", statusUntil: now + 600, presenceState: null, voiceChannel: null },
  ]);

  // A stale status (statusUntil < now) is hidden — nulls, not the past values.
  rowFactory = () => ({ status_text: "gone soon", status_until: now - 10 });
  const stale = await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  assert.deepEqual(stale.online, [
    { userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null },
  ]);

  // The tier overlays beside the status and survives a stale status (the two
  // are independent: one untils, the other never does).
  rowFactory = () => ({ status_text: "afk", status_until: now - 10, presence_state: "dnd" });
  const tiered = await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  assert.deepEqual(tiered.online, [
    { userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: "dnd", voiceChannel: null },
  ]);
});

test("the overlay's read carries the tier column beside the status columns", async () => {
  // Structural pin: overlayStatus selects all three persisted fields so a
  // PATCH on either survives a hub eviction.
  const source = (await import("node:fs")).readFileSync(
    new URL("../api/presence.mjs", import.meta.url), "utf8",
  );
  assert.match(source, /presence_state FROM gc_member_status/);
});

test("unknown or malformed frames get a 400 error and leave the membership alone", async () => {
  const hub = new PresenceHub({ setWebSocketAutoResponse() {} }, {});
  await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });

  const bad = await hub.fetch(
    new Request("https://presence.internal/hub", { method: "POST", body: "{oops" }),
  );
  assert.equal(bad.status, 400);

  const mystery = await hub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify({ type: "mystery" }),
    }),
  );
  assert.equal(mystery.status, 400);

  const after = await hubFrame(hub, { type: "list" });
  assert.deepEqual(after.online, [
    { userId: 1, username: "alice", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null },
  ]);
});

// --- ChatRoom relay plumbing ------------------------------------------------------

test("a member's chat upgrade forwards a connect frame to the hub", async () => {
  const hubFrames = [];
  const env = { __presence: fakePresenceBinding({ frames: hubFrames }), get PRESENCE() { return this.__presence; } };
  const { room, ctx } = makeRoom(env);
  const socket = await connect(room, ctx, { userId: 7, username: "wempos", channelKind: "text" });
  void socket;
  await new Promise((resolve) => {
    const check = () => (hubFrames.length ? resolve() : setImmediate(check));
    check();
  });

  assert.deepEqual(env.PRESENCE.names, ["hub"]);
  assert.deepEqual(hubFrames, [{ type: "connect", userId: 7, username: "wempos" }]);
});

test("the heartbeat WS frame rides the room to the hub and the sender gets the presence frame", async () => {
  const hubFrames = [];
  const env = {
    __presence: fakePresenceBinding({
      frames: hubFrames,
      online: [
        { userId: 1, username: "alice", statusText: "brb", statusUntil: null, presenceState: null, voiceChannel: null },
        { userId: 7, username: "wempos", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null },
      ],
    }),
    get PRESENCE() {
      return this.__presence;
    },
  };
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  const wempos = await connect(room, ctx, { userId: 7, username: "wempos", channelKind: "text" });
  clearFrames(alice);
  clearFrames(wempos);

  await room.webSocketMessage(wempos, JSON.stringify({ type: "heartbeat" }));
  await new Promise((resolve) => {
    const check = () => (wempos.sent.length ? resolve() : setImmediate(check));
    check();
  });

  assert.equal(env.PRESENCE.names.includes("hub"), true);
  const heartbeat = hubFrames.find((frame) => frame.type === "heartbeat");
  assert.deepEqual(heartbeat, { type: "heartbeat", userId: 7, username: "wempos" });

  // The sender gets the pinned presence frame; nobody else does.
  assert.deepEqual(sentFrames(wempos), [{
    type: "presence",
    online: [
      { userId: 1, username: "alice", statusText: "brb", statusUntil: null, presenceState: null, voiceChannel: null },
      { userId: 7, username: "wempos", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null },
    ],
  }]);
  assert.deepEqual(sentFrames(alice), []);
});

test("a room close forwards a leave frame to the hub", async () => {
  const hubFrames = [];
  const env = { __presence: fakePresenceBinding({ frames: hubFrames }), get PRESENCE() { return this.__presence; } };
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  const wempos = await connect(room, ctx, { userId: 7, username: "wempos", channelKind: "text" });

  ctx.webSocketClosed(wempos);
  await room.webSocketClose(wempos);
  await new Promise((resolve) => {
    const check = () => (hubFrames.some((f) => f.type === "leave") ? resolve() : setImmediate(check));
    check();
  });

  assert.deepEqual(hubFrames.find((frame) => frame.type === "leave"), { type: "leave", userId: 7 });
  void alice;
});

test("a broken hub never takes the chat relay down: no presence frame, socket stays", async () => {
  const env = {
    PRESENCE: {
      idFromName() {
        return { name: "hub" };
      },
      get() {
        return {
          fetch: async () => new Response("boom", { status: 500 }),
        };
      },
    },
  };
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  clearFrames(alice);

  await room.webSocketMessage(alice, JSON.stringify({ type: "heartbeat" }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sentFrames(alice), []);
  assert.deepEqual(ctx.getWebSockets(), [alice]);
});

// --- REST routes ------------------------------------------------------------------

test("GET /api/presence round-trips the hub with a list frame and returns {online}", async () => {
  const { row, headers } = await sessionFixtures("wempos");
  const presenceBinding = fakePresenceBinding({
    online: [{ userId: 7, username: "wempos", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null }],
  });
  const env = { GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]), PRESENCE: presenceBinding };

  const response = await dispatch(
    new Request(`${ORIGIN}/api/presence`, { method: "GET", headers }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    online: [{ userId: 7, username: "wempos", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null }],
  });
  // The pinned hub identity: one hub DO, addressed by name.
  assert.deepEqual(presenceBinding.names, ["hub"]);
  assert.deepEqual(presenceBinding.frames, [{ type: "list" }]);
});

test("GET /api/presence refuses the unsigned and degrades to 503 without the binding", async () => {
  const { headers } = await sessionFixtures("wempos");
  const unauthorized = await dispatch(
    new Request(`${ORIGIN}/api/presence`, { method: "GET" }),
    { GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => null }]), PRESENCE: fakePresenceBinding() },
  );
  assert.equal(unauthorized.status, 401);

  const { row } = await sessionFixtures("wempos");
  const noBinding = await dispatch(
    new Request(`${ORIGIN}/api/presence`, { method: "GET", headers }),
    { GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]) },
  );
  assert.equal(noBinding.status, 503);
});

test("PATCH /api/me/status persists the status row with the pinned SQL shape", async () => {
  const { row, headers } = await sessionFixtures("wempos");
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const env = { GOOBER_DB: db };

  const response = await dispatch(
    new Request(`${ORIGIN}/api/me/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ statusText: "building goobercord", statusUntil: 1731699999 }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    status: { statusText: "building goobercord", statusUntil: 1731699999 },
  });

  // The pinned write: one upsert, user-keyed, cleared values ride the binds.
  // The tier key was ABSENT here, so the keep-branch never mentions the
  // column in its UPDATE arm and the INSERT slot answers NULL.
  assert.equal(db.writes.length, 1);
  const write = db.writes[0];
  assert.equal(write.sql.includes("INSERT INTO gc_member_status"), true);
  assert.equal(write.sql.includes("ON CONFLICT(user_id) DO UPDATE"), true);
  assert.equal(write.sql.includes("updated_at = excluded.updated_at"), true);
  assert.equal(write.sql.includes("presence_state = excluded.presence_state"), false);
  assert.deepEqual(write.bound.slice(0, 3), [
    MEMBER_ID,
    "building goobercord",
    1731699999,
  ]);
});

test("PATCH /api/me/status carries the tier only when the key is present", async () => {
  const { row, headers } = await sessionFixtures("wempos");

  for (const [sent, stored] of [["idle", "idle"], ["dnd", "dnd"], ["online", null], [null, null]]) {
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(
      new Request(`${ORIGIN}/api/me/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ statusText: null, statusUntil: null, presenceState: sent }),
      }),
      { GOOBER_DB: db },
    );
    assert.equal(response.status, 200, String(sent));
    assert.deepEqual(await bodyOf(response), {
      status: { statusText: null, statusUntil: null, presenceState: stored },
    });
    // The set-branch: the column rides BOTH arms and its bind is the
    // normalized slot.
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].sql.includes("presence_state = excluded.presence_state"), true);
    assert.deepEqual(db.writes[0].bound, [MEMBER_ID, null, null, stored, db.writes[0].bound[4]]);
  }

  // An unknown tier refuses before any write.
  const badDb = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const badState = await dispatch(
    new Request(`${ORIGIN}/api/me/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ statusText: null, statusUntil: null, presenceState: "superstar" }),
    }),
    { GOOBER_DB: badDb },
  );
  assert.equal(badState.status, 400);
  assert.deepEqual(badDb.writes, []);
});

test("PATCH /api/me/status null clears the status and rejects garbage before writing", async () => {
  const { row, headers } = await sessionFixtures("wempos");

  // Null clears: both binds ride as SQL NULL.
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const clear = await dispatch(
    new Request(`${ORIGIN}/api/me/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ statusText: null, statusUntil: null }),
    }),
    { GOOBER_DB: db },
  );
  assert.equal(clear.status, 200);
  assert.equal(db.writes.length, 1);
  // The keep-branch: 5 slots now (presence_state between until and updated_at)
  // with the tier slot answering NULL.
  assert.deepEqual(db.writes[0].bound, [MEMBER_ID, null, null, null, db.writes[0].bound[4]]);

  // A 129-character statusText is refused before any write.
  const longDb = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const tooLong = await dispatch(
    new Request(`${ORIGIN}/api/me/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ statusText: "x".repeat(129), statusUntil: null }),
    }),
    { GOOBER_DB: longDb },
  );
  assert.equal(tooLong.status, 400);
  assert.deepEqual(longDb.writes, []);

  // A non-integer statusUntil is refused too.
  const badDb = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const badUntil = await dispatch(
    new Request(`${ORIGIN}/api/me/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ statusText: "hi", statusUntil: "tomorrow" }),
    }),
    { GOOBER_DB: badDb },
  );
  assert.equal(badUntil.status, 400);
  assert.deepEqual(badDb.writes, []);
});

test("PATCH /api/me/status keeps the CSRF gate: a mismatched token is 403 and unwritten", async () => {
  const { row, headers } = await sessionFixtures("wempos");
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(
    new Request(`${ORIGIN}/api/me/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: headers.Cookie,
        "X-CSRF-Token": "forged-token-000",
      },
      body: JSON.stringify({ statusText: null, statusUntil: null }),
    }),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(db.writes, []);
});

test("presence routes stay out of each other's way: unknown paths fall through", async () => {
  const { row, headers } = await sessionFixtures("wempos");
  const response = await dispatch(
    new Request(`${ORIGIN}/api/presence/other`, {
      method: "GET",
      headers: { Origin: ORIGIN, Cookie: headers.Cookie },
    }),
    {
      GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]),
      PRESENCE: fakePresenceBinding(),
    },
  );
  assert.equal(response.status, 404);
});

// --- the app-wide presence beat (POST /api/presence/announce) -------------------

test("POST /api/presence/announce claims the member with a heartbeat frame and answers the envelope", async () => {
  const { row, headers } = await sessionFixtures("wempos");
  const frames = [];
  const online = [{ userId: 7, username: "wempos", statusText: null, statusUntil: null, presenceState: null, voiceChannel: null }];
  const response = await dispatch(
    new Request(`${ORIGIN}/api/presence/announce`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: headers.Cookie, "X-CSRF-Token": headers["X-CSRF-Token"] },
    }),
    {
      GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]),
      __presence: fakePresenceBinding({ frames, online }),
      get PRESENCE() { return this.__presence; },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { online });
  // The claim rides the same hub entry point the socket beats use — one
  // heartbeat frame (the upsert-then-overlay idempotent arm), exactly one
  // DO hop, addressed at the pinned hub name.
  assert.deepEqual(frames, [{ type: "heartbeat", userId: 7, username: "wempos" }]);
});

test("POST /api/presence/announce refuses the unsigned and degrades to 503 without the binding", async () => {
  const unauthorized = await dispatch(
    new Request(`${ORIGIN}/api/presence/announce`, { method: "POST" }),
    { GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => null }]), PRESENCE: fakePresenceBinding() },
  );
  // requireUser (a mutating lane) answers its no-session refusal as 403 —
  // the GET list's requireSignedInRead is the 401 arm, not this one.
  assert.equal(unauthorized.status, 403);

  const { row, headers } = await sessionFixtures("wempos");
  const noBinding = await dispatch(
    new Request(`${ORIGIN}/api/presence/announce`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: headers.Cookie, "X-CSRF-Token": headers["X-CSRF-Token"] },
    }),
    { GOOBER_DB: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]) },
  );
  assert.equal(noBinding.status, 503);
});
