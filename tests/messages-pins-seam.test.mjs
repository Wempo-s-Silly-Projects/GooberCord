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

// T-R25-SPLIT-MSGS-1: the pins seam (the first family off api/messages.mjs).
// The 0026 pins family rides api/messages-pins.mjs verbatim: the section
// (the manage-pin read + pinRights + both handlers) + the TWO router tail
// arms (PUT/DELETE /api/messages/:id/pin + GET /api/channels/:id/pins —
// contiguous, the router's LAST arms, no interior interloper between them).
// The forward sits at the pin arm's ORIGINAL position; its `undefined`
// fall-through keeps the router's remaining arms running exactly as before.
// The payload/gate machinery the pins read shares with the history page
// (channelForUser/enforceChannelBits/MESSAGE_SELECT/groupedPayloadReads/
// publicMessage) stays ONE implementation in messages.mjs, imported at CALL
// time (the circular import stays inert); no SQL fragment mirrors are
// needed (the family owns no module-scope guard SQL of its own — the cap
// arm rides the UPDATE's WHERE verbatim).
//
// Overlap enumeration rides the overlap test: /pin and /pins carry a path
// segment the bare-id families (/messages/:id, /channels/:id/messages) never
// reach; no sibling matches.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleMessageRoutes } from "../api/messages.mjs";
import { handleMessagesPinsRoutes } from "../api/messages-pins.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { GC_PINS_MAX_PER_CHANNEL, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM_SOURCE = readFileSync(join(HERE, "../api/messages-pins.mjs"), "utf8");
const MESSAGES_SOURCE = readFileSync(join(HERE, "../api/messages.mjs"), "utf8");

const ORIGIN = "http://localhost";
const USER_ID = 7;

test("the pins family rides api/messages-pins.mjs — one single-purpose module", () => {
  for (const handler of ["handlePinRoute", "handleChannelPinsRoute", "pinRights"]) {
    assert.match(SEAM_SOURCE, new RegExp("(async function |function )" + handler + "\\("),
      handler + " moved with its family");
  }
  // The family's manage-grant fragment rides with it (no SQL text rewritten
  // anywhere); the cap-law constant rides the seam's imports, never a
  // literal.
  assert.match(SEAM_SOURCE, /const PIN_MANAGER_READ_SQL/);
  assert.match(SEAM_SOURCE, /GC_PINS_MAX_PER_CHANNEL/);
  // The shared payload/gate machinery stays ONE implementation — imported at
  // call time, never copied.
  for (const shared of [
    "channelForUser", "enforceChannelBits", "MESSAGE_SELECT",
    "groupedPayloadReads", "publicMessage",
  ]) {
    assert.match(SEAM_SOURCE, new RegExp("\\b" + shared + "\\b"), shared + " imported");
    assert.doesNotMatch(SEAM_SOURCE,
      new RegExp("(async function |function )" + shared + "\\("),
      shared + " must NOT be redefined in the seam");
  }
});

test("messages.mjs delegates the pins — one dispatch, no copied pin handlers", () => {
  for (const handler of ["handlePinRoute", "handleChannelPinsRoute"]) {
    assert.doesNotMatch(MESSAGES_SOURCE,
      new RegExp("async function " + handler + "\\("),
      handler + " must NOT remain defined in messages.mjs");
  }
  assert.doesNotMatch(MESSAGES_SOURCE, /const PIN_MANAGER_READ_SQL/);
  // The router's dispatch block is the forward.
  assert.match(MESSAGES_SOURCE, /await handleMessagesPinsRoutes\(/,
    "the router hands the pins to the seam module");
  // The shared helpers stay exported from messages.mjs (the one-implementation
  // contract — newly exported BY this move, still defined HERE).
  for (const shared of [
    "function groupedPayloadReads", "function publicMessage",
    "const MESSAGE_SELECT",
  ]) {
    assert.match(MESSAGES_SOURCE, new RegExp(shared.replace("$", "\\$")),
      shared + " stays in messages.mjs");
  }
});

test("no other family's path overlaps a pin path", () => {
  // The bare-id families match exact /api/messages/:id and
  // /api/channels/:id/messages — neither reaches a /pin or /pins segment.
  for (const literal of ["pinMatch", "pinsMatch"]) {
    assert.doesNotMatch(MESSAGES_SOURCE, new RegExp(literal),
      literal + " moved to the seam");
  }
  // The seam pins both arms it answers (nothing rides the fall-through by
  // accident).
  assert.match(SEAM_SOURCE, /\\\/messages\\\/\(\[1-9\]\[0-9\]\{0,14\}\)\\\/pin\$/, "the seam answers /messages/:id/pin");
  assert.match(SEAM_SOURCE, /\\\/channels\\\/\(\[1-9\]\[0-9\]\{0,14\}\)\\\/pins\$/, "the seam answers /channels/:id/pins");
});

// --- the smoke (the pin PUT through handleMessageRoutes) --------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const CLASSIFIER_TEST = (sql) =>
  sql.includes("SELECT m.author_id AS author_id, m.is_pinned AS is_pinned") &&
  sql.includes("FROM gc_messages m JOIN gc_channels c");

const { randomToken, sha256Hex, nowSeconds } = await import("../api/core/crypto.mjs");
const authToken = randomToken();
const csrf = randomToken(24);
const sessionRow = {
  token_hash: await sha256Hex(authToken),
  user_id: USER_ID,
  csrf_token: csrf,
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatchMessages(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMessageRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

test("the seam walks the SAME wire through handleMessageRoutes (the guarded pin UPDATE runs)", async () => {
  // Own-message pin: the classifier read answers the caller's own author id
  // on a server channel, and the guarded cap UPDATE rides the seam module
  // byte-unchanged (the count arm + the cited constant inside the WHERE).
  const runCalls = [];
  const firstCalls = [];
  const env = {
    GOOBER_DB: {
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.first = async () => {
          firstCalls.push({ sql, bound: statement.bound });
          if (SESSION_READ_TEST(sql)) return sessionRow;
          if (CLASSIFIER_TEST(sql)) return { author_id: USER_ID, is_pinned: 0, server_id: 1 };
          return null;
        };
        statement.all = async () => ({ results: [] });
        statement.run = async () => {
          runCalls.push({ sql, bound: statement.bound });
          return { meta: { changes: 1, last_row_id: 0 } };
        };
        return statement;
      },
    },
  };
  const response = await dispatchMessages(
    new Request(ORIGIN + "/api/messages/42/pin", {
      method: "PUT",
      headers: {
        Origin: ORIGIN,
        Cookie: "goober_session=" + authToken,
        "X-CSRF-Token": csrf,
      },
    }),
    envWithLimiters(env),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { pinned: true, id: 42 });
  const update = runCalls.find((call) => call.sql.startsWith("UPDATE gc_messages SET is_pinned"));
  assert.ok(update, "the pin rode the seam module's guarded UPDATE under the same route");
  assert.match(update.sql, /is_pinned = 1 WHERE id = \? AND/);
  assert.match(update.sql, /\(SELECT COUNT\(\*\) FROM gc_messages WHERE channel_id =/);
  assert.deepEqual(update.bound, [42, 42, GC_PINS_MAX_PER_CHANNEL],
    "the cap arm rides the WHERE byte-unchanged, bound to the cited constant");
  const classifier = firstCalls.find((call) => CLASSIFIER_TEST(call.sql));
  assert.ok(classifier, "the classifier read rides byte-unchanged");
  // And the direct seam entry answers the same path (the forward holds).
  assert.equal(typeof handleMessagesPinsRoutes, "function");
});
