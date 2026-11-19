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

// Backup-codes routes (v4.8.1): GooberCord side of the shared single-use
// TOTP backup codes — the generation route's replace-in-one-batch + the raw
// codes shown exactly once, and the login step's code-or-backup burn riding
// the same totp limiter tier. The table itself is forum-owned (migration
// 0042 in wempos-forum); every GC statement here targets only it and the
// contracted shared rows (users/sessions). Mirrors the
// fake-db/pinned-SQL patterns of tests/accounts-module.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { handleAccountRoutes } from "../api/accounts.mjs";
import { hashPassword } from "../api/core/passwords.mjs";
import { generateTotpSecret, totpAt } from "../api/core/totp.mjs";
import { sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const PEPPER = "goobercord-test-pepper-0123456789abcdef0123456789";
const PASSWORD = "correct horse battery staple";
const CHALLENGE = "gc-challenge-token-from-the-login-step";

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

// Test dispatcher: mirrors worker.mjs's apiError mapping.
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

// The signed-in session every member-endpoint test needs; also the exact
// session read the vendored requireCsrf runs.
const MEMBER_SESSION_HEADERS = { "X-CSRF-Token": "c".repeat(24), Cookie: "goober_session=" + "A".repeat(44) };

const SESSION_READ = {
  test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
  first: async () => ({
    token_hash: "h", user_id: 7, csrf_token: "c".repeat(24), expires_at: 9999999999,
    username: "wempos", role: "member", bio: "", avatar_status: null,
    avatar_mime: null, avatar_updated_at: null, avatar_version: null, totp_enabled: 0,
  }),
};

// Every limiter env stub records its derived key on the totp limiter itself.
function envWithLimiter(db, extra = {}) {
  const limiter = {
    calls: [],
    async limit({ key }) {
      limiter.calls.push(key);
      return { success: true };
    },
  };
  const env = { PASSWORD_PEPPER: PEPPER, GOOBER_DB: db, _networkBanCheck: async () => ({ banned: false, ipHash: "a".repeat(64) }), ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async () => ({ success: true }) };
  }
  env.GC_TOTP_RATE_LIMITER = limiter;
  return { env, limiter };
}

// fakeDb as in accounts-module.test.mjs; the totp limiter is injectable.
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

const NETWORK_BAN_TEST = (sql) => sql.includes("FROM banned_ips") && !sql.includes("INSERT INTO sessions");
const noNetworkBan = { test: NETWORK_BAN_TEST, first: async () => null };

const LOGIN_USER_SELECT_TEST = (sql) =>
  sql.includes("FROM users WHERE username_key = ? LIMIT 1");

const ACCOUNT_BAN_TEST = (sql) =>
  sql.includes("SELECT reason, expires_at FROM bans WHERE user_id = ?");
const noAccountBan = { test: ACCOUNT_BAN_TEST, first: async () => null };

const TOTP_STATUS_TEST = (sql) =>
  sql.includes("SELECT totp_secret FROM users WHERE id = ?");

const GENERATE_ROW_TEST = (sql) =>
  sql.includes("SELECT totp_enabled, totp_secret, password_salt, password_hash FROM users WHERE id = ?");

const BACKUP_BURN_TEST = (sql) =>
  sql.includes("DELETE FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL");

const BACKUP_DELETE_TEST = (sql) =>
  sql === "DELETE FROM totp_backup_codes WHERE user_id = ?";

const BACKUP_INSERT_TEST = (sql) =>
  sql === "INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)";

const USER_RESELECT_TEST = (sql) =>
  sql.includes("FROM users WHERE id = ? LIMIT 1") &&
  !sql.includes("totp_secret") &&
  !sql.includes("session") &&
  sql.includes("password_salt");

const SESSION_INSERT_TEST = (sql) => sql.includes("INSERT INTO sessions");

const CHALLENGE_KEY_ROW_TEST = (sql) =>
  sql.includes("SELECT username_key, totp_enabled, totp_secret FROM users WHERE id = ?");

async function userRow(user) {
  const passwordHash = await hashPassword(PASSWORD, PEPPER);
  return {
    id: user.id ?? 7,
    username: user.username ?? "wempos",
    username_key: (user.username ?? "wempos").toLowerCase(),
    password_salt: user.salt ?? (user.withPassword ? passwordHash.salt : ""),
    password_hash: user.hash ?? (user.withPassword ? passwordHash.hash : ""),
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

// --- POST /api/me/totp/backups/generate -----------------------------------------

test("generate demands a signed-in session", async () => {
  const db = fakeDb([]);
  const { env } = envWithLimiter(db);
  const response = await dispatch(
    postJson("/api/me/totp/backups/generate", { currentPassword: PASSWORD }),
    env,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(db.calls, []);
});

test("generate: replaces the old set in one batch and shows the raw codes exactly once", async () => {
  const db = fakeDb([
    noNetworkBan,
    SESSION_READ,
    {
      test: GENERATE_ROW_TEST,
      first: async () => ({ ...(await userRow({ withPassword: true, totp_enabled: 1, totp_secret: generateTotpSecret() })) }),
    },
    {
      test: BACKUP_BURN_TEST,
      run: (bound) => {
        // The confirmation rode a backup code; the burn keys on user + hash.
        assert.equal(bound[0], 7);
        assert.match(bound[1], /^[0-9a-f]{64}$/);
        return { meta: { changes: 1 } };
      },
    },
  ]);
  const { env, limiter } = envWithLimiter(db);
  const response = await dispatch(
    postJson("/api/me/totp/backups/generate", {
      currentPassword: PASSWORD,
      code: "b".repeat(8),
    }, MEMBER_SESSION_HEADERS),
    env,
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.codes.length, 10);
  for (const code of body.codes) assert.match(code, /^[A-Za-z0-9_-]{8}$/);

  // The batch is exactly one invalidating DELETE + the 10 inserts, bound to
  // this user, hashes only.
  const deleteCall = db.calls.find((call) => call.sql === "DELETE FROM totp_backup_codes WHERE user_id = ?");
  const insertCalls = db.calls.filter((call) => call.sql.startsWith("INSERT INTO totp_backup_codes"));
  assert.ok(deleteCall);
  assert.deepEqual(deleteCall.bound, [7]);
  assert.equal(insertCalls.length, 10);
  for (let index = 0; index < 10; index++) {
    assert.deepEqual(insertCalls[index].bound[0], 7);
    assert.equal(insertCalls[index].bound[1], await sha256Hex(body.codes[index]));
  }
  // The raw codes ride ONLY the response — no statement bind carries one.
  const allBinds = db.calls
    .filter((call) => call.bound !== undefined)
    .flatMap((call) => call.bound.map(String));
  for (const code of body.codes) {
    assert.equal(allBinds.includes(code), false, "raw code must never be stored");
  }
  // The generation rides the totp limiter keyed per account.
  assert.deepEqual(limiter.calls, [await sha256Hex("totp:user:7")]);
});

test("generate: the old set is invalidated BEFORE any fresh insert", async () => {
  const db = fakeDb([
    noNetworkBan,
    SESSION_READ,
    {
      test: GENERATE_ROW_TEST,
      first: async () => ({ ...(await userRow({ withPassword: true, totp_enabled: 0 })) }),
    },
  ]);
  const { env } = envWithLimiter(db);
  await dispatch(
    postJson("/api/me/totp/backups/generate", { currentPassword: PASSWORD }, MEMBER_SESSION_HEADERS),
    env,
  );
  const deleteAt = db.calls.findIndex((call) => call.sql.startsWith("DELETE FROM totp_backup_codes"));
  const insertAt = db.calls.findIndex((call) => call.sql.startsWith("INSERT INTO totp_backup_codes"));
  assert.ok(deleteAt >= 0 && insertAt > deleteAt, "delete precedes the inserts");
});

test("generate: wrong password 401s with zero backup statements", async () => {
  const db = fakeDb([
    noNetworkBan,
    SESSION_READ,
    {
      test: GENERATE_ROW_TEST,
      first: async () => ({ ...(await userRow({ withPassword: true, totp_enabled: 0 })) }),
    },
  ]);
  const { env } = envWithLimiter(db);
  const response = await dispatch(
    postJson("/api/me/totp/backups/generate", { currentPassword: "not my password" }, MEMBER_SESSION_HEADERS),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error, "Your current password is incorrect.");
  assert.deepEqual(
    db.calls.filter((call) => call.sql.includes("totp_backup_codes")),
    [],
  );
});

test("generate: with 2FA on the 6-digit authenticator code confirms too", async () => {
  const secret = generateTotpSecret();
  const db = fakeDb([
    noNetworkBan,
    SESSION_READ,
    {
      test: GENERATE_ROW_TEST,
      first: async () => ({ ...(await userRow({ withPassword: true, totp_enabled: 1, totp_secret: secret })) }),
    },
  ]);
  const { env } = envWithLimiter(db);
  const now = nowSeconds();
  let response = null;
  for (const drift of [0, 30, -30]) {
    try {
      response = await dispatch(
        postJson("/api/me/totp/backups/generate", {
          currentPassword: PASSWORD,
          code: await totpAt(secret, now + drift),
        }, MEMBER_SESSION_HEADERS),
        env,
      );
      if (response.status === 401) response = null;
    } catch (error) {
      response = null;
    }
    if (response) break;
  }
  assert.ok(response, "no step of the window verified");
  assert.equal(response.status, 200);
  assert.equal((await bodyOf(response)).codes.length, 10);
});

// --- the login step: code or backup code -----------------------------------------

// The login-shaped fake that mints a real challenge, like accounts-module's
// 2FA tests: login → {totpRequired, challenge} → POST /api/auth/totp.
async function loginDb(options = {}) {
  const secret = options.secret ?? generateTotpSecret();
  const member = await userRow({ withPassword: true, totp_enabled: 1, totp_secret: secret });
  const db = fakeDb([
    noNetworkBan,
    { test: LOGIN_USER_SELECT_TEST, first: async () => member },
    { test: TOTP_STATUS_TEST, first: async () => ({ totp_secret: secret }) },
    noAccountBan,
    {
      test: CHALLENGE_KEY_ROW_TEST,
      first: async () => ({
        username_key: "wempos", totp_enabled: 1, totp_secret: secret,
      }),
    },
    {
      test: BACKUP_BURN_TEST,
      run: () => ({ meta: { changes: options.burnChanges ?? 1 } }),
    },
    {
      test: SESSION_INSERT_TEST,
      run: (bound) => {
        assert.deepEqual(bound.length, 9, "the atomic insert binds account-ban and Forum-keyed network-ban guards");
        return { meta: { changes: 1 } };
      },
    },
  ]);
  return { db, secret };
}

async function signChallenge(env) {
  const login = await dispatch(
    postJson("/api/auth/login", { username: "wempos", password: PASSWORD }),
    env,
  );
  assert.equal(login.status, 200);
  const body = await bodyOf(login);
  assert.equal(body.totpRequired, true);
  return body.challenge;
}

test("login step: a valid backup code burns once and mints the session", async () => {
  const { db } = await loginDb();
  const { env, limiter } = envWithLimiter(db);
  const challenge = await signChallenge(env);
  const backupCode = "k".repeat(8);
  const response = await dispatch(
    postJson("/api/auth/totp", { challenge, code: backupCode }),
    env,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie"), /^goober_session=/);
  const body = await bodyOf(response);
  assert.equal(body.user.totpEnabled, true);
  // The burn keys on user + hash — the raw code never lands in a bind.
  const burn = db.calls.find((call) => BACKUP_BURN_TEST(call.sql));
  assert.deepEqual(burn.bound, [7, await sha256Hex(backupCode)]);
  // Both limiter passes fired before the burn: per-IP, then per-account.
  assert.deepEqual(limiter.calls, [
    await sha256Hex("totp:198.51.100.7"),
    await sha256Hex("totp:user:7"),
  ]);
});

test("login step: a reused backup code (changes 0) 401s with no session minted", async () => {
  const { db } = await loginDb({ burnChanges: 0 });
  const { env } = envWithLimiter(db);
  const challenge = await signChallenge(env);
  const response = await dispatch(
    postJson("/api/auth/totp", { challenge, code: "k".repeat(8) }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error, "That code is not correct.");
  assert.ok(!db.calls.some((call) => call.sql.includes("INSERT INTO sessions")));
  assert.ok(!db.calls.some((call) => call.call === "batch"));
});

test("login step: a wrong 6-digit code and a wrong backup code answer IDENTICALLY (no leak)", async () => {
  const answers = [];
  for (const wrongCode of ["000000", "z".repeat(8)]) {
    const { db } = await loginDb({ burnChanges: 0 });
    const { env } = envWithLimiter(db);
    const challenge = await signChallenge(env);
    const response = await dispatch(
      postJson("/api/auth/totp", { challenge, code: wrongCode }),
      env,
    );
    answers.push(String(response.status) + " " + (await bodyOf(response)).error);
  }
  assert.equal(answers[0], answers[1]);
  assert.equal(answers[0], "401 That code is not correct.");
});

test("login step: garbage between the two shapes stays the same 401 (no shape oracle)", async () => {
  const { db } = await loginDb({ burnChanges: 0 });
  const { env } = envWithLimiter(db);
  const challenge = await signChallenge(env);
  const response = await dispatch(
    postJson("/api/auth/totp", { challenge, code: "!!!???" }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error, "That code is not correct.");
});

test("login step: an absent code still answers the shared 400 with the both-shapes copy", async () => {
  const { db } = await loginDb();
  const { env } = envWithLimiter(db);
  const challenge = await signChallenge(env);
  const response = await dispatch(
    postJson("/api/auth/totp", { challenge }),
    env,
  );
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /backup code/);
});
