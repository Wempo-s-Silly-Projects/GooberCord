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

-- 0057 — the fx_burst effect flag (the 2026-11-19 cosmetics v1 slate,
-- Phase 3): ONE ALTER that adds the burst marker onto the reaction row the
-- equipped fx_burst pack's spend flags, so the reaction reads can echo the
-- burst to the client. No new table (the slate's "no new table" law rides),
-- no rename, no FK change — a plain ADD COLUMN on gc_message_reactions (the
-- migration shape 0003/0005/0017 pinned first), NOT NULL DEFAULT 0 so every
-- existing row reads unflagged and the read echoes stay additive.

ALTER TABLE gc_message_reactions ADD COLUMN fx_burst INTEGER NOT NULL DEFAULT 0;
