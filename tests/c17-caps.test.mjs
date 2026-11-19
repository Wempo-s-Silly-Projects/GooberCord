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

// The cycle-17 capsule/bookmark findings, pinned (lane-c17-caps). The lane's
// targets: the capsules mine page answers a capped list of 100 plus an
// additive truncated probe seat (the c16 bookmarks idiom), the create
// envelope seats its id ONLY on a real integer last_row_id (Number(null) is
// 0 — a lie), the bookmark save PREPENDS its fresh pointer to the lane with
// the read's newest-first parity and caps at the list mirror, and the
// capsules panel recomputes the sealed fact from reveal_at at PAINT time
// (the backend's own per-row idiom) instead of trusting an aged mirror
// flag. The fakeDb idiom is the module suites' own (c16-caps.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { handleCapsuleRoutes } from "../api/capsules.mjs";
import * as constants from "../constants.mjs";
const GC_BOOKMARKS_LIST_MAX = constants.GC_BOOKMARKS_LIST_MAX;
const GC_CAPSULES_MINE_LIST_MAX = constants.GC_CAPSULES_MINE_LIST_MAX;
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 2;
const NOW = nowSeconds();

const CAPSULES_API = await readFile(new URL("../api/capsules.mjs", import.meta.url), "utf8");
const CAPSULES_UI = await readFile(new URL("../public/js/ui/capsules.js", import.meta.url), "utf8");
const BOOKMARKS_UI = await readFile(new URL("../public/js/ui/bookmarks.js", import.meta.url), "utf8");
const CONSTANTS = await readFile(new URL("../constants.mjs", import.meta.url), "utf8");
const enData = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];

// The fakeDb idiom (tests/c16-caps.test.mjs): prepared statements match a
// route by SQL shape; handlers get (bound, sql) so a seat can apply the
// statement's own LIMIT the way the engine would.
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
        return route && route.first ? await route.first(statement.bound, sql) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound, sql) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.run ? await route.run(statement.bound, sql) : { meta: { changes: 1 } };
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
const MEMBERSHIP_READ_TEST = (sql) =>
  sql.includes("FROM gc_server_members") && sql.includes("server_id = ? AND user_id = ?");
const CAPSULES_MINE_TEST = (sql) =>
  sql.startsWith("SELECT id, channel_id, reveal_at") && sql.includes("ORDER BY reveal_at");
const CAPSULES_MINE_PROBE_TEST = (sql) => sql.startsWith("SELECT 1 AS one FROM gc_time_capsules");
const CAPSULE_CREATE_TEST = (sql) => sql.startsWith("INSERT INTO gc_time_capsules");

async function dispatchCapsule(method, path, routes, payload = undefined) {
  const token = randomToken();
  const sessionRow = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: "csrf-" + token,
    expires_at: NOW + 3600,
    username: "wempos",
    role: "member",
  };
  const request = new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": "csrf-" + token,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: () => sessionRow },
    { test: MEMBERSHIP_READ_TEST, first: () => ({ role: "member" }) },
    ...routes,
  ]);
  const response = await handleCapsuleRoutes(
    request, okEnv(db), new URL(request.url), path, method, undefined, () => NOW,
  ).catch((error) =>
    error instanceof HttpError
      ? json(error.payload || { error: error.message }, error.status, error.headers)
      : null,
  );
  return { db, response, body: response ? JSON.parse(await response.text()) : null };
}

// --- F1: the mine page caps at the named constant + an additive probe seat ---

test("c17 mine cap stands in constants.mjs at 100 beside the bookmarks cap", async () => {
  assert.equal(GC_CAPSULES_MINE_LIST_MAX, 100, "the mine page's cap value");
  const source = await readFile(new URL("../constants.mjs", import.meta.url), "utf8");
  // Beside the siblings: the capsules block and the bookmarks cap name the
  // same list-cap family; the mine seat rides between them.
  assert.match(source, /export const GC_CAPSULES_MINE_LIST_MAX = 100;[\s\S]*?export const GC_BOOKMARKS_LIST_MAX = 100;/,
    "the mine cap rides beside the capped-list family");
  assert.equal(GC_BOOKMARKS_LIST_MAX, 100, "the bookmarks cap value stays UNCHANGED");
});

test("c17 mine SQL keeps its reveal_at ordering and gains the capped shape + probe", () => {
  // TEST-MOVE (lane-c18-fix): the order seat moved ASC -> DESC
  // (the deslop-c17 prescription — the actionable open rows paint first in
  // the capped page); the pin's SHAPE rides unchanged, only the direction
  // seat re-seats, and the one-row over-extension probe keeps its idiom (the
  // BOOKMARKS_LIST_PROBE_SQL shape at api/bookmarks.mjs).
  assert.match(CAPSULES_API, /ORDER BY reveal_at DESC LIMIT "\s*\+\s*GC_CAPSULES_MINE_LIST_MAX;/,
    "the mine statement caps at the named constant");
  assert.match(CAPSULES_API, /ORDER BY reveal_at DESC LIMIT 1 OFFSET "\s*\+\s*GC_CAPSULES_MINE_LIST_MAX;/,
    "the mine probe rides the one-row over-extension idiom (LIMIT 1 OFFSET cap)");
  const probeBoundShape = CAPSULES_API.match(/CAPSULES_MINE_PROBE_SQL/);
  assert.ok(probeBoundShape, "the probe statement exists");
  assert.match(CAPSULES_API, /truncated: Boolean\(overCap\)/,
    "the mine envelope gains an ADDITIVE truncated seat, the bookmarks shape");
});

const mineRows = (count) => Array.from({ length: count }, (_, index) => ({
  id: count - index,
  channel_id: null,
  reveal_at: NOW + 600 + index,
}));

test("c17 mine answers truncated true with 100 items for 101 rows", async () => {
  const { db, response, body } = await dispatchCapsule(
    "GET", `/api/servers/${SERVER_ID}/capsules/mine`, [
      {
        // The emulator applies the statement's own LIMIT, as the engine
        // would: 101 stored rows, the capped read ships MAX of them.
        test: CAPSULES_MINE_TEST,
        all: (bound, sql) => ({
          results: mineRows(GC_CAPSULES_MINE_LIST_MAX + 1)
            .slice(0, Number(sql.match(/LIMIT (\d+)/)[1])),
        }),
      },
      { test: CAPSULES_MINE_PROBE_TEST, first: () => ({ one: 1 }) },
    ],
  );
  assert.equal(response.status, 200);
  assert.equal(body.capsules.length, GC_CAPSULES_MINE_LIST_MAX, "the page stays capped");
  assert.equal(body.truncated, true, "the 101st row answers a truncation signal");
  const probe = db.calls.find((call) => CAPSULES_MINE_PROBE_TEST(call.sql));
  assert.notEqual(probe, undefined, "the probe rode the wire");
  assert.equal(probe.bound[0], USER_ID, "the probe read is author-scoped");
  assert.equal(probe.bound[1], SERVER_ID, "the probe read is server-scoped");
});

test("c17 mine answers truncated false at 99 rows", async () => {
  const { response, body } = await dispatchCapsule(
    "GET", `/api/servers/${SERVER_ID}/capsules/mine`, [
      { test: CAPSULES_MINE_TEST, all: () => ({ results: mineRows(99) }) },
      { test: CAPSULES_MINE_PROBE_TEST, first: () => null },
    ],
  );
  assert.equal(response.status, 200);
  assert.equal(body.capsules.length, 99);
  assert.equal(body.truncated, false);
});

// --- F1 rider: the client lane mirrors the truncated seat per-server ---------

test("c17 the client lane keys the mine truncated seat per-server and paints gc.capsules.more", () => {
  assert.match(CAPSULES_UI, /const mineTruncatedKey = \(serverId\) => `mineTruncated:\$\{serverId\}`;/,
    "the quiet lane keys PER-SERVER (the mineKey idiom)");
  assert.match(CAPSULES_UI, /store\.set\(\{ \[mineTruncatedKey\(serverId\)\]: payload\?\.truncated === true \}\);/,
    "the envelope's own truncated flag is the only seat — no invented count");
  assert.match(CAPSULES_UI, /t\("gc\.capsules\.more", \{ shown: rows\.length \}\)/,
    "the shown count rides the rows actually painted (the gc.bookmarks.more idiom)");
  assert.equal(CAPSULES_UI.match(/gc\.capsules\.more/g)?.length, 1,
    "ONE capsules more key — painted once");
  assert.match(CAPSULES_UI, /truncated === true \? \[truncatedRow, errorLine\] : \[errorLine\]/,
    "the line paints ONLY when the payload says so");
});

test("c17 gc.capsules.more is en-seated real copy and translated in all 8 staged bundles", async () => {
  const en = enData["gc.capsules.more"];
  assert.equal(typeof en, "string");
  assert.ok(en.includes("{{shown}}"), "the shown seat rides the copy");
  for (const langKey of STAGED) {
    const bundle = JSON.parse(
      await readFile(new URL(`../public/locales/${langKey}.json`, import.meta.url), "utf8"));
    const value = bundle["gc.capsules.more"];
    assert.equal(typeof value, "string", `${langKey} seats the key`);
    assert.ok(value.length > 0, `${langKey} seats real copy`);
    assert.notEqual(value, en, `${langKey} carries TRANSLATED copy — no en placeholder`);
    assert.equal(
      JSON.stringify(Object.keys(bundle).filter((key) => /gc\.capsules\.more/.test(key))),
      JSON.stringify(["gc.capsules.more"]),
      "no byte-equal carve, no plural arms");
  }
});

// --- F2 (LOW-1): the save PREPENDS newest-first and caps the lane -------------

test("c17 the bookmark save prepends the fresh row first and caps at the list mirror", () => {
  assert.match(BOOKMARKS_UI, /G-4 mirror: GC_BOOKMARKS_LIST_MAX \(constants\.mjs\)/,
    "the mirror carries its provenance comment seat");
  assert.match(BOOKMARKS_UI, /UI_BOOKMARKS_LIST_MAX = 100;/);
  // TEST-MOVE (lane-c18-fix): the lane expression lifted to a `lane` const
  // (the duplicate arm's dedupe rides the same read) — the PREPEND+capped
  // slice shape stays, only its spelling moved.
  assert.match(BOOKMARKS_UI,
    /\[freshRow, \.\.\.lane\]\s*\.slice\(0, UI_BOOKMARKS_LIST_MAX\)/,
    "the fresh pointer paints FIRST (the capped read's newest-first parity) and the lane never grows past the mirror");
  assert.match(BOOKMARKS_UI, /\[freshRow, \.\.\./,
    "no appended tail: the fresh row is not pushed to the END of the lane");
});

// --- F3 (LOW-2): the paint recomputes sealed from revealAt --------------------

test("c17 the painted sealed state derives from revealAt, never the payload flag", () => {
  assert.match(CAPSULES_UI, /Number\(row\.revealAt\) > /,
    "the per-row recompute at PAINT time (the mine route's own idiom)");
  assert.match(CAPSULES_UI, /Date\.now\(\) \/ 1000/,
    "the paint compares against now, no stored state");
  assert.doesNotMatch(CAPSULES_UI, /row\.sealed === true/,
    "the payload's sealed flag is NOT the painted-seat source — an aged mirror cannot paint a stale delete door");
  assert.match(CAPSULES_UI, /revealed\?\.sealed === false/,
    "the reveal handler's unsealed-shape guard stays (the body rides the one read)");
});

// --- F4 (LOW-4): the create envelope seats its id ONLY on a real integer ------

test("c17 create answers NO id seat when last_row_id is null or absent", async () => {
  for (const meta of [{ changes: 1, last_row_id: null }, { changes: 1, last_row_id: undefined }, { changes: 1 }]) {
    const { response, body } = await dispatchCapsule(
      "POST", `/api/servers/${SERVER_ID}/capsules`, [
        { test: CAPSULE_CREATE_TEST, run: () => ({ meta }) },
      ],
      { body: "see you next year", revealAt: NOW + 3600 },
    );
    assert.equal(response.status, 201);
    assert.equal("id" in body, false, "a missing seat ships NO id: 0 (a lie)");
    assert.equal(body.sealed, true);
    assert.equal("body" in body, false);
  }
});

test("c17 create still seats the id on a real integer last_row_id", async () => {
  const { body } = await dispatchCapsule(
    "POST", `/api/servers/${SERVER_ID}/capsules`, [
      { test: CAPSULE_CREATE_TEST, run: () => ({ meta: { changes: 1, last_row_id: 42 } }) },
    ],
    { body: "see you next year", revealAt: NOW + 3600 },
  );
  assert.equal(body.id, 42, "the real seat answers exactly as before");
});
