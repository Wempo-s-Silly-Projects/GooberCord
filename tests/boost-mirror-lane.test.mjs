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
// see <https://www.gnu.org/licenses/>.

// T79 RED lane (docs/drafts/t79-post-boost-spec.md): the two lead-named
// contract rows for the forum post boost's GC render half — the announcement
// channel id gate and the mirrored card's byte shape. These rows are RED by
// design at spec time: api/boost.mjs does not exist yet (the spec's §3
// records the import failure as the red state); the GREEN commit writes the
// module to the spec and flips the file, not these expectations.
import test from "node:test";
import assert from "node:assert/strict";

import { validateAnnouncementChannel, renderBoostCard, handleConsumeBoostsRoute } from "../api/boost.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";

const FORUM_ORIGIN = "https://wempos-forum.itswempo.workers.dev";

const ANNOUNCEMENT_CHANNEL = {
  id: 12,
  server_id: 3,
  name: "announcement",
  kind: "announcement",
  position: 0,
};

const BOOST = {
  id: 1,
  forum_post_id: 4242,
  thread_title: "The wobbly button thread",
  thread_excerpt: "A member asked for the wobbly buttons and the owner shipped them.",
  author_id: 7,
  author_name: "wempos",
};

// --- the announcement channel id gate -------------------------------------------

test("an unknown channel id fails the announcement gate with 404", () => {
  assert.throws(
    () => validateAnnouncementChannel(null),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

test("a text channel fails the announcement gate with 409", () => {
  assert.throws(
    () => validateAnnouncementChannel({ ...ANNOUNCEMENT_CHANNEL, kind: "text" }),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test("a voice channel fails the announcement gate with 409", () => {
  assert.throws(
    () => validateAnnouncementChannel({ ...ANNOUNCEMENT_CHANNEL, kind: "voice" }),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test("an announcement channel passes the gate and rides it untouched", () => {
  assert.equal(validateAnnouncementChannel(ANNOUNCEMENT_CHANNEL), ANNOUNCEMENT_CHANNEL);
});

// --- the mirrored card shape ------------------------------------------------------

test("the mirrored card carries title, excerpt and provenance on its lines", () => {
  const card = renderBoostCard(BOOST, FORUM_ORIGIN);
  assert.equal(
    card.body,
    "[Forum boost] The wobbly button thread\n" +
      "\n" +
      "A member asked for the wobbly buttons and the owner shipped them.\n" +
      "\n" +
      `Posted in the forum by wempos — read it at ${FORUM_ORIGIN}/posts/4242`,
  );
});

test("a long thread excerpt ellipsizes at the card's 240-character cap", () => {
  const longExcerpt = "x".repeat(300);
  const card = renderBoostCard({ ...BOOST, thread_excerpt: longExcerpt }, FORUM_ORIGIN);
  assert.equal(card.body.split("\n")[2], "x".repeat(240) + "…");
});

test("the card's provenance rides the forum's canonical /posts/ addressable URL", () => {
  const card = renderBoostCard(BOOST, FORUM_ORIGIN);
  assert.ok(card.body.endsWith(`${FORUM_ORIGIN}/posts/${BOOST.forum_post_id}`));
});

// --- the wave-3 rider rows (R6 + R5, spec §4) -----------------------------------
// Route-level pins through handleConsumeBoostsRoute with the ordered fake db
// (the servers-module idiom): session read → channel kind read → member gate
// → SEND layers (null context: the graceful default passes) → R5 wall →
// pending read → the R6 ban screen. The limiter stub rides the env and every
// call is recorded, so the pins see the gate order.

const ORIGIN = "http://localhost";
const USER_ID = 7;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

async function sessionRow() {
  const token = randomToken();
  const csrf = randomToken(24);
  return {
    token,
    csrf,
    row: {
      token_hash: await sha256Hex(token),
      user_id: USER_ID,
      csrf_token: csrf,
      expires_at: nowSeconds() + 3600,
      username: "wempos",
      role: "member",
      avatar_status: null,
      avatar_mime: null,
      avatar_updated_at: null,
      avatar_version: null,
      totp_enabled: 0,
    },
  };
}

// Ordered fake db (the servers-module idiom, trimmed to first/all).
function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        bound: [],
        bind: (...values) => {
          statement.bound = values;
          return statement;
        },
        first: async () => {
          calls.push({ call: "first", sql, bound: statement.bound });
          const route = find(sql);
          return route && route.first ? route.first(statement.bound) : null;
        },
        all: async () => {
          calls.push({ call: "all", sql, bound: statement.bound });
          const route = find(sql);
          return route && route.all ? route.all(statement.bound) : { results: [] };
        },
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const item of statements) {
        const route = find(item.sql);
        results.push(route && route.all ? { results: await route.all() } : { results: [] });
      }
      calls.push({ call: "batch" });
      return results;
    },
  };
}

async function dispatchConsume(request, env) {
  try {
    return await handleConsumeBoostsRoute(request, env, 3, 12);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(error.payload || { error: error.message }, error.status, error.headers);
  }
}

function mintLimiter() {
  const limited = [];
  return {
    limited,
    limit: async ({ key }) => {
      limited.push(key);
      return { success: true };
    },
  };
}

// The consume fixtures: signed-in member, announcement channel, the member
// gate passes, the SEND layers answer nothing (null context = graceful
// default), one pending boost.
function consumeRoutes(pendingResults, options = {}) {
  return [
    { test: SESSION_READ_TEST, first: async () => options.session?.row },
    {
      test: (sql) => sql.includes("SELECT id, server_id, kind FROM gc_channels"),
      first: async () => ({ id: 12, server_id: 3, kind: "announcement" }),
    },
    {
      test: (sql) => sql.includes("FROM gc_channels c WHERE c.id = ?"),
      first: async () => ({ id: 12, server_id: 3, kind: "announcement" }),
    },
    {
      test: (sql) => sql.includes("FROM gc_fleet_boosts b JOIN users"),
      all: async () => ({ results: pendingResults }),
    },
    {
      test: (sql) => sql.includes("FROM bans WHERE user_id = ? AND revoked_at IS NULL"),
      first: async () => (options.banned ? { reason: "x", expires_at: null } : null),
    },
  ];
}

test("the R6 ban screen refuses a banned author's pending boost with 409 and renders nothing", async () => {
  const { token, csrf, row } = await sessionRow();
  const limiter = mintLimiter();
  const db = fakeDb(
    consumeRoutes(
      [{ id: 1, forum_post_id: 9, author_id: 3, thread_title: "t", thread_excerpt: "e", author_name: "goob" }],
      { session: { row }, banned: true },
    ),
  );
  const response = await dispatchConsume(
    new Request(ORIGIN + "/api/servers/3/channels/12/consume-boosts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-CSRF-Token": csrf,
        Cookie: "__Host-goober_session=" + token,
      },
    }),
    { GOOBER_DB: db, GC_MESSAGE_RATE_LIMITER: limiter },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "A banned member's boost cannot render.");
  // Fail-closed: not one card insert or stamp ran.
  assert.equal(db.calls.some((call) => call.sql && (call.sql.includes("INSERT INTO gc_messages") || call.sql.includes("UPDATE gc_fleet_boosts"))), false);
  // The R5 wall rode first (the ban screen answers AFTER the writer bucket).
  assert.equal(limiter.limited.length, 1);
  assert.equal(limiter.limited[0], await sha256Hex("message:user:" + USER_ID));
});

test("the R5 wall rides the ONE message writer bucket with the send path's actor shape", async () => {
  const { token, csrf, row } = await sessionRow();
  const limiter = mintLimiter();
  const db = fakeDb(
    consumeRoutes([{ id: 1, forum_post_id: 9, author_id: 3, thread_title: "t", thread_excerpt: "e", author_name: "goob" }], { session: { row } }),
  );
  await dispatchConsume(
    new Request(ORIGIN + "/api/servers/3/channels/12/consume-boosts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-CSRF-Token": csrf,
        Cookie: "__Host-goober_session=" + token,
      },
    }),
    { GOOBER_DB: db, GC_MESSAGE_RATE_LIMITER: limiter },
  );
  // The wall took the message bucket, the session member's actor, once.
  assert.equal(limiter.limited.length, 1);
  assert.equal(limiter.limited[0], await sha256Hex("message:user:" + USER_ID));
});

