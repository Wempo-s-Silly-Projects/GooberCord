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

-- 0050 — Soundboard Studio's pack tables (the expression port lane, owner
-- order 2026-11-18: "stay reverted, port everything"). Scar note: the
-- rewrite-era 0036 created these exact tables and the whole 0029-0044 chain
-- was ALREADY applied to the live shared wempo-forum-data D1 (0045's header
-- proves 0044 rode that chain), so on the live D1 this migration is a
-- NO-OP by design — CREATE TABLE IF NOT EXISTS never touches the populated
-- remote tables, never drops, never renames. On any fresh tree or local
-- rebuild (where 0029-0044 never ran) the DDL lands here whole, so the
-- soundboard-studio backend runs against a floor that exists.
--
-- Same contract as every sibling migration: every object gc_-prefixed and
-- additive only — applies cleanly right after 0045 (its only precondition).

CREATE TABLE IF NOT EXISTS gc_sound_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 2 AND 32
      AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
      AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_gc_sound_packs_server
  ON gc_sound_packs(server_id, created_at);

CREATE TABLE IF NOT EXISTS gc_sound_pack_sounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES gc_sound_packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 2 AND 32
      AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
      AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  upload_id TEXT NOT NULL,
  -- The 5 MB tier-caps floor: GC_SOUND_PACK_CLIP_MAX_BYTES (the clip cap is
  -- GC's own feature surface — the parity board's 512KB row is a separate
  -- contract, pinned in constants.mjs, untouched here).
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  mime TEXT NOT NULL CHECK (mime IN ('audio/mpeg', 'audio/ogg')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved')),
  added_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(pack_id, upload_id),
  UNIQUE(pack_id, name)
);

CREATE INDEX IF NOT EXISTS idx_gc_sound_pack_sounds_pack
  ON gc_sound_pack_sounds(pack_id, status);
