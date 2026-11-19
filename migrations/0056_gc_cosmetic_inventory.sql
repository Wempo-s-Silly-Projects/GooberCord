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

-- 0056 — the cosmetic inventory (the 2026-11-19 cosmetics v1 slate): ONE
-- table's DDL plus its equipped index, nothing else touched (0052
-- discipline — no shared-table edit, no ALTER, no seed, no trigger). The
-- equip state rides a column HERE instead of an ALTER on gc_cosmetics, so
-- the v1 surface (migration 0013) is never repatterned.
--
-- FK discipline (the 0053-0055 hazard law): BOTH FKs reference
-- referenced-name-stable parents — users and gc_servers — that no previous
-- migration renamed and NO later rename/rebuild rides this file. The arms
-- are both ON DELETE CASCADE by the account-deletion law: a user's death
-- takes the whole inventory (same shape as gc_cosmetic_ownership and the
-- capsule family), and a server's death takes its channel-banner row. The
-- runner is FK-enforcing; the DDL lands clean with FKs ON because it is
-- CREATE-only against fresh rows.
--
-- Shape notes (the slate's draft DDL, verbatim):
--   item_key / kind live in constants.mjs as the single source of truth
--   (the CHECK lists mirror them; clients import, never re-declare).
--   kind = 'own' rows hold qty = 1 forever (the CHECK floors at 0 and the
--   route-side arm enforces 1); kind = 'consumable' rows decrement via the
--   guarded-claim shape — a use that loses the race is all-zero + 409, the
--   original row survives (economy-skill law 3).
--   server_id is NULL for profile-scoped items (frames, effects); the
--   channel-banner row is per-server.
--   equipped = 1 marks the active item per slot; "one equipped per slot"
--   is enforced ROUTE-SIDE inside the equip transaction (set the picked
--   row, clear its slot siblings) — never by a trigger.
--   No deleted_at, no timers, no cron — uninstall is the hard row delete
--   (capsule law).
CREATE TABLE IF NOT EXISTS gc_cosmetic_inventory (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (item_key IN ('fx_burst_confetti', 'frame_gold', 'frame_neon', 'channel_banner_dusk')),
  kind TEXT NOT NULL CHECK (kind IN ('consumable', 'own')),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0),
  equipped INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  server_id INTEGER NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_gc_cosmetic_inventory_equipped
  ON gc_cosmetic_inventory(user_id, equipped);
