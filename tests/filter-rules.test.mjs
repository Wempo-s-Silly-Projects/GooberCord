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

// The filter/AutoMod batch (0010): the per-server rule matcher (api/
// filterrules.mjs — wildcards, regex, care, exemptions), the rule CRUD + the
// alerts feed routes (api/servers.mjs), the send-path gate (api/messages.mjs —
// block with a linked alert + the owner-timed-out write, care with the inline
// careNotice), the nickname screen, and the Care class's WS delivery frame.
// Same fakeDb + pinned-SQL conventions as the messages/servers modules: the
// authorization contract lives in the query text, so that is what the tests
// assert.
import { handleMessageRoutes } from "../api/messages.mjs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleServerRoutes } from "../api/servers.mjs";
import { ChatRoom } from "../api/rooms.mjs";
import {
  _resetServerRulesCacheForTests,
  CARE_HELPLINE_URL,
  evaluateServerRules,
  FILTERED_NAME_ERROR,
  filterAlertInsertSql,
  filterAlertPruneSql,
  FILTER_RULE_MAX_PATTERNS,
  FILTER_RULE_MAX_TERMS,
  FILTER_RULE_TERM_CHARACTERS,
  FILTER_RULE_PATTERN_CHARACTERS,
  FILTER_RULE_MAX_RULES,
  FILTER_RULE_EXEMPT_ROLES_MAX,
  FILTER_RULE_EXEMPT_CHANNELS_MAX,
  nameRuleHit,
  parseFilterTerm,
  ruleMatchesText,
  termsFromBody,
  timeoutAsOwnerSql,
} from "../api/filterrules.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const CHANNEL_ID = 3;
const SERVER_ID = 1;
const KICK_BIT = SERVER_PERMISSIONS.KICK_MEMBERS;

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function fakeDb(routes) {
  const calls = [];
  let nextRowId = 0;
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
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        const route = find(sql);
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run(false));
      calls.push({
        call: "batch",
        sql: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

async function sessionFixtures(role = "member") {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role,
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return {
    token,
    row,
    headers: {
      Cookie: "__Host-goober_session=" + token,
      "X-CSRF-Token": csrf,
      Origin: ORIGIN,
    },
  };
}

function jsonRequest(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatchMessages(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMessageRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

async function dispatchServers(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleServerRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

function messageRow(overrides = {}) {
  return {
    id: 11,
    author_id: USER_ID,
    author_name: "wempos",
    body: "hello",
    client_message_id: null,
    source: null,
    created_at: 100,
    edited_at: null,
    ...overrides,
  };
}

// --- the send path's own SQL shapes --------------------------------------------

const CHANNEL_SERVER_TEST = (sql) => sql === "SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1";

const CHANNEL_ACCESS_TEST = (sql) =>
  sql.includes("FROM gc_channels c WHERE c.id = ?") &&
  sql.includes("gc_server_members m") &&
  sql.includes("gc_conversation_members cm");

const FILTER_TIER_TEST = (sql) =>
  sql.startsWith("SELECT role AS role,") && sql.includes("FROM gc_server_members WHERE server_id = ?");

const FILTER_ROLE_ROWS_TEST = (sql) => sql.startsWith("SELECT role_id FROM gc_member_roles WHERE server_id = ?");

const RULES_READ_TEST = (sql) => sql.startsWith("SELECT id, server_id, name, terms,") &&
  sql.includes("FROM gc_filter_rules WHERE server_id = ?");

const ALERT_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO gc_filter_alerts");

const ALERT_PRUNE_TEST = (sql) => sql.startsWith("DELETE FROM gc_filter_alerts");

const MOD_TIMEOUT_TEST = (sql) =>
  sql === timeoutAsOwnerSql();

const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");

const MESSAGE_RESELECT_TEST = (sql) =>
  sql.includes("FROM gc_messages m JOIN users u") &&
  sql.includes("ORDER BY m.id DESC LIMIT 1");

// one stored rule row (as the D1 SELECT joins it)
function ruleRow(overrides = {}) {
  return {
    id: 1,
    server_id: SERVER_ID,
    name: "bad words",
    terms: JSON.stringify([{ text: "forbiddenterm", strategy: "contains" }]),
    exempt_role_ids: JSON.stringify([]),
    exempt_channel_ids: JSON.stringify([]),
    actions: JSON.stringify(["block"]),
    is_care: 0,
    check_names: 0,
    block_message: null,
    timeout_minutes: null,
    created_by: 1,
    created_at: 90,
    updated_at: 90,
    ...overrides,
  };
}

// a send that passes everything: the reselect answers the stored row
function passingSendRoutes(extraRoutes = []) {
  return [
    {
      test: MESSAGE_RESELECT_TEST,
      run: async () => ({
        meta: { changes: 1, last_row_id: 11 },
        results: [messageRow({ id: 11, body: "hello" })],
      }),
    },
    ...extraRoutes,
  ];
}

beforeEach(() => {
  _resetFilterWordsCacheForTests();
  _resetServerRulesCacheForTests();
});

// --- 1. the term grammar ---------------------------------------------------------

test("parseFilterTerm pins the four match strategies and the regex form", () => {
  assert.deepEqual(parseFilterTerm("dog"), { text: "dog", strategy: "contains" });
  assert.deepEqual(parseFilterTerm("cat*"), { text: "cat*", strategy: "prefix" });
  assert.deepEqual(parseFilterTerm("*cat"), { text: "*cat", strategy: "suffix" });
  assert.deepEqual(parseFilterTerm("*cat*"), { text: "*cat*", strategy: "anywhere" });
  // The *mid*dle spanning form (an interior star, no end stars).
  assert.deepEqual(parseFilterTerm("mid*dle"), { text: "mid*dle", strategy: "anywhere" });
  assert.deepEqual(parseFilterTerm("/ba\\s?d/i"), {
    text: "/ba\\s?d/i",
    strategy: "regex",
  });
  assert.throws(() => parseFilterTerm("*"), (error) => error.status === 400);
  assert.equal(parseFilterTerm("   "), null);
});

test("a regex term that does not compile is rejected with a clear error at SAVE time", () => {
  assert.throws(
    () => parseFilterTerm("/([unclosed/"),
    (error) => error instanceof HttpError &&
      error.status === 400 &&
      /compile/.test(error.message),
  );
  assert.throws(
    () => parseFilterTerm("/x(?:a+)+y/"),
    (error) => error instanceof HttpError && /catastrophic/.test(error.message),
  );
});

test("ruleMatchesText: contains, prefix, suffix, anywhere, spanning, and regex", () => {
  const contains = { terms: [{ text: "dog", strategy: "contains" }] };
  const prefix = { terms: [{ text: "cat*", strategy: "prefix" }] };
  const suffix = { terms: [{ text: "*cat", strategy: "suffix" }] };
  const anywhere = { terms: [{ text: "*cat*", strategy: "anywhere" }] };
  const spanning = { terms: [{ text: "mid*dle", strategy: "anywhere" }] };
  const regex = { terms: [{ text: "/e.?mail/", strategy: "regex" }] };

  assert.ok(ruleMatchesText(contains, "I love my DOG here"));
  assert.ok(ruleMatchesText(contains, "doghouse"));
  assert.ok(ruleMatchesText(prefix, "the catalogue"));
  assert.ok(!ruleMatchesText(prefix, "bobcat")); // starts-with only
  assert.ok(ruleMatchesText(suffix, "wild bobcat"));
  assert.ok(!ruleMatchesText(suffix, "catapult")); // ends-with only
  assert.ok(ruleMatchesText(anywhere, "bobcatting"));
  assert.ok(ruleMatchesText(spanning, "the middle one"));
  assert.ok(!ruleMatchesText(spanning, "mid the dle")); // one-token span
  assert.ok(ruleMatchesText(regex, "send me an EMAIL"));
  assert.ok(!ruleMatchesText(regex, "no contact here"));
  assert.ok(!ruleMatchesText(contains, "nothing here"));
});

test("ruleMatchesText never throws on a runtime-broken stored pattern", () => {
  const broken = {
    terms: [{ text: "/(?/", strategy: "regex" }, { text: "dog", strategy: "contains" }],
  };
  // The inert pattern degrades; the OTHER terms keep matching.
  assert.ok(ruleMatchesText(broken, "a dog"));
  assert.ok(!ruleMatchesText(broken, "nothing"));
});

test("termsFromBody enforces the server's term and regex caps", () => {
  const many = Array.from({ length: FILTER_RULE_MAX_TERMS + 1 }, (_, i) => "word" + i);
  assert.throws(() => termsFromBody(many), (error) => error.status === 400);
  const capped = Array.from({ length: FILTER_RULE_MAX_TERMS }, (_, i) => "word" + i);
  assert.equal(termsFromBody(capped).length, FILTER_RULE_MAX_TERMS);

  const regexes = Array.from(
    { length: FILTER_RULE_MAX_PATTERNS + 1 },
    (_, i) => "/w\\d+" + "x".repeat(i) + "/",
  );
  assert.throws(
    () => termsFromBody(regexes),
    (error) => error.status === 400 && /regex terms/.test(error.message),
  );
  assert.throws(() => termsFromBody([]), (error) => error.status === 400);
  // A dedup: the same term twice stores once.
  assert.equal(termsFromBody("dog\ndog").length, 1);
});

test("the W-B1.5 widenings ride their cited rows, and the exempt caps guard the rule edit path", () => {
  // docs/parity-limits.md, AutoMod row (verified 2026-11-17).
  assert.equal(FILTER_RULE_MAX_TERMS, 1000, "1000 terms per keyword rule");
  assert.equal(FILTER_RULE_TERM_CHARACTERS, 60, "60 chars per term");
  assert.equal(FILTER_RULE_PATTERN_CHARACTERS, 260, "the regex bound moved 75 → 260");
  assert.equal(FILTER_RULE_MAX_RULES, 10, "10 rules per server (was 8)");
  assert.equal(FILTER_RULE_EXEMPT_ROLES_MAX, 20, "the NEW exempt role cap");
  assert.equal(FILTER_RULE_EXEMPT_CHANNELS_MAX, 50, "the NEW exempt channel cap");
  // The caps ride the edit path's guarded write: both the create and the
  // update call validExemptIds with the parity cap BEFORE the membership
  // read, so an oversized list never spends a query.
  const SERVERS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api", "servers.mjs"), "utf8");
  const capNeedle = (call) => SERVERS.split(call).length - 1;
  assert.equal(capNeedle("FILTER_RULE_EXEMPT_ROLES_MAX);"), 2,
    "both rule-edit sites (create + update) pass the role cap (the import line names it bare)");
  assert.equal(capNeedle("FILTER_RULE_EXEMPT_CHANNELS_MAX);"), 2,
    "both rule-edit sites pass the channel cap");
  const helper = SERVERS.slice(SERVERS.indexOf("async function validExemptIds"));
  assert.match(helper, /requested\.length > cap\)\s*\{\s*throw new HttpError\(400, "That list is too long[^"]*"/,
    "the length guard rides inside the helper, ahead of the DB read");
});

// --- 2. the evaluation -----------------------------------------------------------

function keywordRule(overrides = {}) {
  return {
    id: 1,
    name: "swears",
    isCare: false,
    checkNames: false,
    terms: [{ text: "zorp", strategy: "contains" }],
    exemptRoleIds: [],
    exemptChannelIds: [],
    actions: ["block"],
    blockMessage: null,
    timeoutMinutes: 10,
    ...overrides,
  };
}

const BASE_CONTEXT = { channelId: CHANNEL_ID, memberRoleIds: [], isMemberModeratorTier: false };

test("evaluateServerRules: keyword block, the block-message copy, and the block default", () => {
  const outcome = evaluateServerRules([keywordRule()], "hi zorp there", BASE_CONTEXT);
  assert.equal(outcome.kind, "blocked");
  assert.equal(outcome.matched, "zorp");

  const custom = evaluateServerRules(
    [keywordRule({ blockMessage: "That word is not allowed  in this server." })],
    "zorp",
    BASE_CONTEXT,
  );
  assert.equal(custom.kind, "blocked");

  // actions: [] reads as [block] — a keyword rule with no actions still acts.
  const defaulting = evaluateServerRules([keywordRule({ actions: [] })], "zorp", BASE_CONTEXT);
  assert.equal(defaulting.kind, "blocked");

  // actions: [alert] (or [alert, timeout]) does NOT block — the message stores.
  const alertOnly = evaluateServerRules(
    [keywordRule({ actions: ["alert", "timeout"] })], "zorp", BASE_CONTEXT,
  );
  assert.equal(alertOnly.kind, "acted");

  assert.equal(evaluateServerRules([keywordRule()], "all clean", BASE_CONTEXT).kind, "none");
});

test("evaluateServerRules: the structural exemptions (moderator tier, role, channel)", () => {
  const moderator = evaluateServerRules(
    [keywordRule()], "zorp", { ...BASE_CONTEXT, isMemberModeratorTier: true },
  );
  assert.equal(moderator.kind, "none");

  const roleExempt = evaluateServerRules(
    [keywordRule({ exemptRoleIds: [5] })], "zorp", { ...BASE_CONTEXT, memberRoleIds: [5, 9] },
  );
  assert.equal(roleExempt.kind, "none");

  const channelExempt = evaluateServerRules(
    [keywordRule({ exemptChannelIds: [CHANNEL_ID] })], "zorp", BASE_CONTEXT,
  );
  assert.equal(channelExempt.kind, "none");
});

test("evaluateServerRules: CARE never blocks and only carries the notice — nothing else fires", () => {
  const care = keywordRule({
    isCare: true,
    terms: [{ text: "lost", strategy: "contains" }],
    // Even a stored actions array is IGNORED on a care rule (care never acts).
    actions: ["block", "timeout"],
    timeoutMinutes: 10080,
  });
  const hit = evaluateServerRules(
    [care, keywordRule()], "i am lost and hurt", BASE_CONTEXT,
  );
  assert.equal(hit.kind, "care");
  assert.match(hit.careNotice, /findahelpline\.com/);
  assert.match(hit.careNotice, /You matter/);

  // The rule's own copy (blockMessage) rides as the care copy when written.
  const personal = evaluateServerRules(
    [keywordRule({ isCare: true, actions: [], blockMessage: "Here for you.",
      terms: [{ text: "lost", strategy: "contains" }] })],
    "i am lost", BASE_CONTEXT,
  );
  assert.equal(personal.kind, "care");
  assert.equal(personal.careNotice, "Here for you.");

  // An empty-channel care miss leaves the keyword rule in charge.
  const bothMiss = evaluateServerRules([care], "plain talk", BASE_CONTEXT);
  assert.equal(bothMiss.kind, "none");
});

test("care exemptions and the care-first ordering over keyword rules", () => {
  const care = keywordRule({
    isCare: true,
    actions: [],
    terms: [{ text: "heavy words", strategy: "contains" }],
    exemptChannelIds: [9], // exempt on channel 9 ONLY
  });
  const keyword = keywordRule({ terms: [{ text: "heavy", strategy: "contains" }] });

  // On the care rule's exempt channel the care layer is silent and the
  // keyword rule answers.
  const onExemptChannel = evaluateServerRules(
    [care, keyword], "heavy words", { ...BASE_CONTEXT, channelId: 9 },
  );
  assert.equal(onExemptChannel.kind, "blocked");

  // Elsewhere the care rule answers and never blocks.
  const elsewhere = evaluateServerRules(
    [care, keyword], "heavy words", { ...BASE_CONTEXT, channelId: BASE_CONTEXT.channelId },
  );
  assert.equal(elsewhere.kind, "care");
});

test("nameRuleHit screens only the check_names rows and never the care class", () => {
  const rules = [
    keywordRule({ checkNames: true, terms: [{ text: "badsurname", strategy: "contains" }] }),
    keywordRule({ terms: [{ text: "otherword", strategy: "contains" }] }),
    keywordRule({ isCare: true, terms: [{ text: "heavy", strategy: "contains" }] }),
  ];
  assert.ok(nameRuleHit(rules, "call me badSurname"));
  assert.ok(!nameRuleHit(rules, "fine name"));
  assert.ok(!nameRuleHit(rules, "the otherword name")); // message-only rule's term
  assert.ok(!nameRuleHit(rules, "heavy")); // care is message machinery, never names
});

// --- 3. the send path ------------------------------------------------------------

async function sendWithRules(rules, extraRoutes = [], bodyText = "hello", tier = null) {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: SERVER_ID, kind: "text" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => ({ server_id: SERVER_ID }) },
    { test: RULES_READ_TEST, all: async () => ({ results: rules }) },
    { test: FILTER_TIER_TEST, first: async () => tier },
    { test: FILTER_ROLE_ROWS_TEST, all: async () => ({ results: [] }) },
    ...passingSendRoutes(extraRoutes),
  ]);
  const response = await dispatchMessages(
    jsonRequest("POST", `/api/channels/${CHANNEL_ID}/messages`, { body: bodyText }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  return { db, response, status: response.status, body: await bodyOf(response) };
}

test("a keyword rule blocks the send, logs the alert (no message id, capped preview) BEFORE the throw", async () => {
  const rule = ruleRow({ name: "swears" });
  const { db, status, body } = await sendWithRules(
    [rule],
    [],
    "a wild forbiddenterm appears",
  );

  assert.equal(status, 400);
  assert.deepEqual(body, { error: "That message isn't allowed." });
  // The message INSERT never ran: the ONLY write is the alert + prune batch.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const [alertInsert, alertPrune] = batch.statements.map((statement) => statement.sql);
  assert.match(alertInsert, /^INSERT INTO gc_filter_alerts/);
  assert.match(alertPrune, /ORDER BY id DESC LIMIT 200/);
  const [alertBound] = batch.statements.map((statement) => statement.bound);
  // server, channel, message_id (NULL — nothing was stored), user, rule...
  assert.deepEqual(alertBound.slice(0, 3), [SERVER_ID, CHANNEL_ID, null]);
  assert.equal(alertBound[3], USER_ID);
  assert.equal(alertBound[5], rule.name);
  assert.equal(alertBound[6], "forbiddenterm");
  // The body preview lands capped.
  assert.equal(alertBound[7], "a wild forbiddenterm appears");
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
});

test("a rule's own block message is the member's 400 copy", async () => {
  const { status, body } = await sendWithRules(
    [ruleRow({
      terms: JSON.stringify([{ text: "forbiddenterm", strategy: "contains" }]),
      block_message: "Watch the language, please.",
    })],
    [],
    "forbiddenterm in here",
  );
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "Watch the language, please." });
});

test("an alert-only rule lets the send through and links the alert to the stored row", async () => {
  const { db, status, body } = await sendWithRules(
    [ruleRow({ actions: JSON.stringify(["alert"]) })],
    [],
    "forbiddenterm in here",
  );
  assert.equal(status, 201);
  assert.equal(body.careNotice, undefined);
  // The post-insert batch: the alert rides the message id and the feed trim.
  const batch = db.calls.find(
    (call) => call.call === "batch" &&
      call.statements.some((statement) => statement.sql.startsWith("INSERT INTO gc_filter_alerts")),
  );
  assert.ok(batch);
  assert.equal(batch.statements[0].bound[2], 11); // the stored message's id
  assert.equal(batch.statements[0].bound[7], null); // no preview: the row IS stored
});

test("the timeout action writes gc_server_members.timed_out_until AS THE OWNER (no hierarchy guard)", async () => {
  const { db, status } = await sendWithRules(
    [ruleRow({ actions: JSON.stringify(["timeout"]) })],
    [],
    "forbiddenterm in here",
  );
  assert.equal(status, 201);
  const timeout = db.calls.find(
    (call) => call.call === "run" && call.sql.startsWith("UPDATE gc_server_members SET timed_out_until"),
  );
  assert.ok(timeout);
  // The guard is the owner-immunity rider and NOTHING follows it: no actor
  // hierarchy for the automated actor (the filed item).
  assert.match(timeout.sql, /AND role <> 'owner'$/);
  assert.deepEqual(timeout.bound.slice(1), [SERVER_ID, USER_ID]);
  // The rule's default duration is the mod desk's own 10-minute choice.
  const until = timeout.bound[0];
  const drift = until - nowSeconds();
  assert.ok(drift >= 599 && drift <= 601, "the default 10 minutes ride the timeout (drift " + drift + ")");
});

test("a care hit stores the message untouched, answers careNotice inline, and writes NOTHING", async () => {
  const { db, status, body } = await sendWithRules(
    [ruleRow({
      is_care: 1,
      actions: JSON.stringify([]),
      terms: JSON.stringify([{ text: "i am lost", strategy: "contains" }]),
    })],
    [],
    "i am lost right now",
  );
  assert.equal(status, 201);
  assert.equal(body.message.body, "hello"); // the stored row, untouched (verbatim send)
  assert.match(body.careNotice, /findahelpline\.com/);
  assert.ok(body.careNotice.includes(CARE_HELPLINE_URL));
  // Zero FILTER writes: no alert row, no prune, no timeout — detection logs
  // and notifies nothing beyond the message already stored. The one extra
  // post-send write in the merged tree is the coins grant (0011 — the same
  // legitimate standalone write every fresh send earns, never a care write).
  const postSendWrites = db.calls.filter((call) => call.call === "batch" || call.call === "run");
  assert.equal(postSendWrites.length, 2);
  assert.ok(
    postSendWrites.some((call) => /gc_coin_ledger/.test(call.sql)),
    "the only non-send write is the coin grant's ledger INSERT",
  );
  assert.ok(!JSON.stringify(body.message).includes("careNotice"));
});

test("the care notice is NOT a block when a keyword rule would also have fired — care wins", async () => {
  const { status, body } = await sendWithRules(
    [
      ruleRow({ id: 1, is_care: 1, actions: JSON.stringify([]), terms: JSON.stringify([{ text: "lost", strategy: "contains" }]) }),
      ruleRow({ id: 2, name: "swears", terms: JSON.stringify([{ text: "hello", strategy: "contains" }]) }),
    ],
    [],
    "hello, i am lost",
  );
  // The care rule answers FIRST and never blocks: no 400 anywhere.
  assert.equal(status, 201);
  assert.ok(!body.careNotice ? false : body.careNotice.length > 0);
  assert.match(body.careNotice, /findahelpline\.com/);
});

test("an exempt-channel rule skips its channel (and only its channel)", async () => {
  const { status } = await sendWithRules(
    [ruleRow({ exempt_channel_ids: JSON.stringify([CHANNEL_ID]) })],
    [],
    "forbiddenterm in here",
  );
  assert.equal(status, 201);
});

test("a KICK_MEMBERS holder is structurally exempt from every keyword rule", async () => {
  const { status } = await sendWithRules(
    [ruleRow()],
    [],
    "forbiddenterm in here",
    { role: "member", permissions: KICK_BIT },
  );
  assert.equal(status, 201);
});

test("a server whose rules query answers nothing sends exactly as before (no rule reads past the window)", async () => {
  const { status, body } = await sendWithRules([], [], "any body");
  assert.equal(status, 201);
  assert.equal(body.message.body, "hello");
  assert.equal(body.careNotice, undefined);
});

test("a DM channel never reads the per-server rules", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    { test: CHANNEL_ACCESS_TEST, first: async () => ({ id: CHANNEL_ID, server_id: null, kind: "text" }) },
    { test: CHANNEL_SERVER_TEST, first: async () => null },
    { test: RULES_READ_TEST, all: async () => ({ results: [ruleRow()] }) },
    { test: FILTER_TIER_TEST, first: async () => null },
    { test: FILTER_ROLE_ROWS_TEST, all: async () => ({ results: [] }) },
    ...passingSendRoutes(),
  ]);
  const response = await dispatchMessages(
    jsonRequest("POST", `/api/channels/${CHANNEL_ID}/messages`, { body: "hello" }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(
    db.calls.filter((call) => RULES_READ_TEST(call.sql)),
    [],
  );
});

// --- 4. the routes ---------------------------------------------------------------

test("the rules GET reads only the viewer class's server rules", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.startsWith("SELECT id, server_id, name, terms,") && sql.includes("ORDER BY id"),
      all: async () => ({ results: [ruleRow()] }),
    },
  ]);
  const response = await dispatchServers(
    jsonRequest("GET", "/api/servers/1/filter/rules", undefined, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const { rules } = await bodyOf(response);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].terms, ruleRow().terms ? JSON.parse(ruleRow().terms) : []);
  assert.deepEqual(rules[0].actions, ["block"]);
  const read = db.calls.find((call) => RULES_READ_TEST(call.sql) || (call.sql.includes("ORDER BY id") && call.sql.includes("gc_filter_rules")));
  assert.ok(read);
  // The guard rides the WHERE: the members-desk viewer class, never a JS check.
  assert.match(read.sql, /fg\.role IN \('owner','moderator'\)/);
});

test("a rule create is a guarded INSERT ... SELECT: class 201, outsider 403, cap 400", async () => {
  const { row, headers } = await sessionFixtures();
  const payload = {
    name: "swears",
    terms: "forbiddenterm\nbadpfx*\n/rx\\s?p?attern/",
    actions: ["block", "alert"],
    blockMessage: "That isn't allowed here.",
  };

  // Authorized: the INSERT's guard rides the viewer class inside the SQL.
  let storedRule = null;
  const okDb = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.includes("INSERT INTO gc_filter_rules"),
      run: async (bound) => {
        storedRule = {
          actions: bound[5],
          terms: bound[2],
        };
        return { meta: { changes: 1, last_row_id: 9 } };
      },
    },
    {
      test: (sql) => sql.includes("FROM gc_filter_rules") && sql.includes("WHERE server_id = ? AND id = ? LIMIT 1"),
      first: async () => {
        if (!storedRule) return null;
        return ruleRow({
          id: 9,
          block_message: "That isn't allowed here.",
          terms: storedRule.terms,
          actions: storedRule.actions,
        });
      },
    },
  ]);
  const okResponse = await dispatchServers(
    jsonRequest("POST", "/api/servers/1/filter/rules", payload, headers),
    envWithLimiters({ GOOBER_DB: okDb }),
  );
  assert.equal(okResponse.status, 201);
  const created = (await bodyOf(okResponse)).rule;
  assert.equal(created.id, 9);
  assert.deepEqual(created.actions, ["block", "alert"]);
  const insertCall = okDb.calls.find((call) => call.call === "run" && call.sql.includes("INSERT INTO gc_filter_rules"));
  assert.match(insertCall.sql, /WHERE EXISTS \(SELECT 1 FROM gc_servers fs WHERE fs\.id = \?\) AND \(EXISTS \(SELECT 1 FROM gc_server_members fg/);
  // The guard carries both halves of the members-desk viewer class: the
  // string tier AND the role bit — in the H1 (RBAC audit) per-bit EXISTS form
  // (exact OR; SUM carried 2×KICK's neighbors into phantom higher bits).
  assert.match(insertCall.sql, /gc_member_roles gbm4 JOIN gc_roles gbr4/);
  assert.match(insertCall.sql, /\(gbr4\.permissions & 4\) <> 0/);
  const guardBinds = insertCall.bound.slice(13);
  assert.deepEqual(
    guardBinds.slice(0, 6),
    [SERVER_ID, SERVER_ID, USER_ID, SERVER_ID, USER_ID, SERVER_ID],
  );
  // The cap moved to the parity row (0027 wave): 10.
  assert.match(insertCall.sql, /\(SELECT COUNT\(\*\) FROM gc_filter_rules fc WHERE fc\.server_id = \?\) < 10/);
  // The regex term arrives as a stored regex, compiled (never as inert text):
  const storedTerms = JSON.parse(insertCall.bound[2]);
  assert.deepEqual(
    storedTerms.map((term) => term.strategy),
    ["contains", "prefix", "regex"],
  );

  // Forbidden: zero changes → the 403 (the diagnostic read answers nothing
  // about cap when the count is under the ceiling).
  const forbiddenDb = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.includes("INSERT INTO gc_filter_rules"),
      run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
    },
    {
      test: (sql) => sql.includes("COUNT(*) AS count FROM gc_filter_rules"),
      first: async () => ({ count: 2 }),
    },
  ]);
  const forbidden = await dispatchServers(
    jsonRequest("POST", "/api/servers/1/filter/rules", payload, headers),
    envWithLimiters({ GOOBER_DB: forbiddenDb }),
  );
  assert.equal(forbidden.status, 403);

  // At the cap: the diagnostic picks 400 (the create's one second class).
  // The cap rides the parity row (0027 wave): the diagnostic's read must
  // answer the ceiling's own value.
  const cappedDb = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.includes("INSERT INTO gc_filter_rules"),
      run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
    },
    {
      test: (sql) => sql.includes("COUNT(*) AS count FROM gc_filter_rules"),
      first: async () => ({ count: FILTER_RULE_MAX_RULES }),
    },
  ]);
  const capped = await dispatchServers(
    jsonRequest("POST", "/api/servers/1/filter/rules", payload, headers),
    envWithLimiters({ GOOBER_DB: cappedDb }),
  );
  assert.equal(capped.status, 400);
});

test("an invalid regex term fails the create with 400 and never binds an INSERT", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatchServers(
    jsonRequest("POST", "/api/servers/1/filter/rules", {
      name: "broken",
      terms: "/([unclosed/",
    }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /compile/);
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
});

test("foreign exempt ids are refused before any write", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.startsWith("SELECT id FROM gc_roles WHERE server_id = ?") &&
        sql.includes("FROM gc_roles"),
      all: async () => ({ results: [{ id: 4 }] }),
    },
  ]);
  const response = await dispatchServers(
    jsonRequest("POST", "/api/servers/1/filter/rules", {
      name: "exempting",
      terms: "forbiddenterm",
      exemptRoleIds: [99],
    }, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /exemptRoleIds/);
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
});

test("the update and delete are guarded UPDATE/DELETE with the same viewer class", async () => {
  const { row, headers } = await sessionFixtures();
  const refused = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.startsWith("UPDATE gc_filter_rules"),
      run: async () => ({ meta: { changes: 0 } }),
    },
  ]);
  const update = await dispatchServers(
    jsonRequest("PUT", "/api/servers/1/filter/rules/3", { name: "x", terms: "t" }, headers),
    envWithLimiters({ GOOBER_DB: refused }),
  );
  assert.equal(update.status, 403);

  const deleted = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_filter_rules"),
      run: async () => ({ meta: { changes: 1 } }),
    },
  ]);
  const remove = await dispatchServers(
    jsonRequest("DELETE", "/api/servers/1/filter/rules/3", undefined, headers),
    envWithLimiters({ GOOBER_DB: deleted }),
  );
  assert.equal(remove.status, 200);
  assert.deepEqual(await bodyOf(remove), { deleted: true, serverId: 1, id: 3 });
  assert.match(
    deleted.calls.find((call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_filter_rules")).sql,
    /AND \(EXISTS \(SELECT 1 FROM gc_server_members fg/,
  );
});

test("the alerts feed reads the viewer class's newest alerts with the usernames", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    sessionRoute(row),
    {
      test: (sql) => sql.includes("FROM gc_filter_alerts ga JOIN users gu"),
      all: async () => ({
        results: [{
          id: 4, server_id: 1, channel_id: 3, message_id: null, user_id: 22,
          rule_id: 1, rule_name: "swears", matched: "term", body: "the body", created_at: 100 + nowSeconds(),
          username: "spammer",
        }],
      }),
    },
  ]);
  const response = await dispatchServers(
    jsonRequest("GET", "/api/servers/1/filter/alerts?limit=100", undefined, headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const { alerts } = await bodyOf(response);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].username, "spammer");
  assert.equal(alerts[0].messageId, null);
  assert.equal(alerts[0].createdAt, new Date((100 + nowSeconds()) * 1000).toISOString());
  assert.match(
    db.calls.find((call) => call.sql.includes("gc_filter_alerts")).sql,
    /fg\.role IN \('owner','moderator'\)/,
  );
});

// --- 5. the nickname screen ------------------------------------------------------

const SELF_NICK_UPDATE_TEST = (sql) =>
  sql.includes("UPDATE gc_server_members SET nickname = ? WHERE server_id = ? AND user_id = ?");

// One fixture pair shared by every nickname case in a test: the session row
// the routes read IS the CSRF the request carries.
async function nicknameDb(routes) {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), ...routes]);
  const send = (nickname) =>
    dispatchServers(
      jsonRequest("PATCH", "/api/servers/1/nick", { nickname }, headers),
      envWithLimiters({ GOOBER_DB: db }),
    );
  return { db, send };
}

const NICK_RULES_TEST = (sql) => sql.includes("FROM gc_filter_rules WHERE server_id = ?");

test("a name-class rule blocks the self nickname with the shared 400", async () => {
  const { db, send } = await nicknameDb([
    {
      test: NICK_RULES_TEST,
      all: async () => ({ results: [ruleRow({ check_names: 1, terms: JSON.stringify([{ text: "badnick", strategy: "contains" }]) })] }),
    },
  ]);
  const response = await send("call me badnick");
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: FILTERED_NAME_ERROR });
  // The write never ran and no hit anywhere.
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
});

test("the global word list screens nicknames too, and a clean nickname still stores", async () => {
  const { send } = await nicknameDb([
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "globalbadword", updated_at: 1 }) },
    { test: NICK_RULES_TEST, all: async () => ({ results: [] }) },
  ]);
  const blocked = await send("globalbadword");
  assert.equal(blocked.status, 400);
  assert.deepEqual(await bodyOf(blocked), { error: FILTERED_NAME_ERROR });

  const { db, send: sendOk } = await nicknameDb([
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "globalbadword", updated_at: 1 }) },
    { test: NICK_RULES_TEST, all: async () => ({ results: [] }) },
    { test: SELF_NICK_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const ok = await sendOk("fine nickname");
  assert.equal(ok.status, 200);
});

test("clearing a nickname (null) screens nothing", async () => {
  const { db, send } = await nicknameDb([
    { test: NICK_RULES_TEST, all: async () => ({ results: [ruleRow({ check_names: 1 })] }) },
    { test: SELF_NICK_UPDATE_TEST, run: async () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await send(null);
  assert.equal(response.status, 200);
  // The UPDATE is the only call past the session, and the rules table was
  // never even read (a clear screens nothing).
  const runs = db.calls.filter((call) => call.call === "run");
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /UPDATE gc_server_members SET nickname/);
  assert.ok(db.calls.filter((call) => NICK_RULES_TEST(call.sql)).length === 0);
});

// --- 6. the Care class's WS delivery --------------------------------------------

function fakeCtx() {
  const accepted = [];
  return {
    accepted,
    acceptWebSocket(ws) { accepted.push(ws); },
    getWebSockets() { return accepted.slice(); },
  };
}

// The M3 (RBAC audit) fan-in door's own reads, for the DO tests: the channel
// shape and the member EXISTS (plain `SELECT 1`).
const FANIN_CHANNEL_DOOR_TEST = (sql) =>
  sql.includes("SELECT id, server_id, kind FROM gc_channels WHERE id = ? LIMIT 1");
const FANIN_MEMBER_DOOR_TEST = (sql) =>
  sql.includes("SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");

function makeRoom(env) {
  const ctx = fakeCtx();
  return { room: new ChatRoom(ctx, env), ctx };
}

async function connect(room, ctx, userId, username) {
  const request = new Request(
    "https://chat.internal/api/ws?channel=" + CHANNEL_ID + "&userId=" + userId +
      "&username=" + encodeURIComponent(username) + "&channelKind=text",
    { headers: { Upgrade: "websocket" } },
  );
  const response = await room.fetch(request);
  assert.equal(response.status, 101);
  return ctx.accepted[ctx.accepted.length - 1];
}

test("the care notice reaches the AUTHOR as its own WS frame, and no one else's socket", async () => {
  const notice = "You matter. " + CARE_HELPLINE_URL;
  const env = {
    GOOBER_DB: fakeDb([
      { test: FANIN_CHANNEL_DOOR_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 3, kind: "text" }) },
      { test: FANIN_MEMBER_DOOR_TEST, first: async () => ({ 1: 1 }) },
    ]),
    __sendMessageToChannel: async () => ({
      message: { id: 42, authorId: 1, authorName: "alice", body: "x", editedAt: null, source: null, attachmentIds: [] },
      created: true,
      careNotice: notice,
    }),
  };
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, 1, "alice");
  const bob = await connect(room, ctx, 2, "bob");
  alice.sent.length = 0;
  bob.sent.length = 0;

  await room.webSocketMessage(
    alice,
    JSON.stringify({ type: "msg", clientMessageId: "care-notic1", body: "x" }),
  );

  const aliceFrames = alice.sent.map((frame) => JSON.parse(frame));
  assert.ok(aliceFrames.some((frame) => frame.type === "care_notice" && frame.body === notice));
  assert.deepEqual(bob.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "care_notice"), []);
});

test("a send without a care notice sends no care frame", async () => {
  const env = {
    GOOBER_DB: fakeDb([
      { test: FANIN_CHANNEL_DOOR_TEST, first: async () => ({ id: CHANNEL_ID, server_id: 3, kind: "text" }) },
      { test: FANIN_MEMBER_DOOR_TEST, first: async () => ({ 1: 1 }) },
    ]),
    __sendMessageToChannel: async () => ({
      message: { id: 42, authorId: 1, authorName: "alice", body: "x", editedAt: null, source: null, attachmentIds: [] },
      created: true,
      careNotice: null,
    }),
  };
  const { room, ctx } = makeRoom(env);
  const alice = await connect(room, ctx, 1, "alice");
  alice.sent.length = 0;
  await room.webSocketMessage(
    alice,
    JSON.stringify({ type: "msg", clientMessageId: "care-notic2", body: "x" }),
  );
  assert.ok(!alice.sent.some((frame) => JSON.parse(frame).type === "care_notice"));
});

// --- 7. the schema applies cleanly with the earlier migrations -------------------
// (The static scoping pin rides tests/migration-scoping-0010.test.mjs, per
// the 0004/0006/0007/0008 convention; the real-SQLite independence check, and
// the alerts pruner's own SQL shape, live here.)

test("0010 applies after 0001/0002 alone (independence) in a real SQLite engine", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(path.join(here, "..", "migrations", "0001_initial_goobercord.sql"), "utf8"));
    db.exec(readFileSync(path.join(here, "..", "migrations", "0002_vendored_core_tables.sql"), "utf8"));
    db.exec(readFileSync(path.join(here, "..", "migrations", "0010_filter_upgrades.sql"), "utf8"));
    // The two tables exist, are empty, and the alerts feed accepts a row.
    db.exec(
      "INSERT INTO users (id, username, username_key, password_salt, password_hash, created_at) " +
        "VALUES (7, 'wempos', 'wempos', 'salt', 'hash', 1)",
    );
    db.exec("INSERT INTO gc_servers (id, name, owner_user_id, created_at) VALUES (1, 'Test Server', 7, 1)");
    db.exec("INSERT INTO gc_channels (id, server_id, name, kind, created_at) VALUES (3, 1, 'general', 'text', 1)");
    db.exec(
      "INSERT INTO gc_filter_rules (id, server_id, name, terms, actions, created_at, updated_at) " +
        "VALUES (1, 1, 'swears', '[]', '[\"block\"]', 1, 1)",
    );
    db.exec(
      "INSERT INTO gc_filter_alerts (server_id, channel_id, user_id, rule_id, rule_name, created_at) " +
        "VALUES (1, 3, 7, 1, 'swears', 1)",
    );
    const count = db.prepare("SELECT COUNT(*) AS count FROM gc_filter_alerts").get();
    assert.equal(Number(count.count), 1);
    // The pruner keeps the newest 200.
    db.exec(filterAlertPruneSql().replace(/\?/g, "1"));
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM gc_filter_alerts").get().count), 1);
  } finally {
    db.close();
  }
});
