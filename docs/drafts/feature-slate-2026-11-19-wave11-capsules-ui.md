# feature-slate — wave-11: capsules UI (2026-11-19)

Through-line: the time-capsule backend (api/capsules.mjs) has been live and
audit-hardened through five haywire cycles — the member-facing door is now
the missing half. Wave-11 builds the client surface the routes already earn:
a server-scoped capsules panel where a member composes a sealed letter,
watches it wait for its postmark, reads it once it opens, and can delete it
before reveal. The backend is BYTE-FROZEN for the wave (api, worker.mjs,
core) — every pin reads source; the wave's only backend touch is none.

## The feature

- **Capsules panel** at `/s/:serverId/capsules` (the server-scoped page
  idiom: `/s/2/search`, `/s/2/settings`): nav entry rides the server rail.
  Lists the author's own letters from `GET /api/servers/:id/capsules/mine`
  (`{ capsules: [{ id, channelId, revealAt, sealed }] }`), sealed/open
  classified against now, zero client timers.
- **Compose door**: one explicit `POST /api/servers/:id/capsules` with
  `{ body }`; body 1–2000 chars (G-4 mirror: GC_CAPSULE_BODY_MAX +
  GC_CAPSULE_MIN_AHEAD_SECONDS 300 / GC_CAPSULE_MAX_AHEAD_SECONDS 2592000
  ride constants.mjs, mirrored as literals by wave law). Reveal-at rides the
  form's own date-time seat, validated inside the window client-side AND
  left to the route's 400 family verbatim on refusal. Defaults law: the
  postmark is never pre-filled beyond the minimum window — composing is
  always the member's own act.
- **Reveal view**: `GET /api/servers/:id/capsules/:cid` — author pre-postmark
  paints the sealed shape's schedule; post-postmark paints `body` verbatim
  as member-composed text (textContent seat, never t()'d, never
  interpolated — the welcome-card law). Non-author 404 family paints the
  server's message verbatim.
- **Delete before reveal**: `DELETE /api/servers/:id/capsules/:cid` from the
  panel's own rows; the 409 revealed-locked answer paints verbatim.
- **Rider (T-C16-CAPS LOW-a)**: the bookmarks panel paints the list
  envelope's `truncated` seat (a one-string "N more saved" line) — closing
  the deslop-c16 note in the wave's own file scope.

## Laws the wave rides

- sink law: no coins — capsules mint nothing and the client adds no ledger.
- defaults law: no auto-GET on open beyond the panel's own list pull; no
  auto-compose; the reveal GET is member-initiated.
- no-copy sweep: every painted string rides t() keys; every new key en-seated
  real copy AND translated in all 8 staged bundles (no en placeholder, no
  byte-equal carve); the reveal window's numbers ride the payload/mirrors,
  never prose literals.
- member-composed text law: capsule bodies paint through textContent seats.
- error-copy law: server refusals paint verbatim, never re-worded client-side.
- backend byte-freeze (the wave-10 idiom): freeze pin fingerprints the wave's
  own committed range, never HEAD (the wave-9 lesson, both instances).

## Sequencing

lane-w11-capsules: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → isolated verify ×2 → deslop → merge → push → ritual deploy
→ probe stamp == pushed SHA → board.
