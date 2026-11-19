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

// Wave 17 — the coin shop's use arm (the 2026-11-19 slate): the client face
// of the live, byte-frozen consumable backend (api/coins.mjs:991-1022 —
// POST /api/coins/cosmetics/consume, wired at handleCoinRoutes:1236). The
// shop's inventory rows gain one explicit use act, the owned consumable row
// gains the same equip/unequip toggle the own rows already paint (the
// backend's Phase-3 admitted exception — the effects slot's pack IS the
// equip surface), and every refusal paints the backend's verbatim copy.
// Backend BYTE-FROZEN: this suite edits nothing under api/, worker.mjs,
// core/ — the freeze pin fingerprints the wave's own committed range.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE17_PATHS = ["api", "worker.mjs", "core"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

// The seat is RED-first: the module edits are uncommitted when the pins run
// first — each client read is fresh and fails NAMED (the wave-16 idiom).
const ECONOMY = () => {
  try {
    return read("public/js/ui/economy.js");
  } catch (error) {
    throw new Error(`RED: economy.js unreadable — ${error.message}`);
  }
};

// The byte-frozen backend shapes the client rides (read, NEVER edited).
const COINS = read("api/coins.mjs");

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW key — one button label, single string, no plural arm.
const NEW_KEYS = ["gc.economy.items.use"];

// --- the frozen backend is the single source (read, never edited) ---------------

test("the frozen consume route keeps its shape (api/coins.mjs:991-1022)", () => {
  assert.match(COINS, /async function handleCosmeticConsumeRoute\(request, env\) \{/,
    "the consume arm's own handler");
  assert.match(COINS, /method === "POST" \n?\s*&& path === "\/api\/coins\/cosmetics\/consume"|path === "\/api\/coins\/cosmetics\/consume"/,
    "the route's path");
  assert.match(COINS, /if \(sku\.kind !== "consumable"\) \{/,
    "the kind gate — only consumable rows ride the use arm");
  assert.match(COINS, /INVENTORY_CONSUME_SQL\)/,
    "the ONE guarded UPDATE (the qty > 0 arm IS the claim)");
});

test("the consume refusals' copies are the verbatim contract (grep of the REAL lines)", () => {
  assert.match(COINS, /throw new HttpError\(400, "That cosmetic is not in the shop\."\);/,
    "the unknown-SKU 400's exact copy");
  assert.match(COINS, /throw new HttpError\(400, "That cosmetic is not a consumable pack\."\);/,
    "the kind 400's exact copy");
  assert.match(COINS, /throw new HttpError\(403, "Buy that cosmetic in the coin shop first\."\);/,
    "the buy-first 403's exact copy");
  assert.match(COINS, /throw new HttpError\(409, "That pack is empty\."\);/,
    "the empty-pack 409's exact copy");
});

test("the disambiguating catch arm: changes = 0 reclassifies through the OWNED probe (the c20 forge)", () => {
  // The real block, grepped from the worktree — the zero-change classification
  // is DISAMBIGUATED by the owned-probe lines riding inside the same arm
  // (coins.mjs carries several `changes !== 1` arms; this one is the consume's).
  assert.match(COINS,
    /if \(Number\(result\.meta\?\.changes\) !== 1\) \{\s*\n\s*const owned = await env\.GOOBER_DB\.prepare\(INVENTORY_OWNED_PROBE_SQL\)\s*\n\s*\.bind\(userId, sku\.itemKey\)\.first\(\);\s*\n\s*if \(!owned\) throw new HttpError\(403, "Buy that cosmetic in the coin shop first\."\);\s*\n\s*throw new HttpError\(409, "That pack is empty\."\);\s*\n\s*\}/,
    "the classified post-hoc probe arm, byte-shaped");
});

test("the route wire seat rides handleCoinRoutes (the :1236 seat)", () => {
  assert.match(COINS,
    /if \(path === "\/api\/coins\/cosmetics\/consume" && method === "POST"\) \{\s*\n\s*return handleCosmeticConsumeRoute\(request, env\);\s*\n\s*\}/,
    "the wired seat — the route answered in the dispatcher");
});

test("the frozen backend carries the equip exception (the burst pack IS the equip surface)", () => {
  assert.match(COINS, /sku\.itemKey !== GC_COSMETIC_FX_BURST_ITEM/,
    "the kind guard's admitted Phase-3 exception");
  assert.match(COINS, /publicInventoryRow\(row\) \{[\s\S]*?equipped: row\.equipped === 1/,
    "the echoed rows carry equipped for every kind (the paint's payload truth)");
});

// --- the consumeCosmetic helper (public/js/ui/economy.js) -------------------------

test("the consumeCosmetic helper rides POST /api/coins/cosmetics/consume with the itemKey-only body", () => {
  assert.match(ECONOMY(),
    /export async function consumeCosmetic\(itemKey\) \{/,
    "the helper, named beside the equip family");
  assert.match(ECONOMY(),
    /api\("\/api\/coins\/cosmetics\/consume", \{\s*\n?\s*method: "POST",\s*\n?\s*body: \{ itemKey \},\s*\n?\s*\}\)/,
    "the route + method + body shape (no slot naming, no second wire)");
  assert.match(ECONOMY(), /weldShopEcho\(result\);/,
    "the echo welds into the store's shop shape (the equip family's one weld)");
});

// --- the row branch shape ----------------------------------------------------------

test("the owned consumable row renders the use button (one explicit use act)", () => {
  const economy = ECONOMY();
  const row = economy.slice(economy.indexOf("function inventoryRow(item, errorLine) {"),
    economy.indexOf("function rowPrice(item) {"));
  assert.match(row, /item\.kind === "consumable" && item\.owned/,
    "the consumable-owned branch");
  assert.match(row, /useButton\(item, errorLine\)/,
    "the use button rides the owned consumable row");
  // The use act is the ONE explicit click — no auto-use, no confirm ceremony,
  // no countdown math beyond the payload's own qty.
  assert.doesNotMatch(row, /setInterval|setTimeout|confirm\(/,
    "a member-initiated one-click act (the defaults law)");
});

test("the use button's act: consumeCosmetic with the row's itemKey, refusal verbatim, echo re-render", () => {
  const economy = ECONOMY();
  const useButton = economy.slice(economy.indexOf("function useButton(item, errorLine) {"),
    economy.indexOf("\n}\n", economy.indexOf("function useButton(item, errorLine) {")));
  assert.ok(useButton.includes("function useButton(item, errorLine) {"),
    "the use button is the shop row's button (the equip-family idioms)");
  assert.match(useButton, /t\("gc\.economy\.items\.use"\)/,
    "the use button's label rides the t() key");
  assert.match(useButton, /await consumeCosmetic\(item\.item\);/,
    "the act spends the ROW's itemKey");
  assert.match(useButton, /errorLine\.textContent = error\.message;/,
    "the refusal paints verbatim (403 buy-first / 409 empty / 400 kind)");
  assert.match(useButton, /router\.renderCurrent\(\);/,
    "the success arm re-renders off the echoed inventory (the echo-refresh shape)");
});

test("the equip face is kind-generic; the unequip control rides ONLY the served arm (own kind)", () => {
  const economy = ECONOMY();
  const row = economy.slice(economy.indexOf("function inventoryRow(item, errorLine) {"),
    economy.indexOf("function rowPrice(item) {"));
  assert.match(row, /if \(item\.owned\) \{/,
    "the toggle rides ownership, the backend's own kind guard answers the equip arm");
  assert.doesNotMatch(row, /item\.kind === "own" && item\.owned/,
    "no own-kind gate in the row's TOGGLE branch — the burst pack equips the same buttons");
  assert.match(row, /if \(item\.kind === "own"\) nodes\.push\(unequipButton\(item, errorLine\)\);/,
    "the unequip control paints ONLY on the row the backend's unequip arm serves (a never-served act never paints — the equipped pack rides the equipped span alone)");
  assert.match(row, /h\("span", \{ class: "muted item-equipped", text: t\("gc\.economy\.items\.equipped"\) \}\)/,
    "the equipped paint is the SAME span the own rows paint");
  assert.match(row, /equipButton\(item, errorLine\)/);
  assert.match(row, /unequipButton\(item, errorLine\)/);
});

test("the unequipped own rows and the unowned rows keep today's shape (regression guard)", () => {
  const economy = ECONOMY();
  const row = economy.slice(economy.indexOf("function inventoryRow(item, errorLine) {"),
    economy.indexOf("function rowPrice(item) {"));
  assert.match(row, /shopBuyButton\(item, errorLine\)/,
    "an unowned row still rides the buy button");
  assert.match(row, /t\("gc\.economy\.items\.uses", \{ count: item\.qty \}\)/,
    "the uses span still answers off the payload's qty");
});

test("the weld carries the echo's consumable state: qty AND equipped (the spend's fresh row)", () => {
  const economy = ECONOMY();
  const weld = economy.slice(economy.indexOf("function weldShopEcho(result) {"),
    economy.indexOf("\n}\n", economy.indexOf("function weldShopEcho(result) {")));
  assert.match(weld, /echo\.kind === "consumable"/,
    "the weld arms on the echoed row's kind (the payload's own shape)");
  assert.match(weld, /qty: echo\.qty/,
    "the spend's fresh qty welds onto the shop's item entry (no stale countdown)");
  assert.match(weld, /equipped: echo\.equipped/,
    "the equipped flag welds for the consumable row the same way (the echo carries it)");
});

// --- the freeze (the wave-9 lesson, the NINTH instance) ------------------------------

// LANE_BASE = 8ce8d26 (main tip at lane open). LANE_TIP = the wave's own
// committed feat tip — the lead retargets the placeholder at commit time
// (the wave-9 freeze-pin lesson: the pin fingerprints the lane's own range,
// never HEAD). Until the commit, the placeholder diffs the base — the
// uncommitted handback has no committed range to fingerprint.
test("freeze: the frozen paths stay untouched across LANE_BASE..LANE_TIP", () => {
  const LANE_BASE = "8ce8d26";
  const LANE_TIP = "c97c239";
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, tip, "--", ...FROZEN_WAVE17_PATHS,
    ], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    // The catch is an ARM, not a swallow: a genuinely no-history
    // environment (a shallow checkout, an exported tree) cannot answer the
    // range — the other source-read pins carry the freeze there. A throw in
    // a FULL checkout IS the defect (a mistyped SHA) and must fail loud.
    let isShallow;
    try {
      isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"],
        { cwd: ROOT, encoding: "utf8" }).trim() === "true";
    } catch {
      return; // not a git checkout at all (an exported tree)
    }
    if (isShallow) return;
    throw error;
  }
  assert.equal(touched, "", `${touched ? touched : ""} — the frozen paths must stay untouched`);
});

test("freeze: api/coins.mjs is byte-identical across LANE_BASE..LANE_TIP (the wave's own range)", () => {
  const LANE_BASE = "8ce8d26";
  const LANE_TIP = "c97c239";
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  let bytes;
  try {
    bytes = execFileSync("git", ["diff", LANE_BASE, tip, "--", "api/coins.mjs"],
      { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    let isShallow;
    try {
      isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"],
        { cwd: ROOT, encoding: "utf8" }).trim() === "true";
    } catch {
      return; // not a git checkout at all (an exported tree)
    }
    if (isShallow) return;
    throw error;
  }
  assert.equal(bytes, "", "the consume route + wire seat stay byte-identical (byte-frozen)");
});

// --- the i18n sweep ------------------------------------------------------------

test("every wave key is en-seated real copy", () => {
  for (const key of NEW_KEYS) {
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0, `${key} is en-seated real copy`);
  }
});

test("the key scheme rides the dotted gc.* law — single strings, no plural arms", () => {
  const scheme = /^gc(\.[a-z][a-zA-Z0-9]*)+$/;
  for (const key of NEW_KEYS) assert.match(key, scheme, `the scheme rides: ${key}`);
  for (const key of NEW_KEYS) assert.ok(!/_(one|other|few|many|zero|two)$/.test(key), `${key} is no plural arm`);
});

test("the eight staged bundles carry every wave key TRANSLATED", () => {
  for (const langKey of STAGED) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    for (const key of NEW_KEYS) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
      assert.notEqual(value, enData[key], `${langKey} carries ${key} TRANSLATED — no en placeholder`);
    }
  }
});

test("the REUSED keys are seated before use (en AND one non-en bundle)", () => {
  const de = JSON.parse(read("public/locales/de.json"));
  for (const key of [
    "gc.economy.items.uses",
    "gc.economy.items.equipped",
    "gc.economy.items.equip",
    "gc.economy.items.unequip",
  ]) {
    assert.equal(typeof enData[key], "string", `en seats ${key}`);
    assert.equal(typeof de[key], "string", `de seats ${key}`);
  }
});

test("the AGPL header rides the new file in the canonical shape", () => {
  const sourceText = read("tests/wave17-consume.test.mjs");
  const lines = sourceText.split("\n");
  assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", "line 1");
  for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
    `header line ${i + 1} rides the template`);
  assert.equal(lines[17], "", "rides the 17-lines-plus-blank template");
});
