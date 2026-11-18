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

// The live lane — the ONE socket address per contract §12:
// `GET /api/ws?channel=<id>` (cookie upgrade; the browser never chooses its
// identity — the DO derives it from the session). Outbound frames are JSON
// text: msg (body + clientMessageId), typing, ping, heartbeat, voice_join /
// voice_leave / voice_mute; the binary 0x01||opus plane rides the DO voice
// relay wave. Inbound: msg / broadcast / roster / voice_roster / error /
// pong / presence / care_notice + the binary voice data.
//
// Drop behavior (G-9, system-wide): a socket drop flips the store's
// "connection" to "reconnecting" (the shell paints the one-line strip), the
// composer keeps its drafts, and backoff reconnects; the OPEN event hands
// the caller the ?after= id to re-run catch-up from the newest local
// message. No auto-resend ever — a failed send keeps its error state with
// an explicit retry control.
//
// The rules-gate WS arm rides the send_failed frame ({rules, serverId} ride
// only RulesGateError) — chat.js consumes it through the same shared accept
// flow the REST arm uses.

import { set, emit } from "./store.js";

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const HEARTBEAT_MS = 30000;

// clientMessageId: 8–64 chars (the contract's bound). Timestamp + entropy,
// both base36 — collisions are impossible within a day at human rates.
export function makeClientMessageId(now = Date.now(), random = Math.random) {
  return "gc-" + now.toString(36) + "-" + Math.floor(random() * 1e12).toString(36);
}

// The presence beat for the socket-free lanes: POST /api/presence/announce
// returns the same envelope the hub answers with; the shell holds the loop's
// seat for the page's life.
export function startPresenceBeats(seconds = 300) {
  const state = { stopped: false };
  const timer = setInterval(async () => {
    if (state.stopped) return clearInterval(timer);
    try {
      const { api } = await import("./api.js");
      const payload = await api("/api/presence/announce", { method: "POST" });
      if (Array.isArray(payload?.online)) set({ presence: payload.online });
    } catch { /* an unreachable hub is routine — the loop keeps its seat */ }
  }, seconds * 1000);
  state.stop = () => {
    state.stopped = true;
    clearInterval(timer);
  };
  return state;
}

export class ChannelSocket {
  // handlers: { onOpen(newestResumeId?), onFrame(frame, socket),
  //             onVoiceBytes(data, senderId), onReconnecting() }
  // The caller decides what a frame means; this class only keeps the line
  // alive and the frame shapes exact.
  constructor(handlers = {}, { WebSocketImpl = globalThis.WebSocket, timers = globalThis } = {}) {
    this.handlers = handlers;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.channelId = null;
    this.socket = null;
    this.attempts = 0;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.closedByUser = false;
    this.resumeAfterId = null;
  }

  connect(channelId) {
    this.closedByUser = false;
    this.channelId = channelId;
    this.open_();
    return this;
  }

  open_() {
    clearTimeout(this.connectTimer);
    this.socket = new this.WebSocketImpl(`/api/ws?channel=${this.channelId}`);
    // HIGH-2: WebSocket delivers binary as a Blob by default — without this
    // pin the 0x01||sender||opus dispatch below would never fire in a real
    // browser. (Blob tolerance stays out; the pin is the one-line fix.)
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => {
      this.attempts = 0;
      set({ connection: "live" });
      // The heartbeat keeps the presence beat warm while the channel is open.
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = this.timers.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      this.heartbeat();
      this.handlers.onOpen?.(this, this.resumeAfterId);
      this.resumeAfterId = null;
    });
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let frame = null;
        try { frame = JSON.parse(event.data); } catch { return; } // bad JSON is routine
        if (frame && frame.type === "error" && frame.code === "send_failed") {
          // The failed send keeps its error state (G-9); the composer reads
          // the frame through the handler — no auto-resend, no silent fail.
          this.lastSendError = frame;
        }
        this.handlers.onFrame?.(frame, this);
        return;
      }
      // Binary: 0x01 || senderUserId (BE u32) || opusPacket — you never hear
      // yourself (the exclusion is server-side; the bytes still route here).
      const data = event.data instanceof ArrayBuffer ? new DataView(event.data) : null;
      if (data && data.getUint8(0) === 0x01 && data.byteLength >= 5) {
        this.handlers.onVoiceBytes?.(data, data.getUint32(1, false));
      }
    });
    this.socket.addEventListener("close", () => {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.socket = null;
      if (this.closedByUser) return;
      set({ connection: "reconnecting" });
      this.handlers.onReconnecting?.(this);
      const wait = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
      this.attempts++;
      this.connectTimer = this.timers.setTimeout(() => this.open_(), wait);
    });
    // A 4xx upgrade refusal fires close (or error) — the reconnecting strip
    // is the honest state for a refused socket too; the message column's own
    // 404/403 lane still owns the page copy.
    this.socket.addEventListener("error", () => {});
  }

  // The next server frames dedupe against the store's newest local id: the
  // caller re-runs its ?after= catch-up from here on every live OPEN.
  setResumeAfter(messageId) {
    this.resumeAfterId = messageId;
  }

  get isOpen() {
    return !!this.socket && this.socket.readyState === 1;
  }

  sendFrame(frame) {
    if (this.isOpen) this.socket.send(JSON.stringify(frame));
    return this.isOpen;
  }

  // The send lane returns the clientMessageId the optimistic row keyed —
  // the POST/WS reconcile (G-12) rides it.
  sendChat(body) {
    const clientMessageId = makeClientMessageId();
    return this.sendFrame({ type: "msg", clientMessageId, body })
      ? clientMessageId : null;
  }

  typing() {
    this.sendFrame({ type: "typing" });
  }

  heartbeat() {
    if (this.isOpen) this.socket.send(JSON.stringify({ type: "heartbeat" }));
  }

  ping(t) {
    this.sendFrame({ type: "ping", t });
  }

  voiceJoin() {
    return this.sendFrame({ type: "voice_join" });
  }

  voiceLeave() {
    return this.sendFrame({ type: "voice_leave" });
  }

  voiceMute(muted) {
    return this.sendFrame({ type: "voice_mute", muted: !!muted });
  }

  // Voice data: 0x01 || opusPacket — ONLY while voice-joined on a voice
  // channel; everything else earns the server's binary_unsupported.
  sendVoiceBytes(opusPacket) {
    if (!this.isOpen) return false;
    const frame = new Uint8Array(1 + opusPacket.length);
    frame[0] = 0x01;
    frame.set(opusPacket, 1);
    this.socket.send(frame.buffer);
    return true;
  }

  // A user-leave (navigating away from the channel) stops the reconnecting
  // loop AND closes the socket — no phantom presence beat.
  close() {
    this.closedByUser = true;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    if (this.socket) this.socket.close();
    this.socket = null;
    emit("socket:closed", this.channelId);
  }
}

// A single seat per channel in the store's registry — the lane's owner keys
// sockets by channelId so route re-entries stop their predecessor cleanly.
export const sockets = new Map();

export function getChannelSocket(channelId, handlers) {
  const previous = sockets.get(channelId);
  if (previous) previous.close();
  const socket = new ChannelSocket(handlers).connect(channelId);
  sockets.set(channelId, socket);
  return socket;
}

export function closeChannelSocket(channelId) {
  const socket = sockets.get(channelId);
  if (socket) {
    socket.close();
    sockets.delete(channelId);
  }
}
