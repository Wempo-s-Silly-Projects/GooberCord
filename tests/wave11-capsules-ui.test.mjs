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

// Wave 11 — the capsules panel (the 2026-11-19 slate): the client surface
// the audit-hardened backend (api/capsules.mjs, BYTE-FROZEN five cycles)
// already earned. The four LIVE doors — the mine list GET, the compose POST,
// the reveal GET, the delete DELETE — ride source-read pins against the
// client modules; the shell carries the route + the server rail door; the
// rider closes the deslop-c16 truncated seat in bookmarks.js's own scope.
// The i18n law rides the wave-10 shape: every new key en-seated AND
// translated in all eight staged bundles (no en placeholder, no byte-equal
// carve, no plural arms).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE11_PATHS = ["api", "constants.mjs", "worker.mjs", "public/js/core", "main.js"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const CAPSULES_UI = read("public/js/ui/capsules.js");
const BOOKMARKS_UI = read("public/js/ui/bookmarks.js");
const SHELL = read("public/js/ui/shell.js");

// The byte-frozen backend shape the client mirrors (read, never edited).
const CAPSULES_API = read("api/capsules.mjs");
const CONSTANTS = read("constants.mjs");

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW keys — single strings, no plural arms (the slate's law).
const NEW_KEYS = [
  "gc.shell.nav.capsules",
  "gc.capsules.heading",
  "gc.capsules.empty",
  "gc.capsules.compose.placeholder",
  "gc.capsules.compose.seal",
  "gc.capsules.compose.confirmHeading",
  "gc.capsules.compose.hint",
  "gc.capsules.compose.empty",
  "gc.capsules.reveal.label",
  "gc.capsules.reveal.needed",
  "gc.capsules.reveal.range",
  "gc.capsules.row.sealedLabel",
  "gc.capsules.row.openLabel",
  "gc.capsules.row.open",
  "gc.capsules.row.delete",
  "gc.capsules.delete.confirmHeading",
  "gc.capsules.stamp",
  "gc.bookmarks.more",
];

// --- G-4 mirrors (constants.mjs single source, provenance cited) ---------------

// Provenance: constants.mjs — GC_CAPSULE_BODY_MAX, GC_CAPSULE_MIN_AHEAD_SECONDS,
// GC_CAPSULE_MAX_AHEAD_SECONDS (source-read, never imported client-side; the
// mirrors in the UI file are literals by wave law).
test("the mirrored constants stand in constants.mjs at the pinned values", () => {
  assert.match(CONSTANTS, /export const GC_CAPSULE_BODY_MAX = 2000;/);
  assert.match(CONSTANTS, /export const GC_CAPSULE_MIN_AHEAD_SECONDS = 300;/);
  assert.match(CONSTANTS, /export const GC_CAPSULE_MAX_AHEAD_SECONDS = 2592000;/);
});

test("the client mirrors ride the G-4 literal law with provenance", () => {
  assert.match(CAPSULES_UI, /G-4 mirror: GC_CAPSULE_BODY_MAX \(constants\.mjs\)/);
  assert.match(CAPSULES_UI, /G-4 mirror: GC_CAPSULE_MIN_AHEAD_SECONDS and GC_CAPSULE_MAX_AHEAD_SECONDS \(constants\.mjs\)/);
  assert.match(CAPSULES_UI, /UI_CAPSULE_BODY_MAX = 2000;/);
  assert.match(CAPSULES_UI, /UI_CAPSULE_MIN_AHEAD_SECONDS = 300;/);
  assert.match(CAPSULES_UI, /UI_CAPSULE_MAX_AHEAD_SECONDS = 2592000;/);
  assert.doesNotMatch(CAPSULES_UI, /import .*constants\.mjs/, "the client never imports constants.mjs");
});

// --- F1: the four LIVE doors ----------------------------------------------------

test("the capsules panel module exists and wires the four LIVE doors", () => {
  assert.match(CAPSULES_UI, /export async function loadMineCapsules\(serverId\)/);
  assert.match(CAPSULES_UI, /api\(`\/api\/servers\/\$\{serverId\}\/capsules\/mine`\)/,
    "GET /api/servers/:id/capsules/mine (api/capsules.mjs:161 route arm)");
  assert.match(CAPSULES_UI, /api\(`\/api\/servers\/\$\{serverId\}\/capsules`, \{ method: "POST", body: \{ body: text, revealAt: postmark \} \}\)/,
    "POST /api/servers/:id/capsules { body, revealAt } (api/capsules.mjs:157 route arm)");
  assert.match(CAPSULES_UI, /api\(`\/api\/servers\/\$\{serverId\}\/capsules\/\$\{Number\(capsuleId\)\}`\)/,
    "GET /api/servers/:id/capsules/:cid — the reveal (api/capsules.mjs:170 route arm)");
  assert.match(CAPSULES_UI, /api\(`\/api\/servers\/\$\{serverId\}\/capsules\/\$\{Number\(capsuleId\)\}`, \{ method: "DELETE" \}\)/,
    "DELETE /api/servers/:id/capsules/:cid (api/capsules.mjs:170 route arm)");
});

// TEST-MOVE (deslop fix-round-1, T-WAVE-11 HIGH): the flat "mineCapsules"
// lane was the wave-10 house violation — per-server lanes key by server
// (members.js:39 roster:${serverId}, expressions.js:50
// expressions:${serverId}). The pin retargets to the keyed shape; the key
// itself gets its own pin below.
test("the store lane mirrors the GET list — one lane per server, one shape", () => {
  assert.match(CAPSULES_UI, /const mineKey = \(serverId\) => `mineCapsules:\$\{serverId\}`;/,
    "the rosterKey/expressionsKey idiom (members.js:39, expressions.js:50)");
  // TEST-MOVE (lane-c18-fix): the malformed arm seats the lane NULL, not []
  // — a server-broken answer paints the failed-load face, never the empty
  // state (the valid empty array keeps the empty paint).
  assert.match(CAPSULES_UI, /store\.set\(\{ \[mineKey\(serverId\)\]: Array\.isArray\(payload\?\.capsules\) \? payload\.capsules : null \}\);/);
});

test("the mine lane keys per-server — server-1 rows never answer server-2's URL", () => {
  // The wave-10 flat lane: set once on server 1's visit, read on server 2's
  // render — server 1's roster paints under server 2's URL. The read side
  // AND the lane-miss check both carry the rendered server's key.
  assert.match(CAPSULES_UI, /const mineKey = \(serverId\) => `mineCapsules:\$\{serverId\}`;/);
  assert.match(CAPSULES_UI, /const lane = store\.get\(mineKey\(serverId\)\);/,
    "the lane-miss check reads THIS server's lane");
  assert.match(CAPSULES_UI, /capsuleRows\(store\.get\(mineKey\(serverId\)\), serverId\)/,
    "the painted rows read THIS server's lane");
  assert.doesNotMatch(CAPSULES_UI, /"mineCapsules"/, "the flat lane is retired, not left dead");
});

test("the mine payload's rows paint id, channelId, revealAt, sealed — no invented read", () => {
  assert.match(CAPSULES_UI, /row\.revealAt/);
  assert.match(CAPSULES_UI, /row\.id/);
  assert.doesNotMatch(CAPSULES_UI, /row\.body/, "the mine payload carries NO body — the reveal GET is the only body read");
});

// --- the panel page -------------------------------------------------------------

test("the panel rides the server-scoped task-page idiom and registers in the shell", () => {
  assert.match(CAPSULES_UI, /export function renderCapsulesPanel\(route, mount\)/);
  assert.match(CAPSULES_UI, /Number\(route\.params\.serverId\)/);
  assert.match(CAPSULES_UI, /class: "back-link", href: `\/s\/\$\{serverId\}`/, "the G-6 back affordance");
  assert.match(SHELL, /router\.addRoute\("\/s\/:serverId\/capsules", "server-capsules", renderCapsulesPanel\)/,
    "the panel route registers alongside the nav entry (the bookmarks door idiom; main.js untouched)");
  assert.match(SHELL, /t\("gc\.shell\.nav\.capsules"\)/);
  assert.match(SHELL, /href: `\/s\/\$\{server\.id\}\/capsules`/,
    "the server rail door navigates the active server's capsules page");
});

test("a sealed-shape 200 never paints an undefined body seat (deslop fix-round-1 LOW)", () => {
  assert.match(CAPSULES_UI, /revealed\?\.sealed === false/,
    "the body paints only on the unsealed shape — the author's pre-postmark 200 stays a schedule");
  assert.match(CAPSULES_UI, /typeof revealed\.body === "string"/,
    "the absent-body 200 keeps the schedule paint (the savedStamp guard family)");
});

// --- the defaults law -----------------------------------------------------------

test("the panel's only auto-GET is its own list pull — compose, reveal, delete are member-initiated", () => {
  // Exactly four api() call sites: one per door, all inside load/handler
  // definitions (the module's top level fires no wire at all).
  const apiSeats = CAPSULES_UI.match(/(?:await |return )api\(/g)?.length ?? 0;
  assert.equal(apiSeats, 4, "one wire seat per door: mine, create, reveal, delete");
  // The lane-miss branch auto-pulls ONLY the list (the bookmarks idiom),
  // never a reveal — the reveal GET fires from the open row's own handler.
  assert.match(CAPSULES_UI, /loadMineCapsules\(serverId\)\.then\(\(\) => router\.renderCurrent\(\)\)/);
  const revealSeats = CAPSULES_UI.match(/export async function revealCapsule\(/g)?.length ?? 0;
  assert.equal(revealSeats, 1, "the reveal rides one named door, called only from the row's handler");
  assert.match(CAPSULES_UI, /onClick: async \(\) => \{\s*try \{\s*\n\s*const revealed = await revealCapsule\(serverId, row\.id\);/,
    "the reveal GET is the click's own act (the defaults law)");
});

// --- the compose door -----------------------------------------------------------

test("the compose door rides ONE confirm openDialog — the POST follows the gate", () => {
  assert.match(CAPSULES_UI, /openDialog\(document, \{/);
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.compose\.confirmHeading"\)/,
    "the confirm gate precedes the POST (the settings.js idiom)");
  assert.match(CAPSULES_UI, /onPress: async \(\) => \{\s*try \{\s*\n\s*await createCapsule\(serverId, text, postmark\);/,
    "the POST rides ONLY the confirm action's onPress");
  // One mutating wire seat each (the sink of wires, the deslop law).
  assert.equal(CAPSULES_UI.match(/method: "POST"/g)?.length, 1, "one create seat");
  assert.equal(CAPSULES_UI.match(/method: "DELETE"/g)?.length, 1, "one delete seat");
});

test("the compose well seats the G-4 mirror cap and the postmark window locally", () => {
  assert.match(CAPSULES_UI, /maxlength: String\(UI_CAPSULE_BODY_MAX\)/);
  assert.match(CAPSULES_UI, /text\.length > UI_CAPSULE_BODY_MAX/,
    "the body validates against the mirror before any wire");
  assert.match(CAPSULES_UI, /ahead < UI_CAPSULE_MIN_AHEAD_SECONDS \|\| ahead > UI_CAPSULE_MAX_AHEAD_SECONDS/,
    "the postmark validates inside [now+300s, now+2592000s] client-side, the server's 400 family rides verbatim behind it");
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.reveal\.needed"\)/, "an unseated postmark refuses locally, paints the key");
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.reveal\.range", \{ min: UI_CAPSULE_MIN_AHEAD_SECONDS \/ 60, max: UI_CAPSULE_MAX_AHEAD_SECONDS \/ 86400 \}\)/,
    "the window prose interpolates the mirrors — no numeric literals in the copy");
});

// --- the rows: reveal view + delete door -----------------------------------------

test("sealed rows paint the schedule as a date-time; open rows paint the body verbatim once revealed", () => {
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.row\.sealedLabel", \{ when: revealStamp\(row\.revealAt\) \}\)/,
    "the sealed row paints its schedule (the future date-time stamp)");
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.row\.openLabel", \{ when: revealStamp\(row\.revealAt\) \}\)/,
    "the open row still paints its postmark — the schedule is fact, not surprise");
  assert.match(CAPSULES_UI, /textContent = revealed\.body;/,
    "the letter paints through its own textContent seat, verbatim once revealed");
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.stamp", \{ when: revealStamp\(revealed\.revealAt \?\? revealAt\) \}\)/,
    "the revealed body carries its postmark stamp");
});

test("the letter is member-composed text — never t()'d, never interpolated", () => {
  assert.doesNotMatch(CAPSULES_UI, /t\([^)]*body/, "no t() wrap of the letter");
  assert.doesNotMatch(CAPSULES_UI, /body\}/, "no {{interpolation}} of the letter");
});

test("the delete door rides the own PRE-reveal rows only — the refusals paint verbatim", () => {
  // TEST-MOVE (c17 LOW-2, lane-c17-caps): the painted sealed fact now
  // derives from revealAt at PAINT time (the backend's own per-row
  // recompute idiom) — the payload's stored `row.sealed === true` flag was
  // the aged-mirror seat and is retired, not kept as a second arm.
  assert.match(CAPSULES_UI, /Number\(row\.revealAt\) > Math\.floor\(Date\.now\(\) \/ 1000\)/,
    "the delete affordance gates on the pre-reveal fact recomputed at paint time");
  assert.match(CAPSULES_UI, /errorLine\.textContent = error\.message;/,
    "404/409 server copy paints verbatim (no re-worded client side)");
  assert.doesNotMatch(CAPSULES_UI, /t\([^)]*error/, "no t() wrap of a server error");
});

test("the non-revealed 404 paints the server's message verbatim at the row", () => {
  assert.match(CAPSULES_UI, /letterSeat\.textContent = error\.message;/,
    "the row-owned error seat carries the server's string, never a client re-wording");
});

test("empty schedule is a valid painted state, never an error", () => {
  assert.match(CAPSULES_UI, /length === 0/);
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.empty"\)/);
});

// --- the sink law ----------------------------------------------------------------

test("the sink law: the client adds no coins and no ledger seat", () => {
  assert.doesNotMatch(CAPSULES_UI, /coin/);
  assert.doesNotMatch(CAPSULES_UI, /ledger/);
  assert.doesNotMatch(CAPSULES_UI, /amount/);
});

// --- the rider: the bookmarks list's truncated seat (T-C16-CAPS LOW-a) -----------

test("the bookmarks rider paints the truncated seat only when the payload says so", () => {
  assert.match(BOOKMARKS_UI, /payload\?\.truncated === true/,
    "the envelope's own truncated flag is the only seat — no invented count");
  assert.match(BOOKMARKS_UI, /t\("gc\.bookmarks\.more", \{ shown: rows\.length \}\)/,
    "the shown count rides the rows actually painted; N+1 is never invented");
  assert.match(BOOKMARKS_UI, /truncatedRow = h\("p", \{ class: "muted count-line", text: t\("gc\.bookmarks\.more", \{ shown: rows\.length \}\) \}\)/);
});

// --- the backend stays byte-frozen against the wave -------------------------------

test("the backend stays byte-frozen against the wave (api/capsules.mjs route arms)", () => {
  assert.match(CAPSULES_API, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/capsules\$\/\)/);
  assert.match(CAPSULES_API, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/capsules\\\/mine\$\/\)/);
  assert.match(CAPSULES_API, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/capsules\\\/\(0\|\[1-9\]\[0-9\]\*\)\$\/\)/);
  assert.match(CAPSULES_API, /GC_CAPSULE_MIN_AHEAD_SECONDS \|\|/);
  assert.match(CAPSULES_API, /GC_CAPSULE_MAX_AHEAD_SECONDS/);
});

// --- diff scope (wave-9 freeze idiom) ----------------------------------------------

// The freeze is the WAVE-11 lane contract, so the fingerprint is the lane's
// own committed range (base 5264b03 .. the wave tip) — the wave-9 freeze
// pin's lesson, second instance (f7db5e1): the pin MUST diff the wave's own
// two commits, never a HEAD-open leg, or the first post-wave audit fix
// breaks it.
// LANE-BASE = 5264b03 (main tip at lane open); LANE-TIP = e872ec3, the
// wave's own feat commit (the lead's retarget commit rides beside, not
// inside, the range — the wave-9 lesson's committed-range fingerprint).
test("diff scope: the lane touches NO backend file and no core wire", () => {
  const LANE_BASE = "5264b03";
  const LANE_TIP = "e872ec3";
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, LANE_TIP, "--", ...FROZEN_WAVE11_PATHS,
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
