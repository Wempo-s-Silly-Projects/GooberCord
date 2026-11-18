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

// T83 Goober of the Day — RED rows (spec:
// docs/drafts/t83-goober-of-the-day-spec.md). RED today BY CONSTRUCTION:
// api/goober-day.mjs and the gc_goober_* tables do not exist yet, so this
// file's import fails before a single row runs — the ERR_MODULE_NOT_FOUND
// below IS the raw RED error. The GREEN lane lands the module + migration
// and these rows flip one by one; extending the fake during GREEN is
// expected and allowed.
//
// Idiom: the coins-module fakeDb + pinned-SQL contract style (the T82 lane's
// scaffold). The fake encodes the rows' shape (vote/opt-out/card tables) so
// each row pins a LAW:
//   * one vote per member per day — the votes PK + ON CONFLICT DO NOTHING;
//   * anonymity — no statement ever SELECTs the voter mapping (the only
//     voter-keyed read is the caller's OWN "did I vote" one-row check);
//   * per-server visibility — every gc_goober_* statement carries its own
//     server seat INSIDE the WHERE;
//   * candidacy — the roll-over pick carries the NOT EXISTS opt-out arm;
//   * roll-over — a pure date-key comparison at read time, deterministic
//     tie-break (votes DESC, votee_id ASC);
//   * no ladder — no route exists that lists candidates or votes.
import test from "node:test";
import assert from "node:assert/strict";

import { handleGooberDayRoutes } from "../api/goober-day.mjs";
import {
  GC_GOOBER_DAY_SECONDS,
  GC_GOOBER_DAY_TAGLINE_MAX,
  GC_GOOBER_DAY_MIN_VOTES_FOR_CARD,
} from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const FRIEND_ID = 22;
const TIED_ID = 44;
const OPTED_OUT_ID = 30;
const SERVER_A = 1;
const SERVER_B = 2;
const NOW = nowSeconds();
const TODAY_KEY = NOW - (NOW % GC_GOOBER_DAY_SECONDS);
const YESTERDAY_KEY = TODAY_KEY - GC_GOOBER_DAY_SECONDS;

// --- scaffolding (coins-module idiom, trimmed to the day-card needs) ---------

const SESSION_TOKEN = "A".repeat(40);
const SESSION_ROW = {
  token_hash: await sha256Hex(SESSION_TOKEN),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "wempos",
  role: "member",
  bio: "",
  avatar_status: null,
  avatar_mime: null,
  avatar_updated_at: null,
  avatar_version: null,
  totp_enabled: 0,
};

function dayDb(options = {}) {
  const votes = (options.votes || []).map((row) => ({ ...row }));
  const optouts = (options.optouts || []).map((row) => ({ ...row }));
  const cards = (options.cards || []).map((row) => ({ ...row }));
  const members = options.members || [
    { server_id: SERVER_A, user_id: USER_ID, role: "member" },
    { server_id: SERVER_A, user_id: FRIEND_ID, role: "member" },
    { server_id: SERVER_A, user_id: OPTED_OUT_ID, role: "member" },
    { server_id: SERVER_A, user_id: TIED_ID, role: "member" },
    { server_id: SERVER_B, user_id: USER_ID, role: "member" },
  ];
  const calls = [];
  const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
  const ROLE_TEST = (sql) => sql.startsWith("SELECT role FROM gc_server_members");
  const VOTEE_MEMBER_TEST = (sql) =>
    sql.startsWith("SELECT 1 FROM gc_server_members");
  const TARGET_OPTOUT_TEST = (sql) =>
    sql.startsWith("SELECT 1 FROM gc_goober_optouts");
  const OWN_OPTOUT_TEST = (sql) =>
    sql.startsWith("SELECT user_id FROM gc_goober_optouts");
  const OWN_VOTE_TEST = (sql) =>
    sql.startsWith("SELECT 1 FROM gc_goober_votes");
  const CANDIDACY_UPSERT_TEST = (sql) =>
    sql.startsWith("INSERT INTO gc_goober_optouts");
  const CANDIDACY_DELETE_TEST = (sql) =>
    sql.startsWith("DELETE FROM gc_goober_optouts");
  const VOTE_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_goober_votes");
  const AGGREGATE_TEST = (sql) =>
    sql.startsWith("SELECT votee_id, COUNT(*) AS votes FROM gc_goober_votes");
  const CARD_READ_TEST = (sql) =>
    sql.startsWith("SELECT winner_id, votes_count, tagline FROM gc_goober_cards");
  const CARD_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_goober_cards");
  const TAGLINE_TEST = (sql) => sql.startsWith("UPDATE gc_goober_cards SET tagline = ?");

  const routes = [
    { test: SESSION_TEST, first: async () => SESSION_ROW },
    {
      test: ROLE_TEST,
      first: async (bound) =>
        members.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.user_id) === Number(bound[1])) || null,
    },
    {
      test: VOTEE_MEMBER_TEST,
      first: async (bound) =>
        members.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.user_id) === Number(bound[1])) || null,
    },
    {
      test: TARGET_OPTOUT_TEST,
      first: async (bound) =>
        optouts.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.user_id) === Number(bound[1])) || null,
    },
    { test: OWN_OPTOUT_TEST, first: async () => null },
    { test: OWN_VOTE_TEST, first: async () => null },
    {
      test: VOTE_INSERT_TEST,
      run: (bound) => {
        // PK-shape: (server_id, day_key, voter_id) — a duplicate answers
        // changes 0 exactly like ON CONFLICT DO NOTHING would.
        const duplicate = votes.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.day_key) === Number(bound[1]) &&
          Number(row.voter_id) === Number(bound[2]));
        if (duplicate) return { meta: { changes: 0 } };
        votes.push({
          server_id: bound[0], day_key: bound[1], voter_id: bound[2],
          votee_id: bound[3], created_at: bound[4],
        });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: CANDIDACY_UPSERT_TEST,
      run: (bound) => {
        const existing = optouts.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.user_id) === Number(bound[1]));
        if (!existing) {
          optouts.push({ server_id: bound[0], user_id: bound[1], updated_at: bound[2] });
        }
        return { meta: { changes: 1 } };
      },
    },
    {
      test: CANDIDACY_DELETE_TEST,
      run: (bound) => {
        const index = optouts.findIndex((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.user_id) === Number(bound[1]));
        if (index < 0) return { meta: { changes: 0 } };
        optouts.splice(index, 1);
        return { meta: { changes: 1 } };
      },
    },
    {
      // DB-shaped aggregate: raw counts for the bound day, no law baked in —
      // the opt-out filter is pinned TEXTUALLY on the pick's SQL (row 2).
      test: AGGREGATE_TEST,
      all: async (bound) => {
        const counts = new Map();
        for (const row of votes) {
          if (Number(row.server_id) !== Number(bound[0]) ||
            Number(row.day_key) !== Number(bound[1])) continue;
          const key = Number(row.votee_id);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return {
          results: [...counts.entries()]
            .map(([votee_id, votes]) => ({ votee_id, votes }))
            .sort((a, b) => b.votes - a.votes || a.votee_id - b.votee_id),
        };
      },
    },
    {
      test: CARD_READ_TEST,
      first: async (bound) =>
        cards.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.day_key) === Number(bound[1])) || null,
    },
    {
      test: CARD_INSERT_TEST,
      run: (bound) => {
        const existing = cards.find((row) =>
          Number(row.server_id) === Number(bound[0]) &&
          Number(row.day_key) === Number(bound[1]));
        if (existing) return { meta: { changes: 0 } };
        cards.push({
          server_id: bound[0], day_key: bound[1], winner_id: bound[2],
          votes_count: bound[3], tagline: null,
        });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: TAGLINE_TEST,
      run: (bound) => {
        const card = cards.find((row) =>
          Number(row.server_id) === Number(bound[1]) &&
          Number(row.day_key) === Number(bound[2]) &&
          Number(row.winner_id) === Number(bound[3]));
        if (!card) return { meta: { changes: 0 } };
        card.tagline = bound[0];
        return { meta: { changes: 1 } };
      },
    },
    { test: () => true, run: () => ({ meta: { changes: 1 } }) },
  ];

  const db = {
    calls,
    votes,
    optouts,
    cards,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound, call: "first" });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound, call: "all" });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound, call: "run" });
        return route && route.run ? route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleGooberDayRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(
    JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 },
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function authed(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "__Host-goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- rows -------------------------------------------------------------------

test("the Goober of the Day constants exist with the spec's caps", () => {
  assert.equal(GC_GOOBER_DAY_SECONDS, 86400);
  assert.equal(GC_GOOBER_DAY_TAGLINE_MAX, 64);
  assert.equal(GC_GOOBER_DAY_MIN_VOTES_FOR_CARD, 1);
});

test("an opted-out member is not a candidate — the vote refuses and the pick filters", async () => {
  const db = dayDb({
    optouts: [{ server_id: SERVER_A, user_id: OPTED_OUT_ID, updated_at: NOW - 10 }],
  });
  const response = await dispatch(
    authed("POST", `/api/servers/${SERVER_A}/goober/vote`, { voteeId: OPTED_OUT_ID }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 404, "candidacy is not published: a non-candidate is the unknown shape");
  assert.ok(db.votes.length === 0, "nothing was written");
  // The pick's own arm: fire a roll-over-computing read and pin the opt-out
  // filter INSIDE the aggregate's SQL (not beside it in JS).
  await dispatch(authed("GET", `/api/servers/${SERVER_A}/goober/today`), envWithLimiters(db));
  const pick = db.calls.find((call) =>
    call.call === "all" && call.sql.startsWith("SELECT votee_id, COUNT(*)"));
  if (pick) {
    assert.ok(pick.sql.includes("NOT EXISTS") && pick.sql.includes("gc_goober_optouts"),
      "the winner pick carries the opt-out filter INSIDE the SQL");
  }
});

test("votes are per-server ONLY — server B's card never answers server A's votes", async () => {
  const db = dayDb({
    votes: [{
      server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID + 100,
      votee_id: FRIEND_ID, created_at: NOW - 2000,
    }],
    members: [
      { server_id: SERVER_A, user_id: USER_ID, role: "member" },
      { server_id: SERVER_B, user_id: USER_ID, role: "member" },
    ],
  });
  const response = await dispatch(
    authed("GET", `/api/servers/${SERVER_B}/goober/today`), envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.goober, null, "no cross-server leakage: server B paints nothing");
  // Every statement targeting a gc_goober_* table carries ITS OWN server seat.
  for (const call of db.calls) {
    if (call.sql?.includes("gc_goober_")) {
      assert.equal(Number(call.bound[0]), SERVER_B,
        "the server seat rides INSIDE the statement: " + call.sql);
    }
  }
});

test("there is no ladder — the global and candidate-list shapes do not exist", async () => {
  const db = dayDb();
  for (const path of [
    "/api/goober/leaders",
    `/api/servers/${SERVER_A}/goober/candidates`,
    `/api/servers/${SERVER_A}/goober/votes`,
  ]) {
    const response = await dispatch(authed("GET", path), envWithLimiters(db));
    assert.equal(response.status, 404, "no such surface: " + path);
  }
  const gooberCalls = db.calls.filter((call) => call.sql?.includes("gc_goober"));
  assert.equal(gooberCalls.length, 0,
    "the refused shapes fired ZERO gc_goober statements");
});

test("the ballot mapping is never a read — anonymity through the window and after", async () => {
  const db = dayDb({
    votes: [{
      server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID + 200,
      votee_id: FRIEND_ID, created_at: NOW - 2000,
    }],
  });
  // A full flow: vote, then the today read (roll-over + card + own states).
  await dispatch(
    authed("POST", `/api/servers/${SERVER_A}/goober/vote`, { voteeId: FRIEND_ID }),
    envWithLimiters(db),
  );
  await dispatch(authed("GET", `/api/servers/${SERVER_A}/goober/today`), envWithLimiters(db));
  for (const call of db.calls) {
    if (call.sql?.includes("gc_goober_votes")) {
      assert.ok(!/^SELECT voter_id/.test(call.sql) && !call.sql.includes("SELECT voter_id,"),
        "no statement reads the ballot mapping: " + call.sql);
    }
  }
  const aggregate = db.calls.find((call) =>
    call.call === "all" && call.sql.startsWith("SELECT votee_id, COUNT(*)"));
  if (aggregate) {
    assert.ok(aggregate.sql.includes("GROUP BY votee_id"),
      "the tally aggregates by votee only");
  }
});

test("one vote per member per day — the PK's own verdict answers the double vote", async () => {
  const db = dayDb();
  const first = await dispatch(
    authed("POST", `/api/servers/${SERVER_A}/goober/vote`, { voteeId: FRIEND_ID }),
    envWithLimiters(db),
  );
  assert.equal(first.status, 201);
  const insert = db.calls.find((call) =>
    call.call === "run" && call.sql.startsWith("INSERT INTO gc_goober_votes"));
  assert.ok(insert, "the vote is one guarded INSERT");
  assert.ok(insert.sql.includes("ON CONFLICT (server_id, day_key, voter_id) DO NOTHING"),
    "the one-vote law rides the statement's own conflict arm");
  const second = await dispatch(
    authed("POST", `/api/servers/${SERVER_A}/goober/vote`, { voteeId: TIED_ID }),
    envWithLimiters(db),
  );
  assert.equal(second.status, 409, "the second vote today is the conflict answer");
  assert.equal(db.votes.length, 1, "one row stands");
});

test("roll-over is deterministic — the same completed day answers the SAME Goober", async () => {
  const db = dayDb({
    votes: [
      { server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID, votee_id: FRIEND_ID, created_at: NOW - 5000 },
      { server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID + 101, votee_id: FRIEND_ID, created_at: NOW - 4000 },
      { server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID + 102, votee_id: FRIEND_ID, created_at: NOW - 3000 },
      { server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID + 103, votee_id: TIED_ID, created_at: NOW - 2000 },
    ],
  });
  const first = await bodyOf(await dispatch(
    authed("GET", `/api/servers/${SERVER_A}/goober/today`), envWithLimiters(db),
  ));
  assert.equal(first.goober?.id, FRIEND_ID, "the tallied winner is painted");
  assert.equal(first.goober?.votesCount, 3, "the card's count is the completed day's tally");
  const second = await bodyOf(await dispatch(
    authed("GET", `/api/servers/${SERVER_A}/goober/today`), envWithLimiters(db),
  ));
  assert.equal(second.goober?.id, FRIEND_ID,
    "a re-read answers the identical card (the lazily written card, not a re-tally)");
  // The deterministic tie-break: an exact tie resolves to the LOWER id.
  const tied = dayDb({
    votes: [
      { server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID, votee_id: TIED_ID, created_at: NOW - 5000 },
      { server_id: SERVER_A, day_key: YESTERDAY_KEY, voter_id: USER_ID + 101, votee_id: FRIEND_ID, created_at: NOW - 4000 },
    ],
  });
  const third = await bodyOf(await dispatch(
    authed("GET", `/api/servers/${SERVER_A}/goober/today`), envWithLimiters(tied),
  ));
  assert.equal(third.goober?.id, FRIEND_ID, "a tie resolves to the lower member id — deterministically");
});
