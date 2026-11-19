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

// The go-haywire-c16 LOW findings, pinned. The lane's three targets: the
// capsule by-id arms answer ONLY through the owning server's URL namespace
// (a member of two servers must not address their server-A capsule through
// a server-B URL), the bookmark list carries an additive truncated signal
// past its cap, and the capsule body cap's comment seats record the 0052
// CHECK's wider 4000 backstop against the 2000 route constant. The fakeDb
// idiom is the module suites' own; the "real sqlite" nuance it emulates is
// the seat branch — a read whose WHERE lacks the server seat matches the
// row through ANY server's URL (the leak), and only the fixed shape can
// miss on a foreign serverId.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { handleCapsuleRoutes } from "../api/capsules.mjs";
import { handleBookmarkRoutes } from "../api/bookmarks.mjs";
import { GC_BOOKMARKS_LIST_MAX, GC_CAPSULE_BODY_MAX } from "../constants.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const USER_SERVER = 2; // the capsule's OWN server
const FOREIGN_SERVER = 1; // the URL's server in the cross-server pins
const NOW = nowSeconds();

// The fakeDb idiom (tests/time-capsules-module.test.mjs): prepared
// statements match a route by SQL shape; handlers get (bound, sql) so the
// seat branch can tell the pre-fix leak shape from the fixed one.
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
const AUTHOR_READ_TEST = (sql) =>
  sql.startsWith("SELECT id, author_id, channel_id, reveal_at") && sql.includes("author_id = ?");
const VIEW_READ_TEST = (sql) =>
  sql.startsWith("SELECT id, author_id, channel_id, reveal_at FROM gc_time_capsules WHERE id = ?");
const BODY_READ_TEST = (sql) => sql.startsWith("SELECT body FROM gc_time_capsules");
const CAPSULE_DELETE_TEST = (sql) => sql.startsWith("DELETE FROM gc_time_capsules");
const CHANNEL_ACCESS_TEST = (sql) => sql.startsWith("SELECT c.id, c.server_id, c.kind FROM gc_channels");

async function dispatchCapsule(method, path, routes) {
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
  });
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: () => sessionRow },
    // The member-of-both-servers gate: only the by-id arms are on trial.
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

// The one capsule under trial: authored by USER_ID, sealed into
// USER_SERVER, already revealed with a channel target (the widest shape —
// every arm on trial can reach the same row).
const capsuleRow = {
  id: 9,
  author_id: USER_ID,
  server_id: USER_SERVER,
  channel_id: 55,
  reveal_at: NOW - 600,
};

// The author read under the seat branch: without the server seat the read
// matches the row through ANY URL (pre-fix leak); with it, only an owning
// serverId bound in the seat answers.
const authorReadRoute = {
  test: AUTHOR_READ_TEST,
  first: (bound, sql) => {
    if (!sql.includes("server_id = ?")) return capsuleRow;
    return Number(bound[0]) === capsuleRow.id && Number(bound[1]) === USER_SERVER
      ? capsuleRow
      : null;
  },
};

// The non-author view read under the same seat branch lives with
// nonAuthorRow further down.

const bodyReadRoute = { test: BODY_READ_TEST, first: () => ({ body: "letter from server two" }) };
const channelAccessRoute = {
  test: CHANNEL_ACCESS_TEST,
  first: () => ({ id: 55, server_id: USER_SERVER, kind: "text" }),
};

test("c16 capsule by-id 404s through a foreign server's URL", async () => {
  const { response } = await dispatchCapsule(
    "GET", `/api/servers/${FOREIGN_SERVER}/capsules/9`, [authorReadRoute],
  );
  assert.equal(response.status, 404, "the author arm must not match through a foreign URL");
});

test("c16 capsule by-id answers through its owning server's URL with the seat bound", async () => {
  const { db, response, body } = await dispatchCapsule(
    "GET", `/api/servers/${USER_SERVER}/capsules/9`, [authorReadRoute],
  );
  assert.equal(response.status, 200);
  assert.equal(body.sealed, false, "post-reveal the author's own arm still delivers the letter");
  const authorRead = db.calls.find((call) => AUTHOR_READ_TEST(call.sql));
  assert.equal(Number(authorRead.bound[1]), USER_SERVER, "the URL's serverId rides the seat");
  assert.equal(Number(authorRead.bound[2]), USER_ID, "the author seat follows the server seat");
});

// A DIFFERENT author's revealed capsule: the view read's seat branch is on
// trial (the author arm must miss for this row on any URL).
const nonAuthorRow = { id: 10, author_id: 8, server_id: USER_SERVER, channel_id: 55, reveal_at: NOW - 600 };
const nonAuthorViewReadRoute = {
  test: VIEW_READ_TEST,
  first: (bound, sql) => {
    if (!sql.includes("server_id = ?")) return nonAuthorRow;
    return Number(bound[0]) === nonAuthorRow.id && Number(bound[1]) === USER_SERVER
      ? nonAuthorRow
      : null;
  },
};
const emptyAuthorReadRoute = { test: AUTHOR_READ_TEST, first: () => null };

test("c16 revealed non-author arm 404s through a foreign server's URL", async () => {
  const { response, body } = await dispatchCapsule(
    "GET", `/api/servers/${FOREIGN_SERVER}/capsules/10`,
    [emptyAuthorReadRoute, nonAuthorViewReadRoute, channelAccessRoute, bodyReadRoute],
  );
  assert.equal(response.status, 404, "the view arm must not match through a foreign URL");
  assert.equal("body" in (body || {}), false, "no letter body ever rides the foreign URL");
});

// The delete arms' row: PRE-reveal (reveal_at in the future), so the
// author arm's classification hands a deletable row and the DELETE itself
// is on trial.
const openRow = { ...capsuleRow, reveal_at: NOW + 600 };
const openAuthorReadRoute = {
  test: AUTHOR_READ_TEST,
  first: (bound, sql) => {
    if (!sql.includes("server_id = ?")) return openRow;
    return Number(bound[0]) === openRow.id && Number(bound[1]) === USER_SERVER
      ? openRow
      : null;
  },
};

test("c16 delete 404s through a foreign server's URL", async () => {
  const { db, response } = await dispatchCapsule(
    "DELETE", `/api/servers/${FOREIGN_SERVER}/capsules/9`,
    [openAuthorReadRoute, { test: CAPSULE_DELETE_TEST, run: () => ({ meta: { changes: 1 } }) }],
  );
  assert.equal(response.status, 404, "the pre-check arm must not match through a foreign URL");
  assert.equal(db.calls.filter((call) => CAPSULE_DELETE_TEST(call.sql)).length, 0,
    "a foreign-URL address never reaches the DELETE");
});

test("c16 delete statement carries the server seat with id then server then author", async () => {
  const { db, response } = await dispatchCapsule(
    "DELETE", `/api/servers/${USER_SERVER}/capsules/9`, [openAuthorReadRoute],
  );
  assert.equal(response.status, 200);
  const deleteCall = db.calls.find((call) => CAPSULE_DELETE_TEST(call.sql));
  assert.ok(CAPSULE_DELETE_TEST(deleteCall.sql) && deleteCall.sql.includes("server_id = ?"),
    "the DELETE's own WHERE carries the server seat");
  assert.deepEqual(deleteCall.bound, [9, USER_SERVER, USER_ID, NOW]);
});

// F2: the bookmarks list answers an additive truncated signal. The list
// statement keeps its exact capped shape; the probe route is a separate
// one-row over-extension read.
const BOOKMARK_LIST_TEST = (sql) =>
  sql.startsWith("SELECT id, message_id, saved_at FROM gc_bookmarks");
const BOOKMARK_PROBE_TEST = (sql) => sql.startsWith("SELECT 1 AS one FROM gc_bookmarks");

async function dispatchBookmarkList(routes) {
  const token = randomToken();
  const sessionRow = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: "csrf-" + token,
    expires_at: NOW + 3600,
    username: "wempos",
    role: "member",
  };
  const request = new Request(ORIGIN + "/api/bookmarks", {
    headers: { Origin: ORIGIN, Cookie: "goober_session=" + token, "X-CSRF-Token": "csrf-" + token },
  });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: () => sessionRow }, ...routes]);
  const response = await handleBookmarkRoutes(
    request, okEnv(db), new URL(request.url), "/api/bookmarks", "GET", undefined,
  ).catch((error) =>
    error instanceof HttpError
      ? json(error.payload || { error: error.message }, error.status, error.headers)
      : null,
  );
  return { db, response, body: response ? JSON.parse(await response.text()) : null };
}

const listRows = (count) => Array.from({ length: count }, (_, index) => ({
  id: count - index,
  message_id: 1000 - index,
  saved_at: NOW - index,
}));

test("c16 bookmark list answers truncated true with 100 items for 101 rows", async () => {
  const { db, response, body } = await dispatchBookmarkList([
    {
      // The emulator applies the statement's own LIMIT, as the engine
      // would: 101 stored rows, the capped read ships MAX of them.
      test: BOOKMARK_LIST_TEST,
      all: (bound, sql) => ({
        results: listRows(GC_BOOKMARKS_LIST_MAX + 1)
          .slice(0, Number(sql.match(/LIMIT (\d+)/)[1])),
      }),
    },
    { test: BOOKMARK_PROBE_TEST, first: () => ({ one: 1 }) },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.bookmarks.length, GC_BOOKMARKS_LIST_MAX, "the page stays capped");
  assert.equal(body.truncated, true, "the 101st row answers a truncation signal");
  assert.equal(db.calls.find((call) => BOOKMARK_PROBE_TEST(call.sql)).bound[0], USER_ID,
    "the probe read is owner-scoped");
});

test("c16 bookmark list answers truncated false at 99 rows", async () => {
  const { response, body } = await dispatchBookmarkList([
    { test: BOOKMARK_LIST_TEST, all: () => ({ results: listRows(99) }) },
    { test: BOOKMARK_PROBE_TEST, first: () => null },
  ]);
  assert.equal(response.status, 200);
  assert.equal(body.bookmarks.length, 99);
  assert.equal(body.truncated, false);
});

// F3: the cap value stays UNCHANGED with its provenance comment seat.
test("c16 capsule body cap keeps 2000 with the schema-backstop provenance seat", async () => {
  assert.equal(GC_CAPSULE_BODY_MAX, 2000, "the route cap value must not move");
  const source = await readFile(new URL("../constants.mjs", import.meta.url), "utf8");
  assert.match(source, /schema_backstop_4000_vs_route_2000/,
    "the 0052 CHECK's wider 4000 backstop carries a provenance seat");
});
