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

// Servers and channels routes (Phase 1, Task 4): server create/list and the
// moderator-gated channel create, driven against a fake GOOBER_DB. Same fake
// conventions as the accounts test module — fakeDb records every statement's
// bound values, with batch() carrying each statement's SQL so tests can pin
// the guarded-SQL shape itself (the authorization contract lives in the
// query text, so that is what the tests assert).
import test from "node:test";
import assert from "node:assert/strict";

import { handleServerRoutes } from "../api/servers.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import {
  GC_ROLES_MAX_PER_SERVER,
  MAX_CHANNELS_PER_SERVER,
  RATE_LIMIT_BINDINGS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function postJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// Test dispatcher: mirrors worker.mjs's apiError mapping so HttpErrors surface
// as the same JSON responses the worker would return.
async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleServerRoutes(
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

// Ordered fake DB: the first matching route answers each statement shape.
// Top-level run() calls are recorded individually; batch() is recorded as ONE
// call carrying every statement's SQL + bound values (a real D1 batch executes
// its statements under a single transaction). Unrouted runs default to a
// single-row insert with an incrementing last_row_id, like a real write.
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
      // Batch statements execute without their own call entries: the batch
      // entry alone carries each statement's SQL + bound values.
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

// --- session fixtures -----------------------------------------------------------
// The signed-in shape: a session row behind the vendored readSession SELECT,
// with a real cookie/CSRF token pair for requireUser-routed requests.

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");

async function sessionFixtures() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
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
  };
  return { token, csrf, row };
}

// --- handler contract -----------------------------------------------------------

test("unknown API paths fall through to the worker's handler loop", async () => {
  const response = await handleServerRoutes(
    get("/api/nope"),
    { GOOBER_DB: fakeDb([]) },
    new URL(ORIGIN + "/api/nope"),
    "/api/nope",
    "GET",
    undefined,
  );
  assert.equal(response, undefined);
});

test("non-numeric server id paths fall through to the worker's 404", async () => {
  const response = await handleServerRoutes(
    postJson("/api/servers/abc/channels", { name: "x", kind: "text" }),
    { GOOBER_DB: fakeDb([]) },
    new URL(ORIGIN + "/api/servers/abc/channels"),
    "/api/servers/abc/channels",
    "POST",
    undefined,
  );
  assert.equal(response, undefined);
});

// --- POST /api/servers ----------------------------------------------------------

test("creating a server opens with one insert, builds the rest on its id, returns #general", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: (sql) =>
        sql.includes("SELECT id, name, kind, position FROM gc_channels WHERE server_id = ?") &&
        sql.includes("name = 'general'"),
      first: async () => ({ id: 4, name: "general", kind: "text", position: 0 }),
    },
  ]);
  const response = await dispatch(
    postJson(
      "/api/servers",
      { name: "Goober HQ" },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(await bodyOf(response), {
    server: { id: 1, name: "Goober HQ" },
    channels: [{ id: 4, name: "general", kind: "text", position: 0 }],
  });

  // The opener rides ONE run(): gc_servers' row inserts alone, because the
  // real (remote) D1 resets last_insert_rowid() across a batch()'s
  // statements — the build batch binds the opener's id explicitly instead,
  // and a failed build batch deletes the opener it opened (the compensated
  // create keeps all-or-nothing). The compensation's DELETE is only reached
  // on failure; the happy path shows none.
  const opener = db.calls.find(((call) => call.call === "run" && call.sql.includes("INSERT INTO gc_servers")));
  assert.ok(opener);
  assert.equal(opener.bound[0], "Goober HQ");
  assert.equal(opener.bound[1], USER_ID);
  // The opener's run plus the mint are the ONLY standalone write calls; the
  // economy re-rule's community-builder mint rides AFTER the build batch as
  // one failure-isolated INSERT ('server' source), never inside the batch —
  // coins can never fail a server.
  const mint = db.calls.find((call) => call.call === "run" && call.sql.includes("'server'"));
  assert.ok(mint);
  assert.match(mint.sql, /^INSERT INTO gc_coin_ledger \(user_id, delta, source, created_at\)/);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" &&
      /^(INSERT|UPDATE|DELETE)/.test(call.sql) && call !== opener && call !== mint),
    [],
  );

  const batch = db.calls.find((call) => call.call === "batch");
  assert.ok(batch);
  const writeSqls = batch.statements.map((statement) => statement.sql);
  // Scoping pin: every written table is a gc_ table.
  for (const writeSql of writeSqls) {
    assert.match(writeSql, /^INSERT INTO gc_/);
  }
  assert.deepEqual(writeSqls.length, 2);
  assert.match(writeSqls[0], /INSERT INTO gc_server_members/);
  assert.match(writeSqls[1], /INSERT INTO gc_channels/);
  assert.match(writeSqls[1], /'general', 'text', 0/);

  // Bindings: the build batch carries the opener's literal id, the session
  // user owns the server it creates.
  assert.equal(batch.statements[0].bound[0], 1);
  assert.equal(batch.statements[0].bound[1], USER_ID);
  assert.equal(batch.statements[0].bound[2], "owner");
  assert.equal(batch.statements[1].bound[0], 1);
});

test("server create rejects a whitespace-only name with 400 and zero D1 writes", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(
    postJson(
      "/api/servers",
      { name: "   " },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "Server name must be between 1 and 100 characters.",
  });
  // No batch, no write: only the session read ever reached the database.
  assert.deepEqual(
    db.calls.filter((call) => call.call === "batch" || call.call === "run"),
    [],
  );
});

test("server create demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(postJson("/api/servers", { name: "Goober HQ" }), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 401);
  // The vendored requireCsrf wording for a missing session.
  assert.deepEqual(await bodyOf(response), {
    error: "Your session has expired. Reload the page and sign in again.",
  });
  assert.deepEqual(
    db.calls.filter((call) => call.call === "batch" || call.call === "run"),
    [],
  );
});

// --- GET /api/servers -----------------------------------------------------------

const SERVERS_LIST_SELECT_TEST = (sql) =>
  sql.includes("FROM gc_server_members m") &&
  sql.includes("JOIN gc_servers s ON s.id = m.server_id") &&
  sql.includes("LEFT JOIN gc_channels c ON c.server_id = s.id") &&
  sql.includes("ORDER BY s.id, c.position, c.id");

test("GET /api/servers lists a member's two servers with roles, icon urls, and channel lists", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      // One joined query; rows arrive ordered by (server, position, id).
      test: SERVERS_LIST_SELECT_TEST,
      all: async () => ({
        results: [
          { server_id: 1, server_name: "Alpha", server_is_public: 1, server_icon_media_id: 12, role: "member", server_boosts: 3, boosted_by_me: 1, channel_id: 10, channel_name: "general", channel_kind: "text", channel_position: 0 },
          { server_id: 1, server_name: "Alpha", server_is_public: 1, server_icon_media_id: 12, role: "member", server_boosts: 3, boosted_by_me: 1, channel_id: 11, channel_name: "lounge", channel_kind: "voice", channel_position: 1 },
          { server_id: 2, server_name: "Beta", server_is_public: 0, server_icon_media_id: null, role: "moderator", server_boosts: 0, boosted_by_me: 0, channel_id: 13, channel_name: "general", channel_kind: "text", channel_position: 0 },
        ],
      }),
    },
  ]);
  const response = await dispatch(
    get("/api/servers", { Cookie: "__Host-goober_session=" + token }),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    servers: [
      {
        id: 1,
        name: "Alpha",
        isPublic: true,
        role: "member",
        iconUrl: "/api/attachments/12",
        // Goober+ boosts ride the list additively; a row without the columns
        // reads as unboosted and not boosted by the caller.
        boosts: 3,
        boostedByMe: true,
        channels: [
          { id: 10, name: "general", kind: "text", position: 0, isSpoiler: false },
          { id: 11, name: "lounge", kind: "voice", position: 1, isSpoiler: false },
        ],
      },
      {
        id: 2,
        name: "Beta",
        isPublic: false,
        role: "moderator",
        iconUrl: null,
        boosts: 0,
        boostedByMe: false,
        channels: [{ id: 13, name: "general", kind: "text", position: 0, isSpoiler: false }],
      },
    ],
  });

  // The one joined query also carries the DM/group exclusion explicitly, and
  // reads the icon pointer from the server row itself.
  const list = db.calls.find((call) => call.call === "all");
  assert.ok(list);
  assert.match(list.sql, /c\.server_id IS NOT NULL/);
  assert.match(list.sql, /s\.icon_media_id AS server_icon_media_id/);
});

test("GET /api/servers demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(get("/api/servers"), { GOOBER_DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(await bodyOf(response), { error: "Please sign in to do that." });
  // Never read a roster without a session — the caller's user_id is not guessed.
  assert.deepEqual(
    db.calls.filter((call) => call.call === "all"),
    [],
  );
});

// --- POST /api/servers/:id/channels ----------------------------------------------

const CHANNEL_INSERT_TEST = (sql) =>
  sql.includes("INSERT INTO gc_channels (server_id, name, kind, position, created_at)") &&
  sql.includes("FROM gc_server_members") &&
  sql.includes("COUNT(*)");

const CHANNEL_RESELECT_TEST = (sql) =>
  sql.includes("SELECT id, name, kind, position FROM gc_channels WHERE id = ? AND server_id = ?");

const MEMBERSHIP_ROLE_TEST = (sql) =>
  sql.includes("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?");

// Stateful channel-cap stand-in: the guarded INSERT's COUNT(*) precondition is
// real SQL, so the fake decides changes=0/1 from a simulated existing-channel
// count, exactly as D1 would.
function channelCapRoutes(role, existingChannels) {
  const state = { channels: existingChannels, role };
  return {
    state,
    routes: [
      {
        test: CHANNEL_INSERT_TEST,
        run: () => {
          // D1 evaluates BOTH preconditions (role and cap) inside the INSERT;
          // the fake refuses anything either would refuse.
          const privileged = state.role === "owner" || state.role === "moderator";
          if (!privileged || state.channels >= MAX_CHANNELS_PER_SERVER) {
            return { meta: { changes: 0 } };
          }
          state.channels += 1;
          return { meta: { changes: 1, last_row_id: 90 } };
        },
      },
      { test: MEMBERSHIP_ROLE_TEST, first: async () => (state.role ? { role: state.role } : null) },
      {
        test: CHANNEL_RESELECT_TEST,
        first: async () => ({
          id: 90,
          name: "voice-1",
          kind: "voice",
          position: state.channels - 1,
        }),
      },
    ],
  };
}

async function sessioned(routes) {
  const { token, csrf, row } = await sessionFixtures();
  return {
    db: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]),
    createChannelRequest: (body) =>
      postJson(
        "/api/servers/3/channels",
        body,
        { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
      ),
  };
}

test("an owner appends a channel at the next position inside the guarded INSERT", async () => {
  // Server #3 holds 499 channels (general + 498 more): the 500th is still
  // allowed — parity-limits.md: Channels per server 500, text+voice+
  // categories combined (verified 2026-11-17).
  const { routes } = channelCapRoutes("owner", 499);
  const { db, createChannelRequest } = await sessioned(routes);
  const response = await dispatch(createChannelRequest({ name: "voice-1", kind: "voice" }), {
    GOOBER_DB: db,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    channel: { id: 90, name: "voice-1", kind: "voice", position: 499 },
  });

  const insert = db.calls.find((call) => call.call === "run" && CHANNEL_INSERT_TEST(call.sql));
  assert.ok(insert);
  // The role precondition rides INSIDE the INSERT — no read-then-write gate.
  assert.match(insert.sql, /role IN \('owner','moderator'\)/);
  // The cap precondition rides INSIDE the INSERT (parity-limits.md: Channels
  // per server 500 — MAX 500, minus the one joining).
  assert.match(insert.sql, /\(SELECT COUNT\(\*\) FROM gc_channels WHERE server_id = \?\) <= 499/);
  // Position appends after the current max.
  assert.match(
    insert.sql,
    /\(SELECT COALESCE\(MAX\(position\), -1\) \+ 1 FROM gc_channels WHERE server_id = \?\)/,
  );
  // Bindings: server id, name, kind, then the subquery's server id, then the
  // created timestamp — never a client-supplied position. (The phase-3 role
  // extension adds the manages OR-clause binds after the timestamp: the
  // string-tier membership pair, then the H1 per-bit EXISTS pair, then the
  // cap's server id.)
  assert.deepEqual(
    insert.bound.filter((value, index) => index !== 4),
    [3, "voice-1", "voice", 3, 3, USER_ID, 3, USER_ID, 3],
  );
  assert.equal(typeof insert.bound[4], "number");
});

test("the channel create past the 500-channel cap 400s with the exact limit message", async () => {
  // Server #3 is already at the cap (500 channels — the parity law's row):
  // the guarded INSERT's COUNT(*) precondition lets nothing through, and the
  // membership read that follows only classifies the failure — authority
  // stayed inside the INSERT.
  const { state, routes } = channelCapRoutes("owner", MAX_CHANNELS_PER_SERVER);
  const { db, createChannelRequest } = await sessioned(routes);
  const response = await dispatch(createChannelRequest({ name: "voice-2", kind: "voice" }), {
    GOOBER_DB: db,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "That server has reached its channel limit.",
  });
  assert.equal(state.channels, MAX_CHANNELS_PER_SERVER); // nothing was created
  const insert = db.calls.find((call) => call.call === "run" && CHANNEL_INSERT_TEST(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /INSERT INTO gc_channels/);
});

test("a plain member's channel create 403s instead of the cap message", async () => {
  const { state, routes } = channelCapRoutes("member", 0);
  const { db, createChannelRequest } = await sessioned(routes);
  const response = await dispatch(createChannelRequest({ name: "secret", kind: "text" }), {
    GOOBER_DB: db,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), {
    error: "You do not have permission to do that.",
  });
  assert.equal(state.channels, 0);
  // The guarded insert ran (changes=0), then the role diagnostic classified it.
  assert.ok(db.calls.find((call) => call.call === "run" && CHANNEL_INSERT_TEST(call.sql)));
  assert.ok(db.calls.find((call) => MEMBERSHIP_ROLE_TEST(call.sql)));
});

test("a non-member's channel create 403s and reveals no server existence", async () => {
  const { state, routes } = channelCapRoutes(null, 0);
  const { db, createChannelRequest } = await sessioned(routes);
  const response = await dispatch(createChannelRequest({ name: "secret", kind: "text" }), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), {
    error: "You do not have permission to do that.",
  });
  assert.equal(state.channels, 0);
});

test("channel create rejects a non-text/voice/announcement kind with 400 before any write", async () => {
  const { routes } = channelCapRoutes("owner", 0);
  const { db, createChannelRequest } = await sessioned(routes);
  const response = await dispatch(createChannelRequest({ name: "dm-ish", kind: "dm" }), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "Channel kind must be text, voice or announcement.",
  });
  assert.equal(
    db.calls.find((call) => CHANNEL_INSERT_TEST(call.sql)),
    undefined,
  );
});

test("channel create rejects a whitespace-only name with 400 before any write", async () => {
  const { routes } = channelCapRoutes("owner", 0);
  const { db, createChannelRequest } = await sessioned(routes);
  const response = await dispatch(createChannelRequest({ name: "  ", kind: "text" }), {
    GOOBER_DB: db,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "Channel name must be between 1 and 100 characters.",
  });
  assert.equal(
    db.calls.find((call) => CHANNEL_INSERT_TEST(call.sql)),
    undefined,
  );
});

test("channel create demands a signed-in session", async () => {
  const db = fakeDb([]);
  const response = await dispatch(
    postJson("/api/servers/3/channels", { name: "nope", kind: "text" }),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 401);
  // The vendored requireCsrf wording for a missing session.
  assert.deepEqual(await bodyOf(response), {
    error: "Your session has expired. Reload the page and sign in again.",
  });
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

// --- PATCH /api/servers/:id (server settings: name + icon) -------------------------

const SERVER_UPDATE_TEST = (sql) =>
  sql.includes("UPDATE gc_servers") && sql.includes("owner_user_id = ?");

const SERVER_RESELECT_TEST = (sql) =>
  sql.includes("SELECT id, name, icon_media_id, is_public, verification_level FROM gc_servers");

// The icon intake reused verbatim from api/media.mjs: the standalone
// attachment INSERT (status='pending') plus its 64k chunk INSERTs — no new
// storage SQL may appear next to them.
const ATTACHMENT_INTAKE_TEST = (sql) =>
  sql.includes("INSERT INTO gc_attachments (message_id, uploader_id, mime, size_bytes, status, width, height, created_at)") &&
  sql.includes("'pending'");

const CHUNK_INTAKE_TEST = (sql) => sql.includes("INSERT INTO gc_attachment_chunks");

function patchJson(path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// A real multipart/form-data PATCH, exactly as the browser builds it: `name`
// as a text field, the icon as the `image` file part.
function patchMultipart(path, { fields = {}, files = [] }, headers = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
  for (const file of files) {
    form.append(file.field || "image", new File([file.bytes], file.name || "icon.png"));
  }
  return new Request(ORIGIN + path, {
    method: "PATCH",
    headers: { Origin: ORIGIN, ...headers },
    body: form,
  });
}

function envWithLimiters(extra = {}) {
  const env = { ...extra };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The smallest PNG the intake's sanitizer keeps verbatim (signature + IHDR +
// IEND): enough for createAttachment to accept it and store it pending.
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

function pngImage() {
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("IEND"),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Stateful PATCH stand-in: the guarded UPDATE is real SQL, so the fake decides
// changes=0/1 from the ownership precondition's own bindings, exactly as D1
// would (the bind layout is [setBinds..., serverId, ownerId] — the owner id is
// always the last one).
function serverPatchRoutes({ ownerId = USER_ID, reselect = null } = {}) {
  return {
    routes: [
      {
        test: SERVER_UPDATE_TEST,
        run: (bound) => {
          if (Number(bound[bound.length - 1]) !== Number(ownerId)) {
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 1 } };
        },
      },
      {
        test: SERVER_RESELECT_TEST,
        first: async () =>
          reselect || { id: 3, name: "Renamed", icon_media_id: 5, is_public: 0 },
      },
    ],
  };
}

const ICON_GUARD_TEST = (sql) =>
  sql.includes("AND EXISTS (SELECT 1 FROM gc_attachments WHERE id = ? AND uploader_id = ?)");

test("an owner renames the server in one guarded UPDATE", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const { routes } = serverPatchRoutes({ ownerId: USER_ID });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const response = await dispatch(
    patchJson(
      "/api/servers/3",
      { name: "Renamed" },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    server: { id: 3, name: "Renamed", iconUrl: "/api/attachments/5", isPublic: false },
  });

  // One UPDATE, no batch: the ownership rides the WHERE, never a read-then-
  // write gate; only the session read and the owner-guarded reselect surround
  // the write.
  const update = db.calls.find((call) => call.call === "run" && SERVER_UPDATE_TEST(call.sql));
  assert.ok(update);
  assert.match(update.sql, /^UPDATE gc_servers SET name = \? WHERE id = \? AND owner_user_id = \?$/);
  assert.deepEqual(update.bound, ["Renamed", 3, USER_ID]);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "batch"),
    [],
  );
  assert.ok(db.calls.find((call) => SERVER_RESELECT_TEST(call.sql)));
});

test("a non-owner's PATCH 403s with zero changes and no existence probe", async () => {
  const { token, csrf, row } = await sessionFixtures();
  // A different member owns server #3: the guarded UPDATE itself refuses.
  const { routes } = serverPatchRoutes({ ownerId: 999, reselect: null });
  const notOwnerRoutes = [routes[0], { ...routes[1], first: async () => null }];
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...notOwnerRoutes]);
  const response = await dispatch(
    patchJson(
      "/api/servers/3",
      { name: "Renamed" },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  // No diagnostic read between the failed UPDATE and the 403: an unknown
  // server id answers the exact same 403 — no existence oracle.
  const update = db.calls.find((call) => call.call === "run" && SERVER_UPDATE_TEST(call.sql));
  assert.ok(update);
  const indexOfUpdate = db.calls.findIndex((call) => call === update);
  assert.deepEqual(
    db.calls.filter(
      (call, index) =>
        index > indexOfUpdate &&
        call.call === "first" &&
        !SERVER_RESELECT_TEST(call.sql),
    ),
    [],
  );
});

test("PATCH with iconMediaId null clears the icon without the attachment guard", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const { routes } = serverPatchRoutes({ ownerId: USER_ID });
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]);
  const response = await dispatch(
    patchJson(
      "/api/servers/3",
      { iconMediaId: null },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 200);
  const update = db.calls.find((call) => call.call === "run" && SERVER_UPDATE_TEST(call.sql));
  assert.ok(update);
  // The clear binds an explicit NULL and the EXISTS reference guard is absent
  // — there is nothing to own.
  assert.match(update.sql, /SET icon_media_id = \? WHERE id = \? AND owner_user_id = \?$/);
  assert.doesNotMatch(update.sql, /EXISTS/);
  assert.equal(update.bound[0], null);
  assert.deepEqual(update.bound, [null, 3, USER_ID]);
});

test("PATCH refuses to point the icon at another member's attachment inside the UPDATE", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const { routes } = serverPatchRoutes({ ownerId: USER_ID, reselect: null });
  // The fake acts as D1 would when the ownership guard passes but the
  // EXISTS(attachment owned by the caller) fails: zero changes, then the 403.
  const guardedRoutes = [
    {
      test: SERVER_UPDATE_TEST,
      run: async () => ({ meta: { changes: 0 } }),
    },
  ];
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...guardedRoutes]);
  const response = await dispatch(
    patchJson(
      "/api/servers/3",
      { iconMediaId: 55 },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "You do not have permission to do that." });
  // The guard rides the UPDATE itself, pinned in the query text: the id being
  // set must exist AND belong to the caller.
  const update = db.calls.find((call) => call.call === "run" && SERVER_UPDATE_TEST(call.sql));
  assert.ok(update);
  assert.match(update.sql, /SET icon_media_id = \? WHERE id = \? AND owner_user_id = \?/);
  assert.ok(ICON_GUARD_TEST(update.sql));
  // setBinds, (server id, owner id), then the guard's (icon id, owner id).
  assert.deepEqual(update.bound, [55, 3, USER_ID, 55, USER_ID]);
  // Nothing is read back after the failed UPDATE — no oracle either way.
  assert.equal(db.calls.filter((call) => SERVER_RESELECT_TEST(call.sql)).length, 0);
});

test("PATCH accepts an icon id that IS one of the caller's own attachments", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const ownedRoutes = [
    {
      test: SERVER_UPDATE_TEST,
      run: async () => ({ meta: { changes: 1 } }),
    },
    {
      test: SERVER_RESELECT_TEST,
      first: async () => ({ id: 3, name: "Alpha", icon_media_id: 12, is_public: 1 }),
    },
  ];
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...ownedRoutes]);
  const response = await dispatch(
    patchJson(
      "/api/servers/3",
      { iconMediaId: 12 },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    server: { id: 3, name: "Alpha", iconUrl: "/api/attachments/12", isPublic: true },
  });
  const update = db.calls.find((call) => call.call === "run" && SERVER_UPDATE_TEST(call.sql));
  assert.deepEqual(update.bound, [12, 3, USER_ID, 12, USER_ID]);
});

test("PATCH validates iconMediaId's shape before any statement runs", async () => {
  for (const bad of ["12", 0, -3, 4.5]) {
    const { token, csrf, row } = await sessionFixtures();
    const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
    const response = await dispatch(
      patchJson(
        "/api/servers/3",
        { iconMediaId: bad },
        { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
      ),
      { GOOBER_DB: db },
    );
    assert.equal(response.status, 400, "iconMediaId " + JSON.stringify(bad) + " must 400");
    assert.deepEqual(
      db.calls.filter((call) => call.call === "run" || call.call === "batch"),
      [],
    );
  }
});

test("PATCH with no recognized fields is a 400 with zero statements", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(
    patchJson("/api/servers/3", {}, { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf }),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("PATCH validates an empty name like create, before any write", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(
    patchJson(
      "/api/servers/3",
      { name: "   " },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    error: "Server name must be between 1 and 100 characters.",
  });
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("a multipart PATCH rides the media intake and one guarded UPDATE", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const intakeRoutes = [
    {
      test: SERVER_UPDATE_TEST,
      // The owner id + the EXISTS guard pass (user 7 owns the id the intake
      // just generated, which the fake's default batch rows returns as 1).
      run: async (bound) => {
        const [name, iconId, , ownerId, guardedId, guardedUploaderId] = bound;
        if (Number(ownerId) !== USER_ID) return { meta: { changes: 0 } };
        if (guardedUploaderId !== undefined) {
          if (
            Number(guardedUploaderId) !== USER_ID ||
            Number(guardedId) !== Number(iconId)
          ) {
            return { meta: { changes: 0 } };
          }
        }
        state.name = name;
        state.icon = Number(iconId);
        return { meta: { changes: 1 } };
      },
    },
    {
      test: SERVER_RESELECT_TEST,
      first: async () => ({ id: 3, name: "Renamed via multipart", icon_media_id: 1, is_public: 0 }),
    },
  ];
  const state = { name: null, icon: null };
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...intakeRoutes]);

  const response = await dispatch(
    patchMultipart(
      "/api/servers/3",
      {
        fields: { name: "Renamed via multipart" },
        files: [{ bytes: pngImage(), name: "icon.png" }],
      },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    envWithLimiters({ GOOBER_DB: db }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    server: { id: 3, name: "Renamed via multipart", iconUrl: "/api/attachments/1", isPublic: false },
  });

  // The upload REUSED createAttachment's exact intake batch: the pending
  // attachment row plus its chunk INSERT — zero new storage SQL next to it.
  const intakeBatch = db.calls.find(
    (call) =>
      call.call === "batch" &&
      call.statements.some((statement) => ATTACHMENT_INTAKE_TEST(statement.sql)),
  );
  assert.ok(intakeBatch);
  assert.deepEqual(
    intakeBatch.statements[0].bound,
    [USER_ID, "image/png", pngImage().length, intakeBatch.statements[0].bound[3]],
  );
  assert.ok(intakeBatch.statements.some((statement) => CHUNK_INTAKE_TEST(statement.sql)));

  // …and the UPDATE consumed the id the intake produced, with both guards aboard.
  const update = db.calls.find((call) => call.call === "run" && SERVER_UPDATE_TEST(call.sql));
  assert.ok(update);
  assert.equal(state.icon, 1);
  assert.equal(state.name, "Renamed via multipart");
  assert.match(update.sql, /SET name = \?, icon_media_id = \?/);
  assert.match(update.sql, /EXISTS \(SELECT 1 FROM gc_attachments WHERE id = \? AND uploader_id = \?\)/);
  // name, icon id, server id, owner id, then the guard's (id, uploader) pair.
  assert.equal(update.bound[0], "Renamed via multipart");
  assert.equal(Number(update.bound[1]), 1);
  // The upload rides the same "upload" limiter the standalone intake uses.
  assert.ok(db.calls.find((call) => call.call === "run" && !SERVER_UPDATE_TEST(call.sql)) === undefined);
});

test("a multipart PATCH demands the upload limiter like the standalone intake", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(
    patchMultipart(
      "/api/servers/3",
      { files: [{ bytes: pngImage() }] },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    { GOOBER_DB: db },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

test("a multipart PATCH with a whitespace-only name 400s before any write", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([{ test: SESSION_READ_TEST, first: async () => row }]);
  const response = await dispatch(
    patchMultipart(
      "/api/servers/3",
      {
        fields: { name: "   " },
        files: [{ bytes: pngImage() }],
      },
      { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
    ),
    envWithLimiters({ GOOBER_DB: db }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(
    db.calls.filter((call) => call.call === "run" || call.call === "batch"),
    [],
  );
});

// --- POST /api/servers/:id/roles (the 250-roles parity cap) ----------------------

const ROLE_INSERT_TEST = (sql) =>
  sql.includes("INSERT INTO gc_roles (server_id, name, color, position, permissions, created_at)") &&
  sql.includes("FROM gc_server_members") &&
  sql.includes("COUNT(*)");

const ROLE_CAP_COUNT_TEST = (sql) =>
  sql.includes("SELECT COUNT(*) AS n FROM gc_roles WHERE server_id = ?");

const ROLE_RESELECT_TEST = (sql) =>
  sql.includes("SELECT id, name, color, position, permissions FROM gc_roles WHERE id = ? AND server_id = ?");

// Stateful role-cap stand-in, the channelCapRoutes idiom: the guarded INSERT's
// COUNT(*) precondition is real SQL, so the fake decides changes=0/1 from a
// simulated existing-role row count, exactly as D1 would.
function roleCapRoutes(role, existingRoles) {
  const state = { roles: existingRoles, role };
  return {
    state,
    routes: [
      {
        test: ROLE_INSERT_TEST,
        run: () => {
          // D1 evaluates BOTH preconditions (owner/MANAGE_ROLES and the cap)
          // inside the INSERT; the fake refuses anything either would refuse.
          const privileged = state.role === "owner" || state.role === "moderator";
          if (!privileged || state.roles >= GC_ROLES_MAX_PER_SERVER - 1) {
            return { meta: { changes: 0 } };
          }
          state.roles += 1;
          return { meta: { changes: 1, last_row_id: 90 } };
        },
      },
      { test: ROLE_CAP_COUNT_TEST, first: async () => ({ n: state.roles }) },
      {
        test: ROLE_RESELECT_TEST,
        first: async () => ({
          id: 90,
          name: "night-owl",
          color: null,
          position: state.roles - 1,
          permissions: 0,
        }),
      },
    ],
  };
}

async function sessionedRoles(routes) {
  const { token, csrf, row } = await sessionFixtures();
  return {
    db: fakeDb([{ test: SESSION_READ_TEST, first: async () => row }, ...routes]),
    createRoleRequest: (body) =>
      postJson(
        "/api/servers/3/roles",
        body,
        { Cookie: "__Host-goober_session=" + token, "X-CSRF-Token": csrf },
      ),
  };
}

test("the role cap's operator is the off-by-one-fixed strict `<`, keyed at 249", async () => {
  // A full server (249 explicit gc_roles rows) admits no 250th: 250 counts
  // @everyone, which sits in no gc_roles row, so the explicit-row ceiling is
  // 249 and the insert must land INTO <= 248 (strictly below the ceiling) —
  // parity-limits.md: Roles per server 250 including @everyone, error 30005
  // (verified 2026-11-17). The fake refuses at >= 249, exactly as the SQL
  // precondition (`< 249`) does, and the diagnostic read classifies the 400.
  const { state, routes } = roleCapRoutes("owner", 249);
  const { db, createRoleRequest } = await sessionedRoles(routes);
  const response = await dispatch(createRoleRequest({ name: "night-owl" }), {
    GOOBER_DB: db,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await bodyOf(response), {
    // The exact cap copy, NOT the 403: n = 249 keys the diagnostic
    // (`>= GC_ROLES_MAX_PER_SERVER - 1`), so a full server names the cap.
    error: "That server already has the maximum number of roles.",
  });
  assert.equal(state.roles, 249); // nothing was created

  const insert = db.calls.find((call) => call.call === "run" && ROLE_INSERT_TEST(call.sql));
  assert.ok(insert);
  // The authority rider rides INSIDE the INSERT — no read-then-write gate.
  assert.match(insert.sql, /om\.role = 'owner'/);
  // THE SHAPE PIN: the cap operator is strict `<` at the explicit-row ceiling —
  // a `<=` (the pre-fix operator) would admit a 250th explicit row and make
  // 251 total incl. @everyone, off by one from the parity row.
  assert.match(
    insert.sql,
    /\(SELECT COUNT\(\*\) FROM gc_roles WHERE server_id = \?\) < 249/,
  );
  assert.doesNotMatch(insert.sql, /\) <= 249/);
  // Bindings, pinned at the RIDER-ERA-INVARIANT subset: the composed WHERE
  // changes ONLY its authority arm between the rider eras (rewrite-era
  // mask-pair MERGED_PERMS_SELECT vs the union-era holdsRolesBitsSql
  // per-bit EXISTS — the union law keeps ONE composed form and
  // roles-module.test.mjs pins its full bind tail), so this pin holds
  // across BOTH: the column head (server id, name, color), the permissions
  // mask built from names, the now timestamp — and the cap's server id
  // riding LAST (the cap arm closes the WHERE in every era) — never a
  // client-supplied number anywhere.
  assert.deepEqual(insert.bound.slice(0, 3), [3, "night-owl", null]);
  assert.equal(insert.bound[4], 0);
  assert.equal(typeof insert.bound[5], "number");
  assert.equal(insert.bound[insert.bound.length - 1], 3);
});

test("the role cap lands INTO 248: the 250th explicit role joins at the fixed count", async () => {
  // 248 existing rows passes the strict precondition (`< 249`), landing this
  // create INTO <= 248 — the ceiling 249 explicit rows is only ever refused.
  assert.equal(GC_ROLES_MAX_PER_SERVER, 250); // parity-limits.md row, 2026-11-17
  const { state, routes } = roleCapRoutes("owner", 248);
  const { db, createRoleRequest } = await sessionedRoles(routes);
  const response = await dispatch(createRoleRequest({ name: "night-owl" }), {
    GOOBER_DB: db,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    role: { id: 90, name: "night-owl", color: null, position: 248, permissions: [] },
  });
  assert.equal(state.roles, 249); // the ceiling is now live for the next create

  const insert = db.calls.find((call) => call.call === "run" && ROLE_INSERT_TEST(call.sql));
  assert.ok(insert);
  assert.match(
    insert.sql,
    /\(SELECT COUNT\(\*\) FROM gc_roles WHERE server_id = \?\) < 249/,
  );
  // Position appends after the current max, inside the statement.
  assert.match(
    insert.sql,
    /\(SELECT COALESCE\(MAX\(position\), -1\) \+ 1 FROM gc_roles WHERE server_id = \?\)/,
  );
});
