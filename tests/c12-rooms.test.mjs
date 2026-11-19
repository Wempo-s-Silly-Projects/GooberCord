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

// GO-HAYWIRE cycle-12: the ChatRoom "msg" and "heartbeat" arms get the
// typing floor's peek/ARM idiom (per-(channel, user) window, cap-evicted
// Map, zero-read repeats) and the presence hub's leave arm clamps its
// delete to a positive-count decrement. Fixtures mirror
// rooms-relay.test.mjs and presence-module.test.mjs in miniature; the
// chat.js conversations-lane roster guard rides the roster-key pin's regex
// idiom (the file's DOM-coupled arms are source-pinned, like
// roster-key-namespace.test.mjs does).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { ChatRoom } from "../api/rooms.mjs";
import { PresenceHub } from "../api/presence.mjs";
import { HttpError } from "../api/core/http.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const CHAT = readFileSync(join(HERE, "../public/js/ui/chat.js"), "utf8");

const CHANNEL_ID = 3;

// --- fake DO context (rooms-relay.test.mjs's shape) ------------------------------
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
  };
}

// --- fake send primitive (rooms-relay.test.mjs's shape) ---------------------------
function envWithSender(records, extra = {}, sender = null) {
  return {
    ...extra,
    __sendMessageToChannel: async (env, user, channelId, body, clientMessageId) => {
      if (sender?.throw !== undefined) throw sender.throw;
      records.push({ userId: user.id, channelId, body, clientMessageId });
      return {
        message: {
          id: 42,
          authorId: Number(user.id),
          authorName: user.username,
          body,
          editedAt: null,
          source: null,
          attachmentIds: [],
        },
        created: true,
      };
    },
  };
}

function makeRoom(env) {
  const ctx = fakeCtx();
  return { room: new ChatRoom(ctx, env), ctx };
}

// --- M3 fan-in door fixtures (rooms-relay.test.mjs's shape) ------------------------
const FANIN_CHANNEL_TEST = (sql) =>
  sql.includes("SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1");
const FANIN_MEMBER_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const FANIN_SEAT_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_conversation_members WHERE channel_id = ? AND user_id = ? LIMIT 1");
const LAYER_MEMBER_TEST = (sql) =>
  sql.includes("FROM gc_server_members") && sql.includes("m.user_id = ?");

function fanInDb({ channel, members }) {
  const set = new Set(members.map(Number));
  return fakeDb([
    { test: FANIN_CHANNEL_TEST, first: async () => channel },
    {
      test: (sql) => FANIN_MEMBER_TEST(sql) || LAYER_MEMBER_TEST(sql),
      first: async (bound) => (set.has(Number(bound[1])) ? { 1: 1, role: "member" } : null),
    },
    { test: FANIN_SEAT_TEST, first: async (bound) => (set.has(Number(bound[1])) ? { 1: 1 } : null) },
  ]);
}

function fakeDb(routes) {
  const find = (sql) => routes.find((route) => route.test(sql));
  return {
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
      statement.run = async () => ({ meta: { changes: 1, last_row_id: 1 } });
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

// The fan-in fixture, wrapped with a read counter (the peek pin's idiom).
function countingFanInDb(fixture) {
  const base = fanInDb(fixture);
  const db = { readCount: 0 };
  db.prepare = (sql) => {
    db.readCount += 1;
    return base.prepare(sql);
  };
  return db;
}

async function connect(room, ctx, { userId, username, channelKind }) {
  const request = new Request(
    `https://chat.internal/api/ws?channel=${CHANNEL_ID}&userId=${userId}` +
      `&username=${encodeURIComponent(username)}&channelKind=${channelKind}`,
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

// The floor is a wall-clock window (Date.now, the voice cache's clock):
// pin it so no pin flakes on scheduling.
async function withFrozenClock(run) {
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    return await run((advanceMs) => {
      now += advanceMs;
    });
  } finally {
    Date.now = realNow;
  }
}

// --- F1: the msg arm's floor -------------------------------------------------------

test("a floored msg frame answers the send_failed refusal and costs zero DB reads", async () => {
  const records = [];
  const db = countingFanInDb({
    channel: { id: CHANNEL_ID, server_id: 1, kind: "text" },
    members: [1],
  });
  const env = envWithSender(records, { GOOBER_DB: db });
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  clearFrames(alice);

  await withFrozenClock(async () => {
    // The admitted frame walks the gate and relays (to nobody: one socket).
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "first" }));
    assert.equal(records.length, 1);

    // The wire-rate repeat: refused with the REST wall's 429 copy in the
    // send_failed shape — the sender knows the send did not go through.
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "flood" }));
    assert.deepEqual(sentFrames(alice), [{
      type: "error",
      code: "send_failed",
      message: "Too many requests. Please wait a little and try again.",
    }]);

    // The repeat is a pure in-memory peek-refusal: no channel row, no
    // membership read, no bits walk, and nothing was persisted.
    const readsBefore = db.readCount;
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "flood2" }));
    assert.equal(db.readCount, readsBefore);
    assert.equal(records.length, 1);
  });
});

test("the msg floor is per-caller: another user's frame still relays through", async () => {
  const records = [];
  const db = countingFanInDb({
    channel: { id: CHANNEL_ID, server_id: 1, kind: "text" },
    members: [1, 2],
  });
  const env = envWithSender(records, { GOOBER_DB: db });
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  const bob = await connect(room, ctx, { userId: 2, username: "bob", channelKind: "text" });
  clearFrames(alice);
  clearFrames(bob);

  await withFrozenClock(async () => {
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "from alice" }));
    // Alice's window is warm; Bob's floor is his own: his frame relays.
    await room.webSocketMessage(bob, JSON.stringify({ type: "msg", body: "from bob" }));
    assert.equal(records.length, 2);
    assert.equal(records[1].userId, 2);
    // Each relay reaches only the OTHER socket.
    assert.deepEqual(sentFrames(bob), [{ type: "msg", message: recordsAs(records, 0) }]);
    assert.deepEqual(sentFrames(alice), [{ type: "msg", message: recordsAs(records, 1) }]);
  });
});

test("the msg floor window decays: the next frame past it relays again", async () => {
  const records = [];
  const db = countingFanInDb({
    channel: { id: CHANNEL_ID, server_id: 1, kind: "text" },
    members: [1],
  });
  const env = envWithSender(records, { GOOBER_DB: db });
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });

  await withFrozenClock(async (advance) => {
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "one" }));
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "two" })); // floored
    advance(2100); // past the 2s REST-bucket floor
    clearFrames(alice);
    await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "three" }));
    assert.equal(records.length, 2);
  });
});

test("a failed send never consumes a msg-floor slot", async () => {
  const records = [];
  const db = countingFanInDb({
    channel: { id: CHANNEL_ID, server_id: 1, kind: "text" },
    members: [1],
  });
  const env = envWithSender(
    records,
    { GOOBER_DB: db },
    { throw: new HttpError(403, "You do not have permission to do that.") },
  );
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  clearFrames(alice);

  await withFrozenClock(async () => {
    // Three refused sends IN A WIRE-RATE BURST: each refuse is the gate's
    // own send_failed (never the floor's 429 copy), and each still walks
    // the gate — a refused frame never consumes a slot, so a burst of
    // invalid sends cannot arm the floor and muzzle the next good send.
    for (let index = 0; index < 3; index += 1) {
      const readsBefore = db.readCount;
      await room.webSocketMessage(alice, JSON.stringify({ type: "msg", body: "nope" }));
      assert.deepEqual(sentFrames(alice), [{
        type: "error",
        code: "send_failed",
        message: "You do not have permission to do that.",
      }]);
      assert.equal(db.readCount, readsBefore + 3); // channel row + member + bits walk
      clearFrames(alice);
    }
  });
});

test("the msg floor map's stale entries expire under the cap (the typing floor's idiom)", () => {
  const room = new ChatRoom(fakeCtx(), {});
  return withFrozenClock(async () => {
    for (let userId = 0; userId < 600; userId += 1) {
      room.msgFloorCache.set(`1:${userId}`, Date.now() - ChatRoom.MSG_FLOOR_MS - 1);
    }
    room.msgFloorArm({ channelId: 1, userId: 9 });
    assert.equal(room.msgFloorCache.size, 1);
    assert.equal(room.msgFloorCache.has("1:9"), true);
  });
});

// --- F2: the heartbeat arm's floor -------------------------------------------------

// The fake hub (presence-module.test.mjs's shape): every forwarded frame is
// recorded; the pinned presence envelope rides back.
function fakePresenceBinding() {
  return {
    forwarded: [],
    idFromName(name) {
      return { name };
    },
    get(stubId) {
      return {
        fetch: async (request) => {
          this.forwarded.push(JSON.parse(await request.text()));
          return new Response(JSON.stringify({ type: "presence", online: [9] }),
            { headers: { "Content-Type": "application/json" } });
        },
      };
    },
  };
}

async function heartbeatRoom(hub) {
  const env = { GOOBER_DB: fakeDb([]), PRESENCE: hub };
  const { room, ctx } = makeRoom(env);
  const socket = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  // The upgrade's own connect relay is fire-and-forget; let it land, then
  // every pin counts from an empty hub ledger.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  hub.forwarded.length = 0;
  clearFrames(socket);
  return { room, socket };
}

test("a wire-rate heartbeat burst forwards the hub beat once and answers only the admitted beat", async () => {
  const hub = fakePresenceBinding();
  const { room, socket } = await heartbeatRoom(hub);

  await withFrozenClock(async () => {
    // The admitted beat rides the hub and answers the pinned envelope.
    await room.webSocketMessage(socket, JSON.stringify({ type: "heartbeat" }));
    assert.equal(hub.forwarded.length, 1);
    assert.equal(hub.forwarded[0].type, "heartbeat");
    assert.deepEqual(sentFrames(socket), [{ type: "presence", online: [9] }]);

    // Five wire-rate repeats: ZERO hub relays, zero new answers, socket
    // stays connected (the silent skip — no error frame, no close).
    clearFrames(socket);
    for (let index = 0; index < 5; index += 1) {
      await room.webSocketMessage(socket, JSON.stringify({ type: "heartbeat" }));
    }
    assert.equal(hub.forwarded.length, 1);
    assert.deepEqual(sentFrames(socket), []);
  });
});

test("the heartbeat floor decays past its window: the next beat forwards again", async () => {
  const hub = fakePresenceBinding();
  const { room, socket } = await heartbeatRoom(hub);

  await withFrozenClock(async (advance) => {
    await room.webSocketMessage(socket, JSON.stringify({ type: "heartbeat" }));
    advance(31_000); // past the 30s beat window
    await room.webSocketMessage(socket, JSON.stringify({ type: "heartbeat" }));
    assert.equal(hub.forwarded.length, 2);
  });
});

test("the heartbeat floor map's stale entries expire under the cap (the typing floor's idiom)", () => {
  const room = new ChatRoom(fakeCtx(), {});
  return withFrozenClock(async () => {
    for (let userId = 0; userId < 600; userId += 1) {
      room.heartbeatFloorCache.set(`1:${userId}`, Date.now() - ChatRoom.HEARTBEAT_FLOOR_MS - 1);
    }
    room.heartbeatFloorArm({ channelId: 1, userId: 9 });
    assert.equal(room.heartbeatFloorCache.size, 1);
    assert.equal(room.heartbeatFloorCache.has("1:9"), true);
  });
});

// --- F4: the conversations-lane roster guard (source pin, the file's idiom) --------

test("the conversations-lane roster frame guards an array before it writes the store", () => {
  // The DM lane arm must carry the SAME shape guard the mounted channel's
  // arm does (chat.js:444's class lane): a non-array members frame leaves
  // the previous store value untouched.
  assert.match(
    CHAT,
    /} else if \(frame\.type === "roster" && Array\.isArray\(frame\.members\)\) \{\n\s*store\.set\(\{ \[`presence:\$\{conversationId\}`\]: frame\.members \}\);/,
    "the conversations-lane roster arm keys presence:<conversationId> and only stores an array",
  );
});

// --- F5: the presence hub's leave clamp ---------------------------------------------

function fakeHub() {
  return new PresenceHub({}, { GOOBER_DB: fakeDb([]) });
}
async function sendHubFrame(hub, frame) {
  const response = await hub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify(frame),
    }),
  );
  return response.json();
}
const onlineIds = (body) => body.online.map((entry) => entry.userId);

test("a leave for an uncounted (announce-only) user deletes nothing from the roster", async () => {
  const hub = fakeHub();
  // The voice frame identity-upserts WITHOUT touching the connect count —
  // the hub's own analog of the REST announce roll (a presence row with a
  // 0/absent count).
  await sendHubFrame(hub, { type: "voice", userId: 9, username: "zoe" });
  assert.deepEqual(onlineIds(await sendHubFrame(hub, { type: "list" })), [9]);

  // Any socket's leave frame for user 9's id must NOT drop the roster row.
  const body = await sendHubFrame(hub, { type: "leave", userId: 9 });
  assert.deepEqual(onlineIds(body), [9]);
  // And the next leave does not flicker them back out — nothing to delete.
  assert.deepEqual(onlineIds(await sendHubFrame(hub, { type: "leave", userId: 9 })), [9]);
});

test("a 1->0 count decrement still drops the roster entry", async () => {
  const hub = fakeHub();
  await sendHubFrame(hub, { type: "connect", userId: 5, username: "five" });
  assert.deepEqual(onlineIds(await sendHubFrame(hub, { type: "list" })), [5]);

  // The first leave still leaves a socket: the row lives.
  await sendHubFrame(hub, { type: "connect", userId: 5, username: "five" });
  await sendHubFrame(hub, { type: "leave", userId: 5 });
  assert.deepEqual(onlineIds(await sendHubFrame(hub, { type: "list" })), [5]);

  // The last counted socket closed: the row drops for real.
  const body = await sendHubFrame(hub, { type: "leave", userId: 5 });
  assert.deepEqual(onlineIds(body), []);
});

function recordsAs(records, index) {
  const record = records[index];
  return {
    id: 42,
    authorId: Number(record.userId),
    authorName: record.userId === 1 ? "alice" : "bob",
    body: record.body,
    editedAt: null,
    source: null,
    attachmentIds: [],
  };
}
