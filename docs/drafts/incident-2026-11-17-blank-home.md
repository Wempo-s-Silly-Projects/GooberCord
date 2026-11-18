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
| after 21:15 | Both fixes on main tip (`aa6979a` = HEAD). This brief's deploy/push lane is out of scope; the live instance is on the pre-fix build until the next verified deploy. |

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

## Status

Fixes `722e9e2` + `aa6979a` at main tip (`aa6979a`), suite 1351/1351. Next
verified deploy under the full ritual (NAME-PRESENCE `d1_migrations`, then
probes green) flips the live instance; until then prod behaves per its
current build. No push/deploy performed from the post-mortem seat.
