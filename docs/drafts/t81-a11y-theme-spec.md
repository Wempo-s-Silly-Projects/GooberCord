# T81 — a11y theme row: high-contrast tokens + font scale (spec draft)

Slate row 8 (fleet-wave-2026-11-18, branch tip c215561). Status: SPEC + RED
tests only (tests/a11y-theme.test.mjs) — the GREEN lane lands the rows.
Deliverable law: WCAG 2.2 (https://www.w3.org/TR/WCAG22/, read 2026-11-17)
— 1.4.3 contrast-minimum 4.5:1 body/label text, 1.4.11 non-text-contrast
3:1 UI components/borders/focus, 1.4.6 contrast-enhanced 7:1 held as the
target the hc block exceeds everywhere it can. Every ratio below is a
MEASURED WCAG relative-luminance computation, not an eyeball claim.

## 1. High-contrast tokens (both themes, first-class)

Two new token blocks riding `public/styles.css`, one per theme, redefining
the core set verbatim — EXACT selectors, tests pin them:

/* ======================== a11y tokens ======================== */

:root[data-hc="on"] { ...12 tokens, dark hc values below... }
:root[data-theme="light"][data-hc="on"] { ...12 tokens, light hc values... }

REQUIRED token list in both blocks (tests enumerate):
`--ink --muted --desk --paper --line --focus --link --green
--coral --error-chip-ink --error-chip-bg --quiet-hover`

Proposed values (all pairs measured PASS below):

| token      | dark hc  | light hc   |
| ---------- | -------- | ---------- |
| --ink      | #ffffff  | #101c29    |
| --muted    | #c9d3dd  | #43525f    |
| --desk     | #0b1119  | #fffaf0    |
| --paper    | #14202e  | #ffffff    |
| --line     | #7487a0  | #8a7f66    |
| --focus    | #a8c7ff  | #0b47a0    |
| --link     | #9be3bd  | #1a4f39    |
| --green    | #17553a  | #26573f    |
| --coral    | #ff9b8a  | #7a231a    |
| --error-chip-ink | #ff9b8a | #7a231a |
| --error-chip-bg  | #3a1214 | #ffe4dc |
| --quiet-hover    | #233646 | #f0e4c8 |

Every UNLISTED token inherits the incumbent theme value — the hc block is a
sparse override, never a fork of the whole palette.

## 2. Font scale — one root var, rem-driven

- `:root` gains `--font-scale: 1;` (default is exactly 1 — no change until
  the row moves it).
- The base rule gains the single scale seat:
  `html { font-size: calc(100% * var(--font-scale)); }`
  All component sizes already ride rem, so one var scales the whole sheet;
  px-valued borders/indents stay fixed by design (geometry, not text).
- The settings row writes the var INLINE on `documentElement`
  (`style.setProperty("--font-scale", …)`) so it always outranks :root and
  no second-at-theme-block duplication is needed. Permitted steps:
  0.875 / 1 / 1.25 (named constants — no magic inline numbers).

## 3. Settings surface (shell userBlock seat)

Rides the existing theme-row grammar in `public/js/ui/shell.js:363-392`
(text-and-label buttons, no icon-only controls):

- "High contrast" — a `type=button` toggling `data-hc` on/off on
  `documentElement`, visible label states via the i18n seat (new key
  pair gc.shell.theme.hcOn / gc.shell.theme.hcOff), persisted to
  `goober-hc` ("on"/"off").
- "Text size" — same row grammar cycling 0.875 → 1 → 1.25, persisted to
  `goober-font-scale`.
- Kit's vendored engine (public/js/vendor/frontload/tokens.mjs) is NOT
  touched — byte-parity law. The rows extend the dataset pattern Kit
  already paints (`data-theme`, tokens.mjs:132) with the two extra
  attributes/vars painted by shell-side code, never vendor edits.
- PRE-PAINT: both settings ride `public/js/theme-preload.js` (the seat
  index.html:22 mounts before first paint) so hc/font-scale never flash —
  the same beat that prevents the theme flash covers these.

## 4. Contrast acceptance criteria (measured 2026-11-17, WCAG formula)

Floors: text pairs 4.5:1 (1.4.3), non-text pairs 3:1 (1.4.11). Formula:
WCAG 2.2 relative luminance. All 19 measured pairs PASS:

| pair | dark hc | light hc | floor |
| ---- | ------- | -------- | ----- |
| ink/desk | 18.95 | 16.54 | 4.5 |
| ink/paper | 16.46 | 17.21 | 4.5 |
| muted/desk | 12.49 | 7.73 | 4.5 |
| muted/paper | 10.85 | 8.04 | 4.5 |
| link/desk | 12.74 | 9.09 | 4.5 |
| focus/desk (non-text) | 11.08 | 8.33 | 3 |
| line/desk (non-text) | 5.16 | 3.80 | 3 |
| #ffffff button text on --green | 8.76 | 8.34 | 4.5 |
| chip ink / chip bg | 8.07 | 8.35 | 4.5 |

(Dark green-hover pair #1d6946 measured 6.64 — any --green-dark override
must stay ≥ 4.5 against #ffffff text.)

A GREEN-lane token row that fails any of these floors fails the tests —
the test file recomputes the luminance math itself, so a hand-tuned hex
can't slip under a floor by looking right.

## 5. No-hex rule

Hex literals live ONLY inside the two a11y token blocks. The a11y RULES
section (pinned marker `== a11y rules ==`) consumes `var(--…)` exclusively
— tokens are the single source of color truth, same law as the rest of
the sheet.

## 6. Test contract (RED rows shipped in tests/a11y-theme.test.mjs)

1. both hc blocks exist with the exact selectors, each redefining the
   REQUIRED token list;
2. `--font-scale: 1;` at :root + `calc(100% * var(--font-scale))` seat;
3. the a11y rules section carries zero hex literals;
4. the hc token values hold their WCAG floors (recomputed in-test).

## 7. Follow-up row (advisory 3, logged 2026-11-18 — its own lane)

The text-scale meta opt-in (`<meta name="text-scale" content="scale">`)
is NOT taken tonight: it requires a stylesheet-wide rem audit plus a
Firefox visual pass at 320px reflow. Static gates ALREADY verified for
the shipped seat: zero px-valued font-size declarations in
public/styles.css (grep count 0 — text scales purely through rem/zoom,
so the "resizable to at least 200% without loss of content" gate rides
browser zoom), and the sheet's existing 900px/640px mobile breakpoints
carry the 320px reflow pins. Open items for the follow-up lane:
the meta opt-in itself, a full rem audit (the sheet's px values are
borders/indents only by intent — enforce that), and the 320px reflow
screenshot pass (Firefox-only lane per the standing law).
