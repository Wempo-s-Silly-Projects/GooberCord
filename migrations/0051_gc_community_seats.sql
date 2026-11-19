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

-- 0051 — the community seats (the 2026-11-18 re-code wave). TWO CREATE-only
-- statements and one index: no rebuild, no ALTER, no touch on any existing
-- seat. 2026-11-19 lead amendment: the statements ship IF NOT EXISTS per the
-- wave law (0029-0044-era tables already exist on the live D1 — applying a
-- plain CREATE failed the ledger registration; shapes verified byte-identical
-- on prod). The campfire ledger deliberately gets NO statement here — the
-- books are an aggregate over the gc_coin_ledger rows the economy already
-- mints (0011), so a ledger table would be a second, driftable copy of
-- history the schema already stores.
--
-- gc_paper_configs — the Morning Paper's whole seat. The paper is DERIVED ON
-- REQUEST from rows the server already stores (gc_messages, the reaction
-- seat): there is NO paper-issues table, NO render cache, NO per-issue
-- persistence, and no history archive — "yesterday's paper" re-derives the
-- previous UTC day-key window the same way, so one config row per server
-- carries the entire feature. Absence of the row IS the off-state (defaults
-- law): no default row, no tombstone, no history — the DELETE is the whole
-- off-transition, and an untouched server answers every paper route with the
-- unconfigured 404 shape. Both FKs cascade: the server's death and the
-- enabling mod's account deletion take the seat with them, so the config can
-- never outlive its owners. enabled keeps the 0 arm for the upsert's
-- CHECK shape only — a 0 row is never written by the routes; the
-- off-transition is the hard delete.
CREATE TABLE IF NOT EXISTS gc_paper_configs (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id)
);

-- Month-day community anniversaries: one member, at most ONE month-day
-- anniversary — the PK IS the seat. The schema IS the privacy law (LIMIT
-- COLLECTION NOT ACCESS): MONTH+DAY and nothing else. There is no year
-- column and no anchored timestamp — the data a "member for N years"
-- computation needs does not exist and can never be derived on this seat; any
-- future migration adding one is rejected on its face. Month is 0-11 (the
-- UTC month index the celebrant join binds), day is 1-31 and STRUCTURAL
-- ONLY (no per-month day counts, no leap math — Feb 30 is stored verbatim
-- and simply never fires, because matching is pure (month, day) equality).
-- An account's death cascades the row away (no orphan, GDPR shape free of
-- charge: nothing to export).
CREATE TABLE IF NOT EXISTS gc_user_anniversaries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month   INTEGER NOT NULL CHECK (month IN (0,1,2,3,4,5,6,7,8,9,10,11)),
  day     INTEGER NOT NULL CHECK (day >= 1 AND day <= 31),
  PRIMARY KEY (user_id)
);

-- The celebrant read's only access path: the paper's join fires on the
-- server's members by (month, day).
CREATE INDEX IF NOT EXISTS idx_gc_user_anniversaries_month_day
  ON gc_user_anniversaries (month, day);
