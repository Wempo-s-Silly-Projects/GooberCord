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

-- 0050 — time capsules (lane2-lifecycle recode, 2026-11-18): the ONE new
-- table, nothing else (CREATE-only: no shared-table edit, no ALTER, no seed,
-- no trigger). Not in the prod migration ledger per the port brief — the
-- table is new, and a plain CREATE is the honest witness: an apply against a
-- ledger whose table already exists fails loudly instead of guessing.
--
-- gc_time_capsules — one scheduled letter. channel_id NULL is the SELF-SEAL
-- (the letter rides to its author alone); a channel-targeted letter rides
-- the SAME channel VIEW/SEND gates the message send does, so no config table
-- and no toggle column here. There is NO revealed_at and NO deleted_at
-- column by law: the reveal state reads from reveal_at <= now at read time
-- (no timers, no cron, no lazy write-back), and deletion is the hard row
-- delete the author makes while the letter is still open — the postmark ends
-- the author's control, never the room's copy. The body bound mirrors the
-- message family's widest stored bound (0021's CHECK shape); the live
-- per-tier house cap rides the route arm, never this CHECK.
-- Both cascade FKs: the author's account and the target channel's death
-- take their letters with them.
CREATE TABLE gc_time_capsules (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  channel_id INTEGER NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  reveal_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_time_capsules_author ON gc_time_capsules(author_id, server_id);
CREATE INDEX idx_gc_time_capsules_channel ON gc_time_capsules(channel_id, reveal_at);
