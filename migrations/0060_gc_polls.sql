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

-- 0060 — the channel polls (wave 26, W26-2). A poll is a MESSAGE TYPE:
-- one gc_polls row keyed to its message (message_id UNIQUE — one poll per
-- message, and the read arm's index), carrying the question (the message
-- body itself carries it too — the payload repeats it so the renderer is
-- self-contained), the option list as ONE JSON array (each option's text
-- is route-capped at constants.mjs's GC_POLL_OPTION_MAX, the count at
-- POLL_MAX_OPTIONS = 10 — the JSON column's length CHECK is the
-- envelope backstop), the single/multi-choice flag, and the close state
-- (closed_at/closed_by NULL until the creator closes — the close is a
-- plain UPDATE, the creator-only authority rides the statement's own
-- WHERE arm inside api/messages-polls.mjs; a closed poll can never be
-- un-closed by the route, so there is no reopen arm).
--
-- FK discipline (the D1 FK-runner law, 0059's precedent): ZERO foreign
-- keys — plain INTEGER columns + CHECKs only. A deleted message leaves
-- its poll row unread (a history read keys polls by LIVING message ids);
-- the row is inert history, never a live join arm.
--
-- The cap literals mirror the constants.mjs seats (SQL cannot import): a
-- question is 200 characters (GC_POLL_QUESTION_MAX), the option JSON's
-- envelope is 2048 bytes. tests/messages-polls-seam.test.mjs holds the
-- constants and these literals to each other.

CREATE TABLE IF NOT EXISTS gc_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE,
  channel_id INTEGER NOT NULL,
  question TEXT NOT NULL CHECK (length(question) <= 200),
  options_json TEXT NOT NULL CHECK (length(options_json) <= 2048),
  multiple INTEGER NOT NULL CHECK (multiple IN (0, 1)),
  closed_at INTEGER NULL,
  closed_by INTEGER NULL,
  created_at INTEGER NOT NULL
);
