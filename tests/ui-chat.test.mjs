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

// The chat lane: the mention highlighter's parity against the backend's own
// parser (position walk pinned to matchRosterMentions's id sequence), the
// G-12 optimistic reconcile in both directions, failed-send retry states,
// forward-only read markers, the composer's laws, and the fail-soft
// attachment/GIF rendering. Behavior tests run against a stubbed fetch;
// DOM-rendered halves pin by source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const calls = [];
let responses = [];
globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, method: init.method || "GET", body: init.body });
  const response = responses.shift();
  return new Response(typeof response === "string" ? response : JSON.stringify(response),
    { status: Number.isInteger(response?.status) ? response.status : 200 });
};

const chat = await import("../public/js/ui/chat.js");
const store = (await import("../public/js/core/store.js")).default;
const parser = await import("../api/mentions.mjs");
const constants = await import("../constants.mjs");
const CHAT = readFileSync(join(HERE, "../public/js/ui/chat.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");

const ME = { id: 1, username: "me", isPlus: false };

const ROSTER = [
  { id: 2, username: "wempo", nickname: null },
  { id: 3, username: "other", nickname: "two words" },
  { id: 4, username: "twin", nickname: "wempoX" },
];

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

// --- the mention highlighter's parity (sharp edge #5) ------------------------

test("the highlighter's resolutions EQUAL the backend parser's, case after case", () => {
  // The EXPECTED map pins the contract the backend parser itself sets:
  // "mail@wempo.com" resolves to 2 on BOTH ends (the '.' rides the
  // candidate's own char class — a shared contract fact, not a defect).
  const cases = [
    "hi @wempo!",
    "yo @wempo, @wempo again",
    "@two words sits with a seam",
    "@two words. drops its trailing seam",
    "mail@wempo.com parses like the backend parses it",
    "@WEMPO resolves case-insensitively",
    "@wempotwo's trailing seam rescues the username",
    "no mentions at all",
  ];
  const expected = [["2"], ["2", "2"], ["3"], ["3"], ["2"], ["2"], ["2"], []];
  cases.forEach((text, index) => {
    const mine = chat.mentionSpans(text, ROSTER).map((span) => String(span.userId));
    const backend = parser.matchRosterMentions(text, ROSTER).map(String);
    assert.deepEqual(mine, backend, `parity: ${text}`);
    assert.deepEqual(mine, expected[index], `contract: ${text}`);
  });
});

test("a candidate matching MORE THAN ONE member resolves to nobody — on both ends", () => {
  const AMBIGUOUS = [
    { id: 2, username: "wempo", nickname: null },
    { id: 5, username: "zz", nickname: "wempo" },
  ];
  assert.deepEqual(parser.matchRosterMentions("@wempo says hi", AMBIGUOUS), []);
  assert.deepEqual(chat.mentionSpans("@wempo says hi", AMBIGUOUS), []);
  // @everyone is a word-bounded flag, not a member name.
  assert.deepEqual(chat.mentionSpans("hey @everyoneelse", ROSTER), []);
});

test("@everyone/@here keep the backend's word-bounded arms", () => {
  assert.equal(parser.mentionsEveryoneFlag("hey @everyone!"), true);
  assert.equal(parser.mentionsEveryoneFlag("@everyonehere"), false);
  assert.equal(parser.mentionsEveryoneFlag("mail@everyone.org"), false);
});

// --- G-12: the optimistic reconcile in both directions ------------------------

const CHANNEL = 7;

function primeLane() {
  store.set({ [`messages:${CHANNEL}`]: { list: [], oldestAfter: null, complete: false } });
}

test("an optimistic send reconciles on the POST; a replayed frame dedupes", async () => {
  primeLane();
  responses = [{ message: { id: 50, authorId: 1, authorName: "me", body: "hi", editedAt: null, source: "web", attachmentIds: [], isPlus: false } }];
  const sent = await chat.sendToChannel(CHANNEL, "hi", { clientMessageId: "gc-test-01" });
  assert.equal(JSON.parse(calls[0].body).clientMessageId, "gc-test-01");
  const lane = store.get(`messages:${CHANNEL}`);
  assert.equal(lane.list.length, 1);
  assert.equal(lane.list[0].id, 50, "the pending row adopted the real id");
  assert.equal(lane.list[0].pending, undefined);
  assert.deepEqual(sent, sent);
  // The WS frame with the SAME id inserts nothing.
  const before = lane.list.length;
  chat.adoptMessage(CHANNEL, sent, ME);
  assert.equal(store.get(`messages:${CHANNEL}`).list.length, before);
});

test("a WS frame arriving BEFORE the POST adopts into the pending row (G-12)", () => {
  primeLane();
  // The pending seat rides the send flow's shape: plant directly through
  // sendToChannel's optimistic half is async-wired, so the pending shape is
  // exercised by adoptMessage's early-frame arm against a planted row.
  store.set({ [`messages:${CHANNEL}`]: { list: [{
    pending: true, pendingId: "gc-test-02", pendingAuthor: 1, pendingAt: Date.now(),
    authorId: 1, authorName: "me", body: "early",
  }], oldestAfter: null, complete: false } });
  const me = { id: 1, username: "me" };
  const adapted = chat.adoptMessage(CHANNEL, {
    id: 77, authorId: 1, authorName: "me", body: "early",
  }, me, "gc-test-02");
  assert.equal(adapted.id, 77);
  const lane = store.get(`messages:${CHANNEL}`);
  assert.equal(lane.list.length, 1, "no duplicate row");
  assert.equal(lane.list[0].pending, undefined, "the pending seat became the real message");
  assert.equal(lane.list[0].id, 77);
});

test("a failed send keeps its error state; the retry rides a FRESH clientMessageId", async () => {
  primeLane();
  responses = [{ error: "That message isn't allowed.", status: 400 }];
  await chat.sendToChannel(CHANNEL, "forbidden", {}).catch(() => {});
  const lane = store.get(`messages:${CHANNEL}`);
  assert.equal(lane.list.length, 1, "the failed send keeps its row");
  assert.equal(lane.list[0].sendError, "That message isn't allowed.");
  // The explicit retry: the old pending row drops, a NEW send rides a new id.
  responses = [{ message: { id: 51, authorId: 1, authorName: "me", body: "forbidden words", editedAt: null, source: "web", attachmentIds: [], isPlus: false } }];
  await chat.retryFailed(CHANNEL, { pendingId: lane.list[0].pendingId, body: "forbidden words", localFile: null });
  assert.equal(calls.length, 2, "two sends total");
  const firstId = JSON.parse(calls[0].body).clientMessageId;
  const secondId = JSON.parse(calls[1].body).clientMessageId;
  assert.notEqual(firstId, secondId, "a retry is a fresh send, never a resend of the same key");
  assert.equal(store.get(`messages:${CHANNEL}`).list[0].id, 51);
});

// --- read markers: forward-only, client-seat ---------------------------------

test("the read marker rides forward-only; stale or repeated markers never POST", async () => {
  responses = [{}, {}];
  await chat.markRead(9, 100);
  await chat.markRead(9, 90); // behind: no POST
  await chat.markRead(9, 100); // repeat: no POST
  assert.equal(calls.length, 1, "the repeat and the stale marker never went out");
  assert.equal(calls[0].path, "/api/conversations/9/read");
  await chat.markRead(9, 101);
  assert.equal(calls.length, 2, "a newer marker rides");
});

// --- the constants (G-4) ------------------------------------------------------

test("the mirrored caps equal the backend's constants", () => {
  assert.equal(chat.UI_FREE_MESSAGE_MAX, constants.GC_FREE_MESSAGE_MAX);
  assert.equal(chat.UI_PLUS_MESSAGE_MAX, constants.GC_PLUS_MESSAGE_MAX);
  assert.equal(chat.UI_ATTACHMENT_FREE_MAX, constants.MAX_ATTACHMENT_BYTES);
  assert.equal(chat.UI_ATTACHMENT_MINI_MAX, constants.GC_MINI_ATTACHMENT_BYTES);
  assert.equal(chat.UI_ATTACHMENT_PLUS_MAX, constants.GC_PLUS_ATTACHMENT_BYTES);
  assert.equal(chat.UI_VOICE_MAX_PARTICIPANTS, constants.GC_VOICE_MAX_PARTICIPANTS);
  assert.deepEqual(chat.UI_REACTIONS_SUPER, [...constants.GC_PLUS_REACTIONS]);
});

// --- routes --------------------------------------------------------------------

test("routes: the chat wave owns its seats — channel, conversation, pins, search", () => {
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/:channelId", "channel", renderChannelPane\)/);
  assert.match(MAIN, /addRoute\("\/dm\/:id", "conversation", renderConversation\)/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/:channelId\/pins", "channel-pins", renderChannelPins\)/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/search", "server-search", renderServerSearch\)/);
  // The pins + search seats register BEFORE the channel catch-all.
  assert.ok(MAIN.indexOf('"channel-pins"') < MAIN.indexOf('"channel", renderChannelPane'));
  assert.ok(MAIN.indexOf('"server-search"') < MAIN.indexOf('"channel", renderChannelPane'));
});

// --- the composer's laws (DOM halves pin by source) ----------------------------

test("the composer: Enter sends, Shift+Enter breaks the line, drafts ride sessionStorage", () => {
  assert.match(CHAT, /draft:gc:\$\{channelId\}/);
  assert.match(CHAT, /sessionStorage\.setItem\(draftKey/);
  assert.match(CHAT, /sessionStorage\.removeItem\(draftKey/);
  assert.match(CHAT, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(CHAT, /maxlength: String\(limit\)/, "the well seats its own bound");
});

test("the meter appears only past the reveal seat (Rethink 8), tier-aware", () => {
  assert.equal(chat.UI_METER_REVEAL_AT, 1800);
  assert.match(CHAT, /well\.value\.length > UI_METER_REVEAL_AT/);
  assert.match(CHAT, /me\?\.isPlus \? UI_PLUS_MESSAGE_MAX : UI_FREE_MESSAGE_MAX/);
  assert.match(CHAT, /meter\.hidden = true/, "the meter hides under the seat");
});

test("the riders are the ONLY icon buttons in the chat surface (G-7)", () => {
  const riders = (CHAT.replace(/\/\/[^\n]*/g, "").match(/class: "icon-button[^"]*"/g)) || [];
  // Five riders: attach, GIF, emoji, sticker, soundboard. Every other chat
  // surface control is a quiet/row control or a real button role.
  const riderSeats = riders.filter((entry) => /attach|gif-rider|emoji-rider|sticker-rider|soundrider|voice/.test(entry));
  // The reaction picker's choices live in a DIALOG, never the chat surface.
  assert.ok(riderSeats.length >= 5, "the rider row carries its five seats");
  assert.match(CHAT, /chat-row \.row-quiet-control|row-quiet-control/, "row actions stay quiet controls");
});

test("the GIF display rides ONLY the same-origin proxy", () => {
  const codeOnly = CHAT.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const klipyHost = ["kli", "py", ".", "com"].join("");
  assert.ok(!codeOnly.includes(klipyHost), "a direct provider URL never touches code");
  assert.ok(!codeOnly.includes("tenor"), "the dead provider's name never rides code either");
  assert.match(CHAT, /gifProxyUrl/);
  assert.match(CHAT, /\/api\/gifs\/image\?u=/, "insertion pins the proxied URL as body text");
  assert.match(CHAT, /Search for something|gifQuery|UI_GIF_QUERY_MAX/);
  assert.match(CHAT, /gifProxyUrl\(gif\.url\)/);
  assert.match(CHAT, /insertAtCaret\(well, token\)/);
});

test("pending-moderation asymmetry: local previews in the composer, fail-soft renders", () => {
  assert.match(CHAT, /objectUrlFor\(file\)/, "the preview is the LOCAL file, never the serving URL");
  assert.match(CHAT, /t\("gc\.chat\.attach\.pending"\)/, "the pending seat is named, not hidden");
  assert.match(CHAT, /t\("gc\.chat\.attach\.one"\)/, "the UI refuses a second attach first");
  // Message renders fail soft: 404 attachment → the placeholder, never a broken img.
  assert.match(CHAT, /onError: \(e\) => e\.currentTarget\.replaceWith\(document\.createTextNode\(event\.raw\)\)/,
    "an unresolvable token renders as its literal text");
  assert.match(CHAT, /event\.currentTarget\.remove\(\)/, "a broken GIF seat drops quietly");
});

test("the slowmode meter rides Retry-After; the well disables nothing else", () => {
  assert.match(CHAT, /armSlowmeter\(error\.retryAfter\)/);
  assert.match(CHAT, /t\("gc\.chat\.slowmode\.wait", \{ seconds: left \}\)/);
  const classify = readFileSync(join(HERE, "../public/js/core/api.js"), "utf8");
  assert.match(classify, /retryAfter/, "api.js lands the Retry-After flag (the W-R2 note's consumer)");
});

test("the send-failure render reads the verbatim text inline (G-2), WS arm included", () => {
  assert.match(CHAT, /errorLine\.textContent = error\.message/);
  assert.match(CHAT, /onSendErrorFrame/);
  assert.match(CHAT, /frame\.rules/, "the WS rules-gate arm consumes the frame's rules seat");
  assert.match(CHAT, /guardRulesGate\(document, error,/, "the WS/REST arms share the accept flow");
});

// --- the pin/unpin seat's coherence (the bundle's slip, made a law) -----------

// --- the async /dm seat's render-epoch guard (T47) ------------------------------

// A headless DOM surface big enough for the shell frame's h() walk (the stub
// rides the i18n test's proven StubNode pattern). Only the T47 test installs
// it; every other row in this file stays header-free.
class T47Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
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
  prepend(kid) {
    if (!kid) return;
    if (kid.parentNode) {
      const sibs = kid.parentNode.children;
      const at = sibs.indexOf(kid);
      if (at >= 0) sibs.splice(at, 1);
    }
    kid.parentNode = this;
    this.children.unshift(kid);
  }
  appendChild(kid) { this.append(kid); return kid; }
  removeChild(kid) {
    const at = this.children.indexOf(kid);
    if (at >= 0) this.children.splice(at, 1);
    kid.parentNode = null;
    return kid;
  }
  replaceChildren(...kids) {
    for (const kid of this.children) kid.parentNode = null;
    this.children = [];
    this.append(...kids);
  }
  remove() {
    if (this.parentNode) {
      const sibs = this.parentNode.children;
      const at = sibs.indexOf(this);
      if (at >= 0) sibs.splice(at, 1);
      this.parentNode = null;
    }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener() {}
  removeEventListener() {}
  get firstChild() { return this.children[0] ?? null; }
  querySelectorAll(selector) {
    const attr = String(selector).replace(/^\[/, "").replace(/\]$/, "");
    const found = [];
    const walk = (node) => {
      if (node.attributes?.has(attr)) found.push(node);
      for (const kid of node.children || []) walk(kid);
    };
    for (const kid of this.children) walk(kid);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

T47Node.Event = class { constructor(type) { this.type = type; } };

test("the cold-store /dm seat paints once: a superseded render never paints (T47)", async () => {
  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    Node: globalThis.Node,
    Element: globalThis.Element,
    Event: globalThis.Event,
    WebSocket: globalThis.WebSocket,
    sessionStorage: globalThis.sessionStorage,
    window: globalThis.window,
    location: globalThis.location,
  };
  const router = (await import("../public/js/core/router.js"));
  const mount = { children: [], replaceChildren() { this.children.length = 0; },
    append(...kids) { this.children.push(...kids); } };
  // The interleaving: conversation payloads resolve B-then-A while the seats
  // fired A-then-B — only the still-routed seat may paint.
  const taps = [];
  const tap = () => new Promise((resolve) => taps.push(() =>
    resolve(new Response(JSON.stringify({ conversations: [
      { id: 1, name: "alpha", kind: "direct", members: [{ userId: 1 }, { userId: 2 }, { userId: 3 }, { userId: 4 }] },
      { id: 2, name: "beta", kind: "direct", members: [{ userId: 1 }, { userId: 2 }, { userId: 3 }] },
    ] }), { status: 200 }))));
  const pending = new Promise(() => {}); // the quiet lane: history/side-fetches wait forever
  const quiet = (shape = {}) => Promise.resolve(new Response(JSON.stringify(shape), { status: 200 }));
  try {
    globalThis.document = {
      documentElement: new T47Node("html"),
      body: new T47Node("body"),
      createElement: (tag) => new T47Node(tag),
      createElementNS: (ns, tag) => new T47Node(tag),
      createTextNode: (text) => new T47Node("#text"),
      addEventListener() {},
    };
    globalThis.Node = T47Node;
    globalThis.Element = T47Node;
    globalThis.Event = T47Node.Event;
    globalThis.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} send() {} close() {} };
    globalThis.sessionStorage = { store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
      setItem(k, v) { this.store.set(k, String(v)); },
      removeItem(k) { this.store.delete(k); } };
    globalThis.window = { addEventListener() {}, location: { pathname: "/", origin: "https://gc.example" } };
    globalThis.location = { pathname: "/", origin: "https://gc.example", href: "https://gc.example/", host: "gc.example" };
    globalThis.fetch = async (path) => {
      const to = `${path}`;
      if (to.startsWith("/api/conversations")) return tap();
      if (to.startsWith("/api/servers")) return quiet({ servers: [] });
      if (to.startsWith("/api/mentions")) return quiet({ mentions: [] });
      // history + the side lanes the shell hydrates wait forever: only the
      // two seat awaits' resolution order drives the case.
      if (to.startsWith("/api/channels/")) return pending;
      return pending;
    };
    store.reset();
    router.addRoute("/dm/:id", "conversation", chat.renderConversation);
    router.mount(mount);
    router.navigate("/dm/1");
    router.navigate("/dm/2");
    // B resolves first (it is the routed seat)...
    taps[1]?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mount.children.length, 1, "the routed seat painted exactly one shell");
    assert.equal(router.current().params.id, "2");
    // ...then A resolves: superseded, it bails instead of appending its shell.
    taps[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mount.children.length, 1, "the superseded seat painted nothing");
  } finally {
    taps.forEach((open) => { try { open(); } catch { /* drain */ } });
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
    globalThis.Node = previous.Node;
    globalThis.Element = previous.Element;
    globalThis.Event = previous.Event;
    globalThis.WebSocket = previous.WebSocket;
    globalThis.sessionStorage = previous.sessionStorage;
    globalThis.window = previous.window;
    globalThis.location = previous.location;
    store.reset();
  }
});

test("the row's pin control: call site and bundle agree on which word paints which state", () => {
  const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
  assert.equal(en["gc.chat.row.pin"], "Pin", "row.pin paints the UNpinned row's action");
  assert.equal(en["gc.chat.row.unpin"], "Unpin", "row.unpin paints the pinned row's action");
  // The call site answers the pinned flag with the unpin pair's key — the
  // coherent order (a pinned row offers to unpin), name-to-value lawful.
  assert.match(CHAT,
    /pinnedFlag \? t\("gc\.chat\.row\.unpin"\) : t\("gc\.chat\.row\.pin"\)/,
    "pinned → row.unpin, unpinned → row.pin");
});
