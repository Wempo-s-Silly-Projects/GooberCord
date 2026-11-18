-- 0038: Bookmarks (T88, docs/drafts/t88-bookmarks-spec.md §5) — the ONE new
-- table, nothing else (CREATE-only: no shared-table edit, no ALTER, no FK).
--
-- gc_bookmarks — the reading list's whole seat. A bookmark is a PRIVATE
-- POINTER a member saves onto a message: address columns ONLY (who saved it,
-- which message, when), no text copy, no snippet, no read-state flag, no
-- server_id (the server comes via the message join), no note, no auto rows
-- (defaults law: nothing exists until the member acts). NO FK anywhere (the
-- lane ruling): a deleted message leaves an orphan pointer that the read's
-- JOIN naturally drops — no CASCADE arm to reason about, no FK arm on any
-- other table's delete path.
CREATE TABLE gc_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_bookmarks_owner_message
  ON gc_bookmarks (owner_user_id, message_id);
