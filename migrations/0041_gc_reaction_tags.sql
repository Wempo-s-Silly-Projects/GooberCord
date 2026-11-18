-- 0041: Reaction tags (T89, docs/drafts/t89-reaction-tags-spec.md §5) — the
-- TWO new tables, nothing else (CREATE-only: no shared-table edit, no ALTER,
-- no FK, no trigger, no rollup, no leaderboard).
--
-- gc_server_reaction_tags — the mod's emoji→tag map: id, server_id, emoji,
-- tag_text, created_by, created_at. One row per emoji per server (the
-- UNIQUE pair IS the upsert's conflict target). tag_text is a locale-key
-- REFERENCE or a short server-native string (the tag text law, spec §6).
--
-- gc_reaction_tag_opts — the member side: the (tag_id, user_id) pair IS the
-- opt row (idempotence at the key), opted_at rides along. NO FK (the lane
-- ruling): a removed map row leaves an orphan opt row that the mine read's
-- JOIN naturally drops — no CASCADE arm to reason about, no edit to any
-- other table's write path.
CREATE TABLE gc_server_reaction_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  tag_text TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (server_id, emoji)
);
CREATE TABLE gc_reaction_tag_opts (
  tag_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  opted_at INTEGER NOT NULL,
  PRIMARY KEY (tag_id, user_id)
);
CREATE INDEX idx_gc_reaction_tags_server
  ON gc_server_reaction_tags (server_id);

