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

// Custom emoji + stickers (parity bundle 0020): the CRUD routes against the
// fakeDb, the token machinery, and the send-time external-emoji decision.
// Same fake conventions as the servers/messages modules: fakeDb records every
// statement's bound values, batch() carries each statement's SQL (the
// authorization contract lives in the query text, so that is what the tests
// pin), and unrouted reads return null/{results: []} like a real miss.
import test from "node:test";
import assert from "node:assert/strict";
import { handleExpressionRoutes } from "../api/emoji.mjs";
import {
  referencedExpressionIds,
  enforceExpressionTokenAccess,
  emojiToken,
  stickerToken,
  EMOJI_TOKEN_PATTERN,
  STICKER_TOKEN_PATTERN,
} from "../api/emoji.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  RATE_LIMIT_BINDINGS,
  GC_EMOJI_FILE_MAX,
  GC_EMOJI_MAX_PER_SERVER,
  GC_SOUNDBOARD_MAX_PER_SERVER,
  GC_STICKER_FILE_MAX,
  GC_STICKER_MAX_PER_SERVER,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 3;
const ATTACHMENT_ID = 9;

// --- routes ---------------------------------------------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

// --- scaffolding -----------------------------------------------------------------

// ONE memoized fixture per file run: a session read must answer the SAME
// row the request's cookie/CSRF headers were built from.
async function session() {
  const token = randomToken();
  const csrf = randomToken(24);
  return {
    row: {
      token_hash: await sha256Hex(token),
      user_id: USER_ID,
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
    },
    headers: { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
  };
}

// ONE memoized fixture per file run: a session read must answer the SAME
// row the request's cookie/CSRF headers were built from.
const SESSION_FIX = session();

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleExpressionRoutes(request, env, url, url.pathname, request.method.toUpperCase(), {});
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
        if (route === undefined) return { meta: { changes: 1, last_row_id: ++nextRowId } };
        return await route.run(statement.bound);
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

// --- SQL-text shapes --------------------------------------------------------------

const MEMBERSHIP_TEST = (sql) =>
  sql.includes("SELECT 1 AS member FROM gc_server_members");
const ROLE_READ_TEST = (sql) =>
  sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1");
const MERGED_TEST = (sql) =>
  sql.includes("GROUP_CONCAT(ar.permissions)");
const MANAGE_BIT = 1 << 11;

function expressionRoutes({
  kind = "emoji",
  member = true,
  role = "member",
  permissions = MANAGE_BIT,
  insertChanges = 1,
  count = 0,
  ownAttachment = 1,
  // The W-B0 classifier arms (the shared-asset / oversize refusals).
  assetSize = GC_STICKER_FILE_MAX,
  assetMessageId = null,
  assetEmojiUsed = 0,
  assetStickersUsed = 0,
  assetSoundsUsed = 0,
} = {}) {
  const table = kind === "sticker" ? "gc_stickers" : "gc_emoji";
  const row = {
    id: kind === "sticker" ? 5 : 4,
    server_id: SERVER_ID,
    name: "partyparrot",
    attachment_id: ATTACHMENT_ID,
    created_at: 900,
  };
  // Route order matters: every run-shape comes FIRST, because the writes'
  // guarded SQL text carries the merged-perms fragment (a read route for it
  // would shadow the INSERT/DELETE runs).
  return [
    { test: (sql) => sql.startsWith("INSERT INTO " + table), run: async (bound) => ({ meta: { changes: insertChanges } }) },
    {
      test: (sql) => sql.startsWith("UPDATE " + table + " SET name = "),
      run: async (bound) => ({ meta: { changes: 1 } }),
    },
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => (member ? { member: 1 } : null) },
    {
      test: ROLE_READ_TEST,
      first: async () => member
        ? { role }
        : null,
    },
    {
      test: MERGED_TEST,
      first: async () => ({ permissions }),
    },
    {
      test: (sql) => sql.startsWith("SELECT EXISTS (SELECT 1 FROM gc_attachments a"),
      first: async () => ({
        ownAttachment,
        count,
        // The W-B0 classifier arms (the shared-asset/oversize refusals):
        // defaults describe an unreferenced, in-bounds, message-free asset.
        size: assetSize,
        messageId: assetMessageId,
        emojiUsed: assetEmojiUsed,
        stickersUsed: assetStickersUsed,
        soundsUsed: assetSoundsUsed,
      }),
    },
    {
      test: (sql) => sql.includes("WHERE server_id = ? AND name = ? ORDER BY id DESC"),
      first: async () => ({ ...row, name: (await SESSION_FIX).row && row.name }),
    },
    {
      test: (sql) => sql.startsWith("SELECT attachment_id FROM " + table),
      first: async () => ({ attachment_id: ATTACHMENT_ID }),
    },
    {
      test: (sql) => sql.startsWith("SELECT id, server_id, name, attachment_id, created_at FROM " + table + " WHERE id = ?"),
      first: async () => ({ ...row, name: "renamed" }),
    },
  ];
}

const baseEnv = (db) => envWithLimiters({ GOOBER_DB: db });

// --- list -------------------------------------------------------------------------

test("GET /api/servers/:id/emojis lists the inventory for a member, 404s an outsider", async () => {
  const { headers } = await SESSION_FIX;
  const row = { id: 4, server_id: SERVER_ID, name: "partyparrot", attachment_id: ATTACHMENT_ID, created_at: 900 };
  const db = fakeDb(expressionRoutes() && [
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_emoji"),
      all: async () => ({ results: [row] }),
    },
    {
      test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_stickers"),
      all: async () => ({ results: [] }),
    },
  ]);
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", { method: "GET", headers }),
    baseEnv(db),
  );
  assert.equal(response.status, 200);
  // The caps rider (W-B0): the manage UI's slot counters ride the list
  // payload, resolved per server (level 0 → the bases).
  assert.deepEqual(await bodyOf(response), {
    emojis: [{ id: 4, serverId: SERVER_ID, name: "partyparrot", url: "/api/attachments/9", createdAt: new Date(900 * 1000).toISOString() }],
    caps: { emoji: GC_EMOJI_MAX_PER_SERVER, stickers: GC_STICKER_MAX_PER_SERVER, sounds: GC_SOUNDBOARD_MAX_PER_SERVER },
  });

  const outsider = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", { method: "GET", headers }),
    baseEnv(fakeDb([
      { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
      { test: MEMBERSHIP_TEST, first: async () => null },
    ])),
  );
  assert.equal(outsider.status, 404);
});

// --- create ------------------------------------------------------------------------

async function createWith(routes, body) {
  const { headers } = await SESSION_FIX;
  return dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis", {
      method: "POST",
      // The write tier's same-origin + CSRF gate needs BOTH headers.
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    baseEnv(routes),
  );
}

test("POST /api/servers/:id/emojis rides the guarded INSERT: manage guard + own attachment + the 50 cap", async () => {
  const db = fakeDb(expressionRoutes());
  const response = await createWith(db, { name: "partyparrot", attachmentId: ATTACHMENT_ID });
  assert.equal(response.status, 201);
  const payload = await bodyOf(response);
  assert.equal(payload.emoji.name, "partyparrot");
  assert.equal(payload.emoji.url, "/api/attachments/9");

  const insert = db.calls.find((call) => call.call === "run" && /^INSERT INTO gc_emoji/.test(call.sql));
  assert.ok(insert, "the guarded INSERT ran");
  // The guard order in the binds: row values, the owner pair, the per-bit pair
  // (the mask literal now rides the SQL — SUM's bit, bit binds are gone), the
  // parity-law file cap, the own-attachment id ×3 (the shared-asset
  // never-arms), then the cap's server probe.
  assert.deepEqual(insert.bound, [
    SERVER_ID, "partyparrot", ATTACHMENT_ID, USER_ID, insert.bound[4],
    SERVER_ID, USER_ID,
    SERVER_ID, USER_ID,
    GC_EMOJI_FILE_MAX,
    ATTACHMENT_ID, ATTACHMENT_ID, ATTACHMENT_ID,
    SERVER_ID,
  ]);
  assert.match(insert.sql, /INSERT INTO gc_emoji \(server_id, name, attachment_id, created_by, created_at\)/);
  // The W-B0 create arms: the asset is standalone (no message), within the
  // emoji file cap, and unreferenced by any row.
  assert.match(insert.sql, /EXISTS \(SELECT 1 FROM gc_attachments a WHERE a\.id = \? AND a\.uploader_id = \? AND a\.message_id IS NULL AND a\.size_bytes <= \?\)/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji WHERE attachment_id = \?\)/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_stickers WHERE attachment_id = \?\)/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM gc_sounds WHERE attachment_id = \?\)/);
  assert.match(insert.sql, new RegExp("\\(SELECT COUNT\\(\\*\\) FROM gc_emoji WHERE server_id = \\?\\) < " + GC_EMOJI_MAX_PER_SERVER));
});

test("a zero-change create classifies: outsider 404, non-authoritative 403, cap 400, foreign attachment 400", async () => {
  const outsider = await createWith(
    fakeDb(expressionRoutes({ member: false, insertChanges: 0 })),
    { name: "parrot", attachmentId: ATTACHMENT_ID },
  );
  assert.equal(outsider.status, 404);
  assert.equal((await bodyOf(outsider)).error, "That server does not exist or you are not in it.");

  const powerless = await createWith(
    fakeDb(expressionRoutes({ permissions: 0, insertChanges: 0 })),
    { name: "parrot", attachmentId: ATTACHMENT_ID },
  );
  assert.equal(powerless.status, 403);

  const full = await createWith(
    fakeDb(expressionRoutes({ insertChanges: 0, count: GC_EMOJI_MAX_PER_SERVER })),
    { name: "parrot", attachmentId: ATTACHMENT_ID },
  );
  assert.equal(full.status, 400);
  assert.match((await bodyOf(full)).error, /This server already has 50 emoji\./);

  const foreign = await createWith(
    fakeDb(expressionRoutes({ insertChanges: 0, count: 0, ownAttachment: 0 })),
    { name: "parrot", attachmentId: ATTACHMENT_ID },
  );
  assert.equal(foreign.status, 400);
  assert.match((await bodyOf(foreign)).error, /your own uploaded images/);
});

test("a duplicate name is the UNIQUE violation, answered 409 — never a silent skip", async () => {
  const routes = [
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    {
      test: (sql) => sql.startsWith("INSERT INTO gc_emoji"),
      run: async () => {
        throw new Error("UNIQUE constraint failed: gc_emoji.server_id, gc_emoji.name");
      },
    },
  ];
  const response = await createWith(fakeDb(routes), { name: "partyparrot", attachmentId: ATTACHMENT_ID });
  assert.equal(response.status, 409);
  assert.match((await bodyOf(response)).error, /already taken/);
});

test("an invalid name is a shape 400 before any write", async () => {
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row }]);
  // The 0026 widenings: 17 chars is now a LAWFUL emoji name (the bound is
  // 32); the probes sit past it, and "bad-name"-shaped spaces never pass.
  for (const name of ["a", "bad-name", "não", "x".repeat(33)]) {
    const response = await createWith(db, { name, attachmentId: ATTACHMENT_ID });
    assert.equal(response.status, 400, JSON.stringify(name));
  }
  // A 32-char name clears the shape gate — the create proceeds past the
  // validator (the fake answers no further route, so the verdict rides the
  // shared shape, never a write).
  assert.equal(db.calls.filter((call) => call.call === "run" || call.call === "batch").length, 0,
    "no statement ran before the shape check");
});

// --- rename ------------------------------------------------------------------------

async function renameWith(routes, id, body) {
  const { headers } = await SESSION_FIX;
  return dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/emojis/" + id, {
      method: "PATCH",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    baseEnv(routes),
  );
}

test("PATCH carries the manage guard inside the UPDATE and re-reads the renamed row", async () => {
  const db = fakeDb(expressionRoutes());
  const response = await renameWith(db, 4, { name: "renamed" });
  assert.equal(response.status, 200);
  assert.equal((await bodyOf(response)).emoji.name, "renamed");

  const update = db.calls.find((call) => call.call === "run" && call.sql.startsWith("UPDATE gc_emoji"));
  assert.match(update.sql, /UPDATE gc_emoji SET name = \? WHERE id = \? AND server_id = \? AND/);
  assert.match(update.sql, /om\.role = 'owner'/);
  assert.equal(update.bound[0], "renamed");
  assert.equal(update.bound[1], 4);
  assert.equal(update.bound[2], SERVER_ID);
  assert.deepEqual(update.bound.slice(3), [SERVER_ID, USER_ID, SERVER_ID, USER_ID],
    "the manage guard's pair binds follow the row binds (owner server, actor, bits server, actor)");
});

test("a zero-change rename answers 404 with authority and 403 without", async () => {
  // The zero-UPDATE variant REPLACES the insert-routes list's UPDATE entry
  // (the run routes come first — the read routes would shadow them).
  const withZeroUpdate = () => {
    const routes = expressionRoutes();
    routes[1] = { test: (sql) => sql.startsWith("UPDATE gc_emoji SET name = "), run: async () => ({ meta: { changes: 0 } }) };
    return routes;
  };
  const authoritative = await renameWith(fakeDb(withZeroUpdate()), 4, { name: "renamed" });
  assert.equal(authoritative.status, 404);
  assert.match((await bodyOf(authoritative)).error, /does not exist/);

  const powerless = await renameWith(
    fakeDb(expressionRoutes({ permissions: 0 }).map((route, index) =>
      index === 1
        ? { test: (sql) => sql.startsWith("UPDATE gc_emoji SET name = "), run: async () => ({ meta: { changes: 0 } }) }
        : route,
    )),
    4, { name: "renamed" },
  );
  assert.equal(powerless.status, 403);
});

// --- delete ------------------------------------------------------------------------

async function deleteWith(routes, id, kind = "emoji") {
  const { headers } = await SESSION_FIX;
  const word = kind === "sticker" ? "stickers" : "emojis";
  return dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/" + word + "/" + id, {
      method: "DELETE",
      headers: { ...headers, Origin: ORIGIN },
    }),
    baseEnv(routes),
  );
}

test("DELETE runs the guarded three-statement batch: row → chunks → attachment with the release guards", async () => {
  // The run-shape routes come first: the batch's DELETE statements carry the
  // merged-perms fragment in their text (a read route would shadow them).
  const routes = [
    { test: (sql) => sql.startsWith("DELETE FROM"), run: async () => ({ meta: { changes: 1 } }) },
    ...expressionRoutes(),
  ];
  const db = fakeDb(routes);
  const response = await deleteWith(db, 4);
  assert.equal(response.status, 200);

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch, "the delete ran as ONE batch");
  assert.equal(batch.statements.length, 3);
  const [rowDelete, chunks, attachmentDelete] = batch.statements;

  // The W-B0 fix (the reviewer's HIGH-1): the ROW delete LEADS — the sibling
  // arms below must read the post-delete state — and the CHUNK statement
  // carries the sibling arms itself (unarmed, it stripped a SHARED
  // attachment's bytes while a sibling survived).
  assert.match(rowDelete.sql, /DELETE FROM gc_emoji WHERE id = \? AND server_id = \? AND/);
  assert.deepEqual(rowDelete.bound.slice(0, 2), [4, SERVER_ID]);

  assert.match(chunks.sql, /^DELETE FROM gc_attachment_chunks WHERE attachment_id = \? AND/);
  assert.deepEqual(chunks.bound[0], ATTACHMENT_ID);
  // The chunk statement's own sibling arms:
  assert.match(chunks.sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji WHERE attachment_id = \?\)/);
  assert.match(chunks.sql, /NOT EXISTS \(SELECT 1 FROM gc_stickers WHERE attachment_id = \?\)/);
  assert.match(chunks.sql, /NOT EXISTS \(SELECT 1 FROM gc_sounds WHERE attachment_id = \?\)/);
  assert.match(chunks.sql, /EXISTS \(SELECT 1 FROM gc_attachments a WHERE a\.id = \? AND a\.message_id IS NULL\)/);

  // The attachment leaves LAST (RESTRICT — the reference must leave first),
  // with the NOT EXISTS release arms for every other referencer of the image.
  assert.match(attachmentDelete.sql, /DELETE FROM gc_attachments WHERE id = \? AND/);
  assert.match(attachmentDelete.sql, /NOT EXISTS \(SELECT 1 FROM gc_emoji WHERE attachment_id = \?\)/);
  assert.match(attachmentDelete.sql, /NOT EXISTS \(SELECT 1 FROM gc_stickers WHERE attachment_id = \?\)/);
  assert.match(attachmentDelete.sql, /message_id IS NULL/);
  assert.equal(attachmentDelete.bound[0], ATTACHMENT_ID);

  // ONE guard on all three statements (the channel-delete discipline) — the
  // per-bit EXISTS guard's two (server, actor) pairs ride each of them.
  for (const statement of [rowDelete, chunks, attachmentDelete]) {
    assert.deepEqual(statement.bound.slice(-4), [SERVER_ID, USER_ID, SERVER_ID, USER_ID],
      "owner + bits guard pairs ride the statement's tail");
  }
});

test("DELETE's pre-read classifies: nobody hears of another server's emoji", async () => {
  const missing = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    {
      test: (sql) => sql.startsWith("SELECT attachment_id FROM gc_emoji"),
      first: async () => null,
    },
    { test: ROLE_READ_TEST, first: async () => ({ role: "moderator" }) },
  ]);
  const response = await deleteWith(missing, 404);
  assert.equal(response.status, 404, "with authority the row is unknown");

  const powerless = fakeDb([
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    {
      test: (sql) => sql.startsWith("SELECT attachment_id FROM gc_emoji"),
      first: async () => null,
    },
    { test: ROLE_READ_TEST, first: async () => ({ role: "member" }) },
    { test: MERGED_TEST, first: async () => ({ permissions: 0 }) },
  ]);
  const refused = await deleteWith(powerless, 4);
  assert.equal(refused.status, 403, "without authority the shared 403 never probes existence");
});

// --- the sticker twin --------------------------------------------------------------

test("the sticker twin shares the shape: same guard, own table, own route word", async () => {
  const { headers } = await SESSION_FIX;
  const db = fakeDb(expressionRoutes({ kind: "sticker" }));
  const response = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/stickers", {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "partyparrot", attachmentId: ATTACHMENT_ID }),
    }),
    baseEnv(db),
  );
  assert.equal(response.status, 201);
  assert.equal((await bodyOf(response)).sticker.name, "partyparrot");
  const insert = db.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_stickers"));
  assert.ok(insert);
  // The 0025 parity pass: the sticker cap resolves by boost LEVEL — a
  // no-boosts server answers the LADDER'S BASE 5 (Discord's real level-0
  // number), and the create statement carries exactly the level's effective
  // count (15/30/60 ride through the shared resolver at L1/L2/L3).
  assert.match(insert.sql, /\(SELECT COUNT\(\*\) FROM gc_stickers WHERE server_id = \?\) < /);
  assert.match(insert.sql, /< 5$/, "the level-0 base is Discord's real 5");

  const list = await dispatch(
    new Request(ORIGIN + "/api/servers/" + SERVER_ID + "/stickers", { method: "GET", headers }),
    baseEnv(fakeDb([
      { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
      { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
      {
        test: (sql) => sql.includes("SELECT id, server_id, name, attachment_id, created_at FROM gc_stickers"),
        all: async () => ({ results: [{ id: 5, server_id: SERVER_ID, name: "s", attachment_id: ATTACHMENT_ID, created_at: 900 }] }),
      },
    ])),
  );
  assert.equal(list.status, 200);
  assert.deepEqual((await bodyOf(list)).stickers[0].name, "s");
});

// --- the W-B0 parity law pass ------------------------------------------------------

async function multipartExpression(routes, path, name, fileBytes) {
  const db = fakeDb(routes);
  const form = new FormData();
  form.append("name", name);
  form.append("image", new Blob([fileBytes]));
  const { headers } = await SESSION_FIX;
  const response = await dispatch(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: { ...headers, Origin: ORIGIN },
      body: form,
    }),
    baseEnv(db),
  );
  return { response, db };
}

// A structurally valid PNG the intake's sanitizer keeps (media-module's
// pngChunk shape): signature + IHDR + IEND, no CRC verification.
function pngLike(payloadBytes = 0) {
  const chunk = (type, data = new Uint8Array(0)) => {
    const out = new Uint8Array(12 + data.length);
    out[0] = (data.length >>> 24) & 0xff;
    out[1] = (data.length >>> 16) & 0xff;
    out[2] = (data.length >>> 8) & 0xff;
    out[3] = data.length & 0xff;
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  };
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", new Uint8Array(13)),
    chunk("IDAT", new Uint8Array(payloadBytes)),
    chunk("IEND"),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// parity-limits.md: Emoji file limit 256 KB / Sticker file limit 512 KB
// (verified 2026-11-17). The intake gate runs BEFORE anything is written —
// the exact 413 copy, and no attachment row (the intake never fires).
test("the expression file gates: an oversized upload 413s with the parity copy and writes nothing", async () => {
  const oversizedEmoji = new Uint8Array(GC_EMOJI_FILE_MAX + 1);
  const { response } = await multipartExpression(
    expressionRoutes(), "/api/servers/" + SERVER_ID + "/emojis", "partyparrot", oversizedEmoji,
  );
  assert.equal(response.status, 413);
  assert.equal((await bodyOf(response)).error, "Emoji must be 256 KB or smaller.");

  const oversizedSticker = new Uint8Array(GC_STICKER_FILE_MAX + 1);
  const stickerTableInsert = (sql) => sql.startsWith("INSERT INTO gc_stickers");
  const stickerRoutes = [
    { test: stickerTableInsert, run: async () => ({ meta: { changes: 1 } }) },
    { test: SESSION_READ_TEST, first: async () => (await SESSION_FIX).row },
    { test: MEMBERSHIP_TEST, first: async () => ({ member: 1 }) },
    { test: ROLE_READ_TEST, first: async () => ({ role: "member" }) },
    { test: MERGED_TEST, first: async () => ({ permissions: MANAGE_BIT }) },
  ];
  const sticker = await multipartExpression(
    stickerRoutes, "/api/servers/" + SERVER_ID + "/stickers", "partyparrot", oversizedSticker,
  );
  assert.equal(sticker.response.status, 413);
  assert.equal((await bodyOf(sticker.response)).error, "Stickers must be 512 KB or smaller.");

  // The under-cap emoji stores (the 20 MiB intake never fired its own ceiling
  // — the kind's cap rides the reader).
  const { response: stored, db: storedDb } = await multipartExpression(
    expressionRoutes(), "/api/servers/" + SERVER_ID + "/emojis", "partyparrot", pngLike(1024),
  );
  assert.equal(stored.status, 201, "the under-cap emoji stores");
  const insert = storedDb.calls.find((call) => call.call === "run" && call.sql.startsWith("INSERT INTO gc_emoji"));
  assert.ok(insert, "the under-cap create's INSERT ran");
});

test("a shared or message-attached asset can never START an expression life (the W-B0 create arms)", async () => {
  // The classifier state for each shared-arm shape: the asset exists, is
  // the caller's own, in-bounds — but already referenced.
  for (const [label, used] of [
    ["emoji-used", { assetEmojiUsed: 1 }],
    ["sticker-used", { assetStickersUsed: 1 }],
    ["sound-used", { assetSoundsUsed: 1 }],
    ["message-attached", { assetMessageId: 5 }],
  ]) {
    const response = await createWith(
      fakeDb(expressionRoutes({ insertChanges: 0, count: 0, ...used })),
      { name: "parrot", attachmentId: ATTACHMENT_ID },
    );
    assert.equal(response.status, 400, label);
    assert.equal(
      (await bodyOf(response)).error,
      "That image is already referenced elsewhere.",
      label,
    );
  }

  // The oversize legacy asset: own, but recorded size_bytes over the kind's
  // cap — the JSON branch's 413.
  const response = await createWith(
    fakeDb(expressionRoutes({ insertChanges: 0, count: 0, assetSize: GC_EMOJI_FILE_MAX + 1 })),
    { name: "parrot", attachmentId: ATTACHMENT_ID },
  );
  assert.equal(response.status, 413);
  assert.equal((await bodyOf(response)).error, "Emoji must be 256 KB or smaller.");
});

test("a legacy-shared row's delete: the sibling survives, the bytes stay (the chunk arms)", async () => {
  // The emoji row still has a STICKER sibling on the same asset: the row
  // leaves, but the chunk statement's sibling arm (post-row-delete) answers
  // zero changes and the attachment itself is never released either.
  const routes = [
    { test: (sql) => sql.startsWith("DELETE FROM gc_emoji"), run: async () => ({ meta: { changes: 1 } }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachment_chunks"), run: async () => ({ meta: { changes: 0 } }), first: async () => null, all: async () => ({ results: [] }) },
    { test: (sql) => sql.startsWith("DELETE FROM gc_attachments"), run: async () => ({ meta: { changes: 0 } }) },
    ...expressionRoutes({ insertChanges: undefined }),
  ];
  const db = fakeDb(routes);
  const response = await deleteWith(db, 4);
  assert.equal(response.status, 200);
  const batch = db.calls.find((call) => call.call === "batch");
  assert.equal(batch.statements.length, 3);
  // The chunk statement ran with zero changes: the sibling keeps its bytes.
  assert.equal(batch.statements[1].sql.startsWith("DELETE FROM gc_attachment_chunks"), true);
  assert.equal(batch.statements[2].sql.startsWith("DELETE FROM gc_attachments"), true);
});

// --- the token machinery -----------------------------------------------------------

test("the token builders and scanners round-trip, and the name cap keeps tokens inside the 32-char reaction CHECK", () => {
  assert.equal(emojiToken("partyparrot", 123), "<e:partyparrot:123>");
  assert.equal(stickerToken("partyparrot", 123), "<s:partyparrot:123>");

  // A 16-char name stays inside the reaction CHECK at the widest realistic id
  // (8 digits): 4 + 16 + 8 + 1 = 29.
  const widest = emojiToken("a".repeat(16), 99_999_999);
  assert.equal(widest.length, 29);
  assert.ok(widest.length <= 32);

  assert.deepEqual(referencedExpressionIds("hey <e:parrot:11> and <s:sticker_1:22> and <e:parrot:11> again"), {
    emojiIds: [11, 11],
    stickerIds: [22],
  });
  assert.deepEqual(referencedExpressionIds("plain text"), { emojiIds: [], stickerIds: [] });
  // A malformed token is never an expression.
  assert.deepEqual(referencedExpressionIds("<e:x:1>", ), { emojiIds: [], stickerIds: [] });
  assert.deepEqual(referencedExpressionIds("<e:parrot:0abc>"), { emojiIds: [], stickerIds: [] });
  EMOJI_TOKEN_PATTERN.lastIndex = 0;
  STICKER_TOKEN_PATTERN.lastIndex = 0;
});

async function gateCall(env, serverId, text) {
  // Direct call — the gate returns undefined on a pass and throws 403 on the
  // non-plus external use.
  return enforceExpressionTokenAccess(env, USER_ID, serverId, text);
}

// The gate's reads: one SELECT per referenced kind over its ids, plus the
// strict plus-perk read (renews_until > now) once an external id exists.
const PLUS_READ_TEST = { test: (sql) => sql.includes("FROM gc_plus_state WHERE user_id = ? LIMIT 1") };
const EMOJI_ID_READ_TEST = { test: (sql) => sql.startsWith("SELECT id, server_id FROM gc_emoji WHERE id IN") };
const STICKER_ID_READ_TEST = { test: (sql) => sql.startsWith("SELECT id, server_id FROM gc_stickers WHERE id IN") };

function gateEnv({ plus = false, emojiRows = [], stickerRows = [] } = {}) {
  return {
    GOOBER_DB: {
      prepare(sql) {
        let route = null;
        if (EMOJI_ID_READ_TEST.test(sql)) route = { all: async () => ({ results: emojiRows }) };
        else if (STICKER_ID_READ_TEST.test(sql)) route = { all: async () => ({ results: stickerRows }) };
        else if (PLUS_READ_TEST.test(sql)) {
          route = { first: async () => ({ renews_until: plus ? nowSeconds() + 600 : 0 }) };
        }
        return {
          bind: (...bound) => ({
            all: async () => (route?.all ? route.all(bound) : { results: [] }),
            first: async () => (route?.first ? route.first(bound) : null),
          }),
        };
      },
    },
  };
}

test("the gate passes a same-server token for any member, and unknown ids are just text", async () => {
  // Own-server emoji on the channel's own server: free for every member.
  const env = gateEnv({ emojiRows: [{ id: 11, server_id: SERVER_ID }] });
  await assert.doesNotReject(() => gateCall(env, SERVER_ID, "hi <e:parrot:11>"));

  // Unknown ids (a token nobody minted) render as text — no gate, no plus read.
  const unknown = gateEnv({ emojiRows: [] });
  await assert.doesNotReject(() => gateCall(unknown, SERVER_ID, "ghost <e:ghost:99>"));
});

test("a cross-server token without an active plus term is refused BEFORE anything is stored", async () => {
  const env = gateEnv({ plus: false, emojiRows: [{ id: 12, server_id: 777 }] });
  await assert.rejects(
    () => gateCall(env, SERVER_ID, "stealing <e:other:12>"),
    (error) => error instanceof HttpError && error.status === 403 &&
      error.message === "Using another server's emoji is a Goober+ perk.",
  );
});

test("an active plus term unlocks the cross-server token; a DM makes every token external", async () => {
  const plusEnv = gateEnv({ plus: true, emojiRows: [{ id: 12, server_id: 777 }] });
  await assert.doesNotReject(() => gateCall(plusEnv, SERVER_ID, "owning <e:other:12>"));

  // A DM/group channel has no channel server: even the member's OWN server's
  // emoji is the external perk there.
  const dmEnv = gateEnv({ plus: false, emojiRows: [{ id: 11, server_id: SERVER_ID }] });
  await assert.rejects(() => gateCall(dmEnv, null, "<e:own:11>"), (error) => error.status === 403);
  await gateCall(gateEnv({ plus: true, emojiRows: [{ id: 11, server_id: SERVER_ID }] }), null, "<e:own:11>");
});

test("the side table loader caps its reads at the inventory limits", async () => {
  const seen = [];
  const env = {
    GOOBER_DB: {
      prepare(sql) {
        seen.push(sql);
        return {
          // The 0023 resolver's boost read rides the same chain: a level-0
          // server (whose inventories list whatever exists — the reads are
          // never capped at the effective count).
          bind: () => ({ all: async () => ({ results: [] }), first: async () => ({ boosts: 0 }) }),
        };
      },
    },
  };
  const { emojis, stickers } = await (await import("../api/emoji.mjs")).loadServerExpressions(env, SERVER_ID);
  assert.deepEqual(emojis, []);
  assert.deepEqual(stickers, []);
  // The 0025 parity pass: the reads are UN-capped — an inventory built at a
  // higher level keeps its rows when the boosts lapse (never deleted, only
  // new creates blocked), and their tokens must still resolve, so the side
  // table bound on what EXISTS, never on the level's current count.
  const emojiRead = seen.find((sql) => sql.includes("gc_emoji") && sql.includes("ORDER BY name, id"));
  const stickerRead = seen.find((sql) => sql.includes("gc_stickers") && sql.includes("ORDER BY name, id"));
  assert.ok(emojiRead);
  assert.ok(stickerRead);
  assert.doesNotMatch(emojiRead, /LIMIT \d+/);
  assert.doesNotMatch(stickerRead, /LIMIT \d+/);
});

