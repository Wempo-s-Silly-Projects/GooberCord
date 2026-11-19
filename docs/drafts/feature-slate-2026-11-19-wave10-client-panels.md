# Feature wave 10 — client panels for the UI-less routes (bookmarks, quests, welcome card)

Date: 2026-11-19. Base: b38c794 (main tip, suite 1916/1916, all audit surfaces
c2-c14 covered). Owner away, Section A fully autonomous. VERSION stays `"prototype"`.

## Through-line

Three backend features are FULLY live — routes pinned through the haywire
cycles, wired into worker.mjs, hardened by the audit fleet — and the client
has zero door into any of them (verified 2026-11-19: `/api/bookmarks`,
`/api/quests`, `/api/servers/:id/welcome-card` have not one `public/js/`
reference). This is the wave-9 pattern again: the wave that ships the surface
the backend already earned. A member who wants to save a message can't;
a member who finished the day's quests can't see progress or claim; a mod
who wrote a welcome blurb has no write door and a member no pull. This wave
wires all three — backend byte-frozen, every change client-side.

## Feature 1 — Bookmarks (save a message + private saved panel)

- Save act: a message-row action in `public/js/ui/chat.js` POSTs
  `/api/messages/:messageId/bookmark` — api/bookmarks.mjs:159 (handler :89,
  wired worker.mjs:225). The idempotent-duplicate 200 renders nothing
  (already-saved is not an error); the shared 404 renders the server's
  message body verbatim (error-copy law).
- Private panel: a new small module `public/js/ui/bookmarks.js` (many-small-files;
  nav entry rides shell.js) — GET `/api/bookmarks` (bookmarks.mjs:162) lists
  the day's saved pointers; DELETE `/api/bookmarks/:bookmarkId`
  (bookmarks.mjs:154) un saves, one explicit click per row. List rides
  GC_BOOKMARKS_LIST_MAX (constants.mjs:553) as a client mirror pin
  (G-4 idiom — economy.js:39). The empty list is a valid painted state
  (defaults law), never an error.
- No message body in the list payload — the backend intentionally returns
  pointer rows only (bookmarks.mjs:80); the panel renders what the contract
  gives (id, messageId, savedAt), no invented read.

## Feature 2 — Daily quests (progress panel + claim door on /shop)

- `public/js/ui/economy.js` renderShop (economy.js:223) gains a quests
  block: GET `/api/quests` (api/quests.mjs:169, handler via worker.mjs:44)
  supplies the three progress counts (messages / voice / earned); the goal
  numbers ride GC_QUEST_GOAL_MESSAGES / _VOICE / _EARNED as mirrored pins
  (constants.mjs:367-369), never hardcoded.
- The claim door POSTs `/api/quests/claim` (quests.mjs:172) — ONE explicit
  click, never default-on (defaults law). The shared daily NOT-EXISTS pair
  means the plain claim (economy.js:52, `/api/coins/claim`) and the quest
  claim race for the same daily slot: whichever 409/flat verdict the backend
  answers renders verbatim; no client dedup logic invented.
- SINK LAW: ZERO new mint — the flat 25 rides the backend-pinned
  GC_QUEST_CLAIM (constants.mjs:366) inside the INSERT gate; this wave adds
  no ledger row and no client-visible balance arithmetic.

## Feature 3 — Welcome card (mod write door + member's once-shown pull)

- Mod write: `public/js/ui/settings.js` gains a welcome-card block inside
  the manage gates (manageGate, settings.js:113) — one blurb field, PUT
  `/api/servers/:id/welcome-card { blurb }` (api/welcome-card.mjs:91),
  capped at GC_WELCOME_CARD_BLURB_MAX as a mirror pin (constants.mjs:567).
- Member pull: GET `/api/servers/:id/welcome-card` (welcome-card.mjs:118)
  reads the member's once-shown state; the client paints the blurb on the
  member's first open and ?repeat=1 rides ONLY an explicit member action,
  never a default (defaults law). The absence of the config row renders
  silence — no card, no empty-state error (the off-state IS the missing row).
- Blurb is member-authored content: stored verbatim, painted verbatim,
  NEVER routed through t() (welcome-card.mjs law). The no-copy sweep applies
  to UI chrome strings only — buttons, headings, confirms ride keys; the
  blurb doesn't.

## Feature 4 — i18n keys (the no-copy sweep)

Every painted string rides NEW t() keys — gc.bookmarks.*, gc.economy.quests.*,
gc.settings.welcomeCard.*, gc.shell.nav.bookmarks under the wave-9 scheme;
en.json seats real copy; all 8 staged bundles (de es fr pt ru ja zh ar)
translate them (no byte-equal carve, no en placeholder) per the cosmetics-ui
test's shape. Single strings, no plural arms.

## Non-goals

- Backend routes byte-frozen (bookmarks/quests/welcome-card are pinned;
  this wave's deslop rejects ANY api/, worker.mjs, or constants.mjs edit).
- Capsules UI (the GET/POST/DELETE capsule routes are live and also UI-less)
  is the wave-11 next-up candidate, NOT this wave — the reveal-gate UX and
  author read make it a real feature-sized surface; three panels is the wave.
- No kick/ban/panel re-skin, no invite-orphan handling, no burst-unequip,
  no voice-cap residual, no relay-floor work (parked owner-gated per prior
  slates), no i18n new bundles (stage-1 + ar-ja-zh shipped).

## Testing posture (~30 pins)

New source-read test file (rides cosmetics-ui.test.mjs's idiom):
the bookmark save POST + duplicate-200 silence + unsave DELETE; the panel's
list-read + empty-list state; the quests panel's goal mirrors against
constants.mjs (G-4 assertion) + claim POST + 409-verbatim lane; the welcome
blurb's PUT cap mirror + repeat=1 explicit-only pull + row-absence silence +
the blurb-never-t()'d pin; every NEW key en-seated + translated in all 8
staged bundles; no api/ file touched (diff-scope assertion pins). RED-first.

## Routing

- ONE lane: lane-w10-panels (branch off b38c794) — public/js/ui/{chat,economy,
  settings,shell,bookmarks}.js + locales + its test file; RED-first; standard
  chain after handback. Deslop lane runs after merge (client-side only).
