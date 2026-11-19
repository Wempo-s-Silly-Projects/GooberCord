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

// Cycle-15 panels — the go-haywire-c15 fix lane: the bookmarks panel's
// saved-stamp guard (F1), the quests payload's null-row guard (F2), the
// claim-disabled sibling ride (F3), the bookmarks lane's one literal (F4),
// the unseated-quest-kind safe seat (F5 + gc.economy.quests.other), the
// ja/zh/ar/ru `_one` plural-arm fills, and the emoji intake headroom
// constant. The F1/F2 pins render the real module paint headlessly (the
// i18n.test.mjs StubNode idiom); the LOW rides ride source-reads (the
// wave10-panels idiom).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const BOOKMARKS_UI = read("public/js/ui/bookmarks.js");
const ECONOMY = read("public/js/ui/economy.js");
const EMOJI = read("api/emoji.mjs");

const BUNDLES = ["en", "es", "de", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The seven plural-arm seats en carries (c15 i18n ride): every bundle must
// seat them too — the en arms are the parity law's reference shape.
const ONE_SEATS = [
  "gc.economy.claim.button_one",
  "gc.settings.join.serverRow_one",
  "gc.settings.invites.uses_one",
  "gc.economy.items.cost_one",
  "gc.economy.items.uses_one",
  "gc.economy.items.costPlus_one",
  "gc.mod.prune.confirm_one",
];

// --- the headless render rig (the i18n.test.mjs StubNode idiom) -----------------

class StubNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.textContent = "";
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
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener() {}
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
}

// The fetch stub serves the real en bundle (the t() floor) plus per-test
// API fixtures keyed by their path prefix; anything unstubbed answers 404
// (api() throws, the callers' catches hold it).
const fixtures = new Map();
const previousFetch = globalThis.fetch;
const previousLocalStorage = globalThis.localStorage;

globalThis.fetch = async (path) => {
  const seat = String(path).split("?")[0];
  if (seat === "/locales/en.json") {
    return new Response(read("public/locales/en.json"), { status: 200 });
  }
  if (fixtures.has(seat)) {
    return new Response(JSON.stringify(fixtures.get(seat)), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "unstubbed: " + seat }), { status: 404 });
};
globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, String(value)); },
  removeItem(key) { this.store.delete(key); },
};
globalThis.Node = StubNode;
globalThis.document = {
  documentElement: new StubNode("html"),
  createElement: (tag) => new StubNode(tag),
  createElementNS: (ns, tag) => new StubNode(tag),
  createTextNode: (text) => { const node = new StubNode("#text"); node.textContent = String(text); return node; },
  body: new StubNode("body"),
  querySelector: () => null,
  querySelectorAll: () => [],
};

const store = (await import("../public/js/core/store.js")).default;
const i18n = await import("../public/js/i18n.js");
await i18n.initI18n();
const bookmarks = await import("../public/js/ui/bookmarks.js");
const economy = await import("../public/js/ui/economy.js");

// The tree walk: every element painted under `root` carrying `className`
// (the stub's class rides either the className setter or the attribute map).
function findAll(root, className) {
  const found = [];
  const walk = (node) => {
    const classes = String(node.className ?? "")
      + " " + String(node.attributes?.get("class") ?? "");
    if (classes.split(" ").includes(className)) found.push(node);
    for (const kid of node.children || []) walk(kid);
  };
  walk(root);
  return found;
}

// The leaf text: the stub carries no aggregated textContent, so the walker
// gathers the text seats (the #text leaves the dom.js h() paints).
function textOf(node) {
  if ((node.children?.length ?? 0) === 0) return String(node.textContent ?? "");
  let out = "";
  for (const kid of node.children) out += textOf(kid);
  return out;
}

test.beforeEach(() => {
  fixtures.clear();
  store.reset();
});

// --- F1: the saved-stamp guard (bookmarks.js) -----------------------------------

// The backend pointer contract reads saved_at as a unix-seconds number
// (bookmarks.mjs:128 Number(...) read) — a non-finite seat (absent, NaN,
// Infinity, a garbage string) paints the "—" dash seat (the codebase's dash
// idiom, economy.js's tenureStartedAt twin), never a RangeError throw that
// kills the whole panel render.
test("an absent, NaN, Infinity or non-numeric savedAt paints the dash seat — the panel mounts, no throw", () => {
  const rows = [
    { id: 1, messageId: 4, savedAt: "garbage" },
    { id: 2, messageId: 5 },
    { id: 3, messageId: 6, savedAt: NaN },
    { id: 4, messageId: 7, savedAt: Infinity },
    { id: 5, messageId: 8, savedAt: 1700000000 }, // the contract's own shape
  ];
  store.set({ bookmarks: rows });
  const mount = new StubNode("main");
  assert.doesNotThrow(() => bookmarks.renderBookmarksPanel({ params: {} }, mount),
    "a malformed pointer seat must never throw out of the sync paint");

  const stamps = findAll(mount, "bookmark-when");
  assert.equal(stamps.length, rows.length, "every row paints its when-seat");
  const dashes = stamps.filter((span) => textOf(span).includes("—"));
  assert.equal(dashes.length, 4, "the four non-finite seats paint the dash");
  const stampRows = stamps.filter((span) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(textOf(span)));
  assert.equal(stampRows.length, 1,
    "the contract-tight row keeps painting the stamp (bookmarks.mjs:128's Number read)");
});

test("the guard rides savedStamp's seat — the finite check is in the source", () => {
  assert.match(BOOKMARKS_UI, /function savedStamp\(savedAt\) \{/,
    "the dash seats ride the one savedStamp helper");
  assert.match(BOOKMARKS_UI, /Number\.isFinite\(/, "the finite check guards the multiply");
});

// The contract row: a real unix-seconds pointer still paints its stamp.
test("a numeric savedAt keeps painting the stamp — the guard never swallows contract rows", () => {
  store.set({ bookmarks: [{ id: 9, messageId: 2, savedAt: 1700000000 }] });
  const mount = new StubNode("main");
  bookmarks.renderBookmarksPanel({ params: {} }, mount);
  const stamps = findAll(mount, "bookmark-when");
  assert.equal(stamps.length, 1);
  assert.match(textOf(stamps[0]), /2023-11-14 22:13/,
    "1700000000 unix seconds renders the UTC minute");
});

// --- F4: the bookmarks lane constant (bookmarks.js) ------------------------------

test("the bookmarks lane literal seats ONCE — the lane key is a named constant", () => {
  assert.match(BOOKMARKS_UI, /const BOOKMARKS_LANE = "bookmarks";/,
    "the lane key is defined once, the STORE_KEY idiom");
  const code = BOOKMARKS_UI.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(code.match(/"bookmarks"/g)?.length, 1,
    "one literal seat: the constant's own line — the five store-lane call sites read the constant");
  assert.equal(code.match(/store\.get\("bookmarks"\)/g)?.length ?? 0, 0, "no raw-key get");
  assert.equal(code.match(/store\.set\(\{ bookmarks:/g)?.length ?? 0, 0, "no raw-key set");
  assert.ok(BOOKMARKS_UI.includes("store.get(BOOKMARKS_LANE)"), "the getter rides the constant");
  assert.ok(BOOKMARKS_UI.includes("store.set({ [BOOKMARKS_LANE]:") || BOOKMARKS_UI.includes("[BOOKMARKS_LANE]:"),
    "the setters ride the computed constant key");
});

// --- F2: the quests null-row guard (economy.js) ----------------------------------

// A null row inside the quests payload array must never throw inside
// renderShop's loadShop().then chain (economy.js:328) — the guard drops it
// and the other rows + the sibling panels paint.
test("a null row in the quests payload is dropped — the panel paints the real rows, the shop mounts", async () => {
  fixtures.set("/api/coins/shop", { balance: 250, daily: { grant: 25, claimedToday: false }, items: [] });
  store.set({ quests: { quests: [
    { kind: "message", goal: 20, progress: 5, complete: false },
    null,
    { kind: "voice", goal: 2, progress: 1, complete: false },
  ], claim: { claimed: false, reward: 25 } } });
  const mount = new StubNode("main");
  economy.renderShop(null, mount);
  await new Promise((resolve) => setImmediate(resolve)); // the payload's microtask chain flushes

  // The chrome's own error seats (claim/gift/items) paint empty; a thrown
  // paint chain would answer the shop crash line WITH text.
  const errors = findAll(mount, "form-error");
  assert.ok(errors.every((line) => textOf(line) === ""),
    "no error paint — a null row is a data wrinkle, not a shop failure");
  const questRows = findAll(mount, "quest-row");
  assert.equal(questRows.length, 2, "the two real rows paint; the null row drops");
  assert.match(textOf(questRows[0]), /5 \/ 20/, "the goal seats paint from the payload");
  assert.match(textOf(questRows[1]), /1 \/ 2/, "the second real row paints past the dropped null");
});

// --- F2 source pin ---------------------------------------------------------------

test("the quests payload row build guards the rows before the map", () => {
  assert.match(ECONOMY, /\(quests\.quests \|\| \[\]\)\.filter\(Boolean\)\.map\(/,
    "the null-row guard sits on the mapped rows source");
});

// --- F3: the claim-disabled sibling ----------------------------------------------

test("the quests claim's disabled state reads the hoisted claimState local", () => {
  assert.match(ECONOMY, /claim\.disabled = !!claimState\?\.claimed;/,
    "the sibling rides the deslop-hoisted local, not a second optional chain");
  assert.doesNotMatch(ECONOMY, /claim\.disabled = !!quests\?\.claim\?\.claimed;/,
    "the missed sibling is gone");
});

// --- F5: the unseated quest kind ---------------------------------------------------

test("an unknown quest kind resolves to the seated generic, never the humanized key tail", () => {
  assert.match(ECONOMY, /"gc\.economy\.quests\.other"/,
    "the safe seat is the code-side generic");
  const mapSource = ECONOMY.match(/const QUEST_KIND_KEYS = \{[^}]*\}/)?.[0];
  assert.ok(mapSource, "the kind map carries the safe seat");
  // The three backend kinds still resolve through their seated keys; the
  // fallback for any OTHER kind is the seated generic — never . + kind.
  const source = ECONOMY.replace(/\/\/[^\n]*/g, "");
  assert.match(source, /questionKindKey|questKindKey[\s\S]*\?\? "gc\.economy\.quests\.other"/,
    "the fallback arm points at the seated generic");
  assert.doesNotMatch(source, /"gc\.economy\.quests\." \+ kind/,
    "no humanized key tail built from an unknown kind");
});

test("gc.economy.quests.other is seated in en and translated in every staged bundle", () => {
  assert.ok(typeof enData["gc.economy.quests.other"] === "string"
    && enData["gc.economy.quests.other"].length > 0, "en seats the generic");
  for (const langKey of ["es", "de", "fr", "pt", "ru", "ja", "zh", "ar"]) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    const value = bundle["gc.economy.quests.other"];
    assert.equal(typeof value, "string", `${langKey} seats the generic`);
    assert.ok(value.length > 0, `${langKey} seats real copy`);
    assert.notEqual(value, enData["gc.economy.quests.other"],
      `${langKey} translates the generic — no en placeholder`);
  }
});

// --- the i18n ride: the seven _one plural arms --------------------------------------

test("every bundle seats the seven _one arms en carries — the parity law's plural shape", () => {
  for (const langKey of BUNDLES) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    for (const key of ONE_SEATS) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
    }
  }
});

test("the undifferentiated bundles mirror their base rows; the ru filler is a real singular", () => {
  for (const langKey of ["ja", "zh"]) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    for (const key of ONE_SEATS) {
      const base = key.replace(/_one$/, "");
      assert.equal(bundle[key], bundle[base],
        `${langKey}'s ${key} mirrors its undifferentiated base row`);
    }
  }
  const ru = JSON.parse(read("public/locales/ru.json"));
  assert.notEqual(ru["gc.settings.join.serverRow_one"], ru["gc.settings.join.serverRow"],
    "ru's serverRow _one is the proper singular, not the base row's genitive plural");
  assert.match(ru["gc.settings.join.serverRow_one"], /\{\{name\}\}/, "the name seat survives");
  assert.match(ru["gc.settings.join.serverRow_one"], /\{\{count\}\}/, "the count seat survives");
});

// --- the emoji ride: the intake headroom constant -----------------------------------

test("the emoji intake headroom is a named exported constant — one seat, one use", () => {
  assert.match(EMOJI, /export const GC_EMOJI_REQUEST_HEADROOM_BYTES = 512 \* 1024;/,
    "the headroom literal is the named export, seat at the value it had");
  const code = EMOJI.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(code.match(/512 \* 1024/g)?.length, 1,
    "one literal seat: the constant's own line");
  assert.match(code, /maxRequestBytes: KIND\[kind\]\.fileMax \+ GC_EMOJI_REQUEST_HEADROOM_BYTES/,
    "the intake rides the constant, no behavior change");
});
