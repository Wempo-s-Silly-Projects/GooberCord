-- 0033: Goober of the Day (T83, docs/drafts/t83-goober-of-the-day-spec.md
-- §1) — three small tables, nothing else (no rebuild, no ALTER).
--
-- 1. gc_goober_votes — the per-server ballot. ONE vote per member per day
--    is the PRIMARY KEY itself, and the INSERT's ON CONFLICT DO NOTHING +
--    its changes verdict are the 409 answer. Rows deliberately carry voter,
--    votee, server, and the date key ONLY: the ballot mapping is NEVER a
--    read surface anywhere in the lane (anonymity through the window AND
--    after it — the tally is an aggregate, the CARD is the only reveal).
--
-- 2. gc_goober_optouts — the candidacy toggle (defaults law: default-in per
--    the slate, the toggle is the explicit act; per-server scoped). The
--    roll-over pick carries a NOT EXISTS arm against this table INSIDE its
--    SQL, so an opted-out member can never be painted even by votes already
--    cast.
--
-- 3. gc_goober_cards — one card per server per completed day, written
--    lazily on the first roll-over read (guarded ON CONFLICT DO NOTHING —
--    a racing pair of readers writes one card and both answer the same
--    winner). Roll-over is a pure date-key comparison at read time (no
--    timers, no cron). tagline is the winner's ONE FREE cosmetic slot (a
--    gift lane: nothing mints, nothing sinks); it ships empty and only the
--    currently-card member of the server may write it.
CREATE TABLE gc_goober_votes (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  day_key INTEGER NOT NULL,
  voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  votee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, day_key, voter_id)
);
CREATE INDEX idx_gc_goober_votes_day
  ON gc_goober_votes(server_id, day_key, votee_id);

CREATE TABLE gc_goober_optouts (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE gc_goober_cards (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  day_key INTEGER NOT NULL,
  winner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  votes_count INTEGER NOT NULL CHECK (votes_count >= 1),
  tagline TEXT NULL CHECK (tagline IS NULL OR length(trim(tagline)) BETWEEN 1 AND 64),
  PRIMARY KEY (server_id, day_key)
);
