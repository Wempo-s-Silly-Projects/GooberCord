-- Copyright 2026 YourLocalGoober
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

-- 0061 — the channel polls' votes (wave 26, W26-2, gc_polls's 0060 pair).
-- ONE vote claim per member per poll — the UNIQUE(poll_id, user_id) floor
-- is the whole claim: the vote arm's changeable-vote UPDATE rides the
-- upsert's conflict arm (excluded.choices_json), so a member's second cast
-- REPLACES their claim in-statement (never a second row, never a double
-- tally), and the one-row-per-member shape IS the one-vote-per-user-per-poll
-- law at the schema level. The row's choices ride ONE JSON array of option
-- indexes (a single-choice poll stores a one-element array — the ROUTE's
-- intake pins single/multi: a single-choice ballot is refused with more
-- than one index, so the schema carries no per-poll choice-count column);
-- indexes are validated at the intake against the live option list (the
-- JSON column's length CHECK is the envelope backstop, 64 bytes seats the
-- ten-option maximum).
--
-- FK discipline (the D1 FK-runner law, 0059's precedent): ZERO foreign
-- keys — plain INTEGER columns + CHECKs only. A closed and emptied poll's
-- votes are inert history, never live join arms; no member death (or poll
-- death) removes them by cascade today (no FK exists to carry one).
-- UNIQUE(poll_id, user_id) also serves the tally read's poll_id prefix
-- (the 0060 table needs no extra index).

CREATE TABLE IF NOT EXISTS gc_poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  choices_json TEXT NOT NULL CHECK (length(choices_json) <= 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (poll_id, user_id)
);
