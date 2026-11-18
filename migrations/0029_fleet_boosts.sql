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
-- The gc_channels kind widening (0024's exact rebuild law: RESTRICT canary
-- filled only when the parent holds rows; ids copied explicitly; DROP the
-- original BY ITS OWN NAME; RENAME the copy over that name — the referencing
-- children are never rewritten; the 0001 index recreated verbatim; the
-- canary leaves with the rebuild).
-- ---------------------------------------------------------------------------

CREATE TABLE gc_channels_fk_canary_0029 (
  channel_id INTEGER NOT NULL REFERENCES gc_channels(id) ON DELETE RESTRICT
);
INSERT INTO gc_channels_fk_canary_0029 (channel_id)
  SELECT MIN(id) FROM gc_channels HAVING COUNT(*) > 0;

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

DROP TABLE gc_channels_fk_canary_0029;

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
