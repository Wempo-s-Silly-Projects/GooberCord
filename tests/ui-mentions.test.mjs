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

// The mentions inbox: a rail item with the count pill (never a bell — the
// button law), the /mentions route, dismiss by MESSAGE id, and the 0028
// contingency (unlanded backend → quiet rail state + inline route error,
// never a fabricated list).
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const calls = [];
let responses = [];
globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, method: init.method || "GET" });
  const response = responses.shift();
  return new Response(typeof response === "string" ? response : JSON.stringify(response),
    { status: response?.status ?? 200 });
};

const mentions = await import("../public/js/ui/mentions.js");
const store = (await import("../public/js/core/store.js")).default;
const MENTIONS = readFileSync(join(HERE, "../public/js/ui/mentions.js"), "utf8");
const SHELL = readFileSync(join(HERE, "../public/js/ui/shell.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("the inbox loads into the store; the pill's count IS the list length", async () => {
  responses = [{ mentions: [
    { messageId: 1, channelId: 4, channelName: "general", channelKind: "text",
      authorId: 2, authorUsername: "wempo", body: "hi @me", createdAt: "x", mentionedAt: "y" },
  ] }];
  const list = await mentions.loadMentions();
  assert.equal(list.length, 1);
  assert.equal(store.get("mentions").length, 1);
});

test("dismiss rides the message-id shape (the deprecated endpoint's), then refetches", async () => {
  responses = [{ deleted: true }, { mentions: [] }];
  await mentions.dismissMention(12);
  assert.equal(calls[0].path, "/api/mentions/12");
  assert.equal(calls[0].method, "DELETE");
  assert.deepEqual(store.get("mentions"), [], "the refetch replaces the list; empty renders the empty state");
});

test("the 0028 contingency: no fabricated list when the backend hasn't landed", async () => {
  responses = [{ error: "Route not found.", status: 404 }, null];
  await mentions.loadMentions().catch(() => {});
  assert.equal(store.get("mentions"), undefined,
    "the store stays empty; the route page renders the error string inline");
  assert.match(MENTIONS, /error\.message/, "the catch surfaces the payload text");
});

test("the rail item is TEXT + a count pill — no bell icon anywhere", () => {
  // Comments tell the law; the pin sees only the code.
  const codeOnly = SHELL.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(codeOnly, /mentions-item/);
  assert.match(codeOnly, /count-pill/);
  assert.doesNotMatch(codeOnly, /bell|🔔/i);
  assert.match(MAIN, /addRoute\("\/mentions", "mentions", renderMentions\)/);
});

test("rows guard for the shape: dm/group rows link, server rows are text (no serverId to link)", () => {
  assert.match(MENTIONS, /channelKind === "dm" \|\| mention\.channelKind === "group"/);
  assert.match(MENTIONS, /0028 shape/, "the backend gap (serverId) is documented, not hidden");
  assert.doesNotMatch(MENTIONS, /\bfetch\(/);
});

test("mentions.js speaks through the bundle (the mini-sweep's seats)", () => {
  const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
  const pinned = {
    "gc.mentions.empty": "No mentions waiting — the count pill in the rail tracks it.",
    "gc.mentions.inThread": "in {{channel}}",
    "gc.mentions.threadUnnamed": "the conversation",
    "gc.mentions.inChannel": "in #{{channel}}",
    "gc.mentions.channelUnnamed": "a channel",
    "gc.mentions.dismiss": "Dismiss",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(en[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.match(MENTIONS, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
  // Cross-area reuse: the shell's swept nav seat paints the page heading and
  // the shared keep-set paints the chrome.
  assert.match(MENTIONS, /t\("gc\.shell\.nav\.mentionsShort"\)/);
  assert.match(MENTIONS, /t\("gc\.controls\.back"\)/);
});

test("mentions.js holds NO sweep's leftover literals (the seat scan)", () => {
  const codeOnly = MENTIONS
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/t\("gc\.[^"]*"[^)]*\)/g, "");
  assert.doesNotMatch(codeOnly, /text: "[A-Z←#][^"]*"/);
  assert.doesNotMatch(codeOnly, /"[a-z ]*(conversation|channel)"/,
    "the channel-name fallbacks ride their keys");
});
