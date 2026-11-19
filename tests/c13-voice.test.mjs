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

// GO-HAYWIRE cycle-13: the voice frame arms get the c12 floors' peek/ARM
// idiom (F1 voice_join — the hub subrequest + presence write is the
// amplification; F2 voice_mute/voice_leave — the O(sockets) roster fan-out
// is), and the room's per-caller maps get ONE bounded bump whose
// oldest-entry eviction caps them hard at 512 (F3). Fixtures mirror
// c12-rooms.test.mjs in miniature; the voice channel rides the seat route
// (server_id null) so the authority walk is the two-query door, no bits.

import test from "node:test";
import assert from "node:assert/strict";

import { ChatRoom } from "../api/rooms.mjs";
import { GC_VOICE_FLOOR_SECONDS } from "../constants.mjs";

const CHANNEL_ID = 3;

// --- fake DO context (c12-rooms.test.mjs's shape) --------------------------------
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

// --- M3 fan-in door fixtures (c12-rooms.test.mjs's shape) --------------------------
const FANIN_CHANNEL_TEST = (sql) =>
  sql.includes("SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1");
const FANIN_SEAT_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_conversation_members WHERE channel_id = ? AND user_id = ? LIMIT 1");

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

// A seat-based voice channel: server_id null walks the conversation seat,
// so the door is one channel row + one seat read, no CONNECT/SPEAK bits.
function fanInDb({ channel, members }) {
  const set = new Set(members.map(Number));
  return fakeDb([
    { test: FANIN_CHANNEL_TEST, first: async () => channel },
    { test: FANIN_SEAT_TEST, first: async (bound) => (set.has(Number(bound[1])) ? { 1: 1 } : null) },
  ]);
}

function makeRoom(env) {
  const ctx = fakeCtx();
  return { room: new ChatRoom(ctx, env), ctx };
}

// --- voice room fixtures ----------------------------------------------------------
const VOICE_FIXTURE = {
  channel: { id: CHANNEL_ID, server_id: null, kind: "voice" },
  members: [1, 2],
};

// The fake hub (c12-rooms.test.mjs's shape): every forwarded frame recorded.
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

async function voiceRoom() {
  const hub = fakePresenceBinding();
  const { room, ctx } = makeRoom({ GOOBER_DB: fanInDb(VOICE_FIXTURE), PRESENCE: hub });
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "voice" });
  const bob = await connect(room, ctx, { userId: 2, username: "bob", channelKind: "voice" });
  // The upgrade's own connect relay is fire-and-forget; let it land, then
  // every pin counts from an empty hub ledger (c12's heartbeatRoom idiom).
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  hub.forwarded.length = 0;
  clearFrames(alice);
  clearFrames(bob);
  return { room, hub, alice, bob };
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
function rosterTo(socket) {
  return sentFrames(socket).filter((frame) => frame.type === "voice_roster").length;
}
function hubRides(hub, type) {
  return hub.forwarded.filter((frame) => frame.type === type).length;
}

// The floor is a wall-clock window (Date.now, the voice cache's clock):
// pin it so no pin flakes on scheduling (c12's withFrozenClock idiom).
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

const VOICE_FLOOR_PAST = (GC_VOICE_FLOOR_SECONDS + 1) * 1000;

// --- F2's constant: the floor window rides the constants law -----------------------

test("the voice floor window is GC_VOICE_FLOOR_SECONDS, matched to the voice authority TTL", () => {
  assert.equal(ChatRoom.VOICE_FLOOR_MS, GC_VOICE_FLOOR_SECONDS * 1000);
  // F1's law: the window stays consistent with the 10s authority horizon.
  assert.equal(ChatRoom.VOICE_FLOOR_MS, ChatRoom.VOICE_AUTH_TTL_MS);
  assert.equal(GC_VOICE_FLOOR_SECONDS, 10);
});

// --- F1: the voice_join arm's floor ------------------------------------------------

test("a wire-rate voice_join burst rides the presence hub once; another caller and a decayed window re-admit", async () => {
  const { room, hub, alice, bob } = await voiceRoom();
  await withFrozenClock(async (advance) => {
    // The admitted join walks the door and relays to the hub.
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    assert.equal(hub.forwarded.length, 1);
    assert.equal(hub.forwarded[0].type, "voice");

    // Five wire-rate repeats: ZERO hub rides — the subrequest + presence
    // write is the amplification the floor exists to absorb.
    for (let index = 0; index < 5; index += 1) {
      await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    }
    assert.equal(hub.forwarded.length, 1);

    // Per-caller key: bob's join is his own floor's business.
    await room.webSocketMessage(bob, JSON.stringify({ type: "voice_join" }));
    assert.equal(hub.forwarded.length, 2);

    // Decay: past the window the next join rides the hub again.
    advance(VOICE_FLOOR_PAST);
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    assert.equal(hub.forwarded.length, 3);
  });
});

test("a floored voice_join drops ONLY the hub side effects: no refusal, connection alive, roster ack rides", async () => {
  const { room, hub, alice } = await voiceRoom();
  await withFrozenClock(async () => {
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    clearFrames(alice);

    // A floored repeat: the hub is skipped (nothing beyond the admitted
    // ride), no error frame, no close — and the roster broadcast stays the
    // joiner's in-memory ok, exactly the happy path's non-hub shape.
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    assert.equal(hub.forwarded.length, 1);
    assert.equal(sentFrames(alice).some((frame) => frame.type === "error"), false);
    assert.equal(alice.closed, undefined);
    assert.equal(rosterTo(alice), 1);
    const meta = JSON.parse(alice.deserializeAttachment());
    assert.equal(meta.voice, true);
  });
});

// --- F2: the voice_mute / voice_leave arms' floors ----------------------------------

test("a wire-rate voice_mute burst floors the roster broadcast but never the sender's own state", async () => {
  const { room, hub, alice, bob } = await voiceRoom();
  await withFrozenClock(async (advance) => {
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    clearFrames(alice);
    clearFrames(bob);

    // The admitted mute rebuilds + broadcasts the roster to every socket.
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_mute", muted: true }));
    assert.equal(rosterTo(bob), 1);

    // Five wire-rate repeats: ZERO broadcast frames reach the other socket
    // — but the arm's order puts the flags write before the broadcast, so
    // the last floored mute still flipped the sender's own state.
    for (let index = 0; index < 5; index += 1) {
      await room.webSocketMessage(alice, JSON.stringify({ type: "voice_mute", muted: false }));
    }
    assert.equal(rosterTo(bob), 1);
    const meta = JSON.parse(alice.deserializeAttachment());
    assert.equal(meta.voiceMuted, false);

    // Decay: past the window the next mute broadcasts again.
    advance(VOICE_FLOOR_PAST);
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_mute", muted: true }));
    assert.equal(rosterTo(bob), 2);
  });
});

test("a join/leave alternation rides the hub once per arm per window, flags still flip every frame", async () => {
  const { room, hub, alice } = await voiceRoom();
  await withFrozenClock(async () => {
    // Three join/leave rounds: the floored repeats must not ride the leave
    // arm's hub subrequest back in past the join floor's skip — otherwise
    // an alternator gets a hub ride every other frame.
    for (let index = 0; index < 3; index += 1) {
      await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
      await room.webSocketMessage(alice, JSON.stringify({ type: "voice_leave" }));
    }
    assert.equal(hubRides(hub, "voice"), 1);
    assert.equal(hubRides(hub, "voice_leave"), 1);
    // The flags write runs on both paths (floor drops the broadcast, never
    // the state): the last round ends out of voice.
    const meta = JSON.parse(alice.deserializeAttachment());
    assert.equal(meta.voice, false);
  });
});

test("a floored voice_leave keeps the flags cleared while the hub and the roster broadcast wait for the window", async () => {
  const { room, hub, alice, bob } = await voiceRoom();
  await withFrozenClock(async (advance) => {
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    clearFrames(alice);
    clearFrames(bob);
    // The admitted leave rides the hub once and broadcasts once.
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_leave" }));
    assert.equal(hubRides(hub, "voice_leave"), 1);
    assert.equal(rosterTo(bob), 1);

    // Floored repeat: no hub ride, no broadcast, state still cleared.
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_leave" }));
    assert.equal(hubRides(hub, "voice_leave"), 1);
    assert.equal(rosterTo(bob), 1);
    const meta = JSON.parse(alice.deserializeAttachment());
    assert.equal(meta.voice, false);

    // Decay: the join re-admits past the window (roster broadcast rides
    // again), and the leave that follows forwards and broadcasts once more.
    advance(VOICE_FLOOR_PAST);
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_join" }));
    assert.equal(hubRides(hub, "voice"), 2);
    assert.equal(rosterTo(bob), 2);
    await room.webSocketMessage(alice, JSON.stringify({ type: "voice_leave" }));
    assert.equal(hubRides(hub, "voice_leave"), 2);
    assert.equal(rosterTo(bob), 3);
  });
});

// --- F3: the four maps cap hard at 512 fresh entries --------------------------------

test("the per-caller floor maps cap hard at 512 fresh entries — the oldest inserted entry is the eviction", async () => {
  // The voice-auth map's 513th caller rides the real door (seat route).
  const bigRoster = {
    channel: { id: 1, server_id: null, kind: "voice" },
    members: Array.from({ length: 513 }, (_, index) => index),
  };
  const room = new ChatRoom(fakeCtx(), { GOOBER_DB: fanInDb(bigRoster) });
  await withFrozenClock(async () => {
    const now = Date.now();
    const armCases = [
      ["msgFloorCache", "msgFloorArm"],
      ["heartbeatFloorCache", "heartbeatFloorArm"],
      ["typingFloorCache", "typingFloorArm"],
    ];
    for (const [cacheName, armName] of armCases) {
      const cache = room[cacheName];
      for (let userId = 0; userId < 512; userId += 1) cache.set(`1:${userId}`, now);
      room[armName]({ channelId: 1, userId: 512 });
      assert.equal(cache.size, 512, `${cacheName} caps hard at 512`);
      assert.equal(cache.has("1:0"), false, `${cacheName} evicts the oldest`);
      assert.equal(cache.has("1:512"), true, `${cacheName} admits the new caller`);
    }

    // The voice-auth map ({ok, at} entries): 512 fresh seeded answers, and
    // the 513th caller re-walks the door before its cap-bump lands.
    for (let userId = 0; userId < 512; userId += 1) {
      room.voiceAuthCache.set(`1:${userId}`, { ok: true, at: now });
    }
    const ok = await room.voiceRelayAllowed({ channelId: 1, userId: 512, channelKind: "voice" });
    assert.equal(ok, true);
    assert.equal(room.voiceAuthCache.size, 512);
    assert.equal(room.voiceAuthCache.has("1:0"), false);
    assert.equal(room.voiceAuthCache.has("1:512"), true);
  });
});
