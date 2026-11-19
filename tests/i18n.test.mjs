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
  // risk is disclosed in the commit body, not hidden). The stored and
  // navigator-derived seats ride the same shipped-base gate; this list is
  // what that gate keeps.
  assert.deepEqual(i18n.BUNDLE_LANGS, ["en", "es", "de", "fr", "pt", "ru", "ja", "zh", "ar"]);
});

test("a wedged (non-JSON) en response retries uncached instead of leaving key tails", async () => {
  // The T25 churn window served the SPA-fallback HTML for /locales/en.json
  // (200); a force-cache copy of it wedged tabs on visible key tails with
  // zero console errors. A poisoned en parse must fall to one uncached
  // retry and, failing that, still catalog en as {} so setLang repaints.
  let calls = 0;
  bundles.clear();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => (++calls === 1
    ? new Response("<!DOCTYPE html>", { status: 200 })
    : new Response(JSON.stringify(LOCALES.en), { status: 200 }));
  try {
    await i18n.initI18n();
    assert.equal(i18n.currentLang(), "en");
    assert.match(i18n.t("gc.gate.accept"), /Accept and continue/,
      "the retry lands the real en copy, not key tails");
    assert.equal(calls, 2, "exactly one uncached retry after the poisoned copy");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("bundle fetches ride the app-build stamp as a cache-buster", async () => {
  bundles.clear();
  bundles.set("en.json", LOCALES.en);
  let seen = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path) => { seen = String(path); return realFetch("/locales/en.json"); };
  try {
    globalThis.document.querySelector = () => ({ content: "1.0@722e9e2" });
    await i18n.initI18n();
    assert.match(seen, /\?v=1\.0%40722e9e2$/,
      "the stamp rides the URL so each deploy's copy is a distinct cache row");
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document.querySelector;
  }
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
    freshBundles({ en: LOCALES.en, "ar-eg": { "gc.chat.pins.empty": "لا شيء بعد." } });
    globalThis.localStorage.setItem("lang", "en");
    await i18n.setLang("../../etc/passwd");
    assert.equal(globalThis.localStorage.getItem("lang"), "en",
      "the traversal shape dies at the sanitize gate — the unlawful seat never enters the store");
    for (const path of seen) {
      assert.doesNotMatch(path, /\.\.|%2F|%2f/gi, `the loader's fetch URL never carries the refused chars: ${path}`);
    }
    globalThis.localStorage.setItem("lang", "ar-EG");
    await i18n.setLang("ar-EG");
    assert.equal(globalThis.localStorage.getItem("lang"), "ar-eg",
      "the lawful regional tag rides untouched (an ar-eg bundle ships above the law's floor)");
  } finally {
    globalThis.fetch = previous;
  }
});

test("the raw-seat sweep keys pin (pins dialog, shell rails, document title)", () => {
  // This tree's own UI copy: the pins dialog is pins.heading/link + the
  // capNote/empty pair, the member rail is shell.members.empty, and the
  // document title rides gc.app.title (the LOW-1 binding below).
  const pinned = {
    "gc.app.title": "GooberCord",
    "gc.chat.pins.heading": "Pins",
    "gc.chat.pins.link": "Pins",
    "gc.chat.pins.empty": "Nothing pinned in this channel yet.",
    "gc.chat.pins.capNote": "Pins cap at 250 per channel — the server's text is the truth at the cap.",
    "gc.shell.members.empty": "Pick a server to see its members.",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(enData[key], value, `${key} rides the sweep's exact en copy`);
  }
});

test("the static <title> binding rides en.json's gc.app.title 1:1 (ship-reviewer LOW-1)", () => {
  const html = readFileSync(join(HERE, "../public/index.html"), "utf8");
  const attr = html.match(/<title\s+data-i18n="gc\.app\.title">([^<]*)<\/title>/);
  assert.ok(attr, "the title element carries the gc.app.title binding");
  assert.equal(attr[1], enData["gc.app.title"],
    "static title text and en.json's gc.app.title cannot drift apart — the en fast-path skips applyDom, so this static render is the only one");
});

// --- the carve gate: the byte-equal grandfather set, pinned exactly -----------

// The staged bundles grandfather some en bytes as their own copy (names of
// seats, code-side chips, cognate-class lines the realign rulings allowed).
// The law this pin carries: CLASSES NAME carves, KEYS ENUMERATE them — a
// class-based judgment list would re-open the blind spot, because a wrongly
// copied full sentence is not a cognate class. So the set is exhaustive and
// asserted in BOTH directions: any future equal-but-undeclared row fails
// red, and any future flex of a carved row (de "Roles" someday) fails red
// until this list updates with its ruling. Scan-derivation: the gate was
// re-declared against THIS tree's bundles (the pre-rewrite base's data) —
// every list row was computed from the byte-equal scan and each row is a
// genuine cognate-class judgment (brand strings, placeholders-only rows like
// "gc.shell.mentions.loading" ("…"), ellipsis-and-ident rows). The two
// rewrite-era placeholder fixes (de kinds.sounds → "Klänge", es nav.server →
// "Servidor") ride this tree, so both left their gate; the rewrite-era
// "gc.chat.gif.button" and "gc.paper.channelRow" carve rows are not in this
// tree's data (the base carries the GIF provider's own copy row and no
// paper row), so both dropped from every list.
const CARVE_GATES = {
  // ar enters the gate closing the wave-3 lane (the reviewer's declared two
  // at 212c883, scan-proven here key-for-key — the same set asserted third
  // time running, the declaration pattern stable).
  ar: [
    "gc.app.title",
    "gc.chat.gif.short",
    "gc.shell.mentions.loading",
  ],
  es: [
    "gc.app.title",
    "gc.chat.expressions.stickerTitle",
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
    "gc.shell.mentions.loading",
  ],
  fr: [
    "gc.app.title",
    "gc.chat.compose.aria",
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
  // The cache policy (the ported wedge law): bundle fetches never force old
  // cache rows — no-cache over a stamped URL, not force-cache.
  assert.match(I18N, /cache: "no-cache"/);
  assert.match(I18N, /app-build/, "the app-build stamp rides the bundle URL as the cache-buster");
  assert.doesNotMatch(I18N, /cache: "force-cache"/);
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

test("an unshipped stored seat (or a 404 seat) fails open to English", async () => {
  // The T25-churn wedged tab taught the loader's law: a stored seat whose
  // base is not one the fleet ships keeps NO paint on tails — it rides
  // back to en at boot (the human can re-pick any shipped seat; the old
  // fail-open-to-anything left lang on a catalogless seat forever).
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.setItem("lang", "xx-wemponese");
  await i18n.initI18n();
  assert.equal(i18n.currentLang(), "en",
    "a shipless stored seat normalizes to en, never a catalogless tail-paint");
  assert.equal(i18n.t("gc.chat.pins.empty"), "Nothing pinned in this channel yet.",
    "the en bundle carries the copy, never a broken page");
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});

// --- the setLang seat gate (the seat hole: setLang now rides the same
// base-script law storedLang() has carried since aa6979a) ------------------------

test("setLang refuses any seat whose base script is not in BUNDLE_LANGS", async () => {
  // The bork arc: setLang stored+activated ANY sanitized key with no bundle
  // gate, so a shipless seat rode lang onto an empty catalog — every t()
  // painted humanized key tails with zero self-heal. Refusal means: no
  // store write, no switch, strings keep resolving on the untouched seat.
  await i18n.initI18n(); // the en seat, no stored choice
  assert.equal(await i18n.setLang("it"), "en", "a seatless refusal returns the unchanged seat");
  assert.equal(i18n.currentLang(), "en", "lang never rides the refused key");
  assert.equal(globalThis.localStorage.getItem("lang"), null,
    "the refused seat never enters the store");
  assert.equal(i18n.t("gc.chat.pins.empty"), "Nothing pinned in this channel yet.",
    "strings keep resolving — the empty-catalog tail-paint is dead");
  await i18n.setLang("xx-wemponese"); // the regional tags of shipless bases refuse too
  assert.equal(i18n.currentLang(), "en");
  assert.equal(globalThis.localStorage.getItem("lang"), null);
});

test("setLang keeps riding lawful regional seats: 'zh-hans' → base 'zh' ships", async () => {
  freshBundles({ en: LOCALES.en, "zh-hans": LOCALES["zh-hans"] });
  try {
    await i18n.initI18n();
    await i18n.setLang("zh-hans");
    assert.equal(i18n.currentLang(), "zh-hans", "the base-script seat stays lawful through setLang");
    assert.equal(globalThis.localStorage.getItem("lang"), "zh-hans", "the lawful choice rides the store");
    assert.equal(i18n.t("gc.chat.pins.empty"), "Nothing pinned here yet, in Chinese.");
  } finally {
    freshBundles({ en: LOCALES.en });
    globalThis.localStorage.store.clear();
    await i18n.initI18n();
  }
});

test("a lawful seat whose bundle 404s rolls back to the previous seat, scrubbed", async () => {
  const previousDoc = globalThis.document;
  try {
    const holder = new StubNode("doc");
    holder.documentElement = new StubNode("html");
    const node = new StubNode("p");
    node.setAttribute("data-i18n", "gc.chat.pins.empty");
    holder.append(node);
    globalThis.document = holder;
    await i18n.initI18n(); // en; the boot pass painted the en copy
    assert.equal(node.textContent, "Nothing pinned in this channel yet.");
    assert.equal(await i18n.setLang("fr"), "en", "the failed switch returns the rolled-back seat");
    assert.equal(i18n.currentLang(), "en", "lang rolled back to the previous seat");
    assert.equal(globalThis.localStorage.getItem("lang"), null,
      "the failure key was never left in storage");
    assert.equal(holder.documentElement.lang, "en",
      "setHtmlLang returned to the previous seat");
    assert.equal(holder.documentElement.dir, "ltr", "the rollback keeps the dir law's ltr for en");
    assert.equal(node.textContent, "Nothing pinned in this channel yet.",
      "applyDom re-ran on the rollback — no empty-catalog state survives");
  } finally {
    globalThis.document = previousDoc;
  }
});

test("initI18n scrubs an unlawful stored key from storage at boot (defense-in-depth)", async () => {
  freshBundles({ en: LOCALES.en });
  globalThis.localStorage.setItem("lang", "it"); // the churn-era browser's stale row
  await i18n.initI18n();
  assert.equal(globalThis.localStorage.getItem("lang"), null,
    "the rejected stored key is scrubbed — no stale row re-wedges a future lane");
  assert.equal(i18n.currentLang(), "en", "the boot still lands on en");
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
  await i18n.setLang("xx-broken"); // the seat gate refuses — no catalogless seat ever rides
  assert.equal(i18n.currentLang(), "en", "the refused seat never becomes the active locale");
  assert.equal(i18n.fmtNumber(7, {}).length >= 1, true, "a refused seat still leaves formatting lawful");
  globalThis.localStorage.store.clear();
  await i18n.initI18n();
});

// --- the paint-swap race (T29): the en floor's late resolve repainted -------

test("the en floor repaints already-bound copy: initI18n's en seat calls applyDom", async () => {
  // The boot NEVER awaits the lane: painters run t() over an EMPTY catalog
  // while /locales/en.json is still in flight — the bound copy is humanized
  // key tails until SOMETHING repaints. The en seat's late resolve is that
  // something: one applyDom() over the document at catalog.set time.
  const previousDoc = globalThis.document;
  try {
    const holder = new StubNode("doc");
    holder.documentElement = new StubNode("html");
    const node = new StubNode("p");
    node.setAttribute("data-i18n", "gc.t29.late");
    holder.append(node);
    globalThis.document = holder;
    globalThis.localStorage.setItem("lang", "en"); // deterministic en seat
    node.textContent = i18n.t("gc.t29.late"); // the painter's pre-resolve paint
    assert.equal(node.textContent, "Late",
      "the pre-resolve paint is the humanized tail — the empty-catalog race");
    freshBundles({ en: { "gc.t29.late": "Repainted now." } }); // the file lands
    await i18n.initI18n(); // the boot's unawaited lane finally resolves
    assert.equal(node.textContent, "Repainted now.",
      "the en seat's resolve repainted the already-bound copy — tails cleared");
  } finally {
    globalThis.document = previousDoc;
  }
});

// --- the ported lane (port2-i18n): the negotiation reads the full list --------

// navigator.languages is the browser's Accept-Language class: the same
// preference-ordered candidate list the header carries, minus the q-values
// (the engine already ordered it). The negotiation walks the LIST and takes
// the first legal seat; single-tag engines (and stubs) ride language alone.
test("the negotiation rides navigator.languages in preference order", async () => {
  freshBundles({ en: LOCALES.en, fr: { "gc.chat.pins.empty": "Rien d'épinglé dans ce salon, pour l'instant." } });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: ["fr-CA", "fr-FR", "en-US"], language: "en-US" },
    });
    await i18n.initI18n();
    assert.equal(i18n.currentLang(), "fr",
      "the highest-preference legal seat wins, not the bare single tag's en");
    assert.equal(i18n.t("gc.chat.pins.empty"), "Rien d'épinglé dans ce salon, pour l'instant.",
      "the fr copy paints — the negotiation reached the bundle");
    // A list entry whose seat is illegal never stalls the walk: the first
    // legal LATER entry still wins.
    globalThis.localStorage.store.clear();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: ["it-IT", "de-DE", "en-US"], language: "en-US" },
    });
    freshBundles({ en: LOCALES.en, de: { "gc.chat.pins.empty": "In diesem Kanal ist noch nichts angepinnt." } });
    await i18n.initI18n();
    assert.equal(i18n.currentLang(), "de", "an illegal list head is skipped, the walk continues");
  } finally {
    Object.defineProperty(globalThis, "navigator", previousNavigator);
    globalThis.localStorage.store.clear();
  }
});

// The single-language engines (and every node-side stub) keep the one-tag
// negotiation: language alone, normalized through the same seat gate.
test("a listless navigator still negotiates language alone", async () => {
  freshBundles({ en: LOCALES.en, ja: { "gc.chat.pins.empty": "まだピン留めはありません。" } });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "ja" },
    });
    await i18n.initI18n();
    assert.equal(i18n.currentLang(), "ja", "language alone still negotiates");
  } finally {
    Object.defineProperty(globalThis, "navigator", previousNavigator);
    globalThis.localStorage.store.clear();
  }
});

// --- the ported lane (port2-i18n): the bundle delta rides translated ----------

// The base picked up exactly one key after the bundle sync froze — and the
// §13 Source mirror (c396585) seated its translation in all eight bundles in
// the same act. The law holds and is pinned: every seated bundle carries the
// row TRANSLATED (the blessed register picks below), never an en placeholder.
// AGPLv3 stays verbatim (the translators' law); no row is byte-equal to en,
// so no carve gate's set changes under the pin.
test("every seated bundle carries gc.shell.user.source, translated (no en placeholder)", () => {
  const expected = {
    de: "Quelle (AGPLv3)",
    es: "Código fuente (AGPLv3)",
    fr: "Code source (AGPLv3)",
    pt: "Código-fonte (AGPLv3)",
    ru: "Исходный код (AGPLv3)",
    ja: "ソースコード (AGPLv3)",
    zh: "源码 (AGPLv3)",
    ar: "الكود المصدري (AGPLv3)",
  };
  for (const [langKey, value] of Object.entries(expected)) {
    const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${langKey}.json`), "utf8"));
    assert.equal(bundle["gc.shell.user.source"], value, `${langKey} carries the translated row`);
  }
});

// The soundboard-studio wave grew the catalog without backfill — the audit
// caught the 12 gc.studio keys riding en.json alone. The law holds and is
// pinned: every staged bundle seats each studio row, filled and translated
// (never an en placeholder nor an empty row, on the cosmetics-ui shape).
test("every staged bundle seats the 12 gc.studio rows, translated (no en placeholder)", () => {
  const studioKeys = Object.keys(enData)
    .filter((key) => key.startsWith("gc.studio."))
    .sort();
  assert.equal(studioKeys.length, 12, "the studio catalog is exactly the 12 rows");
  for (const langKey of ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"]) {
    const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${langKey}.json`), "utf8"));
    for (const key of studioKeys) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.notEqual(value.trim(), "", `${langKey} fills ${key}`);
      assert.notEqual(value, enData[key], `${langKey} carries ${key} translated, not the en row`);
    }
  }
});

// --- the ported lane (port2-i18n): the funnel's cache-header pins ----------------

// The base funnel semantics stay: /locales/*.json rides the generic ASSETS
// leg, secureResponse re-wraps it (no-store rides every asset answer), and
// stampedAssetResponse only touches text/html — a JSON bundle is never
// html-stamped and keeps the fresh-answer law the loader's no-cache pairs with.
test("the /locales funnel answers bundles 200 JSON with the no-store law, never html-stamped", async () => {
  const worker = (await import("../worker.mjs")).default;
  const bundle = new Response(JSON.stringify({ "gc.app.title": "GooberCord" }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
  const response = await worker.fetch(new Request("https://gc.test/locales/en.json"), {
    ASSETS: { fetch: async () => bundle },
    VERSION: "1.0",
    COMMIT_SHA: "6cc360a",
  }, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /application\/json/);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300",
    "the asset layer's own cache policy rides through — securityHeaders adds no directive of its own to a JSON bundle (the loader's no-cache law pairs with whatever the asset layer answers)");
  assert.doesNotMatch((await response.text()).slice(0, 200), /app-build/,
    "a JSON bundle never rides the html stamping pass");
});

// Unknown-locale 200-html is base behavior (the base funnel serves unknown
// paths the SPA fallback, en fallback 200): documented here, deliberately NOT
// re-pointed to the rewrite-era 404 — the loader's fail-open answers it.
test("an unseated locale path keeps the base funnel's 200-html SPA fallback", async () => {
  const worker = (await import("../worker.mjs")).default;
  const html = "<!DOCTYPE html><html><head><title>GooberCord</title></head><body></body></html>";
  const response = await worker.fetch(new Request("https://gc.test/locales/xx-wemponese.json"), {
    ASSETS: { fetch: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }) },
    VERSION: "1.0",
    COMMIT_SHA: "6cc360a",
  }, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /text\/html/,
    "the base funnel semantics: the SPA fallback answers, the loader fails open to en");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
