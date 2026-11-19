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

// Registration username word-filter parity (Phase 1, Task 3 carry into Task 5):
// the forum rejects usernames that do not survive the word filter untouched
// (api/session.mjs register branch), and GooberCord's register must too once
// the forum's filter primitives are vendored. With an EMPTY effective list
// (today's production state — the owner disabled the filter on 2026-11-15)
// the whole check is a strict no-op pass-through, which these tests also pin.
//
// Kept as a separate small file: Task 3's diff (tests/accounts-module.test.mjs)
// is closed, so its fixtures are minimally re-stated here rather than edited.
import test from "node:test";
import assert from "node:assert/strict";

import { handleAccountRoutes } from "../api/accounts.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const PEPPER = "goobercord-test-pepper-0123456789abcdef0123456789";

function postJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.7", ...headers },
    body: JSON.stringify(body),
  });
}

// Test dispatcher: mirrors worker.mjs's apiError mapping so HttpErrors surface
// as the same JSON responses the worker would return.
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

// Test seam (the accounts module's documented one): records the Turnstile
// action per call instead of hitting Cloudflare siteverify.
function turnstileSpy() {
  const spy = async (request, env, body, expectedAction) => {
    spy.actions.push(expectedAction);
  };
  spy.actions = [];
  return spy;
}

// Minimal fake DB: the first matching route answers each statement shape.
// Written for this file only; no batch() (register creates its session with a
// plain run when there is no old token to rotate).
function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  return {
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
  };
}

// --- shared fake-route shapes ---------------------------------------------------

const NETWORK_BAN_TEST = (sql) => sql.includes("FROM banned_ips") && !sql.includes("INSERT INTO sessions");
const noNetworkBan = { test: NETWORK_BAN_TEST, first: async () => null };

// The vendored filter store's source: the shared site_settings row (READ-ONLY —
// the scoping contract forbids forum-row writes, and none happen here).
const SITE_SETTINGS_TEST = (sql) => sql.includes("FROM site_settings");

const USER_RESELECT_TEST = (sql) =>
  sql.includes("FROM users WHERE id = ? LIMIT 1") &&
  !sql.includes("totp_secret") &&
  !sql.includes("session") &&
  sql.includes("password_salt");

function storedUser(username) {
  return {
    id: 7,
    username,
    username_key: username.toLowerCase(),
    password_salt: "00",
    password_hash: "00",
    role: "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
}

// --- registration parity --------------------------------------------------------

test("register rejects a username that does not survive the filter untouched", async () => {
  _resetFilterWordsCacheForTests();
  const spy = turnstileSpy();
  const db = fakeDb([
    noNetworkBan,
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "badword", updated_at: 1 }) },
  ]);
  const env = envWithLimiters({
    GOOBER_DB: db,
    TURNSTILE_SECRET: "secret",
    TURNSTILE_HOSTNAMES: "localhost",
    _turnstileVerify: spy,
  });

  const response = await dispatch(
    postJson("/api/auth/register", { username: "badword_user", password: "longenoughpassword" }),
    env,
  );

  // The forum's verbatim register copy (api/session.mjs), never hinting at
  // the private word list.
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That username isn't allowed." });

  // The rejection happened at the filter gate: no Turnstile action ever ran
  // (the check sits before the human check, GC's shape-first ordering) and no
  // users row was written.
  assert.deepEqual(db.calls.filter((call) => call.sql.includes("INSERT INTO users")), []);
  assert.deepEqual(spy.actions, []);
});

test("register rejects the leet/skeleton normalized variant of a filtered entry", async () => {
  _resetFilterWordsCacheForTests();
  const spy = turnstileSpy();
  const db = fakeDb([
    noNetworkBan,
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "badword", updated_at: 1 }) },
  ]);
  const env = envWithLimiters({
    GOOBER_DB: db,
    TURNSTILE_SECRET: "secret",
    TURNSTILE_HOSTNAMES: "localhost",
    _turnstileVerify: spy,
  });

  // "badw0rd" normalizes to the entry's skeleton — the forum's second check
  // (containsFilteredWord over normalizeUsernameForFilter) catches it.
  const response = await dispatch(
    postJson("/api/auth/register", { username: "badw0rd", password: "longenoughpassword" }),
    env,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), { error: "That username isn't allowed." });
  assert.deepEqual(db.calls.filter((call) => call.sql.includes("INSERT INTO users")), []);
  assert.deepEqual(spy.actions, []);
});

test("register passes clean usernames through when the effective filter list is empty", async () => {
  _resetFilterWordsCacheForTests();
  const spy = turnstileSpy();
  // The site_settings row EXISTS with an empty value — the D1 row is the
  // single source of truth once present, even when emptied (the filter is
  // OFF, today's production state), and beats any FILTERED_WORDS secret.
  const db = fakeDb([
    noNetworkBan,
    { test: SITE_SETTINGS_TEST, first: async () => ({ value: "", updated_at: 1 }) },
    {
      test: USER_RESELECT_TEST,
      first: async () => storedUser("wempos"),
    },
  ]);
  const env = envWithLimiters({
    GOOBER_DB: db,
    TURNSTILE_SECRET: "secret",
    TURNSTILE_HOSTNAMES: "localhost",
    FILTERED_WORDS: "ignored-when-the-d1-row-exists",
    _turnstileVerify: spy,
  });

  const response = await dispatch(
    postJson("/api/auth/register", { username: "wempos", password: "longenoughpassword" }),
    env,
  );

  // Full pass-through: the flow reached and passed the Turnstile step and
  // minted the account exactly like an unfiltered registration.
  assert.equal(response.status, 201);
  assert.deepEqual(spy.actions, ["register"]);
  assert.equal((await bodyOf(response)).user.username, "wempos");

  // The parity check still rode the read-only site_settings lookup — the
  // mechanism, not the word list, is what is mirrored.
  assert.ok(db.calls.find((call) => SITE_SETTINGS_TEST(call.sql)));
});
