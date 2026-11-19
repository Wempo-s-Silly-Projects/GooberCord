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

// ChatRoom Durable Object (Phase 1, Task 8): per-channel WebSocket fan-out,
// reached through GET /api/ws (api/ws.mjs) and addressed by the pinned DO id
// `channel:<channelId>`. It owns ONLY the relay: message persistence rides
// Task 5's `sendMessageToChannel` primitive (validation, word filter,
// idempotent insert, last_* bump all live there — the DO never duplicates
// them), and everything a socket sends is one of the pinned client frames.
//
// Envelope (pinned in the plan; phase 2 voice extends, never breaks it —
// NON-voice binary frames are still reserved and answered with
// binary_unsupported):
//   client→server: {"type":"msg","clientMessageId":...,"body":...},
//                  {"type":"typing"}, {"type":"ping","t":...},
//                  {"type":"voice_join"|"voice_leave"},
//                  {"type":"voice_mute","muted":bool},
//                  [binary] 0x01 || opusPacket (voice channels, voice-joined
//                  sockets only)
//   server→client: {"type":"msg","message":{...}} (Task 5 shape), {"type":
//                  "broadcast","kind":"typing","userId":...}, {"type":
//                  "roster","members":[{userId,username}]}, {"type":"error",
//                  "code":...}, {"type":"voice_roster","participants":[
//                  {userId,username,muted}]},
//                  [binary] 0x01 || senderUserId(BE u32) || opusPacket
//
// Voice (Phase 2) rides THIS same channel WebSocket — the owner's plan is
// Opus-over-WebSocket fanned out by the per-room DO, not WebRTC. There is no
// media proxying and no audio codec work server-side: the DO only checks the
// one version byte and the frame ceiling, prepends the sender's userId, and
// relays to the room's voice-joined sockets. Limits live in constants.mjs
// (GC_VOICE_MAX_PARTICIPANTS etc.) and are mirrored in the UI copy.
//
// The unit contract (tests/rooms-relay.test.mjs) drives the class with a fake
// ctx/env and fake sockets, so every touch of the workerd-only builtins
// (DurableObject, WebSocketPair) is guarded: with workerd absent the class
// still instantiates and the same event methods run over the fake sockets.
// In the deployed worker the guard is a plain successful dynamic import.
//
// The DO is written for hibernation: sockets are accepted with
// acceptWebSocket and per-socket identity rides serializeAttachment, so the
// per-connection fan-out state survives eviction as attachments + the
// ctx.getWebSockets() enumeration — no in-memory Map to lose on hibernate.
import { sendMessageToChannel as sendMessageToChannelPrimitive, RulesGateError, enforceChannelBits } from "./messages.mjs";
import { CARE_WS_FRAME_TYPE } from "./filterrules.mjs";
import { HttpError, json } from "./core/http.mjs";
import {
  GC_FLOOR_MAP_CAP,
  GC_TYPING_FLOOR_SECONDS,
  GC_VOICE_FLOOR_SECONDS,
  GC_VOICE_FRAME_VERSION,
  GC_VOICE_MAX_FRAME_BYTES,
  GC_VOICE_MAX_PARTICIPANTS,
} from "../constants.mjs";

let workerd = null;
try {
  workerd = await import("cloudflare:workers");
} catch {
  /* node --test: no workerd builtins — the class runs over fake sockets */
}

// Bundler/runtime ordering can leave the guarded import unresolved at module
// evaluation in wrangler dev (the DO then upgrades over fake sockets and
// acceptWebSocket 500s). Re-attempt it at the first real use — tests keep
// their fake-socket path when the specifier is genuinely absent.
async function ensureWorkerd() {
  if (!workerd) {
    try {
      workerd = await import("cloudflare:workers");
    } catch {
      /* keep the fake-socket path */
    }
  }
  return workerd;
}

class DurableObjectBase {}

function fakeServerSocket() {
  const socket = {
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
  return socket;
}

function upgradeResponse(client) {
  if (workerd) return new Response(null, { status: 101, webSocket: client });
  // node --test: undici's Response cannot represent a 101, so the fallback
  // hands the unit tests the same 101-shaped result without a runtime 1xx.
  return { status: 101, webSocket: client };
}

function upgradePair() {
  // WebSocketPair is a workerd runtime GLOBAL — the guarded module import can
  // stay unresolved under wrangler dev's DO bundling, so the global is the
  // authoritative fallback; only node --test lands on the fake socket.
  const PairCtor =
    (workerd && workerd.WebSocketPair) || globalThis.WebSocketPair || null;

  if (PairCtor) {
    const pair = new PairCtor();
    return { client: pair[0], server: pair[1] };
  }
  return { client: fakeServerSocket(), server: fakeServerSocket() };
}

// --- M3 (RBAC audit): the fan-in doors re-check the upgrade's authority -----
//
// The upgrade (api/ws.mjs) gated VIEW/SEND (text) or CONNECT/SPEAK (voice)
// once, at the 101. Hibernation makes that answer STALE: a socket kicked,
// timed out, or deny-layer-revoked after the upgrade keeps writing and
// relaying otherwise. The DO now re-checks per frame (text) or per relay
// slice (voice): a server channel rides gc_server_members' EXISTS at the
// layer gates' own door; a dm/group conversation rides its seat row. The
// timeout + rules + verification gates already live in the send primitive
// every "msg" frame walks, so the fan-in adds the two checks the primitive
// cannot make (membership is silently absent there, and no overwrite layer
// is ever re-read).
//
// One channel-shape read per frame, then the door's own query.

async function fanInChannelRow(env, channelId) {
  return env.GOOBER_DB.prepare(
    "SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(Number(channelId)).first();
}

// Is the user still a member — server channels through the roster row, dm/
// group through the conversation seat. Refusal decisions fail CLOSED: a
// missing channel, a missing row, or a query that cannot run all refuse.
async function fanInMembershipOk(env, channel, userId) {
  if (channel.server_id !== null && channel.server_id !== undefined) {
    const member = await env.GOOBER_DB.prepare(
      "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(Number(channel.server_id), userId).first();
    return member !== null;
  }
  const seat = await env.GOOBER_DB.prepare(
    "SELECT 1 FROM gc_conversation_members WHERE channel_id = ? AND user_id = ? LIMIT 1",
  ).bind(Number(channel.id), userId).first();
  return seat !== null;
}

export class ChatRoom extends (workerd?.DurableObject ?? DurableObjectBase) {
  constructor(state, env) {
    super(state, env);
    // workerd's DurableObject base assigns neither field; the explicit
    // assignment keeps the class identical under `node --test`, where the
    // guarded import fell back to an inert base.
    this.ctx = state;
    this.env = env;
  }

  async fetch(request) {
    // Retry the guarded import before building a pair (see ensureWorkerd).
    await ensureWorkerd();
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "A WebSocket upgrade is required." }, 426);
    }
    const url = new URL(request.url);
    const userId = Number(url.searchParams.get("userId"));
    const username = url.searchParams.get("username");
    const channelKind = url.searchParams.get("channelKind");
    const channelId = Number(url.searchParams.get("channel"));
    if (!Number.isInteger(userId) || userId <= 0 || username === null || !Number.isInteger(channelId)) {
      return json({ error: "Chat connection is not authorized." }, 403);
    }
    const { client, server } = upgradePair();
    this.ctx.acceptWebSocket(server);
    // voice/voiceMuted persist WITH the attachment, so the voice state below
    // survives DO hibernation exactly like the identity it hangs off.
    server.serializeAttachment(JSON.stringify({
      userId, username, channelKind, channelId, voice: false, voiceMuted: false,
    }));
    this.forwardToPresence({ type: "connect", userId, username });
    this.broadcastRoster();
    return upgradeResponse(client);
  }

  metaFor(socket) {
    try {
      const meta = JSON.parse(socket.deserializeAttachment());
      if (meta && Number.isInteger(meta.userId)) return meta;
    } catch {
      /* no attachment / unreadable — treat as unknown */
    }
    return null;
  }

  roster() {
    const members = [];
    const seen = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const meta = this.metaFor(socket);
      if (meta && !seen.has(meta.userId)) {
        seen.add(meta.userId);
        members.push({ userId: meta.userId, username: meta.username });
      }
    }
    return members;
  }

  sendFrame(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      // A socket that died mid-relay must not take the fan-out down; the
      // close handler cleans up its roster entry.
      void error;
    }
  }

  // The fan-out: every OTHER socket, never the sender. The exclusion is
  // per-(user, channel) ATTACHED IDENTITY, not per-socket: EVERY socket of
  // the same user in the same channel is skipped, so a user's own second tab
  // receives nothing — the client writes its own messages through REST and
  // adopts the echo there. A DIFFERENT channel's sockets are untouched (they
  // live in a different ChatRoom DO), so the identity check is per room.
  broadcastJson(origin, payload) {
    const frame = JSON.stringify(payload);
    // Exclude by ATTACHED IDENTITY, not object identity: under hibernation the
    // socket arguments are re-materialized per event, so `socket === origin`
    // can miss and a sender gets its own relay back.
    const originMeta = this.metaFor(origin);
    for (const socket of this.ctx.getWebSockets()) {
      const meta = this.metaFor(socket);
      if (
        originMeta &&
        meta &&
        meta.userId === originMeta.userId &&
        meta.channelId === originMeta.channelId
      ) {
        continue;
      }
      try {
        socket.send(frame);
      } catch (error) {
        // A socket that died mid-relay must not take the fan-out down; the
        // close handler cleans up its roster entry.
        void error;
      }
    }
  }

  // Presence relay plumbing (Task 9): one hub DO at the pinned name "hub",
  // spoken to through the stub-fetch frames api/presence.mjs pins. Joins/
  // leaves/heartbeats forward to the hub; the hub never reaches back into a
  // room, so presence traffic can never wake a room pair. A missing binding
  // or a failing hub must never take the chat relay down — every failure is
  // swallowed here, not in the callers.
  forwardToPresence(frame) {
    const presence = this.env?.PRESENCE;
    if (!presence) return null;
    return presence.get(presence.idFromName("hub")).fetch(
      new Request("https://presence.internal/hub", {
        method: "POST",
        body: JSON.stringify(frame),
      }),
    ).catch((error) => {
      void error;
      return null;
    });
  }

  broadcastRoster() {
    const frame = JSON.stringify({ type: "roster", members: this.roster() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
      } catch (error) {
        void error;
      }
    }
  }

  // --- voice (Phase 2): Opus-over-WebSocket relay in the room's own DO ------

  // Voice participants = sockets of this room whose attachment carries
  // voice: true. Distinct by userId (a user's second socket never duplicates).
  voiceRoster() {
    const participants = [];
    const seen = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const meta = this.metaFor(socket);
      if (meta && meta.voice && Number.isInteger(meta.userId) && !seen.has(meta.userId)) {
        seen.add(meta.userId);
        participants.push({
          userId: meta.userId,
          username: meta.username,
          muted: Boolean(meta.voiceMuted),
        });
      }
    }
    return participants;
  }

  // Sent to EVERY socket in the room (the sender included): the joiner needs
  // the roster to know which peers to expect audio from.
  broadcastVoiceRoster() {
    const frame = JSON.stringify({ type: "voice_roster", participants: this.voiceRoster() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
      } catch (error) {
        void error;
      }
    }
  }

  // Re-persist one socket's attachment with mutated voice flags. Hibernation
  // safe: the attachment is the same storage the identity rides.
  storeVoiceFlags(socket, meta, voice, voiceMuted) {
    try {
      socket.serializeAttachment(JSON.stringify({
        userId: meta.userId,
        username: meta.username,
        channelKind: meta.channelKind,
        channelId: meta.channelId,
        voice,
        voiceMuted,
      }));
    } catch (error) {
      // A socket that can no longer be tagged simply drops out of the roster.
      void error;
    }
  }

  async handleVoiceFrame(socket, meta, type, frame) {
    // Voice is a voice-channel feature; text/DM sockets stay text-only (and a
    // text channel's binary frames keep the phase 1 binary_unsupported pin).
    if (meta.channelKind !== "voice") {
      this.sendFrame(socket, { type: "error", code: "voice_text_only" });
      return;
    }

    if (type === "voice_join") {
      // Cycle-13 floor: the PEEK runs before any work (the c12 floors' own
      // idiom) — a repeat inside the window is a pure in-memory check: zero
      // gate re-walks, zero hub rides. The floored join keeps the arm's
      // non-hub side effects in the arm's own order (the flags write rides
      // BEFORE the hub call on the happy path — verify: no other mutation
      // precedes forwardToPresence) and skips ONLY the hub subrequest +
      // presence write: no error frame, no close, and the roster broadcast
      // stays the joiner's in-memory ok. No legit state change breaks — the
      // flags mutation runs on both paths — and skipping the door's re-walk
      // is within the same GC_VOICE_FLOOR_SECONDS horizon the authority
      // cache itself holds (the admitted join just answered it).
      if (this.voiceJoinFloorRepeat(meta)) {
        this.storeVoiceFlags(socket, meta, true, false);
        this.broadcastVoiceRoster();
        return;
      }
      // The M3 voice door at the frame too: the join re-walks the same
      // fragments the upgrade checked (membership + CONNECT/SPEAK, via the
      // TTL cache). A refused join is ignored — no flags set, no roster.
      if (!(await this.voiceRelayAllowed(meta))) return;
      const others = this.voiceRoster().filter((entry) => entry.userId !== meta.userId);
      // Free-plan cap (constants.mjs): a full room refuses new participants
      // instead of letting the relay fan-out grow without bound.
      if (!meta.voice && others.length >= GC_VOICE_MAX_PARTICIPANTS) {
        this.sendFrame(socket, { type: "error", code: "voice_full" });
        return;
      }
      this.storeVoiceFlags(socket, meta, true, false);
      await this.forwardToPresence({
        type: "voice",
        userId: meta.userId,
        username: meta.username,
        channelId: meta.channelId,
      });
      this.broadcastVoiceRoster();
      this.voiceJoinFloorArm(meta);
      return;
    }

    if (type === "voice_mute") {
      if (!meta.voice || typeof frame.muted !== "boolean") {
        this.sendFrame(socket, { type: "error", code: "bad_frame" });
        return;
      }
      // Cycle-13 floor: the arm's order puts the flags write before the
      // broadcast, and the floor drops the BROADCAST, never the state — a
      // repeat inside the window silently skips the O(sockets) roster
      // fan-out (the drop shape: no error frame, no close) while the
      // sender's own mute state stays untouched by flooring.
      this.storeVoiceFlags(socket, meta, true, frame.muted);
      if (this.voiceMuteFloorRepeat(meta)) return;
      this.broadcastVoiceRoster();
      this.voiceMuteFloorArm(meta);
      return;
    }

    if (type === "voice_leave") {
      if (meta.voice) {
        // Cycle-13 floor, the mute arm's drop shape: the flags write runs
        // on both paths; a repeat inside the window silently skips the hub
        // relay + roster broadcast, so a join/leave alternation cannot ride
        // the leave arm's hub subrequest back in past the join floor's skip.
        this.storeVoiceFlags(socket, meta, false, false);
        if (this.voiceLeaveFloorRepeat(meta)) return;
        await this.forwardToPresence({ type: "voice_leave", userId: meta.userId });
        this.broadcastVoiceRoster();
        this.voiceLeaveFloorArm(meta);
      }
      return;
    }
  }

  // One Opus frame can run 40+ a second on an active talker — a per-FRAME
  // authority re-query would carry the voice lane's whole fan-in load. The
  // voice door's answer is therefore cached per (channel, user) for the
  // M3 voice TTL (10s): a kick or a deny revoke severs the relay within
  // that window, and every miss re-walks the door (membership, then the
  // CONNECT/SPEAK pair through enforceChannelBits — the SAME fragments the
  // upgrade walked). A refused or failing check is SILENT: the frame is
  // simply not relayed, and voice_join is ignored — no new WS error codes.
  static VOICE_AUTH_TTL_MS = 10000; // 10s: the upgrade answers stay no older
  // than this once the socket is in a voice seat.

  voiceAuthCache = new Map(); // `${channelId}:${userId}` → { ok, at }

  async voiceRelayAllowed(meta) {
    if (meta.channelKind !== "voice") return false;
    const key = meta.channelId + ":" + meta.userId;
    const cached = this.voiceAuthCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < ChatRoom.VOICE_AUTH_TTL_MS) return cached.ok;

    let ok = false;
    try {
      const channel = await fanInChannelRow(this.env, meta.channelId);
      if (channel && String(channel.kind) === "voice") {
        ok = await fanInMembershipOk(this.env, channel, meta.userId);
        if (ok && channel.server_id !== null && channel.server_id !== undefined) {
          try {
            await enforceChannelBits(
              this.env,
              { id: channel.id, server_id: channel.server_id },
              meta.userId,
              ["CONNECT", "SPEAK"],
            );
          } catch (error) {
            void error; // a denied member keeps the seat, loses the relay
            ok = false;
          }
        }
      }
    } catch (error) {
      void error; // fail closed
      ok = false;
    }
    // A long-idle DO never grows the cache without bound; the shared bump's
    // stale sweep (any entry is re-walked on its next consult regardless).
    this.#bumpBoundedCache(
      this.voiceAuthCache,
      key,
      (entry) => now - entry.at >= ChatRoom.VOICE_AUTH_TTL_MS,
      { ok, at: now },
    );
    return ok;
  }

  // The typing floor (GO-HAYWIRE cycle-4): a "typing" frame fans out to every
  // other socket in the room, so the client-side throttle the typing branch
  // used to trust was an amplification lever — a hostile socket could inject
  // typing frames at wire rate and make the DO relay N-1 copies of each. The
  // floor is two halves keyed per (channel, user), lead deslop F1: the PEEK
  // runs before the gate, so a repeat inside the window drops as a pure
  // in-memory check — zero D1 reads, because the gate below walks 1-3
  // queries per frame and a wire-rate repeater must not buy wire-rate reads.
  // The ARM runs only after a passing gate (the voice cache's own law: a
  // refused check never consumes a slot). A hibernate just resets the
  // window; drops come without an error frame or a close.
  static TYPING_FLOOR_MS = GC_TYPING_FLOOR_SECONDS * 1000;

  typingFloorCache = new Map(); // `${channelId}:${userId}` → last accepted (ms)

  typingFloorRepeat(meta) {
    const last = this.typingFloorCache.get(meta.channelId + ":" + meta.userId);
    return last !== undefined && Date.now() - last < ChatRoom.TYPING_FLOOR_MS;
  }

  typingFloorArm(meta) {
    this.#bumpBoundedCache(
      this.typingFloorCache,
      meta.channelId + ":" + meta.userId,
      (entryAt) => Date.now() - entryAt >= ChatRoom.TYPING_FLOOR_MS,
      Date.now(),
    );
  }

  // GO-HAYWIRE cycle-12: the "msg" frame arm runs the SAME fan-in gates the
  // REST send does, but rode no rate wall at all — the REST wall
  // (GC_MESSAGE_RATE_LIMITER, 30 per 60s) never reached the primitive. The
  // floor is the typing floor's exact idiom: per-(channel, user) window,
  // 30/60s ⇒ one send per GC_TYPING_FLOOR_SECONDS (constants.mjs — the REST
  // bucket's own spacing, never re-declared here). A floored frame answers
  // the send_failed refusal (the vendor 429 body's shared copy) instead of
  // dropping silently: the sender knows the send did not go through, unlike
  // a typed-repeat drop.
  static MSG_FLOOR_MS = GC_TYPING_FLOOR_SECONDS * 1000;

  msgFloorCache = new Map(); // `${channelId}:${userId}` → last accepted (ms)

  msgFloorRepeat(meta) {
    const last = this.msgFloorCache.get(meta.channelId + ":" + meta.userId);
    return last !== undefined && Date.now() - last < ChatRoom.MSG_FLOOR_MS;
  }

  msgFloorArm(meta) {
    this.#bumpBoundedCache(
      this.msgFloorCache,
      meta.channelId + ":" + meta.userId,
      (entryAt) => Date.now() - entryAt >= ChatRoom.MSG_FLOOR_MS,
      Date.now(),
    );
  }

  // GO-HAYWIRE cycle-12: the "heartbeat" arm made a per-frame DO-to-DO
  // subrequest + D1 read + O(snapshot) serialization, so a wire-rate
  // repeater amplified one presence answer into a hub relay each — the
  // client's honest cadence is one beat per 30s (ws.js HEARTBEAT_MS, not an
  // importable constant — the client bundle stays standalone). The floor
  // carries the same 30s window per caller: the normal beat is admitted, a
  // wire-rate burst is absorbed. A floored beat SILENTLY SKIPS the hub
  // relay (the typing floor's drop shape — no error frame, no close): the
  // sender just rides its last presence answer until the next admitted
  // beat, and the beat carries no sender-visible side effect to refuse.
  static HEARTBEAT_FLOOR_MS = 30_000;

  heartbeatFloorCache = new Map(); // `${channelId}:${userId}` → last accepted (ms)

  heartbeatFloorRepeat(meta) {
    const last = this.heartbeatFloorCache.get(meta.channelId + ":" + meta.userId);
    return last !== undefined && Date.now() - last < ChatRoom.HEARTBEAT_FLOOR_MS;
  }

  heartbeatFloorArm(meta) {
    this.#bumpBoundedCache(
      this.heartbeatFloorCache,
      meta.channelId + ":" + meta.userId,
      (entryAt) => Date.now() - entryAt >= ChatRoom.HEARTBEAT_FLOOR_MS,
      Date.now(),
    );
  }

  // The cycle-13 bump: ONE bounded write for every per-caller Map (the
  // cycle-4/12 floors and the voice-auth cache, plus the cycle-13 voice
  // floors). The stale sweep stays the PRIMARY eviction — it fires when the
  // map is AT the cap (the guard is >=, reachable after every insert that
  // met a full map) and each caller's own window decides; the oldest-
  // inserted entry dies only when no entry is stale (deslop-h13-voice
  // MEDIUM-1: the old > guard could never fire — cap-at-insert holds size
  // <= 512 at every entry). Before inserting a new key the map caps hard
  // at GC_FLOOR_MAP_CAP (512), so one bump never nets the Map above the
  // cap; a re-arm of an existing key never evicts an innocent caller's
  // slot.
  #bumpBoundedCache(cache, key, isStale, value) {
    if (cache.size >= GC_FLOOR_MAP_CAP) {
      for (const [entryKey, entry] of cache) {
        if (isStale(entry)) cache.delete(entryKey);
      }
    }
    while (cache.size >= GC_FLOOR_MAP_CAP && !cache.has(key)) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, value);
  }

  // GO-HAYWIRE cycle-13: the voice frame arms' per-caller floors (the c12
  // idiom, one map per arm, the shared bump's eviction). The window is
  // GC_VOICE_FLOOR_SECONDS (10s — the voice authority TTL's own horizon),
  // never re-declared here. One map per arm: a mute must never floor a
  // leave (a muted member still leaves, and the roster has to say so), so
  // the mute and leave arms do not share a window.
  static VOICE_FLOOR_MS = GC_VOICE_FLOOR_SECONDS * 1000;

  voiceJoinFloorCache = new Map(); // `${channelId}:${userId}` → last admitted join (ms)

  voiceJoinFloorRepeat(meta) {
    const last = this.voiceJoinFloorCache.get(meta.channelId + ":" + meta.userId);
    return last !== undefined && Date.now() - last < ChatRoom.VOICE_FLOOR_MS;
  }

  voiceJoinFloorArm(meta) {
    this.#bumpBoundedCache(
      this.voiceJoinFloorCache,
      meta.channelId + ":" + meta.userId,
      (entryAt) => Date.now() - entryAt >= ChatRoom.VOICE_FLOOR_MS,
      Date.now(),
    );
  }

  voiceMuteFloorCache = new Map(); // `${channelId}:${userId}` → last broadcast mute (ms)

  voiceMuteFloorRepeat(meta) {
    const last = this.voiceMuteFloorCache.get(meta.channelId + ":" + meta.userId);
    return last !== undefined && Date.now() - last < ChatRoom.VOICE_FLOOR_MS;
  }

  voiceMuteFloorArm(meta) {
    this.#bumpBoundedCache(
      this.voiceMuteFloorCache,
      meta.channelId + ":" + meta.userId,
      (entryAt) => Date.now() - entryAt >= ChatRoom.VOICE_FLOOR_MS,
      Date.now(),
    );
  }

  voiceLeaveFloorCache = new Map(); // `${channelId}:${userId}` → last forwarded leave (ms)

  voiceLeaveFloorRepeat(meta) {
    const last = this.voiceLeaveFloorCache.get(meta.channelId + ":" + meta.userId);
    return last !== undefined && Date.now() - last < ChatRoom.VOICE_FLOOR_MS;
  }

  voiceLeaveFloorArm(meta) {
    this.#bumpBoundedCache(
      this.voiceLeaveFloorCache,
      meta.channelId + ":" + meta.userId,
      (entryAt) => Date.now() - entryAt >= ChatRoom.VOICE_FLOOR_MS,
      Date.now(),
    );
  }

  // The typing frame's M3 re-check — the SAME fragments the msg frame walks
  // (channel row, membership, the VIEW/SEND pair on server channels), minus
  // the sender-facing error frame: a kick or a deny revoke here is SILENT,
  // the voice door's shape. A kicked member's dead socket cannot broadcast
  // typing at all.
  async typingAllowed(meta) {
    let ok = false;
    try {
      const channelRow = await fanInChannelRow(this.env, meta.channelId);
      if (channelRow && (await fanInMembershipOk(this.env, channelRow, meta.userId))) {
        ok = true;
        if (channelRow.server_id !== null && channelRow.server_id !== undefined) {
          await enforceChannelBits(
            this.env,
            { id: channelRow.id, server_id: channelRow.server_id },
            meta.userId,
            ["VIEW", "SEND"],
          );
        }
      }
    } catch (error) {
      void error; // fail closed
      ok = false;
    }
    return ok;
  }

  // The one hot path: an Opus packet in, tagged + relayed out. Header:
  //   client→DO: [0x01][opus packet]
  //   DO→peers:  [0x01][sender userId BE u32][opus packet]
  // No persistence, no re-encoding, only voice-joined sockets receive, and a
  // user never hears their own stream back (same-userId exclusion). A socket
  // that can't take a frame is skipped — the close handler cleans it up.
  // The M3 door answers BEFORE anything fans out (the voiceRelayAllowed TTL
  // cache above): a refused or failing re-check drops the frame silently —
  // the kicked socket simply stops being relayed.
  async relayVoiceFrame(socket, meta, message) {
    if (meta.channelKind !== "voice" || !meta.voice) {
      // Non-voice channels (and non-voice sockets on voice channels) keep the
      // phase 1 reservation — binary is never relayed as chat content.
      this.sendFrame(socket, { type: "error", code: "binary_unsupported" });
      return;
    }

    const bytes = message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : ArrayBuffer.isView(message)
        ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
        : null;

    if (
      bytes === null ||
      bytes.length < 2 ||
      bytes.length > GC_VOICE_MAX_FRAME_BYTES + 1 ||
      bytes[0] !== GC_VOICE_FRAME_VERSION
    ) {
      this.sendFrame(socket, { type: "error", code: "bad_frame" });
      return;
    }

    if (!(await this.voiceRelayAllowed(meta))) return;

    const packet = new Uint8Array(1 + 4 + (bytes.length - 1));
    packet[0] = GC_VOICE_FRAME_VERSION;
    packet[1] = (meta.userId >>> 24) & 0xff;
    packet[2] = (meta.userId >>> 16) & 0xff;
    packet[3] = (meta.userId >>> 8) & 0xff;
    packet[4] = meta.userId & 0xff;
    packet.set(bytes.subarray(1), 5);

    for (const peer of this.ctx.getWebSockets()) {
      const peerMeta = this.metaFor(peer);
      if (!peerMeta || !peerMeta.voice || peerMeta.userId === meta.userId) continue;
      try {
        peer.send(packet);
      } catch (error) {
        void error;
      }
    }
  }

  // The message primitive the DO persists through (Task 5 owns validation,
  // filter, idempotency, last_* bump). Env-hooked so the unit tests can pin
  // the call without a workerd runtime; the module import is the production
  // path and the hook is absent there.
  sendMessage(user, channelId, body, clientMessageId) {
    const send = typeof this.env.__sendMessageToChannel === "function"
      ? this.env.__sendMessageToChannel
      : sendMessageToChannelPrimitive;
    return send(this.env, user, channelId, body, clientMessageId);
  }

  async webSocketMessage(socket, message) {
    const meta = this.metaFor(socket);
    if (meta === null) return;

    // Binary is voice (phase 2) and voice only — one Opus packet per frame,
    // relayed by this DO. Non-voice channels and non-voice sockets still get
    // the phase 1 reservation reply.
    if (typeof message !== "string") {
      await this.relayVoiceFrame(socket, meta, message);
      return;
    }

    let frame;
    try {
      frame = JSON.parse(message);
    } catch (error) {
      void error;
      this.sendFrame(socket, { type: "error", code: "bad_frame" });
      return;
    }
    const type = frame && typeof frame === "object" && !Array.isArray(frame) ? frame.type : null;

    if (type === "voice_join" || type === "voice_leave" || type === "voice_mute") {
      await this.handleVoiceFrame(socket, meta, type, frame);
      return;
    }

    if (type === "msg") {
      // GO-HAYWIRE cycle-12: the floor PEEK runs before the gate — a
      // wire-rate repeater must not buy wire-rate D1 reads, the typing
      // floor's own law. A repeat inside the window is refused with the
      // send_failed shape carrying the REST wall's shared 429 copy (the
      // vendor limiter's body, duplicated verbatim because vendor/http.mjs
      // is read-only), and the ARM never runs for a refused frame. The arm
      // lands only after the send primitive accepted the message: a
      // send_failed (validation, filter, rules) never consumes a slot.
      if (this.msgFloorRepeat(meta)) {
        this.sendFrame(socket, {
          type: "error",
          code: "send_failed",
          message: "Too many requests. Please wait a little and try again.",
        });
        return;
      }
      try {
        // The M3 text-door re-check, per frame: a kick/ban deletes the
        // membership row (or the conversation seat) and answers through this
        // throw — the send_failed frame carries the shared 403 copy — and a
        // deny-layer revoke rides enforceChannelBits' VIEW/SEND pair, exactly
        // the fragments the upgrade walked. The timeout + rules + verification
        // gates live in the primitive the frame is about to walk (the same
        // call chain a REST send takes), and a query that cannot run fails
        // closed with it.
        const channelRow = await fanInChannelRow(this.env, meta.channelId);
        if (
          !channelRow ||
          !(await fanInMembershipOk(this.env, channelRow, meta.userId))
        ) {
          throw new HttpError(403, "You do not have permission to do that.");
        }
        if (channelRow.server_id !== null && channelRow.server_id !== undefined) {
          await enforceChannelBits(
            this.env,
            { id: channelRow.id, server_id: channelRow.server_id },
            meta.userId,
            ["VIEW", "SEND"],
          );
        }
        const { message: row, careNotice } = await this.sendMessage(
          { id: meta.userId, username: meta.username },
          meta.channelId,
          frame.body,
          frame.clientMessageId === undefined ? null : frame.clientMessageId,
        );
        this.msgFloorArm(meta);
        this.broadcastJson(socket, { type: "msg", message: row });
        // The Care class (0010): the notice reaches the AUTHOR on the WS
        // path as its own frame — the fan-out excludes the sender, so a
        // broadcast can never carry it — and only then (a care hit writes
        // and notifies nothing else).
        if (typeof careNotice === "string" && careNotice.length > 0) {
          this.sendFrame(socket, { type: CARE_WS_FRAME_TYPE, body: careNotice });
        }
      } catch (error) {
        const frame = {
          type: "error",
          code: "send_failed",
          // HttpError copies (validation, the filter — FilterError extends
          // HttpError) are safe to echo; a non-HTTP failure gets the
          // generic copy instead.
          message: error instanceof HttpError ? error.message : "The message could not be sent.",
        };
        // The rules gate's pointer (0012): the DO relays the same fields the
        // REST send's 403 body carries, so the client's ONE gate dialog opens
        // over either transport.
        if (error instanceof RulesGateError) {
          frame.rules = error.rules;
          frame.serverId = error.serverId;
        }
        this.sendFrame(socket, frame);
      }
      return;
    }

    if (type === "typing") {
      // No persistence. Three gates before the fan-out (GO-HAYWIRE cycle-4):
      // the in-memory floor PEEK first — a repeat drops here with zero D1
      // reads — then the M3 member re-check (a kicked or revoked socket fans
      // out nothing and hears nothing back), then the floor ARM, which never
      // runs for a refused frame. A floored repeat is silent: no error
      // frame, no close.
      if (this.typingFloorRepeat(meta)) return;
      if (!(await this.typingAllowed(meta))) return;
      this.typingFloorArm(meta);
      this.broadcastJson(socket, { type: "broadcast", kind: "typing", userId: meta.userId });
      return;
    }

    if (type === "ping") {
      this.sendFrame(socket, { type: "pong", t: "t" in frame ? frame.t : null });
      return;
    }

    if (type === "heartbeat") {
      // Client-driven presence (one frame per 30s — the ws.js beat, whose
      // HEARTBEAT_MS this window mirrors): the floor PEEK first, so a
      // wire-rate burst of heartbeats costs zero hub relays past the
      // first admitted beat. The floored skip is silent and carries no
      // error frame (comment on HEARTBEAT_FLOOR_MS names the choice); the
      // arm lands on the ADMITTED beat, before the relay, so even a dead
      // hub cannot turn a burst into wire-rate subrequests.
      if (this.heartbeatFloorRepeat(meta)) return;
      this.heartbeatFloorArm(meta);
      // Relay the identity to the hub, and its pinned presence envelope
      // rides back to the sender only. A dead or missing hub answers
      // nothing — the socket stays connected either way, and nothing fans
      // out to the room.
      const hub = await this.forwardToPresence({
        type: "heartbeat",
        userId: meta.userId,
        username: meta.username,
      });
      const payload = hub && hub.ok ? await hub.json().catch(() => null) : null;
      if (payload && Array.isArray(payload.online)) {
        this.sendFrame(socket, { type: "presence", online: payload.online });
      }
      return;
    }

    this.sendFrame(socket, { type: "error", code: "bad_frame" });
  }

  async webSocketClose(socket) {
    // Leave: everyone still connected gets the updated roster. The closing
    // socket needs none — workerd has already dropped it from getWebSockets()
    // by the time this handler runs. Presence follows with a leave frame so
    // the hub drops the user even when no other socket ever heartbeat.
    void socket;
    const meta = this.metaFor(socket);
    if (meta && Number.isInteger(meta.userId)) {
      await this.forwardToPresence({ type: "leave", userId: meta.userId });
      if (meta.voice) {
        // A dropped voice socket (tab close, network cut) releases its seat
        // AND clears the hub's voice-channel marker, so the sidebar stops
        // listing someone who isn't speaking.
        await this.forwardToPresence({ type: "voice_leave", userId: meta.userId });
        this.broadcastVoiceRoster();
      }
    }
    this.broadcastRoster();
  }

  webSocketError(socket, error) {
    // A broken frame connection drops rather than poisons the room.
    void socket;
    void error;
  }
}
