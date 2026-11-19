# feature-slate — wave-15: the anniversary seat (2026-11-19)

Through-line: the celebration seat (api/paper.mjs:291-341 —
PUT /api/users/me/anniversary `{month, day}` + DELETE, self-scoped,
self-gated, LIMIT-COLLECTION month+day WITH NO YEAR) is fully live and
the celebration paper already paints today's celebrants server-side —
but a member has no door to set or clear their own month-day. This is
the wave-10/13/14 pattern: the surface the backend already earned.
Backend BYTE-FROZEN for the wave (api, worker.mjs, core) — every
change client-side.

## The feature

- **Settings seat**: the account-settings surface gains an
  anniversary seat — month 0-11 / day 1-31 mirrors (constants.mjs
  GC_USER_ANNIVERSARY_MONTH_MAX/DAY_MAX, G-4 idiom), STRUCTURAL ONLY
  (the backend stores Feb 30 verbatim and never fires it — the client
  mirrors that truth, no per-month day counts invented, no leap math).
- **Set/clear acts**: PUT is the one explicit save (defaults law: no
  pre-filled month, the seat opens empty); DELETE is one explicit
  clear (no confirm-gate ceremony — absence IS the off-state and the
  clear is total). Second PUT overwrites in place.
- **Paint truth**: the current celebration answer (or its absence)
  paints from the member's own state — no invented countdown, no
  today-list duplication (that reads ride the paper as member-scoped
  data, not this seat's).

## Laws the wave rides

- privacy law: the schema carries month+day and nothing else — the
  client paints the month-day, never a year, never a derived age
  (LIMIT COLLECTION NOT ACCESS holds at the door too).
- sink law: no coins. defaults law: empty seat, member-initiated acts.
- no-copy sweep: every painted string rides t() keys; en real copy +
  translated in all 8 staged bundles; no byte-equal en carve.
- error-copy law: the route's 400/401 families paint verbatim.
- backend byte-freeze (the wave-9 lesson, six instances): the freeze
  pin fingerprints the wave's own committed range (LANE_TIP
  placeholder retargeted at commit time by the lead).

## Sequencing

lane-w15-anniv: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → retarget freeze pin → isolated verify ×2 → deslop →
merge → push → ritual deploy → probe stamp == pushed SHA → board.
