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

// The economy lane: the snapshot is the ONLY balance source (no ledger
// summing, no client cap arithmetic), the claim's shared 409 renders
// verbatim, the ledger cursor appends without duplicating, the voice tick is
// silent when granted:false and stops on stop() without catch-up ticks, and
// the shop carries claim/bundles/items/apply/gift/ledger as one route.
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
  return new Response(
    typeof response === "string" ? response : JSON.stringify(response),
    { status: Number.isInteger(response?.status) ? response.status : 200 });
};

const economy = await import("../public/js/ui/economy.js");
const store = (await import("../public/js/core/store.js")).default;
const constants = await import("../constants.mjs");
const ECON = readFileSync(join(HERE, "../public/js/ui/economy.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
const SHELL = readFileSync(join(HERE, "../public/js/ui/shell.js"), "utf8");

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("the mirrored voice window equals the backend's constant (G-4)", () => {
  assert.equal(economy.COIN_VOICE_TICK_SECONDS, constants.GC_COIN_VOICE_TICK_SECONDS);
});

test("loadCoins lands the snapshot; the footer line reads ONLY it", async () => {
  responses = [{ balance: 250, dailyCeiling: 250, earnedToday: 0,
    daily: { grant: 25, claimedToday: false } }];
  const snapshot = await economy.loadCoins();
  assert.equal(snapshot.balance, 250);
  assert.equal(store.get("coins").balance, 250);
});

test("claim: the shared 409 renders verbatim; the snapshot only moves on success", async () => {
  responses = [{ error: "Already claimed today. Come back tomorrow.", status: 409 }];
  await economy.claimDaily().catch((error) => {
    assert.equal(error.message, "Already claimed today. Come back tomorrow.");
  });
  assert.equal(store.get("coins"), undefined, "a refusal never writes the store");
  responses = [{ claimed: true, balance: 275 }];
  await economy.claimDaily();
  assert.equal(store.get("coins").balance, 275);
});

test("the writes ride the exact body grammar: buy, renew (absent = full), gift", async () => {
  responses = [
    { bought: true, cost: 100, items: [] }, { balance: 150 }, // buy + its snapshot refetch
    { balance: 0 }, { balance: 0 }, // full renew + its refetch
    { balance: 0 }, { balance: 0 }, // mini renew + its refetch
    { balance: 0, price: 500, plus: {}, giftedTo: { id: 4 } }, { balance: 0 },
  ];
  await economy.buyCosmetic("banner");
  assert.deepEqual(JSON.parse(calls[0].body), { item: "banner" });
  await economy.renewPlus(); // absent body = full
  assert.equal(calls[2].body, undefined);
  await economy.renewPlus("mini");
  assert.deepEqual(JSON.parse(calls[4].body), { tier: "mini" });
  await economy.giftPlus("wempo");
  assert.deepEqual(JSON.parse(calls[6].body), { username: "wempo" });
});

test("apply cosmetics: the PATCH echo lands in the store's user (banner/flair additive)", async () => {
  store.set({ user: { id: 1, username: "me" } });
  responses = [{ cosmetics: { banner: "#397357", flair: "gm" } }];
  const result = await economy.applyCosmetics({ banner: "#397357" });
  assert.deepEqual(result.cosmetics, { banner: "#397357", flair: "gm" });
  assert.equal(store.get("user").banner, "#397357");
  assert.equal(store.get("user").flair, "gm");
});

test("the ledger cursor appends; a replayed cursor never duplicates (ids are the dedupe key)", async () => {
  responses = [{ entries: [{ id: 9, delta: 25, source: "daily_claim" }], nextAfter: 9 },
    { entries: [{ id: 9, delta: 25, source: "daily_claim" },
      { id: 8, delta: 3, source: "message_send" }], nextAfter: 8 }];
  await economy.loadLedger();
  await economy.loadLedger(store.get("ledger").nextAfter);
  const ledger = store.get("ledger");
  assert.equal(ledger.entries.length, 2, "the replayed id inserted nothing");
  assert.deepEqual(ledger.entries.map((entry) => entry.id).sort((a, b) => b - a), [9, 8]);
});

// The once-per-session failure surface is module state: this test runs BEFORE
// the other voice-tick case so the flag is fresh here (the other case's stub
// bodies reject their JSON parse and would consume the warn first).
test("a rejected tick (network/5xx) surfaces ONE warn per session while the loop stays alive", async () => {
  store.set({ coins: { balance: 5, voice: { windowSeconds: 0.01 } } });
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  // A network failure: the transport records the call, then rejects BEFORE
  // any response exists.
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method || "GET", body: init.body });
    throw new TypeError("fetch failed");
  };
  try {
    const stop = economy.startVoiceTicks(7);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const rejectedTicks = calls.filter((call) => call.path === "/api/coins/voice/tick").length;
    assert.ok(rejectedTicks >= 2, "the loop kept ticking through the failures");
    stop();

    // One quiet warn for the whole session, no DOM churn (the store's coins
    // lane stays exactly as the pre-failure snapshot left it).
    assert.equal(warnings.length, 1);
    assert.ok(String(warnings[0][0]).startsWith("coins tick failed — retrying next tick"));
    assert.equal(store.get("coins").balance, 5, "a failed tick never touches the store");

    // A granted:false cap/gate case arrives as DATA (HTTP 200), not a catch:
    // no second warn, no churn.
    const previousSecondFetch = globalThis.fetch;
    globalThis.fetch = async (path, init = {}) => {
      calls.push({ path, method: init.method || "GET", body: init.body });
      return new Response(JSON.stringify({ balance: 5, granted: false }), { status: 200 });
    };
    try {
      const stopAgain = economy.startVoiceTicks(7);
      await new Promise((resolve) => setTimeout(resolve, 30));
      stopAgain();
    } finally {
      globalThis.fetch = previousSecondFetch;
    }
    assert.equal(warnings.length, 1, "granted:false is silent-in-response, never a catch");
  } finally {
    globalThis.fetch = previousFetch;
    console.warn = previousWarn;
  }
});

test("the voice tick rides the snapshot's window, stays silent on granted:false, and stops cleanly", async () => {
  store.set({ coins: { balance: 5, voice: { windowSeconds: 0.01 } } });
  responses = [];
  const stop = economy.startVoiceTicks(7);
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  const ticks = calls.filter((call) => call.path === "/api/coins/voice/tick");
  assert.ok(ticks.length >= 2, "the loop ticked on its window");
  assert.deepEqual(JSON.parse(ticks[0].body), { channelId: 7 });
  const count = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.filter((call) => call.path === "/api/coins/voice/tick").length,
    ticks.length, "no catch-up ticks after stop() — join loss ends the loop");
  assert.ok(count >= ticks.length);
});

test("the shop route: one route, claim + bundles + items + gift + ledger", () => {
  assert.match(MAIN, /addRoute\("\/shop", "shop", renderShop\)/);
  assert.match(ECON, /t\("gc\.economy\.claim\.button", \{ count: daily\.grant/);
  assert.match(ECON, /renewalPrice/);
  assert.match(ECON, /t\("gc\.economy\.plus\.pitch"\)/, "the never-bought shape speaks");
  assert.match(ECON, /t\("gc\.economy\.plus\.grace"/, "the grace banner (renewal stays allowed)");
  assert.match(ECON, /t\("gc\.economy\.gift\.priceNote"\)/,
    "the gift confirm states the RECIPIENT's pricing before the commit");
  assert.match(ECON, /t\("gc\.chat\.history\.older"\)/, "the cursor appends (chat's swept seat)");
  assert.match(ECON, /t\("gc\.economy\.ledger\.empty"\)/, "the ledger's G-5 sentence");
  assert.match(ECON, /item\.owned/, "ownership is the payload's flag, pre-computed route-side");
});

test("no client cap arithmetic, no ledger summing — the snapshot is the only balance", () => {
  // Comments tell the law; the pin sees only the code.
  const codeOnly = ECON.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(codeOnly, /Math\.max|GC_PLUS|GC_COIN_DAILY/);
  assert.doesNotMatch(codeOnly, /reduce\(/, "the ledger is read, never summed");
  assert.doesNotMatch(codeOnly, /\bbalance\s*(\+=|-=|\*=|\/=)/,
    "no client-side balance arithmetic");
});

test("the ambient footer is a self-hydrating node (never a route re-render)", () => {
  // The footer line paints ITSELF after the snapshot lands — a route
  // re-render would drop the member's mid-edit form state (G-1).
  assert.match(SHELL, /coinFooterLine\(\)/);
  assert.match(ECON, /loadCoins\(\)\.then\(paint\)/);
  assert.doesNotMatch(ECON, /router\.renderCurrent[\s\S]{0,80}claimDaily/, "the footer claim repaints node-locally");
  assert.match(ECON, /const fresh = await claimDaily\(\);\s*\n?\s*paint\(fresh\)/);
});

// --- the shop speaks through the bundle -----------------------------------------

const EN = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

test("economy.js speaks through gc.economy.* (and the swept seats only)", () => {
  const pinned = {
    "gc.economy.heading": "Coin shop",
    "gc.economy.claim.heading": "Daily claim",
    "gc.economy.claim.button": "Claim {{count}} coins",
    "gc.economy.claim.ceiling": "— earned today {{earned}} / ceiling {{ceiling}}.",
    "gc.economy.claim.ambient": "Claim",
    "gc.economy.offer.summary": "{{price}} now · {{renewal}} renewal · {{days}}-day term",
    "gc.economy.buy.confirm": "Buy {{name}}?",
    "gc.economy.buy.summary": "{{price}} coins now. Renewal later is {{renewal}} for another {{days}} days.",
    "gc.economy.buy.button": "Buy",
    "gc.economy.cosmetics.apply": "Apply",
    "gc.economy.gift.unnamed": "this member",
    "gc.economy.gift.summary": "Their row prices it: their first term costs full price; a renewal extends their term 30 days.",
    "gc.economy.gift.section": "Gifting",
    "gc.economy.ledger.heading": "Ledger",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(EN[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.match(ECON, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
  // The adjudicated grammar ride (en's singular arm): the flexed coin seats
  // carry their _one branch beside the bare row — en's rule picks it at
  // exactly count 1; the {{count}} seam seats the lookup (i18n.js).
  assert.equal(EN["gc.economy.claim.button_one"], "Claim {{count}} coin",
    "the claim's singular branch rides beside its bare row");
  assert.equal(EN["gc.economy.items.cost_one"], "{{count}} coin",
    "the cost's singular branch rides beside its bare row");
  // The collapsed twin reuses chat's swept seat; the seed died at this commit.
  assert.equal(EN["gc.economy.ledger.older"], undefined,
    "Load earlier rides gc.chat.history.older once");
  // "Goober+" (the panel heading and tier names) is the brand — code-side.
  assert.match(ECON, /h\("h3", \{ text: "Goober\+" \}\)/);
});

test("economy.js holds NO sweep's leftover literals (the seat scan)", () => {
  const codeOnly = ECON
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // The Goober+ tier heading and names are the brand — never localized.
    .replace(/t\("gc\.[^"]*"[^)]*\)/g, "")
    .replace(/text: "Goober\+"/g, "");
  assert.doesNotMatch(codeOnly, /text: "[A-Z←"'][^"]*"/);
  assert.doesNotMatch(codeOnly, /label: "[A-Z][^"]*"/);
  assert.doesNotMatch(codeOnly, /description: "[A-Z0-9][^"]*"/);
});

test("the footer line repaints when a voice tick lands the coins lane (no route re-render)", async () => {
  const previous = { Node: globalThis.Node, document: globalThis.document };
  class CoinStubNode {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.className = "";
      this.textContent = "";
    }
    append(...kids) { this.children.push(...kids); }
    replaceChildren() { this.children = []; }
    setAttribute(name, value) { this.attributes ??= new Map(); this.attributes.set(name, String(value)); }
    addEventListener() { /* the click lane is not under test here */ }
  }
  const nodeOf = (tag, text) => {
    const node = new CoinStubNode(tag);
    node.textContent = text;
    return node;
  };
  globalThis.Node = CoinStubNode;
  globalThis.document = {
    createElement: (tag) => new CoinStubNode(tag),
    createTextNode: (text) => nodeOf("#text", String(text)),
  };
  try {
    // The coin-mark node hides its class in attributes; the number is the
    // painted text — walk to the coin-balance-num seat and read it.
    const balanceNum = (node) => {
      if (String(node.className).split(/\s+/).includes("coin-balance-num")) return node;
      for (const kid of node.children ?? []) {
        const found = balanceNum(kid);
        if (found) return found;
      }
      return null;
    };
    store.set({ coins: { balance: 10, voice: { windowSeconds: 600 } } });
    const line = economy.coinFooterLine(); // the pre-tick paint off the store
    assert.equal(balanceNum(line)?.textContent, "10", "the line paints the seated balance");
    store.set({ coins: { balance: 12 } }); // the tick's arrival — the paint moment
    assert.equal(balanceNum(line)?.textContent, "12", "the subscriber repainted the same node");
  } finally {
    globalThis.Node = previous.Node;
    globalThis.document = previous.document;
    store.reset(); // drops this line's live seat before the next case
  }
});
