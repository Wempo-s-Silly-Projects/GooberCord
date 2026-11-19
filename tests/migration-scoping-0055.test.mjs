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

// Migration 0055 scoping pin: the five account-deletion FK gaps, closed by
// the rebuild pattern (0021/0024/0027 discipline): per table — CREATE the
// `_rebuild` copy with the ONE FK-clause delta, INSERT..SELECT the rows with
// ids explicit, DROP the original BY ITS OWN NAME, RENAME the copy over that
// exact name (children are never rewritten), recreate every named index the
// live DDL declares. The static pins hold the exact statement set/in order,
// the five FK treatments in their intended clauses, the copied column sets,
// the recreated indexes, and the single-delta shape (CHECK counts); the
// real-SQLite pins hold the fidelity end-to-end (rows preserved, ids and
// child links exact, and — with FKs ON after the apply — user deletion now
// SET-NULLs the server owner and the audit/ban/filter authorships, CASCADEs
// the creator's invites, and CASCADEs the victim's expression rows through
// their attachments, with a survivor's rows untouched).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The helper mirrors tests/migration-scoping.test.mjs's statementsOf —
// copied inline (importing the sibling file would drag its 0001 pins into
// this file's solo run) so a statement is only closed once BEGIN/END
// tokens balance. 0055 carries no trigger, so the balance is trivial.
function statementsOf(sql) {
  const withoutComments = sql.replace(/--[^\n]*/g, "");
  const parts = withoutComments.split(";");
  const statements = [];
  const count = (s, word) => (s.match(new RegExp(`\\b${word}\\b`, "gi")) || []).length;
  let buf = [];
  for (const part of parts) {
    buf.push(part);
    const candidate = buf.join(";");
    if (count(candidate, "begin") === count(candidate, "end")) {
      const trimmed = candidate.trim();
      if (trimmed) statements.push(trimmed);
      buf = [];
    }
  }
  const tail = buf.join(";").trim();
  if (tail) statements.push(tail);
  return statements;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0055_gc_fk_gaps.sql"),
  "utf8",
);

function stripped(sql) {
  return sql.replace(/--[^\n]*/g, " ").trim();
}

function migrationStatements() {
  return statementsOf(MIGRATION);
}

const TABLES = [
  { name: "gc_invites", hasIndex: "idx_gc_invites_server ON gc_invites(server_id)" },
  { name: "gc_server_bans", hasIndex: null },
  { name: "gc_filter_rules", hasIndex: "idx_gc_filter_rules_server ON gc_filter_rules(server_id, id)" },
  { name: "gc_emoji", hasIndex: null },
  { name: "gc_stickers", hasIndex: null },
  { name: "gc_sounds", hasIndex: null },
];

test("the file is exactly 30 statements: the owner column dance, then six rebuild pairs", () => {
  const list = migrationStatements();
  assert.equal(list.length, 30, `30 statements expected, got ${list.length}`);
  // (1) the owner dance: four statements, the parent's name never moves.
  let at = 0;
  assert.match(list[at++], /^ALTER TABLE gc_servers ADD COLUMN owner_user_id_setnull\b/);
  assert.match(list[at++], /^UPDATE gc_servers SET owner_user_id_setnull = owner_user_id\b/);
  assert.match(list[at++], /^ALTER TABLE gc_servers DROP COLUMN owner_user_id\b/);
  assert.match(list[at++], /^ALTER TABLE gc_servers RENAME COLUMN owner_user_id_setnull TO owner_user_id\b/);
  for (const { name, hasIndex } of TABLES) {
    assert.match(list[at++], new RegExp(`^CREATE TABLE "?${name}_rebuild"? \\(`));
    assert.match(list[at++], new RegExp(`^INSERT INTO ${name}_rebuild`));
    assert.match(list[at++], new RegExp(`^DROP TABLE "?${name}"?`));
    assert.match(list[at++], new RegExp(`^ALTER TABLE ${name}_rebuild RENAME TO ${name}\\b`));
    if (hasIndex) {
      const literal = hasIndex.replace(/([().,])/g, "\\$1");
      assert.match(list[at++], new RegExp(`^CREATE INDEX (IF NOT EXISTS )?${literal}`));
    }
  }
  assert.equal(at, list.length, "every statement belongs to the dance or a rebuild pair");
});

test("the five FK treatments ride exactly the intended clauses", () => {
  const body = stripped(MIGRATION);
  // (1) the server owner: NULLable + SET NULL, via the column dance
  // (the dancer's carrier column carries the FK; the rename restores the name).
  assert.match(body, /owner_user_id_setnull INTEGER NULL REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(body, /RENAME COLUMN owner_user_id_setnull TO owner_user_id\b/);
  assert.doesNotMatch(body, /owner_user_id[^\n]*NOT NULL REFERENCES/);
  // (2) the invite author: NOT NULL kept, CASCADE chosen.
  assert.match(body, /created_by INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  // (3)+(4) the audit/ban authorships: already NULLable, now SET NULL.
  assert.equal((body.match(/ON DELETE SET NULL/g) || []).length, 3,
    "SET NULL rides exactly three clauses: server owner, filter author, ban author");
  // (5) the expression wall: all three RESTRICTs become CASCADEs.
  for (const table of ["gc_emoji", "gc_stickers", "gc_sounds"]) {
    assert.match(body, new RegExp(
      `attachment_id INTEGER NOT NULL\\s*REFERENCES gc_attachments\\(id\\) ON DELETE CASCADE`,
    ));
  }
  assert.equal((body.match(/ON DELETE RESTRICT/g) || []).length, 0,
    "no RESTRICT survives the rebuild");
  assert.equal(
    (body.match(/REFERENCES users\(id\)(?!\s+ON DELETE)/g) || []).length, 0,
    "no bare users reference (the NO ACTION FKs are exactly what pins the rows)",
  );
});

test("each copy lists the identical column set on both sides — no renumbering", () => {
  const list = migrationStatements();
  const columns = {
    gc_invites: "code, server_id, created_by, created_at, uses, expires_at, max_uses, revoked_at",
    gc_server_bans: "server_id, user_id, created_by, reason, created_at",
    gc_filter_rules: "id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions, is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at",
    gc_emoji: "id, server_id, name, attachment_id, created_by, created_at",
    gc_stickers: "id, server_id, name, attachment_id, created_by, created_at",
    gc_sounds: "id, server_id, name, attachment_id, created_by, created_at",
  };
  for (const { name } of TABLES) {
    const copy = list.find((s) => s.startsWith(`INSERT INTO ${name}_rebuild`));
    const cols = columns[name];
    const pattern = cols.split(", ").join("\\s*,\\s*");
    assert.match(copy, new RegExp(`INSERT INTO ${name}_rebuild\\s*\\(?\\s*[^;]*?${pattern}\\b`),
      `${name} left side`);
    assert.match(copy, new RegExp(`SELECT[^;]*?\\b${pattern}\\b[^;]*?\\bFROM ${name}\\b`),
      `${name} right side`);
  }
});

test("the single delta per table is the FK clause: the rest of the shape matches the live DDL", () => {
  const list = migrationStatements();
  const creates = Object.fromEntries(
    TABLES.map(({ name }) => [name, list.find((s) =>
      s.startsWith(`CREATE TABLE ${name}_rebuild`) || s.startsWith(`CREATE TABLE "${name}_rebuild`))]),
  );
  const expected = {
    gc_invites: [
      "code TEXT PRIMARY KEY",
      "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
      "created_at INTEGER NOT NULL",
      "uses INTEGER NOT NULL DEFAULT 0",
      "expires_at INTEGER NULL, max_uses INTEGER NULL, revoked_at INTEGER NULL",
    ],
    gc_server_bans: [
      "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
      "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
      "reason TEXT NULL CHECK(reason IS NULL OR length(reason) <= 280)",
      "created_at INTEGER NOT NULL",
      "PRIMARY KEY (server_id, user_id)",
    ],
    gc_filter_rules: [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
      "name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 64)",
      "terms TEXT NOT NULL CHECK(length(terms) BETWEEN 2 AND 65536)",
      "exempt_role_ids TEXT NULL CHECK(exempt_role_ids IS NULL OR length(exempt_role_ids) <= 4096)",
      "exempt_channel_ids TEXT NULL CHECK(exempt_channel_ids IS NULL OR length(exempt_channel_ids) <= 4096)",
      "actions TEXT NOT NULL CHECK(actions IS NOT NULL AND length(actions) BETWEEN 2 AND 64)",
      "is_care INTEGER NOT NULL DEFAULT 0 CHECK(is_care IN (0, 1))",
      "check_names INTEGER NOT NULL DEFAULT 0 CHECK(check_names IN (0, 1))",
      "block_message TEXT NULL CHECK(block_message IS NULL OR length(block_message) <= 150)",
      "timeout_minutes INTEGER NULL CHECK(timeout_minutes IS NULL OR timeout_minutes IN (1, 5, 10, 60, 1440, 10080, 40320))",
      "created_at INTEGER NOT NULL",
      "updated_at INTEGER NOT NULL",
    ],
    gc_emoji: [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
      "name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 32",
      "attachment_id INTEGER NOT NULL",
      "created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
      "created_at INTEGER NOT NULL",
      "UNIQUE(server_id, name)",
    ],
    gc_stickers: [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
      "name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 30",
      "attachment_id INTEGER NOT NULL",
      "created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
      "created_at INTEGER NOT NULL",
      "UNIQUE(server_id, name)",
    ],
    gc_sounds: [
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
      "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
      "name TEXT NOT NULL",
      "attachment_id INTEGER NOT NULL",
      "created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE",
      "created_at INTEGER NOT NULL",
      "UNIQUE(server_id, name)",
    ],
  };
  const checkCounts = {
    gc_invites: 0,
    gc_server_bans: 1,
    gc_filter_rules: 9,
    gc_emoji: 1,
    gc_stickers: 1,
    gc_sounds: 1,
  };
  for (const [name, fragments] of Object.entries(expected)) {
    for (const fragment of fragments) {
      assert.ok(creates[name].includes(fragment), `${name} missing: ${fragment}`);
    }
    assert.equal(
      (creates[name].match(/CHECK\(/g) || []).length,
      checkCounts[name],
      `${name}: no constraint delta rides the rebuild besides the FK clause`,
    );
  }
});

test("the named indexes: the two rebuild indexes recreate after their renames; the server index is untouched", () => {
  const body = stripped(MIGRATION);
  for (const { name, hasIndex } of TABLES) {
    if (!hasIndex) continue;
    const renameAt = body.indexOf(`RENAME TO ${name}`);
    const indexAt = body.indexOf(`CREATE INDEX`);
    const own = body.indexOf(hasIndex);
    assert.ok(renameAt > -1 && own > -1, `${name}: rename + index present`);
    assert.ok(own > renameAt, `${name} index is created only on the final table`);
    assert.ok(indexAt > -1);
  }
  assert.equal((body.match(/CREATE INDEX/g) || []).length, 2,
    "exactly the two live named indexes ride the rebuilds");
  // gc_servers' name never moves, so its named index needs no recreate.
  assert.doesNotMatch(body, /DROP INDEX/, "no index is dropped");
  assert.doesNotMatch(body, /idx_gc_servers_is_public/,
    "the server index survives the column dance untouched");
});

test("the 0013->0014 hazard stays dead: drops are own-name, six rebuilds, no PRAGMA, parent never dropped", () => {
  const body = stripped(MIGRATION);
  assert.equal((body.match(/DROP TABLE/g) || []).length, 6);
  assert.equal((body.match(/RENAME TO/g) || []).length, 6);
  assert.doesNotMatch(body, /RENAME TO.*pre/i);
  assert.doesNotMatch(body, /\bPRAGMA\b/i, "no PRAGMA rides the file");
  assert.doesNotMatch(body, /DROP TABLE "?gc_servers"?/,
    "the populated parent is never dropped — enforcement survives by design");
  for (const { name } of TABLES) {
    assert.match(body, new RegExp(`DROP TABLE "?${name}"?`), `${name} dropped by its own name`);
  }
});

test("no forum-side table beyond the read-only users reference is touched", () => {
  const body = stripped(MIGRATION);
  const tables = [...new Set(
    [...body.matchAll(/(?:REFERENCES|FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1]),
  )].filter((name) => !name.startsWith("gc_"));
  assert.deepEqual(tables, ["users"]);
});

// --- real SQLite (fidelity end-to-end) --------------------------------------

function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, icon_media_id INTEGER NULL, is_public INTEGER NOT NULL DEFAULT 0, boosts INTEGER NOT NULL DEFAULT 0, verification_level INTEGER NOT NULL DEFAULT 0
        CHECK(verification_level IN (0, 1, 2, 3, 4)), rules_text TEXT NULL);
    CREATE INDEX idx_gc_servers_is_public ON gc_servers(is_public);
    CREATE TABLE gc_channels (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NULL REFERENCES gc_servers(id),
      created_at INTEGER NOT NULL);
    CREATE TABLE gc_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uploader_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id INTEGER NULL);
    CREATE TABLE gc_invites (
      code TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NULL, max_uses INTEGER NULL, revoked_at INTEGER NULL);
    CREATE INDEX idx_gc_invites_server ON gc_invites(server_id);
    CREATE TABLE gc_server_bans (
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER NULL REFERENCES users(id),
      reason TEXT NULL CHECK(reason IS NULL OR length(reason) <= 280),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id));
    CREATE TABLE gc_filter_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 64),
      terms TEXT NOT NULL CHECK(length(terms) BETWEEN 2 AND 65536),
      exempt_role_ids TEXT NULL CHECK(exempt_role_ids IS NULL OR length(exempt_role_ids) <= 4096),
      exempt_channel_ids TEXT NULL CHECK(exempt_channel_ids IS NULL OR length(exempt_channel_ids) <= 4096),
      actions TEXT NOT NULL CHECK(actions IS NOT NULL AND length(actions) BETWEEN 2 AND 64),
      is_care INTEGER NOT NULL DEFAULT 0 CHECK(is_care IN (0, 1)),
      check_names INTEGER NOT NULL DEFAULT 0 CHECK(check_names IN (0, 1)),
      block_message TEXT NULL CHECK(block_message IS NULL OR length(block_message) <= 150),
      timeout_minutes INTEGER NULL CHECK(timeout_minutes IS NULL OR timeout_minutes IN (1, 5, 10, 60, 1440, 10080, 40320)),
      created_by INTEGER NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE INDEX idx_gc_filter_rules_server ON gc_filter_rules(server_id, id);
    CREATE TABLE gc_emoji (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 32),
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE RESTRICT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(server_id, name));
    CREATE TABLE gc_stickers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 30),
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE RESTRICT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(server_id, name));
    CREATE TABLE gc_sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 32),
      attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE RESTRICT,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(server_id, name));
    INSERT INTO users (id) VALUES (2), (3);
    INSERT INTO gc_servers (id, name, owner_user_id, created_at, is_public)
      VALUES (5, 'victim-land', 2, 900, 1), (6, 'survivor-land', 3, 905, 1);
    INSERT INTO gc_channels (id, server_id, created_at) VALUES (11, 5, 910);
    INSERT INTO gc_attachments (id, uploader_id, message_id) VALUES (100, 2, NULL), (101, 3, NULL);
    INSERT INTO gc_invites (code, server_id, created_by, created_at, uses)
      VALUES ('victimcode', 5, 2, 920, 0), ('alivecode', 6, 3, 925, 1);
    INSERT INTO gc_server_bans (server_id, user_id, created_by, created_at)
      VALUES (5, 3, 2, 930);
    INSERT INTO gc_filter_rules (id, server_id, name, terms, actions, created_by, created_at, updated_at)
      VALUES (1, 5, 'rule-one', 'word', 'ban', 2, 940, 941),
             (2, 6, 'rule-two', 'ward', 'kick', 3, 945, 946);
    INSERT INTO gc_emoji (id, server_id, name, attachment_id, created_by, created_at)
      VALUES (1, 5, 'aa', 100, 2, 950), (2, 6, 'bb', 101, 3, 955);
    INSERT INTO gc_stickers (id, server_id, name, attachment_id, created_by, created_at)
      VALUES (1, 5, 'cc', 100, 2, 960);
    INSERT INTO gc_sounds (id, server_id, name, attachment_id, created_by, created_at)
      VALUES (1, 5, 'dd', 100, 2, 965);
  `);
  return db;
}

function apply(db) {
  // The runner is FK-ENFORCING (two remote applies proved it: 7500
  // immediately, then at COMMIT even with deferral). The file is written
  // enforcement-clean, so the fidelity lane applies it with FKs ON.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATION);
}

test("the apply preserves every row, id, link, index, and UNIQUE through the rebuild", () => {
  const db = seed();
  apply(db);
  db.exec("PRAGMA foreign_keys = ON");

  assert.deepEqual(
    db.prepare("SELECT id, name, owner_user_id, is_public FROM gc_servers ORDER BY id").all()
      .map((r) => ({ id: Number(r.id), name: r.name, owner: Number(r.owner_user_id), pub: Number(r.is_public) })),
    [{ id: 5, name: "victim-land", owner: 2, pub: 1 }, { id: 6, name: "survivor-land", owner: 3, pub: 1 }],
  );
  assert.deepEqual(
    db.prepare("SELECT id, name FROM gc_filter_rules ORDER BY id").all()
      .map((r) => ({ id: Number(r.id), name: r.name })),
    [{ id: 1, name: "rule-one" }, { id: 2, name: "rule-two" }],
  );
  // The children's own-name clauses resolve to the rebuilt parents.
  db.prepare("INSERT INTO gc_channels (id, server_id, created_at) VALUES (12, 5, 1000)").run();
  // The auto-named UNIQUE indexes re-derive through the rename.
  const autoindexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'sqlite_autoindex_gc_sounds%'",
  ).all().map((r) => r.name);
  assert.deepEqual(autoindexes, ["sqlite_autoindex_gc_sounds_1"]);
  // The rebuilt uniqueness still holds.
  assert.throws(() =>
    db.prepare("INSERT INTO gc_sounds (server_id, name, attachment_id, created_by, created_at) VALUES (5, 'dd', 101, 3, 1005)").run(),
  "UNIQUE(server_id, name) must still refuse a duplicate");
  // New rows continue the preserved sequences.
  db.prepare(
    "INSERT INTO gc_servers (id, name, owner_user_id, created_at) VALUES (7, 'next', 3, 1010)",
  ).run();
  assert.equal(Number(db.prepare("SELECT MAX(id) AS m FROM gc_servers").get().m), 7);
  // The named indexes came back.
  for (const index of ["idx_gc_servers_is_public", "idx_gc_invites_server", "idx_gc_filter_rules_server"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(index),
      `${index} recreated`);
  }
});

test("with FKs ON, user deletion now rides the five new arms — survivors untouched", () => {
  const db = seed();
  apply(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("DELETE FROM users WHERE id = 2");

  // (1) owner SET NULL — the server outlives its (dead) owner, NULLable.
  const owner = db.prepare("SELECT owner_user_id FROM gc_servers WHERE id = 5").get();
  assert.equal(owner.owner_user_id, null, "the orphaned server's owner rides SET NULL");
  assert.equal(db.prepare("SELECT owner_user_id FROM gc_servers WHERE id = 6").get().owner_user_id, 3,
    "the survivor's ownership is untouched");
  // (2) invite CASCADE — the creator's invites die, the survivor's live.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_invites WHERE code = 'victimcode'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_invites WHERE code = 'alivecode'").get().n, 1);
  // (3)+(4) filter/ban authorship SET NULL — rows outlive their (dead) authors.
  assert.equal(db.prepare("SELECT created_by FROM gc_filter_rules WHERE id = 1").get().created_by, null);
  assert.equal(db.prepare("SELECT created_by FROM gc_filter_rules WHERE id = 2").get().created_by, 3);
  assert.equal(db.prepare("SELECT created_by FROM gc_server_bans WHERE created_by IS NULL AND server_id = 5").get().created_by, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_server_bans").get().n, 1,
    "the ban row itself survives its author's death");
  // (5) expression CASCADE through the victim's attachments; survivor untouched.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_emoji").get().n, 1);
  assert.equal(db.prepare("SELECT id FROM gc_emoji").get().id, 2, "the survivor's emoji lives");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_stickers").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_sounds").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_attachments WHERE id = 100").get().n, 0,
    "the victim's attachment rides its own uploader CASCADE (the pre-0055 500)");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gc_attachments WHERE id = 101").get().n, 1);
});
