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

-- 0054 — welcome cards (lane2-lifecycle recode, 2026-11-18): the era-0042
-- DDL reinstated for the FRESH tree, by the lead ruling ("0042
-- gc_welcome_cards EXISTS in the prod migration ledger" turned out to hold
-- for the LIVE ledger only — 0029-0044 are absent from this tree's
-- migrations/ because the revert took them, so a fresh D1 rebuild would
-- leave the table missing and the welcome-card routes would 500). The
-- columns byte-match the era commit c1b0b4a (migrations/0042 as it rode):
-- both-arms mod-gated upsert and the once-shown ledger are pinned against
-- exactly this shape.
--
-- Scar note (the lead's rationale): 0029-0044 are absent from the fresh
-- tree — fresh D1 must not 500. On the live shared wempo-forum-data D1,
-- era-0042 already created both tables, so this migration is a NO-OP by
-- design — CREATE ... IF NOT EXISTS never touches the populated remote
-- tables, never drops, never renames. On any fresh tree or local rebuild
-- the DDL lands here whole, so the welcome-card routes run against a floor
-- that exists. CREATE-only: no shared-table edit, no ALTER, no FK, no
-- seed, no index (the composite PK carries the ledger's read).
CREATE TABLE IF NOT EXISTS gc_welcome_cards (
  server_id INTEGER NOT NULL,
  blurb_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id)
);
CREATE TABLE IF NOT EXISTS gc_welcome_card_views (
  server_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  shown_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
