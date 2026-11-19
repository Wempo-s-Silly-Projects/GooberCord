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

// Cycle-18 MEDIUMs + riders, pinned (lane-c18-fix). The lane's targets:
// F1 — both capsules mine statements ride ORDER BY reveal_at DESC (the
// deslop-c17 prescription: the actionable open rows paint first, the
// revealed tail truncates harmlessly; zero new binds, probe parity kept)
// and the panel never re-sorts the payload away from that open-first page;
// F2 — the bookmark save's duplicate arm loses the pointer (the 1-seat
// read widens to id + saved_at and the duplicate envelope gains the real
// id/savedAt, so the client's toggle finds its saved truth and the unsave
// door exists on a double-save), with lane dedupe (never a double-row);
// F3 (rider) — a malformed (server-broken) load answer seats the lane NULL
// and paints the failed-load face, never the empty state; the valid empty
// array keeps the empty paint;
// F4 (F1 ride) — gc.capsules.more rewords to a neutral capped-page line
// (the DESC page mixes open + sealed rows), re-translated all-8 bundles.
// The rigs are the suites' own idioms: fakeDb (bookmarks-module.test.mjs),
// the headless render rig (c15-panels.test.mjs), the source-read pin
// (c17-caps.test.mjs).
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

import { handleBookmarkRoutes } from "../api/bookmarks.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const CAPSULES_API = read("api/capsules.mjs");
const CAPSULES_UI = read("public/js/ui/capsules.js");
const BOOKMARKS_API = read("api/bookmarks.mjs");
const BOOKMARKS_UI = read("public/js/ui/bookmarks.js");
const CONSTANTS = read("constants.mjs");

const BUNDLES = ["en", "de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const STAGED = BUNDLES.slice(1);
const bundleCopy = {};
for (const langKey of BUNDLES) {
  bundleCopy[langKey] = JSON.parse(read(`public/locales/${langKey}.json`));
}
const enData = bundleCopy.en;

// --- the bookmark module rig (tests/bookmarks-module.test.mjs idiom) ------------

const ORIGIN = "http://localhost";
const USER_ID = 7;

function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
  };
  return db;
}

const okEnv = (db) => ({
  GOOBER_DB: db,
  GC_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
  GC_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
});

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const BOOKMARK_SAVE_TEST = (sql) => sql.startsWith("INSERT INTO gc_bookmarks");
// The duplicate read: the WIDE shape answers only the id + saved_at seat.
const BOOKMARK_DUPLICATE_READ_TEST = (sql) => sql.startsWith("SELECT id, saved_at FROM gc_bookmarks");

async function dispatchBookmark(method, path, routes) {
  const token = randomToken();
  const request = new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": "csrf-" + token,
    },
  });
  const db = fakeDb([...routes, { test: SESSION_READ_TEST, first: async () => ({
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: "csrf-" + token,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role: "member",
  }) }]);
  const response = await handleBookmarkRoutes(
    request, okEnv(db), new URL(request.url), path, method, undefined,
  ).catch((error) =>
    error instanceof HttpError
      ? json(error.payload || { error: error.message }, error.status, error.headers)
      : null,
  );
  return { db, response, body: response ? JSON.parse(await response.text()) : null };
}

// --- the headless UI rig (tests/c15-panels.test.mjs StubNode idiom) ---------------

class StubNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.textContent = "";
    this.parentNode = null;
  }
  append(...kids) {
    for (const kid of kids) {
      if (!kid || typeof kid !== "object") continue;
      if (kid.parentNode) {
        const sibs = kid.parentNode.children;
        const at = sibs.indexOf(kid);
        if (at >= 0) sibs.splice(at, 1);
      }
      kid.parentNode = this;
      this.children.push(kid);
    }
  }
  remove() {
    if (this.parentNode) {
      const sibs = this.parentNode.children;
      const at = sibs.indexOf(this);
      if (at >= 0) sibs.splice(at, 1);
      this.parentNode = null;
    }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener() {}
  querySelectorAll(selector) {
    const attr = String(selector).replace(/^\[/, "").replace(/\]$/, "");
    const found = [];
    const walk = (node) => {
      if (node.attributes?.has(attr)) found.push(node);
      for (const kid of node.children || []) walk(kid);
    };
    for (const kid of this.children) walk(kid);
    return found;
  }
}

const fixtures = new Map();
const previousFetch = globalThis.fetch;
const previousLocalStorage = globalThis.localStorage;

globalThis.fetch = async (path) => {
  const seat = String(path).split("?")[0];
  if (seat === "/locales/en.json") {
    return new Response(read("public/locales/en.json"), { status: 200 });
  }
  if (fixtures.has(seat)) {
    return new Response(JSON.stringify(fixtures.get(seat)), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "unstubbed: " + seat }), { status: 404 });
};
globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, String(value)); },
  removeItem(key) { this.store.delete(key); },
};
globalThis.Node = StubNode;
globalThis.document = {
  documentElement: new StubNode("html"),
  createElement: (tag) => new StubNode(tag),
  createElementNS: (ns, tag) => new StubNode(tag),
  createTextNode: (text) => { const node = new StubNode("#text"); node.textContent = String(text); return node; },
  body: new StubNode("body"),
  querySelector: () => null,
  querySelectorAll: () => [],
};

const store = (await import("../public/js/core/store.js")).default;
const i18n = await import("../public/js/i18n.js");
await i18n.initI18n();
const bookmarksUi = await import("../public/js/ui/bookmarks.js");
const capsulesUi = await import("../public/js/ui/capsules.js");

// The tree walk (c15-panels idiom): every painted element carrying `class`.
function findAll(root, className) {
  const found = [];
  const walk = (node) => {
    const classes = String(node.className ?? "")
      + " " + String(node.attributes?.get("class") ?? "");
    if (classes.split(" ").includes(className)) found.push(node);
    for (const kid of node.children || []) walk(kid);
  };
  walk(root);
  return found;
}

function textOf(node) {
  if ((node.children?.length ?? 0) === 0) return String(node.textContent ?? "");
  let out = "";
  for (const kid of node.children) out += textOf(kid);
  return out;
}

test.beforeEach(() => {
  fixtures.clear();
  store.reset();
});

// --- F1: the mine page's order law flips to reveal_at DESC -----------------------

test("c18 the mine list statement rides ORDER BY reveal_at DESC", () => {
  assert.match(CAPSULES_API,
    /WHERE author_id = \? AND server_id = \? ORDER BY reveal_at DESC LIMIT "\s*\+\s*GC_CAPSULES_MINE_LIST_MAX;/,
    "the listed page paints the actionable open rows first, zero new binds");
  assert.doesNotMatch(CAPSULES_API, /ORDER BY reveal_at ASC/,
    "the ASC page is retired, not left beside the DESC page");
});

test("c18 the mine probe mirrors the same DESC order and answer shape", () => {
  assert.match(CAPSULES_API,
    /ORDER BY reveal_at DESC LIMIT 1 OFFSET "\s*\+\s*GC_CAPSULES_MINE_LIST_MAX;/,
    "the probe rides the one-row over-extension idiom beside the DESC list");
  const orders = CAPSULES_API.match(/ORDER BY reveal_at [A-Z]+/g) || [];
  assert.deepEqual(orders, ["ORDER BY reveal_at DESC", "ORDER BY reveal_at DESC"],
    "BOTH mine statements share the identical order — probe parity preserved");
});

test("c18 the constants direction note states the DESC page (the parked revisit)", () => {
  const note = CONSTANTS.slice(
    CONSTANTS.indexOf("GC_CAPSULES_MINE_LIST_MAX", CONSTANTS.indexOf("GC_CAPSULES_MAX_OPEN_PER_MEMBER")) - 600,
  );
  assert.ok(note.includes("ORDER BY reveal_at DESC"),
    "the parked order note is revisited: it names the DESC page itself");
});

test("c18 the capsules panel never re-sorts the open-first page away", () => {
  // The DESC lane arrives open-first; the panel paints rows in payload
  // order — no .sort() may rearrange the sealed/open mixture.
  assert.doesNotMatch(CAPSULES_UI, /\.sort\(/, "no re-sort of the payload order");
  assert.match(CAPSULES_UI, /for \(const row of rows\)/,
    "capsuleRows paints the payload's own order");
});

// --- F2: the duplicate save keeps the pointer -------------------------------------

test("c18 the bookmark duplicate arm answers the real id + savedAt", async () => {
  const { db, response, body } = await dispatchBookmark("POST", "/api/messages/101/bookmark", [
    { test: BOOKMARK_SAVE_TEST, run: () => ({ meta: { changes: 0 } }) },
    { test: BOOKMARK_DUPLICATE_READ_TEST, all: () => ({ results: [{ id: 33, saved_at: 123 }] }) },
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(body, { saved: true, duplicate: true, id: 33, savedAt: 123 },
    "the duplicate envelope rides the first-buy shape (additive id + savedAt)");
  const duplicate = db.calls.find((call) => BOOKMARK_DUPLICATE_READ_TEST(call.sql));
  assert.equal(duplicate.bound[0], USER_ID, "the duplicate read stays owner-scoped");
  assert.equal(duplicate.bound[1], 101, "the duplicate read stays message-scoped");
});

test("c18 the fresh save shape is unchanged (additive envelope only)", async () => {
  const { response, body } = await dispatchBookmark("POST", "/api/messages/101/bookmark", [
    { test: BOOKMARK_SAVE_TEST, run: () => ({ meta: { changes: 1, last_row_id: 3 } }) },
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(body, { saved: true, id: 3, savedAt: body.savedAt });
  assert.equal("duplicate" in body, false, "the fresh arm carries no duplicate seat");
});

test("c18 the duplicate read widens from the 1-seat stub to id + saved_at", () => {
  assert.match(BOOKMARKS_API,
    /"SELECT id, saved_at FROM gc_bookmarks b WHERE b\.owner_user_id = \? AND b\.message_id = \? LIMIT 1"/,
    "the first-buy shape's columns ride the read");
  assert.doesNotMatch(BOOKMARKS_API,
    /"SELECT 1 FROM gc_bookmarks b WHERE b\.owner_user_id = \? AND b\.message_id = \? LIMIT 1"/,
    "the 1-seat stub shape is retired (the save gate's NOT EXISTS keeps its own seat)");
});

test("c18 saveBookmark prepends the TRUE pointer row on a duplicate answer", async () => {
  fixtures.set("/api/messages/5/bookmark", { saved: true, duplicate: true, id: 9, savedAt: 123 });
  await bookmarksUi.saveBookmark(5);
  const lane = store.get("bookmarks") || [];
  assert.equal(lane.length, 1, "the duplicate's real pointer lands — the toggle finds its saved truth");
  assert.deepEqual(lane[0], { id: 9, messageId: 5, savedAt: 123 });
});

test("c18 saveBookmark never double-rows a lane already holding the pointer", async () => {
  fixtures.set("/api/messages/5/bookmark", { saved: true, duplicate: true, id: 9, savedAt: 123 });
  await bookmarksUi.saveBookmark(5);
  await bookmarksUi.saveBookmark(5);
  const lane = store.get("bookmarks") || [];
  assert.equal(lane.length, 1, "a lane holding the row (by id or messageId) dedupes — never two rows");
});

test("c18 the fresh save still prepends (the dedupe arm stays additive)", async () => {
  fixtures.set("/api/messages/6/bookmark", { saved: true, id: 44, savedAt: 9 });
  await bookmarksUi.saveBookmark(6);
  const lane = store.get("bookmarks") || [];
  assert.deepEqual(lane, [{ id: 44, messageId: 6, savedAt: 9 }],
    "the fresh pointer still lands head-first — unchanged first-buy behavior");
});

// --- F3: the malformed envelope paints the failed-load face, never empty ----------

test("c18 a payload missing the array keys the lane NULL (bookmarks + capsules)", async () => {
  fixtures.set("/api/bookmarks", { truncated: false });
  await bookmarksUi.loadBookmarks();
  assert.equal(store.get("bookmarks"), null,
    "a server-broken answer seats the lane null — never the empty array");

  fixtures.set("/api/servers/2/capsules/mine", { truncated: false });
  await capsulesUi.loadMineCapsules(2);
  assert.equal(store.get("mineCapsules:2"), null,
    "the mine lane keys per-server and seats null on the malformed shape");
});

test("c18 the valid empty array keeps the empty paint (unchanged)", async () => {
  fixtures.set("/api/bookmarks", { bookmarks: [], truncated: false });
  await bookmarksUi.loadBookmarks();
  assert.deepEqual(store.get("bookmarks"), [],
    "an empty array is the valid empty state, not an error");

  fixtures.set("/api/servers/2/capsules/mine", { capsules: [], truncated: true });
  await capsulesUi.loadMineCapsules(2);
  assert.deepEqual(store.get("mineCapsules:2"), []);
  assert.equal(store.get("mineTruncated:2"), true, "the truncated seat survives the envelope split");
});

test("c18 a NULL bookmarks lane paints the failed-load face, never the empty state", () => {
  store.set({ bookmarks: null }); // the malformed-load seat — no load may fire again
  const mount = new StubNode("main");
  bookmarksUi.renderBookmarksPanel({ params: {} }, mount);
  const errors = findAll(mount, "form-error");
  assert.ok(errors.some((node) => textOf(node) === enData["gc.bookmarks.loadFailed"]),
    "the null lane paints its own failed-load line, the errorLine idiom's class");
  assert.equal(findAll(mount, "empty-state").filter(
    (node) => textOf(node) === enData["gc.bookmarks.empty"]).length, 0,
    "the null lane is NOT the empty paint — the broken answer stays visible");
});

test("c18 a NULL capsules lane paints the failed-load face, never the empty state", () => {
  store.set({ "mineCapsules:2": null });
  const mount = new StubNode("main");
  capsulesUi.renderCapsulesPanel({ params: { serverId: "2" } }, mount);
  const errors = findAll(mount, "form-error");
  assert.ok(errors.some((node) => textOf(node) === enData["gc.capsules.loadFailed"]),
    "the null lane paints its own failed-load line");
  assert.equal(findAll(mount, "empty-state").filter(
    (node) => textOf(node) === enData["gc.capsules.empty"]).length, 0,
    "the null lane is NOT the empty paint");
});

test("c18 both panels carry the loadFailed line with no empty-state conflation", () => {
  for (const [ui, key] of [[BOOKMARKS_UI, "gc.bookmarks.loadFailed"], [CAPSULES_UI, "gc.capsules.loadFailed"]]) {
    assert.match(ui, new RegExp(`lane === null`),
      "the null branch is its own seat, distinct from the load-on-undefined arm");
    assert.match(ui, new RegExp(`t\\("${key.replaceAll(".", "\\.")}"\\)`),
      `${key} is painted verbatim through t()`);
  }
});

test("c18 the loadFailed keys are en-seated and translated all-9-bundles", () => {
  for (const key of ["gc.bookmarks.loadFailed", "gc.capsules.loadFailed"]) {
    const en = enData[key];
    assert.equal(typeof en, "string", `${key} is en-seated`);
    assert.ok(en.length > 0, `${key} seats real copy`);
    for (const langKey of STAGED) {
      const value = bundleCopy[langKey][key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats real copy for ${key}`);
      assert.notEqual(value, en, `${langKey} carries TRANSLATED copy — no en placeholder`);
    }
  }
});

// --- F4: the neutral capped-page line (F1 ride) ------------------------------------

test("c18 gc.capsules.more rewords to the neutral capped-page line", () => {
  assert.equal(enData["gc.capsules.more"], "Showing {{shown}} of your time capsules",
    "the DESC page mixes open + sealed rows — the copy cannot say sealed-only");
  assert.doesNotMatch(enData["gc.capsules.more"], /sealed/i,
    "the sealed-only wording is retired from the en copy");
});

test("c18 the reworded gc.capsules.more is translated all-8-staged (no byte-equal)", () => {
  const en = enData["gc.capsules.more"];
  for (const langKey of STAGED) {
    const value = bundleCopy[langKey]["gc.capsules.more"];
    assert.equal(typeof value, "string", `${langKey} seats the key`);
    assert.ok(value.length > 0, `${langKey} seats real copy`);
    assert.ok(value.includes("{{shown}}"), `${langKey} carries the shown seat`);
    assert.notEqual(value, en, `${langKey} carries TRANSLATED copy — no en placeholder`);
    assert.equal(
      JSON.stringify(Object.keys(bundleCopy[langKey]).filter((key) => /gc\.capsules\.more/.test(key))),
      JSON.stringify(["gc.capsules.more"]),
      "no byte-equal carve, no plural arms");
  }
});
