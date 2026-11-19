-- Copyright 2026 ItsWempo
--
-- This file is part of GooberCord.
--
-- GooberCord is free software: you can redistribute it and/or modify it
-- under the terms of the GNU Affero General Public License as published by
-- the Free Software Foundation, either version 3 of the License, or
-- (at your option) any later version.
--
-- This program is distributed in the hope that it will be useful, but
-- WITHOUT ANY WARRANTY; without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
-- GNU Affero General Public License for more details.
--
-- You should have received a copy of the
-- GNU Affero General Public License along with this program.  If not,
-- see <https://www.gnu.org/licenses/>

-- 0055 — the five account-deletion FK gaps (audit-verified @ tree 58651d4).
-- Five audit sites make a user's own account deletion throw FOREIGN KEY
-- constraint failed and answer 500:
--   (1) gc_servers.owner_user_id  — NO ACTION pins the server row;
--   (2) gc_invites.created_by     — NO ACTION pins non-revoked invites;
--   (3) gc_filter_rules.created_by— NO ACTION pins the non-null rows;
--   (4) gc_server_bans.created_by — NO ACTION pins the non-null rows;
--   (5) the RESTRICT wall: gc_emoji/gc_stickers/gc_sounds.attachment_id ride
--       ON DELETE RESTRICT while gc_attachments.uploader_id CASCADEs, so the
--       uploader's attachment delete dies on their own expression rows.
-- SQLite cannot ALTER a FK clause, and the runner is FK-ENFORCING. Two
-- remote applies proved the rebuild-by-rename dance DEAD on a populated
-- parent: the first (2026-11-19, ledger top 0054) refused gc_servers' DROP
-- immediately (7500, SQLITE_CONSTRAINT_FOREIGNKEY) and rolled back
-- atomically (no *_rebuild leak); the second rode PRAGMA
-- defer_foreign_keys = ON (accepted on D1 today — 0024's internal-error
-- finding is stale) and still died at COMMIT: a pure-SQLite probe
-- (2026-11-19) reproduced the deferred COMMIT
-- refusal — the rename-restore window leaves children naming a vanished
-- parent, and deferral cannot rescue a parent that must not exist mid-file.
-- So gc_servers is rebuilt by the COLUMN dance instead (SQLite 3.35+,
-- probed enforcement-clean: ADD a NULLable FK column, carry the values with
-- UPDATE, DROP the NOT NULL column, rename it back). The table NAME never
-- moves — children resolve by the same name through every statement, no
-- parent DROP ever executes, and no implicit DELETE fires. The delta: the
-- owner column re-enters at the TAIL of the column order (same column set,
-- same checks, NULLable + SET NULL).
--
-- The six childless tables keep the create/copy/drop/rename dance:
-- gc_invites/gc_server_bans/gc_filter_rules/gc_emoji/gc_stickers/gc_sounds
-- are referenced by NO table, so their drops cannot strand a foreign key
-- (their own FKs point OUTWARD and vanish with their rows; the copies'
-- INSERT..SELECT references only parents that exist at that point).
--
-- The five treatments (byte-truth DDLs captured from the live shared
-- wempo-forum-data D1, 2026-11-19, via sqlite_master — NOT the 0xxx files;
-- the 0001/0004/0010/0008/0027-era shapes plus every later column add are
-- reproduced exactly):
--   (1) gc_servers.owner_user_id: NOT NULL SET NULL is illegal in SQLite, so
--       the column dance makes the column NULLable — INTEGER NULL
--       REFERENCES users(id) ON DELETE SET NULL (the accepted audit shape;
--       the app-side invariant stays: routes guard on owner_user_id = ? and
--       a NULL owner means an ownerless server, never a fabricated one).
--       The only INSERT path binds the authenticated actor's id — no route
--       can insert NULL.
--   (2) gc_invites.created_by: stays NOT NULL and becomes
--       REFERENCES users(id) ON DELETE CASCADE — deleting the creator
--       deletes their invites (an invite is not a user asset worth
--       surviving its author; making the creator NULLable instead would
--       change discovery's shape). Verify: the only INSERT path is
--       api/servers.mjs's INVITE_INSERT_SQL, which binds the authenticated
--       actor's id into created_by — no route can insert NULL.
--   (3)+(4) gc_filter_rules.created_by and gc_server_bans.created_by: both
--       already NULLable — the rebuild keeps NOT NULL off and rides
--       ON DELETE SET NULL.
--   (5) the three expression tables' attachment_id: ON DELETE RESTRICT ->
--       ON DELETE CASCADE — user death removes their expression rows
--       through the attachment cascade. This never deletes more than
--       today's manual delete path: an expression's attachment rides
--       message_id NULL (the caller's-own-attachment rule in api/emoji.mjs
--       and the soundboard intake), the shared-asset arms mean an
--       attachment already referenced by any expression or sound can never
--       START a new expression life, and the manual delete statements
--       (api/soundboard.mjs, api/emoji.mjs) only clear the attachment and
--       its chunks when NOTHING still references them — so a manual
--       expression delete behaves exactly as before, while the CASCADE arm
--       fires only where today's RESTRICT made the DELETE statement itself
--       500.
--
-- APPLY RITUAL (NAME-PRESENCE — per-table COUNT(*) + sqlite_master shape
-- compare BEFORE and AFTER; remote applies ride the full verify ritual, and
-- d1_migrations registration happens through the normal ledger flow):
--   BEFORE counts (captured 2026-11-19, tree 58651d4, remote):
--     gc_servers 3, gc_invites 2, gc_filter_rules 0, gc_server_bans 0,
--     gc_emoji 0, gc_stickers 0, gc_sounds 0.
--   AFTER: every table's COUNT(*) MUST EQUAL its BEFORE count (no row may
--   appear, vanish, or renumber); the sqlite_master shape compare must show
--   ONLY the intended FK-clause delta per rebuilt table (line-wrap on the
--   touched clause allowed) and the same named index set. For gc_servers
--   the allowed shape delta is wider by design: owner_user_id re-enters as
--   the LAST column, NULLable with ON DELETE SET NULL (the column dance
--   cannot splice a column mid-table), and idx_gc_servers_is_public is
--   untouched (its parent table name never moved). Whitespace/quoting is
--   normalized before judging deltas.

-- gc_servers: the four-statement column dance (probed enforcement-clean).
-- ADD is legal because the new column's implicit default is NULL; the
-- UPDATE carries every owner value across; DROP takes the NOT NULL column
-- and its NO ACTION FK away; RENAME restores the app-facing column name.
ALTER TABLE gc_servers ADD COLUMN owner_user_id_setnull INTEGER NULL REFERENCES users(id) ON DELETE SET NULL;
UPDATE gc_servers SET owner_user_id_setnull = owner_user_id;
ALTER TABLE gc_servers DROP COLUMN owner_user_id;
ALTER TABLE gc_servers RENAME COLUMN owner_user_id_setnull TO owner_user_id;

-- gc_invites: the one delta vs the live DDL is created_by's
-- ON DELETE CASCADE (NOT NULL stays — the only INSERT path binds the
-- authenticated actor's id, never NULL).
CREATE TABLE gc_invites_rebuild (
  code TEXT PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
, expires_at INTEGER NULL, max_uses INTEGER NULL, revoked_at INTEGER NULL
);
INSERT INTO gc_invites_rebuild
  (code, server_id, created_by, created_at, uses, expires_at, max_uses, revoked_at)
SELECT code, server_id, created_by, created_at, uses, expires_at, max_uses, revoked_at
FROM gc_invites;
DROP TABLE gc_invites;
ALTER TABLE gc_invites_rebuild RENAME TO gc_invites;
-- Dropped with the table; recreated verbatim after the rename.
CREATE INDEX idx_gc_invites_server ON gc_invites(server_id);

-- gc_server_bans: the one delta vs the live DDL is created_by's
-- ON DELETE SET NULL (the column is already NULLable).
CREATE TABLE gc_server_bans_rebuild (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NULL CHECK(reason IS NULL OR length(reason) <= 280),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
INSERT INTO gc_server_bans_rebuild
  (server_id, user_id, created_by, reason, created_at)
SELECT server_id, user_id, created_by, reason, created_at
FROM gc_server_bans;
DROP TABLE gc_server_bans;
ALTER TABLE gc_server_bans_rebuild RENAME TO gc_server_bans;

-- gc_filter_rules: the one delta vs the live DDL is created_by's
-- ON DELETE SET NULL (the column is already NULLable).
CREATE TABLE gc_filter_rules_rebuild (
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
  created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO gc_filter_rules_rebuild
  (id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions,
   is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at)
SELECT
  id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions,
  is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at
FROM gc_filter_rules;
DROP TABLE gc_filter_rules;
ALTER TABLE gc_filter_rules_rebuild RENAME TO gc_filter_rules;
-- Dropped with the table; recreated verbatim after the rename.
CREATE INDEX IF NOT EXISTS idx_gc_filter_rules_server ON gc_filter_rules(server_id, id);

-- gc_emoji: the one delta vs the live DDL is attachment_id's
-- ON DELETE RESTRICT -> ON DELETE CASCADE.
CREATE TABLE "gc_emoji_rebuild" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 32
    AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
    AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  attachment_id INTEGER NOT NULL
    REFERENCES gc_attachments(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);
INSERT INTO gc_emoji_rebuild
  (id, server_id, name, attachment_id, created_by, created_at)
SELECT id, server_id, name, attachment_id, created_by, created_at
FROM gc_emoji;
DROP TABLE "gc_emoji";
ALTER TABLE gc_emoji_rebuild RENAME TO gc_emoji;

-- gc_stickers: the one delta vs the live DDL is attachment_id's
-- ON DELETE RESTRICT -> ON DELETE CASCADE.
CREATE TABLE "gc_stickers_rebuild" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 30
    AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
    AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  attachment_id INTEGER NOT NULL
    REFERENCES gc_attachments(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);
INSERT INTO gc_stickers_rebuild
  (id, server_id, name, attachment_id, created_by, created_at)
SELECT id, server_id, name, attachment_id, created_by, created_at
FROM gc_stickers;
DROP TABLE "gc_stickers";
ALTER TABLE gc_stickers_rebuild RENAME TO gc_stickers;

-- gc_sounds: the one delta vs the live DDL is attachment_id's
-- ON DELETE RESTRICT -> ON DELETE CASCADE.
CREATE TABLE "gc_sounds_rebuild" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 2 AND 32
      AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
      AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  attachment_id INTEGER NOT NULL
    REFERENCES gc_attachments(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);
INSERT INTO gc_sounds_rebuild
  (id, server_id, name, attachment_id, created_by, created_at)
SELECT id, server_id, name, attachment_id, created_by, created_at
FROM gc_sounds;
DROP TABLE "gc_sounds";
ALTER TABLE gc_sounds_rebuild RENAME TO gc_sounds;
