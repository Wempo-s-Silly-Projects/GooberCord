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

// T92 Server Welcome Card — the RED rows (spec: docs/drafts/t92-welcome-card-spec.md).
// DELIVERED FAILING: no api/welcome-card.mjs, no worker.mjs registration, no
// migrations/0042_gc_welcome_cards.sql, no GC_WELCOME_CARD_BLURB_MAX, no GREEN.
// Idiom: the paperDb fake (tests/morning-paper-red.test.mjs) under the lead's
// two fake laws — the session fake compares sha256Hex(token) at bound[0]
// (core/auth.mjs:104-105, the bookmarks-test law), and the prefix-anchored
// statement routes ride ABOVE the broad includes() routes (routes.find()
// first-match shadowing). Every guard arm is ENCODED in the fake: the mod
// gate inside the card upsert (0037's PAPER_ENABLE_SQL shape, bind contract
// [server_id, blurb, server_id, actor_id]), and the member's-membership check
// inside the views INSERT (bind contract [server_id, user_id, shown_at]) —
// a GREEN implementation that loses an arm fails here. The view row's only
// writer is the member's OWN GET (spec §3): the fake rejects any insert whose
// actor membership check fails. Sink law N/A (spec §6): no gc_coin_ledger
// route exists in the fake, so a card that ever mints fails by silence never
// being banked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../worker.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const SERVER_ID = 1;
const MOD_ID = 7;       // owner — the write gate admits owner/moderator
const MEMBER_ID = 22;   // plain member of the same server
const OUTSIDER_ID = 44; // not a member of the server at all
const CARD_PATH = "/api/servers/" + SERVER_ID + "/welcome-card";
const BLURB = "Welcome to the fire, goober. Read the rules, say hi, stoke the campfire.";
const BLURB_2 = "New season, new fire. The rules are on the door.";

// The shared unknown-server 404 body — the same family answer the membership
// gates throw (api/paper.mjs:116): non-member, unknown id, and unconfigured
// card are indistinguishable to the asker.
const SHARED_UNKNOWN = "This server does not exist or you cannot view it.";

const MOD_TOKEN = "W".repeat(40);
const MEMBER_TOKEN = "E".repeat(40);
const OUTSIDER_TOKEN = "D".repeat(40);

// auth.mjs binds sha256Hex(token) as token_hash (core/auth.mjs:104-105), so
// the session fake must compare the HASH — a raw-token comparison starves
// every session and 401s the whole lane (lead-ruled fake law, 2026-11-18).
const MOD_HASH = await sha256Hex(MOD_TOKEN);
const MEMBER_HASH = await sha256Hex(MEMBER_TOKEN);
const OUTSIDER_HASH = await sha256Hex(OUTSIDER_TOKEN);

function sessionRow(userId, tokenSeed) {
  return {
    token_hash: tokenSeed.repeat(32).slice(0, 64),
    user_id: userId,
    csrf_token: "C".repeat(24),
    expires_at: nowSeconds() + 3600,
    username: "member" + userId,
  };
}
const MOD_SESSION = sessionRow(MOD_ID, "W");
const MEMBER_SESSION = sessionRow(MEMBER_ID, "E");
const OUTSIDER_SESSION = sessionRow(OUTSIDER_ID, "D");

// The welcomeCardDb fake: three state maps ARE the whole seat — the membership
// set ("user_id:server_id" -> role), the card configs (server_id -> blurb), and
// the shown-once ledger ("user_id:server_id" -> view row). Absence of a card
// row IS the off state (defaults law, spec §2): nothing exists and nothing
// fires until a mod configures and the member themselves fetches.
function welcomeCardDb(options = {}) {
  const membership = new Map(options.membership || []); // "user_id:server_id" -> role
  const cards = new Map(options.cards || []);           // server_id -> blurb_text
  const views = new Map(options.views || []);           // "user_id:server_id" -> view row
  const calls = [];

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async (bound) => {
        const hash = String(bound[0] || "");
        if (hash === MOD_HASH) return MOD_SESSION;
        if (hash === MEMBER_HASH) return MEMBER_SESSION;
        if (hash === OUTSIDER_HASH) return OUTSIDER_SESSION;
        return null;
      },
    },
    {
      // The shown-once ledger write (spec §3's only per-member insert). The
      // membership check lives INSIDE the route: a non-member's insert makes
      // changes-0 — a view row can never pre-exist or outlive its member's
      // own GET. Bind contract: [server_id, user_id, shown_at]. RIDES FIRST —
      // the broad gc_server_members includes() route below also matches any
      // statement naming the ledger's neighborhood, and routes.find()
      // first-match would shadow this route dead (the fake-defect class the
      // lead ruled on 2026-11-18).
      test: (sql) => sql.startsWith("INSERT INTO gc_welcome_card_views"),
      run: (bound) => {
        const serverId = Number(bound[0]);
        const userId = Number(bound[1]);
        const shownAt = Number(bound[2]);
        if (!membership.has(userId + ":" + serverId)) return { meta: { changes: 0 } };
        views.set(userId + ":" + serverId, { server_id: serverId, user_id: userId, shown_at: shownAt });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The mod-gated upsert (spec §4, 0037's PAPER_ENABLE_SQL shape): the
      // role gate lives INSIDE the statement — a non-mod's write makes zero
      // changes, classified to the shared unknown-server 404, never a 403
      // existence oracle. Bind contract pins PAPER_ENABLE's order:
      // [server_id, blurb, server_id, actor_id]. RIDES ABOVE the broad
      // gc_server_members includes() route — the upsert's WHERE EXISTS
      // carries that substring and would be answered from the membership
      // read's shape, making changes-0 unreachable.
      test: (sql) => sql.startsWith("INSERT INTO gc_welcome_cards"),
      run: (bound) => {
        const serverId = Number(bound[0]);
        const blurb = String(bound[1]);
        const actorId = Number(bound[3]);
        const role = membership.get(actorId + ":" + serverId);
        if (role !== "owner" && role !== "moderator") return { meta: { changes: 0 } };
        cards.set(serverId, blurb);
        return { meta: { changes: 1 } };
      },
    },
    {
      // The ledger read: bound contract [server_id, user_id] (the fetch's
      // own WHERE). A row answers only after the member's own GET.
      test: (sql) => sql.includes("FROM gc_welcome_card_views"),
      first: async (bound) =>
        views.get(Number(bound[1]) + ":" + Number(bound[0])) || null,
    },
    {
      // The card read (spec §2's "404's own WHERE"): no row = the surface
      // does not exist for this server.
      test: (sql) => sql.includes("FROM gc_welcome_cards"),
      first: async (bound) =>
        cards.has(Number(bound[0]))
          ? { blurb_text: cards.get(Number(bound[0])) }
          : null,
    },
    {
      // The membership pre-read (api/servers.mjs idiom): bound
      // [server_id, user_id] — the member's own gate before any seat read.
      test: (sql) => sql.includes("gc_server_members"),
      first: async (bound) => {
        const role = membership.get(Number(bound[1]) + ":" + Number(bound[0]));
        return role ? { role } : null;
      },
    },
  ];

  const db = {
    calls,
    membership,
    cards,
    views,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql)) || null;
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
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
  };
  return db;
}

const SEED = {
  membership: [
    [MOD_ID + ":" + SERVER_ID, "owner"],
    [MEMBER_ID + ":" + SERVER_ID, "member"],
  ],
};

function envOf(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function authed(method, path, session, body) {
  // session === null rides NO cookie: the un-authed visitor arm.
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(session
        ? {
            Cookie: "__Host-goober_session=" + session.__token,
            "X-CSRF-Token": session.csrf_token,
          }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
MOD_SESSION.__token = MOD_TOKEN;
MEMBER_SESSION.__token = MEMBER_TOKEN;
OUTSIDER_SESSION.__token = OUTSIDER_TOKEN;

// --- rows -------------------------------------------------------------------

test("the welcome card seat ships as ONE CREATE-only migration 0042 carrying BOTH tables, no FK (DDL-level pin)", () => {
  const text = readFileSync(new URL("../migrations/0042_gc_welcome_cards.sql", import.meta.url), "utf8");
  const creates = text.match(/CREATE TABLE/g) || [];
  assert.equal(creates.length, 2, "the config seat AND the shown-once ledger ride the one migration — no third seat");
  const cardBody = text.slice(
    text.indexOf("CREATE TABLE gc_welcome_cards"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_welcome_cards")),
  );
  for (const column of ["server_id", "blurb_text", "enabled"]) {
    assert.match(cardBody, new RegExp("\\b" + column + "\\b"), column + " rides the config seat");
  }
  assert.match(cardBody, /PRIMARY KEY \(server_id\)/, "one config row per server, ever (spec §3)");
  assert.match(cardBody, /\bDEFAULT 0\b/, "enabled answers 0 by default — OFF is the stored default, not an absence");
  const viewBody = text.slice(
    text.indexOf("CREATE TABLE gc_welcome_card_views"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_welcome_card_views")),
  );
  for (const column of ["server_id", "user_id", "shown_at"]) {
    assert.match(viewBody, new RegExp("\\b" + column + "\\b"), column + " rides the ledger");
  }
  assert.match(viewBody, /PRIMARY KEY \(server_id, user_id\)/,
    "the shown-once ledger keys on the (server_id, user_id) composite — one row per member per server");
  assert.doesNotMatch(text, /\bREFERENCES\b/, "NO FK anywhere (spec §3): orphans drop at read, no CASCADE arm");
  assert.doesNotMatch(text, /\b(ALTER|DROP|UPDATE|DELETE FROM|INSERT INTO)\b/,
    "CREATE-only — no ALTER, no seed, nothing else rides the migration");
});

test("GC_WELCOME_CARD_BLURB_MAX exists in constants.mjs riding 300 — a HOUSE cap, not a parity claim (spec §5)", () => {
  const text = readFileSync(new URL("../constants.mjs", import.meta.url), "utf8");
  assert.match(text, /export const GC_WELCOME_CARD_BLURB_MAX = 300\b/,
    "the blurb cap is a named constants.mjs import, never a magic number in route code");
});

test("a mod's PUT writes the card: the statement gate passes, the row upserts in place — one row per server, ever", async () => {
  const db = welcomeCardDb(SEED);
  assert.equal(db.cards.size, 0, "defaults law: nothing exists until a mod acts");
  const first = await worker.fetch(authed("PUT", CARD_PATH, MOD_SESSION, { blurb: BLURB }), envOf(db), {});
  assert.equal(first.status, 200, "the mod write exists and answers its state");
  assert.deepEqual([...db.cards.entries()], [[SERVER_ID, BLURB]],
    "one config row, the blurb stored verbatim (locale law, spec §5 — never translated or rewritten)");
  const second = await worker.fetch(authed("PUT", CARD_PATH, MOD_SESSION, { blurb: BLURB_2 }), envOf(db), {});
  assert.equal(second.status, 200, "the re-write answers its state");
  assert.equal(db.cards.size, 1, "the upsert refreshes in place — one row per server, ever");
  assert.equal(db.cards.get(SERVER_ID), BLURB_2, "the newest blurb IS the card");
});

test("a plain member's PUT answers changes-0 classified to the shared unknown-server 404 — the gate lives INSIDE the statement", async () => {
  const db = welcomeCardDb(SEED);
  const response = await worker.fetch(authed("PUT", CARD_PATH, MEMBER_SESSION, { blurb: BLURB }), envOf(db), {});
  assert.equal(response.status, 404, "never a 403 — non-mod and unknown share ONE class (spec §4)");
  assert.equal((await response.json()).error, SHARED_UNKNOWN,
    "the shared unknown-server shape: non-mod and unknown are indistinguishable");
  const gateInserts = db.calls.filter((call) => call.sql.startsWith("INSERT INTO gc_welcome_cards"));
  assert.equal(gateInserts.length, 1,
    "the upsert FIRED once and gated itself — a pre-read 403 oracle never reaches the statement (spec §4)");
  assert.equal(db.cards.size, 0, "the non-mod's intent never conjures a row");
});

test("a blurb over GC_WELCOME_CARD_BLURB_MAX answers 400 before any seat statement fires", async () => {
  const db = welcomeCardDb(SEED);
  const over = "x".repeat(300 + 1); // GC_WELCOME_CARD_BLURB_MAX + 1 (house cap, spec §5)
  const response = await worker.fetch(authed("PUT", CARD_PATH, MOD_SESSION, { blurb: over }), envOf(db), {});
  assert.equal(response.status, 400, "over-cap blurb answers the validation family");
  const payload = await response.json();
  assert.ok(payload.error, "the validation answers a shaped error body");
  const seatStatements = db.calls.filter((call) => call.sql.includes("gc_welcome_card"));
  assert.equal(seatStatements.length, 0, "validation rides ahead of the statement (spec §4)");
});

test("defaults law: with NO card row a member's GET answers the shared unknown-server 404 and writes nothing", async () => {
  const db = welcomeCardDb(SEED);
  const response = await worker.fetch(authed("GET", CARD_PATH, MEMBER_SESSION), envOf(db), {});
  assert.equal(response.status, 404, "the unconfigured server answers the unknown-server family");
  assert.equal((await response.json()).error, SHARED_UNKNOWN,
    "no distinct 'no card' body — non-member and unconfigured are indistinguishable, no config-existence oracle (spec §2)");
  assert.equal(db.views.size, 0, "no view row is conjured by an unread card");
  const writes = db.calls.filter((call) => call.call === "run" && call.sql.includes("gc_welcome_card"));
  assert.equal(writes.length, 0, "the off-state earns reads only — no write fires without a card");
});

test("the once-shown contract: first fetch answers the blurb and records the member's OWN view; the next stays silent until ?repeat=1", async () => {
  const db = welcomeCardDb({ ...SEED, cards: [[SERVER_ID, BLURB]] });
  const first = await worker.fetch(authed("GET", CARD_PATH, MEMBER_SESSION), envOf(db), {});
  assert.equal(first.status, 200, "the member's fetch exists and answers its state");
  assert.deepEqual(await first.json(), { blurb: BLURB, shown: true }, "the first fetch answers the blurb verbatim, shown");
  const viewRows = [...db.views.values()];
  assert.equal(viewRows.length, 1, "exactly one view row, recorded by the fetch itself");
  assert.deepEqual(viewRows[0], { server_id: SERVER_ID, user_id: MEMBER_ID, shown_at: viewRows[0].shown_at },
    "the row carries (server_id, user_id, shown_at) and NOTHING else (spec §3)");
  assert.equal(typeof viewRows[0].shown_at, "number", "shown_at is the server's epoch seconds");

  const second = await worker.fetch(authed("GET", CARD_PATH, MEMBER_SESSION), envOf(db), {});
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { shown: true, blurb: null },
    "the second fetch keeps the blurb silent — the once-shown arm (spec §4)");

  const repeat = await worker.fetch(authed("GET", CARD_PATH + "?repeat=1", MEMBER_SESSION), envOf(db), {});
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { blurb: BLURB, shown: true },
    "?repeat=1 is the member's explicit re-show — the re-show arm (spec §4)");
  assert.equal(db.views.size, 1, "the re-show never duplicates the ledger row");
});

test("a non-member's GET rides the shared 404 and the views ledger stays empty — no row without the member's own membership", async () => {
  const db = welcomeCardDb({ ...SEED, cards: [[SERVER_ID, BLURB]] });
  const response = await worker.fetch(authed("GET", CARD_PATH, OUTSIDER_SESSION), envOf(db), {});
  assert.equal(response.status, 404, "the membership gate classifies non-member to the shared 404");
  assert.equal((await response.json()).error, SHARED_UNKNOWN, "non-member and unconfigured share ONE body (spec §2)");
  const viewInserts = db.calls.filter((call) => call.sql.startsWith("INSERT INTO gc_welcome_card_views"));
  assert.equal(viewInserts.length, 0, "the ledger's only writer is the member's own GET (spec §3)");
  assert.equal(db.views.size, 0, "the outsider's asking writes no row");
  const member = await worker.fetch(authed("GET", CARD_PATH, MEMBER_SESSION), envOf(db), {});
  assert.equal(member.status, 200, "the member beside them still gets the card");
});

test("un-authed: both welcome-card routes answer 401 before any seat statement fires", async () => {
  const db = welcomeCardDb({ ...SEED, cards: [[SERVER_ID, BLURB]] });
  for (const [method, path] of [["GET", CARD_PATH], ["PUT", CARD_PATH]]) {
    const response = await worker.fetch(authed(method, path, null), envOf(db), {});
    assert.equal(response.status, 401, method + " " + path + " answers the un-signed 401");
  }
  const seatStatements = db.calls.filter((call) => call.sql.includes("gc_welcome_card"));
  assert.equal(seatStatements.length, 0, "the 401 rides ahead of the seat — no gc_welcome_card statement");
});

test("sink law N/A: no gc_coin_ledger route exists in the fake, so a card that mints fails by never being banked", async () => {
  const db = welcomeCardDb({ ...SEED, cards: [[SERVER_ID, BLURB]] });
  await worker.fetch(authed("PUT", CARD_PATH, MOD_SESSION, { blurb: BLURB }), envOf(db), {});
  await worker.fetch(authed("GET", CARD_PATH, MEMBER_SESSION), envOf(db), {});
  await worker.fetch(authed("GET", CARD_PATH + "?repeat=1", MEMBER_SESSION), envOf(db), {});
  const coinStatements = db.calls.filter((call) => call.sql.includes("gc_coin_ledger"));
  assert.equal(coinStatements.length, 0, "the card mints and sinks nothing (spec §6)");
});
