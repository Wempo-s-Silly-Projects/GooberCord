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

-- 0051 — bookmarks (lane2-lifecycle recode, 2026-11-18): the ONE new table,
-- nothing else (CREATE-only: no shared-table edit, no ALTER, no FK, no
-- seed). Not in the prod migration ledger per the port brief; 0050 carried
-- this lane's capsules table, so the second table takes the next ordinal.
--
-- gc_bookmarks — a bookmark is a PRIVATE POINTER a member saves onto a
-- message: address columns ONLY (who saved it, which message, when). No
-- text copy, no snippet, no read-state flag, no note, no server_id (the
-- server arrives via the message's channel at read), and no auto rows
-- (defaults law: nothing exists until the member themselves saves). NO FK
-- anywhere by design: a deleted message leaves an orphan pointer the
-- owner's list read's JOIN-classification naturally drops — no CASCADE arm
-- to reason about, no edit to any other table's write path, and a
-- wrong-owner unsave is indistinguishable from a wrong id (no existence
-- oracle either way).
CREATE TABLE gc_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_bookmarks_owner_message
  ON gc_bookmarks (owner_user_id, message_id);
