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

// Wave 12 — the boost-tier surface (the 2026-11-19 slate): ONE additive
// read route (GET /api/servers/:id/boost-tier, riding api/boost-level.mjs's
// own resolver — zero new resolver logic) and ONE server-settings panel
// that gives the 0023 matrix its face. RED-first pins: the route's gate
// order and shared-404 idiom, the L0/L1/L2/L3 boundary payloads, the
// nextLevel derivation (honest at every boundary; L3 answers null), the
// levelPerks-null-at-L0 law, the payload-carried panel (the client NEVER
// mirrors the level table), the defaults-law auto-GET, the i18n sweep in
// all nine bundles, and the committed-range freeze pin (the wave-9/10/11
// lesson — the diff runs base..tip, never a HEAD-open leg).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const SETTINGS_UI = read("public/js/ui/settings.js");
const enData = JSON.parse(read("public/locales/en.json"));

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];

// The wave's NEW keys — single strings, no plural arms (the slate's law).
const NEW_KEYS = [
  "gc.settings.boostTier.heading",
  "gc.settings.boostTier.tierBadge",
  "gc.settings.boostTier.boostsLine",
  "gc.settings.boostTier.nextLabel",
  "gc.settings.boostTier.progress",
  "gc.settings.boostTier.topLevel",
  "gc.settings.boostTier.capsLine",
  "gc.settings.boostTier.perks.heading",
  "gc.settings.boostTier.perks.stream",
  "gc.settings.boostTier.perks.audio",
  "gc.settings.boostTier.perks.upload",
  "gc.settings.boostTier.perks.stage",
];

// --- the route: live pins against a fake GOOBER_DB ------------------------------

const importRoute = async () => (await import("../api/boost-tier.mjs")).handleBoostTierRoutes;

const SHARED_UNKNOWN_404 = "This server does not exist or you cannot view it.";
const membershipRow = { role: "member" };

// Ordered fake DB: the session read, the membership gate, and the resolver's
// one boosts read answer by SQL shape (the bookmarks-module idiom).
function tierDb(routes, { limiter } = {}) {
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
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? route.first(statement.bound) : null;
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.run ? route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
  };
  const env = {
    GOOBER_DB: db,
    GC_READ_RATE_LIMITER: {
      limit: async ({ key }) => {
        calls.push({ call: "limit", key });
        return { success: limiter ? limiter(key) : true };
      },
    },
  };
  return env;
}

const SESSION_TEST = (sql) => Boolean(sql && sql.includes("FROM sessions"));
const MEMBERSHIP_TEST = (sql) => Boolean(sql && sql.includes("gc_server_members") && sql.includes("role"));
const BOOSTS_TEST = (sql) => Boolean(sql && sql.includes("SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1"));

function fakeSessionRow() {
  return {
    token_hash: "x".repeat(64),
    user_id: 7,
    csrf_token: "y".repeat(24),
    expires_at: 4102444800 + 3600,
    username: "wempos",
    role: "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
}

// The signed-in shape (the servers-module idiom): a real Origin + CSRF pair
// so requireCsrf passes on the GET.
function tierRequest(path) {
  return new Request("http://localhost" + path, {
    method: "GET",
    headers: {
      Cookie: "goober_session=t" + "1".repeat(39),
      Origin: "http://localhost",
      "X-CSRF-Token": "y".repeat(24),
    },
  });
}

async function tierDispatch(path, env) {
  const handleBoostTierRoutes = await importRoute();
  const request = tierRequest(path);
  const url = new URL(request.url);
  try {
    return await handleBoostTierRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    return error.status
      ? new Response(JSON.stringify({ error: error.message }), { status: error.status })
      : null;
  }
}

const bodyOf = async (response) => JSON.parse(await response.text());

const withBoosts = (boosts) => ({
  test: BOOSTS_TEST,
  first: async () => ({ boosts }),
});

test("GET /api/servers/:id/boost-tier answers boosts, level, caps, levelPerks, nextLevel", async () => {
  const env = tierDb([
    { test: SESSION_TEST, first: async () => fakeSessionRow() },
    { test: MEMBERSHIP_TEST, first: async () => membershipRow },
    withBoosts(7),
  ]);
  const response = await tierDispatch("/api/servers/1/boost-tier", env);
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["boosts", "caps", "level", "levelPerks", "nextLevel"],
    "the envelope carries exactly the five seats the slate names",
  );
  assert.equal(payload.boosts, 7);
  assert.equal(payload.level, 2);
  assert.deepEqual(payload.caps, { emoji: 150, stickers: 30, soundboard: 36 });
  assert.equal(payload.levelPerks.streamHeight, 1440);
});

test("the gate order rides welcome-card's idiom: session -> membership -> limiter -> resolver", async () => {
  const env = tierDb([
    { test: SESSION_TEST, first: async () => fakeSessionRow() },
    { test: MEMBERSHIP_TEST, first: async () => membershipRow },
    withBoosts(14),
  ]);
  const response = await tierDispatch("/api/servers/1/boost-tier", env);
  assert.equal(response.status, 200);
  const order = env.GOOBER_DB.calls.map((call) => (call.call === "limit" ? "limit" : call.call));
  assert.deepEqual(order, ["first", "first", "limit", "first"],
    "membership pre-read gates BEFORE the limiter and the resolver read");
  // The wall's own view is the vendor's hashed actor (api/vendor/http.mjs
  // sha256's "scope:actor"); the RAW actor identity — the server + member
  // bucket the route asks for — is a source-read pin (the vendor's wall is
  // never re-keyed by a test).
  const limitCall = env.GOOBER_DB.calls.find((call) => call.call === "limit");
  assert.ok(limitCall, "the read bucket fires exactly once, after the membership gate");
  const resolverCall = env.GOOBER_DB.calls.find((call) => BOOSTS_TEST(call.sql));
  assert.equal(resolverCall.bound[0], 1, "the resolver read rides its one PK bind");
});

test("a non-member answers the shared unknown-server 404 and reads NOTHING behind the gate", async () => {
  const env = tierDb([
    { test: SESSION_TEST, first: async () => fakeSessionRow() },
    { test: MEMBERSHIP_TEST, first: async () => null }, // the wrong-server / non-member arm
  ]);
  const response = await tierDispatch("/api/servers/99/boost-tier", env);
  assert.equal(response.status, 404);
  assert.equal((await bodyOf(response)).error, SHARED_UNKNOWN_404);
  assert.equal(env.GOOBER_DB.calls.filter((call) => BOOSTS_TEST(call.sql)).length, 0,
    "no tier read ever fires for an outsider — no existence oracle");
});

test("a denied read bucket answers 429 before the resolver runs", async () => {
  const env = tierDb([
    { test: SESSION_TEST, first: async () => fakeSessionRow() },
    { test: MEMBERSHIP_TEST, first: async () => membershipRow },
    withBoosts(2),
  ], { limiter: () => false });
  const response = await tierDispatch("/api/servers/1/boost-tier", env);
  assert.equal(response.status, 429);
  assert.equal(env.GOOBER_DB.calls.filter((call) => BOOSTS_TEST(call.sql)).length, 0,
    "no bytes behind the wall (the media-module d3 law)");
});

test("unknown paths fall through to the worker's handler chain (undefined, no 404 of its own)", async () => {
  const handleBoostTierRoutes = await importRoute();
  const env = tierDb([]);
  for (const [method, path] of [["POST", "/api/servers/1/boost-tier"], ["GET", "/api/servers/1/boost-tie"], ["GET", "/api/servers/abc/boost-tier"]]) {
    const request = new Request("http://localhost" + path, { method });
    const url = new URL(request.url);
    const outcome = await handleBoostTierRoutes(
      request, env, url, url.pathname, method, undefined,
    );
    assert.equal(outcome, undefined, `${method} ${path} is not this module's route`);
  }
});

test("the route module writes NOTHING — one read, no INSERT/UPDATE/DELETE arm", async () => {
  const source = read("api/boost-tier.mjs");
  assert.doesNotMatch(source, /\.run\(/, "no run() arm in the route module");
  assert.doesNotMatch(source, /INSERT INTO|UPDATE |DELETE FROM/, "the route mints nothing");
  assert.match(source, /path\.match\(\/\^\\\/api\\\/servers\\\/\(0\|\[1-9\]\[0-9\]\*\)\\\/boost-tier\$\/\)/);
  assert.match(source, /rateLimit\(request, env, "read", "boost-tier:" \+ serverId \+ ":" \+ userId\)/,
    "the raw read bucket keys server + member (the vendor wall hashes it)");
  assert.match(source, /export async function handleBoostTierRoutes\(request, env, url, path, method, ctx\)/,
    "the module rides the shared dispatch-chain shape");
});

// --- the resolver boundaries ride UNTOUCHED (api/boost-level.mjs, never edited) --

const BOOST_BOUNDARIES = [
  [0, 0, 2],
  [1, 0, 2],
  [2, 1, 7],
  [6, 1, 7],
  [7, 2, 14],
  [13, 2, 14],
  [14, 3, null],
  [9999, 3, null],
];

test("nextLevel derives honestly at every floor boundary — L3 answers null (payload-carried)", async () => {
  for (const [boosts, level, nextBoosts] of BOOST_BOUNDARIES) {
    const env = tierDb([
      { test: SESSION_TEST, first: async () => fakeSessionRow() },
      { test: MEMBERSHIP_TEST, first: async () => membershipRow },
      withBoosts(boosts),
    ]);
    const response = await tierDispatch("/api/servers/1/boost-tier", env);
    assert.equal(response.status, 200);
    const payload = await bodyOf(response);
    assert.equal(payload.level, level, `${boosts} boosts -> level ${level}`);
    if (nextBoosts === null) {
      assert.equal(payload.nextLevel, null, `${boosts} boosts -> nextLevel null (L3's own law)`);
    } else {
      assert.equal(payload.nextLevel.level, level + 1, `${boosts} boosts -> next level ${level + 1}`);
      assert.equal(payload.nextLevel.boosts, nextBoosts,
        `${boosts} boosts -> the next floor is ${nextBoosts}`);
    }
  }
});

test("level 0 answers the resolver's base caps and levelPerks null — the panel paints the base face", async () => {
  const env = tierDb([
    { test: SESSION_TEST, first: async () => fakeSessionRow() },
    { test: MEMBERSHIP_TEST, first: async () => membershipRow },
    withBoosts(0),
  ]);
  const response = await tierDispatch("/api/servers/1/boost-tier", env);
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.level, 0);
  assert.equal(payload.levelPerks, null);
  assert.deepEqual(payload.caps, { emoji: 50, stickers: 5, soundboard: 8 });
  assert.equal(payload.nextLevel.boosts, 2, "level 0 answers the level-1 entry (2 boosts)");
});

test("api/boost-level.mjs stays byte-frozen against the wave — the route CONSUMES it", async () => {
  const resolverSource = read("api/boost-level.mjs");
  assert.match(resolverSource, /export async function serverBoostTier\(env, serverId\)/);
  assert.match(resolverSource, /levelPerks: entry/);
  assert.match(resolverSource, /Math\.max\(LEVEL_BASE_CAPS\[key\]/);
});

// --- the client panel: payload-carried, one auto-GET, seats not numerals --------

test("the settings page carries the boost-tier panel beside the welcome-card precedent", () => {
  assert.match(SETTINGS_UI, /function boostTierPanel\(serverId\)/);
  assert.match(SETTINGS_UI, /nodes\.push\(boostTierPanel\(serverId\)\);/,
    "the panel rides renderServerSettings's manageGate build (the additive nodes.push registration, the owner-seat idiom)");
});

test("the panel's ONE wire is its own open — the defaults law, one GET per visit", () => {
  const seats = SETTINGS_UI.match(/api\(`\/api\/servers\/\$\{serverId\}\/boost-tier`\)/g)?.length ?? 0;
  assert.equal(seats, 1, "exactly one api() seat: the tier read, fired on the panel's own open");
  assert.match(SETTINGS_UI, /api\(`\/api\/servers\/\$\{serverId\}\/boost-tier`\)\.then\(/,
    "the GET is the panel's own auto-load, not a member-initiated act");
  assert.doesNotMatch(SETTINGS_UI, /method: "(?:POST|PUT|PATCH|DELETE)", body: \{[^}]*boost/i,
    "no write arm exists behind the panel");
});

test("the panel mirrors nothing — every painted number rides the payload", () => {
  assert.doesNotMatch(SETTINGS_UI, /(?:import|const|export const)[^\n]*GC_BOOST_LEVELS/,
    "no client mirror of the level table (the payload is the single source)");
  assert.doesNotMatch(SETTINGS_UI, /boosts (?:>=|>) 2\b/, "no prose threshold");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.tierBadge", \{ level: payload\?\.level \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.boostsLine", \{ boosts: payload\?\.boosts \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.capsLine", \{[^}]*emoji: payload\?\.caps\?\.emoji, stickers: payload\?\.caps\?\.stickers, soundboard: payload\?\.caps\?\.soundboard \}[)\s]*\)/);
});

test("the progress seat rides the wave-10 idiom; L3 paints the top level instead (nextLevel null)", () => {
  assert.match(SETTINGS_UI, /const nextLevel = payload\?\.nextLevel \?\? null;/,
    "the null branch keys on the payload's own null — no invented falsy arm");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.nextLabel", \{ level: nextLevel\.level \}\)/,
    "L0/L1/L2 paint the next floor's label from the payload");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.progress", \{ progress: payload\.boosts, goal: nextLevel\.boosts \}\)/,
    "the {{progress}}/{{goal}} neutral-seat idiom (gc.economy.quests.progress's shape)");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.topLevel"\)/,
    "nextLevel null seats the top-level line — no progress bar at L3");
});

test("levelPerks paints as-is from the payload and stays silent at level 0 (the null-entry law)", () => {
  assert.match(SETTINGS_UI, /const perks = payload\?\.levelPerks \?\? null;/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.stream", \{ height: perks\.streamHeight, fps: perks\.streamFps \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.audio", \{ bitrate: perks\.audioBitrate \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.upload", \{ size: perks\.uploadBytes \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.stage", \{ seats: perks\.stageSeats \}\)/);
  assert.doesNotMatch(SETTINGS_UI, /Math\.(?:ceil|min|max|round|floor)\([^)]*perks/i,
    "the resolver's numbers paint unrounded, never recomputed client-side");
});

test("the panel's refusals paint the server's string verbatim (G-2) and no coin surface exists", () => {
  const panelSource = SETTINGS_UI.slice(SETTINGS_UI.indexOf("function boostTierPanel"));
  assert.match(panelSource, /errorLine\.textContent = error\.message;/
, "the shared 404 / 429 family paints verbatim");
  assert.doesNotMatch(panelSource, /coin|ledger/, "the sink law: no coins behind the tier");
});

// --- the append shape (T-WAVE-12 HIGH): the L0/L3 seats skip, never stringify ---

// Native ParentNode.append STRINGIFIES its arguments — a bare null child
// paints the literal "null". h()'s children ride appendChildren's falsy-skip
// law (public/js/core/dom.js:79-83, null/undefined/false skipped); the panel's
// own append site must carry THAT law. No DOM lib runs here (jsdom is banned;
// no new deps), so the pin is the append shape itself: the well's only append
// carries ONE Node-shaped seat variable, gated by the falsy-skip skip — the
// optional seats (the L3 topLevel replacement, the progress bar's L3 absence,
// the levelPerks arm and its four perk lines) are built into the seats array
// and skipped, never handed to append.
test("the panel's append rides the appendChildren falsy-skip law — no bare null seat stringifies", () => {
  const panelSource = SETTINGS_UI.slice(SETTINGS_UI.indexOf("function boostTierPanel"),
    SETTINGS_UI.indexOf("function renderServerSettings"));
  // The seats are gathered first (h() calls only), the optional arms land as
  // null in the ARRAY — where falsy-skip is legal — never as append arguments.
  assert.match(panelSource, /const seats = \[/,
    "the seats gather first, the optional arms answering null INSIDE the array");
  assert.match(panelSource, /if \(seat === null \|\| seat === undefined\) continue;/,
    "the falsy-skip law (dom.js:80) lives at the append site");
  const appends = panelSource.match(/well\.append\([^)]*\)/g) ?? [];
  assert.equal(appends.length, 1, `one append site (found ${appends.length})`);
  assert.match(appends[0], /well\.append\(seat\)/,
    "the append carries one Node-shaped seat variable, never a literal");
  assert.doesNotMatch(panelSource, /append\([\s\S]{0,200}?\?\s*h\(/,
    "no inline ternary hands a falsy arm to append — the arms answer inside the seats array");
  assert.doesNotMatch(panelSource, /append\(\s*(?:null|undefined)\b/,
    "no bare null/undefined appends (they stringifies as the word 'null')");
});

// --- the freeze pin (wave-9 lesson, fourth instance: committed range only) --------

// LANE_BASE = bdd723d (main tip at lane open, the wave-12 slate commit);
// LANE-TIP is the wave's OWN feat commit — the lead retargets the
// placeholder after the commit (the wave-10/11 retarget seat).
test("diff scope: the lane touches NO frozen api module and wires worker.mjs at two lines", () => {
  const LANE_BASE = "bdd723d";
  const LANE_TIP = "400c3b5"; // the wave's OWN feat commit (the retarget seat)
  let apiTouched;
  let workerStat;
  try {
    apiTouched = execFileSync("git", ["diff", "--name-only", LANE_BASE, LANE_TIP, "--", "api"],
      { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
      .filter((path) => path && path !== "api/boost-tier.mjs");
    workerStat = execFileSync("git", ["diff", "--numstat", LANE_BASE, LANE_TIP, "--", "worker.mjs"],
      { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    // The uncommitted handback (the placeholder tip) or a non-git tree — the
    // lead retargets the tip and the fingerprint activates there (the
    // wave-10/11 precedent's retarget seat).
    return;
  }
  assert.deepEqual(apiTouched, [], "every OTHER api module stays byte-frozen");
  const [added, removed] = workerStat.split("\t");
  assert.equal(Number(added), 2, "worker.mjs pins ONLY the import + dispatch line additions");
  assert.equal(Number(removed), 0);
});

// --- the i18n sweep --------------------------------------------------------------

test("every wave key is en-seated real copy", () => {
  for (const key of NEW_KEYS) {
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0, `${key} is en-seated real copy`);
  }
});

test("the key scheme rides the dotted gc.* law — single strings, no plural arms", () => {
  const scheme = /^gc(\.[a-z][a-zA-Z0-9]*)+$/;
  for (const key of NEW_KEYS) assert.match(key, scheme, `the scheme rides: ${key}`);
  for (const key of NEW_KEYS) assert.ok(!/_(one|other|few|many|zero|two)$/.test(key), `${key} is no plural arm`);
});

test("the eight staged bundles carry every wave key TRANSLATED", () => {
  for (const langKey of STAGED) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    for (const key of NEW_KEYS) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
      assert.notEqual(value, enData[key], `${langKey} carries ${key} TRANSLATED — no en placeholder`);
    }
  }
});
