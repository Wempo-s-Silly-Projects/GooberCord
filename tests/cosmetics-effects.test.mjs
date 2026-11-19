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

// The cosmetics effects runtime (Phase 3 of the 2026-11-19 cosmetic v1
// slate — docs/superpowers/specs/2026-11-19-cosmetics-v1-design.md): the
// equipped fx_burst pack spends ONE use per fresh reaction ADD — the ride
// lives INSIDE the reaction route, verdict-gated on the INSERT's changes = 1,
// as ONE batch whose two statements each carry the WHOLE guard set (flag:
// row unflagged + equipped live pack; consume: flag THERE + qty > 0), so the
// decrement and the flag land together or not at all (the Phase 1 purchase
// idiom's atomicity discipline). The flag echoes in the grouped reaction
// reads; the client's burst render is a one-shot CSS class on the flagged
// ADD response.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleSocialRoutes } from "../api/social.mjs";
import { handleMessageRoutes } from "../api/messages.mjs";
import { handleCoinRoutes } from "../api/coins.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS, GC_COSMETIC_FX_BURST_ITEM } from "../constants.mjs";

// A local clone of the statement splitter (the shared helper runs its own
// file's tests into this file's count when imported — keep the run scoped).
function splitStatements(sql) {
  const withoutComments = sql.replace(/--[^\n]*/g, "");
  const count = (s, word) => (s.match(new RegExp(`\\b${word}\\b`, "gi")) || []).length;
  const statements = [];
  let buf = [];
  for (const part of withoutComments.split(";")) {
    buf.push(part);
    const candidate = buf.join(";");
    if (count(candidate, "begin") === count(candidate, "end")) {
      const trimmed = candidate.trim();
      if (trimmed) statements.push(trimmed);
      buf = [];
    }
  }
  const tail = buf.join(";").trim();
  if (tail) statements.push(tail);
  return statements;
}

const HERE = dirname(new URL(import.meta.url).pathname);
const ORIGIN = "http://localhost";
const USER_ID = 7;
const MESSAGE_ID = 42;
const CHANNEL_ID = 3;
const NOW = nowSeconds();

const SOCIAL = readFileSync(join(HERE, "../api/social.mjs"), "utf8");
const MESSAGES = readFileSync(join(HERE, "../api/messages.mjs"), "utf8");
const CHAT = readFileSync(join(HERE, "../public/js/ui/chat.js"), "utf8");
const STYLES = readFileSync(join(HERE, "../public/styles.css"), "utf8");
const FX_MIGRATION = readFileSync(join(HERE, "../migrations/0057_message_fx_burst.sql"), "utf8");

// --- scaffolding (same conventions as tests/social-module.test.mjs) -------------

function request(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function dispatchVia(handlers, request_, env) {
  const url = new URL(request_.url);
  return (async () => {
    let response;
    for (const handler of handlers) {
      try {
        response = await handler(
          request_, env, url, url.pathname, request_.method.toUpperCase(), undefined,
        );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        response = json(error.payload || { error: error.message }, error.status, error.headers);
      }
      if (response) return response;
    }
    return new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
  })();
}

const dispatchSocial = (req, env) => dispatchVia([handleSocialRoutes], req, env);
const dispatchMessages = (req, env) => dispatchVia([handleMessageRoutes, handleSocialRoutes], req, env);

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

const SESSION_TOKEN = "A".repeat(40);
const CSRF_TOKEN = "B".repeat(24);
const SESSION_ROW = {
  token_hash: await sha256Hex(SESSION_TOKEN),
  user_id: USER_ID,
  csrf_token: CSRF_TOKEN,
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
const HEADERS = { Cookie: "goober_session=" + SESSION_TOKEN, "X-CSRF-Token": CSRF_TOKEN };

function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// --- the SQL shapes the ride carries ---------------------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const MESSAGE_READ_TEST = (sql) => sql.includes("FROM gc_messages m WHERE m.id = ? LIMIT 1");
const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c") && sql.includes("gc_conversation_members cm");
const MEMBER_GATE_TEST = (sql) =>
  sql.includes("FROM gc_server_members m JOIN users u") && sql.includes("timed_out_until");
const REACTION_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_message_reactions");
const REACTION_HELD_TEST = (sql) =>
  sql.startsWith("SELECT 1 AS held FROM gc_message_reactions");
const BURST_FLAG_TEST = (sql) => sql.startsWith("UPDATE gc_message_reactions SET fx_burst = 1");
const BURST_CONSUME_TEST = (sql) =>
  sql.startsWith("UPDATE gc_cosmetic_inventory SET qty = qty - 1") &&
  sql.includes("gc_message_reactions");
const REACTION_GROUPED_TEST = (sql) =>
  sql.includes("FROM gc_message_reactions r JOIN users u ON u.id = r.user_id") &&
  sql.includes("ORDER BY");
const EQUIP_CLEAR_TEST = (sql) => sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 0");
const EQUIP_SET_TEST = (sql) => sql.startsWith("UPDATE gc_cosmetic_inventory SET equipped = 1");
const INVENTORY_READ_TEST = (sql) =>
  sql.startsWith("SELECT item_key, kind, qty, equipped, server_id");

// The burst state the fake encodes: the pack row (0056's columns) and the
// flagged state the flag statement would set. The arms mirror the pinned SQL.
function reactionDb({ insertChanges = 1, held = false, pack = null } = {}) {
  let packState = pack === null ? null : { ...pack };
  let flagged = false;
  const burstErrors = [];
  const calls = [];

  const routes = [
    { test: SESSION_READ_TEST, first: async () => SESSION_ROW },
    { test: MESSAGE_READ_TEST, first: async () => ({ id: MESSAGE_ID, channel_id: CHANNEL_ID }) },
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: null, kind: "dm" }) },
    { test: MEMBER_GATE_TEST, first: async () => ({ timed_out_until: null, role: "member", joined_at: 1, account_created_at: 1, permissions: 0 }) },
    { test: REACTION_INSERT_TEST, run: async () => ({ meta: { changes: insertChanges } }) },
    { test: REACTION_HELD_TEST, first: async () => (held ? { held: 1 } : null) },
    // The flag statement: its WHERE arms are the unflagged row + the live
    // equipped pack; the fake encodes BOTH, so a pinned statement that lost
    // an arm answers changes = 0.
    {
      test: BURST_FLAG_TEST,
      run: async () => {
        const live = packState !== null && packState.equipped === 1 && packState.qty > 0;
        if (!live || flagged) return { meta: { changes: 0 } };
        flagged = true;
        return { meta: { changes: 1 } };
      },
    },
    // The consume statement: its arms are the flag THERE + qty > 0 (visible
    // within the same batch — the pair is one transaction server-side).
    {
      test: BURST_CONSUME_TEST,
      run: async () => {
        if (!flagged || packState === null || packState.qty < 1) {
          return { meta: { changes: 0 } };
        }
        packState = { ...packState, qty: packState.qty - 1 };
        return { meta: { changes: 1 } };
      },
    },
  ];

  const db = {
    calls,
    packStateOf: () => packState,
    flaggedOf: () => flagged,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        if (!route || !route.run) return { meta: { changes: 0 } };
        return route.run(statement.bound);
      };
      return statement;
    },
    // The burst arm rides ONE batch; a broken arm models the D1 failure the
    // best-effort discipline answers.
    async batch(statements) {
      if (burstErrors.length > 0) throw burstErrors.shift();
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      calls.push({
        call: "batch",
        statements: statements.map((entry) => ({ sql: entry.sql, bound: entry.bound })),
      });
      return results;
    },
  };
  db.breakBatches = (error) => burstErrors.push(error);
  return db;
}

// --- the migration (0057 — the flag rides the reaction row) -----------------------

test("0057 is exactly one statement: ALTER adding the burst flag, nothing else", () => {
  const statements = splitStatements(FX_MIGRATION).filter((entry) => entry.trim().length > 0);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^ALTER TABLE gc_message_reactions ADD COLUMN fx_burst\b/);
  assert.match(statements[0], /INTEGER NOT NULL DEFAULT 0/);
});

test("0057 applies on the 0009 reactions schema and the flag rides the row", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_messages (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL);
    CREATE TABLE gc_message_reactions (
      message_id INTEGER NOT NULL REFERENCES gc_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL CHECK(length(emoji) BETWEEN 1 AND 32),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji));
  `);
  db.exec(FX_MIGRATION);
  db.prepare("INSERT INTO users (id) VALUES (2)").run();
  db.prepare("INSERT INTO gc_messages (id, channel_id) VALUES (1, 1)").run();
  db.prepare(
    "INSERT INTO gc_message_reactions (message_id, user_id, emoji, created_at) VALUES (1, 2, '🔥', 3)",
  ).run();
  db.prepare(
    "UPDATE gc_message_reactions SET fx_burst = 1 WHERE message_id = 1 AND user_id = 2 AND emoji = '🔥'",
  ).run();
  assert.equal(
    db.prepare("SELECT fx_burst AS flag FROM gc_message_reactions").get().flag,
    1,
  );
});

// --- the reaction route's ride (verdict-gated, one batch, both guards) ------------

test("a fresh ADD rides the burst arm: one batch, flag then consume, response echoes fxBurst", async () => {
  const db = reactionDb({
    pack: { itemKey: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 2, equipped: 1 },
  });
  const response = await dispatchSocial(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, HEADERS),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  const body = await bodyOf(response);
  assert.equal(body.reaction.fxBurst, true);

  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "the burst arm runs as ONE batch");
  assert.equal(batch.statements.length, 2, "the flag, then the consume (one transaction)");
  const [flag, consume] = batch.statements;
  assert.match(flag.sql, /UPDATE gc_message_reactions SET fx_burst = 1/);
  // The flag's arms: the unflagged row + the equipped live pack, INSIDE the SQL.
  assert.match(flag.sql, /fx_burst = 0/);
  assert.match(flag.sql, /gc_cosmetic_inventory/);
  assert.match(flag.sql, /kind = 'consumable'/);
  assert.match(flag.sql, /equipped = 1/);
  assert.match(flag.sql, /qty > 0/);
  assert.equal(flag.bound[0], MESSAGE_ID);
  assert.equal(flag.bound[1], USER_ID);
  // The consume's arms: the flag THERE + the pack's qty floor.
  assert.match(consume.sql, /SET qty = qty - 1/);
  assert.match(consume.sql, /kind = 'consumable'/);
  assert.match(consume.sql, /equipped = 1/);
  assert.match(consume.sql, /qty > 0/);
  assert.match(consume.sql, /fx_burst = 1/);
  // A spent pack decrements exactly one use.
  assert.equal(db.packStateOf().qty, 1, "exactly one use spent");
});

test("the ride is verdict-gated: a zero-change ADD (replay or cap) never consumes", async () => {
  const replay = reactionDb({
    insertChanges: 0, held: true,
    pack: { itemKey: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 2, equipped: 1 },
  });
  const replayResponse = await dispatchSocial(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, HEADERS),
    envWithLimiters(replay),
  );
  assert.equal(replayResponse.status, 201);
  assert.equal((await bodyOf(replayResponse)).reaction.fxBurst, undefined,
    "an idempotent replay fires no effect");
  assert.equal(replay.packStateOf().qty, 2, "no use spent on a replay");
  assert.equal(replay.calls.some((entry) => entry.call === "batch"), false);

  const cap = reactionDb({
    insertChanges: 0, held: false,
    pack: { itemKey: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 2, equipped: 1 },
  });
  const capResponse = await dispatchSocial(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🎉" }, HEADERS),
    envWithLimiters(cap),
  );
  assert.equal(capResponse.status, 400);
  assert.equal(cap.packStateOf().qty, 2);
  assert.equal(cap.calls.some((entry) => entry.call === "batch"), false,
    "the cap refusal never rides the burst arm");
});

test("the lost race leaves qty and fires no effect (all-zero, the original row survives)", async () => {
  // pack = an EMPTY equipped row: the flag's pack arm fails, the consume's
  // qty arm fails, and the pair lands all-zero.
  const db = reactionDb({
    pack: { itemKey: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 0, equipped: 1 },
  });
  const response = await dispatchSocial(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, HEADERS),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  const body = await bodyOf(response);
  assert.equal(body.reaction.fxBurst, undefined, "no effect fired");
  assert.equal(db.packStateOf().qty, 0, "the row survives at its floor");
  assert.equal(db.flaggedOf(), false, "the row is never flagged without the decrement");
  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "the guarded pair still ran (changes = 0 each)");
});

test("a failed burst batch never fails the reaction (best-effort, console.error(errorName))", async () => {
  const db = reactionDb({
    pack: { itemKey: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 2, equipped: 1 },
  });
  const failures = [];
  const original = console.error;
  console.error = (...parts) => failures.push(parts);
  db.breakBatches(new Error("d1 outage"));
  try {
    const response = await dispatchSocial(
      request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, HEADERS),
      envWithLimiters(db),
    );
    assert.equal(response.status, 201, "the reaction keeps its plain 201");
    assert.equal((await bodyOf(response)).reaction.fxBurst, undefined);
  } finally {
    console.error = original;
  }
  assert.ok(failures.length === 1, "the failure surfaces exactly once");
  assert.match(String(failures[0][0]), /burst/i);
  assert.equal(failures[0][1], "Error", "the errorName discipline rides the ride");
});

test("the equipped arm rides the consume: an UNEQUIPPED pack neither flags nor spends", async () => {
  const db = reactionDb({
    pack: { itemKey: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 3, equipped: 0 },
  });
  const response = await dispatchSocial(
    request("PUT", "/api/messages/" + MESSAGE_ID + "/reactions", { emoji: "🔥" }, HEADERS),
    envWithLimiters(db),
  );
  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).reaction.fxBurst, undefined);
  assert.equal(db.packStateOf().qty, 3, "an unequipped pack never auto-spends");
  assert.equal(db.flaggedOf(), false);
});

// --- the flag's payload passthrough ----------------------------------------------

test("the grouped detail read's SELECT carries the fx_burst flag", async () => {
  const db = reactionDb();
  const response = await dispatchSocial(
    request("GET", "/api/messages/" + MESSAGE_ID + "/reactions", undefined, HEADERS),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const read = db.calls.find((entry) => REACTION_GROUPED_TEST(entry.sql));
  assert.ok(read, "the grouped read ran");
  assert.match(read.sql, /r\.fx_burst AS fx_burst/,
    "the flag rides the row read — the echo stays additive");
});

// (the detail/grouped echo pins below run against a stubbed read layer)

// One flagged row for the history page's grouped read, and the page's single
// message row (the same publicMessage shape the social-module stub rides).
const MESSAGE_PAGE_ROW = {
  id: MESSAGE_ID, author_id: USER_ID, author_name: "wempos", body: "hi",
  client_message_id: null, source: null, created_at: NOW, edited_at: null,
  author_accent: null,
};

function readDb(reactionRows) {
  return {
    calls: [],
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        statement.bound.forEach(() => {});
        if (MESSAGE_READ_TEST(sql)) return { id: MESSAGE_ID, channel_id: CHANNEL_ID };
        if (SESSION_READ_TEST(sql)) return SESSION_ROW;
        if (CHANNEL_ACCESS_TEST(sql)) return { id: CHANNEL_ID, server_id: null, kind: "dm" };
        if (sql.includes("SELECT server_id FROM gc_channels WHERE id")) return { server_id: null };
        if (sql.includes("gc_conversation_members.last_read_message_id")) return null;
        return null;
      };
      statement.all = async () => {
        if (REACTION_GROUPED_TEST(sql)) return { results: reactionRows };
        if (sql.includes("FROM gc_attachments")) return { results: [] };
        if (sql.includes("FROM gc_messages m")) return { results: [MESSAGE_PAGE_ROW] };
        return { results: [] };
      };
      statement.run = async () => ({ meta: { changes: 0 } });
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

test("GET /api/messages/:id/reactions echoes fxBurst on flagged users, plain shape otherwise", async () => {
  const db = readDb([
    { emoji: "🔥", user_id: USER_ID, username: "wempos", fx_burst: 1 },
    { emoji: "🔥", user_id: 9, username: "ada" },
    { emoji: "🙂", user_id: 8, username: "bean", fx_burst: 0 },
  ]);
  const response = await dispatchSocial(
    request("GET", "/api/messages/" + MESSAGE_ID + "/reactions", undefined, HEADERS),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  const fire = body.reactions.find((entry) => entry.emoji === "🔥");
  const warm = body.reactions.find((entry) => entry.emoji === "🙂");
  assert.equal(fire.users[0].fxBurst, true);
  assert.equal(fire.users[1].fxBurst, undefined, "an unflagged entry keeps its plain shape");
  assert.deepEqual(warm.users, [{ id: 8, username: "bean" }]);
});

test("the history page's grouped read echoes fxBurst on the flagged user entry", async () => {
  const rows = [{
    message_id: MESSAGE_ID, emoji: "🔥", user_id: USER_ID, username: "wempos", fx_burst: 1,
  }];
  const db = readDb(rows);
  const response = await dispatchMessages(
    request("GET", "/api/channels/" + CHANNEL_ID + "/messages", undefined, HEADERS),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.messages[0].reactions[0].users[0].fxBurst, true,
    "the flagged payload echoes through the list payload");
});

test("the flag rides BOTH messages.mjs grouped reads (history + pins) in the SELECT", () => {
  const echoes = (MESSAGES.match(/r\.fx_burst AS fx_burst/g) || []).length;
  assert.equal(echoes, 2, "the history page and the pins page grouped reads");
});

// --- the equip arm extension (the effects slot equips its pack) -------------------

test("the fx_burst pack equips through the one batch (the effects slot's equipped arm)", async () => {
  const calls = [];
  const packRow = { user_id: USER_ID, item_key: GC_COSMETIC_FX_BURST_ITEM, kind: "consumable", qty: 5, equipped: 0 };
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
        if (SESSION_READ_TEST(sql)) return SESSION_ROW;
        if (sql.startsWith("SELECT 1 AS owned FROM gc_cosmetic_inventory")) return { owned: 1 };
        return null;
      };
      statement.all = async () => ({ results: [{ ...packRow, equipped: 1 }] });
      statement.run = async () => ({ meta: { changes: 1 } });
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({
        call: "batch",
        statements: statements.map((entry) => ({ sql: entry.sql, bound: entry.bound })),
      });
      return results;
    },
  };
  const { built } = {
    built: request("POST", "/api/coins/cosmetics/equip", { itemKey: GC_COSMETIC_FX_BURST_ITEM }, HEADERS),
  };
  const url = new URL(built.url);
  const response = await handleCoinRoutes(
    built, { GOOBER_DB: db, ...Object.fromEntries(Object.values(RATE_LIMIT_BINDINGS).map((binding) => [binding, { limit: async () => ({ success: true, key: binding }) }])) },
    url, url.pathname, "POST", undefined,
  );
  assert.ok(response, "the route answers");
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.equipped, true);
  assert.equal(body.itemKey, GC_COSMETIC_FX_BURST_ITEM);
  assert.equal(body.inventory.find((row) => row.itemKey === GC_COSMETIC_FX_BURST_ITEM).equipped, true);
  const batch = db.calls.find((entry) => entry.call === "batch");
  assert.ok(batch, "one batch, one transaction");
  assert.ok(batch.statements.some((entry) => EQUIP_CLEAR_TEST(entry.sql)));
  assert.ok(batch.statements.some((entry) => EQUIP_SET_TEST(entry.sql)));
});

// --- the source pins (the render half pins by source, per the suite's contract) ---

test("the ride order: the burst arm sits INSIDE the changes = 1 verdict, before the 201", () => {
  const verdict = SOCIAL.indexOf("Number(insert?.meta?.changes) === 1");
  const ride = SOCIAL.indexOf("burst = await fireReactionBurstArm(");
  const respond = SOCIAL.indexOf("mine: true", ride);
  assert.ok(verdict > -1 && ride > verdict && respond > ride,
    "verdict -> ride (best-effort) -> response");
  assert.match(SOCIAL, /try \{\s*\n\s*burst = await fireReactionBurstArm/,
    "the ride is best-effort (never a thrower through the route)");
});

test("the burst constant is the single source of truth (constants.mjs, imported, never re-declared)", () => {
  assert.equal(GC_COSMETIC_FX_BURST_ITEM, "fx_burst_confetti");
  assert.match(SOCIAL, /import \{[^}]*GC_COSMETIC_FX_BURST_ITEM[^}]*\} from "\.\.\/constants\.mjs"/);
});

test("the client burst render: one CSS class on the flagged ADD with aria-hidden + animationend", () => {
  assert.match(CHAT, /fx-burst/, "the burst class pins in the reactions module");
  assert.match(CHAT, /fxBurst/, "the client keys on the flagged payload");
  assert.match(CHAT, /animationend/, "the overlay removes itself");
  assert.match(CHAT, /aria-hidden/, "the burst is decorative (no copy, no i18n key)");
  assert.match(STYLES, /@keyframes fx-burst-fade/);
  assert.match(STYLES, /@keyframes fx-burst-scatter/);
  assert.match(STYLES, /pointer-events: none/, "the overlay never eats clicks");
});

test("the picker's order law: refresh FIRST, burst SECOND at both call sites", () => {
  // The regression the HIGH finding caught: laneRefresh does
  // column.replaceChildren() in the same tick, so a burst pinned BEFORE the
  // refresh dies before its first frame paints (a paid use that shows
  // nothing). The pin catches the swap at both arms.
  const picker = CHAT.slice(
    CHAT.indexOf("function reactionPicker"),
    CHAT.indexOf("const dialog = openDialog"),
  );
  const refreshes = [...picker.matchAll(/refreshColumn\(columnNodeRef, currentChannelId\)/g)]
    .map((match) => match.index);
  const bursts = [...picker.matchAll(/fireBurst\(message\)/g)].map((match) => match.index);
  assert.equal(refreshes.length, 2, "one refresh per arm (common + super)");
  assert.equal(bursts.length, 2, "one burst call per arm");
  for (const arm of [0, 1]) {
    assert.ok(refreshes[arm] < bursts[arm],
      "arm " + arm + ": the refresh runs first, the burst pins the rebuilt row");
  }
});

