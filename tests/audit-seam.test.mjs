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

// T-R26-AUDIT (wave 26, W26-1): the server audit seam pin. ONE shared
// writer — recordAudit(env, actorId, serverId, actionKey, targetUserId,
// targetRef, payloadJson) in api/audit.mjs — feeds migration 0059's
// gc_server_audit; the moderation handlers insert the call at their exact
// commit points (kick/ban/unban/prune in api/server-mod.mjs, role
// create/update/delete + member nick in api/server-roles.mjs, overwrite
// PUT/DELETE in api/server-channels.mjs); the read arm
// (GET /api/servers/:id/audit) rides the owner/moderator manage tier in
// api/server-mod.mjs behind the constants.mjs single home
// (AUDIT_READ_LIMIT/AUDIT_PAYLOAD_MAX_BYTES — never re-declared). The
// real-SQLite probe lands 0059's DDL and drives recordAudit's INSERT
// end-to-end — node:sqlite enforces the placeholder/bind arithmetic real
// D1 enforces (the guard-binds referee).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD_SOURCE = readFileSync(join(HERE, "../api/server-mod.mjs"), "utf8");
const ROLES_SOURCE = readFileSync(join(HERE, "../api/server-roles.mjs"), "utf8");
const CHANNELS_SOURCE = readFileSync(join(HERE, "../api/server-channels.mjs"), "utf8");
const CONSTANTS_SOURCE = readFileSync(join(HERE, "../constants.mjs"), "utf8");
const MIGRATION_SQL = readFileSync(
  join(HERE, "../migrations/0059_gc_server_audit.sql"), "utf8",
);

// The RED edge: api/audit.mjs does not exist before the implementation —
// the whole file module-misses until the seam exists.
import { recordAudit, AUDIT_INSERT_SQL } from "../api/audit.mjs";
import { AUDIT_READ_LIMIT, AUDIT_PAYLOAD_MAX_BYTES } from "../constants.mjs";

const AUDIT_ARM_SOURCE =
  'path.match(/^\\/api\\/servers\\/(0|[1-9][0-9]*)\\/audit$/)';

// Handler slice: from the handler's own `async function` head to the NEXT
// handler head (or EOF) — a slice bounded tight enough for a
// doesNotMatch on the read arms to mean the read arms themselves.
function handlerSource(source, name) {
  const start = source.indexOf("async function " + name + "(");
  assert.ok(start !== -1, name + " exists");
  const next = source.indexOf("\nasync function ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

test("the audit writer rides api/audit.mjs — ONE single-purpose module", () => {
  const source = readFileSync(join(HERE, "../api/audit.mjs"), "utf8");
  assert.match(source, /export async function recordAudit\(/,
    "recordAudit is the module's one shared export");
  assert.match(source, /const AUDIT_INSERT_SQL/,
    "the INSERT fragment keeps its one home");
  // Positional binds only (the guard-binds law): no named-bind tokens.
  assert.doesNotMatch(AUDIT_INSERT_SQL, /:\w+/,
    "the INSERT carries no named binds");
  assert.match(AUDIT_INSERT_SQL,
    /^INSERT INTO gc_server_audit \(/, "the INSERT names its table");
  assert.equal((AUDIT_INSERT_SQL.match(/\?/g) || []).length, 7,
    "the INSERT is 7 positional placeholders");
  // Batched INSERT (the D1 batch idiom), and an audit failure never fails
  // the mutation that already committed.
  assert.match(source, /GOOBER_DB\.batch\(\[/,
    "recordAudit rides the batch idiom");
  assert.match(source, /catch \(error\)/, "the audit write is best-effort");
  for (const siblingSource of [MOD_SOURCE, ROLES_SOURCE, CHANNELS_SOURCE]) {
    assert.doesNotMatch(siblingSource, /async function recordAudit\b/,
      "recordAudit is never re-declared in a sibling");
    assert.doesNotMatch(siblingSource, /INSERT INTO gc_server_audit/,
      "no second INSERT literal in a sibling module");
  }
});

test("the audit caps keep their constants.mjs single home", () => {
  assert.match(CONSTANTS_SOURCE, /export const AUDIT_READ_LIMIT = 100/);
  assert.match(CONSTANTS_SOURCE, /export const AUDIT_PAYLOAD_MAX_BYTES = 4096/);
  for (const sourceName of [
    readFileSync(join(HERE, "../api/audit.mjs"), "utf8"), MOD_SOURCE,
    ROLES_SOURCE, CHANNELS_SOURCE,
  ]) {
    assert.doesNotMatch(sourceName, /const AUDIT_(READ_LIMIT|PAYLOAD_MAX_BYTES)\b/,
      "the audit caps are never re-declared outside constants.mjs");
  }
});

test("writer calls sit at the moderation commit points", () => {
  // server-mod.mjs: the kick/ban/unban/prune enforcement arm.
  const modHandlers = [
    "handleKickMemberRoute", "handleBanMemberRoute",
    "handleUnbanMemberRoute", "handlePruneRoute",
  ];
  // server-roles.mjs: the role CRUD + the member nickname.
  const rolesHandlers = [
    "handleCreateRoleRoute", "handleUpdateRoleRoute",
    "handleDeleteRoleRoute", "handleSetMemberNicknameRoute",
  ];
  // server-channels.mjs: the overwrite edits.
  const channelsHandlers = [
    "handlePutOverwriteRoute", "handleDeleteOverwriteRoute",
  ];
  for (const name of modHandlers) {
    assert.match(handlerSource(MOD_SOURCE, name), /await recordAudit\(/,
      name + " records its audit row");
  }
  for (const name of rolesHandlers) {
    assert.match(handlerSource(ROLES_SOURCE, name), /await recordAudit\(/,
      name + " records its audit row");
  }
  for (const name of channelsHandlers) {
    assert.match(handlerSource(CHANNELS_SOURCE, name), /await recordAudit\(/,
      name + " records its audit row");
  }
  // The reads never log: the list arms of every touched module stay
  // recordAudit-free.
  for (const name of ["handleListFilterRulesRoute", "handleListFilterAlertsRoute"]) {
    assert.doesNotMatch(handlerSource(MOD_SOURCE, name), /recordAudit\(/,
      name + " is a read — never logged");
  }
  for (const name of ["handleListRolesRoute", "handleRosterRoute"]) {
    assert.doesNotMatch(handlerSource(ROLES_SOURCE, name), /recordAudit\(/,
      name + " is a read — never logged");
  }
});

test("the read arm rides the manage tier behind the constant cap", () => {
  assert.ok(MOD_SOURCE.includes(AUDIT_ARM_SOURCE),
    "the GET /api/servers/:id/audit arm is dispatched");
  assert.match(MOD_SOURCE, /ORDER BY ga\.id DESC LIMIT " \+ AUDIT_READ_LIMIT/,
    "the page rides the constants.mjs cap");
  assert.match(MOD_SOURCE, /role IN \('owner','moderator'\)/,
    "the read's guard rides the owner/moderator manage tier");
  // No sibling answers the audit path.
  for (const siblingPath of [
    "../api/servers.mjs", "../api/server-roles.mjs",
    "../api/server-channels.mjs",
  ]) {
    const sibling = readFileSync(join(HERE, siblingPath), "utf8");
    assert.equal(sibling.includes("/servers/(0|[1-9][0-9]*)/audit"), false,
      siblingPath + " must not answer the audit path");
  }
});

test("0059 is the gc_server_audit DDL: CREATE-only, FK-free, capped payload", () => {
  // The prose below the header cites the FK law — test the DDL, not the
  // citation: the statement body starts at the CREATE TABLE.
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf("CREATE TABLE"));
  assert.doesNotMatch(body.toUpperCase(), /FOREIGN KEY|REFERENCES|TRIGGER|PRAGMA|RENAME|DROP/,
    "the DDL is CREATE-only, FK-free");
  assert.match(MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS\s*\n?\s*gc_server_audit/,
    "the table lands");
  assert.match(MIGRATION_SQL,
    /CREATE INDEX idx_gc_server_audit_server/,
    "the read's index lands");
  assert.match(MIGRATION_SQL, /CHECK \(length\(payload_json\) <= 4096\)/,
    "the payload cap mirrors the constants.mjs literal");
  // The 17-line-plus-blank AGPLv3 header.
  const lines = MIGRATION_SQL.split("\n");
  assert.match(lines[0], /^-- Copyright 2026 /);
  assert.equal(lines[16].startsWith("--"), true, "line 17 ends the license block");
  assert.equal(lines[17].trim(), "", "line 18 is the blank separator line");
});

// --- the real-SQLite probe (0059 DDL + the recordAudit INSERT end-to-end) ------

function sqliteEnv(db) {
  return {
    GOOBER_DB: {
      prepare(sql) {
        const statement = { sql, bound: [] };
        statement.bind = (...values) => { statement.bound = values; return statement; };
        statement.run = async () => {
          // node:sqlite throws on a placeholder/bind mismatch — the same
          // arithmetic real D1 enforces ("Wrong number of parameter
          // bindings").
          db.prepare(sql).run(...statement.bound);
          return { meta: { changes: 1 } };
        };
        statement.first = async () => db.prepare(sql).get(...statement.bound) ?? null;
        statement.all = async () => db.prepare(sql).all(...statement.bound);
        return statement;
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    },
  };
}

test("0059's DDL + recordAudit's INSERT run end-to-end on node:sqlite", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MIGRATION_SQL);
    const env = sqliteEnv(db);

    await recordAudit(env, 7, 1, "member.kick", 42, null, "{}");
    await recordAudit(env, 7, 1, "member.nick", null, null,
      JSON.stringify({ before: "old", after: "new" }));

    const rows = db.prepare("SELECT * FROM gc_server_audit ORDER BY id").all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor_id, 7);
    assert.equal(rows[0].action_key, "member.kick");
    assert.equal(rows[0].target_user_id, 42);
    assert.equal(rows[0].target_ref, null);
    assert.equal(rows[0].created_at > 0, true);
    assert.deepEqual(JSON.parse(rows[1].payload_json),
      { before: "old", after: "new" });

    // The payload cap is real: an over-cap payload meets the CHECK. The
    // mutation is never failed by it (recordAudit is best-effort) — a
    // refused audit write throws INSIDE the probe's bare batch only.
    const badEnv = sqliteEnv(db);
    await assert.rejects(
      badEnv.GOOBER_DB.batch([
        badEnv.GOOBER_DB.prepare(AUDIT_INSERT_SQL).bind(
          1, 7, "role.update", null, null, "x".repeat(4097), 5,
        ),
      ]),
      "the 4096-byte payload CHECK refuses the oversized row",
    );
  } finally { db.close(); }
});
