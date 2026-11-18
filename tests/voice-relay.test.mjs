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

// Phase 2 voice: Opus-over-WebSocket relay in the room's own ChatRoom DO, plus
// the PresenceHub voice markers. Same fake conventions as rooms-relay.test.mjs
// (fake ctx + fake sockets; a fake env.PRESENCE records every stub frame the
// DO forwards).
import test from "node:test";
import assert from "node:assert/strict";

import { ChatRoom } from "../api/rooms.mjs";
import { PresenceHub } from "../api/presence.mjs";
import {
  GC_VOICE_FRAME_VERSION,
  GC_VOICE_MAX_PARTICIPANTS,
} from "../constants.mjs";

const VOICE_CHANNEL_ID = 11;

// --- fake DO context (+ sockets), as in rooms-relay.test.mjs --------------------
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
      if (this.attachment === undefined) throw new Error("No socket attachment.");
      return this.attachment;
    },
    close() {
      this.closed = true;
    },
  };
}

// env.PRESENCE records every stub frame; the snapshot reply is irrelevant to
// the relay (forwardToPresence only reads it in the heartbeat path).
function fakePresence() {
  const frames = [];
  return {
    frames,
    idFromName(name) {
      return { name };
    },
    get() {
      return {
        fetch: async (request) => {
          frames.push(JSON.parse(await request.text()));
          return { ok: true, json: async () => ({ type: "presence", online: [] }) };
        },
      };
    },
  };
}

function makeRoom(env = {}) {
  const ctx = fakeCtx();
  return { room: new ChatRoom(ctx, env), ctx, env };
}

// --- M3 fan-in door fixtures (as in rooms-relay.test.mjs) -------------------------
// A voice join or relay frame re-walks the door: the channel-shape read
// (SELECT id, server_id, kind FROM gc_channels), the membership EXISTS, the
// layer gate's own membership read, and (the graceful default) an empty role
// + overwrite chain — every voice participant sails through, any other query
// reads null.
const FANIN_CHANNEL_TEST = (sql) =>
  sql.includes("SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1");
const FANIN_MEMBER_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const LAYER_MEMBER_TEST = (sql) =>
  sql.includes("FROM gc_server_members") && sql.includes("m.user_id = ?");

function fanInDb() {
  return {
    prepare(sql) {
      const statement = {
        bind: () => ({
          first: async () => {
            if (FANIN_CHANNEL_TEST(sql)) return { id: VOICE_CHANNEL_ID, server_id: 3, kind: "voice" };
            if (FANIN_MEMBER_TEST(sql)) return { 1: 1 };
            if (LAYER_MEMBER_TEST(sql)) return { 1: 1, role: "member" };
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

// The voice env: every socket is a live member of server 3's voice channel —
// the door keeps the seat open through join, relay, mute, leave, and close.
function voiceEnv(presence) {
  return { PRESENCE: presence, GOOBER_DB: fanInDb() };
}

async function connect(room, ctx, { userId, username, channelKind = "voice" }) {
  const request = new Request(
    `https://chat.internal/api/ws?channel=${VOICE_CHANNEL_ID}&userId=${userId}` +
      `&username=${encodeURIComponent(username)}&channelKind=${channelKind}`,
    { headers: { Upgrade: "websocket" } },
  );
  const response = await room.fetch(request);
  assert.equal(response.status, 101);
  const socket = ctx.accepted[ctx.accepted.length - 1];
  socket.meta = { userId, username, channelKind, channelId: VOICE_CHANNEL_ID };
  return socket;
}

function sentFrames(socket) {
  return socket.sent
    .filter((frame) => typeof frame === "string")
    .map((frame) => JSON.parse(frame));
}

function sentBinaries(socket) {
  return socket.sent
    .filter((frame) => typeof frame !== "string")
    .map((frame) => new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
}

function clearFrames(socket) {
  socket.sent.length = 0;
}

// The DO forwards a "connect" hub frame AND a text "roster" broadcast for
// every socket upgrade (phase 1 behavior, untouched by voice) — tests below
// pin the voice-specific traffic only.
function voiceFrames(presence) {
  return presence.frames.filter((frame) => frame.type === "voice" || frame.type === "voice_leave");
}

function opusPacket(marker) {
  return new Uint8Array([0x01, marker, marker + 1, marker + 2]);
}

async function joinVoice(room, socket) {
  await room.webSocketMessage(socket, JSON.stringify({ type: "voice_join" }));
}

// --- ChatRoom: voice control frames --------------------------------------------

test("voice_join on a voice channel joins, broadcasts the roster to everyone, and forwards the hub marker", async () => {
  const presence = fakePresence();
  const { room, ctx } = makeRoom(voiceEnv(presence));
  const alice = await connect(room, ctx, { userId: 1, username: "alice" });
  const bob = await connect(room, ctx, { userId: 2, username: "bob" });
  clearFrames(alice);
  clearFrames(bob);

  await joinVoice(room, alice);

  // Everyone gets the roster (the joiner included — it learns who to expect).
  const roster = { type: "voice_roster", participants: [{ userId: 1, username: "alice", muted: false }] };
  assert.deepEqual(sentFrames(alice), [roster]);
  assert.deepEqual(sentFrames(bob), [roster]);
  // The hub marker names the channel, so the sidebar can list participants.
  assert.deepEqual(voiceFrames(presence), [
    { type: "voice", userId: 1, username: "alice", channelId: VOICE_CHANNEL_ID },
  ]);
  // The voice flag persists in the attachment (hibernation-safe by contract).
  const attachment = JSON.parse(alice.deserializeAttachment());
  assert.equal(attachment.voice, true);
  assert.equal(attachment.voiceMuted, false);
});

test("voice_join on a text or DM socket is refused with voice_text_only and leaves the hub alone", async () => {
  const presence = fakePresence();
  const { room, ctx } = makeRoom({ PRESENCE: presence });
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });
  clearFrames(alice);

  await joinVoice(room, alice);

  assert.deepEqual(sentFrames(alice), [{ type: "error", code: "voice_text_only" }]);
  assert.deepEqual(voiceFrames(presence), []);
  assert.equal(JSON.parse(alice.deserializeAttachment()).voice, false);
});


test("binary from a voice KIND channel but a non-joined socket keeps the phase 1 reservation", async () => {
  const { room, ctx } = makeRoom({});
  const alice = await connect(room, ctx, { userId: 1, username: "alice" }); // not joined

  await room.webSocketMessage(alice, opusPacket(0x10));

  assert.deepEqual(sentFrames(alice).at(-1), { type: "error", code: "binary_unsupported" });
});

test("binary on a text channel stays binary_unsupported (the phase 1 pin intact)", async () => {
  const { room, ctx } = makeRoom({});
  const alice = await connect(room, ctx, { userId: 1, username: "alice", channelKind: "text" });

  await room.webSocketMessage(alice, opusPacket(0x10));

  assert.deepEqual(sentFrames(alice).at(-1), { type: "error", code: "binary_unsupported" });
});

test("malformed binary frames get bad_frame and the socket stays connected", async () => {
  const { room, ctx } = makeRoom(voiceEnv(null));
  const alice = await connect(room, ctx, { userId: 1, username: "alice" });
  await joinVoice(room, alice);
  clearFrames(alice);

  // Wrong version byte.
  await room.webSocketMessage(alice, new Uint8Array([0x07, 9, 9]));
  // Too short to carry a sender tag after the downlink rewrite… but too
  // short for the UPLINK too: a 1-byte payload-less frame.
  await room.webSocketMessage(alice, new Uint8Array([GC_VOICE_FRAME_VERSION]));
  // Oversized: the ceiling exists so one peer can't make the DO fan out
  // arbitrarily large frames.
  await room.webSocketMessage(alice, new Uint8Array(4096 + 16));

  assert.deepEqual(sentFrames(alice), [
    { type: "error", code: "bad_frame" },
    { type: "error", code: "bad_frame" },
    { type: "error", code: "bad_frame" },
  ]);
});

test("voice_mute broadcasts the muted flag; voice_leave releases the seat and clears the marker", async () => {
  const presence = fakePresence();
  const { room, ctx } = makeRoom(voiceEnv(presence));
  const alice = await connect(room, ctx, { userId: 1, username: "alice" });
  const bob = await connect(room, ctx, { userId: 2, username: "bob" });
  await joinVoice(room, alice);
  await joinVoice(room, bob);
  clearFrames(alice);
  clearFrames(bob);

  await room.webSocketMessage(alice, JSON.stringify({ type: "voice_mute", muted: true }));
  const mutedRoster = {
    type: "voice_roster",
    participants: [
      { userId: 1, username: "alice", muted: true },
      { userId: 2, username: "bob", muted: false },
    ],
  };
  assert.deepEqual(sentFrames(alice), [mutedRoster]);
  assert.deepEqual(sentFrames(bob), [mutedRoster]);

  // A non-boolean mute (and a mute from a non-participant) is a bad frame.
  await room.webSocketMessage(bob, JSON.stringify({ type: "voice_mute", muted: "yes" }));
  assert.deepEqual(sentFrames(bob).at(-1), { type: "error", code: "bad_frame" });

  clearFrames(alice);
  await room.webSocketMessage(alice, JSON.stringify({ type: "voice_leave" }));
  assert.deepEqual(sentFrames(alice), [{
    type: "voice_roster",
    participants: [{ userId: 2, username: "bob", muted: false }],
  }]);
  assert.deepEqual(presence.frames.at(-1), { type: "voice_leave", userId: 1 });

  // A lone voice_leave from a never-joined socket is a silent no-op.
  const dave = await connect(room, ctx, { userId: 4, username: "dave" });
  clearFrames(dave);
  await room.webSocketMessage(dave, JSON.stringify({ type: "voice_leave" }));
  assert.deepEqual(sentFrames(dave), []);
});

test("the free-plan participant cap refuses the 7th joiner with voice_full", async () => {
  const { room, ctx } = makeRoom(voiceEnv(fakePresence()));
  const sockets = [];
  for (let index = 1; index <= GC_VOICE_MAX_PARTICIPANTS; index++) {
    const socket = await connect(room, ctx, { userId: index, username: "u" + index });
    await joinVoice(room, socket);
    sockets.push(socket);
  }

  const seventh = await connect(room, ctx, { userId: 99, username: "late" });
  clearFrames(seventh);
  await joinVoice(room, seventh);

  assert.deepEqual(sentFrames(seventh), [{ type: "error", code: "voice_full" }]);
  // And it never appears in anyone's roster — the seats are full.
  assert.deepEqual(room.voiceRoster().length, GC_VOICE_MAX_PARTICIPANTS);
  assert.ok(!room.voiceRoster().some((entry) => entry.userId === 99));
});

test("re-joining after leaving reuses the seat and a second voice_join is idempotent", async () => {
  const { room, ctx } = makeRoom(voiceEnv(fakePresence()));
  const alice = await connect(room, ctx, { userId: 1, username: "alice" });
  await joinVoice(room, alice);
  await joinVoice(room, alice); // duplicate join: no cap error, one roster member
  assert.deepEqual(room.voiceRoster(), [{ userId: 1, username: "alice", muted: false }]);

  await room.webSocketMessage(alice, JSON.stringify({ type: "voice_leave" }));
  assert.deepEqual(room.voiceRoster(), []);
  await joinVoice(room, alice);
  assert.deepEqual(room.voiceRoster(), [{ userId: 1, username: "alice", muted: false }]);
});

test("a dropped voice socket releases its seat: remaining peers get the roster, the hub clears", async () => {
  const presence = fakePresence();
  const { room, ctx } = makeRoom(voiceEnv(presence));
  const alice = await connect(room, ctx, { userId: 1, username: "alice" });
  const bob = await connect(room, ctx, { userId: 2, username: "bob" });
  await joinVoice(room, alice);
  await joinVoice(room, bob);
  clearFrames(alice);

  ctx.webSocketClosed(bob);
  await room.webSocketClose(bob);

  // The close handler emits the voice roster (for the peers) and the hub
  // marker clear, then the ordinary text roster — pin the voice parts.
  const rosters = sentFrames(alice).filter((frame) => frame.type === "voice_roster");
  assert.deepEqual(rosters.at(-1), {
    type: "voice_roster",
    participants: [{ userId: 1, username: "alice", muted: false }],
  });
  assert.ok(voiceFrames(presence).some((frame) => frame.type === "voice_leave" && frame.userId === 2));
});

// --- PresenceHub voice markers ---------------------------------------------------

async function hubFrame(hub, payload) {
  const response = await hub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
  return response.json();
}

test("the hub marks and clears a voice channel without touching presence itself", async () => {
  const hub = new PresenceHub({ setWebSocketAutoResponse() {} }, {});

  await hubFrame(hub, { type: "heartbeat", userId: 1, username: "alice" });
  const marked = await hubFrame(hub, { type: "voice", userId: 1, username: "alice", channelId: 11 });
  assert.deepEqual(marked.online, [{
    userId: 1,
    username: "alice",
    statusText: null,
    statusUntil: null,
    presenceState: null,
    voiceChannel: 11,
  }]);

  // A malformed channelId marks presence but with no channel (defensive: the
  // DO always sends an integer, but the REST surface keeps its types honest).
  await hubFrame(hub, { type: "voice", userId: 1, username: "alice", channelId: NaN });
  const nanMarked = await hubFrame(hub, { type: "list" });
  assert.equal(nanMarked.online[0].voiceChannel, null);

  // voice_leave clears ONLY the marker — Alice stays online.
  const cleared = await hubFrame(hub, { type: "voice_leave", userId: 1 });
  assert.deepEqual(cleared.online, [{
    userId: 1,
    username: "alice",
    statusText: null,
    statusUntil: null,
    presenceState: null,
    voiceChannel: null,
  }]);
});

test("a voice join for someone the hub has never seen upserts them with the marker", async () => {
  const hub = new PresenceHub({ setWebSocketAutoResponse() {} }, {});
  const marked = await hubFrame(hub, { type: "voice", userId: 5, username: "carol", channelId: 11 });
  assert.deepEqual(marked.online, [{
    userId: 5,
    username: "carol",
    statusText: null,
    statusUntil: null,
    presenceState: null,
    voiceChannel: 11,
  }]);
});

// --- the shared client codec (public/js/voice.js) --------------------------------



