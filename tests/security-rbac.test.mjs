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

// The RBAC audit's standing pins (live-prod H1/H2 repair):
//
// H1 — every SQL authority guard that used SUM over the held roles' masks
// carried duplicate bits into phantom higher bits (2×MANAGE_EMOJI(2048)
// summed to 4096 = MENTION_EVERYONE; 2×KICK_MEMBERS(4) to 8 = MANAGE_INVITES;
// n duplicates of any bit b keep adding into b's own neighbours). The repair
// converts every guard to exact-OR semantics: per-bit EXISTS subqueries for
// the gates, GROUP_CONCAT + a JS fold (parseMergedMask) for the mask READS.
// The proofs here run in REAL sqlite (node:sqlite) against the audited
// shapes, plus per-module source pins, plus the helper's own unit pins, plus
// the H2 destination-slot route pin (the free-slot climb through a deletion
// gap).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MENTION_EVERYONE,
  SERVER_PERMISSIONS,
  holdsRolesBitsSql,
  holdsRolesBitsParams,
  parseMergedMask,
  roleMaskColumnSql,
  canManageRoleAt,
  highestPosition,
} from "../api/permissions.mjs";
import { handleServerRoutes } from "../api/servers.mjs";
import {
  IDENTITY_TUPLE_SQL,
  ROW_INSERT_SQL,
  STAGING_ARMS_SQL,
  STAGING_CLEAR_SQL,
} from "../api/uploads.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";
import { HttpError, json } from "../api/core/http.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";

const SERVER_ID = 3;
const MANAGE_EMOJI = SERVER_PERMISSIONS.MANAGE_EMOJI;
const KICK_MEMBERS = SERVER_PERMISSIONS.KICK_MEMBERS;
const MANAGE_INVITES = SERVER_PERMISSIONS.MANAGE_INVITES;
const MANAGE_ROLES = SERVER_PERMISSIONS.MANAGE_ROLES;

// --- the helpers' own unit pins ----------------------------------------------------

test("holdsRolesBitsSql: one per-bit EXISTS arm per bit, the bit literal inside, unique aliases", () => {
  const single = holdsRolesBitsSql(MENTION_EVERYONE);
  assert.match(single, /EXISTS \(SELECT 1 FROM gc_member_roles gbm4096 JOIN gc_roles gbr4096/);
  assert.match(single, /gbr4096\.permissions & 4096\) <> 0\)/);
  const both = holdsRolesBitsSql([KICK_MEMBERS, MANAGE_ROLES]);
  assert.match(both, /gbm4 /);
  assert.match(both, /\(gbr4\.permissions & 4\) <> 0/);
  assert.match(both, /gbm2 /);
  assert.match(both, /\(gbr2\.permissions & 2\) <> 0/);
  // Each arm's own (server, actor) pair — no shared placeholders.
  assert.equal(both.split("?").length - 1, 4);
});

test("holdsRolesBitsParams: exactly one (server, actor) pair per bit, in arm order", () => {
  assert.deepEqual(holdsRolesBitsParams(SERVER_ID, 7, MANAGE_EMOJI), [SERVER_ID, 7]);
  assert.deepEqual(holdsRolesBitsParams(SERVER_ID, 7, [KICK_MEMBERS, MANAGE_ROLES]),
    [SERVER_ID, 7, SERVER_ID, 7]);
});

test("parseMergedMask folds with OR: duplicates NEVER climb into a neighbour bit", () => {
  assert.equal(parseMergedMask(null), 0);
  assert.equal(parseMergedMask(""), 0);
  // The audited phantom: two roles each carrying 2048 once folded to 4096
  // under SUM. The OR fold answers 2048 — no bit appears that no role holds.
  assert.equal(parseMergedMask("2048,2048"), 2048 & MANAGE_EMOJI);
  assert.equal((parseMergedMask("2048,2048") & MENTION_EVERYONE), 0);
  assert.equal(parseMergedMask("4,4,4"), KICK_MEMBERS);
  assert.equal((parseMergedMask("4,4") & MANAGE_INVITES), 0);
  // Genuine combinations still fold through.
  assert.equal(parseMergedMask("1,4,2048"), 1 | 4 | 2048);
  assert.equal(parseMergedMask("12"), 12);
});

test("roleMaskColumnSql is the GROUP_CONCAT + JS-fold read shape", () => {
  const sql = roleMaskColumnSql();
  assert.match(sql, /GROUP_CONCAT\(ar\.permissions\)/);
  assert.match(sql, /gc_member_roles gmr JOIN gc_roles ar/);
  assert.doesNotMatch(sql, /SUM\(/);
  assert.equal(sql.split("?").length - 1, 2, "one (server, actor) pair");
});

// --- the REAL-sqlite proofs (node:sqlite) ------------------------------------------

const AUDITED_SCHEMA = `
CREATE TABLE gc_roles (
  id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL,
  name TEXT NOT NULL, color TEXT, position INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE gc_server_members (
  server_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', nickname TEXT,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE gc_member_roles (
  server_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role_id INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id, role_id)
);
`;

function seededDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(AUDITED_SCHEMA);
  const insRole = db.prepare(
    "INSERT INTO gc_roles (id, server_id, name, position, permissions) VALUES (?, ?, ?, ?, ?)",
  );
  const insMember = db.prepare(
    "INSERT INTO gc_server_members (server_id, user_id, role) VALUES (?, ?, 'member')",
  );
  const insHolding = db.prepare(
    "INSERT INTO gc_member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)",
  );
  // The audited phantom's member: TWO roles each holding MANAGE_EMOJI only.
  insRole.run(11, SERVER_ID, "A", 5, MANAGE_EMOJI);
  insRole.run(12, SERVER_ID, "B", 4, MANAGE_EMOJI);
  insMember.run(SERVER_ID, 7);
  insHolding.run(SERVER_ID, 7, 11);
  insHolding.run(SERVER_ID, 7, 12);
  // The two-KICK member: 2×KICK_MEMBERS(4) — SUM reads 8 (MANAGE_INVITES).
  insRole.run(21, SERVER_ID, "C", 3, KICK_MEMBERS);
  insRole.run(22, SERVER_ID, "D", 2, KICK_MEMBERS);
  insMember.run(SERVER_ID, 8);
  insHolding.run(SERVER_ID, 8, 21);
  insHolding.run(SERVER_ID, 8, 22);
  // The exact-OR baseline: one KICK role + one INVITES role = 12 both ways.
  insRole.run(31, SERVER_ID, "E", 1, KICK_MEMBERS);
  insRole.run(32, SERVER_ID, "F", 1, MANAGE_INVITES);
  insMember.run(SERVER_ID, 9);
  insHolding.run(SERVER_ID, 9, 31);
  insHolding.run(SERVER_ID, 9, 32);
  return db;
}

const OLD_SUM_MASK_SQL =
  "SELECT COALESCE(SUM(r.permissions), 0) AS mask FROM gc_member_roles mr " +
    "JOIN gc_roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?";
const oldSumMask = (db, userId) => Number(
  db.prepare(OLD_SUM_MASK_SQL).get(SERVER_ID, userId).mask,
);

const newMask = (db, userId) => parseMergedMask(
  db.prepare(
    "SELECT " + roleMaskColumnSql() + " AS mask FROM gc_server_members m " +
      "WHERE m.server_id = ? AND m.user_id = ?",
  ).get(SERVER_ID, userId, SERVER_ID, userId).mask,
);

// The guard question as a statement: does the actor's held set admit `bit`?
const plainGuard = (db, userId, bit) =>
  db.prepare(
    "SELECT 1 AS hit WHERE " + holdsRolesBitsSql(bit) + " LIMIT 1",
  ).get(...holdsRolesBitsParams(SERVER_ID, userId, bit)) !== undefined;

test("REAL sqlite: the SUM mask read of 2×MANAGE_EMOJI answers the phantom bit; the GROUP_CONCAT fold does not", () => {
  const db = seededDb();
  try {
    // The old read (what every guard saw before the fix) is the bug itself.
    assert.equal(oldSumMask(db, 7), MENTION_EVERYONE,
      "2×2048 sums to 4096 — the phantom that made a duplicate-emoji holder able to mention everyone");
    // The shipped read: GROUP_CONCAT + parseMergedMask.
    assert.equal(newMask(db, 7), MANAGE_EMOJI);
    assert.equal((newMask(db, 7) & MENTION_EVERYONE), 0,
      "no MENTION_EVERYONE bit rides the fold for a member who never held it");
  } finally {
    db.close();
  }
});

test("REAL sqlite: the per-bit EXISTS guard is exact OR for the 2×2048 member", () => {
  const db = seededDb();
  try {
    assert.equal(plainGuard(db, 7, MANAGE_EMOJI), true,
      "the member DOES hold MANAGE_EMOJI (twice) — the bit admits");
    assert.equal(plainGuard(db, 7, MENTION_EVERYONE), false,
      "the phantom 4096 admittance is refused: EXISTS knows no role holds it");
    // The old SUM guard (constructed only to document the refuted shape):
    const oldGuardMask = oldSumMask(db, 7);
    assert.equal((oldGuardMask & MENTION_EVERYONE) === MENTION_EVERYONE, true,
      "the old `(mask & bit) = bit` arm WOULD have admitted the phantom — the exact bug");
  } finally {
    db.close();
  }
});

test("REAL sqlite: 2×KICK carries the phantom 8 (MANAGE_INVITES); the guard refuses invites, admits kick", () => {
  const db = seededDb();
  try {
    assert.equal(oldSumMask(db, 8), MANAGE_INVITES,
      "2×4 sums to 8 — the kicked-out member could manage invites under the old read");
    assert.equal(newMask(db, 8), KICK_MEMBERS);
    assert.equal(plainGuard(db, 8, KICK_MEMBERS), true);
    assert.equal(plainGuard(db, 8, MANAGE_INVITES), false,
      "the invites bit is refused even though SUM claimed it");
  } finally {
    db.close();
  }
});

test("REAL sqlite: an exact-OR member (kick + invites = 12) reads the same either way — no over-tightening", () => {
  const db = seededDb();
  try {
    assert.equal(oldSumMask(db, 9), KICK_MEMBERS | MANAGE_INVITES);
    assert.equal(newMask(db, 9), KICK_MEMBERS | MANAGE_INVITES);
    assert.equal(plainGuard(db, 9, KICK_MEMBERS), true);
    assert.equal(plainGuard(db, 9, MANAGE_INVITES), true);
  } finally {
    db.close();
  }
});

// --- the per-module source pins (no SUM mask fragment survives anywhere) -----------

const API_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "api");
const CONVERTED = [
  "servers.mjs", "messages.mjs", "emoji.mjs", "soundboard.mjs", "social.mjs",
];

test("every converted module reads role masks by GROUP_CONCAT fold, never by SUM", () => {
  for (const file of CONVERTED) {
    const source = readFileSync(path.join(API_DIR, file), "utf8");
    assert.doesNotMatch(source, /SUM\(\s*[\w.]*permissions\b/i,
      file + " still carries a SUM-over-permissions mask read (the H1 phantom)");
    assert.doesNotMatch(source, /COALESCE\(SUM\(/i,
      file + " still carries a COALESCE-SUM aggregate");
  }
});

test("the per-bit guard is the shipped shape on every module that gates authority", () => {
  for (const file of CONVERTED) {
    const source = readFileSync(path.join(API_DIR, file), "utf8");
    if (!source.includes("holdsRolesBitsSql")) continue; // a module may gate by other fragments
    assert.match(source, /holdsRolesBitsSql\(/, file + " converts its gate bits through the shared fragment");
    const fragments = source.match(/holdsRolesBitsParams\(/g) || [];
    assert.ok(fragments.length > 0, file + " binds its guard pairs through the shared params helper");
  }
});

// --- H2: the destination-slot hierarchy check (route-level pin) --------------------

const ORIGIN = "http://localhost";
const USER_ID = 7;

function request(method, path, body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    response = await handleServerRoutes(
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

function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => { statement.bound = values; return statement; };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = find(sql);
        return route ? (route.first ? await route.first(statement.bound) : null) : null;
      };
      statement.all = async () => ({ results: [] });
      statement.run = async () => ({ meta: { changes: 1 } });
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

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

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const ACTOR_CONTEXT_TEST = (sql) =>
  sql.includes("AS permissions") && sql.includes("AS position") &&
  sql.includes("FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?");
const ROLE_SELECT_TEST = (sql) =>
  sql.includes("SELECT id, name, color, position, permissions FROM gc_roles WHERE id = ? AND server_id = ?");

test("H2: a role cannot climb into a free slot ABOVE the actor's top position (403, no batch)", async () => {
  // The actor holds MANAGE_ROLES with a top position of 1; the role sits at 0
  // (below the top, the CURRENT position passes); the free slot 3 rides a
  // deletion gap above the actor. The destination check refuses — under the
  // pre-fix code (current-position only) this climb succeeded.
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: ACTOR_CONTEXT_TEST,
      first: async () => ({ role: "member", permissions: MANAGE_ROLES, position: 1, nickname: null }),
    },
    { test: ROLE_SELECT_TEST, first: async () => ({ id: 4, name: "A", color: null, position: 0, permissions: 0 }) },
    {
      test: (sql) => sql.includes("SELECT COALESCE(MAX(position), -1) AS max_position FROM gc_roles"),
      first: async () => ({ max_position: 3 }),
    },
    { test: (sql) => sql.includes("SELECT id FROM gc_roles WHERE server_id = ? AND position = ? AND id <> ?"),
      first: async () => null },
  ]);
  const response = await dispatch(
    request("PATCH", "/api/servers/3/roles/4", { position: 3 }, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
    }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "You do not have permission to do that." });
  // Refused at the destination check — nothing moved.
  assert.deepEqual(db.calls.filter((call) => call.call === "run"), []);
});

test("H2 positive control: a free-slot move WITHIN the actor's top still rides", async () => {
  const { token, csrf, row } = await sessionFixtures();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: ACTOR_CONTEXT_TEST,
      first: async () => ({ role: "member", permissions: MANAGE_ROLES, position: 2, nickname: null }),
    },
    { test: ROLE_SELECT_TEST, first: async () => ({ id: 4, name: "A", color: null, position: 0, permissions: 0 }) },
    {
      test: (sql) => sql.includes("SELECT COALESCE(MAX(position), -1) AS max_position FROM gc_roles"),
      first: async () => ({ max_position: 3 }),
    },
    { test: (sql) => sql.includes("SELECT id FROM gc_roles WHERE server_id = ? AND position = ? AND id <> ?"),
      first: async () => null },
  ]);
  const response = await dispatch(
    request("PATCH", "/api/servers/3/roles/4", { position: 1 }, {
      Cookie: "goober_session=" + token,
      "X-CSRF-Token": csrf,
    }),
    envWithLimiters(db),
  );
  assert.equal(response.status, 200);
  // The batch ran (both statements carry the destination-guarded updates).
  assert.equal(db.calls.filter((call) => call.call === "first").length >= 3, true);
});

test("canManageRoleAt is the strict-below rule the H2 check re-asserts at the destination", () => {
  assert.equal(canManageRoleAt(false, 2, 1), true);
  assert.equal(canManageRoleAt(false, 2, 2), false, "equal is refused, not just greater");
  assert.equal(canManageRoleAt(false, 2, 3), false);
  assert.equal(canManageRoleAt(true, -1, 9), true, "the owner tier bypasses");
  assert.equal(highestPosition([]), -1);
});

// The limiter-accepting env (the route pins above need every binding present).
function envWithLimiters(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// --- the resolved upload commit batch EXECUTES (real sqlite) -----------------------
//
// A string-matching pin sufficed for nothing here: the reviewer's HIGH (the
// 7-for-8 ROW_INSERT shape, fixed by giving size_bytes back its own `?` and
// created_at the last) threw only at EXECUTION — "7 values for 8 columns" on
// every commit. These tests run the route's resolved SQL + binds against a
// REAL node:sqlite fixture, so the batch's SQL text can never drift its
// column counts again.

import { DatabaseSync as UploadExecDb } from "node:sqlite"; // distinct from the audit's fixture db

const COMMIT_MIME = "image/png";
const COMMIT_NOW = 1700000000;
const COMMIT_UPLOAD_ID = "ABCdef123456";
const COMMIT_UPLOADER = 7;
const COMMIT_CHUNK_BYTES = 64000;

function commitFixtureDb() {
  const db = new UploadExecDb(":memory:");
  db.exec(`
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER, uploader_id INTEGER NOT NULL,
      mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL, width INTEGER, height INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE gc_upload_parts (
      upload_id TEXT NOT NULL, uploader_id INTEGER NOT NULL, seq INTEGER NOT NULL,
      data BLOB NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (upload_id, uploader_id, seq)
    );
    CREATE TABLE gc_attachment_chunks (
      attachment_id INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY (attachment_id, seq)
    );
  `);
  return db;
}

function seedStaged(db) {
  // The wave-20 truth: a staging row carries NO chunk bytes — 1-byte marker
  // rows ride the part seqs (the byte leg is the bucket's), so the fixture
  // seeds the marker shape, never a byte-carrying BLOB.
  const marker = new Uint8Array(1);
  db.prepare(
    "INSERT INTO gc_upload_parts (upload_id, uploader_id, seq, data, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(COMMIT_UPLOAD_ID, COMMIT_UPLOADER, 0, marker, COMMIT_NOW);
}

// The batch exactly as handleCommitUploadRoute assembles it (wave-20): the
// resolved SQL text and the route's bind order — NO move arm (the byte leg
// retired to the bucket; the row, the clear, nothing between), and the row's
// own binds carry no byte payload.
function resolvedCommitBinds({ count, sum }) {
  return {
    rowSql: ROW_INSERT_SQL + STAGING_ARMS_SQL,
    rowBinds: [COMMIT_UPLOADER, COMMIT_MIME, sum, COMMIT_NOW,
      COMMIT_UPLOAD_ID, COMMIT_UPLOADER, count],
    clearSql: STAGING_CLEAR_SQL,
    clearBinds: [COMMIT_UPLOAD_ID, COMMIT_UPLOADER],
  };
}

test("the resolved commit batch EXECUTES in real sqlite: the row carries the declared size, no byte payload anywhere", () => {
  const db = commitFixtureDb();
  try {
    seedStaged(db);
    // The staged truth, asserted in the SAME real sqlite: every staging
    // row's data column holds ONLY the 1-byte marker — a byte-carrying row
    // would be the wave-20 violation itself.
    const staged = db.prepare("SELECT seq, length(data) AS marker FROM gc_upload_parts ORDER BY seq").all();
    assert.equal(staged.length, 1);
    assert.equal(staged[0].marker, 1, "staging rows hold ONLY 1-byte markers (the byte leg is the bucket's)");
    const batch = resolvedCommitBinds({ count: 1, sum: COMMIT_CHUNK_BYTES });
    // The wave-20 seam: the batch's row SQL carries no move arm — no
    // gc_attachment_chunks statement rides behind the row birth.
    assert.doesNotMatch(batch.rowSql, /gc_attachment_chunks/,
      "the move arm retired with the byte leg");
    assert.ok(batch.rowBinds.every((bind) => typeof bind === "string" || typeof bind === "number"),
      "the row's binds carry no byte payload");
    db.prepare(batch.rowSql).run(...batch.rowBinds);
    db.prepare(batch.clearSql).run(...batch.clearBinds);

    const row = db.prepare(
      "SELECT message_id, uploader_id, mime, size_bytes, status, created_at FROM gc_attachments ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(row, "the pending row was born inside the resolved batch");
    assert.equal(row.message_id, null);
    assert.equal(row.uploader_id, COMMIT_UPLOADER);
    assert.equal(row.mime, COMMIT_MIME);
    assert.equal(row.size_bytes, COMMIT_CHUNK_BYTES,
      "size_bytes rides the route's declared size (the streamed sum's arm was the intake-time gate)");
    assert.equal(row.status, "pending");
    assert.equal(row.created_at, COMMIT_NOW);
    // The identity tuple (uploader, mime, size, created_at) resolves the born row.
    const identity = db.prepare(
      "SELECT id FROM gc_attachments WHERE message_id IS NULL AND uploader_id = ? " +
        "AND mime = ? AND size_bytes = ? AND created_at = ? ORDER BY id DESC LIMIT 1",
    ).get(COMMIT_UPLOADER, COMMIT_MIME, COMMIT_CHUNK_BYTES, COMMIT_NOW);
    assert.ok(identity, "the identity tuple resolves (the birth and the clear share it)");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_upload_parts").get().n, 0,
      "the staging rows cleared once the count arm birthed exactly one row");
  } finally {
    db.close();
  }
});

test("a raced staged set (the arms mismatch) births NOTHING and the staging stays for the retry", () => {
  const db = commitFixtureDb();
  try {
    seedStaged(db); // one 1-byte marker row (the byte leg is the bucket's)
    // The route's verify read claimed 2 parts / 128,000 bytes; the birth arm
    // reads the raced set and refuses inside the statement — the birth is
    // the batch's sole gate (wave-20: no move arm rides behind it, the clear
    // runs only after a DURABLE assembly, so the staging survives unrun).
    const batch = resolvedCommitBinds({ count: 2, sum: 128000 });
    db.prepare(batch.rowSql).run(...batch.rowBinds);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_attachments").get().n, 0,
      "no row was born against the raced set");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_upload_parts").get().n, 1,
      "the staging stays exactly as the caller staged it (the clear rides only behind a durable assembly)");
  } finally {
    db.close();
  }
});

test("the identity tuple SQL itself is the two-statement agreement the comment pins", () => {
  assert.match(IDENTITY_TUPLE_SQL, /message_id IS NULL/);
  assert.match(IDENTITY_TUPLE_SQL, /size_bytes = \?/);
  assert.equal(IDENTITY_TUPLE_SQL.split("?").length - 1, 4,
    "uploader, mime, size_bytes, created_at — one pair per statement, no third wheel");
});
