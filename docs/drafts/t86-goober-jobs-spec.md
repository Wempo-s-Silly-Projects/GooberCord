# T86 — Goober Jobs: weekly quests, pool-first mint (wave-4)

Spec for slate lane 5 (`docs/drafts/feature-slate-wave4-2026-11-18.md`): three quests per
server, rotated weekly, paying the Campfire pool FIRST and members second. RED rows:
`tests/goober-jobs-red.test.mjs` (fails today by construction — the GREEN lane implements to
them; extending the file's fake during GREEN is expected). No commit here; PROD-D1 FORBIDDEN.

## SINK LAW (front and center — the whole feature is a sink)

Every job finish is a mint, and every mint routes to the server's Campfire pool FIRST,
members second — the same pool the T76 slate landed in migration `0030_gc_economy.sql`
(`gc_campfires.pool`, CHECK pool >= 0, MIN-arm cap at GC_CAMPFIRE_MAX_POOL). Reuse, never
re-declare: the finish's pool credit rides
`campfirePoolCreditStatement(db, serverId, amount, now, fingerprint)` (api/campfire.mjs:160)
inside the finish batch — no new pool SQL, no second cap constant. Pool-first ordering is
part of the contract: the credit statement binds BEFORE any member payout in the same batch.

Cap arithmetic (the T62 sink analysis, /tmp/gc-economy-sim.md: baseline sink coverage 13.1%,
mint-side growth only survives if it rides a named sink): GC_JOB_FINISH_BONUS = 100 per
finish, 3 jobs/week → ≤ 300 coins/server/week minted, of which 80 % pools (≤ 240 pre-sunk)
and ≤ 60 circulate directly (~8.6/day/server, against a ~165/day/member mint — coverage-
neutral, the pool share RE-USES sunk capacity Campfire draws already budget). The member
share of a finish with zero online members burns into the pool (same credit statement, top-up
arm) — no finish ever mints 100 % to circulating balances.

## DDL (migration 0032_gc_server_jobs.sql — 0031 is the T82 time-capsules lane's
number; the chain runs 0030 → 0031 → 0032. No rebuild, every table new)

```sql
-- Opt-in state. Defaults law: enabled DEFAULT 0; nothing exists for a server
-- until a mod opts in. No per-server defaults, no cross-server inheritance.
CREATE TABLE gc_server_jobs (
  server_id INTEGER PRIMARY KEY REFERENCES gc_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);

-- Quest counters ONLY (the slate's privacy law). Aggregate, per-server, per
-- week, per activity kind; NEVER a member column, member row, or join key.
-- Counters count ACTIVITY, independent of the coin ceiling (a ceiling-capped
-- message is still a chore done).
CREATE TABLE gc_job_counters (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  week_key INTEGER NOT NULL,
  kind TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  PRIMARY KEY (server_id, week_key, kind)
);

-- The finish ledger: ONE row per finished job (the PK's week_key + job_id is
-- the double-fingerprint — a finish mint's INSERT arm refuses a second payout,
-- coins-style). paid_total records what the batch actually minted.
CREATE TABLE gc_job_finishes (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  week_key INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  paid_total INTEGER NOT NULL CHECK (paid_total = 100),
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, week_key, job_id)
);
```

**Job defs are CODE, not rows.** The def list lives in `api/jobs.mjs` as constants —
`{ id, titleKey, kind, goal }` with `titleKey` an i18n key (`gc.jobs.<id>`), never a stored
prose string (the no-copy sweep law: any DB-backed def would mint untranslated paint). Five
static defs:

| id | titleKey | kind (counter fed by) | goal |
|---|---|---|---|
| wash-day | gc.jobs.wash_day | message (posted in this server) | 250 |
| kindling | gc.jobs.kindling | voice (presence ticks in this server) | 60 |
| hearth-lights | gc.jobs.hearth_lights | reaction (adds in this server) | 100 |
| open-door | gc.jobs.open_door | join (new gc_server_members rows) | 5 |
| stoked | gc.jobs.stoked | stoke (Campfire stokes made) | 5 |

## Weekly rotation — server-seeded shuffle, deterministic

Pure function `pickJobs(serverId, weekKey)` in api/jobs.mjs: a mulberry32 PRNG seeded
`(server_id * 2654435761) ^ weekKey` rotates the static def list; the first
`GC_JOB_DEFS_PER_WEEK` = 3 defs are the week's jobs. Same server + same week → the same
three jobs on every read, every isolate, no stored state (the rotation is COMPUTED — the
server stores no rotation row; `gc_server_jobs` carries opt-in state only). A server's
week never changes mid-week; different weeks may differ but need not.

`week_key = floor(now / GC_JOB_WEEK_SECONDS) * GC_JOB_WEEK_SECONDS` (UTC epoch-week floor,
D1-friendly integer; GC_JOB_WEEK_SECONDS = 604800).

## Activity counters (the hooks are ride-alongs, minting-independent)

`recordJobProgress(env, serverId, kind, amount, now)` (exported, api/jobs.mjs): one upsert
`INSERT INTO gc_job_counters ... ON CONFLICT DO UPDATE counter = counter + ?` with
`counter + ? <= 1000000` sanity arm (no farm spiral; the goal arms make growth irrelevant past
the finish). Called by the paths that ALREADY observe the activity — no new tracker, no new
polling, no per-member attribution anywhere:

- messages (api/messages.mjs, after a fresh server-channel post; the idempotent-replay rule
  holds — replays were never fresh),
- voice (api/coins.mjs voice tick, server voice channel only),
- reactions (api/social.mjs add-reaction),
- joins (api/servers.mjs join INSERT path, changes = 1),
- stokes (api/campfire.mjs stoke route, changes = 1).

When the upserted counter crosses a pickJobs-selected def's goal, the SAME call evaluates the
finish (one batch: finishes INSERT arm = the fingerprint, campfirePoolCreditStatement pool
share, then the member share mint):

- **Pool first:** `MIN(100 * GC_JOB_POOL_SHARE_PERCENT / 100)` — 80 coins — credited via
  `campfirePoolCreditStatement` with fingerprint = the finishes INSERT's own arm.
- **Members second:** 20 coins split flat across the members ONLINE in this server at finish
  time (the Campfire draw's presence intersection — the count is a number; a member who was
  never in the server sees nothing). `floor(20 / online) >= 1` each; the rounding remainder
  and the whole share when zero members are online route INTO the pool (the same credit
  statement, a second top-up, still in the finish batch).
- Every payout row: `source = 'job_finish'`, `related_user_id = NULL`, per-member ledger
  rows only under the batch's pool arm — no per-member job rows survive (the counters table
  is the only state; it rolls over with the week's rows, deletable with the server).

## Routes (new module api/jobs.mjs, registered in worker.mjs API_HANDLERS)

- `GET /api/servers/:id/jobs` — members read:
  `{ enabled, weekKey, jobs: [{ id, titleKey, goal, counter, done }] }`. A not-opted-in
  server answers `{ enabled: false, jobs: [] }` (defaults law, not a 403 — the feature is
  simply absent). Painted strings ride `titleKey` ONLY — no prose in the payload.
- `POST /api/servers/:id/jobs/toggle` `{ enabled }` — the mod desk's server-config permission
  gate (same guard family as server settings, not a member route); writes the
  `gc_server_jobs` row. Nothing else in the fleet reads `enabled` (no global surface, no
  cross-server roll-up, no job digest on the side).
- Rate limits: `jobs:read` / `jobs:toggle` bindings, the established pattern.

## New constants (constants.mjs block, all capped, none parity)

| Constant | Value | Meaning |
|---|---|---|
| GC_JOB_FINISH_BONUS | 100 | total mint per finish |
| GC_JOB_POOL_SHARE_PERCENT | 80 | pool-first share (invariant: with member share total = 100) |
| GC_JOB_MEMBER_SHARE_PERCENT | 20 | online split; zero-online burns to the pool |
| GC_JOB_WEEK_SECONDS | 604800 | the week floor |
| GC_JOB_DEFS_PER_WEEK | 3 | the weekly rotation takes 3 |
| GC_JOB_GOAL_MESSAGES / VOICE / REACTIONS / JOINS / STOKES | 250 / 60 / 100 / 5 / 5 | def goals |
| GC_JOB_COUNTER_SANITY_CAP | 1000000 | the upsert's growth arm |

Cap note (T62): jobs' weekly mint ≤ 300/server with ≥ 80 % pool-first — the circulating
growth is ≤ 60/week/server, bounded by the sink it names; the member share's online-split
grows with the fire's own payout budget, not with the roster.

## RED rows shipped (tests/goober-jobs-red.test.mjs)

Constants row (existence + the 80/20 = 100 invariant); opt-in default row (`enabled: false,
jobs: []` without any mod call, then the toggle writes the row); rotation determinism row
(two GETs, one server, deep-equal 3-job array, titleKey-shaped); pool-first mint row (the
finish batch's pool credit carries 80 and binds BEFORE the member payouts); counter-scope row
(the 0032 DDL carries no member column on counters); t()-keys row (no prose keys in the
payload); zero-online burn row (unsplit member share routes into the pool); weekly
double-finish row (the finishes INSERT's PK arm refuses the second mint). All failing today
— RED by construction, GREEN lane implements to them.

— Level & Economy Designer, T86, 2026-11-18. Sources: slate lane 5; T76 spec + 0030 DDL;
api/campfire.mjs @ ca13009; /tmp/gc-economy-sim.md (T62).
