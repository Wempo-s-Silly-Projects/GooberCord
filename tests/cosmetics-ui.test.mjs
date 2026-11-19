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

// The cosmetics shop UI (the 2026-11-19 v1 slate's phase 2) — the items
// panel rides the Phase-1 payload as data (kind/qty/equipped arrive from
// api/coins.mjs's shape, never re-derived client-side), the equip toggle
// rides Phase-1's POST /api/coins/cosmetics/equip, the consume runtime rides
// the wave-17 door (2026-11-19; it superseded this file's Phase-3 park), and
// every t() key the panel names is seated in
// en.json AND translated in all eight staged bundles (the law: no en
// placeholder, no byte-equal carve, no machine keys in a fleet bundle).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ECONOMY = readFileSync(join(HERE, "../public/js/ui/economy.js"), "utf8");
const COINS = readFileSync(join(HERE, "../api/coins.mjs"), "utf8");
// T-R25-SPLIT-COINS-1: the cosmetics route arms ride api/coins-cosmetics.mjs
// verbatim; the arm pins read the SEAM source (the same bytes, moved).
const SEAM = readFileSync(join(HERE, "../api/coins-cosmetics.mjs"), "utf8");
const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];

const enData = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

// The v1 SKU list reads the constants.mjs single source (the same four the
// 0056 CHECK list carries); the name keys ride the client's camel transform,
// never a re-declared SKU map.
const SKU_ITEMS = ["fx_burst_confetti", "frame_gold", "frame_neon", "channel_banner_dusk"];
const camelItemKey = (item) => item.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const NAME_KEYS = SKU_ITEMS.map((item) => "gc.economy.items." + camelItemKey(item));
const GRAMMAR_KEYS = ["gc.economy.items.uses", "gc.economy.items.costPlus",
  "gc.economy.items.equipped", "gc.economy.items.equip", "gc.economy.items.unequip"];
const NEW_KEYS = [...NAME_KEYS, ...GRAMMAR_KEYS];

test("the v1 rows ride the items panel as a KIND shape, named through the i18n lane", () => {
  assert.match(ECONOMY, /itemKey\.replace\(\/_\(\[a-z0-9\]\)\/g, \(_, c\) => c\.toUpperCase\(\)\)/,
    "the name key rides the itemKey's own camel transform — no SKU map re-declared client-side");
  assert.match(ECONOMY, /item\.kind === "consumable"/, "the consumable shape reads kind");
  assert.match(ECONOMY, /item\.kind === "own"/, "the own shape reads kind");
  assert.match(ECONOMY, /text: t\(skuNameKey\(item\.item\)\)/,
    "the row name renders through t(), never the raw itemKey");
});

test("the sku name keys are en-seated exactly once per v1 itemKey", () => {
  assert.equal(enData[NAME_KEYS[0]], "Confetti burst pack (5 uses)");
  assert.equal(enData[NAME_KEYS[1]], "Gold frame");
  assert.equal(enData[NAME_KEYS[2]], "Neon frame");
  assert.equal(enData[NAME_KEYS[3]], "Dusk banner skin");
});

test("the consumable row answers its remaining uses from the payload's qty", () => {
  assert.match(ECONOMY, /t\("gc\.economy\.items\.uses", \{ count: item\.qty \}\)/,
    "the uses line rides Phase-1's qty read, never a client recount");
  // A consumable re-buys (its packs stack by design) — the buy button stays.
  assert.match(ECONOMY, /item\.kind === "consumable" && item\.owned/);
});

test("the equipped own row carries the unequip control beside the equipped span; one equip control otherwise", () => {
  assert.match(ECONOMY, /h\("span", \{ class: "muted item-equipped", text: t\("gc\.economy\.items\.equipped"\) \}\)/,
    "the equipped row keeps the equipped span (every kind — the pack rides the equipped span alone)");
  assert.match(ECONOMY, /if \(item\.kind === "own"\) nodes\.push\(unequipButton\(item, errorLine\)\);/,
    "the unequip control rides ONLY the row the backend's unequip arm serves (own kind — the wave-17 kind split)");
  assert.match(ECONOMY, /function unequipButton\(/,
    "the control is the equipped row's own quiet button");
  assert.match(ECONOMY, /text: t\("gc\.economy\.items\.unequip"\)/,
    "the unequip control renders through the lane's own key");
  assert.match(ECONOMY, /await unequipCosmetic\(item\.item\)/,
    "the unequip control rides the shop row's own item");
  assert.match(ECONOMY, /text: t\("gc\.economy\.items\.equip"\)/);
  assert.match(ECONOMY, /await equipCosmetic\(item\.item\)/,
    "the still-equipable rows keep ONE equip control");
});

test("the equip and unequip toggles ride the ONE Phase 1 route with the payload echo passing back", () => {
  assert.match(ECONOMY, /await api\("\/api\/coins\/cosmetics\/equip", \{\s*method: "POST", body: \{ itemKey \},\s*\}\);/,
    "the equip arm rides the Phase-1 route verbatim");
  assert.match(ECONOMY, /method: "POST", body: \{ itemKey, unequip: true \},/,
    "the unequip arm rides the SAME route as its body flag, never a second wire");
  assert.match(ECONOMY, /store\.set\(\{\s*shop: \{\s*\.\.\.shop,\s*inventory,\s*items: \(shop\.items \|\| \[\]\)\.map\(/,
    "the echoed inventory lands back in the store's shop shape (the items weld rides the route's echo)");
});

test("a purchase keeps the existing POST /api/coins/cosmetics path — no second wire", () => {
  assert.equal(ECONOMY.match(/"\/api\/coins\/cosmetics"/g)?.length, 1,
    "the buy route appears exactly once: buyCosmetic's POST");
  assert.match(ECONOMY, /await buyCosmetic\(item\.item\)/,
    "the v1 rows ride the same buy surface the banner/flair rows always have");
});

test("the consume runtime rides the wave-17 door (the 2026-11-19 wave-17 slate supersedes the Phase-3 park)", () => {
  const consumeCall = ECONOMY.match(/api\("\/api\/coins\/cosmetics\/consume"/g) || [];
  assert.equal(consumeCall.length, 1,
    "exactly the ONE consume call site rides (the helper's POST; no second wire)");
  assert.match(ECONOMY, /export async function consumeCosmetic\(itemKey\)/,
    "the helper, named beside the equip family");
  const consumeCalls = ECONOMY.match(/consumeCosmetic\(item\.item\)/g) || [];
  assert.equal(consumeCalls.length, 1, "the use button is the ONE caller");
});

test("the both-prices line renders where the payload provides a differing plus price", () => {
  assert.match(ECONOMY, /typeof item\.plusPrice === "number" && item\.plusPrice !== item\.price/,
    "the line rides the payload's own plusPrice — never a fabricated number");
  assert.match(ECONOMY, /t\("gc\.economy\.items\.costPlus", \{ count: item\.plusPrice \}\)/);
});

test("the server side is Phase 1's own shape — the lane adds no route and no shape", () => {
  assert.match(COINS,
    /\{ \.\.\.entry, qty: row === null \? 0 : row\.qty \}\s*\n\s*: \{ \.\.\.entry, equipped: row !== null && row\.equipped === true \}/,
    "publicCosmeticItems answers the consumable's qty and the own item's equip state");
  assert.match(COINS, /inventory: inventoryRows\.map\(publicInventoryRow\),/,
    "the shop payload carries its inventory arm (the equip toggle's read)");
  assert.match(SEAM, /path === "\/api\/coins\/cosmetics\/equip"/,
    "the equip route is the Phase-1 lane's own — this lane never re-wires it");
  assert.match(SEAM, /path === "\/api\/coins\/cosmetics\/consume"/,
    "the consume route is the Phase-1 lane's — this lane never re-wires it");
});

test("every new panel key is en-seated, plural arms where the grammar demands", () => {
  for (const key of NEW_KEYS) {
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0, `${key} is en-seated real copy`);
  }
  assert.equal(enData["gc.economy.items.uses_one"], "{{count}} use left");
  assert.equal(enData["gc.economy.items.costPlus_one"], "Goober+ {{count}} coin");
});

test("the new keys ride en.json's key scheme — dotted, lawful plural suffixes only", () => {
  const scheme = /^gc(\.[a-z][a-zA-Z0-9]*)+(_one|_other|_few|_many|_zero|_two)?$/;
  for (const key of NEW_KEYS) {
    assert.match(key, scheme, `the scheme rides: ${key}`);
  }
  for (const key of ["gc.economy.items.uses_one", "gc.economy.items.costPlus_one"]) {
    assert.match(key, scheme, `the suffix arm rides: ${key}`);
  }
});

test("the eight staged bundles carry every new row translated", () => {
  for (const langKey of STAGED) {
    const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${langKey}.json`), "utf8"));
    for (const key of NEW_KEYS) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
      assert.notEqual(value, enData[key], `${langKey} carries ${key} TRANSLATED — no en placeholder, no new carve`);
    }
    for (const arm of ["gc.economy.items.uses_one", "gc.economy.items.costPlus_one"]) {
      if (arm in bundle) {
        assert.notEqual(bundle[arm], enData[arm], `${langKey}'s ${arm} rides translated`);
      }
    }
  }
});

test("the plural seats carry the arms their rules demand — ru's mod-10 seat, ar's few", () => {
  const ru = JSON.parse(readFileSync(join(HERE, "../public/locales/ru.json"), "utf8"));
  const ar = JSON.parse(readFileSync(join(HERE, "../public/locales/ar.json"), "utf8"));
  assert.ok("gc.economy.items.costPlus_few" in ru, "ru carries the few arm (2–4)");
  assert.ok("gc.economy.items.uses_few" in ru, "ru's uses line carries the few arm");
  assert.ok("gc.economy.items.uses_few" in ar, "ar carries the few arm (3-10: ar two=2, few=3-10)");
  assert.ok(!("gc.economy.items.costPlus_few" in enData), "en's two-branch seat stays two-branch");
});
