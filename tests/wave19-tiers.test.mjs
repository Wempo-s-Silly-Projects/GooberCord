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

// Wave 19 — the upload tiers (the 2026-11-19 slate): the owner's BLESSED
// matrix (constants.mjs GC_MINI_ATTACHMENT_BYTES 50 MiB /
// GC_PLUS_ATTACHMENT_BYTES 1 GiB + the request pairs) becomes what the ROUTES
// admit THROUGH the single-shot intake — free never gains a byte, Mini rides
// the 50 MiB pair, Plus keeps the 20 MiB single-shot beside its lane. The 1
// GiB LANE-ceiling arm OPENS in wave-20 (the chunk byte leg rode to R2 —
// GC_UPLOAD_LANE_MAX_BYTES retired, the lane ceiling is GC_PLUS_ATTACHMENT_
// BYTES exactly, the commit re-verifies the tier); the pins below retarget
// to the open truth. The client mirrors pin computed-equality against
// constants.mjs BOTH ways (the wave-14 C1 lesson) and me.plusTier seats the
// composer's tier face. Backend wave (wave-12 precedent: additive wiring, no
// verb mutations, the untouched modules byte-frozen).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { handleMediaRoutes } from "../api/media.mjs";
import { handleAccountRoutes } from "../api/accounts.mjs";
import { handleUploadRoutes, UPLOAD_TIER_ERROR } from "../api/uploads.mjs";
import { attachmentCapBytes, singleShotAttachmentCaps } from "../api/plus.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import * as uploadsModule from "../public/js/ui/uploads.js";
import {
  GC_MINI_ATTACHMENT_BYTES,
  GC_PLUS_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const ORIGIN = "http://localhost";
const USER_ID = 7;
const NOW = nowSeconds();

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
// The wave's touched modules (the freeze pin's exempt list — exactly the
// diff scope; every OTHER module must stay byte-identical across the range).
const TOUCHED = [
  "api/plus.mjs",
  "api/media.mjs",
  "api/messages.mjs",
  "api/accounts.mjs",
  "public/js/ui/uploads.js",
  "public/js/ui/chat.js",
  "tests/plus-perks.test.mjs",
  "tests/wave14-uploads.test.mjs",
  "tests/wave19-tiers.test.mjs",
];

const UPLOADS_UI = read("public/js/ui/uploads.js");
const CONSTANTS_TEXT = read("constants.mjs");
const enData = JSON.parse(read("public/locales/en.json"));

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The ordered fake D1 (the uploads-lane/media-module conventions verbatim).
function fakeDb(routes = []) {
  const calls = [];
  let nextRowId = 1000;
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => { statement.bound = values; return statement; };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async (record = true) => {
        if (record) calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
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
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const PLUS_TIER_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ?");
const tierRoute = (tier, renews = NOW + 3600) => ({
  test: PLUS_TIER_TEST,
  first: async () => ({ renews_until: renews, tier }),
});

const sessionRoute = (row) => ({ test: SESSION_READ_TEST, first: async () => row });

async function sessionFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: USER_ID,
    csrf_token: csrf,
    expires_at: NOW + 3600,
    username: "wempos",
    role: "member",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return { row, headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf } };
}

async function dispatchMedia(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMediaRoutes(request, env, url, url.pathname, request.method.toUpperCase(), undefined);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

async function dispatchUploads(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleUploadRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

function multipartRequest(path, bytes, headers = {}) {
  const form = new FormData();
  form.append("image", new File([bytes], "photo.png"));
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { Origin: ORIGIN, ...headers },
    body: form,
  });
}

// The smallest valid PNG shape stretched across one huge IDAT chunk (the
// media-module convention: the sanitizer keeps a big IDAT verbatim).
function pngChunk(type, data = new Uint8Array(0)) {
  const out = new Uint8Array(12 + data.length);
  const length = data.length;
  out[0] = (length >>> 24) & 0xff;
  out[1] = (length >>> 16) & 0xff;
  out[2] = (length >>> 8) & 0xff;
  out[3] = length & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}
function pngImage(totalBytes) {
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
  ];
  if (totalBytes > 57) parts.push(pngChunk("IDAT", new Uint8Array(totalBytes - 57)));
  parts.push(pngChunk("IEND"));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function partRequest(seq, bytes, extra = {}) {
  const form = new FormData();
  form.append("seq", String(seq));
  if (extra.uploadId) form.append("uploadId", extra.uploadId);
  if (extra.size) form.append("size", String(extra.size));
  form.append("chunk", new Blob([bytes]));
  return new Request(ORIGIN + "/api/uploads/chunks", {
    method: "POST",
    headers: { Origin: ORIGIN, ...extra.headers },
    body: form,
  });
}
const LANE_PART = new Uint8Array(1_024_000);
// The wave-20 bucket fake (the tiny { put, get, head, delete } store).
function wave20Bucket() {
  const calls = [];
  return {
    calls,
    async put(key, value) {
      calls.push({ op: "put", key });
      await new Response(value).arrayBuffer();
    },
    async get() { return null; },
    async head() { return null; },
    async delete(key) { calls.push({ op: "delete", key }); },
  };
}

// --- the resolver truth (the blessed pairs, per term) --------------------------

test("attachmentCapBytes answers the blessed pairs per term", async () => {
  const dbFor = (row) => ({
    GOOBER_DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
  });
  assert.deepEqual(
    await attachmentCapBytes(dbFor(null), USER_ID, NOW),
    { fileBytes: MAX_ATTACHMENT_BYTES, requestBytes: MAX_ATTACHMENT_BYTES + 512 * 1024, tier: null },
    "no row is the free pair");
  assert.deepEqual(
    await attachmentCapBytes(dbFor({ renews_until: NOW + 1, tier: "mini" }), USER_ID, NOW),
    { fileBytes: GC_MINI_ATTACHMENT_BYTES, requestBytes: GC_MINI_ATTACHMENT_BYTES + 512 * 1024, tier: "mini" });
  assert.deepEqual(
    await attachmentCapBytes(dbFor({ renews_until: NOW + 1, tier: "plus" }), USER_ID, NOW),
    { fileBytes: GC_PLUS_ATTACHMENT_BYTES, requestBytes: GC_PLUS_ATTACHMENT_BYTES + 512 * 1024, tier: "plus" });
  assert.equal(
    (await attachmentCapBytes(dbFor({ renews_until: NOW + 1, tier: null }), USER_ID, NOW)).tier,
    "plus", "the legacy NULL tier keeps reading full Goober+");
  assert.equal(
    (await attachmentCapBytes(dbFor({ renews_until: NOW - 1, tier: "plus" }), USER_ID, NOW)).tier,
    null, "a grace window rides the FREE pair");
});

// The SINGLE-SHOT cap mapping: full-plus members ride the lane for anything
// above 20 MiB, so their single-shot window stays the free pair; Mini gets
// exactly the blessed 50 MiB pair; free stays the free pair.
test("singleShotAttachmentCaps maps the tier to the single-shot pair", () => {
  assert.deepEqual(singleShotAttachmentCaps({ fileBytes: MAX_ATTACHMENT_BYTES, requestBytes: MAX_ATTACHMENT_BYTES + 512 * 1024, tier: null }),
    { fileBytes: MAX_ATTACHMENT_BYTES, requestBytes: MAX_ATTACHMENT_BYTES + 512 * 1024 });
  assert.deepEqual(singleShotAttachmentCaps({ fileBytes: GC_MINI_ATTACHMENT_BYTES, requestBytes: GC_MINI_ATTACHMENT_BYTES + 512 * 1024, tier: "mini" }),
    { fileBytes: GC_MINI_ATTACHMENT_BYTES, requestBytes: GC_MINI_ATTACHMENT_BYTES + 512 * 1024 });
  assert.deepEqual(singleShotAttachmentCaps({ fileBytes: GC_PLUS_ATTACHMENT_BYTES, requestBytes: GC_PLUS_ATTACHMENT_BYTES + 512 * 1024, tier: "plus" }),
    { fileBytes: MAX_ATTACHMENT_BYTES, requestBytes: MAX_ATTACHMENT_BYTES + 512 * 1024 },
    "a full-plus member's SINGLE-SHOT window stays 20 MiB — anything larger rides the lane");
});

// --- route-level size gates (fakeDb, the media-module conventions) -------------

test("a MINI-term uploader rides the single-shot 50 MiB admit: exactly at the cap is admitted", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), tierRoute("mini")]);
  const response = await dispatchMedia(
    multipartRequest("/api/attachments", pngImage(GC_MINI_ATTACHMENT_BYTES), headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 201, `the blessed cap admits (got ${response.status}: ${await response.text()})`);
  assert.ok(db.calls.some((call) => call.sql?.includes?.("gc_plus_state")), "the route resolves the tier");
});

test("a MINI-term uploader one byte past the cap answers the tier's own 413 verbatim", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), tierRoute("mini")]);
  const response = await dispatchMedia(
    multipartRequest("/api/attachments", new Uint8Array(GC_MINI_ATTACHMENT_BYTES + 1), headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "Images must be 50 MiB or smaller.");
  assert.deepEqual(db.calls.filter((call) => call.call === "batch"), [], "nothing was written");
});

test("a free member never gains a byte: one past 20 MiB answers the free 413 verbatim", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatchMedia(
    multipartRequest("/api/attachments", new Uint8Array(MAX_ATTACHMENT_BYTES + 1), headers),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "Images must be 20 MiB or smaller.");
});

// The 1 GiB lane arm OPENED (wave-20): the byte leg rides GC_MEDIA, so a
// full-plus first part at the tier's own ceiling stages through the bucket.
test("the lane's ceiling is the tier's own bound: 1 GiB first part stages for full-plus", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), tierRoute("plus")]);
  const r2 = wave20Bucket();
  const response = await dispatchUploads(
    partRequest(0, LANE_PART, { size: String(GC_PLUS_ATTACHMENT_BYTES), headers }),
    envWithLimiters({ GOOBER_DB: db, GC_MEDIA: r2 }),
  );
  assert.equal(response.status, 201,
    `the 1 GiB lane arm is OPEN — GC_PLUS_ATTACHMENT_BYTES admits (got ${response.status})`);
  assert.match(await response.json().then((body) => body.uploadId), /^[A-Za-z0-9_-]{12}$/);
  assert.ok(r2.calls.some((call) => call.op === "put"), "the first part staged in the bucket");
});

test("the lane refuses one past GC_PLUS_ATTACHMENT_BYTES (first part AND commit, full-plus)", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), tierRoute("plus")]);
  const first = await dispatchUploads(
    partRequest(0, LANE_PART, { size: String(GC_PLUS_ATTACHMENT_BYTES + 1), headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(first.status, 400);
  assert.equal((await first.json()).error, "That file size is not a large upload.");

  const commit = await dispatchUploads(
    new Request(ORIGIN + "/api/uploads/laney19Lane1/commit", {
      method: "POST",
      headers: { Origin: ORIGIN, ...headers },
      body: JSON.stringify({ size: GC_PLUS_ATTACHMENT_BYTES + 1 }),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(commit.status, 400);
  assert.equal((await commit.json()).error, "That file size is not a large upload.");
});

test("a Mini member never reaches the lane (the 403 stays verbatim)", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), tierRoute("mini")]);
  const response = await dispatchUploads(
    partRequest(0, LANE_PART, { size: String(GC_MINI_ATTACHMENT_BYTES), headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, UPLOAD_TIER_ERROR);
});

// --- the client mirrors: computed equality BOTH WAYS ---------------------------

test("the client mirrors equal constants.mjs BOTH ways (the C1 law)", () => {
  const ui = UPLOADS_UI;
  const mirrorFree = Number(ui.match(/export const UI_ATTACHMENT_FREE_MAX = (\d+);/)?.[1]);
  const mirrorMini = Number(ui.match(/export const UI_ATTACHMENT_MINI_MAX = (\d+);/)?.[1]);
  const mirrorPlus = Number(ui.match(/export const UI_ATTACHMENT_PLUS_MAX = (\d+);/)?.[1]);
  const numeral = (match) => Number(match?.[1].replaceAll("_", ""));
  const backendMini = numeral(CONSTANTS_TEXT.match(/export const GC_MINI_ATTACHMENT_BYTES = ([\d_]+);/));
  const backendPlus = numeral(CONSTANTS_TEXT.match(/export const GC_PLUS_ATTACHMENT_BYTES = ([\d_]+);/));
  // The lane mirror is COMPUTED from the tier mirror (no numeral literal to
  // extract — wave-20 opened the ceiling to the tier's own bound).
  const laneMirrorSeats = ui.match(/export const UI_UPLOAD_LANE_MAX_BYTES = UI_ATTACHMENT_PLUS_MAX;/);
  // forward: mirror EQUALS the extracted backend literal;
  // backward: the backend literal EQUALS the mirror (never an invented number).
  assert.equal(mirrorFree, MAX_ATTACHMENT_BYTES);
  assert.equal(mirrorMini, backendMini);
  assert.equal(mirrorPlus, backendPlus);
  assert.ok(laneMirrorSeats, "the lane mirror seats the tier mirror's number");
  assert.equal(backendMini, mirrorMini);
  assert.equal(backendPlus, mirrorPlus);
  assert.equal(backendPlus, 1_073_741_824);
  assert.equal(backendMini, 52_428_800);
});

test("the lane mirror rides the tier's own 1 GiB bound (wave-20)", () => {
  assert.match(UPLOADS_UI, /export const UI_UPLOAD_LANE_MAX_BYTES = UI_ATTACHMENT_PLUS_MAX;/,
    "the lane bound's mirror rides the tier mirror, computed");
  assert.doesNotMatch(CONSTANTS_TEXT, /GC_UPLOAD_LANE_MAX_BYTES/,
    "the backend's retired 125 MiB arm stays retired");
  assert.doesNotMatch(UPLOADS_UI, /131072000/,
    "the client mirror never carries the retired bound");
});

test("the lane predicate is tier-aware inside the tier's own ceiling", () => {
  assert.equal(uploadsModule.ridesChunkLane(MAX_ATTACHMENT_BYTES + 1, "plus"), true,
    "the lane opens just past 20 MiB for full-plus");
  assert.equal(uploadsModule.ridesChunkLane(GC_PLUS_ATTACHMENT_BYTES, "plus"), true,
    "the lane opens to exactly the tier's ceiling (1 GiB) for full-plus");
  assert.equal(uploadsModule.ridesChunkLane(GC_PLUS_ATTACHMENT_BYTES + 1, "plus"), false,
    "past the tier ceiling is no door — the free 20 MiB cap refused it anyway");
  assert.equal(uploadsModule.ridesChunkLane(GC_MINI_ATTACHMENT_BYTES, "mini"), false,
    "Mini never rides the lane");
  assert.equal(uploadsModule.ridesChunkLane(MAX_ATTACHMENT_BYTES + 1, null), false,
    "free never rides the lane");
});

test("the composer wires the tier through the lane predicate", () => {
  const CHAT = read("public/js/ui/chat.js");
  assert.match(CHAT, /ridesChunkLane\(file\.size,\s*laneTier\)/,
    "the lane door opens only for the file's tier");
  assert.match(CHAT, /const laneTier = /,
    "the tier is computed once beside the tierCap");
  assert.match(CHAT, /if \(file\.size > UI_UPLOAD_LANE_MAX_BYTES\)/,
    "the tier-ceiling lane bound keeps its own refusal beside the tier cap");
  assert.match(CHAT, /UI_ATTACHMENT_PLUS_MAX\s*\n?\s*: laneTier === "mini"\s*\?\s*UI_ATTACHMENT_MINI_MAX/,
    "the tier cap paints the tier's own ceiling");
});


// --- the /me tier seat (wave-19): route-level pins, the c23 wiring-gap class

// The /me seeding's OWN named-bind read (the :uid shape the accent pair's
// idiom rides) — never the :? positional shape plusPerkActive uses, so the
// pin proves the route runs the wave's read, not an old caller's.
const PLUS_TIER_NAMED_TEST = (sql) => sql.includes("FROM gc_plus_state WHERE user_id = :uid");

async function dispatchAccounts(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleAccountRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 });
}

test("GET /api/me seats the tier of an active term (the composer's laneTier reads it)", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), {
    test: PLUS_TIER_NAMED_TEST,
    first: async () => ({ active: 1, plusTier: "mini" }),
  }]);
  const response = await dispatchAccounts(
    new Request(ORIGIN + "/api/me", { headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  assert.equal(body.user.plusTier, "mini", "the active term's tier paints");
  assert.equal(body.user.isPlus, true, "the strict-active badge keeps its answer");
  // The unrouted accent read answers null — the fold's shape is
  // { accentColor: null, tagline: null } (userAccentColorTagline(null)),
  // keys present with null values, never absent keys (deslop-w19: the
  // tautology `/^|^$/` proves nothing, so the pin asserts the real shape).
  assert.deepEqual({ accentColor: body.user.accentColor, tagline: body.user.tagline },
    { accentColor: null, tagline: null },
    "an unrouted accent read answers the null-shaped fold");
});

test("GET /api/me seats plusTier :now strictly — a lapsed term adds no key", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row), {
    test: PLUS_TIER_NAMED_TEST,
    first: async () => ({ active: 0, plusTier: "mini" }),
  }]);
  const response = await dispatchAccounts(
    new Request(ORIGIN + "/api/me", { headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  assert.equal(body.user.isPlus, false, "the strict-active law keeps the badge off");
  assert.equal("plusTier" in body.user, false,
    "a lapsed term adds no plusTier key (the absence idiom)");
});

test("GET /api/me runs the wave's tier read (the SQL carries tier AS plusTier)", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([sessionRoute(row)]);
  const response = await dispatchAccounts(
    new Request(ORIGIN + "/api/me", { headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(await response.text());
  assert.equal("plusTier" in body.user, false,
    "no row at all also adds no key");
  const tierRead = db.calls.find((call) => call.call === "first" && /tier AS plusTier/.test(call.sql));
  assert.ok(tierRead, "the /me route runs the wave's own additive read");
});

// --- the tier-informed refusal copy stays seated ×9 ----------------------------

test("the reused size-refusal key rides en + the 8 REAL translations", () => {
  const staged = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
  for (const lang of staged) {
    const bundle = JSON.parse(read(`public/locales/${lang}.json`));
    const value = bundle["gc.chat.attach.tooLarge"];
    assert.equal(typeof value, "string", `${lang} seats gc.chat.attach.tooLarge`);
    assert.ok(value.length > 0 && value !== enData["gc.chat.attach.tooLarge"],
      `${lang} carries gc.chat.attach.tooLarge TRANSLATED`);
  }
  assert.match(enData["gc.chat.attach.tooLarge"], /\{\{mib\}\}/);
});

// --- the freeze (the wave-9 lesson; the c25 probe-of-the-probe shape) ----------

// LANE_BASE = 100cf8b (main tip at lane open, the wave-19 slate commit).
// LANE_TIP = the wave's own committed feat tip — the lead retargets the
// placeholder at commit time; until then the placeholder diffs the base and
// the source pins carry the freeze.
test("freeze: every module outside the wave's touched set stays byte-identical", () => {
  const LANE_BASE = "100cf8b";
  const LANE_TIP = "536d23d";
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  let touched;
  try {
    touched = execFileSync("git", ["diff", "--name-only", LANE_BASE, tip],
      { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
      .filter((path) => path && !TOUCHED.includes(path));
  } catch (error) {
    // The catch is an ARM, not a swallow: a genuinely no-history environment
    // (a shallow checkout, an exported tree) cannot answer the range — the
    // other source-read pins carry the freeze there. A throw in a FULL
    // checkout IS the defect (a mistyped SHA) and must fail loud. The probe
    // of the probe (the c25 audit LOW): a rev-parse failure alone is not
    // "not a git checkout" — a full checkout with a broken git still
    // rethrows, so a silent skip never rides a broken environment.
    let isShallow = null;
    try {
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    } catch {
      return; // git itself unusable (no repo at all — an exported tree)
    }
    try {
      isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"],
        { cwd: ROOT, encoding: "utf8" }).trim() === "true";
    } catch {
      throw error; // git answers HEAD but refuses the probe — not a swallow
    }
    if (isShallow) return;
    throw error;
  }
  assert.deepEqual(touched, [], `${touched.join(", ")} — every untouched module stays byte-frozen`);
});

// --- the AGPL header rides the new file in the canonical shape ------------------

test("the AGPL header rides the new file in the canonical shape", () => {
  const sourceText = read("tests/wave19-tiers.test.mjs");
  const lines = sourceText.split("\n");
  assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", "line 1");
  for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
    `header line ${i + 1} rides the template`);
  assert.equal(lines[17], "", "rides the 17-lines-plus-blank template");
});
