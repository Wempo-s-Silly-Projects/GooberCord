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

// The Morning Paper (the re-coded daily digest): the server reading ITS OWN
// rows back. The config row IS the whole seat (absence = off-state); the
// paper is DERIVED ON REQUEST — it mints nothing, sinks nothing, tracks
// nothing, and no write statement of any kind may fire during a read.
//
// Same fakeDb + pinned-SQL contract style as coins-module: every guard rides
// INSIDE the SQL, and the fake's handlers ENCODE that guard (the mod gate on
// the enable upsert, the UTC day-key window) so a pinned statement that loses
// an arm fails the tests.
import test from "node:test";
import assert from "node:assert/strict";

import { handlePaperRoutes } from "../api/paper.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import {
  GC_PAPER_ANNIVERSARIES_MAX,
  GC_PAPER_CHANNELS_MAX,
  GC_PAPER_DAY_SECONDS,
  GC_PAPER_REACTIONS_MAX,
  GC_PAPER_YESTERDAY_KEYS,
} from "../constants.mjs";

const ORIGIN = "http://localhost";
const USER_ID = 7;
const SERVER_ID = 500;
const NOW = nowSeconds();
const DAY_START = NOW - (NOW % GC_PAPER_DAY_SECONDS);
const TODAY_MONTH = new Date(NOW * 1000).getUTCMonth();
const TODAY_DAY = new Date(NOW * 1000).getUTCDate();

// --- shared scaffolding (coins-module conventions) ------------------------------

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

function request(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handlePaperRoutes(
      request, env, url, url.pathname, request.method.toUpperCase(), undefined,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(error.payload || { error: error.message }, error.status, error.headers);
  }
  return response ?? new Response(
    JSON.stringify({ error: "That API endpoint does not exist." }),
    { status: 404 },
  );
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = {
      limit: async ({ key }) => ({ success: true, key }),
    };
  }
  return env;
}

// --- the stateful fake -----------------------------------------------------------

function paperDb(memberRows, options = {}) {
  // No members given = the plain default member (user 7 on this server).
  const provided = (Array.isArray(memberRows) ? memberRows : [])
    .concat(options.members || []);
  const members = (provided.length ? provided : [
    { server_id: SERVER_ID, user_id: USER_ID, role: "member" },
  ]).map((row) => ({ ...row }));
  const configs = new Map(options.configs || []); // server_id -> { enabled, updated_by, updated_at }
  const channels = (options.channels || []).map((row) => ({ ...row }));
  const messages = (options.messages || []).map((row) => ({ ...row }));
  const reactions = (options.reactions || []).map((row) => ({ ...row }));
  const anniversaries = new Map((options.anniversaries || [])
    .map((row) => [row.user_id, { ...row }]));
  const users = new Map((options.users || [])
    .map((row) => [row.id, { ...row }]));
  const calls = [];

  const serverChannels = (serverId) =>
    channels.filter((row) => row.server_id === serverId);
  const textChannelIds = (serverId) =>
    serverChannels(serverId).filter((row) => row.kind === "text").map((row) => row.id);
  const memberOf = (serverId, userId) => members.find(
    (row) => row.server_id === serverId && row.user_id === userId,
  );
  const modMember = (serverId, userId) => {
    const row = memberOf(serverId, userId);
    return row && (row.role === "owner" || row.role === "moderator") && row;
  };
  // The read-time LIMIT: the sections' aggregates cut at the LIMIT arm baked
  // into the pinned SQL — the fake honors it so a statement that loses the
  // arm fails the cap tests.
  const sqlLimit = (sql) => {
    const match = /\bLIMIT (\d+)\s*$/.exec(sql);
    return match ? Number(match[1]) : Infinity;
  };

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      // The membership gate — pinned SQL shape, unknown-server 404 encoded
      // by answering null (the route classifies). The demod-race option
      // answers the read AS a moderator and then strips the seat (the
      // demod lands between the gate read and the statement) — the delete
      // statement's own gate is what must refuse.
      test: (sql) =>
        sql.startsWith("SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ?"),
      first: async (bound) => {
        const row = memberOf(bound[0], bound[1]);
        if (!row) return null;
        const answer = { ...row };
        if (options.demodAfterMembershipRead) row.role = "member";
        return answer;
      },
    },
    {
      test: (sql) => sql.startsWith("SELECT enabled FROM gc_paper_configs WHERE server_id = ?"),
      first: async (bound) => configs.get(bound[0]) || null,
    },
    {
      // The mod-gated ON upsert: the gate rides INSIDE the statement's WHERE —
      // a non-mod's write makes zero changes and conjures no row.
      test: (sql) => sql.startsWith("INSERT INTO gc_paper_configs"),
      run: (bound) => {
        // [serverId, enabled, updatedBy, now, gateServerId, gateUserId]
        const [serverId, enabled, updatedBy, updatedAt, gateServer, gateUser] = bound;
        if (!modMember(gateServer, gateUser)) return { meta: { changes: 0 } };
        configs.set(serverId, { enabled, updated_by: updatedBy, updated_at: updatedAt });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The OFF-transition: the whole off-state is the row's absence —
      // GATED like the ON upsert: the statement's own EXISTS carries the
      // mod verdict (a demod between the route's read and this run makes
      // zero changes, never a delete).
      test: (sql) => sql.startsWith("DELETE FROM gc_paper_configs WHERE server_id = ?"),
      run: (bound) => {
        const [serverId, gateServer, gateUser] = bound;
        if (bound.length > 2 && !modMember(gateServer, gateUser)) {
          return { meta: { changes: 0 } };
        }
        const had = configs.has(serverId);
        configs.delete(serverId);
        return { meta: { changes: had ? 1 : 0 } };
      },
    },
    {
      // Channels section: per-channel counts over the server's public TEXT
      // channels, windowed, ordered by count then id.
      test: (sql) => sql.includes("GROUP BY m.channel_id"),
      all: async (bound, stmtSql) => {
        const [serverId, startSeconds, endSeconds] = bound;
        const counts = new Map();
        for (const message of messages) {
          const channel = channels.find((row) => row.id === message.channel_id);
          if (!channel || channel.server_id !== serverId || channel.kind !== "text") continue;
          if (message.created_at < startSeconds || message.created_at >= endSeconds) continue;
          counts.set(message.channel_id, (counts.get(message.channel_id) || 0) + 1);
        }
        const rows = [...counts.entries()]
          .map(([channelId, count]) => ({ channel_id: channelId, row_count: count }))
          .sort((left, right) => right.row_count - left.row_count || left.channel_id - right.channel_id);
        return { results: rows.slice(0, sqlLimit(stmtSql)) };
      },
    },
    {
      // Reactions section: the window's most-given tokens on the server's
      // text-channel messages, grouped by emoji only (no member column).
      test: (sql) => sql.includes("GROUP BY r.emoji"),
      all: async (bound, stmtSql) => {
        const [serverId, startSeconds, endSeconds] = bound;
        const textIds = textChannelIds(serverId);
        const counts = new Map();
        for (const reaction of reactions) {
          const message = messages.find((row) => row.id === reaction.message_id);
          if (!message || !textIds.includes(message.channel_id)) continue;
          if (reaction.created_at < startSeconds || reaction.created_at >= endSeconds) continue;
          counts.set(reaction.emoji, (counts.get(reaction.emoji) || 0) + 1);
        }
        const rows = [...counts.entries()]
          .map(([emoji, count]) => ({ emoji, row_count: count }))
          .sort((left, right) => right.row_count - left.row_count || left.emoji.localeCompare(right.emoji));
        return { results: rows.slice(0, sqlLimit(stmtSql)) };
      },
    },
    {
      // The celebrants ride-along: read-only, month+day equality, members only.
      test: (sql) => sql.includes("FROM gc_user_anniversaries a"),
      all: async (bound, stmtSql) => {
        const [month, day, serverId] = bound;
        return {
          results: [...anniversaries.values()]
            .filter((row) => row.month === month && row.day === day && memberOf(serverId, row.user_id))
            .map((row) => ({
              id: row.user_id,
              username: (users.get(row.user_id) || { username: "" }).username,
            }))
            .slice(0, sqlLimit(stmtSql)),
        };
      },
    },
    {
      // The self-scoped anniversary upsert (the ONE set statement).
      test: (sql) => sql.startsWith("INSERT INTO gc_user_anniversaries"),
      run: (bound) => {
        const [userId, month, day] = bound;
        anniversaries.set(userId, { user_id: userId, month, day });
        return { meta: { changes: 1 } };
      },
    },
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_user_anniversaries WHERE user_id = ?"),
      run: (bound) => {
        const had = anniversaries.has(bound[0]);
        anniversaries.delete(bound[0]);
        return { meta: { changes: had ? 1 : 0 } };
      },
    },
  ];

  return {
    calls,
    members,
    configs,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound });
        return route && route.first ? await route.first(statement.bound, sql) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound });
        return route && route.all ? await route.all(statement.bound, sql) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound });
        if (!route || !route.run) return { meta: { changes: 1 } };
        return route.run(statement.bound);
      };
      return statement;
    },
    batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
  };
}

const modMembers = (overrides = []) => [
  { server_id: SERVER_ID, user_id: USER_ID, role: "moderator" },
  ...overrides,
];

const freshServer = () => ({
  channels: [
    { id: 11, server_id: SERVER_ID, kind: "text" },
    { id: 12, server_id: SERVER_ID, kind: "voice" },
    { id: 13, server_id: 501, kind: "text" },
  ],
  messages: [
    { id: 1, channel_id: 11, created_at: DAY_START + 10 },
    { id: 2, channel_id: 11, created_at: DAY_START + 20 },
    { id: 3, channel_id: 11, created_at: DAY_START + 30 },
    { id: 4, channel_id: 11, created_at: DAY_START - 100 }, // yesterday
    { id: 5, channel_id: 11, created_at: DAY_START + GC_PAPER_DAY_SECONDS }, // tomorrow
    { id: 7, channel_id: 12, created_at: DAY_START + 40 }, // voice: outside the paper
    { id: 9, channel_id: 13, created_at: DAY_START + 50 }, // foreign server
    { id: 10, channel_id: 13, created_at: DAY_START + 51 },
  ],
  reactions: [
    { message_id: 1, user_id: 2, emoji: "fire", created_at: DAY_START + 10 },
    { message_id: 2, user_id: 3, emoji: "fire", created_at: DAY_START + 20 },
    { message_id: 2, user_id: 4, emoji: "party", created_at: DAY_START + 30 },
    { message_id: 4, user_id: 5, emoji: "party", created_at: DAY_START - 50 }, // yesterday
    { message_id: 7, user_id: 6, emoji: "rocket", created_at: DAY_START + 40 }, // voice channel
  ],
});

// --- the numbers -----------------------------------------------------------------

test("the paper's caps and windows ride constants.mjs, never magic numbers", () => {
  assert.equal(GC_PAPER_DAY_SECONDS, 86400);
  assert.equal(GC_PAPER_CHANNELS_MAX, 10);
  assert.equal(GC_PAPER_REACTIONS_MAX, 10);
  assert.equal(GC_PAPER_ANNIVERSARIES_MAX, 25);
  assert.equal(GC_PAPER_YESTERDAY_KEYS, 1);
});

// --- the seat (defaults law) ------------------------------------------------------

test("an untouched server answers every paper route with the unconfigured 404 and writes nothing", async () => {
  const db = paperDb();
  const env = envWithLimiters(db);

  const read = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  assert.equal(read.status, 404);
  assert.match(await read.text(), /Morning Paper/);

  const previous = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper/previous"), env);
  assert.equal(previous.status, 404);

  const writes = db.calls.filter((call) =>
    call.sql.startsWith("INSERT") || call.sql.startsWith("UPDATE") || call.sql.startsWith("DELETE"));
  assert.deepEqual(writes, [], "an off server conjures no config row");
  assert.deepEqual(db.configs, new Map(), "the seat stays empty");
});

test("the mod's explicit ON act writes ONE config row, and the mod gate rides INSIDE the statement", async () => {
  const db = paperDb(modMembers());
  const env = envWithLimiters(db);

  const response = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: true }), env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { enabled: true });

  const stored = db.configs.get(SERVER_ID);
  assert.ok(stored, "the seat row exists");
  assert.equal(stored.enabled, 1);
  assert.equal(stored.updated_by, USER_ID, "the enabling mod's seat is stamped");

  const enableSql = db.calls.find((call) => call.sql.startsWith("INSERT INTO gc_paper_configs"));
  assert.match(enableSql.sql, /INSERT INTO gc_paper_configs \(server_id, enabled, updated_by, updated_at\)/);
  assert.match(enableSql.sql, /ON CONFLICT \(server_id\) DO UPDATE/);
  // The statement gate: a non-mod's write changes nothing structurally.
  assert.match(enableSql.sql, /WHERE EXISTS \(SELECT 1 FROM gc_server_members/);
  assert.match(enableSql.sql, /pm\.role IN \('owner','moderator'\)/);
});

test("a re-ON refreshes the seat in place — no tombstone, no second row", async () => {
  const db = paperDb(modMembers(), { configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]] });
  const env = envWithLimiters(db);
  await dispatch(request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: true }), env);
  assert.equal(db.configs.size, 1);
  assert.equal(db.configs.get(SERVER_ID).updated_by, USER_ID);
});

test("a regular member's ON act answers 403 and writes nothing", async () => {
  const db = paperDb(); // plain member
  const env = envWithLimiters(db);
  const response = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: true }), env,
  );
  assert.equal(response.status, 403);
  assert.equal(db.configs.size, 0, "a member's write conjures no row");
});

test("a non-member's toggle is the shared unknown-server 404", async () => {
  const db = paperDb(modMembers());
  const env = envWithLimiters(db);
  const response = await dispatch(
    request("POST", "/api/servers/999/paper", { enabled: true }), env,
  );
  assert.equal(response.status, 404);
});

test("the toggle wants a boolean", async () => {
  const env = envWithLimiters(paperDb(modMembers()));
  const missing = await dispatch(request("POST", "/api/servers/" + SERVER_ID + "/paper", {}), env);
  assert.equal(missing.status, 400);
  const junk = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: 1 }), env,
  );
  assert.equal(junk.status, 400);
});

test("the OFF transition is the hard row delete — the next read answers the unconfigured shape", async () => {
  const db = paperDb(modMembers(), { configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]] });
  const env = envWithLimiters(db);

  const response = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: false }), env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { enabled: false });
  assert.equal(db.configs.size, 0, "no tombstone — the delete is the whole off-state");

  const after = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  assert.equal(after.status, 404);

  // An idempotent re-OFF on an absent row answers its state.
  const again = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: false }), env,
  );
  assert.equal(again.status, 200);
  assert.deepEqual(await bodyOf(again), { enabled: false });
});

test("the OFF delete's mod gate rides INSIDE the statement — a demod between the read and the delete makes zero changes and takes the shared refusal", async () => {
  const db = paperDb(modMembers(), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    demodAfterMembershipRead: true,
  });
  const env = envWithLimiters(db);

  const response = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: false }), env,
  );
  assert.equal(response.status, 404, "the statement gate's zero-changes verdict is the shared refusal");
  assert.match(await response.text(), /does not exist or you cannot view it/);
  assert.equal(
    db.configs.get(SERVER_ID)?.enabled, 1,
    "the demodded caller's delete makes zero changes — the seat survives",
  );

  const disableSql = db.calls.find((call) => call.sql.startsWith("DELETE FROM gc_paper_configs"));
  assert.match(disableSql.sql, /AND EXISTS \(SELECT 1 FROM gc_server_members/);
  assert.match(disableSql.sql, /pm\.role IN \('owner','moderator'\)/);
});

test("a still-modded caller's OFF delete changes exactly one row (idempotent absent-row OFF stays 200)", async () => {
  const db = paperDb(modMembers(), { configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]] });
  const env = envWithLimiters(db);
  const response = await dispatch(
    request("POST", "/api/servers/" + SERVER_ID + "/paper", { enabled: false }), env,
  );
  assert.equal(response.status, 200);
  assert.equal(db.configs.size, 0);
});

// --- the read -------------------------------------------------------------------

test("the read is derived on request: zero write statements fire during a read", async () => {
  const db = paperDb(modMembers(), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    ...freshServer(),
  });
  const env = envWithLimiters(db);
  const response = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  assert.equal(response.status, 200);
  const writes = db.calls.filter((call) =>
    /INSERT INTO|UPDATE |DELETE FROM|gc_paper_configs.*UPDATE/i.test(call.sql) &&
    !call.sql.startsWith("SELECT"));
  assert.deepEqual(writes, [], "the paper mints nothing, sinks nothing, tracks nothing");
});

test("today's paper: sections shaped from the server's own rows, sorted and capped", async () => {
  const db = paperDb(modMembers([{ server_id: SERVER_ID, user_id: 22, role: "member" }]), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    ...freshServer(),
    anniversaries: [{ user_id: 22, month: TODAY_MONTH, day: TODAY_DAY }],
    users: [
      { id: 22, username: "ember" },
      { id: 31, username: "ghost" },
    ],
  });
  const env = envWithLimiters(db);

  const response = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);

  assert.equal(payload.titleKey, "paper.title");
  // The window: the UTC day-key pair — end - start is one day, start rides
  // the 0 seconds boundary, and the label states UTC by construction.
  assert.equal(payload.window.endSeconds - payload.window.startSeconds, GC_PAPER_DAY_SECONDS);
  assert.equal(payload.window.startSeconds % GC_PAPER_DAY_SECONDS, 0);
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  assert.equal(
    payload.windowLabelUtc,
    iso(payload.window.startSeconds) + "/" + iso(payload.window.endSeconds),
  );

  // Channels: count per public text channel, the voice and foreign rows
  // contribute nothing.
  assert.deepEqual(payload.sections.channels, [{ channelId: 11, count: 3 }]);
  assert.deepEqual(payload.sections.reactions, [
    { emoji: "fire", count: 2 },
    { emoji: "party", count: 1 },
  ]);
  // The celebrants: the member with TODAY's month-day — handles only.
  assert.deepEqual(payload.sections.anniversaries, [{ userId: 22, handle: "ember" }]);

  // activityRows: the window's total across the sections' own rows —
  // channels 3, reactions 2+1, celebrants 1.
  assert.equal(payload.activityRows, 3 + 3 + 1);
});

test("today's channels section cuts at its cap, strictly by count then id", async () => {
  const channels = [];
  const messages = [];
  for (let index = 0; index < GC_PAPER_CHANNELS_MAX + 2; index += 1) {
    const channelId = 100 + index;
    channels.push({ id: channelId, server_id: SERVER_ID, kind: "text" });
    const count = (index % 2) + 1; // alternating 1..2 rows per channel
    for (let row = 0; row < count; row += 1) {
      messages.push({
        id: 10000 + index * 10 + row,
        channel_id: channelId,
        created_at: DAY_START + row,
      });
    }
  }
  const db = paperDb(modMembers(), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    channels, messages,
  });
  const env = envWithLimiters(db);
  const response = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  const payload = await bodyOf(response);
  assert.equal(payload.sections.channels.length, GC_PAPER_CHANNELS_MAX);
  // Six channels carry two rows (odd ids), six carry one (even ids): the
  // section serves the count-desc run first, ties ascending by channel id,
  // cut at the cap.
  assert.deepEqual(
    payload.sections.channels,
    [
      { channelId: 101, count: 2 }, { channelId: 103, count: 2 },
      { channelId: 105, count: 2 }, { channelId: 107, count: 2 },
      { channelId: 109, count: 2 }, { channelId: 111, count: 2 },
      { channelId: 100, count: 1 }, { channelId: 102, count: 1 },
      { channelId: 104, count: 1 }, { channelId: 106, count: 1 },
    ],
  );
});

test("previous paper: the window is the previous UTC day key, same derivation", async () => {
  const db = paperDb(modMembers(), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    ...freshServer(),
  });
  const env = envWithLimiters(db);
  const response = await dispatch(
    request("GET", "/api/servers/" + SERVER_ID + "/paper/previous"), env,
  );
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);

  assert.equal(payload.window.endSeconds, DAY_START);
  assert.equal(payload.window.startSeconds, DAY_START - GC_PAPER_DAY_SECONDS * GC_PAPER_YESTERDAY_KEYS);

  // The yesterday-only rows land; today's rows do not: exactly one of the
  // seeded channel messages rides inside the previous key.
  assert.deepEqual(payload.sections.channels, [{ channelId: 11, count: 1 }]);

  // The windowed sections' binds carry exactly the previous window.
  const windows = db.calls
    .filter((call) => call.sql.includes("GROUP BY m.channel_id"))
    .map((call) => call.bound);
  for (const [serverId, startSeconds, endSeconds] of windows) {
    assert.equal(serverId, SERVER_ID);
    assert.equal(endSeconds - startSeconds, GC_PAPER_DAY_SECONDS);
    assert.equal(endSeconds <= DAY_START, true);
  }
});

test("a zero-activity day still serves a complete paper — no filler, no errors", async () => {
  const db = paperDb(modMembers(), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
  });
  const env = envWithLimiters(db);
  const response = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.deepEqual(payload.sections, {
    channels: [],
    reactions: [],
    anniversaries: [],
  });
  assert.equal(payload.activityRows, 0);
});

test("the read is members-only; a non-member shares the unknown-server 404", async () => {
  const env = envWithLimiters(paperDb([], {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    members: [{ server_id: SERVER_ID, user_id: 88, role: "member" }],
  }));
  const response = await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env);
  assert.equal(response.status, 404);
});

test("no per-member data rides the sections — handles only on the celebrant rows", async () => {
  const db = paperDb(modMembers([{ server_id: SERVER_ID, user_id: 22, role: "member" }]), {
    configs: [[SERVER_ID, { enabled: 1, updated_by: 99, updated_at: 0 }]],
    ...freshServer(),
    anniversaries: [{ user_id: 22, month: TODAY_MONTH, day: TODAY_DAY }],
    users: [{ id: 22, username: "ember" }],
  });
  const env = envWithLimiters(db);
  const payload = await bodyOf(
    await dispatch(request("GET", "/api/servers/" + SERVER_ID + "/paper"), env),
  );

  for (const channel of payload.sections.channels) {
    assert.deepEqual(Object.keys(channel).sort(), ["channelId", "count"]);
  }
  for (const reaction of payload.sections.reactions) {
    assert.deepEqual(Object.keys(reaction).sort(), ["count", "emoji"]);
  }
  for (const celebrant of payload.sections.anniversaries) {
    assert.deepEqual(Object.keys(celebrant).sort(), ["handle", "userId"]);
  }
  // The sections' pinned SQL never selects a member column.
  for (const call of db.calls) {
    if (call.sql.includes("GROUP BY m.channel_id") || call.sql.includes("GROUP BY r.emoji")) {
      assert.doesNotMatch(call.sql, /user_id|username/, "no member column in an aggregate");

    }
  }
});

test("the paper module owns only its paths — aliens fall through the dispatch", async () => {
  const env = envWithLimiters(paperDb());
  assert.equal(
    await handlePaperRoutes(request("GET", "/api/nope"), env, new URL("http://x/api/nope"), "/api/nope", "GET"),
    undefined,
  );
  assert.equal(
    await handlePaperRoutes(
      request("GET", "/api/servers/" + SERVER_ID + "/ledger"),
      env, new URL("http://x"), "/api/servers/" + SERVER_ID + "/ledger", "GET",
    ),
    undefined,
  );
});
