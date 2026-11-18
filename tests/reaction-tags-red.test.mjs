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

// T89 Reaction tags — the RED rows (spec: docs/drafts/t89-reaction-tags-spec.md).
// DELIVERED FAILING: no api/reaction-tags.mjs, no worker.mjs registration, no
// GREEN. Idiom: the paperDb/bookmarkDb fake (tests/morning-paper-red.test.mjs,
// tests/bookmarks-red.test.mjs) — every guard arm is ENCODED in the fake (the
// mod-role arm inside the map upsert/unmap, the reachability arm inside the
// opt, the map-cap COUNT arm inside the upsert's own WHERE), so a GREEN
// implementation that loses an arm fails here. The seat mints and sinks
// NOTHING (economy re-rule, spec §6): tags are FREE cosmetics — no
// gc_coin_ledger route exists in the fake, so a tag that ever mints fails by
// silence never being banked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../worker.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const SERVER_ID = 1;
const MOD_ID = 7;         // owner of SERVER_ID
const MEMBER_ID = 22;     // plain member of SERVER_ID
const STRANGER_ID = 31;   // another plain member of SERVER_ID
const OUTSIDER_ID = 44;   // not a member of SERVER_ID at all
const NOW = nowSeconds();

const MOD_TOKEN = "O".repeat(40);
const MEMBER_TOKEN = "M".repeat(40);
const STRANGER_TOKEN = "S".repeat(40);
const OUTSIDER_TOKEN = "X".repeat(40);

// auth.mjs binds sha256Hex(token) as token_hash (core/auth.mjs:104-105), so
// the session fake must compare the HASH — a raw-token comparison starves
// every session and 401s the whole lane (the lead-ruled fake law,
// 2026-11-18; assertions untouched).
const MOD_HASH = await sha256Hex(MOD_TOKEN);
const MEMBER_HASH = await sha256Hex(MEMBER_TOKEN);
const STRANGER_HASH = await sha256Hex(STRANGER_TOKEN);
const OUTSIDER_HASH = await sha256Hex(OUTSIDER_TOKEN);

function sessionRow(userId, tokenSeed) {
  return {
    token_hash: tokenSeed.repeat(32).slice(0, 64),
    user_id: userId,
    csrf_token: "C".repeat(24),
    expires_at: nowSeconds() + 3600,
    username: "member" + userId,
  };
}
const MOD_SESSION = sessionRow(MOD_ID, "O");
const MEMBER_SESSION = sessionRow(MEMBER_ID, "M");
const STRANGER_SESSION = sessionRow(STRANGER_ID, "S");
const OUTSIDER_SESSION = sessionRow(OUTSIDER_ID, "X");

// The shared 404 body for the WHOLE tag family (spec §3): non-mod write,
// unknown tag, unknown emoji, non-member, never-opted un-opt, cap-full —
// ONE body, no oracle between any of them.
const SHARED_404 = "Reaction tag not found.";

// Caps ride constants.mjs — read as text, never re-declared in the fake
// (mirrors the bookmarks RED's constants pin). NaN = the constant is absent,
// which its own test row fails on; the fake's cap arms simply never open
// while the constant is missing.
const CONSTANTS_TEXT = readFileSync(new URL("../constants.mjs", import.meta.url), "utf8");
const GC_REACTION_TAGS_MAX = Number((CONSTANTS_TEXT.match(/export const GC_REACTION_TAGS_MAX = (\d+)/) || [])[1]);
const GC_REACTION_TAG_TEXT_MAX = Number((CONSTANTS_TEXT.match(/export const GC_REACTION_TAG_TEXT_MAX = (\d+)/) || [])[1]);

function reactionTagsCap() {
  assert.ok(Number.isFinite(GC_REACTION_TAGS_MAX),
    "GC_REACTION_TAGS_MAX exists in constants.mjs (caps never re-declared)");
  assert.ok(GC_REACTION_TAGS_MAX <= 25,
    "the map cap rides the lane bound (spec §6: <= 25; pinned 20)");
  return GC_REACTION_TAGS_MAX;
}

// The reactionTagDb fake: three state maps ARE the whole seat — the mods set
// ("user:server" with the mod gate INSIDE the write statements), the membership
// set ("user:server" for reads/opts), and the two row stores (the mod's map
// rows, the members' opt rows). Absence of a row IS the un-mapped / un-opted
// state (defaults law, spec §6): nothing exists until someone acts.
function reactionTagDb(options = {}) {
  const mods = new Set(options.mods || []);            // "user_id:server_id" (owner|moderator)
  const membership = new Set(options.membership || []); // "user_id:server_id" (any role)
  const tags = (options.tags || []).map((row) => ({ ...row }));
  const opts = (options.opts || []).map((row) => ({ ...row }));
  let nextTagId = 1 + tags.reduce((max, row) => Math.max(max, row.id), 0);
  const calls = [];

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async (bound) => {
        const token = String(bound[0] || "");
        if (token === MOD_HASH) return MOD_SESSION;
        if (token === MEMBER_HASH) return MEMBER_SESSION;
        if (token === STRANGER_HASH) return STRANGER_SESSION;
        if (token === OUTSIDER_HASH) return OUTSIDER_SESSION;
        return null;
      },
    },
    {
      // The self-scoped un-opt (spec §4's TAG_UNOPT_SQL): ownership IS the
      // only key — a wrong owner (or a wrong tag id) answers changes-0,
      // classified to the shared 404, never a 403 oracle. RIDES FIRST:
      // routes.find() is order-sensitive and the mine read below matches on
      // includes("FROM gc_reaction_tag_opts"), which every DELETE also
      // satisfies — a later-match shadowing here would make an un-opt
      // unable to ever fire (the fake-defect class the lead ruled on
      // 2026-11-18: prefix-anchored routes ride ABOVE broad includes()).
      test: (sql) => sql.startsWith("DELETE FROM gc_reaction_tag_opts"),
      run: (bound) => {
        const tagId = Number(bound[0]);
        const userId = Number(bound[1]);
        const index = opts.findIndex((row) => row.tag_id === tagId && row.user_id === userId);
        if (index === -1) return { meta: { changes: 0 } };
        opts.splice(index, 1);
        return { meta: { changes: 1 } };
      },
    },
    {
      // The reachability-gated opt (spec §4's TAG_OPT_SQL): the tag row in
      // THIS server + THIS member live INSIDE the statement; ON CONFLICT DO
      // NOTHING = idempotent. Binding order is pinned by the spec:
      // [tag_id, user_id, opted_at, tag_id, user_id].
      test: (sql) => sql.startsWith("INSERT INTO gc_reaction_tag_opts"),
      run: (bound) => {
        const tagId = Number(bound[0]);
        const userId = Number(bound[1]);
        const optedAt = Number(bound[2]);
        const tag = tags.find((row) => row.id === tagId);
        const reachable = tag !== undefined && membership.has(userId + ":" + tag.server_id);
        const already = reachable &&
          opts.some((row) => row.tag_id === tagId && row.user_id === userId);
        if (!reachable || already) return { meta: { changes: 0 } };
        opts.push({ tag_id: tagId, user_id: userId, opted_at: optedAt });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The route's own-opt split read (spec §4's TAG_OPT_OWN_READ_SQL):
      // after a changes-0 opt, the route reads the caller's OWN row to
      // separate "already mine" (200 duplicate) from "not reachable" (404).
      test: (sql) => sql.startsWith("SELECT opted_at FROM gc_reaction_tag_opts"),
      first: async (bound) => {
        const tagId = Number(bound[0]);
        const userId = Number(bound[1]);
        const row = opts.find((row) => row.tag_id === tagId && row.user_id === userId);
        return row ? { opted_at: row.opted_at } : null;
      },
    },
    {
      // The mine read (spec §4's TAG_MINE_READ_SQL): the caller's opted tags
      // for THIS server, own only, newest-first, capped — the fake answers
      // from the bound user's opts, so a GREEN read that drops the
      // o.user_id WHERE cannot assemble this shape.
      test: (sql) => sql.includes("FROM gc_reaction_tag_opts"),
      all: async (bound) => {
        const userId = Number(bound[0]);
        const serverId = Number(bound[1]);
        const rows = opts
          .filter((row) => row.user_id === userId)
          .map((row) => ({ opt: row, tag: tags.find((tag) => tag.id === row.tag_id && tag.server_id === serverId) }))
          .filter((row) => row.tag !== undefined)
          .sort((a, b) => (b.opt.opted_at - a.opt.opted_at) || (b.tag.id - a.tag.id))
          .slice(0, Number.isFinite(GC_REACTION_TAGS_MAX) ? GC_REACTION_TAGS_MAX : rows.length)
          .map((row) => ({ id: row.tag.id, emoji: row.tag.emoji, tag_text: row.tag.tag_text }));
        return { results: rows };
      },
    },
    {
      // The mod-gated unmap (spec §4's TAG_DELETE_SQL): the role lives
      // INSIDE the DELETE's WHERE — a wrong role (or a wrong emoji) answers
      // changes-0 → the shared 404. RIDES FIRST: the map read below matches
      // on includes("FROM gc_server_reaction_tags"), which every DELETE
      // also satisfies — the same first-match shadowing class.
      test: (sql) => sql.startsWith("DELETE FROM gc_server_reaction_tags"),
      run: (bound) => {
        const serverId = Number(bound[0]);
        const emoji = String(bound[1]);
        const userId = Number(bound[3]);
        if (!mods.has(userId + ":" + serverId)) return { meta: { changes: 0 } };
        const index = tags.findIndex((row) => row.server_id === serverId && row.emoji === emoji);
        if (index === -1) return { meta: { changes: 0 } };
        tags.splice(index, 1);
        return { meta: { changes: 1 } };
      },
    },
    {
      // The mod-gated, cap-gated upsert (spec §4's TAG_PUT_SQL): BOTH arms
      // gated — real SQLite upsert semantics (the 2026-11-18 lead ruling on
      // the t89-review CRITICAL: this fake previously applied the gates
      // before the conflict branch, which real SQLite does not — the
      // plain-INSERT arm takes the SELECT-WHERE's role+cap arms, the DO
      // UPDATE arm takes the update WHERE's; a gated arm answers changes-0
      // either way → the shared 404, and a non-mod's FRESH-emoji PUT must
      // never insert). Binding order is pinned by the spec: [server_id,
      // emoji, tag_text, created_by, created_at, server_id, user_id,
      // server_id, server_id, user_id, server_id].
      test: (sql) => sql.startsWith("INSERT INTO gc_server_reaction_tags"),
      run: (bound) => {
        const serverId = Number(bound[0]);
        const emoji = String(bound[1]);
        const tagText = String(bound[2]);
        const createdBy = Number(bound[3]);
        const createdAt = Number(bound[4]);
        const existing = tags.find((row) => row.server_id === serverId && row.emoji === emoji);
        if (existing) {
          const updateIsMod = mods.has(Number(bound[9]) + ":" + Number(bound[8]));
          const updateCount = tags.filter((row) => row.server_id === Number(bound[10])).length;
          if (!updateIsMod || updateCount >= GC_REACTION_TAGS_MAX) return { meta: { changes: 0 } };
          existing.tag_text = tagText;
          existing.created_by = createdBy;
          existing.created_at = createdAt;
          return { meta: { changes: 1 } };
        }
        const insertIsMod = mods.has(Number(bound[6]) + ":" + Number(bound[5]));
        const insertCount = tags.filter((row) => row.server_id === Number(bound[7])).length;
        if (!insertIsMod || insertCount >= GC_REACTION_TAGS_MAX) return { meta: { changes: 0 } };
        tags.push({ id: nextTagId++, server_id: serverId, emoji, tag_text: tagText, created_by: createdBy, created_at: createdAt });
        return { meta: { changes: 1 } };
      },
    },
    {
      // The member read of the map (spec §4's TAG_MAP_READ_SQL):
      // membership lives INSIDE the WHERE — a non-member read answers []
      // through the statement gate.
      test: (sql) => sql.includes("FROM gc_server_reaction_tags"),
      all: async (bound) => {
        const serverId = Number(bound[0]);
        const userId = Number(bound[2]);
        if (!membership.has(userId + ":" + serverId)) return { results: [] };
        const rows = tags
          .filter((row) => row.server_id === serverId)
          .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id))
          .slice(0, Number.isFinite(GC_REACTION_TAGS_MAX) ? GC_REACTION_TAGS_MAX : rows.length)
          .map((row) => ({ id: row.id, emoji: row.emoji, tag_text: row.tag_text }));
        return { results: rows };
      },
    },
  ];

  const db = {
    calls,
    tags,
    opts,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql)) || null;
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound, call: "first" });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound, call: "all" });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound, call: "run" });
        return route && route.run ? await route.run(statement.bound) : { meta: { changes: 1 } };
      };
      return statement;
    },
  };
  return db;
}

const SEED = {
  mods: [MOD_ID + ":" + SERVER_ID],
  membership: [MOD_ID + ":" + SERVER_ID, MEMBER_ID + ":" + SERVER_ID, STRANGER_ID + ":" + SERVER_ID],
};

function envOf(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

function authed(method, path, session, body) {
  // session === null rides NO cookie: the un-authed visitor arm.
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(session
        ? {
            Cookie: "__Host-goober_session=" + session.__token,
            "X-CSRF-Token": session.csrf_token,
          }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
MOD_SESSION.__token = MOD_TOKEN;
MEMBER_SESSION.__token = MEMBER_TOKEN;
STRANGER_SESSION.__token = STRANGER_TOKEN;
OUTSIDER_SESSION.__token = OUTSIDER_TOKEN;

const TAG_PATH = "/api/servers/" + SERVER_ID + "/reaction-tags";

// --- rows -------------------------------------------------------------------

test("the reaction-tag seat ships as ONE CREATE-only migration 0041: map + opts, one index, no FK, no shared-table edit", () => {
  const text = readFileSync(new URL("../migrations/0041_gc_reaction_tags.sql", import.meta.url), "utf8");
  const creates = text.match(/CREATE TABLE/g) || [];
  assert.equal(creates.length, 2, "the map + the opt rows ARE the whole seat — TWO tables");
  const mapBody = text.slice(
    text.indexOf("CREATE TABLE gc_server_reaction_tags"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_server_reaction_tags")),
  );
  for (const column of ["id", "server_id", "emoji", "tag_text", "created_by", "created_at"]) {
    assert.match(mapBody, new RegExp("\\b" + column + "\\b"), column + " rides the map");
  }
  assert.match(mapBody, /UNIQUE \(server_id, emoji\)/, "one map row per emoji per server (the upsert's conflict target)");
  const optBody = text.slice(
    text.indexOf("CREATE TABLE gc_reaction_tag_opts"),
    text.indexOf(";", text.indexOf("CREATE TABLE gc_reaction_tag_opts")),
  );
  for (const column of ["tag_id", "user_id", "opted_at"]) {
    assert.match(optBody, new RegExp("\\b" + column + "\\b"), column + " rides the opt");
  }
  assert.match(optBody, /PRIMARY KEY \(tag_id, user_id\)/, "the opt row IS the (tag, member) pair — idempotence at the key");
  assert.doesNotMatch(text, /\bREFERENCES\b/, "NO FK (spec §5): a deleted tag's orphan opt drops at the mine read's JOIN");
  assert.doesNotMatch(text, /\bmessage\b/i, "no message column anywhere — the seat never anchors a message");
  const indexes = text.match(/CREATE INDEX/g) || [];
  assert.equal(indexes.length, 1, "ONE index (spec §5) — 0041 is byte-identical to the PROD-applied migration (d1_migrations ids 84-86, 2026-11-18); the parked opts user-index rides 0043, not here");
  assert.doesNotMatch(text, /\b(ALTER TABLE|DROP TABLE|CREATE TRIGGER|CREATE VIEW|INSERT INTO|UPDATE|DELETE FROM)\b/,
    "CREATE-only: no shared-table edit, no rollup, no leaderboard table");
});

test("GC_REACTION_TAGS_MAX and GC_REACTION_TAG_TEXT_MAX exist in constants.mjs with the spec's values — caps never re-declared", () => {
  const cap = reactionTagsCap();
  assert.equal(cap, 20, "the map cap is ours, aligned with GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE (spec §6)");
  assert.ok(Number.isFinite(GC_REACTION_TAG_TEXT_MAX),
    "GC_REACTION_TAG_TEXT_MAX exists in constants.mjs");
  assert.equal(GC_REACTION_TAG_TEXT_MAX, 32, "the tag-text cap is the same family's short-string ruling (spec §6)");
});

test("a mod maps an emoji to a tag with one PUT: defaults-law empty before, exactly ONE map row, locale-key reference accepted", async () => {
  const tagText = "gc.tags.snow_melt";
  const db = reactionTagDb(SEED);
  assert.equal(db.tags.length, 0, "defaults law: no tag exists for any server until a mod maps one");
  const response = await worker.fetch(
    authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "snow_melt", tag: tagText }), envOf(db), {},
  );
  assert.equal(response.status, 200, "the map act exists and answers its state");
  const payload = await response.json();
  assert.equal(payload.tag.emoji, "snow_melt");
  assert.equal(payload.tag.tag, tagText);
  assert.equal(typeof payload.tag.id, "number");
  assert.equal(db.tags.length, 1, "exactly one map row");
  assert.deepEqual(Object.keys(db.tags[0]).sort(),
    ["created_at", "created_by", "emoji", "id", "server_id", "tag_text"],
    "the row carries the map's five + id and NOTHING else — no message column, no count");
  assert.equal(db.tags[0].created_by, MOD_ID);
  // The gate arms ride INSIDE the statement (spec §4): a GREEN that rides a
  // pre-read oracle or loses the role/cap arm fails by SQL inspection.
  const putCalls = db.calls.filter((call) => call.sql.startsWith("INSERT INTO gc_server_reaction_tags"));
  assert.equal(putCalls.length, 1);
  assert.match(putCalls[0].sql, /role IN \('owner','moderator'\)/, "the mod gate rides the statement's WHERE");
  assert.match(putCalls[0].sql, /SELECT COUNT\(\*\) FROM gc_server_reaction_tags/, "the cap rides the statement's WHERE");
  assert.equal(putCalls[0].bound.length, 11, "the pinned 11-bind order (spec §4): both upsert arms gated");
  assert.equal(putCalls[0].bound[6], MOD_ID, "the INSERT arm's role-gate user bind is the caller");
  assert.equal(putCalls[0].bound[9], MOD_ID, "the update arm's role-gate user bind is the caller");
  assert.equal(putCalls[0].sql.split("role IN ('owner','moderator')").length - 1, 2,
    "BOTH arms carry the role gate — the plain-INSERT arm is never free (t89-review CRITICAL pin)");
});

test("re-PUTing the same emoji is an in-place upsert: one row refreshed, never a second", async () => {
  const db = reactionTagDb(SEED);
  await worker.fetch(authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "snow_melt", tag: "gc.tags.snow_melt" }), envOf(db), {});
  const second = await worker.fetch(
    authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "snow_melt", tag: "gc.tags.snow_thaw" }), envOf(db), {},
  );
  assert.equal(second.status, 200, "the refresh answers its state");
  assert.equal(db.tags.length, 1, "the ON CONFLICT upsert refreshes in place (paper idiom)");
  assert.equal(db.tags[0].tag_text, "gc.tags.snow_thaw", "the refreshed text is what the row carries");
});

test("a non-mod's PUT/DELETE against the tag map makes zero changes and answers the shared 404 — never a 403", async () => {
  const db = reactionTagDb({ ...SEED, tags: [{ id: 3, server_id: SERVER_ID, emoji: "star", tag_text: "gc.tags.star", created_by: MOD_ID, created_at: NOW - 10 }] });
  const memberPut = await worker.fetch(
    authed("PUT", TAG_PATH, MEMBER_SESSION, { emoji: "fire", tag: "gc.tags.fire" }), envOf(db), {},
  );
  assert.equal(memberPut.status, 404, "the statement gate classifies changes-0 to the shared 404");
  assert.notEqual(memberPut.status, 403, "no 403 oracle anywhere in the seat (paper.mjs idiom)");
  assert.equal((await memberPut.json()).error, SHARED_404, "the ONE shared body (spec §3)");
  const memberDelete = await worker.fetch(
    authed("DELETE", TAG_PATH, MEMBER_SESSION, { emoji: "star" }), envOf(db), {},
  );
  assert.equal(memberDelete.status, 404);
  assert.notEqual(memberDelete.status, 403);
  assert.equal((await memberDelete.json()).error, SHARED_404);
  assert.equal(db.tags.length, 1, "the non-mod's intent never conjures a row, never unmoves one");
  assert.equal(db.tags[0].emoji, "star", "the mod's map row survives the non-mod write");
});

test("PUT past GC_REACTION_TAGS_MAX answers the shared 404: the cap rides the statement's WHERE, row 26 is rejected", async () => {
  const cap = reactionTagsCap();
  const seedTags = Array.from({ length: cap }, (_, i) => ({
    id: 100 + i, server_id: SERVER_ID, emoji: "e" + i, tag_text: "gc.tags.t" + i,
    created_by: MOD_ID, created_at: NOW - i,
  }));
  const db = reactionTagDb({ ...SEED, tags: seedTags });
  const overCap = await worker.fetch(
    authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "over_the_cap", tag: "gc.tags.over" }), envOf(db), {},
  );
  assert.equal(overCap.status, 404, "changes-0 → the shared 404, no cap error, no 403");
  assert.equal((await overCap.json()).error, SHARED_404);
  assert.equal(db.tags.length, cap, "row " + (cap + 1) + " was never inserted — the cap arm held");
  assert.equal(db.tags.some((row) => row.emoji === "over_the_cap"), false);
  // Another server's tags do not share the cap: the COUNT is per-server.
  const otherServerTags = [{ id: 900, server_id: 2, emoji: "elsewhere", tag_text: "gc.tags.other", created_by: 11, created_at: NOW - 1 }];
  const db2 = reactionTagDb({ ...SEED, mods: [MOD_ID + ":2"], tags: [...seedTags.slice(0, cap - 1), ...otherServerTags] });
  const across = await worker.fetch(
    authed("PUT", "/api/servers/2/reaction-tags", OUTSIDER_SESSION, { emoji: "fresh", tag: "gc.tags.fresh" }), envOf(db2), {},
  );
  assert.equal(across.status, 404, "the outsider rides the shared 404 class (not a member of server 2)");
});

test("the member read of the map carries NO member column: ids, emoji, tag only", async () => {
  const db = reactionTagDb({
    ...SEED,
    tags: [
      { id: 12, server_id: SERVER_ID, emoji: "star", tag_text: "gc.tags.star", created_by: MOD_ID, created_at: NOW - 10 },
      { id: 11, server_id: SERVER_ID, emoji: "moon", tag_text: "gc.tags.moon", created_by: MOD_ID, created_at: NOW - 20 },
    ],
  });
  const response = await worker.fetch(authed("GET", TAG_PATH, MEMBER_SESSION), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.tags), "the map read is a list, never an error");
  assert.equal(payload.tags.length, 2);
  const painted = JSON.stringify(payload);
  assert.doesNotMatch(painted, /"user_id"|"created_by"|"username"|"handle"|"count"|"total"/,
    "the map read carries no member identity, no count across members (privacy law)");
});

test("a member opts into a tag with one POST: one self-scoped opt row, nothing else", async () => {
  const db = reactionTagDb({
    ...SEED,
    tags: [{ id: 5, server_id: SERVER_ID, emoji: "snow_melt", tag_text: "gc.tags.snow_melt", created_by: MOD_ID, created_at: NOW - 5 }],
  });
  assert.equal(db.opts.length, 0, "defaults law: no opts exist until a member acts");
  const response = await worker.fetch(
    authed("POST", TAG_PATH + "/5/opt", MEMBER_SESSION, {}), envOf(db), {},
  );
  assert.equal(response.status, 200, "the opt act exists and answers its state");
  const payload = await response.json();
  assert.deepEqual(payload, { opted: true }, "the first opt is plain opted:true (spec §3)");
  assert.equal(db.opts.length, 1, "exactly one opt row");
  assert.deepEqual(db.opts[0], { tag_id: 5, user_id: MEMBER_ID, opted_at: db.opts[0].opted_at },
    "the opt row carries tag_id + user_id + opted_at and NOTHING else");
  assert.equal(typeof db.opts[0].opted_at, "number", "opted_at is the server's epoch seconds");
});

test("re-opting is idempotent: still one opt row, still 200, and the answer names the duplicate", async () => {
  const db = reactionTagDb({
    ...SEED,
    tags: [{ id: 5, server_id: SERVER_ID, emoji: "snow_melt", tag_text: "gc.tags.snow_melt", created_by: MOD_ID, created_at: NOW - 5 }],
  });
  await worker.fetch(authed("POST", TAG_PATH + "/5/opt", MEMBER_SESSION, {}), envOf(db), {});
  const second = await worker.fetch(
    authed("POST", TAG_PATH + "/5/opt", MEMBER_SESSION, {}), envOf(db), {},
  );
  assert.equal(second.status, 200, "ON CONFLICT DO NOTHING keeps the re-opt a valid answer");
  assert.deepEqual(await second.json(), { opted: true, duplicate: true },
    "the route splits the caller's OWN changes-0 opt into the duplicate answer (bookmark idiom)");
  assert.equal(db.opts.length, 1, "the primary key (tag_id, user_id) keeps ONE row");
});

test("an opt against a tag outside the member's reach answers ONE shared 404 — unknown tag and non-member are indistinguishable", async () => {
  const noSuchTagDb = reactionTagDb(SEED);
  const noSuchTag = await worker.fetch(
    authed("POST", TAG_PATH + "/999999/opt", MEMBER_SESSION, {}), envOf(noSuchTagDb), {},
  );
  assert.equal(noSuchTag.status, 404, "reachability lives INSIDE the statement, no existence oracle");
  assert.equal((await noSuchTag.json()).error, SHARED_404);
  assert.equal(noSuchTagDb.opts.length, 0, "no opt row is conjured by an unreachable opt");

  const outsideDb = reactionTagDb({
    ...SEED,
    tags: [{ id: 5, server_id: SERVER_ID, emoji: "snow_melt", tag_text: "gc.tags.snow_melt", created_by: MOD_ID, created_at: NOW - 5 }],
  });
  const outsider = await worker.fetch(authed("POST", TAG_PATH + "/5/opt", OUTSIDER_SESSION, {}), envOf(outsideDb), {});
  assert.equal(outsider.status, 404, "the non-member rides the same shared 404 class");
  assert.equal((await outsider.json()).error, SHARED_404);
  assert.equal(outsideDb.opts.length, 0);
});

test("un-opting by the member removes their row; never-opted and no-such-tag answer the SAME shared 404", async () => {
  const db = reactionTagDb({
    ...SEED,
    tags: [{ id: 5, server_id: SERVER_ID, emoji: "snow_melt", tag_text: "gc.tags.snow_melt", created_by: MOD_ID, created_at: NOW - 5 }],
    opts: [{ tag_id: 5, user_id: MEMBER_ID, opted_at: NOW - 2 }],
  });
  const own = await worker.fetch(authed("DELETE", TAG_PATH + "/5/opt", MEMBER_SESSION), envOf(db), {});
  assert.equal(own.status, 200, "the un-opt act answers its state");
  assert.deepEqual(await own.json(), {});
  assert.equal(db.opts.length, 0, "the opt row is gone — self-scoped, owner IS the only key");

  const never = await worker.fetch(authed("DELETE", TAG_PATH + "/5/opt", MEMBER_SESSION), envOf(db), {});
  assert.equal(never.status, 404, "'not yours / never opted' and 'no such row' are indistinguishable");
  assert.equal((await never.json()).error, SHARED_404);
  assert.notEqual(never.status, 403, "no 403 oracle (bookmark idiom)");

  const missing = await worker.fetch(authed("DELETE", TAG_PATH + "/777/opt", MEMBER_SESSION), envOf(db), {});
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, SHARED_404, "ONE body for the whole tag family");
});

test("mine answers ONLY the caller's opted tags: own-only, no member column, no count, capped (privacy law)", async () => {
  const cap = reactionTagsCap();
  const tags = Array.from({ length: cap }, (_, i) => ({
    id: 10 + i, server_id: SERVER_ID, emoji: "e" + i, tag_text: "gc.tags.t" + i,
    created_by: MOD_ID, created_at: NOW - 100 + i,
  }));
  const db = reactionTagDb({
    ...SEED,
    tags,
    opts: [
      // The member's own opts (tag 25 = newest), plus another member's rows
      // the caller must never see: the fake's store holds every member's
      // opts keyed by user_id, so a GREEN read that drops the o.user_id
      // WHERE and a GREEN answer that paints a member column both fail here.
      { tag_id: 25, user_id: MEMBER_ID, opted_at: NOW - 1 },
      { tag_id: 10, user_id: MEMBER_ID, opted_at: NOW - 50 },
      { tag_id: 10, user_id: STRANGER_ID, opted_at: NOW - 2 },
      { tag_id: 11, user_id: OUTSIDER_ID, opted_at: NOW - 3 },
    ],
  });
  const response = await worker.fetch(authed("GET", TAG_PATH + "/mine", MEMBER_SESSION), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.tags), "the mine read is a list, never an error");
  assert.deepEqual(payload.tags.map((row) => row.id), [25, 10],
    "only the caller's opted tags, newest-first (ORDER BY o.opted_at DESC)");
  for (const row of payload.tags) {
    assert.deepEqual(Object.keys(row).sort(), ["emoji", "id", "tag"], "a mine row is the chip shape and nothing else");
  }
  const painted = JSON.stringify(payload);
  assert.doesNotMatch(painted, new RegExp(`"user_id"|"username"|"member"|"count"|"total"|${STRANGER_ID}`),
    "no other member's tags, ids, handles, or any count across members ride the private read — no leaderboard exists");
  const mineCalls = db.calls.filter((call) => call.sql.includes("FROM gc_reaction_tag_opts"));
  assert.equal(mineCalls.length, 1);
  assert.match(mineCalls[0].sql, /o\.user_id = \?/, "the user arm rides the statement's WHERE");
  assert.match(mineCalls[0].sql, /t\.server_id = \?/, "the server arm rides the statement's WHERE");
  assert.match(mineCalls[0].sql, /ORDER BY o\.opted_at DESC, t\.id DESC/, "newest-first is the statement's ORDER");
  assert.match(mineCalls[0].sql, new RegExp("LIMIT " + cap + "\\b"), "the read-time LIMIT rides the constant's cap");
});

test("an untouched member's mine read answers the valid empty shape (defaults law, nothing default-on)", async () => {
  const db = reactionTagDb({ ...SEED, tags: [{ id: 5, server_id: SERVER_ID, emoji: "star", tag_text: "gc.tags.star", created_by: MOD_ID, created_at: NOW - 1 }] });
  const response = await worker.fetch(authed("GET", TAG_PATH + "/mine", MEMBER_SESSION), envOf(db), {});
  assert.equal(response.status, 200, "an empty list is VALID, not an error");
  assert.deepEqual(await response.json(), { tags: [] },
    "the empty shape serves verbatim — no invented rows, no other member's rows leaked");
});

test("the tag text law: an unbounded tag answers 400 before any seat statement fires", async () => {
  const db = reactionTagDb(SEED);
  const longTag = "x".repeat(200);
  const freeText = await worker.fetch(
    authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "fire", tag: longTag }), envOf(db), {},
  );
  assert.equal(freeText.status, 400, "NO painted free-text of unbounded length (spec §2)");
  assert.equal(db.tags.length, 0, "no map row is conjured by a law-breaking PUT");
  const seatWrites = db.calls.filter((call) => call.sql.includes("gc_server_reaction_tags"));
  assert.equal(seatWrites.length, 0, "the 400 rides ahead of the seat statement");
  const emptyTag = await worker.fetch(
    authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "fire", tag: "" }), envOf(db), {},
  );
  assert.equal(emptyTag.status, 400, "neither a locale-key nor a short string: rejected");
});

test("un-authed: every reaction-tag route answers 401 before any seat statement fires", async () => {
  const db = reactionTagDb({ ...SEED, tags: [{ id: 5, server_id: SERVER_ID, emoji: "star", tag_text: "gc.tags.star", created_by: MOD_ID, created_at: NOW - 1 }] });
  const attempts = [
    ["PUT", TAG_PATH],
    ["GET", TAG_PATH],
    ["DELETE", TAG_PATH],
    ["POST", TAG_PATH + "/5/opt"],
    ["DELETE", TAG_PATH + "/5/opt"],
    ["GET", TAG_PATH + "/mine"],
  ];
  for (const [method, path] of attempts) {
    const response = await worker.fetch(authed(method, path, null), envOf(db), {});
    assert.equal(response.status, 401, method + " " + path + " answers the un-signed 401");
  }
  const seatStatements = db.calls.filter((call) => call.sql.includes("gc_reaction_tag") || call.sql.includes("gc_server_reaction_tags"));
  assert.equal(seatStatements.length, 0, "the 401 rides ahead of the seat — no tag statement");
});

test("economy re-rule: no route in this seat fires a coin statement — tags are FREE cosmetics", async () => {
  const db = reactionTagDb({
    ...SEED,
    tags: [{ id: 5, server_id: SERVER_ID, emoji: "snow_melt", tag_text: "gc.tags.snow_melt", created_by: MOD_ID, created_at: NOW - 5 }],
    opts: [{ tag_id: 5, user_id: MEMBER_ID, opted_at: NOW - 2 }],
  });
  await worker.fetch(authed("PUT", TAG_PATH, MOD_SESSION, { emoji: "fire", tag: "gc.tags.fire" }), envOf(db), {});
  await worker.fetch(authed("POST", TAG_PATH + "/5/opt", MEMBER_SESSION, {}), envOf(db), {});
  await worker.fetch(authed("GET", TAG_PATH + "/mine", MEMBER_SESSION), envOf(db), {});
  await worker.fetch(authed("DELETE", TAG_PATH + "/5/opt", MEMBER_SESSION), envOf(db), {});
  const coinStatements = db.calls.filter((call) =>
    call.sql.includes("gc_coin_ledger") || call.sql.includes("gc_coin") || call.sql.includes("mint"));
  assert.equal(coinStatements.length, 0, "no mint, no price, no coin statement anywhere in the seat (spec §6)");
});
