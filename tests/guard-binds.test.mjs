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

// The guard-bind gate (the release battery's finding class): the fakeDb in
// the module tests routes on string matching and NEVER counts binds against
// placeholders, so a guard fragment whose params array and SQL disagree
// sails the suite green and 500s on real D1 ("Wrong number of parameter
// bindings") on every statement that embeds it. These probes run TRUE
// node:sqlite against a minimal schema: each guard composes, then must
// prepare AND execute with its own params array — extra or missing binds
// throw, exactly like D1.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { moderationGuardSql } from "../api/servers.mjs";
import { moderationGuardSql as socialModerationGuardSql } from "../api/social-helpers.mjs";
import { overwriteGuardSql } from "../api/server-channels.mjs";
import { INVITE_LIST_SQL, INVITE_REVOKE_SQL } from "../api/server-invites.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SEAM_SOURCE = readFileSync(path.join(HERE, "..", "api", "server-mod.mjs"), "utf8");
const INVITE_SOURCE = readFileSync(path.join(HERE, "..", "api", "server-invites.mjs"), "utf8");

function probe() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gc_server_members (server_id INTEGER, user_id INTEGER, role TEXT, joined_at INTEGER);
    CREATE TABLE gc_roles (id INTEGER, server_id INTEGER, position INTEGER, permissions INTEGER);
    CREATE TABLE gc_member_roles (server_id INTEGER, user_id INTEGER, role_id INTEGER);
    CREATE TABLE gc_channels (id INTEGER, server_id INTEGER, kind TEXT);
    CREATE TABLE gc_invites (code TEXT, server_id INTEGER, revoked_at INTEGER, created_at INTEGER);
  `);
  return db;
}

// SELECT 1 WHERE <expr> is a valid bare-expr probe: the guard's EXISTS
// clauses are self-contained, so the outer statement needs no tables — this
// isolates exactly the placeholder/bind arithmetic real D1 enforces.
function guardExecutes(db, guard) {
  const statement = db.prepare("SELECT 1 AS ok WHERE " + guard.sql);
  assert.doesNotThrow(() => statement.get(...guard.params),
    "the guard must execute with its own params (" + guard.params.length + " binds vs ? placeholders)");
}

test("moderationGuardSql executes on real SQLite (1 bit + 3 bits)", () => {
  const db = probe();
  try {
    guardExecutes(db, moderationGuardSql(1, 2, 3, SERVER_PERMISSIONS.KICK_MEMBERS));
    guardExecutes(db, moderationGuardSql(1, 2, 3, [
      SERVER_PERMISSIONS.KICK_MEMBERS, SERVER_PERMISSIONS.MANAGE_ROLES, SERVER_PERMISSIONS.MANAGE_CHANNELS,
    ]));
  } finally { db.close(); }
});

test("the social twin guard still executes (the parity control)", () => {
  const db = probe();
  try {
    guardExecutes(db, socialModerationGuardSql(1, 2, 3, SERVER_PERMISSIONS.KICK_MEMBERS));
  } finally { db.close(); }
});

test("overwriteGuardSql executes on real SQLite (everyone + role layers)", () => {
  const db = probe();
  try {
    guardExecutes(db, overwriteGuardSql(1, 2, 3, null));
    guardExecutes(db, overwriteGuardSql(1, 2, 3, 7));
  } finally { db.close(); }
});

test("the prune position guard carries exactly the 3 binds its SQL asks for", () => {
  // positionGuardSql (non-owner): pm.server_id = ? in the literal text,
  // plus TOP_POSITION_SELECT's two (server, user) '?'s at reference time.
  const positionFragment = SEAM_SOURCE.match(
    /"NOT EXISTS \(SELECT 1 FROM gc_member_roles pm[\s\S]+?TOP_POSITION_SELECT \+ "\)";/,
  );
  assert.ok(positionFragment, "the prune position guard fragment is present");
  const literalPlaceholders = (positionFragment[0].match(/\?/g) || []).length;
  assert.equal(literalPlaceholders, 1, "one literal ? (pm.server_id); TOP adds its 2 by reference");
  const placeholderCount = literalPlaceholders + 2;

  const bindsMatch = SEAM_SOURCE.match(
    /const positionGuardBinds = isOwner \? \[\] : \[([^\]]+)\];/,
  );
  assert.ok(bindsMatch, "the position guard binds line is present");
  const bindCount = bindsMatch[1].split(",").filter((s) => s.trim() !== "").length;
  assert.equal(bindCount, 3, "exactly 3 binds ride the 3 placeholders");
  assert.match(SEAM_SOURCE, /\[serverId, serverId, userId\]/,
    "the binds carry pm.server_id then the TOP pair's (serverId, userId)");
  assert.doesNotMatch(SEAM_SOURCE, /const positionGuardBinds = isOwner \? \[\] : \[serverId, userId, serverId, userId\]/,
    "the stale 4-bind 2×TOP shape is gone");
});

test("the invite list statement carries one bind per placeholder", () => {
  const placeholderCount = (INVITE_LIST_SQL.match(/\?/g) || []).length;
  assert.equal(placeholderCount, 5, "i.server_id + the owner pair + the holds pair = 5");
  assert.match(INVITE_SOURCE, /\.bind\(serverId, serverId, userId, serverId, userId\)\.all\(\)/,
    "the list binds ride textual order: i.server_id, om pair, gbm pair");
});

test("the invite revoke statements carry one bind per placeholder", () => {
  const placeholderCount = (INVITE_REVOKE_SQL.match(/\?/g) || []).length;
  assert.equal(placeholderCount, 7, "now + code + server_id + owner pair + holds pair = 7");
  assert.match(INVITE_SOURCE, /\.bind\(now, code, serverId, serverId, userId, serverId, userId\)\.run\(\)/,
    "the revoke binds ride textual order");
  assert.match(INVITE_SOURCE, /\.bind\(serverId, serverId, userId, serverId, userId\)\.first\(\)/,
    "the allowed probe binds ride textual order");
});
