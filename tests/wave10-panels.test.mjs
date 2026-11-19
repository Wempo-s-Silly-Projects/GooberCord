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

// Wave 10 — the client panels the backend already earned (the 2026-11-19
// slate): bookmarks panel + message-row save, the daily quests block on
// /shop, the welcome card's mod write door + member once-shown pull. The
// backend is BYTE-FROZEN (api/bookmarks.mjs, api/quests.mjs,
// api/welcome-card.mjs are pinned through the haywire cycles) — every pin
// here rides source-reads of the client modules, the backend shapes they
// mirror, and the constants the G-4 mirrors cite. The i18n law rides the
// cosmetics-ui shape: every new key en-seated AND translated in all eight
// staged bundles (no en placeholder, no byte-equal carve).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE10_PATHS = ["api", "constants.mjs", "worker.mjs", "public/js/core", "main.js"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const BOOKMARKS_UI = read("public/js/ui/bookmarks.js");
const CHAT = read("public/js/ui/chat.js");
const ECONOMY = read("public/js/ui/economy.js");
const SETTINGS = read("public/js/ui/settings.js");
const SHELL = read("public/js/ui/shell.js");

// The byte-frozen backend shapes the client mirrors (read, never edited).
const BOOKMARKS_API = read("api/bookmarks.mjs");
const QUESTS_API = read("api/quests.mjs");
const WELCOME_API = read("api/welcome-card.mjs");
const CONSTANTS = read("constants.mjs");

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW keys — single strings, no plural arms (the slate's law).
const NEW_KEYS = [
  "gc.shell.nav.bookmarks",
  "gc.bookmarks.heading",
  "gc.bookmarks.empty",
  "gc.bookmarks.rowLabel",
  "gc.bookmarks.savedAt",
  "gc.bookmarks.unsave",
  "gc.chat.row.save",
  "gc.chat.row.unsave",
  "gc.chat.welcome.title",
  "gc.chat.welcome.dismiss",
  "gc.chat.welcome.again",
  "gc.economy.quests.heading",
  "gc.economy.quests.message",
  "gc.economy.quests.voice",
  "gc.economy.quests.earned",
  "gc.economy.quests.progress",
  "gc.economy.quests.claim",
  "gc.economy.quests.claimPlain",
  "gc.economy.quests.claimed",
  "gc.settings.welcomeCard.heading",
  "gc.settings.welcomeCard.fieldLabel",
  "gc.settings.welcomeCard.save",
  "gc.settings.welcomeCard.confirmHeading",
  "gc.settings.welcomeCard.saved",
];

// --- G-4 mirrors (constants.mjs single source, provenance cited) ---------------

// Provenance: constants.mjs — GC_BOOKMARKS_LIST_MAX, GC_QUEST_GOAL_*,
// GC_QUEST_CLAIM, GC_WELCOME_CARD_BLURB_MAX (source-read, never imported
// client-side; the mirrors in the UI files are literals by wave law).
test("the mirrored constants stand in constants.mjs at the pinned values", () => {
  assert.match(CONSTANTS, /export const GC_BOOKMARKS_LIST_MAX = 100;/);
  assert.match(CONSTANTS, /export const GC_QUEST_GOAL_MESSAGES = 20;/);
  assert.match(CONSTANTS, /export const GC_QUEST_GOAL_VOICE = 2;/);
  assert.match(CONSTANTS, /export const GC_QUEST_GOAL_EARNED = 150;/);
  assert.match(CONSTANTS, /export const GC_WELCOME_CARD_BLURB_MAX = 300;/);
});

// --- F1: bookmarks -------------------------------------------------------------

test("the bookmarks panel module exists and wires the three LIVE doors", () => {
  assert.match(BOOKMARKS_UI, /export async function loadBookmarks\(\)/);
  assert.match(BOOKMARKS_UI, /api\("\/api\/bookmarks"\)/, "GET /api/bookmarks (api/bookmarks.mjs:162)");
  assert.match(BOOKMARKS_UI, /api\(`\/api\/bookmarks\/\$\{Number\(bookmarkId\)\}`, \{ method: "DELETE" \}\)/,
    "DELETE /api/bookmarks/:id (api/bookmarks.mjs:154)");
  assert.match(BOOKMARKS_UI, /api\(`\/api\/messages\/\$\{Number\(messageId\)\}\/bookmark`, \{ method: "POST" \}\)/,
    "POST /api/messages/:id/bookmark (api/bookmarks.mjs:159)");
});

test("the panel renders the payload's pointer rows — id, messageId, savedAt, no invented read", () => {
  assert.match(BOOKMARKS_UI, /row\.messageId/);
  assert.match(BOOKMARKS_UI, /row\.savedAt/);
  assert.doesNotMatch(BOOKMARKS_UI, /row\.body/, "the payload carries no message body (bookmarks.mjs:80)");
});

test("the store lane mirrors the GET list — one shape, no client recount", () => {
  // The lane key rides the BOOKMARKS_LANE constant (c15 F4's extraction —
  // these shapes were the raw `store.set({ bookmarks:` spellings before it).
  assert.match(BOOKMARKS_UI, /store\.set\(\{ \[BOOKMARKS_LANE\]:/,
    "the GET list lands in the store's bookmarks lane (the chat row's saved state)");
  // TEST-MOVE (c17 LOW-1, lane-c17-caps): the save now PREPENDS its fresh
  // pointer (the capped read's newest-first parity, the statement's own
  // ORDER BY saved_at DESC) and caps the lane at the UIBOOKMARKS_LIST_MAX
  // mirror — the old append-tail shape painted the fresh row at the END and
  // could push a truncated lane past the cap, so this pin followed the fix.
  // TEST-MOVE (lane-c18-fix): the lane expression lifted to a `lane` const
  // (the duplicate arm's dedupe rides the same read) — the PREPEND shape
  // stays, only its spelling moved (the c17 pin above carries the same move).
  assert.match(BOOKMARKS_UI, /store\.set\(\{\s*\[BOOKMARKS_LANE\]: \[freshRow, \.\.\.lane\]\.slice\(0, UI_BOOKMARKS_LIST_MAX\),?\s*\}\)/);
  assert.match(BOOKMARKS_UI, /store\.set\(\{\s*\[BOOKMARKS_LANE\]: \(store\.get\(BOOKMARKS_LANE\) \|\| \[\]\)\.filter\(/);
});

test("the empty list is a valid painted state, never an error", () => {
  assert.match(BOOKMARKS_UI, /length === 0/);
  assert.match(BOOKMARKS_UI, /t\("gc\.bookmarks\.empty"\)/);
});

test("the message-row save action is an opt-in toggle — DEFAULT-OFF, no automatic save", () => {
  assert.match(CHAT, /await saveBookmark\(message\.id\)/);
  assert.match(CHAT, /await unsaveBookmark\(savedRow\.id\)/);
  // The defaults law: the paint function itself fires no fetch — the save
  // rides the click handler, and chat.js calls the bookmark store lane only
  // through the shared module (never its own GET).
  assert.doesNotMatch(CHAT, /api\("\/api\/bookmarks/);
  assert.equal(CHAT.match(/(?<!un)saveBookmark\(/g)?.length, 1, "one save seat: the click handler");
  assert.equal(CHAT.match(/(?<!un)unsaveBookmark\(/g)?.length, 1, "one unsave seat: the click handler");
  // The default label is the OFF state's word — never a "Saved" claim.
  assert.match(CHAT, /text: savedRow \? t\("gc\.chat\.row\.unsave"\) : t\("gc\.chat\.row\.save"\)/);
});

test("the row bookmark action's refusals render the server's message verbatim", () => {
  assert.match(CHAT, /controls\.title = error\.message; \/\/ the 404 family, verbatim/,
    "the error-copy law: no t() wrap of a server error");
});

test("the bookmarks nav entry rides the shell — text + label, no bare icon; the route registers", () => {
  assert.match(SHELL, /href: "\/bookmarks"/);
  assert.match(SHELL, /t\("gc\.shell\.nav\.bookmarks"\)/);
  assert.match(SHELL, /router\.addRoute\("\/bookmarks", "bookmarks", renderBookmarksPanel\)/,
    "the panel route registers alongside the nav entry (shell's wire, main.js untouched)");
});

// --- F2: quests ----------------------------------------------------------------

test("the shop gains the quests block — GET the day, POST the claim", () => {
  assert.match(ECONOMY, /export async function loadQuests\(\)/);
  assert.match(ECONOMY, /api\("\/api\/quests"\)/, "GET /api/quests (api/quests.mjs:169)");
  assert.match(ECONOMY, /api\("\/api\/quests\/claim", \{ method: "POST" \}\)/,
    "POST /api/quests/claim (api/quests.mjs:172)");
  assert.match(ECONOMY, /body\.append\(\s*questsPanel\(\),/,
    "the quests block rides INSIDE renderShop's panel chain");
});

// The deslop-HIGH pin: the backend's GOALS kinds (api/quests.mjs) are
// message, voice, EARN — the client's kind→key map must resolve every one
// of them to a SEATED key ("earn" → gc.economy.quests.earned), never the
// visible-garbage fallback for a kind the payload actually ships.
test("the kind-to-key map resolves every backend GOALS kind to a seated key", () => {
  const kinds = [...QUESTS_API.matchAll(/kind: "([a-z]+)", goal:/g)].map((entry) => entry[1]);
  assert.deepEqual(kinds, ["message", "voice", "earn"],
    "the backend GOALS list is the single source of the kinds");
  const mapSource = ECONOMY.match(/const QUEST_KIND_KEYS = \{([^}]*)\}/)?.[1];
  assert.ok(mapSource, "the client maps the payload kind through QUEST_KIND_KEYS");
  const map = new Map([...mapSource.matchAll(/([a-z]+): "(gc\.[a-z.A-Z]+)"/g)]
    .map((entry) => [entry[1], entry[2]]));
  for (const kind of kinds) {
    const key = map.get(kind) ?? "gc.economy.quests." + kind;
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0,
      `the payload kind "${kind}" resolves to the seated key ${key}`);
  }
});

test("the goal numbers ride the payload's own values — no client mirror literal, no client import", () => {
  assert.match(ECONOMY, /quest\.goal/, "the GET payload carries its goal values (questPayload's shape)");
  assert.match(ECONOMY, /quest\.progress/);
  assert.doesNotMatch(ECONOMY, /GC_QUEST_GOAL/, "the client never imports constants.mjs");
  assert.doesNotMatch(ECONOMY, /goal:\s*(20|2|150)[^0-9]/, "no goal literal mirrored into the panel");
});

test("the claim verdict renders verbatim — the shared daily slot, no client dedup invented", () => {
  assert.match(ECONOMY, /errorLine\.textContent = error\.message; \/\/ the shared daily slot, verbatim/,
    "the economy.js:52 idiom rides the quest claim too");
  assert.doesNotMatch(ECONOMY, /t\("gc\.economy\.quests\.[a-z]+",\s*error/,
    "no t() wrap of the server's verdict, no client dedup message invented");
});

test("the claim success re-renders from the response and refreshes the coin balance", () => {
  assert.match(ECONOMY, /store\.set\(\{ quests: \{ \.\.\.quests, claim: result\.claim \} \}\);/,
    "the response's claim state lands back in the quests lane");
  assert.match(ECONOMY, /await loadCoins\(\);/, "the balance refresh rides the flat 25's mint");
});

test("the sink law: the client adds no mint and no ledger write", () => {
  assert.doesNotMatch(ECONOMY, /source: "daily"/, "no client-side ledger row — the INSERT gate owns the mint");
  const claimSeats = ECONOMY.match(/api\("\/api\/quests\/claim"/g)?.length ?? 0;
  assert.equal(claimSeats, 1, "one claim wire: claimQuest's POST");
});

test("the claim label never paints an unmatched {{count}} seat", () => {
  assert.match(ECONOMY, /const claimState = quests\?\.claim;/,
    "the claim state hoists once (the deslop-LOW pin)");
  assert.match(ECONOMY, /claimState && Number\.isInteger\(claimState\.reward\)/,
    "the count seat renders only a reward the payload actually carries");
  assert.match(ECONOMY, /t\("gc\.economy\.quests\.claim", \{ count: claimState\.reward \}\)/);
  assert.match(ECONOMY, /t\("gc\.economy\.quests\.claimPlain"\)/,
    "the rewardless state falls back to the plain label, no raw seat");
  assert.equal(ECONOMY.match(/t\("gc\.economy\.quests\.claim",/g)?.length, 1,
    "one counted claim seat: the hoisted state's reward");
});

// --- F3: welcome card ----------------------------------------------------------

test("the mod write door lives inside the manage gate — one blurb PUT, one explicit save", () => {
  assert.match(SETTINGS, /function welcomeCardPanel\(/);
  assert.match(SETTINGS, /api\(`\/api\/servers\/\$\{serverId\}\/welcome-card`, \{ method: "PUT", body: \{ blurb \} \}\)/,
    "PUT /api/servers/:id/welcome-card { blurb } (api/welcome-card.mjs:91)");
  assert.match(SETTINGS, /rulesPanel\(serverId\), welcomeCardPanel\(serverId\)\]/,
    "the panel rides renderServerSettings's manageGate build");
});

test("the PUT fires ONE confirm step later — the defaults law", () => {
  assert.match(SETTINGS, /openDialog\(document, \{[^}]*welcomeCard\.confirmHeading/,
    "the confirm gate precedes the PUT (heading chrome rides its own seat)");
  assert.equal(SETTINGS.match(/welcome-card`, \{ method: "PUT"/g)?.length, 1, "one PUT seat");
  // The PUT rides ONLY the confirm action's onPress — never the form submit itself.
  assert.doesNotMatch(SETTINGS, /welcomeCardPut\([^)]*\)\{\s*await api/, "the paint/submit path never PUTs directly");
});

test("the confirm dialog's body is the blurb itself - member-composed text, verbatim", () => {
  assert.match(SETTINGS, /confirmBody\.textContent = blurb;/,
    "the body paints the blurb through its own textContent seat, never t()'d");
  assert.doesNotMatch(SETTINGS, /"gc\.settings\.welcomeCard\.confirm"/,
    "no reused confirm seat as body");
  assert.ok(!("gc.settings.welcomeCard.confirm" in enData), "the shared confirm key is unseated, not dead");
});

test("the blurb cap rides the mirrored constant with provenance", () => {
  assert.match(SETTINGS, /G-4 mirror: GC_WELCOME_CARD_BLURB_MAX \(constants\.mjs\)/);
  assert.match(SETTINGS, /UI_WELCOME_CARD_BLURB_MAX = 300;/);
  assert.match(SETTINGS, /maxLength: UI_WELCOME_CARD_BLURB_MAX/);
  assert.match(WELCOME_API, /blurb\.length > GC_WELCOME_CARD_BLURB_MAX/,
    "the backend arm the mirror cites stays byte-frozen");
});

test("the member pull is once-per-view — the paint GET carries no repeat, the explicit door is the only repeat", () => {
  // First open: the automatic pull WITHOUT ?repeat=1 (the backend owns the
  // once-shown ledger; the client never records view state client-side).
  assert.match(CHAT, /pullWelcomeCard\(currentServerId, column\);/);
  assert.match(CHAT, /api\(`\/api\/servers\/\$\{serverId\}\/welcome-card\$\{repeat \? "\?repeat=1" : ""\}`\)/);
  assert.match(CHAT, /\{ repeat: true \}/, "?repeat=1 rides ONLY the explicit member action");
  // The repeat-less and repeat seats are exactly two (pull + explicit).
  assert.equal(CHAT.match(/pullWelcomeCard\(/g)?.length, 3,
    "definition + the open's paint call + the explicit door");
});

test("the blurb is member-composed text painted VERBATIM — never t()'d, never interpolated", () => {
  assert.match(CHAT, /\.textContent = blurb;/, "the single textContent seat (welcome-card.mjs law)");
  assert.doesNotMatch(CHAT, /t\([^)]*blurb/, "no t() wrap of the blurb");
  assert.doesNotMatch(CHAT, /blurb\}/, "no {{interpolation}} of the blurb");
});

test("the off-state is silence — the row-absent 404 renders nothing, never an error", () => {
  assert.match(CHAT, /\.catch\(\(\) => \{ \/\* the off-state IS the missing row — silence, never an error \*\/ \}\);/,
    "the member pull's quiet catch");
});

test("the backend stays byte-frozen against the wave", () => {
  assert.match(BOOKMARKS_API, /deleteMatch = method === "DELETE"\s*\?\s*path\.match/);
  assert.match(QUESTS_API, /path === "\/api\/quests\/claim" && method === "POST"/);
  assert.match(WELCOME_API, /method === "PUT"/);
});

// --- diff scope (wave-9 freeze idiom) ------------------------------------------

// The freeze is the WAVE-10 lane contract, so the fingerprint is the lane's
// own committed range (base b38c794 .. the wave tip d54b770) — the wave-9
// freeze pin's lesson. The old HEAD-open leg broke on the FIRST post-wave
// audit fix (c15's emoji headroom ride, api/emoji.mjs) — later cycles own
// their own api/ surfaces; this pin holds the wave's own two commits only.
test("diff scope: the lane touches NO backend file and no core wire", () => {
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", "b38c794", "d54b770", "--", ...FROZEN_WAVE10_PATHS,
    ], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    // A non-git run (an exported tree) cannot answer — the other source-read
    // pins carry the freeze there.
    return;
  }
  assert.equal(touched, "", `${touched ? touched : ""} — the frozen paths must stay untouched`);
});

// --- the i18n sweep -------------------------------------------------------------

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
