-- 0031: Time Capsules (T82, docs/drafts/t82-time-capsules-spec.md §1) — the
-- ONE new table, nothing else (no rebuild, no ALTER: the table is new).
--
-- gc_time_capsules — one scheduled letter. channel_id NULL is the SELF-SEAL
-- (the letter rides to its author alone); a channel-targeted letter rides
-- the SAME channel-overwrite layers the message send does (the desk allows
-- by not denying the author's SEND seat), so no config table and no toggle
-- column here. There is NO revealed_at and NO deleted_at column by law: the
-- reveal state reads from reveal_at <= now at read time (no timers, no
-- cron, no lazy write-back), and deletion is the hard row delete the author
-- makes while the letter is still open — the GDPR shape. Both FKs cascade:
-- the author's account and the target channel's death take their letters
-- with them.
CREATE TABLE gc_time_capsules (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  channel_id INTEGER NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  reveal_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_time_capsules_author ON gc_time_capsules(author_id, server_id);
CREATE INDEX idx_gc_time_capsules_channel ON gc_time_capsules(channel_id, reveal_at);
