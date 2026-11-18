<!--
SPDX-License-Identifier: AGPL-3.0-or-later
GooberCord — incident post-mortem, blank signed-in home (2026-11-17).
Draft seat output; not part of the shipped worker surface.
-->

# Post-mortem: blank signed-in home page — 2026-11-17

Two independent faults produced the same symptom: a signed-in load of `/`
rendered either nothing (blank) or "Heading / Body / Title / Empty" key-tail
text instead of copy. Both faults printed zero console errors.

## Timeline (all times EST 2026-11-17)

| When | Event |
|---|---|
| W-R1, `4bdca5b` | Fault 1 ships. The `/` route seat passes `renderShell` directly as a mount-seat render. Silent since then. |
| T25 churn window | Fault 2 seeds. Worker serves the SPA-fallback HTML for `GET /locales/en.json` with 200 OK. |
| ~20:1x–20:3x | Deploy wave (`8ed233d` stage-2 lift, `331095d` lang picker, churn deploys) widens the churn window; owner hits blank/key-tail home and reports it. |
| `722e9e2` 21:11 | Fix 1: home seat is a real `(route, mount)` render, `homeRoute` builds the frame and appends it into the router mount. |
| `aa6979a` 21:15 | Fix 2: i18n bundle fetch de-cached (`no-cache` + app-build stamp cache-buster), stale-seat fallback to en, wedged non-JSON en retries uncached. Suite 1351/1351. |
| `3e8b8cc` 21:25 | Follow-up (server half): locale bundle paths never ride the SPA fallback — wrong-extension/miss answers a plain 404, worker.mjs +19, `tests/worker-dispatch.test.mjs` +81. Closes the post-mortem "unpinned static fallback" detection-gap row on the serving side. |
| `1fc4b45` 21:30 | Follow-up (loud failure): the silent-failure class gets loud — boot catch in `main.js`, render guards in `core/router.js` and `ui/landing.js`; a render throw now surfaces instead of dying silently. Pins in `tests/core-router.test.mjs`, `tests/main-build.test.mjs`, `tests/ui-landing.test.mjs`. |
| `d6c7feb` 21:36 | Follow-up (presentation): the render-failure card rides the gate-panel idiom on error tokens (`public/styles.css` +16, brace-balance pin). Suite 1362/1362, verified isolated-worktree at the pushed SHA. |
| after 21:36 | Canonical deploys verified: `pnpm run deploy` (the script rides `--keep-vars --var COMMIT_SHA:$(git rev-parse --short HEAD)`; a bare `pnpx wrangler deploy` is BANNED — it emits an empty `build:""`, inerts the stale-build strip, and breaks the `?v=` bundle cache-buster — the T25 churn root cause). Prod on build `d6c7feb`, deploy version `9e948f0d`, probes green. |

## Fault 1 — renderSeat contract violation (`public/js/main.js`)

- Router invokes seat renders as `(route, mountNode)`; `renderShell`'s own
  signature is `(route, paneOverride)`.
- The `/` seat handed `renderShell` to the router, so `#app` was consumed as
  the pane; `shell.js`'s `frame.append(paneOverride)` swallowed the live mount
  node into a detached frame that nothing ever attached.
- Result: every signed-in `/` load rendered a blank page, zero console errors.
- Anonymous loads stop at the sign-in gate before any route render — QA's
  signed-out pass could never see it.

### Fix + pin

- `722e9e2`: `homeRoute(route, mount)` builds the frame, appends it into the
  router's mount. `renderShell` is never a mount-seat render again.
- Pin: `tests/ui-shell.test.mjs:78` forbids
  `addRoute("/", "home", renderShell)`; `tests/ui-shell.test.mjs:80` pins the
  `homeRoute(route, mount)` contract.

## Fault 2 — force-cache HTML poison of `/locales/en.json`

- Inside the churn window, `GET /locales/en.json` answered 200 OK with the
  SPA-fallback HTML instead of JSON.
- `public/js/i18n.js` fetched every bundle with `cache: "force-cache"`, so any
  tab that booted inside the window cached that HTML as the en bundle on disk
  — per-URL, surviving reloads.
- The unguarded `await` on the poisoned bundle threw, the catalog never set,
  and `t()` fell through to humanized key tails ("Heading", "Body", "Title",
  "Empty"). Zero console errors; every repaint kept the poisoned cache and
  re-fetched through `force-cache`.

### Fix + pins

- `aa6979a` (`public/js/i18n.js` +44, `tests/i18n.test.mjs` +61):
  1. bundle fetch rides the app-build stamp as a cache-buster URL — each
     deploy's copy is a distinct cache row;
  2. fetch is `no-cache` — the churn-era HTML row can never win again;
  3. a stale stored seat this fleet no longer ships falls back to en at boot
     ("it" from a churn-era browser can never keep the paint);
  4. a wedged (non-JSON) en response retries uncached instead of leaving key
     tails; the old fail-open row is re-ruled to the new contract.
- Pins: `tests/i18n.test.mjs` — the stale-seat-fallback row, the
  wedged-en-retry row, and the build-stamp row (3 new behavioral rows).

## Detection gap (process, not code)

- **No console errors anywhere.** Both faults fail visually while every
  console lane stays quiet, so the standard "check console errors" QA pass
  was blind by construction. Detection needs rendered-text assertions
  (key-tail strings, mounted node presence), not console sweeps.
- **QA is signed-out only.** Anonymous traffic halts at the sign-in gate
  before any route render, so the home seat — and any future signed-in-only
  seat — is invisible to the existing pass. Signed-in smoke needs an owner or
  seeded-session pass before a wave is called green.
- **Static-resource fallback was unpinned.** Nothing asserted
  `/locales/en.json` returns `Content-Type: application/json` / a
  non-HTML body. Fix 2's wedged-retry pin covers the client half; the server
  half rides the existing SPA-fallback route, worth a route-level pin if the
  churn window recurs.

## Rider — T29 paint-swap race (owner live incident)

- **Race shape:** `main.js` boot does not await the i18n lane. If
  `locales/en.json` resolves AFTER the router mounts, the first paint runs
  `t()` over an EMPTY catalog — the paint binds humanized key tails — and the
  en-seat resolve path did not repaint, so the tails persisted until the next
  route render.
- **Live evidence:** owner hit tails ONCE on a tab already riding fixed
  build `1fc4b45`; stale-tab and poisoned cache were ruled out (both fixes
  active), leaving this race as the only suspect. Rider opened on the board
  at `2026-11-18T02:38Z`.
- **Fix on the seat:** the en seat now calls `applyDom()` the moment the en
  bundle lands (`public/js/i18n.js:139-147`), so one repaint clears the race
  on the en floor; non-en seats already repainted on resolve. Pin: "the en
  floor repaints already-bound copy" (`tests/i18n.test.mjs:641` onward).
- **State at this writing (board T29):** the floor row + pin are in the
  working tree but NOT yet committed at tip `d6c7feb`; the rider row is not
  yet logged CLOSED. The prevention item below (item 2) describes the row
  as landed — read it as the intended end state until the commit lands.

## Prevention (T44 — four layers, one per recurrence route)

1. **Funnel 404 guard — the server half of fault 2** (`3e8b8cc`, `worker.mjs:241-254`):
   `GET /locales/*.json` matching the bundle shape never reaches the SPA
   fallback — a miss is a plain 404 JSON, so the churn window can't seed a
   cached HTML "bundle" again. Paired client half already shipped in
   `aa6979a` (no-cache fetch + app-build `?v=` stamp cache-buster, stale-seat
   → en fallback, wedged non-JSON retry). Pin: the wedged-retry /
   stale-seat / build-stamp behavioral rows in `tests/i18n.test.mjs`.
2. **T29 paint-swap race floor — the symptom-killer for fault 2's tail case**
   (`public/js/i18n.js:139-147`): the boot never awaits the i18n lane, so
   painters ran `t()` over an EMPTY catalog; on the en seat the loader's
   return was the last stop and already-bound copy stayed humanized tails
   until the next route render. The en seat now calls `applyDom()` the moment
   the en bundle lands — one repaint clears the race (non-en seats already
   repainted). Pin: "the en floor repaints already-bound copy"
   (`tests/i18n.test.mjs:641` onward).
3. **Boot/render silent-failure class gets loud** (`1fc4b45` + `d6c7feb`,
   T28): boot catch + render guards turn the zero-console-error failure mode
   (fault 1) into visible error tokens rendered through the gate-panel idiom,
   so the next contract break surfaces in the UI instead of staying a blank
   seat.
4. **Verify-in-isolated-worktree suite law — the process pin** (fleet rider
   `verify-in-isolated-worktree.md`): suite→push binds verify at the pushed
   SHA in an isolated worktree and never gate a git chain behind `| grep` —
   a green local tree under churn (the T25 window) is no longer accepted as
   release evidence.

## Close-out status

- **Fault chain closed at tip `d6c7feb`:** `722e9e2` seat contract →
  `aa6979a` loader de-cache → `3e8b8cc` funnel 404 (server half) →
  `1fc4b45` boot catch + render guards → `d6c7feb` render-failure card.
- **Canonical deploys verified:** `pnpm run deploy` only (script rides
  `--keep-vars --var COMMIT_SHA:$(git rev-parse --short HEAD)`; bare
  `pnpx wrangler deploy` banned — empty `build:""` on `/api/version`, inert
  stale-build strip, broken `?v=` cache-buster). Prod: build `d6c7feb`,
  deploy version `9e948f0d`, probes green.
- **Suite:** 1362/1362, isolated-worktree verified at the pushed SHA
  (`d6c7feb`).
- **Open rider:** T29 paint-swap race — floor row staged, commit pending
  (see rider section above).
- No push/deploy performed from the post-mortem seat; doc-seat changes stay
  inside `docs/drafts/incident-2026-11-17-blank-home.md`.
