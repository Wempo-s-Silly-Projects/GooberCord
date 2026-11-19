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

// The store-key namespace pin: the WS presence frame's lane keys
// `presence:<id>` (an ARRAY of mounted members); `roster:<serverId>` stays
// exclusively the /api/servers/:id/roster ENVELOPE (shape {members,...}, set
// by members.js). The two id tables are independent AUTOINCREMENT counters,
// so channelId == serverId is reachable — a shared namespace let chat's
// array frame overwrite the envelope and members.js's [..payload.members]
// spread threw undefined inside renderRosterBody (uncaught in renderRoute —
// the shell paint wedged). The seats live inside renderChannelPane's
// onFrame wiring, so the pins read the source (the DOM-rendered idiom).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const CHAT = readFileSync(join(HERE, "../public/js/ui/chat.js"), "utf8");
const MEMBERS = readFileSync(join(HERE, "../public/js/ui/members.js"), "utf8");

test("the channel presence frame writes the presence: lane, never the roster:", () => {
  assert.match(CHAT,
    /} else if \(frame\.type === "roster" \&\& Array\.isArray\(frame\.members\)\) \{\n\s*store\.set\(\{ \[`presence:\$\{channelId\}`\]: frame\.members \}\);/,
    "the mounted channel's roster frame keys presence:<channelId> and only stores an array");
});

test("the DM presence frame writes the presence: lane, never the roster:", () => {
  assert.match(CHAT, /store\.set\(\{ \[`presence:\$\{conversationId\}`\]: frame\.members \}\);/);
});

test("the live rail paint subscribes and reads the presence: lane", () => {
  assert.match(CHAT, /rosterUnsub = store\.subscribe\(`presence:\$\{channelId\}`/);
  assert.match(CHAT, /const members = store\.get\(`presence:\$\{channelId\}`\) \|\| \[\];/);
});

test("the message lane and the pins pane read the presence: lane", () => {
  assert.match(CHAT, /store\.get\(`presence:\$\{channelId\}`\)/);
  assert.equal(CHAT.match(/store\.get\(`presence:\$\{channelId\}`\)/g).length, 3,
    "laneRefresh + the rail paint + the pins pane — all three seats");
});

test("chat.js never touches the roster: namespace (members.js owns it)", () => {
  assert.equal((CHAT.match(/roster:\$/g) || []).length, 0,
    "a channel id and a server id collide on the same number — chat's presence array must never share the namespace");
});

test("members.js keeps the roster: envelope (shape {members,...}) alone", () => {
  assert.match(MEMBERS, /const rosterKey = \(serverId\) => `roster:\$\{serverId\}`;/);
  assert.match(MEMBERS, /store\.set\(\{ \[rosterKey\(serverId\)\]: payload \}\);/);
  assert.match(MEMBERS, /payload\.members\.toSorted\(/, "the roster seat sorts a COPY (toSorted) — the envelope's array never mutates");
});
