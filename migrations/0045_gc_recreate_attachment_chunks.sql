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

-- 0045 — owner order 2026-11-18: revert to pre-rewrite. Migration 0044
-- dropped gc_attachment_chunks while the (now restored) legacy intake,
-- serving, and deletion batches speak it. Recreate the table in the exact
-- 0001/0014 shape so the restored worker runs against the live shared
-- wempo-forum-data D1. Starts empty on purpose: prod had 0 chunk rows and
-- 0 attachment rows at the 0044 apply (lead-verified 2026-11-18).
CREATE TABLE gc_attachment_chunks (
  attachment_id INTEGER NOT NULL REFERENCES gc_attachments(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 64000),
  PRIMARY KEY(attachment_id, seq)
);
