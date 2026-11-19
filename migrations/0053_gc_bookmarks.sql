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

-- 0053 — bookmarks (lane2-lifecycle recode, 2026-11-18): ONE table's DDL,
-- nothing else (no shared-table edit, no ALTER, no FK, no seed). 0052
-- carried this lane's capsules table; 0053 is this lane's second ordinal
-- by the lead ruling (first-lane-claimed-wins: expression took 0050,
-- community took 0051; interactions and i18n ship no migrations).
-- Scar note: the rewrite-era 0038 created this exact table and the whole
-- 0029-0044 chain was ALREADY applied to the live shared wempo-forum-data
-- D1 (0045's header proves 0044 rode that chain), so on the live D1 this
-- migration is a NO-OP by design — CREATE ... IF NOT EXISTS never touches
-- the populated remote table, never drops, never renames. On any fresh
-- tree or local rebuild (where 0029-0044 never ran) the DDL lands here
-- whole, so the bookmark routes run against a floor that exists.
--
-- gc_bookmarks — a bookmark is a PRIVATE POINTER a member saves onto a
-- message: address columns ONLY (who saved it, which message, when). No
-- text copy, no snippet, no read-state flag, no note, no server_id (the
-- server arrives via the message's channel at read), and no auto rows
-- (defaults law: nothing exists until the member themselves saves). NO FK
-- anywhere by design: a deleted message leaves an orphan pointer the
-- owner's capped page carries as an UNCLASSIFIABLE pointer row — the
-- shipped list read (BOOKMARK_LIST_SQL in api/bookmarks.mjs) has NO join,
-- so nothing classifies or drops the orphan; the owner's list KEEPS it,
-- unsave stays the manual owner-scoped removal, and the wider
-- classification/clear-act is parked (T-PARITY-BOOKMARK-ORPHANS). No
-- CASCADE arm to reason about, no edit to any other table's write path,
-- and a wrong-owner unsave is indistinguishable from a wrong id (no
-- existence oracle either way). [header-truth fix 2026-11-19, c19 MED-3 —
-- the DDL is untouched; migration files are append-only law.]
CREATE TABLE IF NOT EXISTS gc_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gc_bookmarks_owner_message
  ON gc_bookmarks (owner_user_id, message_id);
