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

// The soundboard lane (0023's feature wave): the CRUD routes against the
// fakeDb (the emoji harness's conventions — the authorization contract lives
// in the query text, so that is what the pins carry), the BOOST-LEVEL slot
// math, the audio sniff's no-row intake, and the purge/twin-arm wiring the
// wave added to the expression-release and server-delete lanes.
import test from "node:test";
import assert from "node:assert/strict";
import { handleSoundboardRoutes, prepareSoundAttachment } from "../api/soundboard.mjs";
import { handleExpressionRoutes } from "../api/emoji.mjs";
import { handleServerRoutes } from "../api/servers.mjs";
import { handleMediaRoutes } from "../api/media.mjs";
import { sniffAudioMime, audioResponse } from "../api/core/audio.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS, GC_ATTACHMENT_OBJECT_PREFIX, GC_SOUNDBOARD_MAX_PER_SERVER, GC_SOUNDBOARD_SOUND_MAX_BYTES } from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const SOUND_ATTACHMENT_ID = 9;
const MANAGE_BIT = 1 << 11;

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const MEMBERSHIP_TEST = (sql) => sql.includes("SELECT 1 AS member FROM gc_server_members");
const ROLE_READ_TEST = (sql) => sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
// The authority read rides the RBAC-audit H1 shape: GROUP_CONCAT + the JS
// fold (SUM carried duplicate role bits into phantom higher bits).
const MERGED_TEST = (sql) => sql.includes("GROUP_CONCAT(ar.permissions)");
const BOOSTS_TEST = (sql) => sql.includes("SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1");
const OWN_SOUND_MIME_TEST = (sql) => sql.includes("SELECT mime FROM gc_attachments WHERE id = ? AND uploader_id = ?");
const SOUND_ROW_TEST = (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_sounds");
const SOUND_STATE_TEST = (sql) => sql.includes("SELECT EXISTS (SELECT 1 FROM gc_attachments a");

async function sessionFixtures(role = "member") {
  const token = randomToken();
  const csrf = randomToken(24);
  return {
    row: {
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
    },
    headers: { Cookie: "goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

const GC_SOUNDBOARD_RE = { 1: 24, 2: 36, 3: 48 };
// ONE memoized fixture per file run: a session read must answer the SAME
// row the request's cookie/CSRF headers were built from.
const SESSION_PROMISE = sessionFixtures();
const sessionRoutes = () => [
  { test: SESSION_READ_TEST, first: async () => (await SESSION_PROMISE).row },
];
const authHeaders = async () => (await SESSION_PROMISE).headers;

async function dispatchBoard(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleSoundboardRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
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

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The JSON create: { response, db } — the caller reads the db's recorded calls.
async function jsonCreate(routes, body, method = "POST") {
  const db = fakeDb([...sessionRoutes(), ...routes]);
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", {
      method,
      headers: { ...(await authHeaders()), Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  return { response, db };
}

// The multipart create: { response, db } — the caller reads the db's recorded
// calls. `extraEnv` carries the R2-facing bindings (the byte-law pins).
async function multipartCreate(routes, name, fileBytes, extraEnv = {}) {
  const db = fakeDb([...sessionRoutes(), ...routes]);
  const form = new FormData();
  form.append("name", name);
  form.append("sound", new Blob([fileBytes]));
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", {
      method: "POST",
      headers: { ...(await authHeaders()), Origin: ORIGIN },
      body: form,
    }),
    envWithLimiters({ GOOBER_DB: db, ...extraEnv }),
  );
  return { response, db };
}

// The Map-backed fake R2 bucket (the media r2-port file's shape): the put's
// store plus a call log for the ordering verdicts.
function fakeR2() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    async get(key) {
      calls.push({ op: "get", key });
      return store.has(key)
        ? { key, arrayBuffer: async () => store.get(key).slice(0).buffer }
        : null;
    },
    async put(key, value) {
      calls.push({ op: "put", key });
      store.set(key, new Uint8Array(value));
    },
    async delete(key) {
      calls.push({ op: "delete", key });
      return store.delete(key);
    },
  };
}

function fakeDb(routes = []) {
  const calls = [];
  let nextRowId = 100;
  const db = {
    calls,
    plusRows: new Map(),
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
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        const route = routes.find((entry) => entry.test(sql));
        if (route && route.run) return route.run(statement.bound);
        return { meta: { changes: 1, last_row_id: ++nextRowId } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

const ID3_MP3 = (() => {
  const bytes = new Uint8Array(64);
  bytes.set([0x49, 0x44, 0x33, 0x03, 0x00], 0); // "ID3" + version
  for (let i = 12; i < bytes.length; i += 1) bytes[i] = 0xa5;
  return bytes;
})();

const soundRoutes = ({
  boosts = 14,
  insertChanges = 1,
  count = 0,
  soundMime = "audio/mpeg",
  member = true,
  role = "member",
  permissions = MANAGE_BIT,
  id = 4,
  // The W-B0 classifier arms.
  assetSize = GC_SOUNDBOARD_SOUND_MAX_BYTES,
  assetMessageId = null,
  assetSoundsUsed = 0,
  assetEmojiUsed = 0,
  assetStickersUsed = 0,
} = {}) => [
  { test: BOOSTS_TEST, first: async () => ({ boosts }) },
  { test: OWN_SOUND_MIME_TEST, first: async () => ({ mime: soundMime }) },
  { test: (sql) => sql.startsWith("INSERT INTO gc_sounds"), run: async () => ({ meta: { changes: insertChanges } }) },
  { test: MEMBERSHIP_TEST, first: async () => (member ? { member: 1 } : null) },
  { test: ROLE_READ_TEST, first: async () => (member ? { role } : null) },
  { test: MERGED_TEST, first: async () => ({ permissions }) },
  {
    test: SOUND_STATE_TEST,
    first: async () => ({
      ownAttachment: 1,
      count,
      // The W-B0 classifier arms (the shared-asset create refusals): defaults
      // describe an unreferenced, in-bounds, message-free asset.
      size: assetSize,
      messageId: assetMessageId,
      soundsUsed: assetSoundsUsed,
      emojiUsed: assetEmojiUsed,
      stickersUsed: assetStickersUsed,
    }),
  },
  {
    test: (sql) => SOUND_ROW_TEST(sql) && sql.includes("WHERE server_id = ? AND name = ? ORDER BY id DESC"),
    first: async () => ({ id, server_id: SERVER_ID, name: "dropthebass", attachment_id: SOUND_ATTACHMENT_ID, created_at: 900 }),
  },
  {
    test: (sql) => SOUND_ROW_TEST(sql) && sql.includes("WHERE id = ? LIMIT 1"),
    first: async () => ({ id, server_id: SERVER_ID, name: "renamed", attachment_id: SOUND_ATTACHMENT_ID, created_at: 900 }),
  },
];

// --- the slot math -----------------------------------------------------------------

const OGG = (() => {
  const bytes = new Uint8Array(64);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  return bytes;
})();

test("the level-0 base is Discord's REAL 8: every server has a board, and the over-slot create is the count arm", async () => {
  // The multipart branch with a VALID mp3: a level-0 create ADMITS (base 8),
  // so the intake rides and the board exists everywhere.
  const { response: created } = await multipartCreate(soundRoutes({ boosts: 0 }), "dropthebass", ID3_MP3);
  assert.equal(created.status, 201);

  // The over-slot classification at the base: an 8-slot server refusing the
  // ninth sound is the count arm's 400.
  const { response: full } = await jsonCreate(
    soundRoutes({ boosts: 0, insertChanges: 0, count: GC_SOUNDBOARD_MAX_PER_SERVER }),
    { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID },
  );
  assert.equal(full.status, 400);
  assert.match((await bodyOf(full)).error, new RegExp("This server already has " + GC_SOUNDBOARD_MAX_PER_SERVER + " sounds\\."));
});

test("the board's read is never capped at the level's current count — the legacy rows stay", async () => {
  const listDb = fakeDb([
    ...sessionRoutes(),
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: BOOSTS_TEST, first: async () => ({ boosts: 0 }) },
    // An inventory that outlived its boost level: 10 rows under a level-0
    // base of 8 — the read must return them ALL.
    { test: (sql) => SOUND_ROW_TEST(sql), all: async () => ({ results: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => ({ id, server_id: SERVER_ID, name: "sound" + id, attachment_id: id, created_at: 900 + id })) }) },
  ]);
  const list = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds", { method: "GET", headers: await authHeaders() }),
    envWithLimiters({ GOOBER_DB: listDb }),
  );
  assert.equal(list.status, 200);
  assert.equal((await bodyOf(list)).sounds.length, 10, "an over-cap inventory lists whole (disabled-not-deleted)");
  const select = listDb.calls.find((call) => call.call === "all" && SOUND_ROW_TEST(call.sql));
  assert.ok(select);
  assert.doesNotMatch(select.sql, /LIMIT \d+/, "no LIMIT clause rides the board's read");
  assert.match(select.sql, /ORDER BY name, id$/);
});

test("the boost levels' slots ride the resolver: 24 at L1, 36 at L2, 48 at L3 — the bound cap rides the guarded INSERT", async () => {
  for (const [level, boosts] of [[1, 2], [2, 7], [3, 14]]) {
    const { response, db } = await jsonCreate(soundRoutes({ boosts }), { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID });
    assert.equal(response.status, 201, "level " + level);
    const payload = await bodyOf(response);
    assert.equal(payload.sound.name, "dropthebass");
    assert.equal(payload.sound.url, "/api/attachments/" + SOUND_ATTACHMENT_ID);

    const insert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_sounds"));
    assert.ok(insert, "the guarded INSERT ran");
    // The GO-HAYWIRE C3 FIX 2 shape: the resolver's cap answer is a bound
    // placeholder, never a concatenated literal.
    assert.match(insert.sql, new RegExp("\\(SELECT COUNT\\(\\*\\) FROM gc_sounds WHERE server_id = \\?\\) < \\?$"));
    assert.equal(insert.bound[insert.bound.length - 1], GC_SOUNDBOARD_RE[level]);
    // The shared-asset arms (W-B0): the sound's asset is standalone, within
    // the 512 KB bytes contract, and unreferenced by any row — the delete-
    // while-referenced shape is unschedulable at create.
    assert.match(insert.sql, /AND a\.message_id IS NULL AND a\.size_bytes <= 524288\)/);
    assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_sounds WHERE attachment_id = \?\)/);
    assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji WHERE attachment_id = \?\)/);
    assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_stickers WHERE attachment_id = \?\)/);
    // The 512 KB bytes cap is a SQL literal; the sibling arms bind the id
    // three more times; the cap rides the final bind.
    assert.deepEqual(insert.bound, [
      SERVER_ID, "dropthebass", SOUND_ATTACHMENT_ID, USER_ID, insert.bound[4],
      SERVER_ID, USER_ID,
      SERVER_ID, USER_ID,
      SOUND_ATTACHMENT_ID, USER_ID,
      SOUND_ATTACHMENT_ID, SOUND_ATTACHMENT_ID, SOUND_ATTACHMENT_ID,
      SERVER_ID,
      GC_SOUNDBOARD_RE[level],
    ]);
    assert.equal(insert.bound.length, insert.sql.split("?").length - 1,
      "the guard arms carry one bind per placeholder (the per-bit pair included)");
  }
});

test("GC_SOUNDBOARD_MAX_PER_SERVER is the matrix's real base 8", () => {
  assert.equal(GC_SOUNDBOARD_MAX_PER_SERVER, 8);
});

test("an over-slot create classifies: the count arm answers 'This server already has N sounds.'", async () => {
  for (const [boosts, full] of [[0, GC_SOUNDBOARD_MAX_PER_SERVER], [2, 24], [7, 36], [14, 48]]) {
    const { response } = await jsonCreate(soundRoutes({ boosts, insertChanges: 0, count: full }), { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID });
    assert.equal(response.status, 400);
    assert.match((await bodyOf(response)).error, new RegExp("This server already has " + full + " sounds\\."));
  }

  // The unauthorized member never probes existence: the shared 403 first.
  const { response: powerless } = await jsonCreate(soundRoutes({ insertChanges: 0, permissions: 0 }), { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID });
  assert.equal(powerless.status, 403);

  // The outsider: the shared 404.
  const { response: outsider } = await jsonCreate(soundRoutes({ member: false, insertChanges: 0 }), { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID });
  assert.equal(outsider.status, 404);
  assert.match((await bodyOf(outsider)).error, /That server does not exist or you are not in it\./);
});

test("the foreign-asset classification: a non-audio own upload never rides the board as a sound", async () => {
  const { response } = await jsonCreate(
    soundRoutes({ insertChanges: 0, soundMime: "image/png" }),
    { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID },
  );
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /Reference one of your own uploaded sounds\./);
});

test("a shared or message-attached asset can never START a sound (the W-B0 create arms)", async () => {
  for (const [label, used] of [
    ["sound-used", { assetSoundsUsed: 1 }],
    ["emoji-used", { assetEmojiUsed: 1 }],
    ["sticker-used", { assetStickersUsed: 1 }],
    ["message-attached", { assetMessageId: 5 }],
  ]) {
    const { response } = await jsonCreate(
      soundRoutes({ insertChanges: 0, count: 0, ...used }),
      { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID },
    );
    assert.equal(response.status, 400, label);
    assert.equal((await bodyOf(response)).error, "That sound is already referenced elsewhere.", label);
  }

  // The oversize legacy asset (an old >512 KB upload): the JSON branch 413s.
  const { response: tooLarge } = await jsonCreate(
    soundRoutes({ insertChanges: 0, count: 0, assetSize: GC_SOUNDBOARD_SOUND_MAX_BYTES + 1 }),
    { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID },
  );
  assert.equal(tooLarge.status, 413);
  assert.match((await bodyOf(tooLarge)).error, /Sounds must be 512 KB or smaller\./);
});

test("a legacy-shared sound's delete: the sibling survives, the bytes stay (the chunk arms)", async () => {
  // The sound row still has an EMOJI sibling on the same asset: the row
  // leaves, but the chunk statement's sibling arm (post-row-delete) answers
  // zero changes and the attachment itself is never released either.
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.startsWith("SELECT attachment_id FROM gc_sounds WHERE id = ? AND server_id = ?"), first: async () => ({ attachment_id: SOUND_ATTACHMENT_ID }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_sounds"), run: async () => ({ meta: { changes: 1 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks"), run: async () => ({ meta: { changes: 0 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachments"), run: async () => ({ meta: { changes: 0 } }) },
    { test: ROLE_READ_TEST, first: async () => ({ role: "member" }) },
    { test: MERGED_TEST, first: async () => ({ permissions: MANAGE_BIT }) },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
  ]);
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds/4", {
      method: "DELETE",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 3);
  // The W-B0 order: the ROW leaves first, the chunk statement carries the
  // sibling arms, the trailing attachment delete keeps every referencer arm.
  assert.match(batch.statements[0].sql, /^DELETE FROM gc_sounds/);
  assert.match(batch.statements[1].sql, /^DELETE FROM gc_attachment_chunks/);
  assert.match(batch.statements[1].sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji WHERE attachment_id = \?\)/);
  assert.match(batch.statements[1].sql, /NOT EXISTS \(SELECT 1 FROM gc_stickers WHERE attachment_id = \?\)/);
  assert.match(batch.statements[1].sql, /NOT EXISTS \(SELECT 1 FROM gc_sounds WHERE attachment_id = \?\)/);
  assert.match(batch.statements[1].sql, /EXISTS \(SELECT 1 FROM gc_attachments a WHERE a\.id = \? AND a\.message_id IS NULL\)/);
  const trailing = batch.statements[2];
  assert.match(trailing.sql, /^DELETE FROM gc_attachments/);
  const soundArm = trailing.sql.indexOf("NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?)");
  const emojiArm = trailing.sql.indexOf("NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?)");
  const stickerArm = trailing.sql.indexOf("NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?)");
  assert.ok(soundArm > -1 && emojiArm > soundArm && stickerArm > emojiArm);
  assert.match(trailing.sql, /message_id IS NULL AND/);
});

// --- the audio intake -----------------------------------------------------------------

test("the intake (Discord-real): MP3/OGG only, 512 KB per sound — an unadmitted format leaves NO row", async () => {
  // A PNG is not a sound; neither is a WAV nor a FLAC — the audio core's
  // sniff can READ those two, but the soundboard's intake admits only the
  // two spec formats.
  for (const [label, fixture] of [
    ["png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ["wav", Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
    ["flac", Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0])],
  ]) {
    const { response, db } = await multipartCreate(soundRoutes({ boosts: 2 }), "dropthebass", fixture);
    assert.equal(response.status, 400, label);
    assert.match((await bodyOf(response)).error, /Only MP3 and OGG sounds are accepted\./);
    assert.deepEqual(db.calls.filter((call) => /INSERT INTO/.test(call.sql) || call.call === "batch"), []);
  }

  const oversized = new Uint8Array(GC_SOUNDBOARD_SOUND_MAX_BYTES + 1);
  oversized.set([0x49, 0x44, 0x33], 0);
  const { response: tooLarge, db: tooLargeDb } = await multipartCreate(soundRoutes({ boosts: 2 }), "dropthebass", oversized);
  assert.equal(tooLarge.status, 413);
  assert.match((await bodyOf(tooLarge)).error, /Sounds must be 512 KB or smaller\./);
  assert.deepEqual(tooLargeDb.calls.filter((call) => /INSERT INTO/.test(call.sql) || call.call === "batch"), []);
});

test("the multipart intake stores the sniffed audio through the SAME standalone attachment machinery — both spec formats", async () => {
  for (const [fixture, mime] of [[ID3_MP3, "audio/mpeg"], [OGG, "audio/ogg"]]) {
    const { response, db } = await multipartCreate(soundRoutes({ boosts: 2 }), "dropthebass", fixture);
    assert.equal(response.status, 201);
    const attachmentInsert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_attachments"));
    assert.ok(attachmentInsert, "the standalone intake ran");
    assert.equal(attachmentInsert.bound[1], mime, "the SNIFFED mime rides the row");
    // No binding (local dev): the legacy chunk write-through stays the byte
    // store — the batch carries row + chunk INSERTs byte-identically.
    const legacyBatch = db.calls.find((call) => call.call === "batch");
    assert.ok(
      legacyBatch.statements.some((statement) => statement.sql.startsWith("INSERT INTO gc_attachment_chunks")),
      "no binding: the D1 chunk intake rides",
    );
  }
});

// --- the sound lane's R2 byte law (media.mjs's shared standalone intake) ----------

const SOUND_ATTACHMENT_ROUTE = {
  test: (sql) => sql.startsWith("INSERT INTO gc_attachments"),
  run: async () => ({ meta: { changes: 1, last_row_id: 77 } }),
};

test("the sound intake under GC_MEDIA commits the ledger row alone and awaits the R2 put before the 201", async () => {
  const r2 = fakeR2();
  const { response, db } = await multipartCreate(
    [SOUND_ATTACHMENT_ROUTE, ...soundRoutes({ boosts: 2 })],
    "dropthebass", ID3_MP3, { GC_MEDIA: r2 },
  );
  assert.equal(response.status, 201);
  // The byte store of record: the intake batch carries the ledger row ALONE.
  const batch = db.calls.find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 1);
  assert.ok(batch.statements[0].sql.startsWith("INSERT INTO gc_attachments"));
  // The put is AWAITED on the intake path: the object is already in the
  // bucket (gc-attachments/<row id>) by the time the route's 201 returns.
  assert.equal(r2.calls.length, 1);
  assert.equal(r2.calls[0].op, "put");
  assert.equal(r2.calls[0].key, GC_ATTACHMENT_OBJECT_PREFIX + "77");
  assert.deepEqual(Uint8Array.from(r2.store.get(GC_ATTACHMENT_OBJECT_PREFIX + "77")), ID3_MP3);
});

test("a failed R2 put on the sound intake sweeps the byte-less pending row and rejects 503", async () => {
  const r2 = fakeR2();
  r2.put = async () => {
    r2.calls.push({ op: "put" });
    throw new Error("bucket down");
  };
  const { response, db } = await multipartCreate(
    [SOUND_ATTACHMENT_ROUTE, ...soundRoutes({ boosts: 2 })],
    "dropthebass", ID3_MP3, { GC_MEDIA: r2 },
  );
  // Fail closed: exactly one put attempt, then the compensating delete
  // sweeps the just-inserted pending row and the create rejects — never a
  // committed byte-less asset, and no gc_sounds row ever references it. The
  // row's death also rides its object delete (the shared standalone intake's
  // byte-death path — lane-r2-audit FINDING 2).
  assert.equal(response.status, 503);
  assert.match((await bodyOf(response)).error, /upload could not be stored/);
  assert.deepEqual(r2.calls.map((call) => call.op), ["put", "delete"]);
  const rollback = db.calls.find(
    (call) => call.call === "run" && call.sql.startsWith("DELETE FROM gc_attachments WHERE id = ?") && call.sql.includes("status = 'pending'"),
  );
  assert.ok(rollback, "the compensating pending-row sweep ran");
  assert.deepEqual(rollback.bound, [77]);
  assert.ok(!db.calls.some((call) => /INSERT INTO gc_sounds/.test(call.sql || "")));
});

test("a duplicate name is the UNIQUE violation answered 409; a bad name is the shape 400", async () => {
  const thrown = new Error("UNIQUE constraint failed: gc_sounds.server_id, gc_sounds.name");
  const { response } = await jsonCreate(
    [{ test: BOOSTS_TEST, first: async () => ({ boosts: 2 }) }, { test: OWN_SOUND_MIME_TEST, first: async () => ({ mime: "audio/mpeg" }) }, { test: (sql) => sql.startsWith("INSERT INTO gc_sounds"), run: async () => { throw thrown; } }],
    { name: "dropthebass", attachmentId: SOUND_ATTACHMENT_ID },
  );
  assert.equal(response.status, 409);
  assert.match((await bodyOf(response)).error, /already taken/);

  const { response: bad } = await jsonCreate(soundRoutes(), { name: "drop the bass!", attachmentId: SOUND_ATTACHMENT_ID });
  assert.equal(bad.status, 400);
  assert.match((await bodyOf(bad)).error, /letters, numbers and underscores/);
});

// --- rename + delete ----------------------------------------------------------------

test("the rename mirrors the lane: the manage guard rides the UPDATE, the UNIQUE violation is the 409", async () => {
  const renameDb = fakeDb([...sessionRoutes(), ...soundRoutes()]);
  const url = ORIGIN + "/api/servers/" + SERVER_ID + "/sounds/" + 4;
  const rename = await dispatchBoard(
    new Request(url, {
      method: "PATCH",
      headers: { ...(await authHeaders()), Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    }),
    envWithLimiters({ GOOBER_DB: renameDb }),
  );
  assert.equal(rename.status, 200);
  const payload = await bodyOf(rename);
  assert.equal(payload.sound.name, "renamed");
  const update = renameDb.calls.find((call) => call.call === "run" && call.sql.startsWith("UPDATE gc_sounds SET name ="));
  assert.ok(update);
  assert.match(update.sql,
    /OR \(EXISTS \(SELECT 1 FROM gc_member_roles gbm2048 JOIN gc_roles gbr2048[\s\S]*\(gbr2048\.permissions & 2048\) <> 0\)/);
});

test("the sound's delete: the three-statement batch and the trailing attachment delete carries EVERY referencer arm", async () => {
  const { row, headers } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.startsWith("SELECT attachment_id FROM gc_sounds WHERE id = ? AND server_id = ?"), first: async () => ({ attachment_id: SOUND_ATTACHMENT_ID }) },
    { test: ROLE_READ_TEST, first: async () => ({ role: "member" }) },
    { test: MERGED_TEST, first: async () => ({ permissions: MANAGE_BIT }) },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
  ]);
  const response = await dispatchBoard(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/sounds/" + 4, {
      method: "DELETE",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
    }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 3);
  const trailing = batch.statements[2];
  assert.match(trailing.sql, /^DELETE FROM gc_attachments/);
  // The gc_sounds arm rides first, the emoji/sticker arms the twin order.
  const soundArm = trailing.sql.indexOf("NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?)");
  const emojiArm = trailing.sql.indexOf("NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?)");
  const stickerArm = trailing.sql.indexOf("NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?)");
  assert.ok(soundArm > -1 && emojiArm > soundArm && stickerArm > emojiArm, "every referencer arm rides the trailing delete");
  assert.match(trailing.sql, /message_id IS NULL AND/);
});

test("the TWIN ARM: an emoji's release can never strip an attachment a sound still references", async () => {
  const db = fakeDb([
    ...sessionRoutes(),
    { test: (sql) => sql.startsWith("SELECT attachment_id FROM gc_emoji"), first: async () => ({ attachment_id: 77 }) },
    { test: ROLE_READ_TEST, first: async () => ({ role: "member" }) },
    { test: MERGED_TEST, first: async () => ({ permissions: MANAGE_BIT }) },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
  ]);
  let response;
  try {
    // The emoji dispatch is the twin's test lane.
    const url = new URL(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis/4");
    response = await handleExpressionRoutes(
      new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis/4", {
        method: "DELETE",
        headers: { ...(await authHeaders()), Origin: ORIGIN, "Content-Type": "application/json" },
      }),
      envWithLimiters({ GOOBER_DB: db }),
      url, url.pathname, "DELETE", {},
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  const trailing = batch.statements[2];
  assert.match(trailing.sql, /NOT EXISTS \(SELECT 1 FROM gc_sounds WHERE attachment_id = \?\)/, "the soundboard's referencer arm rides the emoji lane's trailing delete as the twin");
  assert.match(trailing.sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji WHERE attachment_id = \?\)/);
  assert.match(trailing.sql, /NOT EXISTS \(SELECT 1 FROM gc_stickers WHERE attachment_id = \?\)/);
});

// --- the server delete's purge list -------------------------------------------------

test("the server delete's doomed purge list carries the server's sounds", async () => {
  const { row, headers } = await sessionFixtures("owner");
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    { test: (sql) => sql.startsWith("SELECT attachment_id FROM gc_sounds WHERE server_id = ?"), all: async () => ({ results: [{ attachment_id: 91 }] }) },
    { test: (sql) => sql.startsWith("SELECT icon_media_id FROM gc_servers"), first: async () => ({ icon_media_id: null }) },
    { test: (sql) => sql.startsWith("SELECT a.id FROM gc_attachments a"), all: async () => ({ results: [] }) },
  ]);
  const response = await (async () => {
    const url = new URL(ORIGIN + "/api/servers/" + SERVER_ID);
    try {
      return await handleServerRoutes(
        new Request(ORIGIN + "/api/servers/" + SERVER_ID, { method: "DELETE", headers: { ...headers, Origin: ORIGIN } }),
        envWithLimiters({ GOOBER_DB: db }),
        url, url.pathname, "DELETE", undefined,
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return json(error.payload || { error: error.message }, error.status, error.headers);
    }
  })();
  assert.equal(response.status, 200);
  const soundsPreRead = db.calls.find((call) => call.call === "all" && call.sql.startsWith("SELECT attachment_id FROM gc_sounds WHERE server_id = ?"));
  assert.ok(soundsPreRead, "the sounds' doomed pre-read rode the same discipline");
});

// --- the audio core ---------------------------------------------------------------

test("the audio sniff admits exactly the four formats and nulls everything else", () => {
  const id3 = new Uint8Array(16); id3.set([0x49, 0x44, 0x33, 3, 0], 0);
  const frames = new Uint8Array(16); frames.set([0xff, 0xfb], 0);
  const ogg = new Uint8Array(16); ogg.set([0x4f, 0x67, 0x67, 0x53], 0);
  const wav = new Uint8Array(16); wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], 0);
  const flac = new Uint8Array(16); flac.set([0x66, 0x4c, 0x61, 0x43], 0);
  const png = new Uint8Array(16); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  assert.equal(sniffAudioMime(id3), "audio/mpeg");
  assert.equal(sniffAudioMime(frames), "audio/mpeg");
  assert.equal(sniffAudioMime(ogg), "audio/ogg");
  assert.equal(sniffAudioMime(wav), "audio/wav");
  assert.equal(sniffAudioMime(flac), "audio/flac");
  assert.equal(sniffAudioMime(png), null, "an image is not a sound");
  assert.equal(sniffAudioMime(new Uint8Array(8)), null, "a file shorter than the longest magic head is nothing");
  assert.equal(sniffAudioMime(null), null);
});

test("the audio egress verifier is imageResponse's twin: the sniffed magic must MATCH the claimed mime, else null", () => {
  const id3 = new Uint8Array(16); id3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  const good = audioResponse(id3, "audio/mpeg", "public, max-age=31536000, immutable");
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(good.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(good.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(good.headers.get("Content-Length"), String(id3.length));
  // A claimed mime the bytes do not carry is THE shared 404's null, never a
  // best-guess Content-Type.
  assert.equal(audioResponse(id3, "audio/ogg", "private, max-age=300"), null);
  const garbage = new Uint8Array(16);
  assert.equal(audioResponse(garbage, "audio/mpeg", "private, max-age=300"), null);
});

async function dispatchMedia(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleMediaRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return (
    response ??
    new Response(JSON.stringify({ error: "That API endpoint does not exist." }), { status: 404 })
  );
}

test("the serving branch: an audio row's D1 bytes serve under the image path's gate with the audio verifier", async () => {
  const { row, headers } = await sessionFixtures();
  const approvedSound = { id: 55, uploader_id: USER_ID, status: "approved", mime: "audio/mpeg" };
  const db = fakeDb([
    { test: (sql) => sql.includes("SELECT id, uploader_id, status, mime, size_bytes FROM gc_attachments"), first: async () => approvedSound },
    {
      test: (sql) => sql.includes("SELECT data FROM gc_attachment_chunks WHERE attachment_id"),
      all: async () => ({
        results: [
          { data: ID3_MP3.buffer.slice(0, 40) },
          { data: ID3_MP3.buffer.slice(40, 64) },
        ],
      }),
    },
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
  ]);
  void row;
  const served = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/55", { headers }),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(served.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(new Uint8Array(await served.arrayBuffer()).length, 64, "the chunks concatenate IN ORDER into the sound's bytes");

  // The fail-safe holds for BOTH verifiers: an audio-claimed row whose bytes
  // are GARBAGE is the shared 404, and an image-mime claim answered by the
  // image path first never leaks an audio Content-Type by drift.
  const imageClaimed = { ...approvedSound, id: 56, mime: "image/png" };
  const failingDb = fakeDb([
    { test: (sql) => sql.includes("SELECT id, uploader_id, status, mime, size_bytes FROM gc_attachments"), first: async () => imageClaimed },
    { test: (sql) => sql.includes("SELECT data FROM gc_attachment_chunks WHERE attachment_id"), all: async () => ({ results: [{ data: ID3_MP3.buffer.slice(0) }] }) },
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
  ]);
  const mismatch = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/56", { headers }),
    envWithLimiters({ GOOBER_DB: failingDb }),
  );
  assert.equal(mismatch.status, 404, "an image-claimed row with mp3 bytes serves nothing");

  // The NIT-6 tighten (W-B0): the serving audio family is the admitted pair
  // (GC_SOUND_INTAKE_MIMES — one source with the intake); remote holds zero
  // legacy audio rows (queried 2026-11-17), so an exotic claim is the shared
  // 404, never a sniff-blessed stranger to the intake.
  const wavClaimed = { ...approvedSound, id: 57, mime: "audio/wav" };
  const wavDb = fakeDb([
    { test: (sql) => sql.includes("SELECT id, uploader_id, status, mime, size_bytes FROM gc_attachments"), first: async () => wavClaimed },
    { test: (sql) => sql.includes("SELECT data FROM gc_attachment_chunks WHERE attachment_id"), all: async () => ({ results: [{ data: ID3_MP3.buffer.slice(0) }] }) },
    { test: (sql) => sql.includes("FROM site_settings"), first: async () => ({ value: "", updated_at: 1 }) },
  ]);
  const wav = await dispatchMedia(
    new Request(ORIGIN + "/api/attachments/57", { headers }),
    envWithLimiters({ GOOBER_DB: wavDb }),
  );
  assert.equal(wav.status, 404, "a legacy WAV claim is the shared 404");
});
