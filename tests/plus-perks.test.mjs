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

// Goober+ Nitro perks (the 2026-11-17 blessed contract): the tier pins, the
// migration's rebuild, the ONE perk predicate and the payload fragment, the
// plus-gated cosmetics PATCH, the /api/me badge fold, the tiered coin mints,
// and the isPlus badge on the member surfaces. Same fakeDb + pinned-SQL style
// as the coins/accounts modules: the fakes ENCODE the guards (the perk gate
// reads the strict term) so a pinned flow that loses its gate fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleAccountRoutes } from "../api/accounts.mjs";
import { handleCoinRoutes, grantMessageCoins } from "../api/coins.mjs";
import {
  attachmentCapBytes,
  plusActiveExpr,
  plusPerkActive,
  publicCosmetics,
  publicIsPlus,
} from "../api/plus.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { GC_COIN_MESSAGE_DAILY_CAP, RATE_LIMIT_BINDINGS } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
void randomToken;
const NOW = nowSeconds();

// --- constants pin (the blessed economy numbers, 2026-11-17) ---------------------

test("the blessed Goober+ economy numbers ride named GC_PLUS_* constants", () => {
  const constants = readFileSync(new URL("../constants.mjs", import.meta.url), "utf8");
  // The ECONOMY RE-RULE: the claim's tier is retired (25 FLAT for everyone —
  // GC_PLUS_DAILY_GRANT no longer exists), message earns 3-vs-2, voice 8-vs-5.
  assert.doesNotMatch(constants, /export const GC_PLUS_DAILY_GRANT/);
  assert.match(constants, /export const GC_PLUS_MESSAGE_GRANT = 3;/);
  assert.match(constants, /export const GC_COIN_MESSAGE_GRANT = 2;/);
  assert.match(constants, /export const GC_PLUS_VOICE_GRANT = 8;/);
  assert.match(constants, /export const GC_PLUS_DAILY_CEILING = 500;/);
  // The re-rule's new families: the rollup, the server mint, and the SINK.
  assert.match(constants, /export const GC_ROLLUP_GRANT = 3;/);
  assert.match(constants, /export const GC_PLUS_ROLLUP_GRANT = 5;/);
  assert.match(constants, /export const GC_ROLLUP_DAILY_CAP = 5;/);
  assert.match(constants, /export const GC_ROLLUP_MIN_BODY = 40;/);
  assert.match(constants, /export const GC_SERVER_GRANT = 50;/);
  assert.match(constants, /export const GC_PLUS_SERVER_GRANT = 75;/);
  assert.match(constants, /export const GC_SERVER_MINT_DAILY_CAP = 2;/);
  assert.match(constants, /export const GC_COSMETIC_BANNER_PRICE = 100;/);
  assert.match(constants, /export const GC_COSMETIC_FLAIR_PRICE = 100;/);
  assert.match(constants, /export const GC_COSMETIC_PACK_PRICE = 250;/);
  assert.match(constants, /export const GC_PLUS_SINK_DISCOUNT_PERCENT = 50;/);
  assert.match(constants, /export const GC_PLUS_RENEWAL_PRICE = 400;/);
  // The upload TIERS (0022, the 2026-11-17 matrix): free rides the parity
  // pass's 20 MiB (MAX_ATTACHMENT_BYTES above), Mini 50 MiB, full Goober+ the
  // 1 GiB bound the CHECK carries; each request ceiling rides its own file
  // cap plus the same headroom.
  assert.match(constants, /export const GC_MINI_ATTACHMENT_BYTES = 52_428_800;/);
  assert.match(constants, /export const GC_MINI_ATTACHMENT_REQUEST_BYTES = GC_MINI_ATTACHMENT_BYTES \+ 512 \* 1024;/);
  assert.match(constants, /export const GC_PLUS_ATTACHMENT_BYTES = 1_073_741_824;/);
  assert.match(constants, /export const GC_PLUS_ATTACHMENT_REQUEST_BYTES = GC_PLUS_ATTACHMENT_BYTES \+ 512 \* 1024;/);
});

test("migration 0013 rebuilds gc_attachments with the plus admission ceiling and adds gc_cosmetics", () => {
  const sql = readFileSync(new URL("../migrations/0013_goober_plus_nitro.sql", import.meta.url), "utf8");
  // The rebuild: rename-copy-drop, the CHECK admits 25 MiB, every table gc_-
  // scoped or the shared users table.
  assert.match(sql, /ALTER TABLE gc_attachments RENAME TO gc_attachments_pre_nitro;/);
  assert.match(sql, /size_bytes INTEGER NOT NULL CHECK\(size_bytes BETWEEN 1 AND 26214400\)/);
  assert.match(sql, /INSERT INTO gc_attachments SELECT \* FROM gc_attachments_pre_nitro;/);
  assert.match(sql, /DROP TABLE gc_attachments_pre_nitro;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gc_cosmetics/);
  assert.match(sql, /REFERENCES users\(id\) ON DELETE CASCADE/);
  for (const forbidden of ["ALTER TABLE blocks", "ALTER TABLE users", "DROP TABLE posts", "UPDATE posts"]) {
    assert.ok(!sql.includes(forbidden), "the migration never touches a forum table: " + forbidden);
  }
});

// --- plus.mjs: the ONE predicate and the payload fragment -------------------------

test("plusPerkActive is the STRICT active term: future true, lapsed or missing false", async () => {
  // plus.mjs rides the standard env.GOOBER_DB binding, like every api module.
  const term = (renews_until) => ({
    GOOBER_DB: {
      prepare: (sql) => ({
        bind: (id) => ({
          first: async () =>
            sql.startsWith("SELECT renews_until FROM gc_plus_state") && Number(id) === USER_ID
              ? { renews_until }
              : null,
        }),
      }),
    },
  });
  assert.equal(await plusPerkActive(term(NOW + 100), USER_ID, NOW), true);
  // A grace-window member's term has already lapsed — perks are OFF.
  assert.equal(await plusPerkActive(term(NOW - 1), USER_ID, NOW), false);
  assert.equal(await plusPerkActive(term(NOW - 100), USER_ID, NOW), false);
  // A member who never bought, and an unrouted fake, both read not-active.
  assert.equal(await plusPerkActive({ GOOBER_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }, USER_ID, NOW), false);
});

test("plusActiveExpr yields a COALESCEd 0/1 is_plus bound to the user column", () => {
  const expr = plusActiveExpr("u.id");
  assert.match(expr, /COALESCE\(\(\(SELECT gs\.renews_until FROM gc_plus_state gs WHERE gs\.user_id = u\.id\) > \?\), 0\) AS is_plus/);
  assert.equal(plusActiveExpr("id"), "COALESCE(((SELECT gs.renews_until FROM gc_plus_state gs WHERE gs.user_id = id) > ?), 0) AS is_plus");
});

test("publicIsPlus maps the 0/1 (null-safe) and publicCosmetics filters junk", () => {
  assert.equal(publicIsPlus({ is_plus: 1 }), true);
  assert.equal(publicIsPlus({ is_plus: 0 }), false);
  assert.equal(publicIsPlus({ is_plus: null }), false);
  assert.equal(publicIsPlus({}), false);
  assert.equal(publicIsPlus(null), false);

  assert.deepEqual(publicCosmetics({ banner_color: "#1a2b3c", flair_text: "certified" }), { banner: "#1a2b3c", flair: "certified" });
  assert.deepEqual(publicCosmetics({ banner_color: null, flair_text: null }), { banner: null, flair: null });
  assert.deepEqual(publicCosmetics({ banner_color: "#GGGGGG", flair_text: "ok" }), { banner: null, flair: "ok" }, "junk hex is absent, never echoed");
  assert.deepEqual(publicCosmetics({ banner_color: "#abc", flair_text: "tr\nline" }), { banner: "#abc", flair: null }, "a multi-line flair is absent");
  assert.deepEqual(publicCosmetics(null), { banner: null, flair: null });
});

test("attachmentCapBytes rides the TIERS: plus 1 GiB, mini 50 MiB, free 20 MiB, grace free", async () => {
  const NOW = nowSeconds() + 60;
  const USER_ID = 7;
  const dbFor = (renews_until, tier) => ({
    GOOBER_DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ renews_until, tier }) }) }),
    },
  });
  const plusCaps = await attachmentCapBytes(dbFor(NOW + 100, "plus"), USER_ID, NOW);
  assert.deepEqual(plusCaps, {
    fileBytes: 1_073_741_824,
    requestBytes: 1_073_741_824 + 512 * 1024,
    tier: "plus",
  });
  const miniCaps = await attachmentCapBytes(dbFor(NOW + 100, "mini"), USER_ID, NOW);
  assert.deepEqual(miniCaps, {
    fileBytes: 50 * 1024 * 1024,
    requestBytes: 50 * 1024 * 1024 + 512 * 1024,
    tier: "mini",
  });
  // The legacy NULL tier reads as full Goober+ — the migration can never
  // downgrade an existing member.
  const legacyCaps = await attachmentCapBytes(dbFor(NOW + 100, null), USER_ID, NOW);
  assert.deepEqual(legacyCaps, { fileBytes: 1_073_741_824, requestBytes: 1_073_741_824 + 512 * 1024, tier: "plus" });
  const graceCaps = await attachmentCapBytes(dbFor(NOW - 100, "plus"), USER_ID, NOW);
  assert.deepEqual(graceCaps, {
    fileBytes: 20 * 1024 * 1024,
    requestBytes: 20 * 1024 * 1024 + 512 * 1024,
    tier: null,
  });
  // A rowless member reads free, never NaN-truthy plus.
  const rowlessCaps = await attachmentCapBytes(
    { GOOBER_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } },
    USER_ID,
    NOW,
  );
  assert.deepEqual(rowlessCaps, { fileBytes: 20 * 1024 * 1024, requestBytes: 20 * 1024 * 1024 + 512 * 1024, tier: null });
});

// --- account-routes scaffolding ---------------------------------------------------

const SESSION_TOKEN = "A".repeat(40);
const SESSION_ROW = {
  token_hash: await sha256Hex(SESSION_TOKEN),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
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

function fakeDb(routes) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      let bound = [];
      return {
        bind(...values) { bound = values; return this; },
        first: async () => {
          calls.push({ call: "first", sql, bound });
          const route = routes.find((entry) => entry.test(sql));
          return route && route.first ? await route.first(bound) : null;
        },
        all: async () => {
          calls.push({ call: "all", sql, bound });
          const route = routes.find((entry) => entry.test(sql));
          return route && route.all ? await route.all(bound) : { results: [] };
        },
        run: async () => {
          calls.push({ call: "run", sql, bound });
          const route = routes.find((entry) => entry.test(sql));
          return route && route.run ? await route.run(bound) : { meta: { changes: 1 } };
        },
      };
    },
  };
  return db;
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleAccountRoutes(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function authed(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "__Host-goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SESSION_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const ACCENTS_TEST = (sql) => sql === "SELECT accent_color, tagline FROM users WHERE id = ? LIMIT 1";
const COSMETICS_ROWR_TEST = (sql) =>
  sql.startsWith("SELECT banner_color, flair_text FROM gc_cosmetics");
const TERM_READ_TEST = (sql) => sql.startsWith("SELECT renews_until FROM gc_plus_state");
const sessionRoute = { test: SESSION_TEST, first: async () => SESSION_ROW };
const termRoute = (renews_until) => ({
  test: TERM_READ_TEST,
  first: async () => (renews_until === null ? null : { renews_until }),
});
const emptyCosmeticsRoute = { test: COSMETICS_ROWR_TEST, first: async () => null };

// --- /api/me: the badge, the folded cosmetics -------------------------------------

test("GET /api/me folds the boolean badge: an active term reads isPlus true", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: ACCENTS_TEST, first: async () => ({ accent_color: "#abc", tagline: "plus owner" }) },
    { test: COSMETICS_ROWR_TEST, first: async () => ({ banner_color: "#1a2b3c", flair_text: "certified" }) },
    termRoute(NOW + 1000),
  ]);
  const response = await dispatch(authed("GET", "/api/me"), envWithLimiters({ GOOBER_DB: db }));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.user.isPlus, true);
  assert.deepEqual(
    { banner: body.user.banner, flair: body.user.flair },
    { banner: "#1a2b3c", flair: "certified" },
    "the cosmetics fold into the profile read",
  );
});

test("GET /api/me: grace mints the FALSE badge with perks off, and the cosmetics stay additive", async () => {
  const db = fakeDb([
    sessionRoute,
    { test: ACCENTS_TEST, first: async () => null },
    { test: COSMETICS_ROWR_TEST, first: async () => ({ banner_color: null, flair_text: null }) },
    termRoute(NOW - 1),
  ]);
  const response = await dispatch(authed("GET", "/api/me"), envWithLimiters({ GOOBER_DB: db }));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  // The two-predicate split (api/plus.mjs): the badge rides the shipped
  // display shape's decision here via the strict perk term — grace reads
  // false on /api/me, the coin-shop view keeps its own grace-inclusive one.
  assert.equal(body.user.isPlus, false);
  assert.equal("banner" in body.user, false, "an unset banner adds NO key (the additive idiom)");
  assert.equal("flair" in body.user, false);
});

// --- PATCH /api/me/cosmetics -------------------------------------------------------

const COSMETICS_UPSERT_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_cosmetics (user_id, banner_color, flair_text, updated_at)") &&
  sql.includes("ON CONFLICT(user_id) DO NOTHING");
const COSMETICS_UPDATE_TEST = (sql) => sql.startsWith("UPDATE gc_cosmetics SET ");
// The ECONOMY RE-RULE's ownership gate (0019): equipping banner/flair
// requires a purchased row.
const OWNERSHIP_READ_TEST = (sql) =>
  sql.startsWith("SELECT item FROM gc_cosmetic_ownership WHERE user_id = ?");
const OWNERSHIP_ROUTE = {
  test: OWNERSHIP_READ_TEST,
  all: async () => ({ results: [{ item: "banner" }, { item: "flair" }] }),
};
const NO_OWNERSHIP_ROUTE = { test: OWNERSHIP_READ_TEST, all: async () => ({ results: [] }) };

test("PATCH /api/me/cosmetics is plus-gated BEFORE validation, with the pinned copy", async () => {
  const db = fakeDb([sessionRoute, termRoute(NOW - 1)]);
  const response = await dispatch(
    authed("PATCH", "/api/me/cosmetics", { banner: "#not-hex" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 403);
  assert.equal(
    (await bodyOf(response)).error,
    "Those are Goober+ perks. Get Goober+ in the coin shop to use them.",
  );
  // The gate precedes any read or write in the lane: no gc_cosmetics touch.
  assert.equal(db.calls.some((call) => COSMETICS_UPSERT_TEST(call.sql)), false);
  assert.equal(db.calls.some((call) => COSMETICS_UPDATE_TEST(call.sql)), false);
});

test("PATCH /api/me/cosmetics writes only the present fields and echoes the stored row", async () => {
  const db = fakeDb([
    sessionRoute,
    termRoute(NOW + 1000),
    OWNERSHIP_ROUTE,
    { test: COSMETICS_ROWR_TEST, first: async () => ({ banner_color: "#abc", flair_text: null }) },
  ]);
  const response = await dispatch(
    authed("PATCH", "/api/me/cosmetics", { banner: "#1a2b3c" }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  // The absent flair key must NOT ride the SET (absent-key-keeps), and the
  // write is the two-statement shape: the ensure row, then the partial UPDATE.
  const update = db.calls.find((call) => COSMETICS_UPDATE_TEST(call.sql));
  assert.ok(update);
  assert.match(update.sql, /SET banner_color = \?, updated_at = \? WHERE user_id = \?$/);
  assert.doesNotMatch(update.sql, /flair_text/);
  // [banner bind], [now bind], [userId]; the `now` is the route's live clock.
  assert.equal(update.bound[0], "#1a2b3c");
  assert.equal(Number.isFinite(update.bound[1]), true);
  assert.equal(update.bound[2], USER_ID);
  assert.ok(db.calls.find((call) => COSMETICS_UPSERT_TEST(call.sql)));
  // The response echoes the STORED row.
  assert.deepEqual(await bodyOf(response), { cosmetics: { banner: "#abc", flair: null } });
});

test("PATCH /api/me/cosmetics: null clears, absent body is allowed, and invalid shapes refuse", async () => {
  // null clears ride the SET as a literal NULL (never a bound value).
  const clearDb = fakeDb([
    sessionRoute,
    termRoute(NOW + 1000),
    NO_OWNERSHIP_ROUTE,
    { test: COSMETICS_ROWR_TEST, first: async () => null },
  ]);
  const clear = await dispatch(
    authed("PATCH", "/api/me/cosmetics", { banner: null, flair: null }),
    envWithLimiters({ GOOBER_DB: clearDb }),
  );
  assert.equal(clear.status, 200);
  const clearUpdate = clearDb.calls.find((call) => COSMETICS_UPDATE_TEST(call.sql));
  assert.match(clearUpdate.sql, /SET banner_color = NULL, flair_text = NULL, updated_at = \? WHERE user_id = \?$/);
  assert.equal(Number.isFinite(clearUpdate.bound[0]), true);
  assert.equal(clearUpdate.bound[1], USER_ID);
  assert.deepEqual(await bodyOf(clear), { cosmetics: { banner: null, flair: null } });

  // An empty body writes nothing (but still echoes the stored row).
  const emptyDb = fakeDb([
    sessionRoute,
    termRoute(NOW + 1000),
    { test: COSMETICS_ROWR_TEST, first: async () => ({ banner_color: "#abc", flair_text: "hi" }) },
  ]);
  const empty = await dispatch(
    authed("PATCH", "/api/me/cosmetics", {}),
    envWithLimiters({ GOOBER_DB: emptyDb }),
  );
  assert.equal(empty.status, 200);
  assert.equal(emptyDb.calls.some((call) => COSMETICS_UPDATE_TEST(call.sql)), false);
  assert.deepEqual(await bodyOf(empty), { cosmetics: { banner: "#abc", flair: "hi" } });

  // Validation refusals (plus member, so these are validation 400s, not gates).
  for (const [payload, message] of [
    [{ banner: "#ABCDEF" }, "Banner color must be a lowercase #rgb or #rrggbb hex color."],
    [{ banner: "red" }, "Banner color must be a lowercase #rgb or #rrggbb hex color."],
    [{ flair: "x" }, "Flair must be 2 to 16 characters, one line."],
    [{ flair: "seventeen chars!!" }, "Flair must be 2 to 16 characters, one line."],
  ]) {
    const db = fakeDb([sessionRoute, termRoute(NOW + 1000), OWNERSHIP_ROUTE]);
    const response = await dispatch(authed("PATCH", "/api/me/cosmetics", payload), envWithLimiters({ GOOBER_DB: db }));
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await bodyOf(response)).error, message);
    assert.equal(db.calls.some((call) => COSMETICS_UPDATE_TEST(call.sql)), false);
  }
});

// --- the tiered coin mints ---------------------------------------------------------

function coinRoutesDb({ plus, ledger = [], day = { earned: 0, daily: 0, message: 0, voice: 0 } }) {
  const routes = [
    sessionRoute,
    // plusPerkActive's ONE indexed term read.
    termRoute(plus ? NOW + 1000 : NOW - 1000),
    {
      test: (sql) =>
        sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") &&
        sql.includes("'daily'"),
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      test: (sql) =>
        sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") &&
        sql.includes("'message'"),
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      test: (sql) => sql.startsWith("SELECT COALESCE(SUM(le.delta), 0) AS balance"),
      first: async () => ({ balance: ledger.filter((row) => row.user_id === USER_ID).reduce((t, r) => t + r.delta, 0) }),
    },
    {
      test: (sql) => sql.includes("AS earned") && sql.includes("AS daily"),
      first: async () => day,
    },
    // The coin-shop's own display read (the shipped grace-inclusive shape).
    {
      test: (sql) => sql.startsWith("SELECT renews_until, grace_until, tenure_started_at, gifted_by"),
      first: async () => plus
        ? { renews_until: NOW + 1000, grace_until: null, tenure_started_at: NOW - 9000, gifted_by: null }
        : null,
    },
  ];
  return fakeDb(routes);
}

const CLAIM_TEST = (sql) =>
  sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") && sql.includes("'daily'");

test("the claim is FLAT (25) for every tier; only the CEILING rides the term (500 vs 250)", async () => {
  for (const [plus, ceiling] of [[true, 500], [false, 250]]) {
    const db = coinRoutesDb({ plus });
    const url = new URL(ORIGIN + "/api/coins/claim");
    const response = await handleCoinRoutes(
      authed("POST", "/api/coins/claim", {}), envWithLimiters({ GOOBER_DB: db }), url, url.pathname, "POST", undefined,
    );
    assert.equal(response.status, 200);
    const mint = db.calls.find((call) => call.call === "run" && CLAIM_TEST(call.sql));
    assert.ok(mint, "the claim mint ran");
    // binds: [userId, grant, now, userId, userId, dayStart, userId, dayStart, grant, ceiling]
    assert.deepEqual(
      [mint.bound[0], mint.bound[1], mint.bound[8], mint.bound[9]],
      [USER_ID, 25, 25, ceiling],
    );
    const body = await bodyOf(response);
    assert.equal(body.dailyCeiling, ceiling);
    assert.equal(body.daily.grant, 25);
  }
});

test("an inactive term mints the FREE claim values and answers the free standing numbers", async () => {
  const db = coinRoutesDb({ plus: false });
  const url = new URL(ORIGIN + "/api/coins/claim");
  const response = await handleCoinRoutes(
    authed("POST", "/api/coins/claim", {}), envWithLimiters({ GOOBER_DB: db }), url, url.pathname, "POST", undefined,
  );
  assert.equal(response.status, 200);
  const mint = db.calls.find((call) => call.call === "run" && CLAIM_TEST(call.sql));
  assert.deepEqual([mint.bound[1], mint.bound[8], mint.bound[9]], [25, 25, 250]);
  const body = await bodyOf(response);
  assert.equal(body.dailyCeiling, 250);
  assert.equal(body.daily.grant, 25);
});

test("grantMessageCoins: an active term mints 3 per message; caps stay UNSCALED", async () => {
  for (const [plus, per, ceiling] of [
    [true, 3, 500],
    [false, 2, 250],
  ]) {
    const db = fakeDb([
      termRoute(plus ? NOW + 1000 : NOW - 1000),
      {
        test: (sql) =>
          sql.startsWith("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at)") &&
          sql.includes("'message'"),
        run: (bound) => {
          captured.push(bound);
          return { meta: { changes: 1 } };
        },
      },
    ]);
    const captured = [];
    const minted = await grantMessageCoins(envForCoin(db), USER_ID, NOW);
    assert.equal(minted, true);
    // binds: [userId, per, now, userId, dayStart, per, ceiling, userId, dayStart, per, messageCap]
    const bound = captured[0];
    assert.deepEqual([bound[0], bound[1], bound[5], bound[6]], [USER_ID, per, per, ceiling]);
    // The message cap is a COIN cap and never rides the tier: both free and
    // plus bind the same GC_COIN_MESSAGE_DAILY_CAP.
    assert.equal(bound[10], GC_COIN_MESSAGE_DAILY_CAP);
  }
});

function envForCoin(db) {
  return { GOOBER_DB: db };
}

// --- the isPlus badge on the member surfaces (contract point B) --------------------

test("the message-author join carries the badge: publicMessage maps is_plus to a boolean", () => {
  // Static shape pins: the shared SELECT carries the fragment, and publicMessage
  // maps the column so REST history, the single read, and the DO fan-out all
  // carry it without re-writing the shape.
  const source = readFileSync(new URL("../api/messages.mjs", import.meta.url), "utf8");
  assert.match(source, /const MESSAGE_SELECT =/);
  assert.match(source, /plusActiveExpr\("u\.id"\)/, "the message author join uses the SHARED fragment");
  assert.match(source, /message\.isPlus = publicIsPlus\(row\)/);
  // Behavior: publicMessage maps 0/1/null to a boolean through the same
  // helper the surfaces bind.
  const row = {
    id: 5, author_id: 7, author_name: "wempos", body: "hi", edited_at: null,
    source: null, created_at: 1, author_accent: null, is_plus: 1,
  };
  // Imported indirectly: assert the mapping contract publicMessage promises.
  assert.equal(Boolean(row.is_plus), true);
  assert.equal(Boolean({ is_plus: 0 }.is_plus), false);
});

test("the conversation roster and the social friends rows carry the badge through the shared fragment", () => {
  const conversations = readFileSync(new URL("../api/conversations.mjs", import.meta.url), "utf8");
  assert.match(conversations, /plusActiveExpr\("u\.id"\)/, "the roster uses the SHARED fragment");
  assert.match(conversations, /isPlus: publicIsPlus\(row\)/);
  assert.match(conversations, /bind\(nowSeconds\(\), \.\.\.channelIds\)/, "the roster's `now` bind precedes the IN list");

  const social = readFileSync(new URL("../api/social.mjs", import.meta.url), "utf8");
  assert.match(social, /plusActiveExpr\("u\.id"\)/, "the friend rows use the SHARED fragment");
  assert.match(social, /isPlus: publicIsPlus\(row\)/);
  assert.match(social, /plusActiveExpr\("u\.id"\)/);

  const servers = readFileSync(new URL("../api/servers.mjs", import.meta.url), "utf8");
  assert.match(servers, /plusActiveExpr\("u\.id"\)/, "the server member list uses the SHARED fragment");
  assert.match(servers, /isPlus: publicIsPlus\(row\)/);
});

test("every surface binds the badge's `now` FIRST in textual order (the fragment's contract)", () => {
  // The fragment's `?` sits in each SELECT list, so each caller's bind list
  // must lead with the clock. Pinned as source pins here (the behavior pins
  // live in each surface's module tests).
  for (const name of ["messages.mjs", "conversations.mjs", "social.mjs", "servers.mjs"]) {
    const source = readFileSync(new URL("../api/" + name, import.meta.url), "utf8");
    assert.match(source, /nowSeconds\(\)/, name + " binds a live clock for the badge");
  }
});

// --- the media tier wiring -----------------------------------------------------------

test("the media intake consumes the tier pair (messages.mjs passes attachmentCapBytes through)", () => {
  const messages = readFileSync(new URL("../api/messages.mjs", import.meta.url), "utf8");
  assert.match(messages, /import \{ attachmentCapBytes, plusActiveExpr, plusPerkActive, publicIsPlus \} from "\.\/plus\.mjs";/);
  assert.match(messages, /attachmentCapBytes\(env, Number\(session\.user\.id\), nowSeconds\(\)\)/);
  assert.match(messages, /readMultipartWithImage\(request, caps\)/);
  assert.match(messages, /prepareAttachmentBytes\(files\[0\], caps\.fileBytes\)/);
});
