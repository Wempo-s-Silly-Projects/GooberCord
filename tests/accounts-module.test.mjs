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

// Accounts routes (Phase 1, Task 3): register / login / TOTP second step /
// logout / me / version, driven against the vendored core over a fake GOOBER_DB.
// Everything here is pure SQL over the fake — no real member data, per the
// repo's family-friendly rule. The Turnstile siteverify network call is
// avoided via the env._turnstileVerify override seam (documented in
// api/accounts.mjs).
//
// Control-flow pins mirror the forum's api/session.mjs registration and login
// handlers (network-ban gate → same-origin → per-route rate limit → body →
// credentials → account-ban check → TOTP branch → session mint), with the
// session-less TOTP challenge of the forum's api/twofa.mjs re-pointed at
// GooberCord's own HMAC-signed stateless token (no forum rows written).
import test from "node:test";
import assert from "node:assert/strict";

import { handleAccountRoutes } from "../api/accounts.mjs";
import { hashPassword } from "../api/core/passwords.mjs";
import { generateTotpSecret, totpAt } from "../api/core/totp.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const PEPPER = "goobercord-test-pepper-0123456789abcdef0123456789";

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function postJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "CF-Connecting-IP": "198.51.100.7",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// Test dispatcher: mirrors worker.mjs's apiError mapping so the route module's
// HttpErrors surface as the same JSON responses the worker would return.
async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleAccountRoutes(
      request,
      env,
      url,
      url.pathname,
      request.method.toUpperCase(),
      undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// Every fake limiter accepts (and records) the rateLimit key.
function envWithLimiters(extra = {}) {
  const env = { PASSWORD_PEPPER: PEPPER, _networkBanCheck: async () => ({ banned: false, ipHash: "a".repeat(64) }), ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// Test seam: records the Turnstile action per call instead of hitting
// Cloudflare siteverify. Injected as env._turnstileVerify.
function turnstileSpy() {
  const spy = async (request, env, body, expectedAction) => {
    spy.actions.push(expectedAction);
  };
  spy.actions = [];
  return spy;
}

// Ordered fake DB: the first matching route answers every statement shape.
// Every executed call is recorded so tests can pin which SQL ran (and which
// did not) — the route module's oracle-resistance story lives here.
function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      let bound = [];
      return {
        bind(...values) {
          bound = values;
          return this;
        },
        first: async () => {
          calls.push({ call: "first", sql, bound });
          const route = find(sql);
          return route && route.first ? await route.first(bound) : null;
        },
        all: async () => {
          calls.push({ call: "all", sql, bound });
          const route = find(sql);
          return route && route.all ? await route.all(bound) : { results: [] };
        },
        run: async () => {
          calls.push({ call: "run", sql, bound });
          const route = find(sql);
          return route && route.run ? await route.run(bound) : { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      calls.push({ call: "batch", sql: "batch" });
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

// --- shared fake-route shapes -------------------------------------------------

const NETWORK_BAN_TEST = (sql) => sql.includes("FROM banned_ips") && !sql.includes("INSERT INTO sessions");
const noNetworkBan = { test: NETWORK_BAN_TEST, first: async () => null };
const bannedNetwork = { test: NETWORK_BAN_TEST, first: async () => ({ "1": 1 }) };

const LOGIN_USER_SELECT_TEST = (sql) =>
  sql.includes("FROM users WHERE username_key = ? LIMIT 1");

const ACCOUNT_BAN_TEST = (sql) =>
  sql.includes("SELECT reason, expires_at FROM bans WHERE user_id = ?");
const noAccountBan = { test: ACCOUNT_BAN_TEST, first: async () => null };

const SESSION_INSERT_TEST = (sql) => sql.includes("INSERT INTO sessions");

const TOTP_STATUS_TEST = (sql) =>
  sql.includes("SELECT totp_secret FROM users WHERE id = ?");

const CHALLENGE_KEY_ROW_TEST = (sql) =>
  sql.includes("SELECT username_key, totp_enabled, totp_secret FROM users WHERE id = ?");

const USER_RESELECT_TEST = (sql) =>
  sql.includes("FROM users WHERE id = ? LIMIT 1") &&
  !sql.includes("totp_secret") &&
  !sql.includes("session") &&
  sql.includes("password_salt");

const SESSION_READ_TEST = (sql) =>
  sql.includes("FROM sessions s LEFT JOIN users u");

async function hashFor(password) {
  return hashPassword(password, PEPPER);
}

function userRow(user) {
  return {
    id: user.id ?? 7,
    username: user.username ?? "wempos",
    username_key: (user.username ?? "wempos").toLowerCase(),
    password_salt: user.salt ?? "",
    password_hash: user.hash ?? "",
    role: user.role ?? "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: user.totp_enabled ?? 0,
    totp_secret: user.totp_secret ?? null,
  };
}

// --- handler contract ----------------------------------------------------------

test("unknown API paths fall through to the worker's handler loop", async () => {
  const response = await handleAccountRoutes(
    get("/api/nope"),
    envWithLimiters(),
    new URL(ORIGIN + "/api/nope"),
    "/api/nope",
    "GET",
    undefined,
  );
  assert.equal(response, undefined);
});

// --- GET /api/version -----------------------------------------------------------

test("GET /api/version returns {version, build} from the deployment env", async () => {
  const response = await dispatch(
    get("/api/version"),
    envWithLimiters({ VERSION: "0.1.0", COMMIT_SHA: "7f9fc7f" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { version: "0.1.0", build: "7f9fc7f" });
});

test("GET /api/version falls back to empty strings for unset deployment vars", async () => {
  const response = await dispatch(get("/api/version"), envWithLimiters());
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { version: "", build: "" });
});

// --- POST /api/auth/register ------------------------------------------------

test("register rejects an invalid username with 400 before any Turnstile or user-row work", async () => {
  const turnstile = turnstileSpy();
  const db = fakeDb([]);
  const response = await dispatch(
    postJson("/api/auth/register", { username: "no", password: "long-enough-password" }),
    envWithLimiters({ _networkBanCheck: async () => ({ banned: false, ipHash: "a".repeat(64) }), _turnstileVerify: turnstile, GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "Username must be 3–24 characters and use only letters, numbers, and underscores.",
  });
  assert.deepEqual(turnstile.actions, []);
  // The Forum relay's test seam handles the network gate; no user-row SQL or
  // INSERT is reached for a shape-invalid body.
  assert.deepEqual(
    db.calls.filter((call) => call.sql.includes("FROM users") || call.sql.includes("INSERT INTO users")),
    [],
  );
});

test("register rejects a too-short password with 400 before Turnstile or user-row work", async () => {
  const turnstile = turnstileSpy();
  const db = fakeDb([]);
  const response = await dispatch(
    postJson("/api/auth/register", { username: "wempos", password: "short" }),
    envWithLimiters({ _networkBanCheck: async () => ({ banned: false, ipHash: "a".repeat(64) }), _turnstileVerify: turnstile, GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await bodyOf(response)).error,
    "Password must be 12–128 characters long.",
  );
  assert.deepEqual(turnstile.actions, []);
  assert.deepEqual(
    db.calls.filter((call) => call.sql.includes("FROM users") || call.sql.includes("INSERT INTO users")),
    [],
  );
});

test("register gate-keeps banned networks before Turnstile and any credential work", async () => {
  const turnstile = turnstileSpy();
  const db = fakeDb([bannedNetwork]);
  const response = await dispatch(
    postJson("/api/auth/register", {
      username: "wempos",
      password: "long-enough-password",
      "cf-turnstile-response": "tok",
    }),
    envWithLimiters({ _networkBanCheck: async () => ({ banned: true, ipHash: "a".repeat(64) }), _turnstileVerify: turnstile, GOOBER_DB: db }),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "This network is banned from the forum.");
  // The network gate precedes the human check and all user-row work.
  assert.deepEqual(turnstile.actions, []);
  assert.equal(db.calls.length, 0, "the Forum relay decides the network ban without querying GooberCord's local tables");
});

test("register mints a member user row and an unbanned-gated session", async () => {
  const turnstile = turnstileSpy();
  const db = fakeDb([
    noNetworkBan,
    {
      test: (sql) => sql.includes("INSERT INTO users"),
      run: (bound) => {
        // Column shape of the forum's registration INSERT, member role stored.
        assert.deepEqual(bound.slice(0, 5).slice(-1), ["member"]);
        return { meta: { changes: 1, last_row_id: 7 } };
      },
    },
    { test: USER_RESELECT_TEST, first: async () => userRow({ id: 7 }) },
    {
      test: SESSION_INSERT_TEST,
      run: () => {
        return { meta: { changes: 1 } };
      },
    },
  ]);
  const response = await dispatch(
    postJson("/api/auth/register", {
      username: "wempos",
      password: "long-enough-password",
      "cf-turnstile-response": "tok",
    }),
    envWithLimiters({ _turnstileVerify: turnstile, GOOBER_DB: db }),
  );
  assert.equal(response.status, 201);
  const body = await bodyOf(response);
  assert.equal(body.user.id, 7);
  assert.equal(body.user.username, "wempos");
  assert.equal(body.user.role, "member");
  assert.equal(body.user.avatarUrl, null);
  assert.equal(typeof body.csrfToken, "string");
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^goober_session=[A-Za-z0-9_-]+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.deepEqual(turnstile.actions, ["register"]);
  // The username_key binding lowercases the username.
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO users"));
  assert.equal(insert.bound[0], "wempos");
  assert.equal(insert.bound[1], "wempos");
});

test("register returns 409 when the username is already taken", async () => {
  const db = fakeDb([
    noNetworkBan,
    {
      test: (sql) => sql.includes("INSERT INTO users"),
      run: () => {
        throw new Error("UNIQUE constraint failed: users.username_key");
      },
    },
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ id: 3 }) },
  ]);
  const response = await dispatch(
    postJson("/api/auth/register", {
      username: "wempos",
      password: "long-enough-password",
      "cf-turnstile-response": "tok",
    }),
    envWithLimiters({ _turnstileVerify: turnstileSpy(), GOOBER_DB: db }),
  );
  assert.equal(response.status, 409);
  assert.equal((await bodyOf(response)).error, "That username is already taken.");
});

test("register mints no session when the account insert-gate finds an active ban", async () => {
  // createSession(requireUnbanned=true) uses the conditional INSERT ... WHERE
  // NOT EXISTS (active ban); zero changes must surface as 403, no cookie.
  const db = fakeDb([
    noNetworkBan,
    {
      test: (sql) => sql.includes("INSERT INTO users"),
      run: () => ({ meta: { changes: 1, last_row_id: 7 } }),
    },
    { test: USER_RESELECT_TEST, first: async () => userRow({ id: 7 }) },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 0 } }) },
  ]);
  const response = await dispatch(
    postJson("/api/auth/register", {
      username: "wempos",
      password: "long-enough-password",
      "cf-turnstile-response": "tok",
    }),
    envWithLimiters({ _turnstileVerify: turnstileSpy(), GOOBER_DB: db }),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "This account or network is currently banned.");
  assert.equal(response.headers.get("Set-Cookie"), null);
});

// --- POST /api/auth/login ----------------------------------------------------

test("register/login both refuse cross-origin posts (same-origin gate)", async () => {
  const response = await dispatch(
    new Request(ORIGIN + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7" },
      body: JSON.stringify({ username: "wempos", password: "long-enough-password" }),
    }),
    envWithLimiters({ GOOBER_DB: fakeDb([noNetworkBan]) }),
  );
  assert.equal(response.status, 403);
  assert.equal(
    (await bodyOf(response)).error,
    "This request was blocked because its origin could not be verified.",
  );
});

test("login with a wrong password 401s and records zero session inserts", async () => {
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash }) },
    { test: ACCOUNT_BAN_TEST, first: async () => ({ reason: "x", expires_at: null }) },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  stubRelayFetch(async () =>
    new Response(JSON.stringify({ valid: false }), { status: 200 }));
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "not-the-password" }),
    envWithLimiters({ GOOBER_DB: db, RELAY_TOKEN: "r".repeat(64) }),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await bodyOf(response), {
    error: "The username or password is incorrect.",
  });
  // No credential oracle: the ban-check SQL never ran for a failed password…
  assert.equal(db.calls.find((call) => ACCOUNT_BAN_TEST(call.sql)), undefined);
  // …and zero INSERT INTO sessions statements were recorded.
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("login rejects malformed usernames short of the shapers rule with 400", async () => {
  const db = fakeDb([noNetworkBan]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "sp@ce", password: "long-enough-password" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error, "Enter your username and password.");
  // No user lookup for a shape-invalid username.
  assert.equal(db.calls.find((call) => LOGIN_USER_SELECT_TEST(call.sql)), undefined);
});

test("login on an active-banned account 403s the ban screen after verified credentials", async () => {
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash }) },
    {
      test: ACCOUNT_BAN_TEST,
      first: async () => ({ reason: "Family-friendly review", expires_at: 1893456000 }),
    },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), {
    error: "This account is currently banned.",
    banned: true,
    reason: "Family-friendly review",
    expiresAt: 1893456000,
  });
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("login of a 2FA member returns a signed challenge and never mints a session", async () => {
  const secret = generateTotpSecret();
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    noAccountBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash, totp_enabled: 1, totp_secret: secret }) },
    { test: TOTP_STATUS_TEST, first: async () => ({ totp_secret: secret }) },
  ]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.totpRequired, true);
  assert.equal(typeof body.challenge, "string");
  assert.equal(body.user, undefined);
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("TOTP second step mints the session on a verified code", async () => {
  const secret = generateTotpSecret();
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    noAccountBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash, totp_enabled: 1, totp_secret: secret }) },
    { test: TOTP_STATUS_TEST, first: async () => ({ totp_secret: secret }) },
    { test: CHALLENGE_KEY_ROW_TEST, first: async () => ({ username_key: "wempos", totp_enabled: 1, totp_secret: secret }) },
    {
      test: SESSION_INSERT_TEST,
      run: (bound) => {
        // users.id is the session's owner binding.
        assert.equal(bound[1], 7);
        return { meta: { changes: 1 } };
      },
    },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db });
  const login = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    env,
  );
  const { challenge } = await bodyOf(login);
  const code = await totpAt(secret, nowSeconds());
  const response = await dispatch(
    postJson("/api/auth/totp", { challenge, code }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.user.id, 7);
  assert.equal(body.user.totpEnabled, true);
  assert.equal(typeof body.csrfToken, "string");
  assert.match(response.headers.get("Set-Cookie"), /^goober_session=/);
});

test("TOTP second step rejects a wrong code without touching the session table", async () => {
  const secret = generateTotpSecret();
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    noAccountBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash, totp_enabled: 1, totp_secret: secret }) },
    { test: TOTP_STATUS_TEST, first: async () => ({ totp_secret: secret }) },
    { test: CHALLENGE_KEY_ROW_TEST, first: async () => ({ username_key: "wempos", totp_enabled: 1, totp_secret: secret }) },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db });
  const login = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    env,
  );
  const { challenge } = await bodyOf(login);
  const correctCode = await totpAt(secret, nowSeconds());
  const wrongCode = correctCode === "000000" ? "000001" : "000000";
  const response = await dispatch(postJson("/api/auth/totp", { challenge, code: wrongCode }), env);
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error, "That code is not correct.");
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("TOTP second step rejects a tampered challenge token as expired", async () => {
  const secret = generateTotpSecret();
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    noAccountBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash, totp_enabled: 1, totp_secret: secret }) },
    { test: TOTP_STATUS_TEST, first: async () => ({ totp_secret: secret }) },
  ]);
  const env = envWithLimiters({ GOOBER_DB: db });
  const login = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    env,
  );
  const { challenge } = await bodyOf(login);
  // Alter mid-payload characters so the signature no longer matches.
  const tampered = challenge.slice(0, -20) + "w" + challenge.slice(-19);
  const response = await dispatch(
    postJson("/api/auth/totp", { challenge: tampered, code: "000000" }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(
    (await bodyOf(response)).error,
    "This verification request has expired. Sign in again.",
  );
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

// --- POST /api/auth/logout -------------------------------------------------

async function signedInEnv() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: 7,
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
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) => sql.includes("DELETE FROM sessions WHERE token_hash = ?"),
      run: (bound) => {
        assert.deepEqual(bound, [row.token_hash]);
        return { meta: { changes: 1 } };
      },
    },
  ]);
  return { env: envWithLimiters({ GOOBER_DB: db }), token, csrf, db };
}

test("GET /api/me returns the vendored readSession shape for a signed-in member", async () => {
  const { env, token, csrf } = await signedInEnv();
  const response = await dispatch(get("/api/me", { Cookie: "goober_session=" + token }), env);
  assert.equal(response.status, 200);
  // Goober+ perks ride a second additive read (the vendored readSession is
  // pinned byte-for-byte, so its SELECT carries no accent/tagline): an
  // unrouted read answers null for both.
  assert.deepEqual(await bodyOf(response), {
    user: {
      id: 7,
      username: "wempos",
      role: "member",
      bio: "",
      avatarStatus: null,
      avatarUrl: null,
      totpEnabled: false,
      // The 0005 perks keys are purely additive on the user payload, and the
      // Nitro lane (2026-11-17) adds the boolean badge on EVERY /api/me.
      accentColor: null,
      tagline: null,
      isPlus: false,
    },
    csrfToken: csrf,
  });
});

test("GET /api/me 401s without a valid session cookie", async () => {
  const { env } = await signedInEnv();
  const response = await dispatch(get("/api/me"), env);
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error, "Please sign in to do that.");
});

test("logout deletes the session row and clears the cookie", async () => {
  const { env, token, csrf, db } = await signedInEnv();
  const response = await dispatch(
    postJson("/api/auth/logout", {}, { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf }),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Set-Cookie"),
    "goober_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  const deleteCall = db.calls.find((call) =>
    call.sql.includes("DELETE FROM sessions WHERE token_hash = ?"));
  assert.ok(deleteCall);
  assert.deepEqual(deleteCall.bound, [await sha256Hex(token)]);
});

test("logout demands an authenticated session with CSRF", async () => {
  const { env } = await signedInEnv();
  const response = await dispatch(postJson("/api/auth/logout", {}), env);
  assert.equal(response.status, 401);
  assert.equal(
    (await bodyOf(response)).error,
    "Your session has expired. Reload the page and sign in again.",
  );
});

// --- credential relay (pepper-drift rescue) ----------------------------------
// The local verify runs against a hash minted under a DIFFERENT pepper (what
// the forum stores), so the route hands the decision to the relay. fetch is
// stubbed in-test: the real module would otherwise call the forum origin.

const DIFFERENT_PEPPER = "forum-pepper-0123456789abcdef0123456789abcdef";
const REAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

function stubRelayFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(calls.length, url, init);
  };
  return calls;
}

test("login falls back to the Forum relay when the local pepper differs", async () => {
  const otherPepper = await hashPassword("long-enough-password", DIFFERENT_PEPPER);
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: otherPepper.salt, hash: otherPepper.hash }) },
    { test: ACCOUNT_BAN_TEST, first: async () => null },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const calls = stubRelayFetch(async () =>
    new Response(JSON.stringify({ valid: true, user: { id: 7 } }), { status: 200 }));
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({ GOOBER_DB: db, RELAY_TOKEN: "r".repeat(64) }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie") || "", /goober_session=[A-Za-z0-9_-]+/);
  assert.equal(calls.length, 1, "the Forum relay verifies the password after the Forum ban check");
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")) !== undefined, true);
});

test("relay unavailability is 503 when a valid local pepper does not match the stored hash", async () => {
  const otherPepper = await hashPassword("long-enough-password", DIFFERENT_PEPPER);
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: otherPepper.salt, hash: otherPepper.hash }) },
  ]);
  const calls = stubRelayFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({ GOOBER_DB: db, RELAY_TOKEN: "r".repeat(64) }),
  );
  assert.equal(response.status, 503);
  assert.match((await bodyOf(response)).error, /Password verification is unavailable/);
  assert.equal(calls.length, 1);
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("a network ban activated after preflight blocks session creation", async () => {
  const credentials = await hashFor("long-enough-password");
  let checks = 0;
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash }) },
    noAccountBan,
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({
      GOOBER_DB: db,
      _networkBanCheck: async () => ({ banned: ++checks > 1, ipHash: "a".repeat(64) }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(checks, 2, "the Forum network-ban check runs at preflight and again before mint");
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("session mint atomically rejects a network ban committed after the Forum preflight", async () => {
  const credentials = await hashFor("long-enough-password");
  const ipHash = "b".repeat(64);
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash }) },
    noAccountBan,
    {
      test: SESSION_INSERT_TEST,
      run: async (bound) => {
        const call = db.calls.find((entry) => entry.sql.includes("INSERT INTO sessions"));
        assert.ok(call.sql.includes("NOT EXISTS (SELECT 1 FROM banned_ips bi JOIN bans b"),
          "the INSERT itself checks active Forum network bans");
        assert.ok(call.sql.includes("bi.ip_hash = ?"),
          "the atomic guard compares the Forum-keyed IP hash");
        assert.ok(bound.includes(ipHash), "the exact opaque Forum hash is bound into the INSERT");
        return { meta: { changes: 0 } }; // ban became active after both relay reads
      },
    },
  ]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({
      GOOBER_DB: db,
      _networkBanCheck: async () => ({ banned: false, ipHash }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(db.calls.filter((call) => call.sql.includes("INSERT INTO sessions")).length, 1);
  assert.equal(response.headers.get("Set-Cookie"), null, "no session cookie is issued when the atomic ban guard rejects");
});

test("valid local password sign-in does not depend on the credential relay", async () => {
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash }) },
    { test: ACCOUNT_BAN_TEST, first: async () => null },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const calls = stubRelayFetch(async () => { throw new TypeError("network down"); });
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({ GOOBER_DB: db, RELAY_TOKEN: "r".repeat(64) }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 0, "a successful local verification needs no relay call");
});

test("register converges the fresh hash onto the forum pepper via relaySet", async () => {
  const db = fakeDb([
    noNetworkBan,
    { test: (sql) => sql.includes("INSERT INTO users"), run: () => ({ meta: { changes: 1, last_row_id: 42 } }) },
    { test: USER_RESELECT_TEST, first: async () => userRow({ id: 42 }) },
    { test: ACCOUNT_BAN_TEST, first: async () => null },
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const calls = stubRelayFetch(async () =>
    new Response(JSON.stringify({ changed: true, user: { id: 42 } }), { status: 200 }));
  const response = await dispatch(
    postJson("/api/auth/register", {
      username: "newcomer",
      password: "another-long-password",
      "cf-turnstile-response": "XXXX.DUMMY.PASS.TOKEN.XXXX",
    }),
    envWithLimiters({
      GOOBER_DB: db,
      RELAY_TOKEN: "r".repeat(64),
      _turnstileVerify: async () => {},
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1, "one relay call from register");
  assert.match(String(calls[0].url), /\/api\/relay\/password-set$/);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent, { username: "newcomer", password: "another-long-password" });
});

test("POST /api/admin/reset-password re-issues a password through the relay (owner only)", async () => {
  const { env: memberEnv, token, csrf } = await signedInEnv();
  stubRelayFetch(async () => new Response(JSON.stringify({ changed: true }), { status: 200 }));
  const refused = await dispatch(
    postJson("/api/admin/reset-password", { username: "wempos", password: "reset-pass-123" }, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
    }),
    memberEnv,
  );
  assert.equal(refused.status, 403, "members cannot re-issue passwords");
});

test("login fails closed when the Forum network-ban relay is unavailable", async () => {
  const db = fakeDb([noNetworkBan]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({
      GOOBER_DB: db,
      RELAY_TOKEN: "",
      _networkBanCheck: undefined,
    }),
  );
  assert.equal(response.status, 503);
  assert.match((await bodyOf(response)).error, /Forum network-ban verification is unavailable/);
  assert.equal(db.calls.find((call) => LOGIN_USER_SELECT_TEST(call.sql)), undefined);
});

test("login refuses a Forum-banned network before password relay verification", async () => {
  const db = fakeDb([noNetworkBan]);
  const calls = stubRelayFetch(async () =>
    new Response(JSON.stringify({ banned: true, ipHash: "a".repeat(64) }), { status: 200 }));
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({
      PASSWORD_PEPPER: "",
      GOOBER_DB: db,
      RELAY_TOKEN: "r".repeat(64),
      _networkBanCheck: undefined,
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await bodyOf(response)).error, "This network is banned from the forum.");
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].url), /\/api\/relay\/network-ban-check$/);
  assert.equal(db.calls.find((call) => LOGIN_USER_SELECT_TEST(call.sql)), undefined);
});

test("relay-verified TOTP login refuses to issue an unsigned challenge without a local key", async () => {
  const secret = generateTotpSecret();
  const forumHash = await hashPassword("long-enough-password", DIFFERENT_PEPPER);
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: forumHash.salt, hash: forumHash.hash, totp_enabled: 1, totp_secret: secret }) },
    noAccountBan,
    { test: TOTP_STATUS_TEST, first: async () => ({ totp_secret: secret }) },
  ]);
  stubRelayFetch(async (index, url) => {
    if (String(url).endsWith("/api/relay/password-verify")) {
      return new Response(JSON.stringify({ valid: true, user: { id: 7 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ banned: false }), { status: 200 });
  });
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({
      PASSWORD_PEPPER: "",
      GOOBER_DB: db,
      RELAY_TOKEN: "r".repeat(64),
    }),
  );
  assert.equal(response.status, 503);
  assert.match((await bodyOf(response)).error, /TOTP challenge signing is not configured/);
  assert.equal(db.calls.find((call) => call.sql.includes("INSERT INTO sessions")), undefined);
});

test("relay-only login can proceed after the Forum verifies the network is not banned", async () => {
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({}) },
    noAccountBan,
    { test: SESSION_INSERT_TEST, run: () => ({ meta: { changes: 1 } }) },
  ]);
  const calls = stubRelayFetch(async () =>
    new Response(JSON.stringify({ valid: true, user: { id: 7 } }), { status: 200 }));
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({
      PASSWORD_PEPPER: "",
      GOOBER_DB: db,
      RELAY_TOKEN: "r".repeat(64),
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie") || "", /goober_session=[A-Za-z0-9_-]+/);
  assert.equal(calls.length, 1, "Forum network-ban check and password verification both use the relay");
});

test("login reports unavailable verification when both local pepper and relay are absent", async () => {
  const credentials = await hashFor("long-enough-password");
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => userRow({ salt: credentials.salt, hash: credentials.hash }) },
  ]);
  const response = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: "long-enough-password" }),
    envWithLimiters({ PASSWORD_PEPPER: "", GOOBER_DB: db }),
  );
  assert.equal(response.status, 503);
  assert.match((await bodyOf(response)).error,
    /Password verification is unavailable/);
});
