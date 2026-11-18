-- 0034: Server Seasons (T84, docs/drafts/t84-server-seasons-spec.md §1) —
-- two small tables, nothing else (CREATE-only; no rebuild, no ALTER, no
-- backfill — a rebuild-class statement in this file is a STOP).
--
-- 1. gc_server_seasons — the mod-configured season row. The whole feature
--    is the explicit act of a mod creating THIS row (defaults law: no
--    season configured == no change — an empty table costs the live lanes
--    exactly nothing). `started_at` is set server-side at create time, so
--    the active window is a pure date-key comparison at read time:
--    active when now < started_at + week_count * GC_SEASON_WEEK_SECONDS
--    (no timers, no cron, no background writer ever). The color is an
--    enum of the EXISTING accent tokens (the slate: "a color accent on
--    the existing token set") — never raw hex from a client.
--
-- 2. gc_season_completions — the guarded completion seat. Its
--    PRIMARY KEY is the whole conservation story: the completion INSERT
--    rides ON CONFLICT (server_id, season_started_at) DO NOTHING inside
--    the same batch as the Campfire-pool credit statements (pool-first
--    80/20 per the sink law, splitting GC_SEASON_REWARD_COINS with the
--    shared pool-share percents), and the loser of a raced pair answers
--    changes 0 and mints nothing. The meter itself has NO table and NO
--    writer anywhere in the lane — it is a pure read-time aggregate over
--    the gc_messages + gc_message_reactions rows the server already has.
CREATE TABLE gc_server_seasons (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  color TEXT NOT NULL CHECK (color IN ('green','coral','yellow','blue')),
  goal INTEGER NOT NULL CHECK (goal BETWEEN 1 AND 100000),
  week_count INTEGER NOT NULL CHECK (week_count BETWEEN 1 AND 12),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, started_at)
);

CREATE TABLE gc_season_completions (
  server_id INTEGER NOT NULL,
  season_started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  FOREIGN KEY (server_id, season_started_at)
    REFERENCES gc_server_seasons(server_id, started_at) ON DELETE CASCADE,
  PRIMARY KEY (server_id, season_started_at)
);

CREATE INDEX idx_gc_server_seasons_server
  ON gc_server_seasons(server_id, started_at DESC);
