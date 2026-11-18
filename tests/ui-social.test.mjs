// Copyright 2026 ItsWempo
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

// The social lane: the friends/blocks/status routes' body grammar, the DM
// find-or-create, the hub's quiet-lane structure, and the row-write idiom the
// hover:none clause keeps visible (the W-R2 rider). No cap arithmetic
// client-side — the caps live in the server's 400 texts (G-2 verbatim).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const calls = [];
globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, method: init.method || "GET", body: init.body });
  const response = responses.shift();
  return new Response(typeof response === "string" ? response : JSON.stringify(response),
    { status: Number.isInteger(response?.status) ? response.status : 200 });
};
let responses = [];

const social = await import("../public/js/ui/social.js");
const store = (await import("../public/js/core/store.js")).default;
const router = await import("../public/js/core/router.js");
const SOCIAL = readFileSync(join(HERE, "../public/js/ui/social.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");

const FRIENDS = {
  friends: [{ userId: 4, username: "ally", createdAt: "2026-11-16T00:00:00Z", isPlus: false }],
  pendingSent: [],
  pendingReceived: [{ userId: 9, username: "newcomer", createdAt: "2026-11-17T00:00:00Z" }],
  settings: { acceptRequests: true },
};

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("the loads fill the store's lanes", async () => {
  responses = [FRIENDS, { conversations: [] }, { blocked: [] }];
  const payload = await social.loadSocial();
  assert.equal(payload.settings.acceptRequests, true);
  assert.equal(store.get("friends").friends.length, 1);
  await social.loadConversations();
  assert.deepEqual(store.get("conversations"), []);
  await social.loadBlocks();
  assert.deepEqual(store.get("blocks"), []);
});

test("the DM find-or-create lands the member on the conversation route, body verbatim { userIds }", async () => {
  const CONV = { conversation: { id: 3, name: null, kind: "dm", members: [
    { userId: 1, username: "me", isPlus: false },
    { userId: 4, username: "ally", isPlus: false },
  ] } };
  // The route registry rides this test file too (the router is a singleton).
  router.addRoute("/dm/:id", "conversation-test", () => {});
  responses = [CONV, { conversations: [CONV.conversation] }];
  await social.startConversation(4);
  assert.equal(calls[0].path, "/api/conversations");
  assert.deepEqual(JSON.parse(calls[0].body), { userIds: [4] });
  assert.equal(router.current()?.name, "conversation-test", "navigation to /dm/:id");
});

test("the status write keeps absent keys absent (the contract's KEEP semantics)", async () => {
  responses = [{ status: { statusText: "building", statusUntil: null, presenceState: null } }];
  await social.setStatus({ statusText: "building" });
  assert.deepEqual(JSON.parse(calls[0].body), { statusText: "building" });
  responses = [{ status: { statusText: null, statusUntil: null, presenceState: "idle" } }];
  await social.setStatus({ statusText: null, presenceState: "idle" });
  assert.deepEqual(JSON.parse(calls[1].body), { statusText: null, presenceState: "idle" });
});

test("the gate toggle writes through with a boolean body", async () => {
  responses = [{ settings: { acceptRequests: false } }];
  await social.setAcceptRequests(false);
  assert.deepEqual(JSON.parse(calls[0].body), { acceptRequests: false });
  assert.equal(store.get("friends").settings.acceptRequests, false, "reflected without refetch");
});

test("routes: the hub, the dm seat the chat wave re-registered, one route per area (G-6)", () => {
  assert.match(MAIN, /addRoute\("\/friends", "friends", renderSocialHub\)/);
  assert.match(MAIN, /addRoute\("\/dm\/:id", "conversation", renderConversation\)/);
  assert.match(SOCIAL, /"Group chats only\. A dm IS its member list\."|kind === "group"/);
});

test("the hub's panels: requests settle, outgoing-only cancel, blocks unblock", () => {
  assert.match(SOCIAL, /\/api\/friends\/requests\/accept/);
  assert.match(SOCIAL, /\/api\/friends\/requests\/decline/);
  assert.match(SOCIAL, /Only MINE carry the cancel/);
  assert.match(SOCIAL, /\/api\/blocks\/\$\{userId\}`.{0,40}method: "DELETE"/);
  assert.match(SOCIAL, /t\("gc\.social\.blocks\.member", \{ id: block\.userId \}\)/, "a null username renders the id placeholder through the key");
});

test("no client-side cap arithmetic — the caps live in the server's verbatim 400s", () => {
  assert.doesNotMatch(SOCIAL, /MAX_FRIENDS|MAX_PENDING|\b1000\b|\b20\b/);
});

test("rows offer themselves; the silent writes ride hover (the re-pinned rider)", () => {
  assert.match(SOCIAL, /class: "friend-row"/);
  assert.match(SOCIAL, /row-quiet-control/);
  assert.match(SOCIAL, /event\.stopPropagation/, "a row write never triggers the row's own action");
});
