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

// The live lane: the ONE socket address, exact frame shapes, the heartbeat,
// the G-9 reconnecting state, the resume-after handoff, and clean stops.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);

const ws = await import("../public/js/core/ws.js");
const shell = await import("../public/js/ui/shell.js");
const store = (await import("../public/js/core/store.js")).default;
const WS = readFileSync(join(HERE, "../public/js/core/ws.js"), "utf8");

// A fake socket: same surface pieces ws.js touches.
class FakeSocket {
  constructor(url) {
    FakeSocket.instances.push(this);
    this.url = url;
    this.readyState = 0;
    this.binaryType = "blob"; // the browser default — the binaryType pin fails red pre-fix
    this.sent = [];
    this.listeners = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit("close", {}); }
  open() { this.readyState = 1; this.emit("open", {}); }
  message(str) { this.emit("message", { data: str }); }
  messageBinary(buffer) { this.emit("message", { data: buffer }); }
}
FakeSocket.instances = [];

const timers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
};

const frames = [];
const drops = [];

function freshHandlers() {
  frames.length = 0;
  drops.length = 0;
  return {
    onFrame: (frame) => frames.push(frame),
    onReconnecting: () => drops.push(Date.now()),
  };
}

test.beforeEach(() => {
  FakeSocket.instances = [];
  store.reset();
});

test("the address is contract-true and the identity is server-derived", () => {
  const socket = new ws.ChannelSocket(freshHandlers(), { WebSocketImpl: FakeSocket, timers });
  socket.connect(7);
  assert.equal(FakeSocket.instances[0].url, "/api/ws?channel=7");
  socket.close();
});

test("clientMessageId: 8–64 chars, unique by construction", () => {
  const ids = new Set(Array.from({ length: 50 }, () => ws.makeClientMessageId()));
  assert.equal(ids.size, 50);
  for (const id of ids) {
    assert.ok(id.length >= 8 && id.length <= 64);
  }
});

test("msg frames carry clientMessageId (it rides only the way in)", () => {
  const socket = new ws.ChannelSocket(freshHandlers(), { WebSocketImpl: FakeSocket, timers });
  socket.connect(9);
  const socket0 = FakeSocket.instances[0];
  socket0.open();
  const sent = socket.sendChat("hello");
  assert.ok(sent, "an open socket takes the send");
  const frame = JSON.parse(socket0.sent[socket0.sent.length - 1]);
  assert.equal(frame.type, "msg");
  assert.equal(frame.clientMessageId, sent);
  assert.equal(frame.body, "hello");
  socket.close();
});

test("heartbeat: one beat on open; presence rides the shell lane otherwise", async () => {
  const socket = new ws.ChannelSocket(freshHandlers(), { WebSocketImpl: FakeSocket, timers });
  socket.connect(3);
  const socket0 = FakeSocket.instances[0];
  socket0.open();
  const beats = socket0.sent.filter((data) => {
    try { return JSON.parse(data).type === "heartbeat"; } catch { return false; }
  });
  assert.equal(beats.length, 1, "the initial beat rides the open");
  socket.close();
});

test("a drop flips the store to reconnecting and the backoff reconnects (G-9)", async () => {
  const socket = new ws.ChannelSocket(freshHandlers(), { WebSocketImpl: FakeSocket, timers });
  socket.connect(4);
  const socket0 = FakeSocket.instances[0];
  socket0.open();
  socket0.close();
  assert.equal(store.get("connection"), "reconnecting");
  const handler = socket.handlers.onReconnecting;
  assert.equal(typeof handler, "function");
  await new Promise((resolve) => setTimeout(resolve, 700)); // backoff[0] = 500ms
  assert.ok(FakeSocket.instances.length >= 2, "the reconnect spawned a socket");
  FakeSocket.instances.at(-1).open();
  assert.equal(store.get("connection"), "live");
  socket.close();
});

test("resume-after hands the caller the catch-up id on every live OPEN", async () => {
  let opened = null;
  const socket = new ws.ChannelSocket({
    onOpen: (sock, resumeAfterId) => { opened = resumeAfterId; },
  }, { WebSocketImpl: FakeSocket, timers });
  socket.connect(5);
  socket.setResumeAfter(199);
  FakeSocket.instances[0].open();
  assert.equal(opened, 199, "the resume id rode the first open");
  opened = null;
  FakeSocket.instances[0].close();
  await new Promise((resolve) => setTimeout(resolve, 700));
  FakeSocket.instances.at(-1).open();
  assert.equal(opened, null, "the resume seat clears once used");
  socket.close();
});

test("frames dispatch; the send_failed frame lands in the handler verbatim", () => {
  let lastFailure = null;
  const socket = new ws.ChannelSocket({
    onFrame: (frame) => {
      if (frame.type === "error" && frame.code === "send_failed") lastFailure = frame;
    },
  }, { WebSocketImpl: FakeSocket, timers });
  socket.connect(6);
  const socket0 = FakeSocket.instances[0];
  socket0.open();
  const gateFrame = JSON.stringify({
    type: "error", code: "send_failed",
    message: "You must accept this server's rules before doing that.",
    rules: "Be kind.", serverId: 5,
  });
  socket0.message(gateFrame);
  assert.equal(lastFailure?.message, "You must accept this server's rules before doing that.");
  assert.equal(lastFailure?.rules, "Be kind.");
  assert.equal(lastFailure?.serverId, 5);
  // Bad JSON is routine — never a crash, never a dispatch.
  socket0.message("not-json{{");
  socket.close();
});

test("voice control frames ride exact shapes; binary is the 0x01 lane", () => {
  const voiceFrames = [];
  const bytes = [];
  const socket = new ws.ChannelSocket({
    onFrame: (frame) => voiceFrames.push(frame),
    onVoiceBytes: (data, senderId) => bytes.push({ data, senderId }),
  }, { WebSocketImpl: FakeSocket, timers });
  socket.connect(8);
  const socket0 = FakeSocket.instances[0];
  socket0.open();
  socket.voiceJoin();
  socket.voiceMute(true);
  socket.voiceLeave();
  const kinds = socket0.sent
    .map((data) => { try { return JSON.parse(data).type; } catch { return null; } })
    .filter(Boolean);
  assert.deepEqual(kinds, ["heartbeat", "voice_join", "voice_mute", "voice_leave"]);
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, 0x01);
  view.setUint32(1, 42, false);
  socket0.messageBinary(buffer);
  assert.equal(bytes[0].senderId, 42);
  socket.close();
});

test("getChannelSocket closes its predecessor cleanly (one seat per channel)", () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket; // node's real WebSocket hates a relative URL
  const first = ws.getChannelSocket(11, freshHandlers());
  const socketKey = first.constructor === ws.ChannelSocket;
  assert.ok(socketKey);
  const second = ws.getChannelSocket(11, freshHandlers());
  assert.notEqual(first, second);
  assert.equal(first.socket, null, "the predecessor's socket is gone");
  second.close();
  ws.closeChannelSocket(11);
  assert.equal(ws.sockets.has(11), false);
  globalThis.WebSocket = previous;
});

test("the presence beat posts the announce lane and stops cleanly", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    calls.push(path);
    return new Response(JSON.stringify({ online: [] }), { status: 200 });
  };
  const beat = ws.startPresenceBeats(0.02);
  await new Promise((resolve) => setTimeout(resolve, 120));
  beat.stop();
  const count = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(count >= 2, "the beat ticked");
  assert.equal(calls.length, count, "stop() ends the loop — no stray beats");
  globalThis.fetch = previousFetch;
});

// --- the browser-truth pins (HIGH-2 + the strip repaint) ----------------------

test("the socket rides binaryType arraybuffer — a Blob default never reaches the voice plane", () => {
  const socket = new ws.ChannelSocket(freshHandlers(), { WebSocketImpl: FakeSocket, timers });
  socket.connect(12);
  const socket0 = FakeSocket.instances[0];
  assert.equal(socket0.binaryType, "arraybuffer",
    "open_() pins the 0x01||sender||opus dispatch to ArrayBuffer in a real browser (the browser default is Blob)");
  socket0.open();
  assert.equal(socket0.binaryType, "arraybuffer", "the pin survives the open");
  socket.close();
});

test("a connection flip repaints the strip node-locally through the subscribed shell", async () => {
  // A faithful-enough DOM stub: h() builds, and remove() detaches for real
  // so the strip's comings and goings are observable in the frame's children.
  class StubNode {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.className = "";
      this.textContent = "";
      this.dataset = {};
      this.attrs = {};
      this.parentNode = null;
    }
    append(...kids) {
      for (const kid of kids) {
        if (!kid || typeof kid !== "object") continue;
        if (kid.parentNode) {
          const sibs = kid.parentNode.children;
          const at = sibs.indexOf(kid);
          if (at >= 0) sibs.splice(at, 1);
        }
        kid.parentNode = this;
        this.children.push(kid);
      }
    }
    remove() {
      if (this.parentNode) {
        const sibs = this.parentNode.children;
        const at = sibs.indexOf(this);
        if (at >= 0) sibs.splice(at, 1);
        this.parentNode = null;
      }
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener() {}
  }
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    if (String(path).startsWith("/locales/")) {
      // The swept strip's copy rides the en bundle now.
      return new Response(JSON.stringify({ "gc.shell.reconnecting": "Reconnecting…" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      servers: [], conversations: [], mentions: { list: [] }, online: [],
    }), { status: 200 });
  };
  try {
    globalThis.Node = StubNode;
    globalThis.document = {
      createElement: (tag) => new StubNode(tag),
      createElementNS: (ns, tag) => new StubNode(tag),
      createTextNode: (text) => { const node = new StubNode("#text"); node.textContent = String(text); return node; },
      documentElement: new StubNode("html"),
      body: new StubNode("body"),
    };
    const { initI18n } = await import("../public/js/i18n.js");
    await initI18n(); // the catalog seats the swept key before renderShell paints
    const strips = (frame) => frame.children.filter((child) => child.className === "connection-strip");
    store.reset();
    store.set({ servers: [], user: null });
    const frame = shell.renderShell({ name: "home", params: {} }, null);
    assert.equal(strips(frame).length, 0, "a live socket paints no strip");
    store.set({ connection: "reconnecting" });
    const painted = strips(frame);
    assert.equal(painted.length, 1, "the flip painted the strip through the SUBSCRIPTION, no re-render");
    assert.equal(painted[0].textContent, "Reconnecting…");
    store.set({ connection: "live" });
    assert.equal(strips(frame).length, 0, "the flip back removes the strip node-locally");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the frame contract rides no invented codes", () => {
  // The OUT codes/names come from the contract's §12, verbatim.
  for (const name of ["msg", "typing", "ping", "heartbeat", "voice_join",
    "voice_leave", "voice_mute"]) {
    assert.match(WS, new RegExp(`"${name}"`), `${name} keeps its seat`);
  }
  assert.match(WS, /voice_full|send_failed/, "the error codes stay the contract's");
  assert.match(WS, /voiceBytes|opus|0x01/i, "the binary plane's seat is named");
});
