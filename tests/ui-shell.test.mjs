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

// The shell. Pins the W-R1 contracts by source (the browser half renders;
// node pins the bytes): the theme engine is Kit's, the door tile is WEMPO,
// the first-run screen is the ONE screen, and the placeholder routes the
// later waves re-register carry the names they replace.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SHELL = readFileSync(join(HERE, "../public/js/ui/shell.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
const CSS = readFileSync(join(HERE, "../public/styles.css"), "utf8");

test("the theme engine is the vendored Kit — no bespoke theme module remains", () => {
  assert.match(SHELL, /import \{ makeAppearance \} from "\.\.\/vendor\/frontload\/tokens\.mjs";/);
  assert.match(SHELL, /themeKey: "goober-theme"/);
  assert.match(SHELL, /legacyThemeKeys: \["forum-theme"\]/, "the forum key reads along only");
  assert.doesNotMatch(SHELL, /localStorage\.setItem\("goober-theme/,
    "the engine writes the theme family; the shell never does (T81's goober-hc / goober-font-scale are their own storage family per the spec's §3 — docs/drafts/t81-a11y-theme-spec.md)");
  assert.match(SHELL, /setThemeChoice\(document, localStorage, next\)/);
  assert.match(SHELL, /chromeColors: \{ brand: \{ light: "#f7efdc", dark: "#131b27" \} \}/,
    "browser chrome follows the forum palette");
});

test("the door tile is WEMPO's face; Blaxel stays on the CONTENTS", () => {
  assert.match(SHELL, /src: "\/assets\/wempo\.png"/);
  assert.doesNotMatch(SHELL, /text: "GC"/, "the old GC-tile door is gone");
  assert.match(SHELL, /\/assets\/blaxel\.png/, "Blaxel decorates first-run contents");
  // Never both in the same moment's voice: the home tile and the first-run
  // panes live in different moments (door vs pane body).
  const tile = SHELL.slice(SHELL.indexOf("function homeTile"), SHELL.indexOf("let serversLoading"));
  assert.doesNotMatch(tile, /blaxel/, "the door tile carries no Blaxel");
});

test("first run is ONE screen: You're in. + the two next actions, nothing else", () => {
  assert.match(SHELL, /t\("gc\.shell\.home\.heading"\)/, "the heading rides the en bundle's key");
  assert.match(SHELL, /t\("gc\.shell\.home\.body"\)/, "the next-action copy rides its key");
  const firstRun = SHELL.slice(SHELL.indexOf("function homePane"), SHELL.indexOf("function mainPane"));
  assert.match(firstRun, /servers\.length === 0/);
  assert.doesNotMatch(firstRun, /class: "button/, "a first-run screen offers, it doesn't commit");
});

test("AGPL §13's source-offer rides the user footer as a quiet anchor", () => {
  const EN = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
  assert.match(SHELL, /const GOOBER_SOURCE_URL = "https:\/\/github\.com\/Wempo-s-Silly-Projects\/GooberCord"/,
    "the offer points at the canonical repo (verified against the remote)");
  const foot = SHELL.slice(SHELL.indexOf("function userBlock"), SHELL.indexOf("// --- the main pane"));
  assert.match(foot, /href: GOOBER_SOURCE_URL/,
    "the network-serving UI carries the visible source link (§13), not just the repo");
  assert.match(foot, /text: t\("gc\.shell\.user\.source"\)/, "the §13 copy rides the en bundle's key");
  assert.match(foot, /rel: "noopener noreferrer"/, "an external nav never hands the opener");
  assert.equal(EN["gc.shell.user.source"], "Source (AGPLv3)", "the row is quiet chrome, the license name verbatim");
});

test("the route seats survive the wave re-registrations (by name)", () => {
  // W-R1 regression: renderShell's own signature is (route, paneOverride) —
  // handing it the router's mount node as a "seat" made shell.js frame.append
  // the mount node into a detached frame (the signed-in "/" blank page).
  // The home seat is a real (route, mount) render, placeholder idiom.
  assert.doesNotMatch(MAIN, /addRoute\("\/", "home", renderShell\)/,
    "renderShell is (route, paneOverride), never a mount-seat render");
  assert.match(SHELL, /export function homeRoute\(route, mount\) \{\n  mount\.append\(renderShell\(route\)\);\n\}/,
    "the home seat builds the frame and appends the frame into the router's mount");
  assert.match(MAIN, /addRoute\("\/", "home", homeRoute\)/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId", "server", serverPlaceholder\)/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/:channelId", "channel", renderChannelPane\)/);
  assert.match(MAIN, /appearance\.applyAppearance\(doc, win\.localStorage\)/,
    "the Kit engine applies theme + skin + chrome at boot");
});

test("the shell's store contract keys stay exactly as the waves inherit them", () => {
  const keys = [...SHELL.matchAll(/store\.(?:get|set)\(\{? ?"?([A-Za-z]+)"?\)?/g)]
    .map((m) => m[1]);
  for (const key of ["servers", "activeServerId", "activeChannelId", "user"]) {
    assert.ok(keys.includes(key), key);
  }
});

test("the stylesheet speaks the forum's tokens in both themes, dark on the ground", () => {
  // Dark default: the unattr :root carries the forum's dark block values.
  assert.match(CSS, /--desk: #131b27/);
  assert.match(CSS, /--paper: #1d2836/);
  assert.match(CSS, /--ink: #e8e4d8/);
  assert.match(CSS, /--desk-dot: #26344a/);
  // Light sister keyed by data-theme.
  const light = CSS.slice(CSS.indexOf(':root[data-theme="light"]'));
  for (const [token, value] of [
    ["--desk: #f7efdc"], ["--paper: #fffaf0"], ["--ink: #24364a"],
    ["--desk-dot: #cfbf9c"], ["--muted: #586777"],
  ]) {
    assert.ok(light.includes(token), token + " in the light sister");
  }
  for (const section of ["tokens", "base", "buttons", "shell: the frame"]) {
    assert.match(CSS, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the ${section} section exists in the layer order`);
  }
  assert.doesNotMatch(CSS, /@font-face/, "no fonts bundled — system stacks only");
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /data-skin/,
    "no skin system: the rethink killed Discord cosplay");
});

test("the three-pane grid at the brief's sizes", () => {
  assert.match(CSS, /grid-template-columns: 72px 250px minmax\(0, 1fr\) 240px;/);
  assert.match(CSS, /--button-radius: 0\.45rem 0\.65rem 0\.4rem 0\.55rem;/);
});

// --- the social-lane live repaint (the frozen-paint pins) --------------------
//
// The signed-in boot paints the shell BEFORE the /api/conversations payload
// lands; the receipt (spot-result.json) held the store's conversations at an
// array while the DM seat still read "Fetching" seconds later — nothing in
// the client subscribed to the social keys. These pins follow the
// connection-strip subscriber idiom (renderShell's one live seat) and the
// i18n binding pass (initI18n resolution → applyDom's sweep) for the
// humanized-tail pre-catalog paint.
//
// ORDER CONTRACT: the i18n catalog is module state — the pre-catalog pin
// below must run before any other test in this file seats a bundle.

// A faithful-enough rail stub: reparenting append/remove, replaceWith swaps
// in place, and className matches answer querySelector so the repaint's
// node-local edits are observable headlessly.
class RailStubNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.attributes = new Map();
    this.dataset = {};
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
  replaceWith(kid) {
    if (!this.parentNode) return;
    const at = this.parentNode.children.indexOf(this);
    this.parentNode.children[at] = kid;
    kid.parentNode = this.parentNode;
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, fn) {
    (this.listeners ??= new Map()).set(type, [...(this.listeners?.get(type) ?? []), fn]);
  }
  querySelector(selector) {
    return railStub(this, selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    return railStub(this, selector);
  }
}

function railStub(node, selector) {
  const name = String(selector);
  const found = [];
  const match = (candidate) => {
    if (name.startsWith(".")) {
      return String(candidate.className).split(/\s+/).includes(name.slice(1));
    }
    const attr = name.replace(/^\[/, "").replace(/\]$/, "");
    return candidate.attributes?.has(attr) ?? false;
  };
  const walk = (walked) => {
    if (match(walked)) found.push(walked);
    for (const kid of walked.children ?? []) walk(kid);
  };
  for (const kid of node.children ?? []) walk(kid);
  return found;
}

function textOf(node) {
  let text = node.textContent ?? "";
  for (const kid of node.children ?? []) text += textOf(kid);
  return text;
}

const EN_BUNDLE = {
  "gc.shell.social.fetching": "Fetching conversations…",
  "gc.shell.social.none": "No conversations yet — start one from a member card.",
  "gc.shell.nav.dm": "Direct messages",
  "gc.shell.social.friendsRequests": "Friends & requests",
  "gc.shell.mentions.loading": "…",
};

const store = (await import("../public/js/core/store.js")).default;
const shell = await import("../public/js/ui/shell.js");

function installShellStubs({ enBundle = null } = {}) {
  const previous = {
    node: globalThis.Node,
    document: globalThis.document,
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
  };
  const holder = Object.assign(new RailStubNode("#document"), {
    createElement: (tag) => new RailStubNode(tag),
    createElementNS: (ns, tag) => new RailStubNode(tag),
  });
  holder.createTextNode = (text) => { const node = new RailStubNode("#text"); node.textContent = String(text); return node; };
  holder.documentElement = new RailStubNode("html");
  holder.body = new RailStubNode("body");
  globalThis.Node = RailStubNode;
  globalThis.document = holder;
  globalThis.localStorage = {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
  };
  globalThis.fetch = async (path) => {
    const url = String(path);
    if (url.startsWith("/locales/en.json")) {
      return enBundle
        ? new Response(JSON.stringify(enBundle), { status: 200 })
        : new Response("Not found.", { status: 404 });
    }
    if (url.startsWith("/api/servers")) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    }
    // /api/mentions and /api/conversations stay unanswered: the DM seat must
    // hold its pre-arrival paint, the ARRIVAL step is what drives the pin.
    return new Response("Not found.", { status: 404 });
  };
  store.reset();
  return () => {
    globalThis.Node = previous.node;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.localStorage = previous.localStorage;
  };
}

function dmSeatText(frame) {
  return textOf(frame.querySelector(".dm-section") ?? frame);
}

function seatLoader(frame) {
  // The DM seat's loader/empty-state node (the rail's own p, never the pane's)
  return frame.querySelector(".dm-section")?.querySelector(".empty-state") ?? null;
}

test("the pre-catalog DM seat repaints when initI18n resolves (the humanized-tail pin)", async () => {
  // Catalog EMPTY at paint: t() renders the humanized key tail — then the
  // bundle's resolve (the loader's own applyDom sweep) repaints the seat.
  const restore = installShellStubs({ enBundle: EN_BUNDLE });
  try {
    const { initI18n } = await import("../public/js/i18n.js");
    store.set({ servers: [], user: null });
    const frame = shell.renderShell({ name: "home", params: {} }, null);
    globalThis.document.append(frame);
    assert.equal(seatLoader(frame)?.textContent, "Fetching", "the pre-catalog paint is the humanized key tail");
    await initI18n(); // the boot's unawaited lane resolves — the sweep repaints
    assert.match(seatLoader(frame)?.textContent ?? "", /Fetching conversations…/,
      "initI18n's resolution repaints the t()-direct painted node");
  } finally {
    restore();
  }
});

test("a conversations arrival repaints the DM seat away from 'Fetching'", async () => {
  const restore = installShellStubs({ enBundle: EN_BUNDLE });
  try {
    const { initI18n } = await import("../public/js/i18n.js");
    await initI18n(); // the catalog seats before paint (the healthy-catalog case)
    store.set({ servers: [], user: null });
    const frame = shell.renderShell({ name: "home", params: {} }, null);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the boot loads settle
    assert.match(dmSeatText(frame), /Fetching conversations…/, "no arrivals yet: the seat paints its pre-arrival state");
    store.set({
      conversations: [{
        id: 7,
        name: "Ada",
        unread: 2,
        members: [{ userId: 1, username: "Ada" }, { userId: 2, username: "Bob" }],
      }],
    });
    assert.doesNotMatch(dmSeatText(frame), /Fetching conversations…/, "the arrival repainted the seat through the store subscription, no route re-render");
    assert.ok(frame.querySelector(".dm-row"), "the thread's row paints from the store truth");
    assert.match(dmSeatText(frame), /Ada/, "the DM seat carries the thread's label");
    assert.match(dmSeatText(frame), /2/, "the unread pill paints");
  } finally {
    restore();
  }
});

test("an empty conversations arrival renders the empty state, not 'Fetching'", async () => {
  const restore = installShellStubs({ enBundle: EN_BUNDLE });
  try {
    const { initI18n } = await import("../public/js/i18n.js");
    await initI18n(); // seat the en floor for the assertions' copy
    store.set({ servers: [], user: null });
    const frame = shell.renderShell({ name: "home", params: {} }, null);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the boot loads settle
    assert.match(dmSeatText(frame), /Fetching conversations…/, "the uninitialized key holds the seat");
    store.set({ conversations: [] }); // the receipt's array(0) landing
    assert.doesNotMatch(dmSeatText(frame), /Fetching conversations…/, "the empty list repaints the seat");
    assert.match(dmSeatText(frame), /No conversations yet/, "the empty state paints, never the loader");
    assert.equal(frame.querySelector(".dm-row"), null, "an empty list paints no thread rows");
  } finally {
    restore();
  }
});
