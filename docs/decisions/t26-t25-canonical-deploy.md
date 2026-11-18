# DEC-003: the canonical deploy binds the commit SHA — no bare wrangler deploys

Date: 2026-11-18 · Status: ACCEPTED (law) · Origin: T25 deploy-churn incident
(2026-11-17) + T80 churn attribution

## The decision

`pnpm run deploy` (package.json) is the ONLY deploy command. It binds
`--keep-vars` and `--var COMMIT_SHA:$(git rev-parse --short HEAD)`. A bare
`pnpx wrangler deploy` answers with `build:""` on `/api/version`, which:

1. inerts the stale-build strip (the client's cache-busting `?v=` stamps go
   empty, so stale bundles stop being invalidated), and
2. is the funnel signature of the churn loop: recurring deploys landing
   `build:""` were attributed (T80, session-side deployer behind a shared
   token) and closed by the lead-only deploy authority.

## Consequences

- Deploy authority is lead-only; every non-lead lane's deploy step is "report
  tip, do not deploy".
- Any `/api/version` probe with `build:""` is a churn alarm, not a cosmetic
  quirk — investigate the deployer before touching code.
- Verified ritual per deployed tip: build stamp == pushed tip SHA, plus the
  locale probes (`/locales/it.json` 404-plain, `/locales/en.json` 200-json).

## Attributed receipts

- Churn funnel: build:"" → /locales/unknown.json 200-HTML.
- Fix live at adc3a8d (Version 6a71842d, build=adc3a8d verified).
- Standing law rides `.team/taskboard.json` T25/T80 rows (DONE).
