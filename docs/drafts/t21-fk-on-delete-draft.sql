-- T21 DRAFT (NOT APPLIED): the GDPR FK-on-delete gap — SET NULL for the three
-- gc_ tables that carry a "who created this" users(id) FK with no ON DELETE
-- action, so deleting an active user 500s instead of softening the trail
-- (taskboard T21; the same ruling parked gc_servers.owner_user_id for the
-- owner — ownership can never be SET NULL on a NOT NULL column and needs a
-- transfer ruling, not a FK action).
--
-- Migrations apply ONLY under the FULL NAME-PRESENCE ritual (owner gate);
-- prod-D1 writes are DENIED to agents. Ledger: floor is 0028, so the three
-- drafts ship as migrations/0029, 0030, 0031 — split into one file per
-- number on adopt. Statement numbering inside each stays 0003-free (the
-- 0004 header's rule): these carry no ALTER TABLE gc_servers statements.
--
-- T21 preamble statement list (the user-delete preamble every affected
-- api/ module must state before touching users(id) rows) — the gc_ tables
-- that key on a user (user_id / created_by / owner_user_id):
--   gc_servers (owner_user_id — OWNER RULING, not here), gc_server_members,
--   gc_invites, gc_server_bans, gc_filter_rules, gc_filter_alerts,
--   gc_messages, gc_message_reactions, gc_mentions, gc_conversation_members,
--   gc_friends, gc_friend_requests,
--   gc_blocks, gc_social_prefs, gc_coin_ledger, gc_cosmetics,
--   gc_cosmetic_ownership, gc_plus_state, gc_emoji, gc_stickers, gc_sounds,
--   gc_server_boosts, gc_member_roles, gc_member_status, gc_upload_parts,
--   gc_attachments — plus the shared forum sessions/bans/blocks (GC reads
--   them read-only; the delete preamble belongs to the forum half).
--
-- The rebuild is the childless dance (0026/0027's discipline): no gc_ table
-- carries a REFERENCES gc_invites / gc_server_bans / gc_filter_rules FK
-- (gc_filter_alerts.rule_id and gc_server_members.created_by_invite are
-- plain values, no FK), so the drop cannot strand a foreign key; the FK-on
-- INSERT..SELECT either copies every row or the whole migration rolls back
-- atomically (a successful apply proves no row lost). gc_invites also
-- carries 0017's three ALTER-ed columns — the rebuild keeps them.

-- ===== 0029: gc_invites.created_by — SET NULL =====

CREATE TABLE gc_invites_rebuild (
  code TEXT PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NULL,
  max_uses INTEGER NULL,
  revoked_at INTEGER NULL
);
INSERT INTO gc_invites_rebuild (code, server_id, created_by, created_at, uses, expires_at, max_uses, revoked_at)
SELECT code, server_id, created_by, created_at, uses, expires_at, max_uses, revoked_at
FROM gc_invites;
DROP TABLE gc_invites;
ALTER TABLE gc_invites_rebuild RENAME TO gc_invites;
CREATE INDEX IF NOT EXISTS idx_gc_invites_server ON gc_invites(server_id);
-- 0029 note: the NOT NULL on created_by (0004) is dropped with the rebuild —
-- invites outlive their creator, NULL means the creator's account is gone.

-- ===== 0030: gc_server_bans.created_by — SET NULL =====

CREATE TABLE gc_server_bans_rebuild (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NULL CHECK(reason IS NULL OR length(reason) <= 280),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
INSERT INTO gc_server_bans_rebuild (server_id, user_id, created_by, reason, created_at)
SELECT server_id, user_id, created_by, reason, created_at
FROM gc_server_bans;
DROP TABLE gc_server_bans;
ALTER TABLE gc_server_bans_rebuild RENAME TO gc_server_bans;

-- ===== 0031: gc_filter_rules.created_by — SET NULL =====
-- Shape is 0027's rebuilt row (terms 65536, timeout 40320), not 0010's.

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
INSERT INTO gc_filter_rules_rebuild (
  id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions,
  is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at
) SELECT
  id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions,
  is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at
FROM gc_filter_rules;
DROP TABLE gc_filter_rules;
ALTER TABLE gc_filter_rules_rebuild RENAME TO gc_filter_rules;
CREATE INDEX IF NOT EXISTS idx_gc_filter_rules_server ON gc_filter_rules(server_id, id);
