-- 0029: the T79 twin contract's schema half (docs/drafts/t79-post-boost-spec.md)
-- — the shared boost table + the announcement channel kind.
--
-- Two objects, one file:
--   1. gc_channels' kind CHECK widens: 'announcement' joins the
--      server-scoped kinds. The GC render route (api/boost.mjs) validates the
--      kind FIRST, before any row moves.
--   2. gc_fleet_boosts: the mirrored-boost ledger the forum's mint lane
--      inserts into (GC-owned name spelling — the scoping pin
--      tests/migration-scoping.test.mjs requires GC-created tables to be
--      gc_-prefixed; the forum mint's own IF NOT EXISTS copy carries the
--      identical shape in the forum ledger's next migration). Pending rows
--      (rendered_message_id NULL) await the consume render; the stamp pair
--      + the partial UNIQUE index make one boost render at most one card
--      per channel, so a replayed consume returns stamps, never a second
--      card. Deletion law rides the t64 §2 idiom: the author FK CASCADEs
--      (a deleted member's boosts die WITH the author, and their already
--      rendered cards die through gc_messages.author_id's own CASCADE), and
--      a deleted card/channel SET-NULLs its stamp — the boost falls back to
--      pending rather than ghosting.
--
-- The posts vendored copy: gc_fleet_boosts' forum_target REFERENCES
-- posts(id), and this ledger's own-chain fresh-DB apply needs the target to
-- exist (0002's vendored users/sessions set the exact precedent). On the
-- LIVE shared wempo-forum-data D1 the IF NOT EXISTS copy is a strict no-op —
-- the forum ledger owns posts' shape truth (forum 0034's posts_rebuild is
-- the canonical final-form source below, copied verbatim); this copy exists
-- ONLY so a forum-free rebuild DB can apply the GC chain.

-- ---------------------------------------------------------------------------
-- The gc_channels kind widening — the 2026-11-18 prod-refusal law.
--
-- The rebuild used to ride 0024's canary law: a one-row RESTRICT child
-- filled only when the parent held rows, meant to refuse a populated DROP
-- loudly on an FK-enforcing runner. The prod run falsified the law's
-- premise (T79's "D1's migrator does not enforce FKs during DDL"): applying
-- through `pnpm run db:migrate:remote` FAILED at `DROP TABLE gc_channels`
-- with `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_TRIGGER`, 15
-- channel rows and child rows present, apply atomically rolled back. D1's
-- engine ENFORCES FKs during DDL, and the enforcement runs FK ACTIONS at the
-- DROP's implicit DELETE — the canary's RESTRICT was the refusal.
--
-- Measured on the SAME engine class (local D1 via wrangler --local, 2026-11-18,
-- schema through 0028 + seeded rows, exact prod refusal reproduced first):
--   - PRAGMA defer_foreign_keys = true is DISQUALIFIED twice over: with the
--     canary present the batch dies at COMMIT as workerd "internal error"
--     (the deferred check meets gc_attachments' NO ACTION message FK pointing
--     at cascade-pruned parent rows — the same "internal-errors" note 0024
--     carried), and canary-less it COMMITS with every CASCADE child pruned
--     at the DROP's implicit DELETE (deferral defers the check, never the
--     actions — verified: messages gone, channels restored).
--   - So the only pattern that ACTUALLY works under FK-on apply WITH rows is
--     the child-FK-AROUND rebuild: the transitive closure of tables that die
--     from the parent DROP rides out into gc_-prefixed backup copies BEFORE
--     the DROP and rides back AFTER the rename:
--       direct gc_channels children (all CASCADE at floor 0028):
--         gc_messages, gc_conversation_members, gc_channel_overwrites,
--         gc_filter_alerts
--       gc_messages' own children (their parents die with the channels):
--         gc_mentions, gc_message_reactions (both CASCADE), and
--         gc_attachments whose message FK is NO ACTION on a NULLable column
--         (the rows survive the prune but would dangle — they are detached
--         before the DROP and re-attached from their own backup after it).
--   - The restore is INSERT OR IGNORE FROM the backup: an FK-on engine
--     pruned the rows, so every row returns once; an FK-ignoring engine
--     never pruned them (the old engine class), so the IGNORE makes the
--     restore a verified no-op instead of a duplicate — the file lands the
--     SAME final state on both classes. Ids are preserved both directions
--     (SELECT * copies carry the original values; the rebuild copies ids
--     explicitly), AUTOINCREMENT counters ride explicit id restores up
--     again, and the backup tables are dropped with the batch itself.
--   - The canary is GONE: its loud-refusal lever is precisely what refused
--     the prod apply. The guards are the backups themselves — rows ride out
--     and back, and a failed statement rolls the whole file back atomically
--     (the same proven property the 0024 wave pinned).
-- ---------------------------------------------------------------------------

CREATE TABLE gc_messages_bak_0029 AS SELECT * FROM gc_messages;
CREATE TABLE gc_mentions_bak_0029 AS SELECT * FROM gc_mentions;
CREATE TABLE gc_message_reactions_bak_0029 AS SELECT * FROM gc_message_reactions;
CREATE TABLE gc_conversation_members_bak_0029 AS SELECT * FROM gc_conversation_members;
CREATE TABLE gc_channel_overwrites_bak_0029 AS SELECT * FROM gc_channel_overwrites;
CREATE TABLE gc_filter_alerts_bak_0029 AS SELECT * FROM gc_filter_alerts;
CREATE TABLE gc_attachments_bak_0029 AS SELECT * FROM gc_attachments;

UPDATE gc_attachments SET message_id = NULL;

-- ---------------------------------------------------------------------------
-- The posts vendored copy (moved below the backups unchanged).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4750),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER,
  edited_at INTEGER,
  board TEXT NOT NULL DEFAULT 'general',
  view_count INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  idempotency_key TEXT,
  idempotency_fingerprint TEXT,
  staged_at INTEGER,
  suggestion_status TEXT
    CHECK (suggestion_status IS NULL OR suggestion_status IN ('resolved', 'declined')),
  suggestion_decided_by INTEGER,
  suggestion_decided_at INTEGER
);

-- ---------------------------------------------------------------------------
-- The 0024 rebuild law minus the canary: create the NEW table with the
-- widened kind CHECK, copy rows with ids explicit, DROP the original BY ITS
-- OWN NAME (whatever FK class prunes at the DROP meets empty-handed backups
-- holding the closure), RENAME the copy over that name — the referencing
-- children are never rewritten; the 0001 index recreated verbatim.
-- ---------------------------------------------------------------------------

CREATE TABLE gc_channels_rebuild (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NULL REFERENCES gc_servers(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100) DEFAULT 'dm',
  -- The single delta from 0001: 'announcement' joins the server-scoped kinds.
  kind TEXT NOT NULL CHECK(kind IN ('text','voice','dm','group','announcement')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_message_id INTEGER NULL,
  last_message_at INTEGER NULL,
  is_spoiler INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER NULL REFERENCES gc_channel_categories(id) ON DELETE SET NULL,
  slowmode_seconds INTEGER NOT NULL DEFAULT 0,
  icon_media_id INTEGER NULL,
  CHECK((kind IN ('dm','group') AND server_id IS NULL)
        OR (kind IN ('text','voice','announcement') AND server_id IS NOT NULL))
);

INSERT INTO gc_channels_rebuild
  (id, server_id, name, kind, position, created_at,
   last_message_id, last_message_at, is_spoiler, category_id,
   slowmode_seconds, icon_media_id)
SELECT id, server_id, name, kind, position, created_at,
       last_message_id, last_message_at, is_spoiler, category_id,
       slowmode_seconds, icon_media_id
FROM gc_channels;

DROP TABLE gc_channels;

ALTER TABLE gc_channels_rebuild RENAME TO gc_channels;

CREATE INDEX idx_gc_channels_server ON gc_channels(server_id, position);

-- ---------------------------------------------------------------------------
-- The restore: parents before their children, IGNORE-guarded both ways.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO gc_messages SELECT * FROM gc_messages_bak_0029;
INSERT OR IGNORE INTO gc_mentions SELECT * FROM gc_mentions_bak_0029;
INSERT OR IGNORE INTO gc_message_reactions SELECT * FROM gc_message_reactions_bak_0029;
INSERT OR IGNORE INTO gc_conversation_members SELECT * FROM gc_conversation_members_bak_0029;
INSERT OR IGNORE INTO gc_channel_overwrites SELECT * FROM gc_channel_overwrites_bak_0029;
INSERT OR IGNORE INTO gc_filter_alerts SELECT * FROM gc_filter_alerts_bak_0029;

-- The attachments' NO ACTION message FK is re-attached from the backup by id.
UPDATE gc_attachments SET message_id =
  (SELECT b.message_id FROM gc_attachments_bak_0029 b WHERE b.id = gc_attachments.id);

DROP TABLE gc_messages_bak_0029;
DROP TABLE gc_mentions_bak_0029;
DROP TABLE gc_message_reactions_bak_0029;
DROP TABLE gc_conversation_members_bak_0029;
DROP TABLE gc_channel_overwrites_bak_0029;
DROP TABLE gc_filter_alerts_bak_0029;
DROP TABLE gc_attachments_bak_0029;

-- ---------------------------------------------------------------------------
-- gc_fleet_boosts
-- ---------------------------------------------------------------------------

CREATE TABLE gc_fleet_boosts (
  id INTEGER PRIMARY KEY,
  forum_post_id INTEGER NOT NULL REFERENCES posts(id),
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_title TEXT NOT NULL,
  thread_excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rendered_channel_id INTEGER NULL REFERENCES gc_channels(id) ON DELETE SET NULL,
  rendered_message_id INTEGER NULL REFERENCES gc_messages(id) ON DELETE SET NULL
  -- No pair CHECK between the stamps: the card's deletion SET-NULLs
  -- rendered_message_id while rendered_channel_id (its own FK, a live
  -- channel) stays — a both-or-neither CHECK would refuse every card delete
  -- at its own action (the 0029 scoping pin found exactly that while
  -- probing). Pending stays defined as rendered_message_id IS NULL; the
  -- surviving channel stamp names the boost's render target.
);

-- One boost renders at most one card into one channel: the partial index
-- pins the rendered rows only, so a pending row never races its own index.
CREATE UNIQUE INDEX idx_gc_fleet_boosts_mirror_once
  ON gc_fleet_boosts(forum_post_id, rendered_channel_id)
  WHERE rendered_message_id IS NOT NULL;
