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

// The Wempo Accounts handshake, server half (api/sso.mjs): the ticket-redeem
// route. The pins cover the lane (the ACCOUNTS_WORKER service binding at
// https://sso.internal, the X-Relay-Token header ONLY from env.RELAY_TOKEN),
// the ticket shape (32-byte hex or 400 with no redeem call at all), the
// degraded paths' collapse into ONE shared 401, the login-class gate stack,
// the ban screen, and the minted session's shapes: the /api/me user payload
// and the login route's own Set-Cookie session cookie. The token value is
// asserted BY IDENTITY against the env value it came from and never printed.
import test from "node:test";
import assert from "node:assert/strict";

import { handleSsoRoutes } from "../api/sso.mjs";
import { randomToken } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
// Mixed-case hex on purpose: the redeem must accept it and normalize.
const TICKET = "aB".repeat(32);
const EXPIRED_COPY = "That sign-in link has expired. Sign in again.";
const BANNED_COPY = "This account is currently banned.";
const RELAY_TOKEN = randomToken();
const PASSWORD_PEPPER = "sso-test-forum-pepper-0123456789abcdef";

const USER_KEY_READ_TEST = (sql) => sql.includes("FROM users WHERE username_key = ? LIMIT 1");
const BAN_READ_TEST = (sql) =>
  sql.startsWith("SELECT reason, expires_at FROM bans WHERE user_id = ?");
const PERKS_READ_TEST = (sql) =>
  sql.startsWith("SELECT accent_color, tagline FROM users WHERE id = ? LIMIT 1");
const SESSION_INSERT_TEST = (sql) => sql.startsWith("INSERT INTO sessions");

function request(method, body, headers = {}) {
  return new Request(ORIGIN + "/api/auth/sso/redeem", {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "CF-Connecting-IP": "198.51.100.7",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  try {
    return await handleSsoRoutes(request, env, url, url.pathname, request.method.toUpperCase(), undefined)
      ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
  } catch (caught) {
    // The worker's own error translation (worker.mjs apiError): HttpErrors
    // become their status + payload; anything else is the blanket 500.
    if (caught instanceof HttpError) {
      return json(caught.payload || { error: caught.message }, caught.status, caught.headers);
    }
    throw caught;
  }
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function fakeDb(routes) {
  const calls = [];
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
        const route = routes.find((candidate) => candidate.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        return { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        return { meta: { changes: 1, last_row_id: 1 } };
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

// A fakeDb with limiter bindings, EXCEPT the login limiter which every test
// wires explicitly — that way a test proving the redeem is login-class can
// name GC_LOGIN_RATE_LIMITER without any other limiter answering for it.
function envFor(db, overrides = {}) {
  const env = { GOOBER_DB: db, RELAY_TOKEN, PASSWORD_PEPPER, _networkBanCheck: async () => ({ banned: false, ipHash: "a".repeat(64) }), ...overrides };
  for (const [scope, binding] of Object.entries(RATE_LIMIT_BINDINGS)) {
    if (scope === "login") continue;
    if (!env[binding]) env[binding] = { limit: async () => ({ success: true }) };
  }
  return env;
}

function passingLimiter() {
  return { limit: async ({ key }) => ({ success: true, key }) };
}

// The accounts half, mocked at the binding seam: recording the request GC
// sends and answering per the test's script. script(callIndex) returns
// EITHER an ok-200 body (a JSON string), OR a {status, body} envelope for a
// non-200, OR the sentinel "REJECT" (the unreachable-worker leg).
function accountsBinding(script) {
  const sent = [];
  return {
    sent,
    fetch: async (req) => {
      sent.push({
        url: req.url,
        method: req.method,
        token: req.headers.get("X-Relay-Token"),
        body: JSON.parse(await req.text()),
      });
      const answer = script(sent.length);
      if (answer === "REJECT") throw new Error("binding down");
      const { status, body } = typeof answer === "object" && answer !== null
        ? answer
        : { status: 200, body: answer };
      return new Response(body ?? "", { status: status ?? 200 });
    },
  };
}

const MEMBER_ROW = {
  id: USER_ID,
  username: "wempos",
  username_key: "wempos",
  password_salt: "0".repeat(32),
  password_hash: "0".repeat(64),
  role: "member",
  bio: "",
  avatar_status: null,
  avatar_mime: null,
  avatar_updated_at: null,
  avatar_version: null,
  totp_enabled: 0,
  accent_color: null,
  tagline: null,
};

function userEnv({ accounts, user = MEMBER_ROW, banRow = null, overrides = {} } = {}) {
  const db = fakeDb([
    { test: USER_KEY_READ_TEST, first: async () => user },
    { test: BAN_READ_TEST, first: async () => banRow },
    { test: PERKS_READ_TEST, first: async () => ({ accent_color: null, tagline: null }) },
  ]);
  return { db, env: envFor(db, { ACCOUNTS_WORKER: accounts, GC_LOGIN_RATE_LIMITER: passingLimiter(), ...overrides }) };
}

const TICKET_CALL = (call) =>
  JSON.stringify({
    userId: Number(MEMBER_ROW.id),
    username: MEMBER_ROW.username,
    role: "member",
  });

test("an uppercase-hex ticket is a valid shape and rides lowercased to accounts", async () => {
  const bindingCodes = [];
  const accountsUpper = {
    fetch: async (req) => {
      bindingCodes.push((JSON.parse(await req.text())).code);
      return new Response(JSON.stringify({
        userId: Number(MEMBER_ROW.id),
        username: MEMBER_ROW.username,
        role: "member",
      }), { status: 200 });
    },
  };
  const { env } = userEnv({ accounts: accountsUpper });
  const response = await dispatch(request("POST", { wt: TICKET.toUpperCase() }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(bindingCodes, [TICKET.toLowerCase()], "accounts sees the same hex code");
});
const MISMATCH_CALL = (call) =>
  JSON.stringify({
    userId: Number(USER_ID + 1), // a different member id than the username's row
    username: MEMBER_ROW.username,
    role: "member",
  });

// --- the lane ---------------------------------------------------------------------

test("the redeem rides the service-binding lane and answers the /api/me shape with GC's session cookie", async () => {
  const accounts = accountsBinding(TICKET_CALL);
  const { db, env } = userEnv({ accounts });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 200);

  const sent = accounts.sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].url, "https://sso.internal/api/sso/redeem");
  assert.equal(sent[0].token, env.RELAY_TOKEN, "the token rides ONLY the header, from env");
  assert.deepEqual(sent[0].body, { code: TICKET.toLowerCase() });

  const payload = await bodyOf(response);
  assert.deepEqual(payload.user, {
    id: USER_ID,
    username: "wempos",
    role: "member",
    bio: "",
    avatarStatus: null,
    avatarUrl: null,
    totpEnabled: false,
    accentColor: null,
    tagline: null,
  });
  assert.match(String(payload.csrfToken), /^[A-Za-z0-9_-]+$/);

  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /^goober_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  assert.ok(
    db.calls.some((call) => call.call === "run" && SESSION_INSERT_TEST(call.sql)),
    "the member's own session row is minted",
  );
});

// --- the gate stack ---------------------------------------------------------------

test("same-origin is enforced: a cross-origin redeem is a 403 with no redeem call", async () => {
  const accounts = accountsBinding(TICKET_CALL);
  const { env } = userEnv({ accounts });
  const response = await dispatch(request("POST", { wt: TICKET }, { Origin: "https://elsewhere.example" }), env);
  assert.equal(response.status, 403);
  assert.equal(accounts.sent.length, 0);
});

test("the ticket must be 32-byte hex; anything else is a 400 with NO redeem call", async () => {
  for (const wt of [undefined, null, "", " abc ".repeat(12).trim(), TICKET.slice(1),
    "a".repeat(63) + "g", "0x" + "a".repeat(62), "A".repeat(63)]) {
    const accounts = accountsBinding(TICKET_CALL);
    const { env } = userEnv({ accounts });
    const response = await dispatch(request("POST", { wt }), env);
    assert.equal(response.status, 400, "wt=" + JSON.stringify(wt));
    assert.equal(accounts.sent.length, 0, "a malformed ticket never reaches accounts");
  }
});

test("the redeem rate-limits through GC's OWN login limiter", async () => {
  const accounts = accountsBinding(TICKET_CALL);
  const seen = [];
  const db = fakeDb([{ test: USER_KEY_READ_TEST, first: async () => MEMBER_ROW }]);
  const env = envFor(db, {
    ACCOUNTS_WORKER: accounts,
    GC_LOGIN_RATE_LIMITER: {
      limit: async ({ key }) => {
        seen.push(String(key).length > 0);
        return { success: false };
      },
    },
  });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 429);
  assert.equal(seen.length, 1, "the login limiter answered once");
  assert.equal(accounts.sent.length, 0, "a throttled redeem never reaches accounts");
});

// --- the shared 401 (every degraded path) ------------------------------------------

test("an unconfigured RELAY_TOKEN reports unavailable SSO configuration without redeeming", async () => {
  const accounts = accountsBinding(TICKET_CALL);
  const { env } = userEnv({
    accounts,
    overrides: { RELAY_TOKEN: "", GC_LOGIN_RATE_LIMITER: passingLimiter() },
  });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 503);
  assert.match(await bodyOf(response).then((b) => b.error), /shared RELAY_TOKEN/);
  assert.equal(accounts.sent.length, 0);
});

test("a malformed RELAY_TOKEN is a configuration 503, not an expired-ticket 401", async () => {
  const accounts = accountsBinding(TICKET_CALL);
  const { env } = userEnv({
    accounts,
    overrides: {
      RELAY_TOKEN: "bad\nheader",
      GC_LOGIN_RATE_LIMITER: passingLimiter(),
    },
  });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 503);
  assert.match(await bodyOf(response).then((b) => b.error), /invalid RELAY_TOKEN configuration/);
  assert.equal(accounts.sent.length, 0, "invalid headers must be rejected before contacting Accounts");
});

test("a refuse-status or unparseable answer from accounts all become the one shared 401", async () => {
  const scripts = [
    { status: 401, body: "{\"error\":\"bad token\"}" },      // accounts' own refusal
    { status: 410, body: "{\"error\":\"already redeemed\"}" }, // expired / double-redeemed
    { status: 500, body: "{\"error\":\"boom\"}" },            // accounts sick
    { status: 200, body: "" },                                // unparseable payload
    { status: 200, body: "[]" },                              // non-object payload
  ];
  for (const script of scripts) {
    const accounts = accountsBinding(() => script);
    const { env } = userEnv({ accounts });
    const response = await dispatch(request("POST", { wt: TICKET }), env);
    assert.equal(response.status, 401, JSON.stringify(script));
    assert.equal(await bodyOf(response).then((b) => b.error), EXPIRED_COPY);
    assert.equal(accounts.sent.length, 1, "accounts was asked; GC unified the answer");
  }
});

test("an unreachable accounts worker is the shared 401", async () => {
  const accounts = accountsBinding(() => "REJECT");
  const { env } = userEnv({ accounts });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 401);
  assert.equal(await bodyOf(response).then((b) => b.error), EXPIRED_COPY);
});

test("a well-formed redeem of a member the shared row contradicts is the shared 401 (no mint)", async () => {
  const accounts = accountsBinding(MISMATCH_CALL);
  const { db, env } = userEnv({ accounts });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 401);
  assert.equal(await bodyOf(response).then((b) => b.error), EXPIRED_COPY);
  assert.equal(
    db.calls.filter((call) => call.call === "run" && SESSION_INSERT_TEST(call.sql)).length,
    0,
    "no session is minted for an inconsistent redeem",
  );
});

// --- the ban gates -----------------------------------------------------------------

test("a banned member gets the login ban screen, not a session", async () => {
  const accounts = accountsBinding(TICKET_CALL);
  const { db, env } = userEnv({
    accounts,
    banRow: { reason: "spam", expires_at: null },
  });
  const response = await dispatch(request("POST", { wt: TICKET }), env);
  assert.equal(response.status, 403);
  const payload = await bodyOf(response);
  assert.equal(payload.error, BANNED_COPY);
  assert.equal(payload.banned, true);
  assert.equal(payload.reason, "spam");
  assert.deepEqual(payload.expiresAt, null);
  assert.equal(accounts.sent.length, 1, "the redeem ran; the refusal is GC's gate");
  assert.equal(
    db.calls.some((call) => call.call === "run" && SESSION_INSERT_TEST(call.sql)),
    false,
    "no session row for a banned member",
  );
});
