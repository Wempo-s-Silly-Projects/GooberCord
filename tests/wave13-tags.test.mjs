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
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// Wave 13 — the reaction-tags surface (the 2026-11-19 slate): the client
// face the live, byte-frozen backend (api/reaction-tags.mjs:252-268)
// already earned. The mod panel rides the settings page's manageGate +
// nodes.push idiom (welcome-card / boost-tier); the member face rides a
// server-scoped task page keyed the mineCapsules idiom, its lanes PER-SERVER
// (the wave-11 test-move law). The i18n law rides the wave-11 shape: every
// new key en-seated real copy AND translated in all eight staged bundles.
// The message reactions payload carries NO tag seat (payload-truth law) —
// the chat chip stays out of wave-13.

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE13_PATHS = ["api", "worker.mjs", "constants.mjs", "public/js/core", "public/js/main.js"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const TAGS_UI = read("public/js/ui/reaction-tags.js");
const SETTINGS = read("public/js/ui/settings.js");
const SHELL = read("public/js/ui/shell.js");

// The byte-frozen backend shapes the client mirrors (read, never edited).
const REACTION_TAGS_API = read("api/reaction-tags.mjs");
const MESSAGES_API = read("api/messages.mjs");
const CONSTANTS = read("constants.mjs");

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW keys — single strings, no plural arms (the wave law).
const NEW_KEYS = [
  "gc.shell.nav.tags",
  "gc.settings.reactionTags.heading",
  "gc.settings.reactionTags.count",
  "gc.settings.reactionTags.emojiLabel",
  "gc.settings.reactionTags.tagLabel",
  "gc.settings.reactionTags.tagHelp",
  "gc.settings.reactionTags.save",
  "gc.settings.reactionTags.confirmHeading",
  "gc.settings.reactionTags.saved",
  "gc.settings.reactionTags.empty",
  "gc.settings.reactionTags.deleteConfirm",
  "gc.settings.reactionTags.deleteNote",
  "gc.tags.heading",
  "gc.tags.empty",
  "gc.tags.mineCount",
  "gc.tags.optIn",
  "gc.tags.optOut",
  "gc.tags.loadFailed",
];

// --- G-4 mirrors (constants.mjs single source, provenance cited) ---------------

test("the mirrored constants stand in constants.mjs at the pinned values", () => {
  assert.match(CONSTANTS, /export const GC_REACTION_TAGS_MAX = 20;/);
  assert.match(CONSTANTS, /export const GC_REACTION_TAG_TEXT_MAX = 32;/);
  assert.match(CONSTANTS, /export const GC_REACTION_TAG_EMOJI_MAX = 32;/);
});

test("the client mirrors ride the G-4 literal law with provenance", () => {
  assert.match(TAGS_UI, /G-4 mirror: GC_REACTION_TAGS_MAX, GC_REACTION_TAG_TEXT_MAX and/);
  assert.match(TAGS_UI, /GC_REACTION_TAG_EMOJI_MAX \(constants\.mjs\)/);
  assert.match(TAGS_UI, /UI_REACTION_TAGS_MAX = 20;/);
  assert.match(TAGS_UI, /UI_REACTION_TAG_TEXT_MAX = 32;/);
  assert.match(TAGS_UI, /UI_REACTION_TAG_EMOJI_MAX = 32;/);
  assert.doesNotMatch(TAGS_UI, /import .*constants\.mjs/, "the client never imports constants.mjs");
});

// --- the four LIVE doors ----------------------------------------------------

test("the reaction-tags module wires the four LIVE doors", () => {
  assert.match(TAGS_UI, /export async function loadServerReactionTags\(serverId\)/);
  assert.match(TAGS_UI, /api\(`\/api\/servers\/\$\{serverId\}\/reaction-tags`\)/,
    "GET /api/servers/:id/reaction-tags — the member map read (api/reaction-tags.mjs:243 route arm)");
  assert.match(TAGS_UI, /export async function loadMineReactionTags\(serverId\)/);
  assert.match(TAGS_UI, /api\(`\/api\/servers\/\$\{serverId\}\/reaction-tags\/mine`\)/,
    "GET /api/servers/:id/reaction-tags/mine (api/reaction-tags.mjs:245 route arm)");
  assert.match(TAGS_UI, /export async function optInTag\(serverId, tagId\)/);
  assert.match(TAGS_UI, /api\(`\/api\/servers\/\$\{serverId\}\/reaction-tags\/\$\{Number\(tagId\)\}\/opt`, \{ method: "POST" \}\)/,
    "POST /api/servers/:id/reaction-tags/:tagId/opt (api/reaction-tags.mjs:244 route arm)");
  assert.match(TAGS_UI, /export async function optOutTag\(serverId, tagId\)/);
  assert.match(TAGS_UI, /api\(`\/api\/servers\/\$\{serverId\}\/reaction-tags\/\$\{Number\(tagId\)\}\/opt`, \{ method: "DELETE" \}\)/,
    "DELETE /api/servers/:id/reaction-tags/:tagId/opt (api/reaction-tags.mjs:244 route arm)");
});

// --- per-server lanes (the wave-11 mineKey idiom) ---------------------------

test("the store lanes key PER-SERVER — one lane shape per server, no flat lane", () => {
  assert.match(TAGS_UI, /const mapKey = \(serverId\) => `serverReactionTags:\$\{serverId\}`;/,
    "the rosterKey/expressionsKey idiom (members.js roster:${serverId})");
  assert.match(TAGS_UI, /const mineKey = \(serverId\) => `mineReactionTags:\$\{serverId\}`;/,
    "the wave-11 mineKey idiom (capsules.js mineCapsules:${serverId})");
  assert.doesNotMatch(TAGS_UI, /"mineReactionTags"/, "the flat lane is rejected, never left dead");
  // The malformed arm seats the lane NULL, never [] — the lane-c18-fix law.
  assert.match(TAGS_UI, /Array\.isArray\(payload\?\.tags\) \? payload\.tags : null/);
});

// --- the panel page ---------------------------------------------------------

test("the member panel rides the server-scoped task-page idiom and registers in the shell", () => {
  assert.match(TAGS_UI, /export function renderReactionTagsPanel\(route, mount\)/);
  assert.match(TAGS_UI, /Number\(route\.params\.serverId\)/);
  assert.match(TAGS_UI, /class: "back-link", href: `\/s\/\$\{serverId\}`/, "the G-6 back affordance");
  assert.match(SHELL, /import \{ renderReactionTagsPanel \} from "\.\/reaction-tags\.js";/);
  assert.match(SHELL, /router\.addRoute\("\/s\/:serverId\/tags", "server-tags", renderReactionTagsPanel\)/,
    "the panel route registers alongside the capsules door; main.js untouched");
  assert.match(SHELL, /t\("gc\.shell\.nav\.tags"\)/);
  assert.match(SHELL, /href: `\/s\/\$\{server\.id\}\/tags`/,
    "the server rail door navigates the active server's tags page");
});

// --- the defaults law -------------------------------------------------------

test("the panel's only auto-pull is its own two reads — every opt act is member-initiated", () => {
  // Exactly four api() seats: map GET, mine GET, opt POST, opt DELETE.
  const apiSeats = TAGS_UI.match(/(?:await |return )api\(/g)?.length ?? 0;
  assert.equal(apiSeats, 4, "one wire seat per door");
  const postSeats = TAGS_UI.match(/method: "POST"/g)?.length ?? 0;
  const deleteSeats = TAGS_UI.match(/method: "DELETE"/g)?.length ?? 0;
  assert.equal(postSeats, 1, "one opt seat");
  assert.equal(deleteSeats, 1, "one un-opt seat");
  // The lane-miss branch auto-pulls BOTH reads once (the defaults law: the
  // panel GET rides its own open), never an opt.
  assert.match(TAGS_UI, /Promise\.all\(\[loadServerReactionTags\(serverId\), loadMineReactionTags\(serverId\)\]\)/);
});

// --- the opt acts -----------------------------------------------------------

test("the opt flips ride ONE click per act; the lane updates immutably", () => {
  assert.match(TAGS_UI, /await optOutTag\(serverId, row\.id\)/);
  assert.match(TAGS_UI, /await optInTag\(serverId, row\.id\)/);
  assert.match(TAGS_UI, /mineRows\.filter\(\(entry\) => entry\.id !== row\.id\)/,
    "the un-opt rebuilds the lane (never an in-place splice)");
  assert.match(TAGS_UI, /\[\.\.\.mineRows, \{ id: row\.id, emoji: row\.emoji, tag: row\.tag \}\]/,
    "the opt appends the map row's own shape (no invented fields)");
  assert.match(TAGS_UI, /errorLine\.textContent = error\.message;/,
    "the 404/409 refusal family paints verbatim (no re-worded client side)");
});

// --- the verbatim paint (payload-truth) ------------------------------------

test("server-native tag text paints verbatim through its own seat, never t()'d", () => {
  assert.match(TAGS_UI, /text: row\.tag/);
  assert.match(TAGS_UI, /text: row\.emoji/);
  assert.doesNotMatch(TAGS_UI, /t\([^)]*row\.tag/, "no t() wrap of a server-native tag");
});

test("the chat reaction payload carries NO tag seat — the chip stays out of wave-13", () => {
  // api/messages.mjs's grouped read selects emoji/user_id/fx_burst only;
  // the tag map lives server-side and never rides the message payload, so
  // no client seat may invent it (payload-truth law, the slate's third face).
  assert.doesNotMatch(MESSAGES_API, /tag_text/, "the message payload builds no tag column");
  assert.doesNotMatch(TAGS_UI, /messageId|message_id|fxBurst/, "the member face invents no message-payload seat");
});

// --- the sink law -----------------------------------------------------------

test("the sink law: tags are free cosmetics — no coins, no ledger", () => {
  assert.doesNotMatch(TAGS_UI, /coin/);
  assert.doesNotMatch(TAGS_UI, /ledger/);
  assert.doesNotMatch(SETTINGS.match(/function reactionTagsPanel[\s\S]*?\nfunction [a-z]/)?.[0] ?? "", /coin|ledger/);
});

// --- the mod face -----------------------------------------------------------

test("the mod panel rides the manageGate + nodes.push registration idiom", () => {
  assert.match(SETTINGS, /function reactionTagsPanel\(serverId\) \{/);
  assert.match(SETTINGS, /nodes\.push\(reactionTagsPanel\(serverId\)\)/,
    "the additive nodes.push at the settings build (the boost-tier idiom)");
  assert.match(SETTINGS,
    /import \{[^}]*UI_REACTION_TAGS_MAX[^}]*\} from "\.\/reaction-tags\.js";/,
    "the mirrors import from the one module, never re-declared");
});

test("the mod face: the auto-GET paints the table; PUT and DELETE each ride ONE confirm", () => {
  assert.match(SETTINGS, /`\/api\/servers\/\$\{serverId\}\/reaction-tags`, \{ method: "PUT", body: \{ emoji, tag \} \}\)/,
    "PUT carries the edited pair (one tag upsert per act)");
  assert.match(SETTINGS, /`\/api\/servers\/\$\{serverId\}\/reaction-tags`, \{ method: "DELETE", body: \{ emoji: row\.emoji \} \}\)/,
    "per-tag DELETE carries the emoji the route unmaps");
  assert.match(SETTINGS, /maxLength: UI_REACTION_TAG_EMOJI_MAX/, "the emoji well caps at the mirror");
  assert.match(SETTINGS, /maxLength: UI_REACTION_TAG_TEXT_MAX/, "the tag well caps at the mirror");
  assert.match(SETTINGS, /t\("gc\.settings\.reactionTags\.count", \{ count: rows\.length, max: UI_REACTION_TAGS_MAX \}\)/,
    "the count line rides the rows painted against the mirror");
  // The PUT gate precedes the wire (the defaults law: one explicit act).
  assert.match(SETTINGS, /heading: t\("gc\.settings\.reactionTags\.confirmHeading"\)/);
  // The destructive unmap rides THE one confirm idiom.
  assert.match(SETTINGS, /confirmDialog\(\s*\n?\s*t\("gc\.settings\.reactionTags\.deleteConfirm", \{ emoji: row\.emoji \}\)/);
});

// --- the backend stays byte-frozen against the wave ----------------------------

test("the frozen route table keeps its arms (read, never edited)", () => {
  assert.match(REACTION_TAGS_API, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/reaction-tags\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/opt\$\/\)/);
  assert.match(REACTION_TAGS_API, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/reaction-tags\\\/mine\$\/\)/);
  assert.match(REACTION_TAGS_API, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/reaction-tags\$\/\)/);
  assert.match(REACTION_TAGS_API, /GC_REACTION_TAGS_MAX/);
});

// --- diff scope (the wave-9 freeze idiom) --------------------------------------

// The freeze is the wave-13 lane contract, so the fingerprint is the lane's
// own committed range (base a50bd44 .. the wave tip) — the wave-9 freeze
// pin's lesson, fifth instance: the pin MUST diff the wave's own two
// commits, never a HEAD-open leg, or the first post-wave audit fix breaks it.
// LANE-BASE = a50bd44 (main tip at lane open); LANE-TIP = PLACEHOLDER —
// LANE_TIP_PLACEHOLDER: the lead retargets this to the wave's own feat
// commit at commit time (the wave-10/11/12 retarget-seat precedent).
test("diff scope: the lane touches NO backend file, no constants seat, no core wire", () => {
  const LANE_BASE = "a50bd44";
  const LANE_TIP = "fd6a52c"; // wave-13 feat tip (retargeted by the lead 2026-11-19 — the wave-9 freeze-pin lesson, fifth instance: the pin fingerprints the lane's own range)
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, LANE_TIP, "--", ...FROZEN_WAVE13_PATHS,
    ], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    // A non-git run (an exported tree) cannot answer — the other source-read
    // pins carry the freeze there.
    return;
  }
  assert.equal(touched, "", `${touched ? touched : ""} — the frozen paths must stay untouched`);
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
