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

// The locale lane: the binding pass (textContent/attribute setters only —
// locale JSON is data, never markup), the fallback chain lang → base script
// → en → visible key-tail, the plural rule seat, and en.json's integrity
// (its keys ride the <product>.<area>.<topic>.<element> scheme; server-class
// copy stays out — the server never localizes).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);

const I18N = readFileSync(join(HERE, "../public/js/i18n.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
const enData = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

const bundles = new Map();

// A faithful-enough DOM stub: setAttribute/getAttribute round-trips and
// remove() detaches, so the binding pass is observable headlessly.
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

const previousFetch = globalThis.fetch;
const previousLocalStorage = globalThis.localStorage;

globalThis.Node = StubNode;
globalThis.document = {
  documentElement: (globalThis.document?.documentElement) ?? new StubNode("html"),
  createElement: (tag) => new StubNode(tag),
  createElementNS: (ns, tag) => new StubNode(tag),
  createTextNode: (text) => { const node = new StubNode("#text"); node.textContent = String(text); return node; },
  body: new StubNode("body"),
};
globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, String(value)); },
  removeItem(key) { this.store.delete(key); },
};

const LOCALES = {
  en: {
    "gc.chat.pins.empty": "Nothing pinned in this channel yet.",
    "gc.chat.typing.someOne": "{{user}} is typing…",
    "gc.chat.search.placeholder": "Search this server",
    "gc.chat.count_one": "{{n}} message",
    "gc.chat.count_other": "{{n}} messages",
    "gc.gate.accept": "Accept and continue",
  },
  "zh-hans": { // the base-script chain: zh-hans → zh → en
    "gc.chat.pins.empty": "Nothing pinned here yet, in Chinese.",
  },
  ru: {
    "gc.chat.count_zero": "{{n}} сообщений",
    "gc.chat.count_one": "{{n}} сообщение",
    "gc.chat.count_few": "{{n}} сообщения",
    "gc.chat.count_many": "{{n}} сообщений",
  },
  fr: {
    "gc.chat.count_one": "{{n}} image",
    "gc.chat.count_other": "{{n}} images",
    "gc.chat.count_many": "{{n}} de many",
    "gc.chat.usesRow_one": "{{count}} utilisation",
    "gc.chat.usesRow_other": "{{count}} utilisations",
    "gc.chat.usesRow_many": "{{count}} de uses",
  },
  pt: {
    "gc.chat.count_one": "{{n}} ponto",
    "gc.chat.count_other": "{{n}} pontos",
    "gc.chat.count_many": "{{n}} de many",
  },
  es: {
    "gc.chat.count_one": "{{n}} punto",
    "gc.chat.count_other": "{{n}} puntos",
    "gc.chat.count_many": "{{n}} de many",
  },
};

globalThis.fetch = async (path) => {
  const file = String(path).replace(/^\/locales\//, "");
  const bundle = bundles.get(file);
  return bundle
    ? new Response(JSON.stringify(bundle), { status: 200 })
    : new Response("Not found.", { status: 404 });
};

const i18n = await import("../public/js/i18n.js");

function freshBundles(seeds) {
  bundles.clear();
  for (const [name, data] of Object.entries(seeds)) bundles.set(`${name}.json`, data);
}

test.beforeEach(() => {
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.store.clear();
  globalThis.document.documentElement.attributes.delete("lang");
});

test.after(() => {
  globalThis.fetch = previousFetch;
  globalThis.localStorage = previousLocalStorage;
});

// --- en.json + the shell's boot seam ------------------------------------------

test("en.json: every key rides the <product>.<area>.<topic>(.<element>) scheme", () => {
  const keys = Object.keys(enData);
  assert.ok(keys.length >= 190, `the seed carries the sweep's rows (${keys.length})`);
  for (const key of keys) {
    assert.match(key, /^gc(\.[a-z][a-zA-Z0-9]*)+(_(one|few|many|other|zero|two))?$/,
      `the dotted, no-spaces scheme rides (a trailing CLDR plural arm is the one lawful suffix): ${key}`);
  }
  for (const [key, value] of Object.entries(enData)) {
    assert.equal(typeof value, "string", `${key} holds text, not a shape`);
    assert.ok(value.length > 0 && value.length <= 250, `${key} is real copy`);
  }
  // Shared products do not bleed: the server-class copy stays OUT (the
  // server never localizes; the renderer catalogs only what IT paints).
  const values = Object.values(enData);
  assert.ok(!values.includes("That API endpoint does not exist."),
    "worker.mjs's 404 body never rides the client bundle");
  assert.ok(!values.includes("Not found."), "the same law, the generic 404 body");
});

test("the lifted gate ships exactly the nine en+all-bundle seats (stage-2, owner order)", () => {
  // The owner ordered the stage-2 lift (ja/zh/ar ride on owner authority;
  // the Firefox visual pass is DEFERRED by the owner's own decision — the
  // risk is disclosed in the commit body, not hidden). A stored human
  // choice may still name any seat (the loader's fail-open), this list
  // gates the navigator-derived seats only.
  assert.deepEqual(i18n.BUNDLE_LANGS, ["en", "es", "de", "fr", "pt", "ru", "ja", "zh", "ar"]);
});

test("the dir law: the ar seat flips documentElement to rtl, every other seat to ltr", async () => {
  const html = globalThis.document.documentElement;
  freshBundles({
    en: LOCALES.en,
    ar: { "gc.chat.pins.empty": "لا شيء مثبَّت في هذه القناة بعد." },
    "ar-eg": { "gc.chat.pins.empty": "لا شيء مثبَّت في هذه القناة بعد." },
  });
  try {
    html.dir = "";
    globalThis.localStorage.setItem("lang", "ar");
    await i18n.setLang("ar");
    assert.equal(html.dir, "rtl", "ar rides rtl on the root element");
    globalThis.localStorage.setItem("lang", "ar-EG");
    await i18n.setLang("ar-EG");
    assert.equal(html.dir, "rtl", "the regional ar seat keeps rtl — the base script rules");
    await i18n.setLang("en");
    assert.equal(html.dir, "ltr", "every non-ar seat is ltr");
  } finally {
    html.dir = "";
  }
});

test("setLang strips path/realm chars before the store and any fetch (ship-reviewer LOW-3)", async () => {
  const seen = [];
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (path) => { seen.push(String(path)); return previous(path); };
    globalThis.localStorage.setItem("lang", "../../etc/passwd");
    await i18n.setLang("../../etc/passwd");
    assert.equal(globalThis.localStorage.getItem("lang"), "etcpasswd",
      "only letters, digits and dashes survive — no traversal shape is stored");
    for (const path of seen) {
      assert.doesNotMatch(path, /\.\.|%2F|%2f/gi, `the loader's fetch URL never carries the refused chars: ${path}`);
    }
    globalThis.localStorage.setItem("lang", "ar-EG");
    await i18n.setLang("ar-EG");
    assert.equal(globalThis.localStorage.getItem("lang"), "ar-eg", "the lawful regional tag rides untouched");
  } finally {
    globalThis.fetch = previous;
  }
});

test("the raw-seat sweep keys pin (pins dialog, shell rails, document title)", () => {
  const pinned = {
    "gc.app.title": "GooberCord",
    "gc.chat.pins.close": "Close",
    "gc.chat.pins.note": "Newest first, exactly the channel keeps them.",
    "gc.chat.pins.title": "Pinned messages",
    "gc.shell.members.title": "Members",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(enData[key], value, `${key} rides the sweep's exact en copy`);
  }
});

// --- the carve gate: the byte-equal grandfather set, pinned exactly -----------

// The staged bundles grandfather some en bytes as their own copy (names of
// seats, code-side chips, cognate-class lines the realign rulings allowed).
// The law this pin carries: CLASSES NAME carves, KEYS ENUMERATE them — a
// class-based judgment list would re-open the blind spot, because a wrongly
// copied full sentence is not a cognate class. So the set is exhaustive and
// asserted in BOTH directions: any future equal-but-undeclared row fails
// red, and any future flex of a carved row (de "Roles" someday) fails red
// until this list updates with its ruling. Scan-proven against the staged
// files at the pin's commit; es/de reproduce the reviewer's census
// key-for-key, fr/pt/ru are this scan's enumeration.
const CARVE_GATES = {
  // ar enters the gate closing the wave-3 lane (the reviewer's declared two
  // at 212c883, scan-proven here key-for-key — the same set asserted third
  // time running, the declaration pattern stable).
  ar: [
    "gc.app.title",
    "gc.chat.gif.button",
    "gc.chat.gif.short",
    "gc.shell.mentions.loading",
  ],
  es: [
    "gc.app.title",
    "gc.chat.expressions.stickerTitle",
    "gc.chat.gif.button",
    "gc.chat.gif.short",
    "gc.expressions.kinds.stickers",
    "gc.mod.queue.summary",
    "gc.mod.timeout.choice",
    "gc.settings.channels.spoiler",
    "gc.settings.general",
    "gc.settings.roles.heading",
    "gc.shell.mentions.loading",
  ],
  de: [
    "gc.app.title",
    "gc.chat.gif.button",
    "gc.chat.gif.short",
    "gc.chat.pins.heading",
    "gc.chat.pins.link",
    "gc.mentions.inChannel",
    "gc.mentions.inThread",
    "gc.mod.card.heading",
    "gc.mod.timeout.choice",
    "gc.mod.timeout.label",
    "gc.settings.channels.kindText",
    "gc.settings.fields.name",
    "gc.settings.fields.position",
    "gc.settings.nav.server",
    "gc.shell.placeholder.serverTitle",
    "gc.shell.mentions.loading",
    "gc.social.presence.online",
  ],
  ja: [
    "gc.app.title",
    "gc.chat.gif.button",
    "gc.shell.mentions.loading",
  ],
  fr: [
    "gc.app.title",
    "gc.chat.compose.aria",
    "gc.chat.gif.button",
    "gc.chat.expressions.emojiTitle",
    "gc.chat.expressions.stickerTitle",
    "gc.chat.gif.short",
    "gc.expressions.kinds.emojis",
    "gc.expressions.kinds.stickers",
    "gc.mod.timeout.choice",
    "gc.settings.channels.spoiler",
    "gc.settings.fields.position",
    "gc.settings.nav.expressions",
    "gc.settings.roles.position",
    "gc.shell.mentions.loading",
    "gc.shell.nav.mentionsShort",
    "gc.social.dm.fallback",
    "gc.social.row.message",
  ],
  pt: [
    "gc.app.title",
    "gc.chat.expressions.emojiTitle",
    "gc.chat.expressions.stickerTitle",
    "gc.chat.gif.button",
    "gc.chat.gif.short",
    "gc.expressions.kinds.emojis",
    "gc.expressions.kinds.stickers",
    "gc.mod.queue.summary",
    "gc.mod.timeout.choice",
    "gc.settings.channels.spoiler",
    "gc.shell.mentions.loading",
  ],
  ru: [
    "gc.app.title",
    "gc.chat.expressions.emojiTitle",
    "gc.chat.expressions.stickerTitle",
    "gc.chat.gif.button",
    "gc.expressions.kinds.emojis",
    "gc.expressions.kinds.stickers",
    "gc.shell.mentions.loading",
  ],
  // ja/zh enter the gate with wave-3 (the values declared in 2c41d75, scan-
  // verified: ja one cognate-carve, zh three). Wave-3 intake passed with the
  // gate's first-subject claim true; they are gate-visible from this commit.
  zh: [
    "gc.app.title",
    "gc.chat.expressions.emojiTitle",
    "gc.chat.gif.button",
    "gc.expressions.kinds.emojis",
    "gc.shell.mentions.loading",
  ],
};

test("the carve gate: each staged bundle's byte-equal-to-en set is exactly its pinned list", () => {
  for (const [bundleName, pinned] of Object.entries(CARVE_GATES)) {
    const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${bundleName}.json`), "utf8"));
    const actual = Object.keys(bundle)
      .filter((key) => key in enData && typeof bundle[key] === "string" && bundle[key] === enData[key])
      .sort();
    assert.deepEqual(actual, [...pinned].sort(), `the ${bundleName} carve gate rides exactly its enumerated rows — both directions`);
  }
});

test("main.js wires the lane at boot: non-blocking, en-first", () => {
  assert.match(MAIN, /import \{ initI18n, t \} from "\.\/i18n\.js";/);
  assert.match(MAIN, /initI18n\(\)\.catch\(/, "the boot never awaits the locale lane");
});

test("the module carries the zero-innerHTML law", () => {
  assert.doesNotMatch(I18N, /innerHTML/, "locale content is data — the binding pass parses no markup");
  assert.match(I18N, /textContent/);
  assert.match(I18N, /force-cache/);
});

// --- t(): en lookup + interpolation -------------------------------------------

test("t() reads the en bundle and interpolates; a missing key humanizes its tail", async () => {
  await i18n.initI18n();
  assert.equal(i18n.t("gc.chat.pins.empty"), "Nothing pinned in this channel yet.");
  assert.equal(i18n.t("gc.chat.typing.someOne", { user: "wempo" }), "wempo is typing…");
  assert.equal(i18n.t("gc.chat.typing.someOne"),
    "{{user}} is typing…", "an absent var keeps its seat — never an empty hole");
  assert.equal(i18n.t("gc.chat.never.here"), "Here", "the key's tail humanizes — visible, never silent");
});

// --- the binding pass ----------------------------------------------------------

test("applyDom flips textContent, placeholder and aria through the setters only", async () => {
  await i18n.initI18n();
  const text = document.createElement("p");
  text.setAttribute("data-i18n", "gc.chat.pins.empty");
  const field = document.createElement("input");
  field.setAttribute("data-i18n-placeholder", "gc.chat.search.placeholder");
  const action = document.createElement("button");
  action.setAttribute("data-i18n-aria", "gc.gate.accept");
  const frame = document.createElement("div");
  frame.append(text, field, action);
  i18n.applyDom(frame);
  assert.equal(text.textContent, "Nothing pinned in this channel yet.");
  assert.equal(field.getAttribute("placeholder"), "Search this server");
  assert.equal(action.getAttribute("aria-label"), "Accept and continue");
  // Idempotent: the second pass paints the same truth.
  i18n.applyDom(frame);
  assert.equal(text.textContent, "Nothing pinned in this channel yet.");
});

test("applyDom paints a fake locale set through the swap — and never a markup parse", async () => {
  freshBundles({ en: LOCALES.en, "zh-hans": LOCALES["zh-hans"] });
  globalThis.localStorage.setItem("lang", "zh-hans");
  await i18n.initI18n();
  assert.equal(i18n.currentLang(), "zh-hans");
  const text = document.createElement("p");
  text.setAttribute("data-i18n", "gc.chat.pins.empty");
  const frame = document.createElement("div");
  frame.append(text);
  i18n.applyDom(frame);
  assert.equal(text.textContent, "Nothing pinned here yet, in Chinese.");
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});

// --- the fallback chain ---------------------------------------------------------

test("the chain rides lang → base script → en → the visible key-tail", async () => {
  freshBundles({ en: LOCALES.en, "zh-hans": LOCALES["zh-hans"] });
  globalThis.localStorage.setItem("lang", "zh-hans");
  await i18n.initI18n();
  assert.equal(i18n.t("gc.chat.pins.empty"), "Nothing pinned here yet, in Chinese.",
    "the chosen seat wins");
  assert.equal(i18n.t("gc.chat.search.placeholder"), "Search this server",
    "a key the seat lacks falls through the base script to the complete en bundle");
  assert.equal(i18n.t("gc.chat.never.missingTail"), "Missing tail",
    "a key NO bundle carries is the humanized tail — visible garbage, never silent");
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});

test("an unsupported navigator seat (or a 404 seat) fails open to English", async () => {
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.setItem("lang", "xx-wemponese");
  await i18n.initI18n();
  assert.equal(i18n.currentLang(), "xx-wemponese",
    "an explicit human choice tries its seat");
  assert.equal(i18n.t("gc.chat.pins.empty"), "Nothing pinned in this channel yet.",
    "a failed 404 bundle falls open to the en bundle, never a broken page");
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});

// --- the plural rule seat --------------------------------------------------------

test("t(key, {n}) picks key_<rule> and falls back key_other → key", async () => {
  await i18n.initI18n();
  assert.equal(i18n.t("gc.chat.count", { n: 1 }), "1 message");
  assert.equal(i18n.t("gc.chat.count", { n: 3 }), "3 messages", "the var interpolates into the branch");
  assert.equal(i18n.t("gc.chat.count", { n: 0 }), "0 messages");
});

test("ru's extra arms ride the rule table: one/few/many (+en's zero via the bundle)", async () => {
  freshBundles({ en: LOCALES.en, ru: LOCALES.ru });
  globalThis.localStorage.setItem("lang", "ru");
  await i18n.initI18n();
  assert.equal(i18n.t("gc.chat.count", { n: 1 }), "1 сообщение", "one");
  assert.equal(i18n.t("gc.chat.count", { n: 3 }), "3 сообщения", "few");
  assert.equal(i18n.t("gc.chat.count", { n: 5 }), "5 сообщений", "many");
  assert.equal(i18n.t("gc.chat.count", { n: 12 }), "12 сообщений", "many at 12–14");
  assert.equal(i18n.t("gc.chat.count", { n: 11 }), "11 сообщений", "11 rides many");
  assert.equal(i18n.t("gc.chat.count", { n: 101 }), "101 сообщение", "one rides 101");
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});

test("the ar-class rule carries zero/two/few/many at the rule seat", () => {
  // The rules are exposed through the module's seat: an ar bundle's demands
  // key the lookup. Direct-rule pins via the exported behavior path:
  // seed a tiny ar bundle and check the picks.
  freshBundles({ en: LOCALES.en, ar: {
    "gc.chat.count_zero": "{{n}} items zero",
    "gc.chat.count_two": "{{n}} items two",
    "gc.chat.count_few": "{{n}} items few",
    "gc.chat.count_many": "{{n}} items many",
  }});
  return i18n.setLang("ar").then(() => {
    assert.equal(i18n.t("gc.chat.count", { n: 0 }), "0 items zero");
    assert.equal(i18n.t("gc.chat.count", { n: 2 }), "2 items two");
    assert.equal(i18n.t("gc.chat.count", { n: 7 }), "7 items few");
    assert.equal(i18n.t("gc.chat.count", { n: 50 }), "50 items many");
  }).finally(() => {
    freshBundles({ en: LOCALES.en });
    globalThis.localStorage.removeItem("lang");
  });
});

test("fr/pt ride the shared CLDR block: one for 0..2-exclusive, many for exact round millions", async () => {
  freshBundles({ en: LOCALES.en, fr: LOCALES.fr, pt: LOCALES.pt, es: LOCALES.es });
  try {
    globalThis.localStorage.setItem("lang", "fr");
    await i18n.initI18n();
    assert.equal(i18n.t("gc.chat.count", { n: 0 }), "0 image", "0 rides one — fr's '0 image'");
    assert.equal(i18n.t("gc.chat.count", { n: 1 }), "1 image", "1 rides one");
    assert.equal(i18n.t("gc.chat.count", { n: 0.5 }), "0.5 image", "the (0,2) fractional arm picks 0.5 too");
    assert.equal(i18n.t("gc.chat.count", { n: 1.2 }), "1.2 image", "the decimal arm extends past 1 — red-capable under any n <= 1 predicate");
    assert.equal(i18n.t("gc.chat.count", { n: 1.5 }), "1.5 image", "'1,5 image' is singular-shaped per CLDR one = i = 0..1");
    assert.equal(i18n.t("gc.chat.count", { n: 1.9 }), "1.9 image", "1.9 stays one — both by the rule text and the oracle probe");
    assert.equal(i18n.t("gc.chat.count", { n: 2 }), "2 images", "2 exactly rides other");
    assert.equal(i18n.t("gc.chat.count", { n: 1e6 }), "1000000 de many",
      "the round-million many arm — corrects 1bcfa9e's 1e6→other pin against the CLDR 47 text (ICU probe: 1000000 → many)");
    assert.equal(i18n.t("gc.chat.count", { n: 1500000 }), "1500000 images", "not an exact round million — other");
    assert.equal(i18n.t("gc.chat.count", { n: 1000010 }), "1000010 images", "a million plus 10 — other");
    assert.equal(i18n.t("gc.chat.count", { n: 999999 }), "999999 images", "just under the arm — other");
    globalThis.localStorage.setItem("lang", "pt");
    await i18n.setLang("pt");
    assert.equal(i18n.t("gc.chat.count", { n: 0 }), "0 ponto", "0 rides one in pt — the en-map would route it to other");
    assert.equal(i18n.t("gc.chat.count", { n: 1 }), "1 ponto", "1 rides one in pt");
    assert.equal(i18n.t("gc.chat.count", { n: 1.2 }), "1.2 ponto", "pt shares the (1,2) decimal arm — boundary pin mirrored");
    assert.equal(i18n.t("gc.chat.count", { n: 1.9 }), "1.9 ponto", "pt 1.9 stays one — boundary pin mirrored");
    assert.equal(i18n.t("gc.chat.count", { n: 2 }), "2 pontos", "2 rides other in pt");
    assert.equal(i18n.t("gc.chat.count", { n: 1e6 }), "1000000 de many", "pt shares the block's many arm verbatim");
    globalThis.localStorage.setItem("lang", "es");
    await i18n.setLang("es");
    assert.equal(i18n.t("gc.chat.count", { n: 1 }), "1 punto", "es one is exactly n = 1");
    assert.equal(i18n.t("gc.chat.count", { n: 0 }), "0 puntos", "es 0 rides other — unlike fr/pt, red under any fr-style arm");
    assert.equal(i18n.t("gc.chat.count", { n: 1e6 }), "1000000 de many", "es rides the round-million many arm the en fallback denied");
    assert.equal(i18n.t("gc.chat.count", { n: 1.5 }), "1.5 puntos", "es one is exact-1 only — 1.5 rides other, red under any fr-style arm");
    assert.equal(i18n.t("gc.chat.count", { n: 2000000 }), "2000000 de many", "es many extends to every round million");
    assert.equal(i18n.t("gc.chat.count", { n: 1000010 }), "1000010 puntos", "not a round million — other");
  } finally {
    freshBundles({ en: LOCALES.en });
    globalThis.localStorage.store.clear();
    await i18n.initI18n();
  }
});

test("the plural seat engages on vars.count — the grammar keys' own var (the seam that makes the staged branch rows live)", async () => {
  freshBundles({ en: LOCALES.en, fr: LOCALES.fr });
  try {
    globalThis.localStorage.setItem("lang", "fr");
    await i18n.setLang("fr");
    assert.equal(i18n.t("gc.chat.usesRow", { count: 1 }), "1 utilisation", "the count var routes one");
    assert.equal(i18n.t("gc.chat.usesRow", { count: 3 }), "3 utilisations", "the count var routes other");
    assert.equal(i18n.t("gc.chat.usesRow", { count: 1000000 }), "1000000 de uses", "the count var hits the many arm too");
    globalThis.localStorage.store.clear();
    await i18n.initI18n(); // back to en — the canonical bare rows carry no _one/_other branches
    assert.equal(i18n.t("gc.chat.typing.someOne", { count: 1 }), "{{user}} is typing…",
      "a key with no branch rows falls through to its bare row unchanged — the en/es/de canon rides the fallback");
  } finally {
    freshBundles({ en: LOCALES.en });
    globalThis.localStorage.store.clear();
    await i18n.initI18n();
  }
});

// --- the formatting helpers ------------------------------------------------------

test("fmtNumber and fmtDate ride the active locale and never throw on a bad seat", async () => {
  await i18n.initI18n();
  assert.equal(i18n.fmtNumber(1234.5, { maximumFractionDigits: 1 }).replace(",", ""), "1234.5");
  assert.equal(i18n.fmtDate(Date.UTC(2026, 10, 17), { year: "numeric" }),
    String(new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "UTC" })
      .format(Date.UTC(2026, 10, 17))));
  globalThis.localStorage.setItem("lang", "xx-broken");
  await i18n.setLang("xx-broken"); // 404 seat
  assert.equal(i18n.currentLang(), "xx-broken", "the chosen seat stays chosen");
  assert.equal(i18n.fmtNumber(7, {}).length >= 1, true, "a broken seat still formats");
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});
