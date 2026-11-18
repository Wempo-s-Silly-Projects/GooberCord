-- 0032: the Goober Jobs schema (docs/drafts/t86-goober-jobs-spec.md) — the
-- weekly quests. THREE CREATEs, no rebuild (every table new; 0031 is the
-- time-capsule lane's number — the chain runs 0030 → 0031 → 0032).
--
--   1. gc_server_jobs — the opt-in state. ONE row per server. Defaults law:
--      enabled DEFAULT 0 — nothing exists for a server until its owner opts
--      in, and no other surface reads this row (no global roll-up, no
--      digest).
--   2. gc_job_counters — the quest counters ONLY (the slate's privacy law):
--      aggregate per server / week / activity kind. NO member column, no
--      join key, no attribution anywhere — a counter row answers "the server
--      did this many", never "who did it". Counters count ACTIVITY,
--      independent of the coin ceiling (a ceiling-capped message is still a
--      chore done).
--   3. gc_job_finishes — the finish ledger. ONE row per finished job (the
--      PK is the double-finish fingerprint: a second finish INSERT for the
--      same server/week/job inserts nothing, and the finish batch's pool
--      credit rides the finishes EXISTS as its fingerprint — a lost race
--      banks nothing). paid_total is the batch's own conservation note.
--
--   Sink law rider (constants.mjs, GC_JOB_*): every finish mint routes to
--   the server's gc_campfires pool FIRST (credit rides
--   api/campfire.mjs's campfirePoolCreditStatement — reuse, no second cap)
--   and members only second; a finish with zero online members burns its
--   whole member share into the pool.

CREATE TABLE gc_server_jobs (
  server_id INTEGER PRIMARY KEY REFERENCES gc_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE gc_job_counters (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  week_key INTEGER NOT NULL,
  kind TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  PRIMARY KEY (server_id, week_key, kind)
);

CREATE TABLE gc_job_finishes (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  week_key INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  paid_total INTEGER NOT NULL CHECK (paid_total = 100),
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, week_key, job_id)
);
