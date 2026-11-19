# Quality-closure wave-22 — the web-platform scan lane

Owner's skill invocation (`/modern-web-guidance:modern-web-guidance`, no args,
09:10 EST 2026-11-19) applied to the client tree right after the XHR reversal:
`legacy-scan public/js` → 10 findings, ZERO XHR (the wave-21 revert left the
transport fully clean — the owner's exact worry). All 10 verified against the
guides' keepWhen/dropWhen rubric this hour; evidence copies in
`/tmp/gc-legacy-scan.json` and `/tmp/gc-guides.md` (retrieved ids: dialog,
declarative-dialog-popover-control, dark-mode-toggle, ime-safe-enter-submit).

## Through-line

The forum bar ("ye its not wempos forum quality") is met one platform-grade
correction at a time. This wave closes the seven findings that are mechanical
today, and rows the three that need their own care. No feature surface moves —
every hunk is a behavior-preserving modernization except the one real bug
(IME), which is behavior-FIXING: we ship ja/zh live and `key === "Enter"` fires
mid-composition, sending half-converted messages.

## The mechanical seven (RED-first lane qual-webscan)

1-3. **IME-safe Enter-submit** (chat.js:818 edit-seat, :1047 send well, :1240
     GIF search): ride the guard `if (event.isComposing || event.keyCode ===
     229) return;` after `preventDefault()` — the guide's recommended pair
     (Safari's out-of-order confirming Enter rides the 229 catch; nested under
     the Enter gate so mobile keyboards stay safe).
4. **chat.js:104** `[...fresh].sort(...)` → `fresh.toSorted(...)` (fresh has
   no later use in that branch).
5. **chat.js:607** `[...lane.list].sort(...)` → `lane.list.toSorted(...)`
   (store state; immutability law AND the guide agree).
6. **members.js:94** `[...payload.members].sort(...)` →
   `payload.members.toSorted(...)`.
7. **core/dom.js:96** `while (node.firstChild) removeChild(...)` →
   `node.replaceChildren()`.

Support floor: `toSorted` FF 115 / Chrome 110 (2023), `replaceChildren`
Baseline 2022 — no fallbacks, no polyfills.

## The three that row instead of ride

- **pins.js:148 backdrop dismiss → `closedby="any"` + the guide's
  `'closedBy' in HTMLDialogElement.prototype` fallback detector** (graceful:
  Esc still closes where `closedby` is missing). Guide-backed, goes with the
  next dialog-touching lane — NOT the mechanical lane, it needs a dialog
  render pass.
- **pins.js:146 close button → `<form method="dialog">`** — the dialog
  guide's blessed close shape, Baseline-universal, zero deps; deliberately
  NOT `commandfor` (that route demands the `invokers-polyfill` CDN dependency
  for one button — a license/vendor question out of this wave's scope).
- **theme-preload.js:41 meta color-scheme** — real but re-models the theme
  system (meta + CSS `color-scheme` + `light-dark()`); its own row, design
  pass before any hunk.

## Laws this wave rides

- Byte-freeze law: NO transport changes — fetch stays (client-transport law,
  owner Nov 19 "no xhr thats deprecated").
- No-copy sweep: every painted string rides t() (none added here).
- Suite-first: RED for the IME guard (a fake keyboard event with
  `isComposing: true` must NOT submit), GREEN to spec, isolated verify.
- Co-Authored-By: Claude Code <noreply@anthropic.com>.
