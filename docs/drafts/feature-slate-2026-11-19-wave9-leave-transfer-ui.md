# Feature wave 9 — leave/transfer UI follow-up (wave-8's surface goes client-side)

Date: 2026-11-19. Base: f22c41f (cycle-9 LIVE tip, suite 1871/1871).
Owner away, Section A fully autonomous. VERSION stays `"prototype"`.

## Through-line

Wave 8 (T-PARITY-LEAVE) shipped the leave-server + transfer-ownership
routes live (f22c41f carries them hardened through haywire cycles 7-9),
but the client has no door into them: the slate parked the UI lane as an
"optional follow-up" and the follow-up is now due. A member who wants out
still has no exit button; an owner who wants to hand off still has no
transfer control. This wave wires the routes into the client surfaces they
belong to — backend byte-frozen, every change client-side.

## Feature 1 — Leave server (own row / channel-rail member block)

- Settings/manage surface for the signed-in member's server profile: a
  leave control (button law: text-and-grammar, no bare icons) that POSTs
  /api/servers/:id/leave after the client asks once (destructive, confirm
  step — one explicit click, never default-on, defaults law).
- The owner sees the 409 message pointing at transfer-ownership — the
  error lane renders the server's message body verbatim (no re-wording),
  per the API error-copy law.
- Success: drop the server from the store's servers lane (refreshServers
  idiom) + navigate home.

## Feature 2 — Transfer ownership (owner's manage surface)

- The manage gear route's server block gains a transfer-ownership control:
  active-member picker (rides the roster payload), one confirm step,
  POSTs /api/servers/:id/transfer-ownership with {userId}.
- The demote/self-transfer 200 echo {transferred:false} renders the
  honest no-op line (i18n key, not raw).
- Success: refresh the roster + settings payload (the owner badge may move
  off me — serverAdminRights re-derives).

## Feature 3 — i18n keys (the no-copy sweep)

- Every painted string rides a NEW t() key under gc.shell.* / gc.settings.*
  scheme; en.json seats real copy; all staged bundles (de es fr pt ru ja zh
  ar) translate them (no byte-equal carve, no en placeholder) per the
  cosmetics-ui test's shape. No plural arms needed (single strings).

## Non-goals

- Backend routes byte-frozen (leave/transfer/kick are pinned through
  cycles 7-9; this wave's deslop rejects ANY api/ or constants.mjs edit).
- No kick/ban/timeout UI re-skin (the moderation panel's existing UX
  stands; only the two NEW surfaces are built).
- No invite-orphan handling (parked owner-gated per T-HAYWIRE-9 F3).

## Testing posture (~30 pins)

Source-read pins (ride cosmetics-ui.test.mjs's idiom): the leave control's
confirm step + route POST; the 409-pointer error lane; the transfer
picker's roster read + POST body; the honest {transferred:false} line;
every NEW key en-seated + translated in all 8 staged bundles; no api/
file touched (diff-scope assertion pins).

## Routing

- lane-w9-ui (branch lane-w9-ui off f22c41f): public/js/ui/* + locales +
  its test file; RED-first; standard chain after handback.
