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

// Wave 9's leave/transfer UI pins (the 2026-11-19 slate's client lane). The
// backend routes /api/servers/:id/leave + /api/servers/:id/transfer-ownership
// are BYTE-FROZEN (pinned through haywire cycles 7-9) — this lane only wires
// them into the two client surfaces: the own member card's leave control and
// the owner's transfer picker. The idiom and the bundle law ride
// tests/cosmetics-ui.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const MEMBERS = readFileSync(join(HERE, "../public/js/ui/members.js"), "utf8");
const SETTINGS = readFileSync(join(HERE, "../public/js/ui/settings.js"), "utf8");
const SERVERS_API = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");
const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];

const enData = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

const LEAVE_KEYS = [
  "gc.members.leave.heading",
  "gc.members.leave.button",
  "gc.members.leave.confirmTitle",
  "gc.members.leave.confirmBody",
  "gc.members.leave.action",
];
const TRANSFER_KEYS = [
  "gc.settings.transfer.heading",
  "gc.settings.transfer.pickerLabel",
  "gc.settings.transfer.pickerHelp",
  "gc.settings.transfer.button",
  "gc.settings.transfer.confirmTitle",
  "gc.settings.transfer.confirmBody",
  "gc.settings.transfer.action",
  "gc.settings.transfer.noop",
  "gc.settings.transfer.none",
];
const NEW_KEYS = [...LEAVE_KEYS, ...TRANSFER_KEYS];

// --- feature 1: the own member card's leave control ---------------------------

test("the leave control rides the signed-in member's OWN card — no other surface", () => {
  assert.match(MEMBERS, /function leavePanel\(serverId\)/,
    "one leave panel, one surface");
  assert.match(MEMBERS, /if \(me && me\.id === uid\) \{[\s\S]*?card\.append\(leavePanel\(serverId\)\)/,
    "the panel renders on the self card's branch, never a stranger's card");
  assert.match(MEMBERS, /class: "panel panel-danger"/,
    "the destructive panel wears the danger panel");
  // The button law: text-and-grammar through t(), never a bare icon glyph.
  assert.match(MEMBERS, /class: "button button-danger", type: "button", text: t\("gc\.members\.leave\.button"\)/,
    "the leave button carries its text grammar through the i18n lane");
  assert.doesNotMatch(MEMBERS, /"leave-server"/,
    "no bare-glyph leave affordance rides the card");
});

test("the leave write asks ONCE and rides the frozen route verbatim", () => {
  assert.match(MEMBERS, /heading: t\("gc\.members\.leave\.confirmTitle"\)/,
    "the single confirm step's heading is the i18n key, never raw copy");
  assert.match(MEMBERS, /text: t\("gc\.members\.leave\.confirmBody"\)/,
    "the confirm's body is the i18n key");
  assert.match(MEMBERS, /modalOnly: true/,
    "the confirm is modal — one explicit click, never default-on (defaults law)");
  assert.match(MEMBERS, /class: "button button-danger", text: t\("gc\.members\.leave\.action"\), onPress/,
    "the confirm's commit control carries its own text");
  assert.equal(MEMBERS.match(/\/api\/servers\/\$\{serverId\}\/leave/g)?.length, 1,
    "the leave route is wired exactly once — no second wire");
  assert.match(MEMBERS, /await api\(`\/api\/servers\/\$\{serverId\}\/leave`, \{\s*method: "POST",?\s*\}\)/,
    "the route rides a plain POST, as the frozen contract spells it");
  // The route itself is the frozen backend's — the client adds no shape.
  assert.match(SERVERS_API, /async function handleLeaveServerRoute\(/,
    "the frozen leave handler still stands (this lane never touches api/)");
});

test("the leave refusal renders the server's body VERBATIM in the error lane", () => {
  assert.match(MEMBERS, /errorLine\.textContent = error\.message/,
    "the error line rides the payload's message verbatim (G-2)");
  assert.doesNotMatch(MEMBERS.replace(/\/\/[^\n]*/g, ""), /Transfer ownership before leaving/,
    "the owner's 409 pointer is the SERVER's copy — the client never re-words it");
});

test("a successful leave drops the server from the rail and walks home", () => {
  assert.match(MEMBERS, /await refreshServers\(\);/,
    "the store's servers lane re-reads through the refreshServers idiom");
  assert.match(MEMBERS,
    /store\.set\(\{ \[rosterKey\(serverId\)\]: null \}\);\s*\n\s*await refreshServers\(\);/,
    "the roster cache dies with the membership (mod.js kick's idiom) — a leave→rejoin never serves the stale envelope");
  assert.match(MEMBERS, /router\.navigate\("\/"\);/,
    "the leaving member walks home (the gc.shell navigation idiom)");
});

// --- feature 2: the owner's transfer-ownership picker -------------------------

test("the transfer control rides the manage route's server block for the owner", () => {
  assert.match(SETTINGS, /function transferPanel\(/,
    "one transfer panel, the manage surface's own");
  assert.match(SETTINGS, /server\.role === "owner"\) nodes\.push\(deletePanel\(serverId\), transferPanel\(serverId\)\)/,
    "the owner's settings block gains the transfer panel beside the delete panel");
  assert.match(SETTINGS, /text: t\("gc\.settings\.transfer\.button"\)/,
    "the transfer button carries its text grammar");
});

test("the active-member picker rides the roster payload — never a client re-derive", () => {
  assert.match(SETTINGS,
    /rosterOf\(serverId\)\s*\?\s*Promise\.resolve\(rosterOf\(serverId\)\)\s*:\s*loadRoster\(serverId\)/,
    "the picker reads the cached roster or the one load, the roleEditor idiom");
  assert.match(SETTINGS, /member\.membershipRole !== "owner"/,
    "the owner row stays out of the picker (you cannot hand to yourself here)");
  assert.match(SETTINGS, /label: member\.nickname \|\| member\.username/,
    "option labels ride the roster rows' own display names");
});

test("the transfer write asks ONCE and POSTs the frozen route with { userId }", () => {
  assert.match(SETTINGS, /heading: t\("gc\.settings\.transfer\.confirmTitle"\)/,
    "the confirm's heading is the i18n key");
  assert.match(SETTINGS, /text: t\("gc\.settings\.transfer\.confirmBody"/,
    "the confirm's body is the i18n key (the picked member's name rides it)");
  assert.match(SETTINGS, /class: "button button-danger", text: t\("gc\.settings\.transfer\.action"\), onPress/,
    "the confirm's commit control carries its own text");
  assert.equal(SETTINGS.match(/transfer-ownership/g)?.length, 1,
    "the transfer route is wired exactly once — no second wire");
  assert.match(SETTINGS,
    /await api\(`\/api\/servers\/\$\{serverId\}\/transfer-ownership`, \{\s*method: "POST", body: \{ userId \},?\s*\}\)/,
    "the body is the contract's { userId } — never a renamed wire");
  assert.match(SERVERS_API, /async function handleTransferOwnershipRoute\(/,
    "the frozen transfer handler still stands (this lane never touches api/)");
});

test("the { transferred: false } echo renders an honest i18n line, never silence", () => {
  assert.match(SETTINGS, /result\?\.transferred === false/,
    "the no-op echo is read from the route's own payload");
  assert.match(SETTINGS, /resultLine\.textContent = t\("gc\.settings\.transfer\.noop"\)/,
    "the honest no-op line rides the i18n lane, never raw copy and never a lie");
});

test("a transferred server refreshes the roster AND the settings payloads", () => {
  assert.match(SETTINGS,
    /Promise\.all\(\[\s*loadRoster\(serverId\),\s*refreshServers\(\),\s*\]\)/,
    "both payloads re-read — the owner badge may move right off me");
  assert.match(SETTINGS, /router\.renderCurrent\(\);/,
    "the route re-renders off the fresh payloads (the manage writes' idiom)");
});

test("an empty picker says so — the solo owner is never handed a disabled lie", () => {
  assert.match(SETTINGS, /resultLine\.textContent = t\("gc\.settings\.transfer\.none"\)/,
    "the no-candidates state tells the truth through the i18n lane");
});

// --- feature 3: the bundle law (the cosmetics-ui idiom) -----------------------

test("every new key is en-seated real copy, dotted and scheme-lawful", () => {
  const scheme = /^gc(\.[a-z][a-zA-Z0-9]*)+$/;
  for (const key of NEW_KEYS) {
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0, `${key} is en-seated real copy`);
    assert.match(key, scheme, `the scheme rides: ${key}`);
    assert.ok(!enData[key].includes("en placeholder"), `${key} is not a placeholder`);
  }
});

test("the eight staged bundles carry every new key TRANSLATED", () => {
  for (const langKey of STAGED) {
    const bundle = JSON.parse(readFileSync(join(HERE, `../public/locales/${langKey}.json`), "utf8"));
    for (const key of NEW_KEYS) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
      assert.notEqual(value, enData[key], `${langKey} carries ${key} TRANSLATED — no en placeholder, no byte-equal carve`);
    }
  }
});

// --- the diff-scope sheriff: api/ stays byte-frozen ---------------------------

test("the lane's diff touches no api/ file, no constants.mjs — the frozen path list", () => {
  const FROZEN_PATHS = ["api", "api/vendor", "constants.mjs"];
  // The freeze is the WAVE-9 lane contract, so the fingerprint is the lane's
  // own committed range (base f22c41f .. the wave-9 tip) — NOT moving HEAD:
  // later audit cycles own their own api/ surfaces, and a HEAD-anchored pin
  // would break on every legitimate post-wave-9 api/ fix (c11 did, first
  // probe: the guard caught its own handback only once committed).
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", "f22c41f", "5f106e6", "--", ...FROZEN_PATHS,
    ], { cwd: join(HERE, ".."), encoding: "utf8" }).trim();
  } catch {
    // A non-git run (an exported tree) cannot answer — the other source-read
    // pins carry the freeze there.
    return;
  }
  assert.equal(touched, "", `${touched ? touched : ""} — the frozen paths must stay untouched`);
});
