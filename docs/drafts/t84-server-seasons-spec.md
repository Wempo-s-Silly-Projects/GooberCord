# T84 — Server Seasons spec

Wave-4 lane 3 (slate: `docs/drafts/feature-slate-wave4-2026-11-18.md` §3, rows
27-32). Branch `fleet-wave-2026-11-18`. Spec + RED only in this lane:
`tests/server-seasons-lane.test.mjs` (RED today by construction — `api/
seasons.mjs`, the constants' season block, and the worker registration do not
exist; the file's first statement fails on the import — that IS the raw RED
error and the GREEN seed).

Identity: the server has a calendar.

## 1. The seat (two small tables, nothing else)

`migrations/0034_gc_server_seasons.sql` (created in this lane) is the
load-bearing DDL and wins any conflict; its shape in brief:

- **gc_server_seasons — the mod-configured season row.** One row per season,
  PK (server_id, started_at). `started_at` is set SERVER-SIDE at create time
  (never client-supplied), so the active window is a pure date-key comparison
  at read time: active while `now < started_at + week_count *
  GC_SEASON_WEEK_SECONDS` — no timers, no cron, no background writer. The
  color is an enum of the EXISTING accent tokens (`green | coral | yellow |
  blue` — the slate: "a color accent on the existing token set"); it is
  painted as `var(--<token>)` and never raw hex from a client. `created_by`
  FKs `users(id)`; every string is bound through the CHECKs.
- **gc_season_completions — the guarded completion seat.** PK (server_id,
  season_started_at), FK CASCADE into the season's composite key. Its PK is
  the whole conservation story: the completion INSERT rides
  `ON CONFLICT (server_id, season_started_at) DO NOTHING` inside the SAME
  batch as the finish's Campfire-pool credit statements, and the loser of a
  raced pair of completers answers changes 0 and mints nothing.
- **The meter has NO table and NO writer.** It is a pure read-time aggregate
  over the activity the server already has: member-authored `gc_messages`
  joined through `gc_channels` (the channel row is the ONLY server seat a
  message carries, so the join IS the per-server scope) plus
  `gc_message_reactions` on those messages, both bounded by the season
  window (`created_at >= started_at AND < started_at + week_count * week)`.
  Contribution is by activity the server already has — never by a new
  tracker; nothing in the message/reaction lanes learns this feature exists.

## 2. API surface (all `requireUser`, all rate-limited, member-gated 404)

- `GET /api/servers/:serverId/seasons/current` — the season a member sees.
  Shape: `{ season: { name, color, goal, weekCount, startedAt, endsAt,
  createdBy } | null, meter: number | null, completed: boolean }`. With no
  season row for THIS server the ONLY statement fired is the current-season
  lookup (`ORDER BY started_at DESC LIMIT 1`) and the answer is
  `{ season: null, meter: null, completed: false }` — no season configured
  == no change, nothing default-on. An EXPIRED latest season is answered
  once more in its ended shape: the first read past the window fires the
  completion batch (completion INSERT + pool-credit statements) if the
  aggregate reached the goal — the meter's verdict is computed from the same
  pure aggregate, so re-reads are idempotent (`changes 0` → no second mint).
- `POST /api/servers/:serverId/seasons` `{ name, color, goal, weeks }` —
  the mod's opt-in act (owner-role arm, same pinned
  `SELECT role FROM gc_server_members` gate shape as the roles lanes, 403 on
  a member, 404 on a non-member). Refusals: an UNEXPIRED season already
  active (409 — overlap is refused, not silently extended), a name outside
  1..64 trimmed (400), a color outside the token enum (400), a goal outside
  1..GC_SEASON_METER_GOAL_MAX (400), weeks outside 1..GC_SEASON_MAX_WEEKS
  (400). `startedAt`/`createdAt` are server-side; the client sends none of
  them.
- `DELETE /api/servers/:serverId/seasons/current` — the mod ends the
  season early (owner-role arm). The season row dies; completions CASCADE
  with it. Burn shape: NOTHING mints — no credit statement exists on this
  path at all; an ended-early season is burned, not paid.
- NO other routes on this lane: no member-contribution list, no leaderboard,
  no cross-server anything, no season history read (the CURRENT-or-just-
  ended season is the only season a route answers). Route registration rides
  worker.mjs's API_HANDLERS at GREEN (`handleSeasonRoutes`, the dispatch-
  chain position directly after the jobs family
  `handleJobsRoutes`), plus migration 0034 (next free number — 0033 is
  T83's, applied).

## 3. Laws (this lane's version)

- **Sink law — the meter mints, so the sink is named: pool-side first.** The
  finish reward `GC_SEASON_REWARD_COINS = 250` splits 80/20 with the SHARED
  constants `GC_JOB_POOL_SHARE_PERCENT` / `GC_JOB_MEMBER_SHARE_PERCENT`
  (the Campfire-pool split is ONE law, ONE declaration — the caps law
  forbids re-declaring it under season names); the pool credit binds FIRST
  in the batch through the shared `campfirePoolCreditStatement` helper
  (api/campfire.mjs:161), exactly the order api/jobs.mjs:192-207 already
  enforces. `poolShare = 200`, `memberShare = 50`; the member share rides
  the same online-split idiom as the jobs finish, and its unsplit remainder
  burns into the pool.
- **Defaults law**: opt-in by mod action, never default-on. The only writer
  of a season row is the mod's POST; an empty table costs the live lanes
  exactly nothing; the meter aggregates only inside a configured window.
- **No timers**: active/expired/completion are pure date-key comparisons at
  read time (no setTimeout/setInterval/cron in the module — pinned).
- **No new tracker**: the meter is the read-time SQL aggregate of §1; zero
  per-member rows, zero counter tables, and `api/messages.mjs` / `api/jobs.mjs`
  import nothing from `api/seasons.mjs` (both pins are in the RED file).
- **Per-server visibility ONLY**: every statement's server seat rides the
  season row's `server_id` (and the channel join for the meter); no
  statement aggregates across servers; no global ranking route exists.
- **Caps from constants.mjs, never re-declared:**
  | Constant | Proposed | Meaning |
  |---|---|---|
  | GC_SEASON_WEEK_SECONDS | 604800 | the season week unit |
  | GC_SEASON_MAX_WEEKS | 12 | the season's length cap |
  | GC_SEASON_NAME_MAX | 64 | the season's name bound |
  | GC_SEASON_METER_GOAL_MAX | 100000 | the goal's sanity ceiling |
  | GC_SEASON_REWARD_COINS | 250 | the finish reward (sinks pool-first 80/20) |
  | GC_SEASON_COLOR_TOKENS | ['green','coral','yellow','blue'] | the accent-token enum |
  | (reused) GC_JOB_POOL_SHARE_PERCENT / GC_JOB_MEMBER_SHARE_PERCENT | 80 / 20 | the shared Campfire split |
- **No-copy sweep (all painted strings ride t() keys):** the client paints
  every season string through keys this spec pins for the locale lanes —
  `gc.seasons.title`, `gc.seasons.none`, `gc.seasons.start` (the mod's
  create button), `gc.seasons.name`, `gc.seasons.color`, `gc.seasons.goal`,
  `gc.seasons.weeks`, `gc.seasons.meter` ("{{count}} of {{goal}}"),
  `gc.seasons.done` (the completed banner), `gc.seasons.ended`,
  `gc.seasons.reward`, `gc.seasons.startedBy`, `gc.seasons.endEarly`,
  `gc.seasons.errorTaken`, `gc.seasons.errorName`, `gc.seasons.errorColor`,
  `gc.seasons.errorGoal`, `gc.seasons.errorWeeks`, plus the color names
  `gc.seasons.colors.green/coral/yellow/blue` (22 keys; the i18n scheme law
  bans underscores, hence camelCase). No painted string appears raw in any
  client bundle (the no-copy sweep law); keys land in
  `public/locales/en.json` and the CARVE_GATES discipline at GREEN.
- D1-only, vanilla imperative, AGPLv3 header, no third-party anything.

## 4. RED rows delivered (tests/server-seasons-lane.test.mjs)

1. constants row — the six GC_SEASON_* deltas at their exact values, plus
   the negative pins that no `GC_SEASON_POOL_SHARE` / `GC_SEASON_MEMBER_
   SHARE` re-declaration sneaks into constants.mjs; flips when the constants
   block lands (currently ERR_MODULE_NOT_FOUND on the import).
2. sink law — the finish's exact 200/50 split, `campfirePoolCreditStatement`
   present, and the completion INSERT's
   `ON CONFLICT (server_id, season_started_at) DO NOTHING` arm (the
   once-per-season PK — a raced double-completion mints once).
3. no new tracker — the meter SQL reads through gc_channels +
   gc_message_reactions (existing tables), and both api/messages.mjs and
   api/jobs.mjs import NOTHING from api/seasons.mjs (no event hook, no
   counter bump in the live lanes).
4. defaults law — the current-season lookup is a named pinned SQL
   (`CURRENT_READ_SQL`) that INSERTs nothing; the seasonless server fires
   only that lookup.
5. mod gate — the create + end routes carry the pinned
   `SELECT role FROM gc_server_members` arm (owner-role gate, 403 on
   members, 404 on non-members).
6. CREATE-only migration — every 0034 statement parses to
   `CREATE (TABLE|INDEX)`; an INSERT/UPDATE/DELETE/ALTER/DROP anywhere in
   the file is the rebuild-class STOP.
7. conservation shapes — no setTimeout/setInterval in the module (no
   timers), `GC_SEASON_WEEK_SECONDS` referenced (pure window arithmetic),
   no leaderboard/global route surfaces, no `/api/seasons/leaders` shape.
8. route registration — `handleSeasonRoutes` imported in worker.mjs and
   positioned AFTER the jobs family in API_HANDLERS.

— Backend lane, T84, 2026-11-18. Sources: feature-slate wave-4 §3 (rows
27-32); the T86 pool-first finish idiom (api/jobs.mjs:192-207) and the T83
spec/RED exemplar (docs/drafts/t83-goober-of-the-day-spec.md).
