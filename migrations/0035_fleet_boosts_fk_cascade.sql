-- 0035: the fleet-boosts FK fix (board row FK35) —
-- gc_fleet_boosts.forum_post_id gains ON DELETE CASCADE.
--
-- The finding (ecc-security, 2026-11-18, verified): 0029 shipped the
-- forum_target as a bare `REFERENCES posts(id)` — SQLite NO ACTION. The
-- forum hard-deletes post rows today (api/posts-write.mjs:444
-- POST_DELETE_SQL plus the staged-retry cleanups at :139/:217), so the first
-- boosted post deleted at the forum raises a runtime FK failure on the
-- DELETE and the route 500s. Cascade is the twin law's shape: the boost row
-- is the post's shadow (t64 §2 idiom, same as the author CASCADE), it dies
-- WITH its forum post, and the already-rendered card becomes an orphan whose
-- removal rides the parked GC mirror/retract sweep lane — the spec §2.2
-- amendment records that half.
--
-- SQLite cannot ALTER a foreign key, so this is the rebuild the 0029 file
-- itself taught: create-new → explicit-id copy → drop-old → rename. No
-- canary (nothing REFERENCES gc_fleet_boosts — verified across the tree), no
-- child-FK-AROUND machinery (the DROP is a child-table drop; its rows leave
-- with no one pointing at them), no backup tables. The index rides the old
-- table into the DROP and is recreated here VERBATIM (same columns, same
-- WHERE clause) after the rename. Both engine classes land identical states:
-- FK-off copies the rows and the restore steps never run (no restore steps
-- exist); FK-on re-derives every outgoing FK on the INSERT-copy against still
-- intact parent tables.
--
-- Single DDL copy verified 2026-11-18: migrations/ holds NO second copy of
-- the gc_fleet_boosts shape (no seeds, no schema mirrors) — 0029 is the only
-- prior shape and it is already ritual-applied remotely, which is why this
-- fix ships as a fix-forward 0035 instead of a 0029 amend.

CREATE TABLE gc_fleet_boosts_rebuild (
  id INTEGER PRIMARY KEY,
  forum_post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_title TEXT NOT NULL,
  thread_excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rendered_channel_id INTEGER NULL REFERENCES gc_channels(id) ON DELETE SET NULL,
  rendered_message_id INTEGER NULL REFERENCES gc_messages(id) ON DELETE SET NULL
  -- Unchanged deletion law elsewhere: the author CASCADE and the SET-NULL
  -- stamps ride exactly as 0029 shipped them; no pair CHECK exists before or
  -- after (the card's own SET-NULL action must stay able to fire).
);

INSERT INTO gc_fleet_boosts_rebuild
  (id, forum_post_id, author_id, thread_title, thread_excerpt, created_at,
   rendered_channel_id, rendered_message_id)
SELECT id, forum_post_id, author_id, thread_title, thread_excerpt, created_at,
       rendered_channel_id, rendered_message_id
FROM gc_fleet_boosts;

DROP TABLE gc_fleet_boosts;

ALTER TABLE gc_fleet_boosts_rebuild RENAME TO gc_fleet_boosts;

CREATE UNIQUE INDEX idx_gc_fleet_boosts_mirror_once
  ON gc_fleet_boosts(forum_post_id, rendered_channel_id)
  WHERE rendered_message_id IS NOT NULL;
