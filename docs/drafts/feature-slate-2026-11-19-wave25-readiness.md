# Wave-25 slate — release-ready close-out (2026-11-19)

## Through-line

The owner cloned forum v1 (`~/wempos-forum/wempos-forum`, pinned `16c074d`, the
state live in prod) and ruled it the basis for what "release ready" means —
"bare bones but works. its secure. its functional. it has no major issues."
GC's standing loop now closes rows against that rubric instead of an abstract
quality bar. Wave-25 is therefore an AUDIT-close wave: measure the live tree
against the rubric, row the majors, close them, repeat until quiet.

## The rubric (owner's words, verbatim)

1. "its bare bones but works" — the surface does what it claims end to end;
   bare bones is acceptable, missing/mid-flight is not
2. "its secure" — auth, caps, gates hold; secrets owner-held
3. "its functional" — complete at its scope, i18n rides, first-paint contracts sit
4. "it has no major issues" — anything major open disqualifies the surface

## Basis citation

Reference state: `~/wempos-forum/wempos-forum @ 16c074d` (final v1). Notable
measurables GC is now benchmarked against: 36 test files pin; 43 append-only
migrations; 35 single-purpose route modules + `core/` in ~7.9k api lines;
t() discipline client-wide; the color-scheme theme contract authored at
index.html:11 (GC matched it wave-24, e0dc7d7 — live).

## Lanes

| Row | Seat | Surface | Criterion at risk |
|---|---|---|---|
| T-R25-A11Y | a11y-navigator | keyboard-only pass over LIVE GC (door, channels/composer, theme toggle, pins, shop) | 1, 3 |
| T-R25-VIEWPORT | viewport-saboteur | Firefox-only adversarial viewport pass (320px/200%/forced-colors/split) incl. theme chrome-follow | 1 |
| riders | code-review / ecc-security | STANDBY-ARMED on incoming; findings close against criterion 4 | 2, 4 |

## Laws this wave rides

- Section Q anti-waste (echoed into every brief).
- Firefox-only browser lanes; no Playwright; agents never write prod D1.
- Readiness verdicts cite the rubric numbers (1-4), not taste.
- Anything MAJOR lands as a board row the same day it is found ("no park").
- v1 `16c074d` is the yardstick; pattern-donating is secondary.
