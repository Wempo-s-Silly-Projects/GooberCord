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

// The members lane: the roster contract (routes, store key, staff-field
// gating, the G-3/G-5 copy) and the member card route. Behavior runs against
// a stubbed fetch; the DOM-rendered halves pin by source.
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const calls = [];
globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, method: init.method || "GET", body: init.body });
  const response = responses.shift();
  if (!response) return new Response(JSON.stringify({}), { status: 200 });
  return new Response(typeof response === "string" ? response : JSON.stringify(response), {
    status: response.status ?? 200,
  });
};
let responses = [];

const members = await import("../public/js/ui/members.js");
const store = (await import("../public/js/core/store.js")).default;
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
const MEMBERS = readFileSync(join(HERE, "../public/js/ui/members.js"), "utf8");

const ROSTER = {
  server: { id: 5, hasRules: true },
  viewer: { owner: false, permissions: ["MANAGE_ROLES"], topPosition: 3 },
  roles: [{ id: 1, name: "mods", color: "#397357", position: 3, permissions: [] }],
  members: [{
    id: 2, username: "wempo", nickname: null, avatarUrl: null, membershipRole: "member",
    isPlus: true, roleIds: [1], topPosition: 3, joinedAt: "2026-11-17T08:00:00Z",
    accountCreatedAt: "2026-11-01T08:00:00Z",
  }],
};

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("loadRoster fills the store's per-server envelope; a refusal rethrows (never a fake empty list)", async () => {
  responses = [ROSTER];
  const payload = await members.loadRoster(5);
  assert.deepEqual(payload.viewer.permissions, ["MANAGE_ROLES"]);
  assert.equal(members.rosterOf(5), payload);
  responses = [{ status: 403, error: "You do not have permission to do that." }];
  await members.loadRoster(5).catch((error) => {
    assert.equal(error.message, "You do not have permission to do that.");
  });
});

test("the roster routes and the member card", async () => {
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/member\/:uid", "member", renderMemberCard\)/);
  assert.match(MEMBERS, /\/api\/servers\/\$\{serverId\}\/roster/);
  // The staff gate: platform owner OR the KICK_MEMBERS bit — and the fields
  // render ONLY for that gate, never disabled-for-plain-members.
  assert.match(MEMBERS, /payload\?\.viewer\?\.owner\s*\|\|/);
  assert.match(MEMBERS, /permissions\?\.includes\("KICK_MEMBERS"\)/);
  assert.match(MEMBERS, /Mod fields render for staff/);
  assert.match(MEMBERS, /render at all, not disabled ones/, "zero mod bits = no fields (never disabled-for-all)");
});

test("the nickname writes: PATCH self and PATCH other, input never cleared on a 400", async () => {
  assert.match(MEMBERS, /\/api\/servers\/\$\{serverId\}\/nick`/);
  assert.match(MEMBERS, /\/api\/servers\/\$\{serverId\}\/nick\/\$\{uid\}/);
  // The body grammar: null clears, a string sets — the contract's shape.
  assert.match(MEMBERS, /nickname: nickname === null \? null : String\(nickname\)/);
  // The word-filter 400 keeps the input: the error renders, no value reset.
  assert.doesNotMatch(MEMBERS, /\.value = ""/);
  responses = [ROSTER];
  await members.loadRoster(5);
  responses = [{ member: { serverId: 5, userId: 2, nickname: "wem" } }];
  const saved = await members.saveNickname(5, 2, "wem");
  assert.deepEqual(JSON.parse(calls[1].body), { nickname: "wem" }, "the PATCH is the second call");
  assert.equal(saved.member.nickname, "wem");
  assert.equal(members.rosterOf(5).members[0].nickname, "wem", "the cache rides the echo");
});

test("the empty roster speaks the invite instruction (G-5)", () => {
  assert.match(MEMBERS, /t\("gc\.members\.roster\.alone"\)/);
});

test("roster rows are self-offering links into the card route — never rows of buttons", () => {
  assert.match(MEMBERS, /class: "member-row", href: cardUrl\(member\.id\)/);
  assert.doesNotMatch(MEMBERS, /class: "button[\s\S]{0,120}member-row/);
});

// --- the members lane speaks through the bundle --------------------------------

const EN = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

test("members.js speaks through gc.members.* (and the swept seats only)", () => {
  const pinned = {
    "gc.members.roster.alone": "It's just you in here so far — invite someone.",
    "gc.members.roster.inviteLink": "Invite or discover a server",
    "gc.members.card.nicknameLabel": "Your nickname here",
    "gc.members.card.nicknameHeading": "Nickname",
    "gc.members.card.nicknameHelp": "1–32 characters.",
    "gc.members.card.saveNickname": "Save nickname",
    "gc.members.card.noNickname": "No nickname set.",
    "gc.members.card.timedOut": "timed out",
    "gc.members.card.timedOutUntil": "timed out until",
    "gc.members.card.rulesAccepted": "rules accepted",
    "gc.members.card.verificationPending": "verification pending",
    "gc.members.card.joined": "Joined",
    "gc.members.card.accountMade": "· account made",
    "gc.members.card.viaInvite": "Came in on invite",
    "gc.members.card.owesVerification": "Still owes verification.",
    "gc.members.card.notesHeading": "Moderation notes",
    "gc.members.errors.notMember": "That member is not in this server.",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(EN[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.match(MEMBERS, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
  // The collapsed twins reuse the first-swept seats — the two members-side
  // seeds (friendsHeading, roster.fetching) died at this commit.
  assert.equal(EN["gc.members.card.friendsHeading"], undefined,
    "Friends & DMs rides gc.social.friends.heading once");
  assert.equal(EN["gc.members.roster.fetching"], undefined,
    "the roster fetch line rides gc.settings.roles.fetchingRoster once");
  assert.match(MEMBERS, /t\("gc\.social\.friends\.heading"\)/);
  assert.match(MEMBERS, /t\("gc\.social\.row\.message"\)/);
  assert.match(MEMBERS, /t\("gc\.settings\.roles\.fetchingRoster"\)/);
  assert.match(MEMBERS, /t\("gc\.controls\.back"\)/);
  // "Goober+" is the tier's brand chip — it stays code-side, unpainted.
});

test("members.js holds NO sweep's leftover literals (the seat scan)", () => {
  const codeOnly = MEMBERS
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/t\("gc\.[^"]*"[^)]*\)/g, "")
    // The Goober+ tier chip is the brand's own name — never localized.
    .replace(/text: "Goober\+"/g, "");
  assert.doesNotMatch(codeOnly, /text: "[A-Z←"'][^"]*"/);
  assert.doesNotMatch(codeOnly, /label: "[A-Z][^"]*"/);
  assert.doesNotMatch(codeOnly, /description: "[A-Z0-9][^"]*"/);
});
