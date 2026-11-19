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

// The seam-bind gate (the guard-bind gate's second half, the W26-3 deslop
// finding): the fakeDb seam suites read routes by string matching and don't
// count binds, so every statement the 11-family seam program moved rides
// this gate too. Each moved SQL const is composed the way its callers
// compose it (the dynamic IN tails with a 3-item list) and must prepare AND
// bind on true node:sqlite with a binds array whose length the engine
// checks against the placeholders — extra or missing binds throw, exactly
// like D1. The PLUS term upsert's probe additionally pins the historical
// class: the 6-for-7 SELECT list (GO-HAYWIRE cycle-2 fix 1) was invisible
// to the fakeDb until this class of gate existed.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  COSMETIC_LEDGER_SPEND_SQL,
  COSMETIC_OWNERSHIP_INSERT_SQL,
  COSMETIC_LEGACY_SPEND_HEAD_SQL,
  INVENTORY_SPEND_SQL,
  INVENTORY_OWN_SQL,
  INVENTORY_BUMP_SQL,
  INVENTORY_OWNED_PROBE_SQL,
  INVENTORY_MEMBERSHIP_SQL,
  INVENTORY_EQUIP_CLEAR_SQL,
  INVENTORY_EQUIP_SET_SQL,
  INVENTORY_UNEQUIP_SQL,
  INVENTORY_CONSUME_SQL,
} from "../api/coins-cosmetics.mjs";
import {
  PLUS_SPEND_SQL,
  PLUS_TERM_UPSERT_SQL,
  GIFT_TARGET_READ_SQL,
} from "../api/coins-plus.mjs";
import { PIN_MANAGER_READ_SQL } from "../api/messages-pins.mjs";

// The schema floor: every table the moved statements name, with the
// columns the placeholders' arms reach. Types are loose on purpose — the
// gate probes placeholder/bind arithmetic, not column affinity.
const SCHEMA = `
  CREATE TABLE gc_coin_ledger (user_id INTEGER, delta INTEGER, source TEXT, related_user_id INTEGER, created_at INTEGER, spend_nonce TEXT);
  CREATE TABLE gc_cosmetic_ownership (user_id INTEGER, item TEXT, purchased_at INTEGER);
  -- The UNIQUE pairs the upserts' ON CONFLICT arms require (0056/0058/plus
  -- law: the schema floor is the constraint set, not just the tables).
  CREATE TABLE gc_cosmetic_inventory (user_id INTEGER, item_key TEXT, kind TEXT, qty INTEGER, equipped INTEGER, server_id INTEGER, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id, item_key));
  CREATE TABLE gc_plus_state (user_id INTEGER, renews_until INTEGER, grace_until INTEGER, tenure_started_at INTEGER, gifted_by INTEGER, updated_at INTEGER, tier TEXT, UNIQUE(user_id));
  CREATE TABLE gc_server_members (server_id INTEGER, user_id INTEGER, role TEXT);
  CREATE TABLE gc_member_roles (server_id INTEGER, user_id INTEGER, role_id INTEGER);
  CREATE TABLE gc_roles (id INTEGER, server_id INTEGER, position INTEGER, permissions INTEGER);
  CREATE TABLE users (id INTEGER, username TEXT, username_key TEXT);
`;

function gate(db, sql, binds) {
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.equal(
    placeholders, binds.length,
    "placeholder/bind counts disagree (" + placeholders + " ? vs " + binds.length + " binds)",
  );
  // node:sqlite binds through the executor's arguments (the same style the
  // D1 prepare().bind().first()/run() calls ride); a wrong count throws
  // here exactly like it throws on real D1.
  assert.doesNotThrow(
    () => (sql.startsWith("SELECT") ? db.prepare(sql).get(...binds) : db.prepare(sql).run(...binds)),
    "the statement must bind its own params on real SQLite",
  );
}

function probe() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

// The in-list composition both callers ride: return the joined statement so
// the gate sees the WHOLE composed text, tail placeholders included.
function composeIn(head, items, closer) {
  return head + items.map(() => "?").join(", ") + closer;
}

test("the cosmetics seam statements prepare and bind on real SQLite", () => {
  const db = probe();
  try {
    const now = 1, userId = 2, source = "test", nonce = "n";
    // COSMETIC_LEDGER_SPEND_SQL: user/delta/source/created_at/nonce, the SUM arm's pair, the price.
    gate(db, COSMETIC_LEDGER_SPEND_SQL, [userId, -100, source, now, nonce, userId, 100]);
    // COSMETIC_OWNERSHIP_INSERT_SQL: the ownership triple + the fingerprint's five + the NOT-EXISTS pair.
    gate(db, COSMETIC_OWNERSHIP_INSERT_SQL, [userId, "frame", now, userId, source, -100, now, nonce, userId, "frame"]);
    // COSMETIC_LEGACY_SPEND_HEAD_SQL composes with the IN tail, exactly as the
    // route-side does: 5 + SUM pair + the head's own NOT-EXISTS pair + the list.
    gate(db, composeIn(COSMETIC_LEGACY_SPEND_HEAD_SQL, ["flair", "frame", "banner"], ")) LIMIT 1"),
      [userId, -100, source, now, nonce, userId, 100, userId, "flair", "frame", "banner"]);
    // INVENTORY_SPEND_SQL: the spend quintet + SUM pair + NOT-EXISTS pair + the
    // membership arm's triple (the server's IS NULL pair rides as two binds).
    gate(db, INVENTORY_SPEND_SQL, [userId, -100, source, now, nonce, userId, 100, userId, "burst", 1, 1, userId]);
    // INVENTORY_OWN_SQL: the row's octet + the fingerprint's five + the NOT-EXISTS pair.
    gate(db, INVENTORY_OWN_SQL, [userId, "frame", null, now, now, userId, source, -100, now, nonce, userId, "frame"]);
    // INVENTORY_BUMP_SQL: the row's octet + the fingerprint's five + the bump pair.
    gate(db, INVENTORY_BUMP_SQL, [userId, "burst", 1, now, now, userId, source, -100, now, nonce, 1, now]);
    gate(db, INVENTORY_OWNED_PROBE_SQL, [userId, "burst"]);
    gate(db, INVENTORY_MEMBERSHIP_SQL, [1, userId]);
    // INVENTORY_EQUIP_CLEAR_SQL composes with the slot SKUs, exactly as the route-side does.
    gate(db, composeIn(INVENTORY_EQUIP_CLEAR_SQL, ["flair", "frame", "banner"], ")"),
      [now, userId, "flair", "frame", "banner"]);
    gate(db, INVENTORY_EQUIP_SET_SQL, [now, userId, "frame"]);
    gate(db, INVENTORY_UNEQUIP_SQL, [now, userId, "frame"]);
    gate(db, INVENTORY_CONSUME_SQL, [now, userId, "burst"]);
  } finally { db.close(); }
});

test("the plus seam statements prepare and bind on real SQLite", () => {
  const db = probe();
  try {
    const now = 1, userId = 2, nonce = "n";
    // PLUS_SPEND_SQL: the spend sextet + the target probe + the SUM pair (9).
    gate(db, PLUS_SPEND_SQL, [userId, -1200, "plus_buy", userId, now, nonce, userId, userId, 1200]);
    // PLUS_TERM_UPSERT_SQL (the historical 6-for-7 class): the SELECT list's
    // seven + the fingerprint's six + the conflict arm's five = 19 binds.
    assert.equal((PLUS_TERM_UPSERT_SQL.match(/\?/g) || []).length, 19,
      "the term upsert's SELECT list carries all seven columns' '?' (the 6-for-7 regression class)");
    gate(db, PLUS_TERM_UPSERT_SQL,
      [userId, now, now, 30, now, null, now, "full",
        userId, "plus_buy", -1200, now, null, nonce,
        now, 30, null, "full", now]);
    // The regression-shaped bite: node:sqlite swallows an UNDER-bind
    // (missing params run as NULL — the exact silent-wrong-behavior shape
    // the 6-for-7 shipped), so the count assert above is the under-bind
    // defense; the engine's enforced bite is OVER-bind, and that is pinned:
    assert.throws(
      () => db.prepare(PLUS_TERM_UPSERT_SQL).run(
        userId, now, now, 30, now, null, now, "full",
        userId, "plus_buy", -1200, now, null, nonce,
        now, 30, null, "full", now, 9999),
      "a padded binds array must throw on real SQLite (over-bind)",
    );
    gate(db, GIFT_TARGET_READ_SQL, ["wempo"]);
  } finally { db.close(); }
});

test("the pins seam grant read prepares and binds on real SQLite", () => {
  const db = probe();
  try {
    // PIN_MANAGER_READ_SQL composes at module scope with the role-mask
    // machinery, so its binds ride FOUR placeholders: the (server, user)
    // tier probe's pair + the mask arm's pair (both the same two ids at the
    // call site — PIN_MANAGER_READ_SQL.bind(serverId, userId, serverId, userId)).
    gate(db, PIN_MANAGER_READ_SQL, [1, 2, 1, 2]);
  } finally { db.close(); }
});

// --- the polls seam's bind gate (T-R26-POLLS, additive hunk) ------------------
// The wave-26 polls' OWN hunk, per the hunk-split law: new imports, a local
// schema floor, and local compose/gate helpers with poll-prefixed names —
// the file's existing SCHEMA/gate/composeIn stay byte-untouched (the lead's
// hunks). Same referee law as above: node:sqlite checks the placeholder/
// bind count exactly like D1, every statement composed the way its callers
// compose it (the dynamic IN tails included).

import {
  POLL_VOTE_UPSERT_SQL,
  POLL_CLOSE_SQL,
  POLL_TALLY_SQL,
  POLL_VIEWER_ROWS_SQL,
  POLL_CHUNK_READ_SQL,
} from "../api/messages-polls.mjs";
import { POLL_INSERT_TUPLE_SQL } from "../api/messages.mjs";

// The polls' schema floor: the three tables the poll statements name. The
// UNIQUEs are the floor (the upsert's ON CONFLICT arm needs the pair), the
// gc_messages seat carries the close statement's author probe.
const POLL_GATE_SCHEMA = `
  CREATE TABLE gc_polls (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER UNIQUE, channel_id INTEGER, question TEXT, options_json TEXT, multiple INTEGER, closed_at INTEGER, closed_by INTEGER, created_at INTEGER);
  CREATE TABLE gc_poll_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER, user_id INTEGER, choices_json TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(poll_id, user_id));
  CREATE TABLE gc_messages (id INTEGER PRIMARY KEY, channel_id INTEGER, author_id INTEGER, client_message_id TEXT, created_at INTEGER);
`;

function pollGateProbe() {
  const db = new DatabaseSync(":memory:");
  db.exec(POLL_GATE_SCHEMA);
  db.prepare("INSERT INTO gc_messages (id, channel_id, author_id) VALUES (700, 10, 42)").run();
  db.prepare(
    "INSERT INTO gc_polls (id, message_id, channel_id, question, options_json, multiple, created_at) " +
      "VALUES (5, 700, 10, 'Lunch?', '[\"Pizza\",\"Sushi\"]', 0, 1)",
  ).run();
  return db;
}

function pollComposeIn(head, items, closer) {
  return head + items.map(() => "?").join(",") + closer;
}

test("the polls seam statements prepare and bind on real SQLite", () => {
  const db = pollGateProbe();
  try {
    const now = 7;
    // POLL_INSERT_TUPLE_SQL composes both caller arms (the NULL-cid replay
    // arm and the cid arm): the poll's question/options/multiple triple +
    // the (channel, author) pair; the cid arm adds the cid bind.
    gate(db, POLL_INSERT_TUPLE_SQL +
      "m.client_message_id IS NULL ORDER BY m.id DESC LIMIT 1 ON CONFLICT(message_id) DO NOTHING",
      ["Lunch?", '["Pizza","Sushi"]', 0, 10, 42]);
    gate(db, POLL_INSERT_TUPLE_SQL +
      "m.client_message_id = ? ORDER BY m.id DESC LIMIT 1 ON CONFLICT(message_id) DO NOTHING",
      ["Lunch?", '["Pizza","Sushi"]', 0, 10, 42, "cid-1"]);
    // POLL_VOTE_UPSERT_SQL: the claim quintet, replaced by the conflict arm.
    gate(db, POLL_VOTE_UPSERT_SQL, [5, 42, "[0]", now, now]);
    // POLL_CLOSE_SQL: the (closed_at, closed_by) pair + the poll id + the
    // author probe's bind.
    gate(db, POLL_CLOSE_SQL, [now, 42, 5, 42]);
    // The chunk reads compose their IN tails at the call sites, exactly as
    // appendPollPayloads composes them: the tally's GROUP BY closer, the
    // viewer's user bind first, the rows' bare tail.
    gate(db, pollComposeIn(POLL_TALLY_SQL, [5, 6],
      ") GROUP BY je.value ORDER BY je.value"), [5, 6]);
    gate(db, pollComposeIn(POLL_VIEWER_ROWS_SQL, [5, 6], ")"), [42, 5, 6]);
    gate(db, pollComposeIn(POLL_CHUNK_READ_SQL, [700], ")"), [700]);
  } finally { db.close(); }
});
