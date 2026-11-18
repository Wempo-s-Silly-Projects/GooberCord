# T87 — The Morning Paper spec

Wave-4 lane 6 (slate: `docs/drafts/feature-slate-wave4-2026-11-18.md`). Branch
`fleet-wave-2026-11-18`. Spec only in this lane (RED rides the next lane turn
if the owner gates are answered — no test file shipped here).

Identity: the server writes its own journal. The paper is the server
reading ITS OWN rows back, formatted — not surveillance, not profiling, not
a leaderboard.

Through-line: the paper is DERIVED ON REQUEST from data the server already
stores (messages, threads, capsule seals). It mints nothing new, tracks
nothing new, and answers nothing about members as individuals — it is a
synthesis pass over the day's public ledger, delivered only to the server
that asked, only while a mod keeps it turned on.

## 1. User stories

- As a mod, I turn the paper ON for my server (explicit act, defaults law)
  and pick a delivery window; until I do, the surface does not exist for my
  server.
- As a mod, I turn the paper OFF at any time — mid-cycle off means the next
  pull answers 404-shape "no paper configured" and nothing is stored.
- As a member, I open the paper for TODAY and read the wrap: message count
  by channel for the day, the day's most-active public threads, and any
  capsule seals whose reveal date landed today — nothing about me
  individually.
- As a member of an empty or brand-new server, I see an honest empty page:
  "no activity today" sections rendered as empty states, never as errors
  and never as invented filler.
- As a member of a server with ZERO activity in the window, I get a paper
  whose every section is empty; a paper with nothing in it is still a
  valid, complete page (the journal exists even on quiet days).
- As a member, I can read YESTERDAY's paper (the most recent completed
  window) — a bounded history of the paper itself ONLY, no per-member
  history surface, no cross-server anything.
- As a capsule sender, I see my due-today seal carried in the paper as a
  reveal-due row — the seal body itself is NOT printed in the paper (the
  capsule's own route is the only body reader, T82 law carries).

## 2. Acceptance criteria

- [ ] No gc_paper statement exists outside a WHERE carrying the server seat;
      no global or cross-server paper read exists.
- [ ] The ON/OFF toggle is mod-gated, explicit, and default-OFF for every
      server (defaults law) — an untouched server answers every paper
      route with the 404 shape and the dispatch fires ZERO gc_paper
      statements.
- [ ] The read is pure: the paper is computed at request time from
      existing rows (`gc_messages`, thread seats, `gc_capsules`) with
      bounded windows; NO background writer, NO cron, NO new activity
      tracker is created (T83's no-timers idiom).
- [ ] Every window bound is a named constant; no magic hour/day numbers in
      route code.
- [ ] No DM data, no presence rows, no per-member rollups anywhere in the
      paper shape; the paper's GROUP BY keys are server/day/channel/thread
      only.
- [ ] The capsule section names reveal-DUE seals only (id + due day + sender
      handle per T82's paint rules); it never carries a sealed body.
- [ ] Off-transition mid-cycle: after a toggle-OFF, paper reads answer the
      unconfigured shape; the config row deletes; nothing else persists.
- [ ] Every painted string rides t(); the en bundle ships all keys, non-en
      fills ride CARVE_GATES or stay en-only until ratified.
- [ ] Suite rides the isolated-worktree bind at the pushed SHA.

## 3. Edge-case checklist

- **Empty server** (no members beyond creator): every section answers its
  empty state; the page still serves (a configured server with nothing to
  report is VALID, not an error).
- **Digest with zero activity**: the zero-activity shape —
  `{ sections: { channels: [], threads: [], capsules: [] }, activityRows: 0 }`
  — serves verbatim; no section is dropped, no filler synthesized, no
  "highlights" invented from silence.
- **Opt-out toggled OFF mid-cycle**: the config row delete takes effect on
  the NEXT read (reads check config INSIDE their WHERE); an in-flight
  render completes on its already-read rows; nothing is retained (the
  config delete is the whole off-state — no tombstone, no history).
- **Timezone anchoring**: v1 anchors the day key to UTC
  (`nowSeconds() - now % GC_PAPER_DAY_SECONDS`, the T83 day-key idiom);
  the window label in the paper states UTC. A server-local anchor needs an
  owner-gated per-server tz field — PARKED (owner gate).
- **Day-boundary races**: a read straddling roll-over answers the window
  that the pure date-key arithmetic selects at read time; no lock needed,
  no double-window possible (the key comparison is the whole
  synchronization).
- **Huge-activity servers**: the channels section aggregates at read-time
  with a LIMIT from constants (GC_PAPER_CHANNELS_MAX); the threads section
  orders by row-count and cuts at its own cap — the paper NEVER loads a
  server's whole day into memory.
- **Censored/quiet content**: the paper reads only public channel rows —
  mod-only and permission-gated channels contribute nothing (the channel
  visibility check rides the read's WHERE, same gate a member's own read
  would carry).
- **Bot/system rows**: system-authored rows (import rows, relay writes)
  count only if they already count in the server's own public ledger; the
  paper does not invent an author-side filter beyond what reads carry.

## 4. Migration sketch (CREATE-only — number 0034, next free after T83's
0033)

```sql
CREATE TABLE gc_paper_configs (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id)
);
```

- ONE table, nothing else. The paper is read-time-derived; there is no
  paper-issues table, no render cache, no per-issue persistence — the
  config row IS the whole seat (mirrors T83's "the seat, nothing else").
- The history story ("read yesterday's paper") is satisfied by re-deriving
  the previous day-key window the same way — the rows already exist; no
  issue archive is stored. A stored issue cache is a YAGNI row until a
  real caller needs it.
- The toggle is the explicit act (defaults law): an INSERT/UPDATE carries
  `enabled = 1` only from a mod's intent; a DELETE carries the OFF. There
  is no "null" default row — absence of the row IS off.

## 5. Laws (this lane's version)

- **Defaults law**: the paper is opt-in; OFF until a mod turns it on;
  absence of the config row is the off-state; no default-on anything, and
  no server-wide consent question — the mod toggle IS the consent model,
  and the paper shows only what any member can already read (public
  channels only).
- **No-copy sweep** — every painted string rides t(); the en key list this
  lane adds: `paper.title`, `paper.windowLabelUtc`, `paper.section.channels`,
  `paper.section.threads`, `paper.section.capsules`,
  `paper.empty.channels`, `paper.empty.threads`, `paper.empty.capsules`,
  `paper.empty.all`, `paper.capsuleDueRow`, `paper.configuredBy`,
  `paper.off`. Non-en fills ride CARVE_GATES or stay en-only until
  ratified.
- **Caps from constants.mjs, never re-declared:**

  | Constant | Proposed | Meaning |
  |---|---|---|
  | GC_PAPER_DAY_SECONDS | 86400 | the UTC day-key unit |
  | GC_PAPER_CHANNELS_MAX | 10 | max channel rows per paper |
  | GC_PAPER_THREADS_MAX | 5 | max thread rows per paper |
  | GC_PAPER_CAPSULES_MAX | 25 | max reveal-due seal rows per paper |
  | GC_PAPER_YESTERDAY_KEYS | 1 | completed-window history depth (v1: yesterday only) |

- **Sink law**: N/A — the paper mints nothing and sinks nothing. No coin
  surface touches the paper; no render grant, no read fee, no reward (a
  paid journal is a ladder-shaped idea; the paper stays free like the
  tagline slot).
- **No profiling**: the paper's shape has no member-level rows — counts,
  thread names, seal names; the only personal fact is a capsule's sender
  HANDLE as already painted by T82's own routes (no new personal data
  created, none aggregated per-member).
- D1-only, vanilla imperative, AGPLv3 header, no third-party anything.
- Route registration would ride worker.mjs's API_HANDLERS at GREEN — surface:
  `GET /api/servers/:serverId/paper` (members, config must be on),
  `GET /api/servers/:serverId/paper/previous` (same), and the mod-gated
  `POST /api/servers/:serverId/paper` (`{ enabled: boolean }` — POST is a
  member-gated 404 family per T83; the mod gate rides the existing mod
  permission check, all rate-limited). NO other routes; no global paper
  route exists.

## 6. OWNER_GATED

- **Delivery timing**: this spec ships the paper as pull-on-request
  (member opens it), riding T83's read-time roll-over (no cron exists in
  the fleet and no-timers is the fleet idiom). If the owner wants a
  fixed-hour POST (daily message dropped into a channel), that needs a
  scheduled surface — an owner ruling creates the idiom; this spec does
  not assume one.
- **Boosts ride in?**: v1 does NOT carry a boosts section
  (GC_BOOST_LEVELS is the tier-matrix law; a boosts-in-the-paper section
  is an owner call — it would put a boost count in a synthesized public
  page).
- **Timezone anchor**: UTC-only v1. A per-server local-wall-clock anchor
  needs a tz field on the server seat (schema change beyond this lane's
  CREATE-only sketch) — parked pending owner ruling.
- **History depth**: GC_PAPER_YESTERDAY_KEYS = 1 answers yesterday's paper;
  a longer archive is a one-constant change at green if the owner wants
  more (no schema change needed — re-derivation, not storage).

— Product/planning lane, T87, 2026-11-18. Sources: feature-slate wave-4
entry 6; the T83 spec's idioms (day-key roll-over, guarded defaults law,
constants table, RED-rows list format); constants.mjs export surface read
for naming parity.
