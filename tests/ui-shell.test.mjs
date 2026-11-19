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
  assert.doesNotMatch(SHELL, /localStorage\.setItem/, "the engine writes; the shell never does");
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
  assert.match(MAIN, /addRoute\("\/", "home", renderShell\)/);
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

// A transient failure must not wedge the rails: loadServers' guard reads the
// cache truth, and an empty ARRAY is truthy in JS — caching [] on the catch
// would make the guard permanently true and the rails never retry.
test("a failed servers list stores NULL (retryable), never the truthy empty array", () => {
  const start = SHELL.indexOf("async function loadServers");
  const end = SHELL.indexOf("/", SHELL.indexOf("export async function refreshServers"));
  const block = SHELL.slice(start, end);
  assert.ok(block, "loadServers + refreshServers block present");
  assert.match(block, /store\.set\(\{ servers: null \}\);/,
    "the catch stores null — the next route render's loadServers retries");
  assert.doesNotMatch(block, /store\.set\(\{ servers: \[\] \}\);/,
    "caching [] wedges the guard (empty array is truthy) and the rails never retry");
});

// The wave-25 no-copy sweep (T-R25-I18N-FIX): the pane-title and rail-title
// seats painted raw English — the keys already rode every bundle, so the
// paints now ride them too (R1 + R2 of the audit).
test("the pane and rail titles ride the bundles (wave-25 no-copy rows R1+R2)", () => {
  assert.match(SHELL, /class: "pane-title", text: t\("gc\.shell\.home\.title"\)/,
    "the home pane-title rides its key, never the literal");
  assert.match(SHELL, /class: "rail-title", text: t\("gc\.shell\.nav\.members"\)/,
    "the members rail-title rides the nav key, never the literal");
  const LANGS = ["en", "es", "de", "fr", "pt", "ru", "ar", "ja", "zh"];
  for (const key of ["gc.shell.home.title", "gc.shell.nav.members"]) {
    for (const lang of LANGS) {
      const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${lang}.json`), "utf8"));
      assert.ok(key in bundle, `${key} rides ${lang}.json`);
    }
  }
});

// The wave-25 phone shell (T-R25-SHELL-PHONE, the viewport-saboteur
// finding): under 640px the two fixed rails left a ~54px desk on a 320px
// viewport — the frame collapses to ONE pane, and the rails ride a
// shell-level drawer (the frame's own data-drawer state; the toggle and
// scrim are shell chrome, every contract otherwise untouched).
test("the phone shell collapses to one pane under 640px (shell grid + rails)", () => {
  const start = CSS.indexOf("@media (max-width: 640px)");
  const block = CSS.slice(start, CSS.indexOf("\n}", start));
  assert.ok(block, "the 640px media block is present");
  assert.match(block, /grid-template-columns: minmax\(0, 1fr\);/,
    "one column: the desk fills the phone viewport");
  assert.match(block, /\.rail-servers,\s*\n\s*\.rail-channels \{\s*\n\s*display: none;/,
    "the rails leave the phone grid");
  assert.match(block, /\[data-drawer="open"\] \.rail-servers/,
    "the drawer state re-seats the rails as an overlay");
  assert.match(block, /\.shell-scrim/, "the scrim seats under the drawer");
  assert.match(block, /\.phone-drawer-toggle/, "the shell-level drawer toggle");
  // The viewport-saboteur live-pass regression (781b9e2): the toggle node
  // appends unconditionally, so ABOVE 640px it must be display:none — a bare
  // in-flow button would auto-place into an implicit second grid row and
  // steal desk height (its click is a no-op while the rails are display:none).
  assert.match(CSS,
    /(\n|\/\*[^*]*\*\/\s*)\.phone-drawer-toggle \{\s*\n\s*display: none;/,
    "the toggle is silent by default — the 640px block turns it on");
  // The re-verify regression (the desktop fix's own slip): the media block
  // adds no specificity, so ORDER is the whole contract — the base silence
  // must sit BEFORE the 640px block in source, or the later display:none
  // wins at phone widths and the drawer becomes unreachable.
  assert.ok(CSS.indexOf(".phone-drawer-toggle { display: none; }")
    < CSS.indexOf("@media (max-width: 640px)"),
    "the base silence precedes the 640px block (source order is the contract)");
});

test("the phone drawer is a shell-level pane toggle (shell.js contract)", () => {
  assert.match(SHELL, /dataset\.drawer = open \? "open" : "closed"/, "the frame carries the drawer state");
  assert.match(SHELL, /phone-drawer-toggle/);
  assert.match(SHELL, /shell-scrim/, "the scrim closes the drawer");
  assert.match(SHELL, /t\("gc\.shell\.nav\.menu"\)/, "the toggle rides the bundles");
  for (const lang of ["en", "es", "de", "fr", "pt", "ru", "ar", "ja", "zh"]) {
    const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${lang}.json`), "utf8"));
    assert.ok("gc.shell.nav.menu" in bundle, `gc.shell.nav.menu rides ${lang}.json`);
  }
});

// The wave-25 desweep rows (T-R25-DESWEEP): a cross-tab theme write re-seats
// this tab in place (the guide's persistence law), and the verified-dead
// locale keys stay pruned. NOT in the set: the labelKey/nameHintKey-driven
// gc.expressions.* seats (expressions.js:79-85 t(kind.nameHintKey)), the
// dynamic item-key construction (economy.js:518 — the fx/frame/banner keys),
// the quest kinds' fallback seats (the deslop-HIGH pin's QUEST_KIND_KEYS
// resolution), and the deliberately seated gc.settings.boostTier.perks.upload
// (settings.js:224-228, the c19 MED-2 ruling).
test("a cross-tab goober-theme write re-seats theme + hint + chrome (row R9)", () => {
  assert.match(MAIN, /"storage"/, "the boot carries the storage listener");
  assert.match(MAIN, /"goober-theme"/, "the listener keys on the GC theme key");
  assert.match(MAIN, /syncColorSchemeContract\(doc, theme\)/,
    "the hint + chrome pair re-seat through the shared contract helper");
});

test("the pruned dead locale keys stay dead (wave-25 deslop set)", () => {
  const DEAD = [
    "gc.chat.dm.heading",
    "gc.social.dm.heading",
    "gc.social.dm.placeholder",
    "gc.chat.errors.notFound",
    "gc.chat.gif.unconfigured",
    "gc.chat.search.invalid",
    "gc.expressions.errors.exists",
    "gc.gate.refused",
  ];
  for (const lang of ["en", "es", "de", "fr", "pt", "ru", "ar", "ja", "zh"]) {
    const bundle = readFileSync(join(HERE, `../public/locales/${lang}.json`), "utf8");
    for (const key of DEAD) {
      assert.doesNotMatch(bundle, new RegExp(`"${key}"`), `${key} stays pruned from ${lang}`);
    }
  }
});
