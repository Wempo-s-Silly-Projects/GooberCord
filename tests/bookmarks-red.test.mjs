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

// T88 Bookmarks — the RED rows (spec: docs/drafts/t88-bookmarks-spec.md).
// DELIVERED FAILING: no api/bookmarks.mjs, no worker.mjs registration, no
// GREEN. Idiom: the paperDb fake (tests/morning-paper-red.test.mjs) — every
// guard arm is ENCODED in the fake (the membership/existence/idempotence
// gate inside the save statement, the owner_user_id arm inside the DELETE),
// so a GREEN implementation that loses an arm fails here. The pointer row is
// an ADDRESS ONLY (owner_user_id + message_id + saved_at — spec §2): the
// fake stores nothing else, so a GREEN save that carries a text copy or a
// read-state flag fails by having nowhere to put it. Sink law N/A (spec §6):
// no gc_coin_ledger route exists in the fake, so a bookmark that ever mints
// fails by silence never being banked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../worker.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const OWNER_ID = 22;
const STRANGER_ID = 31; // a member of the same server, but not the owner
const OUTSIDER_ID = 44; // not a member of the message's server at all
const SERVER_ID = 1;
const MESSAGE_ID = 500;
const NOW = nowSeconds();

const OWNER_TOKEN = "O".repeat(40);
const STRANGER_TOKEN = "S".repeat(40);
const OUTSIDER_TOKEN = "X".repeat(40);

// auth.mjs binds sha256Hex(token) as token_hash (core/auth.mjs:104-105),
// so the session fake must compare the HASH — a raw-token comparison
// starves every session and 401s the whole lane (lead-repaired fake
// defect, 2026-11-18; assertions untouched).
const OWNER_HASH = await sha256Hex(OWNER_TOKEN);
const STRANGER_HASH = await sha256Hex(STRANGER_TOKEN);
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
const OWNER_SESSION = sessionRow(OWNER_ID, "O");
const STRANGER_SESSION = sessionRow(STRANGER_ID, "S");
const OUTSIDER_SESSION = sessionRow(OUTSIDER_ID, "X");

// The bookmarkDb fake: three state maps ARE the whole seat — the message's
// server address (message_id -> server_id), the membership set ("user:server"),
// and the pointer rows. Absence of a pointer row IS the un-saved state
// (defaults law, spec §6): nothing exists until the member acts.
function bookmarkDb(options = {}) {
  const messages = new Map(options.messages || []);           // message_id -> server_id
  const membership = new Set(options.membership || []);       // "user_id:server_id"
  const bookmarks = (options.bookmarks || []).map((row) => ({ ...row }));
  const calls = [];

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async (bound) => {
        const token = String(bound[0] || "");
        if (token === OWNER_HASH) return OWNER_SESSION;
        if (token === STRANGER_HASH) return STRANGER_SESSION;
        if (token === OUTSIDER_HASH) return OUTSIDER_SESSION;
        return null;
      },
    },
    {
      // The statement-gated save (spec §4's BK_SAVE_SQL): membership +
      // existence + idempotence live INSIDE the statement. Bind order is
      // pinned by the spec: [owner, message, saved_at, message, owner,
      // owner, message]. A GREEN save that loses any gate arm or rides a
      // pre-read oracle instead, cannot pass this route with changes-.
      test: (sql) => sql.startsWith("INSERT INTO gc_bookmarks"),
      run: (bound) => {
        const ownerId = Number(bound[0]);
        const messageId = Number(bound[1]);
        const savedAt = Number(bound[2]);
        const serverId = messages.get(messageId);
        const reachable =
          serverId !== undefined &&
          membership.has(ownerId + ":" + serverId) &&
          !bookmarks.some((row) => row.owner_user_id === ownerId && row.message_id === messageId);
        if (reachable) bookmarks.push({ owner_user_id: ownerId, message_id: messageId, saved_at: savedAt });
        return { meta: { changes: reachable ? 1 : 0 } };
      },
    },
    {
      // The statement-gated delete (spec §4's BK_DELETE_SQL): ownership is
      // INSIDE the WHERE — a wrong owner (or a wrong id) answers changes-0,
      // classified to the shared 404, never a 403 oracle. RIDES FIRST: the
      // read route below matches on `includes("FROM gc_bookmarks")`, which
      // every DELETE also satisfies, so routes.find() first-match would
      // shadow this route and changes-0 could never fire (the fake-defect
      // class the lead ruled on 2026-11-18 — lead-repaired, assertions
      // untouched).
      test: (sql) => sql.startsWith("DELETE FROM gc_bookmarks"),
      run: (bound) => {
        const bookmarkId = Number(bound[0]);
        const ownerId = Number(bound[1]);
        const index = bookmarks.findIndex((row) =>
          row.id === bookmarkId && row.owner_user_id === ownerId);
        if (index === -1) return { meta: { changes: 0 } };
        bookmarks.splice(index, 1);
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.includes("FROM gc_bookmarks"),
      all: async (bound) => {
        // The private read: ONLY the owner's rows, newest-first, capped —
        // the fake answers from one user's map key, so a GREEN read that
        // drops the owner_user_id WHERE cannot assemble this shape.
        const ownerId = Number(bound[0]);
        const rows = bookmarks
          .filter((row) => row.owner_user_id === ownerId)
          .sort((a, b) => (b.saved_at - a.saved_at) || (b.message_id - a.message_id))
          .slice(0, 100); // GC_BOOKMARKS_LIST_MAX (spec §6); GREEN must ride the constant's LIMIT
        return { results: rows.map((row, i) => ({ id: ownerId * 1000 + i, ...row })) };
      },
    },
  ];

  const db = {
    calls,
    bookmarks,
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
  messages: [[MESSAGE_ID, SERVER_ID], [501, SERVER_ID]],
  membership: [OWNER_ID + ":" + SERVER_ID, STRANGER_ID + ":" + SERVER_ID],
};

function envOf(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function authed(method, path, session) {
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
  });
}
OWNER_SESSION.__token = OWNER_TOKEN;
STRANGER_SESSION.__token = STRANGER_TOKEN;
OUTSIDER_SESSION.__token = OUTSIDER_TOKEN;

// --- rows -------------------------------------------------------------------

test("the bookmarks pointer seat ships as ONE CREATE-only migration 0038: address columns only, no FK, no shared-table edit", () => {
  const text = readFileSync(new URL("../migrations/0038_gc_bookmarks.sql", import.meta.url), "utf8");
  const creates = text.match(/CREATE TABLE/g) || [];
  assert.equal(creates.length, 1, "the pointer IS the whole seat — ONE table");
  const body = text.slice(
    text.indexOf("CREATE TABLE gc_bookmarks"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_bookmarks")),
  );
  for (const column of ["id", "owner_user_id", "message_id", "saved_at"]) {
    assert.match(body, new RegExp("\\b" + column + "\\b"), column + " rides the seat");
  }
  assert.doesNotMatch(body,
    /\b(content|body|snippet|note|read|read_at|read_state|server_id)\b/,
    "no text copy, no read-state flag, no server_id — the row IS just an address");
  assert.doesNotMatch(body, /\bREFERENCES\b/, "NO FK (spec §5): orphans drop at read, no CASCADE arm");
  assert.match(text, /\bCREATE INDEX\b/, "the (owner_user_id, message_id) index serves list + duplicate guard");
  assert.doesNotMatch(text, /\b(ALTER|DROP|UPDATE|DELETE FROM|INSERT INTO)\b.*\b(gc_messages|gc_servers|gc_server_members|gc_channels)\b/,
    "no shared-table edit rides the migration");
});

test("GC_BOOKMARKS_LIST_MAX exists in constants.mjs and rides 100 — caps never re-declared", () => {
  const text = readFileSync(new URL("../constants.mjs", import.meta.url), "utf8");
  assert.match(text, /export const GC_BOOKMARKS_LIST_MAX = 100\b/,
    "the list cap is a named constants.mjs import, never a magic number in route code");
});

test("saving pins a private pointer row: owner_user_id + message_id + saved_at and NOTHING else", async () => {
  const db = bookmarkDb(SEED);
  const before = db.bookmarks.length;
  assert.equal(before, 0, "defaults law: no rows exist until the member acts");
  const response = await worker.fetch(
    authed("POST", "/api/messages/" + MESSAGE_ID + "/bookmark", OWNER_SESSION), envOf(db), {},
  );
  assert.equal(response.status, 200, "the save act exists and answers its state");
  const payload = await response.json();
  assert.equal(payload.saved, true);
  assert.equal(db.bookmarks.length, 1, "exactly one pointer row");
  assert.deepEqual(db.bookmarks[0], { owner_user_id: OWNER_ID, message_id: MESSAGE_ID, saved_at: db.bookmarks[0].saved_at },
    "the row carries owner_user_id + message_id + saved_at and NOTHING else");
  assert.equal(typeof db.bookmarks[0].saved_at, "number", "saved_at is the server's epoch seconds");
});

test("the save answer carries no text copy and no read-state — the pointer answer is ids and timestamps only", async () => {
  const db = bookmarkDb(SEED);
  const response = await worker.fetch(
    authed("POST", "/api/messages/" + MESSAGE_ID + "/bookmark", OWNER_SESSION), envOf(db), {},
  );
  const painted = JSON.stringify(await response.json());
  assert.doesNotMatch(painted, /"content"|"body"|"snippet"|"note"|"read"|"readAt"|"readState"/,
    "no text copy, no read-state flag ever rides the seat or its answer");
});

test("re-saving an already-saved message is idempotent: one row, still 200, no duplicate", async () => {
  const db = bookmarkDb(SEED);
  await worker.fetch(authed("POST", "/api/messages/" + MESSAGE_ID + "/bookmark", OWNER_SESSION), envOf(db), {});
  const second = await worker.fetch(
    authed("POST", "/api/messages/" + MESSAGE_ID + "/bookmark", OWNER_SESSION), envOf(db), {},
  );
  assert.equal(second.status, 200, "idempotent re-save answers its state");
  assert.equal(db.bookmarks.length, 1, "the NOT EXISTS guard keeps ONE row");
});

test("the list is PER-OWNER PRIVATE: only the caller's rows, newest-first, capped", async () => {
  const rows = [];
  for (let i = 0; i < 103; i++) {
    rows.push({ owner_user_id: OWNER_ID, message_id: 1000 + i, saved_at: NOW - i });
  }
  const db = bookmarkDb({
    ...SEED,
    bookmarks: [
      ...rows,
      { owner_user_id: STRANGER_ID, message_id: MESSAGE_ID, saved_at: NOW - 5 },
      { owner_user_id: STRANGER_ID, message_id: 501, saved_at: NOW - 6 },
    ],
  });
  const response = await worker.fetch(authed("GET", "/api/bookmarks", OWNER_SESSION), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.bookmarks), "the list is a list, never an error");
  assert.equal(payload.bookmarks.length, 100, "the list rides GC_BOOKMARKS_LIST_MAX (spec §6 = 100)");
  for (let i = 1; i < payload.bookmarks.length; i++) {
    assert.ok(payload.bookmarks[i - 1].savedAt >= payload.bookmarks[i].savedAt,
      "newest-first: saved_at DESC");
  }
  const painted = JSON.stringify(payload);
  assert.doesNotMatch(painted, new RegExp(`"owner_user_id"|"userId".*${STRANGER_ID}`),
    "no other member's rows, ids, or handles ride a private list");
  assert.equal(payload.bookmarks.some((row) => row.messageId === MESSAGE_ID && row.ownerUserId !== undefined), false,
    "rows answer messageId, never the owner column (the caller IS the owner)");
});

test("the empty member's list answers the valid empty shape (defaults law, nothing default-on)", async () => {
  const db = bookmarkDb(SEED);
  const response = await worker.fetch(authed("GET", "/api/bookmarks", OUTSIDER_SESSION), envOf(db), {});
  assert.equal(response.status, 200, "an empty list is VALID, not an error");
  assert.deepEqual(await response.json(), { bookmarks: [] },
    "the empty shape serves verbatim — no invented rows, no other member's rows leaked");
});

test("deleting MY bookmark removes the row; deleting SOMEONE ELSE'S answers the shared unknown 404 and never a 403", async () => {
  const own = { id: 7, owner_user_id: OWNER_ID, message_id: MESSAGE_ID, saved_at: NOW - 10 };
  const theirs = { id: 8, owner_user_id: STRANGER_ID, message_id: 501, saved_at: NOW - 11 };
  const db = bookmarkDb({ ...SEED, bookmarks: [own, theirs] });

  const wrongOwner = await worker.fetch(authed("DELETE", "/api/bookmarks/8", OWNER_SESSION), envOf(db), {});
  assert.equal(wrongOwner.status, 404);
  assert.equal((await wrongOwner.json()).error, "Bookmark not found.",
    "the shared unknown shape: wrong-owner and wrong-id are indistinguishable (no 403 oracle)");
  assert.equal(db.bookmarks.length, 2, "someone else's pointer row survives the wrong-owner attempt");

  const ownDelete = await worker.fetch(authed("DELETE", "/api/bookmarks/7", OWNER_SESSION), envOf(db), {});
  assert.equal(ownDelete.status, 200, "the owner deletes their own pointer");
  assert.equal(db.bookmarks.length, 1, "and only their own — the owner column was the whole key");
  assert.deepEqual(db.bookmarks[0].owner_user_id, STRANGER_ID);
});

test("a wrong message id and a non-member server answer ONE shared 404 body (statement-gate, no oracle)", async () => {
  const db = bookmarkDb({
    ...SEED,
    membership: [], // the outsider's save cannot reach the server via a pre-read
  });
  const noSuchMessage = await worker.fetch(
    authed("POST", "/api/messages/999999/bookmark", OWNER_SESSION), envOf(db), {},
  );
  assert.equal(noSuchMessage.status, 404);
  const unreachable = await worker.fetch(
    authed("POST", "/api/messages/" + MESSAGE_ID + "/bookmark", OUTSIDER_SESSION), envOf(db), {},
  );
  assert.equal(unreachable.status, 404,
    "OUTSIDER_SESSION rides membership: [] — the statement gate classifies changes-0 to the shared 404");
  assert.equal((await noSuchMessage.json()).error, "Message not found.");
  assert.equal((await unreachable.json()).error, "Message not found.",
    "member and non-member, wrong id and no membership: ONE body");
  assert.equal(db.bookmarks.length, 0, "no pointer row is conjured by an unreachable save");
});

test("un-authed: every bookmarks route answers 401 before any seat statement fires", async () => {
  const db = bookmarkDb(SEED);
  const attempts = [
    ["POST", "/api/messages/" + MESSAGE_ID + "/bookmark"],
    ["GET", "/api/bookmarks"],
    ["DELETE", "/api/bookmarks/7"],
  ];
  for (const [method, path] of attempts) {
    const response = await worker.fetch(authed(method, path, null), envOf(db), {});
    assert.equal(response.status, 401, method + " " + path + " answers the un-signed 401");
  }
  const seatStatements = db.calls.filter((call) => call.sql.includes("gc_bookmarks"));
  assert.equal(seatStatements.length, 0, "the 401 rides ahead of the seat — no gc_bookmarks statement");
});

test("sink law N/A: no gc_coin_ledger route exists in the fake, so a bookmark that mints fails by never being banked", async () => {
  const db = bookmarkDb(SEED);
  await worker.fetch(authed("POST", "/api/messages/" + MESSAGE_ID + "/bookmark", OWNER_SESSION), envOf(db), {});
  await worker.fetch(authed("GET", "/api/bookmarks", OWNER_SESSION), envOf(db), {});
  const coinStatements = db.calls.filter((call) => call.sql.includes("gc_coin_ledger"));
  assert.equal(coinStatements.length, 0, "bookmarks mint and sink nothing (spec §6)");
});
