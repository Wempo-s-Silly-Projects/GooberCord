# Feature slate — wave-26 (self-directed, Section A autonomous, owner away)

Through-line: the 1.0 tree has its seams and gates in place; wave-26 buys the two
moderation-transparency surfaces Discord parity expects (Audit Log, Polls) — both
server-shaped, both riding the existing D1/WS patterns, both forum-grade (bare
bones but works, secure, functional, no major issues).

Stance on the owner's parting directive ("just bug fix, make new features"):
the deslop half runs as wave-26 row 3 (fresh quality-pass over the seam-churn
diffs + the 1.0 surface), the feature half rides rows 1–2 below.

## W26-1 — Server audit log + "Logs" tab

- **Identity**: every moderation action (kick/ban/unban/nick/role edits/
  overrides/prune/boost strip) persists to a `gc_server_audit` row — actor,
  action key, target, one JSON payload of before→after deltas, timestamp —
  and a new "Logs" tab in the server settings panel renders the newest 100
  with i18n'd action labels.
- **Laws it rides**: caps from constants.mjs (AUDIT_RETENTION / READ limit
  land in constants, never re-declared); LIMIT COLLECTION NOT ACCESS (the
  row records server-internal moderation facts that members can already see
  happen — nothing network-external, nothing default-on outside the server);
  i18n discipline (action keys ride t(), en-only until ratified).
- **Surface shape**: D1 migration 00XX `gc_server_audit` (no FK hazards per
  the D1 migration law — plain INTEGER columns + CHECK, follows 0058's
  shape); writer inserted at the exact commit points inside the existing
  moderation handlers (server-mod/servers/server-roles/server-channels),
  ONE shared `recordAudit(env, ...)` helper (seam discipline: one
  implementation); read arm `GET /api/servers/:id/audit` behind
  MANAGE_SERVER-equivalent bits; client tab in the settings panel.

## W26-2 — Channel polls

- **Identity**: a poll message type: POST /api/messages with
  `kind: "poll"`, question + 2..10 options (constants-capped), single- or
  multi-choice, votes persisted per (message,user), live tally in the
  message payload and on the WS event; one-vote-per-user per poll, votes
  changeable until the poll is closed (creator can close).
- **Laws it rides**: defaults law (poll participation is explicit, never
  auto-enrolled); sink law n/a (no coins); positional binds only; payload
  rides the groupedPayloadReads machinery, NOT a new parallel read stack;
  WS event re-uses the rooms DO relay's existing message-update shape —
  no new DO state.
- **Surface shape**: migration 00XX `gc_polls` + `gc_poll_votes` (CHECKs
  inline, no FKs); writer/read in messages.mjs (new arm, forward contract
  same as pins); client poll render + vote UI in the message renderer;
  caps: POLL_MAX_OPTIONS in constants.mjs.

## W26-3 — Standing deslop: post-1.0 quality pass over the seam churn

- **Identity**: a fresh deslop/audit cycle over the recently landed diffs
  (the 11-family seam program f441288/e14c55f/7339fa6, the guard-bind gate
  6a150a1, the 1.0 stamp 2207501) — code-quality + security lenses only;
  every finding RED-first, fixed at the tip, no parked rows ("no park").
- **Laws it rides**: Section Q verbatim; the guard-binds referee covers any
  new bind arithmetic; scope = recently-changed files + their call sites.

## Out of slate (parked, owner-decision items untouched)

- GDPR cross-app deletion, ToS/Privacy venue, kitskey branding (owner-decision
  parked); message scheduling (needs cron surface — propose for wave-27);
  server scheduled events (larger DO-surface; wave-27 candidate).
