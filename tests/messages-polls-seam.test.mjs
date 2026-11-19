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

// T-R26-POLLS (wave 26, W26-2): the channel polls seam pin. The poll
// message type rides api/messages.mjs's send pipeline (kind intake +
// POLL_INSERT_SQL inside sendMessageToChannel's ONE batch — the identity
// tuple re-derives the message id, ON CONFLICT(message_id) DO NOTHING
// keeps an idempotent replay inert); the vote/close arms + the payload
// builder ride api/messages-polls.mjs (the forward contract is the pins
// seam's: one forward at the dispatcher, the shared channels/messages
// machinery imported from messages.mjs, never copied); the payload rides
// groupedPayloadReads (the ONE grouped read stack — chunked under the D1
// bind limit, never a new parallel stack); the WS event reuses the rooms
// DO relay's existing {type:"msg", message} shape (NO new DO state, no
// new client frame type); the caps keep their constants.mjs single home
// (POLL_MAX_OPTIONS). The real-SQLite probe drives 0060/0061's DDL and
// every new poll statement end-to-end — node:sqlite enforces the
// placeholder/bind arithmetic (the guard-binds referee).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES_SOURCE = readFileSync(join(HERE, "../api/messages.mjs"), "utf8");
const ROOMS_SOURCE = readFileSync(join(HERE, "../api/rooms.mjs"), "utf8");
const CONSTANTS_SOURCE = readFileSync(join(HERE, "../constants.mjs"), "utf8");
const MIGRATION_0060 = readFileSync(join(HERE, "../migrations/0060_gc_polls.sql"), "utf8");
const MIGRATION_0061 = readFileSync(join(HERE, "../migrations/0061_gc_poll_votes.sql"), "utf8");

// The RED edge: api/messages-polls.mjs and the constants seats do not
// exist before the implementation — the file module-misses until the seam
// exists.
import { handleMessagesPollsRoutes } from "../api/messages-polls.mjs";
import { POLL_MAX_OPTIONS, GC_POLL_QUESTION_MAX, GC_POLL_OPTION_MAX } from "../constants.mjs";

void handleMessagesPollsRoutes;
void POLL_MAX_OPTIONS; void GC_POLL_QUESTION_MAX; void GC_POLL_OPTION_MAX;

// Handler slice: from the handler's own head to the next handler/exported
// head — bounded tight enough for a doesNotMatch to mean the handler
// itself.
function handlerSource(source, name) {
  const markers = ["async function " + name + "(", "function " + name + "("];
  const starts = markers.map((marker) => source.indexOf(marker))
    .filter((index) => index !== -1);
  const start = Math.min(...starts);
  assert.ok(start !== -1, name + " exists");
  const ends = ["\nasync function ", "\nexport async function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const end = Math.min(...ends, source.length);
  return source.slice(start, end);
}

test("the polls read/write family rides api/messages-polls.mjs — one single-purpose seam", () => {
  const source = readFileSync(join(HERE, "../api/messages-polls.mjs"), "utf8");
  assert.match(source, /export async function handleMessagesPollsRoutes\(/,
    "the family's forward answers in the seam");
  for (const shared of ["castPollVote", "closePoll", "appendPollPayloads"]) {
    assert.match(source, new RegExp("(export )?(async )?function " + shared + "\\("),
      shared + " lives in the seam");
  }
  // The vote/close/tally SQL keeps its seam home (never a second literal
  // in messages.mjs — POLL_INSERT_SQL is the one poll const messages.mjs
  // owns, inside the send batch).
  for (const fragment of [
    "const POLL_VOTE_UPSERT_SQL", "const POLL_CLOSE_SQL",
    "const POLL_TALLY_SQL", "const POLL_READ_SQL", "const POLL_VIEWER_ROWS_SQL",
  ]) {
    assert.match(source, new RegExp(fragment), fragment + " lives in the seam");
    assert.doesNotMatch(MESSAGES_SOURCE, new RegExp(fragment),
      fragment + " must NOT be duplicated in messages.mjs");
  }
  // The shared channels/messages machinery stays ONE implementation in
  // messages.mjs — imported (call-time use; the circular import stays
  // inert), never copied.
  for (const shared of [
    "channelForUser", "enforceChannelBits", "MESSAGE_SELECT",
    "groupedPayloadReads", "publicMessage", "enforceMemberGatesForChannel",
  ]) {
    assert.match(source, new RegExp("\\b" + shared + "\\b"), shared + " imported");
    assert.doesNotMatch(source,
      new RegExp("(async function |function )" + shared + "\\("),
      shared + " must NOT be redefined in the seam");
  }
});

test("messages.mjs delegates the polls — the send side rides the ONE batch", () => {
  // The send-side INSERT keeps ITS home in messages.mjs and is
  // replay-inert.
  assert.match(MESSAGES_SOURCE, /const POLL_INSERT_SQL/,
    "the poll INSERT keeps its home in messages.mjs");
  assert.match(MESSAGES_SOURCE, /ON CONFLICT\(message_id\) DO NOTHING/,
    "the poll INSERT is replay-inert");
  const sendBody = handlerSource(MESSAGES_SOURCE, "sendMessageToChannel");
  assert.match(sendBody, /POLL_INSERT_SQL/,
    "the poll INSERT rides the send's own batch");
  // The send route's poll kind intake.
  const sendRouteBody = handlerSource(MESSAGES_SOURCE, "handleSendMessageRoute");
  assert.match(sendRouteBody, /kind === "poll"/, "the poll kind intake");
  // The forward.
  assert.match(MESSAGES_SOURCE, /await handleMessagesPollsRoutes\(/,
    "the router hands the polls to the seam module");
  // The payload rides groupedPayloadReads — the ONE grouped read stack
  // (additive map inside the chunked loop, never a new parallel stack).
  const groupedBody = handlerSource(MESSAGES_SOURCE, "groupedPayloadReads");
  assert.match(groupedBody, /appendPollPayloads\(/,
    "the grouped loop carries the polls' read");
  assert.match(MESSAGES_SOURCE, /pollPayloadsByMessage/,
    "the payload map rides the existing maps' idiom");
});

test("no other family's path overlaps a poll path", () => {
  const seamSource = readFileSync(join(HERE, "../api/messages-polls.mjs"), "utf8");
  for (const literal of ["pollVoteMatch", "pollCloseMatch"]) {
    assert.doesNotMatch(MESSAGES_SOURCE, new RegExp(literal),
      literal + " lives in the seam");
  }
  // The seam answers its arms; the pins family answers no /poll segment.
  const pinsSource = readFileSync(join(HERE, "../api/messages-pins.mjs"), "utf8");
  for (const shape of ["poll/vote", "poll/close"]) {
    assert.ok(seamSource.includes(shape), "the seam answers " + shape);
    assert.ok(!pinsSource.includes(shape), "the pins family answers no " + shape);
  }
});

test("the poll caps keep their constants.mjs single home", () => {
  assert.match(CONSTANTS_SOURCE, /export const POLL_MAX_OPTIONS = 10/);
  assert.match(CONSTANTS_SOURCE, /export const GC_POLL_QUESTION_MAX = 200/);
  assert.match(CONSTANTS_SOURCE, /export const GC_POLL_OPTION_MAX = 100/);
  for (const sourceName of [MESSAGES_SOURCE, ROOMS_SOURCE]) {
    assert.doesNotMatch(sourceName, /const (POLL_MAX_OPTIONS|GC_POLL_QUESTION_MAX|GC_POLL_OPTION_MAX)\b/,
      "the poll caps are never re-declared outside constants.mjs");
  }
});

test("the WS event reuses the rooms DO relay's existing message-update shape", () => {
  // The frames arrive as new frame TYPES on the DO, but the fan-out is
  // the EXISTING {type:"msg", message} frame — the client needs no new
  // handler — and NO new persisted DO state rides them (the send floor's
  // reuse is the only state touched).
  for (const kind of ["poll_vote", "poll_close"]) {
    assert.match(ROOMS_SOURCE, new RegExp('type === "' + kind + '"'),
      "the DO relay answers " + kind);
  }
  const pollsBody = sliceBetween(ROOMS_SOURCE, 'type === "poll_vote"', "async ping");
  assert.match(pollsBody, /type: "msg", message: /,
    "the fan-out is the existing message-update shape");
  assert.doesNotMatch(pollsBody, /this\.[a-zA-Z]+ = new Map\(/,
    "no new DO state rides the poll frames");
});

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, startMarker + " exists");
  const end = source.indexOf(endMarker, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

// --- the real-SQLite probe (0060/0061 DDL + every poll statement) -------------

function sqliteEnv(db) {
  return {
    GOOBER_DB: {
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.run = async () => {
          // node:sqlite throws on a placeholder/bind mismatch — the same
          // arithmetic real D1 enforces; changes() reads the REAL count
          // back, so a refuted WHERE arm reports 0 exactly like D1.
          db.prepare(sql).run(...statement.bound);
          return { meta: { changes: db.prepare("SELECT changes() AS c").get().c } };
        };
        statement.first = async () => db.prepare(sql).get(...statement.bound) ?? null;
        statement.all = async () => ({ results: db.prepare(sql).all(...statement.bound) });
        return statement;
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) {
          results.push(statement.sql.startsWith("SELECT")
            ? await statement.all()
            : await statement.run());
        }
        return results;
      },
    },
  };
}

function pollSchema() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION_0060);
  db.exec(MIGRATION_0061);
  db.exec(`
    CREATE TABLE gc_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, author_id INTEGER, body TEXT, client_message_id TEXT, created_at INTEGER);
    CREATE TABLE gc_channels (id INTEGER PRIMARY KEY, server_id INTEGER, kind TEXT, last_message_id INTEGER, last_message_at INTEGER);
    CREATE TABLE gc_conversation_members (channel_id INTEGER, user_id INTEGER, last_read_message_id INTEGER);
    CREATE TABLE gc_server_members (server_id INTEGER, user_id INTEGER, role TEXT, joined_at INTEGER, timed_out_until INTEGER, nickname TEXT);
    CREATE TABLE gc_member_roles (server_id INTEGER, user_id INTEGER, role_id INTEGER);
    CREATE TABLE gc_roles (id INTEGER, server_id INTEGER, position INTEGER, permissions INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, username_key TEXT);
  `);
  for (const id of [42, 43]) {
    db.prepare("INSERT INTO users (id, username, username_key) VALUES (?, ?, ?)").run(id, String(id), String(id));
    db.prepare("INSERT INTO gc_server_members (server_id, user_id, role) VALUES (3, ?, 'member')").run(id);
  }
  db.prepare("INSERT INTO gc_channels (id, server_id) VALUES (10, 3)").run();
  db.prepare(
    "INSERT INTO gc_messages (id, channel_id, author_id, body, client_message_id, created_at) " +
      "VALUES (700, 10, 42, 'Lunch?', NULL, 5)",
  ).run();
  return db;
}

test("0060/0061's DDL + every poll statement run end-to-end on node:sqlite", async () => {
  const seam = await import("../api/messages-polls.mjs");
  const db = pollSchema();
  try {
    // The send-side INSERT rides the identity tuple and is replay-inert:
    // a second cast of the same (channel, author, NULL-cid) tuple changes
    // nothing (the UNIQUE(message_id) arm), never double-polls.
    const env = sqliteEnv(db);
    const sendShape = "INSERT INTO gc_polls " +
      "(message_id, channel_id, question, options_json, multiple, closed_at, closed_by, created_at) " +
      "SELECT m.id, m.channel_id, ?, ?, ?, NULL, NULL, m.created_at FROM gc_messages m " +
      "WHERE m.channel_id = ? AND m.author_id = ? AND m.client_message_id IS NULL " +
      "ORDER BY m.id DESC LIMIT 1 ON CONFLICT(message_id) DO NOTHING";
    db.prepare(sendShape).run("Lunch?", '["Pizza","Sushi"]', 0, 10, 42);
    db.prepare(sendShape).run("Lunch?", '["Pizza","Sushi"]', 0, 10, 42);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_polls").get().n, 1,
      "the replay stays inert");

    // The vote: cast, change (the conflict arm replaces), tally.
    await seam.castPollVote(env, 42, 700, [0]);
    await seam.castPollVote(env, 42, 700, [1]);
    await seam.castPollVote(env, 43, 700, [0]);
    const payloads = new Map();
    await seam.appendPollPayloads(env, 42, [700], payloads);
    const payload = payloads.get(700);
    assert.ok(payload, "the payload builder lands the poll's shape");
    assert.deepEqual(payload.votes, [1, 1], "the live tally counts both ballots");
    assert.deepEqual(payload.myChoices, [1], "the viewer's own claim");
    assert.equal(payload.closed, false);

    // Close: the creator's arm closes; a non-creator's arm refutes
    // in-statement (changes 0 → the shared 403); a closed poll refuses
    // further casts.
    await seam.closePoll(env, 42, 700);
    const payloadsAfter = new Map();
    await seam.appendPollPayloads(env, 42, [700], payloadsAfter);
    assert.equal(payloadsAfter.get(700).closed, true, "the close state reads back");
    await assert.rejects(
      closePollFor(seam, env, 43, 700),
      "the non-creator's close refutes",
    );
    await assert.rejects(
      castPollFor(seam, env, 42, 700, [0]),
      "the closed poll's vote arm refuses",
    );
  } finally { db.close(); }
});

async function closePollFor(seam, env, userId, messageId) {
  await seam.closePoll(env, userId, messageId);
}

async function castPollFor(seam, env, userId, messageId, choices) {
  await seam.castPollVote(env, userId, messageId, choices);
}
