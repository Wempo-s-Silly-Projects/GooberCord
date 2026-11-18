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

// Migration 0024 scoping: the parity law's name bounds (docs/parity-limits.md,
// verified 2026-11-17 — role name length 1–100, GC's category names riding the
// same bound). The static pins hold each rebuild's exact shape (five
// statements per table, in this order, nothing else — a CHECK cannot be
// ALTERed so each table rebuilds; the DROP sits AFTER the copy and the final
// RENAME AFTER the drop), the real-SQLite pins hold the fidelity (ids
// preserved, the children's FK clauses still resolve to the rebuilt parents,
// the 100-bound round-trips and 101 refuses) and the 0013→0014 hazard stays
// dead (never a rename-DROP of the referenced shells; children are never
// rewritten at all in this sequence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.join(HERE, "..", "migrations", "0024_parity_role_category_name_bounds.sql"),
  "utf8",
);
const stripped = (s) => s.replace(/--[^\n]*/g, " ").trim();

function migrationStatements() {
  const parts = MIGRATION.replace(/--[^\n]*/g, "").split(";");
  return parts.map((p) => p.trim()).filter(Boolean);
}

test("the file is exactly sixteen statements in the pinned rebuild order", () => {
  const list = migrationStatements();
  assert.equal(list.length, 16, `sixteen statements expected, got ${list.length}`);
  const prefix = (i) => list[i].split("\n")[0].trim().slice(0, 60);
  assert.match(list[0], /^CREATE TABLE gc_roles_fk_canary_0024 \(/);
  assert.match(list[1],
    /^INSERT INTO gc_roles_fk_canary_0024 \(role_id\)\s+SELECT MIN\(id\) FROM gc_roles HAVING COUNT\(\*\) > 0$/);
  assert.match(list[2], /^CREATE TABLE gc_roles_rebuild\b/);
  assert.match(list[3], /^INSERT INTO gc_roles_rebuild\b/);
  assert.match(list[4], /^DROP TABLE gc_roles\b/);
  assert.match(list[5], /^ALTER TABLE gc_roles_rebuild RENAME TO gc_roles\b/);
  assert.match(list[6], /^CREATE INDEX idx_gc_roles_server\b/);
  assert.match(list[7], /^DROP TABLE gc_roles_fk_canary_0024/);
  assert.match(list[8], /^CREATE TABLE gc_channel_categories_fk_canary_0024 \(/);
  assert.match(list[9], /^INSERT INTO gc_channel_categories_fk_canary_0024/);
  assert.match(list[10], /^CREATE TABLE gc_channel_categories_rebuild\b/);
  assert.match(list[11], /^INSERT INTO gc_channel_categories_rebuild\b/);
  assert.match(list[12], /^DROP TABLE gc_channel_categories\b/);
  assert.match(list[13], /^ALTER TABLE gc_channel_categories_rebuild RENAME TO gc_channel_categories\b/);
  assert.match(list[14], /^CREATE INDEX idx_gc_channel_categories_server\b/);
  assert.match(list[15], /^DROP TABLE gc_channel_categories_fk_canary_0024/);
  // Both canaries RESTRICT (the loud-refusal lever on an FK-enforcing
  // runner — D1's engine silently fires CASADE actions on DROP otherwise,
  // verified 2026-11-17), and each leaves with its rebuild.
  assert.match(list[0], /REFERENCES gc_roles\(id\) ON DELETE RESTRICT/);
  assert.match(list[8], /REFERENCES gc_channel_categories\(id\) ON DELETE RESTRICT/);
});

test("no chat-style sentinel names and no other table is touched", () => {
  const body = stripped(MIGRATION);
  for (const name of ["gc_roles_pre_0024", "gc_channel_categories_pre_0024", "chat_messages"]) {
    assert.equal(body.includes(name), false, `${name} must not appear`);
  }
  // The only DROPs and the only RENAMEs operate on the rebuild pairs (two
  // parents, two canaries) — the referenced originals are dropped BY THEIR
  // OWN NAMES after the copy, never via a rename-out (the shape that
  // dangled 0013's children).
  assert.equal((body.match(/DROP TABLE/g) || []).length, 4);
  assert.equal((body.match(/RENAME TO/g) || []).length, 2);
  assert.doesNotMatch(body, /RENAME TO.*pre/);
});

test("the copies list every column explicitly and preserve ids", () => {
  const rolesCopy = migrationStatements()[3];
  const rolesExpected = "id, server_id, name, color, position, permissions, created_at";
  assert.match(rolesCopy, new RegExp(`${rolesExpected}\\b[^;]*${rolesExpected}\\b`, "s"),
    "the gc_roles copy lists the identical column set on both sides — no autoincrement rewrite");
  const categoriesCopy = migrationStatements()[11];
  const categoriesExpected = "id, server_id, name, position, created_at";
  assert.match(categoriesCopy, new RegExp(`${categoriesExpected}\\b[^;]*${categoriesExpected}\\b`, "s"),
    "the gc_channel_categories copy lists the identical column set on both sides");
});

test("the single delta per table is the bound: the rest of the shape matches the origin", () => {
  const rolesCreate = migrationStatements()[2];
  const categoriesCreate = migrationStatements()[10];
  const canaryRolesCreate = migrationStatements()[0];
  const canaryCategoriesCreate = migrationStatements()[8];
  for (const fragment of [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
    // The widened bound — the parity law's role-name row (1–100).
    "name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100)",
    "color TEXT NULL CHECK(color IS NULL OR length(color) = 7",
    "position INTEGER NOT NULL DEFAULT 0",
    "permissions INTEGER NOT NULL DEFAULT 0",
    "created_at INTEGER NOT NULL",
  ]) {
    assert.ok(rolesCreate.includes(fragment), `gc_roles missing: ${fragment}`);
  }
  for (const fragment of [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE",
    "name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100)",
    "position INTEGER NOT NULL DEFAULT 0",
    "created_at INTEGER NOT NULL",
  ]) {
    assert.ok(categoriesCreate.includes(fragment), `gc_channel_categories missing: ${fragment}`);
  }
  // The canaries: RESTRICT over the rebuilt parents — and no CHECK of their
  // own (their column's NOT NULL is the only bound).
  assert.match(canaryRolesCreate, /role_id INTEGER NOT NULL\s+REFERENCES gc_roles\(id\) ON DELETE RESTRICT/);
  assert.equal((canaryRolesCreate.match(/CHECK\(/g) || []).length, 0);
  assert.match(canaryCategoriesCreate, /category_id INTEGER NOT NULL\s+REFERENCES gc_channel_categories\(id\) ON DELETE RESTRICT/);
  assert.equal((canaryCategoriesCreate.match(/CHECK\(/g) || []).length, 0);
  // No second delta slips in: exactly gc_roles' two original CHECK clauses
  // (name widened, color untouched); the categories table carries only the
  // widened name.
  assert.equal((rolesCreate.match(/CHECK\(/g) || []).length, 2,
    "name + color CHECKs only — no new constraint rides along");
  assert.equal((categoriesCreate.match(/CHECK\(/g) || []).length, 1,
    "the name CHECK only — no new constraint rides along");
  // The GC category-name comment cites the parity law's row; nothing in the
  // file mentions Nitro (the naming rule stays clean).
  assert.doesNotMatch(stripped(MIGRATION), /nitro/i);
});

test("both indices are recreated verbatim after their rename", () => {
  const body = stripped(MIGRATION);
  assert.match(body, /CREATE INDEX idx_gc_roles_server ON gc_roles\(server_id\)/);
  assert.match(body, /CREATE INDEX idx_gc_channel_categories_server ON gc_channel_categories\(server_id\)/);
  const rolesIndexAt = body.indexOf("CREATE INDEX idx_gc_roles_server");
  const categoriesIndexAt = body.indexOf("CREATE INDEX idx_gc_channel_categories_server");
  assert.ok(
    body.indexOf("RENAME TO gc_roles") < rolesIndexAt &&
      body.indexOf("RENAME TO gc_channel_categories") < categoriesIndexAt,
    "indices are (re)created only on the final tables",
  );
});

function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_servers (id INTEGER PRIMARY KEY);
    CREATE TABLE gc_channels (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      created_at INTEGER NOT NULL);
    ALTER TABLE gc_channels ADD COLUMN category_id INTEGER NULL
      REFERENCES gc_channel_categories(id) ON DELETE SET NULL;
    ALTER TABLE gc_channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0;
    -- The 0006 and 0007 originals (the two CHECKs pinned above are their only
    -- constraint deltas in 0024).
    CREATE TABLE gc_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 32),
      color TEXT NULL CHECK(color IS NULL OR length(color) = 7
            AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
      position INTEGER NOT NULL DEFAULT 0,
      permissions INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);
    CREATE INDEX idx_gc_roles_server ON gc_roles(server_id);
    CREATE TABLE gc_member_roles (
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES gc_roles(id) ON DELETE CASCADE,
      PRIMARY KEY (server_id, user_id, role_id));
    CREATE TABLE gc_channel_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 32),
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);
    CREATE INDEX idx_gc_channel_categories_server ON gc_channel_categories(server_id);
    CREATE TABLE gc_channel_overwrites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
      category_id INTEGER NULL REFERENCES gc_channel_categories(id) ON DELETE CASCADE,
      role_id INTEGER NULL REFERENCES gc_roles(id) ON DELETE CASCADE,
      allow_mask INTEGER NOT NULL DEFAULT 0,
      deny_mask INTEGER NOT NULL DEFAULT 0,
      CHECK((channel_id IS NOT NULL OR category_id IS NOT NULL)
            AND (channel_id IS NULL OR category_id IS NULL)));
    INSERT INTO users (id) VALUES (2), (3);
    INSERT INTO gc_servers (id) VALUES (5);
    INSERT INTO gc_roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (1, 5, 'moderators', NULL, 0, 32, 900),
             (2, 5, '${"g".repeat(32)}', '#aa10f0', 1, 1024, 910);
    INSERT INTO gc_member_roles (server_id, user_id, role_id) VALUES (5, 2, 1);
    INSERT INTO gc_channel_categories (id, server_id, name, position, created_at)
      VALUES (1, 5, 'text folders', 0, 920);
    INSERT INTO gc_channels (id, server_id, created_at, category_id) VALUES (11, 5, 930, 1);
    INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask)
      VALUES (11, 1, 32, 0);
  `);
  return db;
}

function apply(db) {
  db.exec(MIGRATION);
}

test("the rebuild copies everything through: ids, links, and both widened bounds", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = OFF");
  apply(db);

  const roles = db
    .prepare("SELECT id, name, color, permissions FROM gc_roles ORDER BY id")
    .all()
    .map((r) => ({ id: Number(r.id), name: r.name, color: r.color, permissions: Number(r.permissions) }));
  assert.deepEqual(roles, [
    { id: 1, name: "moderators", color: null, permissions: 32 },
    { id: 2, name: "g".repeat(32), color: "#aa10f0", permissions: 1024 },
  ]);
  assert.deepEqual(
    db.prepare("SELECT id, name FROM gc_channel_categories ORDER BY id").all()
      .map((r) => ({ id: Number(r.id), name: r.name })),
    [{ id: 1, name: "text folders" }],
  );

  // Both widened bounds admit 100 characters and refuse 101.
  const roleInsert = db.prepare(
    "INSERT INTO gc_roles (server_id, name, created_at) VALUES (5, ?, 1000)",
  );
  roleInsert.run("r".repeat(100));
  assert.throws(() => roleInsert.run("s".repeat(101)));
  const categoryInsert = db.prepare(
    "INSERT INTO gc_channel_categories (server_id, name, created_at) VALUES (5, ?, 1000)",
  );
  categoryInsert.run("c".repeat(100));
  assert.throws(() => categoryInsert.run("d".repeat(101)));
  assert.equal(Number(db.prepare("SELECT MAX(id) AS m FROM gc_roles").get().m), 3,
    "the new role continues the sequence past the preserved ids");
  assert.equal(Number(db.prepare("SELECT MAX(id) AS m FROM gc_channel_categories").get().m), 2,
    "the new category continues the sequence past the preserved ids");

  // Both canaries leave with the rebuild: the applied file ends with exactly
  // the two original names plus the users/channels/servers hosts.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'gc_%'")
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(tables, [
    "gc_channel_categories",
    "gc_channel_overwrites",
    "gc_channels",
    "gc_member_roles",
    "gc_roles",
    "gc_servers",
  ]);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE '%rebuild%' OR name LIKE '%canary%'").get().c,
    0,
    "no canary or rebuild shell survives the apply",
  );

  // Children still resolve: FK clauses were never rewritten (a DROP rewrites
  // nothing; the final RENAMEs recreated the exact names they always named),
  // so new child rows referencing preserved ids insert cleanly — and the
  // existing assignment/overwrite rows' links stay exact.
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO gc_member_roles (server_id, user_id, role_id) VALUES (5, 3, 2)").run());
  assert.doesNotThrow(() =>
    db.prepare("INSERT INTO gc_channel_overwrites (category_id, role_id, allow_mask, deny_mask) VALUES (1, 1, 0, 0)").run());
  const rolesTargets = db
    .prepare("SELECT \"table\" FROM pragma_foreign_key_list('gc_member_roles')")
    .all()
    .map((r) => r.table);
  assert.ok(rolesTargets.includes("gc_roles"),
    `gc_member_roles still names gc_roles (targets: ${rolesTargets.join(", ")})`);
  const overwriteTargets = db
    .prepare("SELECT \"table\" FROM pragma_foreign_key_list('gc_channel_overwrites')")
    .all()
    .map((r) => r.table);
  assert.ok(overwriteTargets.includes("gc_roles") && overwriteTargets.includes("gc_channel_categories"),
    `gc_channel_overwrites still names both rebuilt parents (targets: ${overwriteTargets.join(", ")})`);
  db.close();
});

test("with FK enforcement on at apply time, a populated parent refuses loudly", () => {
  // The engine fires the children's CASCADE/SET-NULL actions on DROP (probed
  // on D1's engine 2026-11-17: a populated CASCADE parent drops cleanly and
  // silently prunes every referencing child row) — the RESTRICT canary row is
  // the lever that turns that into the refusal. The canary INSERT selects
  // MIN(id), so an empty parent leaves the canary empty and the rebuild
  // applies cleanly on any engine.
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(
    () => apply(db),
    undefined,
    "the RESTRICT-canary'd DROP of a populated referenced table must abort the apply, never cascade the children away",
  );
  // The aborted statement leaves the original parent intact: nothing was
  // pruned. (The real ledger rolls the whole file back — D1 verified; this
  // non-transactional in-memory pin only claims the parent row set.)
  const rows = db.prepare("SELECT COUNT(*) AS c FROM gc_roles").get().c;
  assert.equal(Number(rows), 2);
  db.close();
});

test("an empty parent applies cleanly even under FK enforcement (the empty canary is inert)", () => {
  const db = seed();
  db.exec("PRAGMA foreign_keys = ON");
  // The referencing child rows go first (the real engine would CASCADE the
  // first two DELETEs anyway; the explicit order keeps the sequence honest),
  // then the parent row sets — leaving both MIN(id) canary inserts empty.
  db.exec("DELETE FROM gc_channel_overwrites");
  db.exec("DELETE FROM gc_member_roles");
  db.exec("DELETE FROM gc_roles");
  db.exec("DELETE FROM gc_channel_categories");
  apply(db);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM gc_roles").get().c), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM gc_channel_categories").get().c), 0);
  const canaries = db
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE '%canary%'")
    .get().c;
  assert.equal(Number(canaries), 0, "both canaries leave with their rebuilds");
  db.close();
});
