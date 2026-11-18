# The feature slate — wave 5 (2026-11-18, midday)

Wave 4 shipped six (T82–T86 deployed, T87 backend live, client half in
flight on the frontend seat). Wave 5 rides the same proven chain
(slate → board → brief → RED → implement → laws → isolate-suite → commit →
gate → deploy). $0, D1-only, no third-party APIs, vanilla imperative,
AGPLv3 headers everywhere.

Through-line: **the hangout gets hands** — ways to keep, to claim, to
account, to remember, to greet.

## Dispatched lanes

1. **Bookmarks (T88)** — a member saves private pointer rows to their own
   reading queue (message id + saved-at, nothing else). Rows are the
   member's alone: nobody else can read them, deletable anytime, wiped on
   account delete (GDPR shape). Identity: your reading list, nobody
   else's.

2. **Reaction tags (T89)** — a mod maps an emoji to a free cosmetic tag;
   members opt in per tag by reacting; the tag rides their server profile
   until they un-react. Tags are cosmetic-only (economy re-rule: coins for
   cosmetics, tags stay free), capped from constants.mjs. Identity:
   collecting moments into a tag.

3. **Campfire ledger page (T90)** — derived-on-request public per-server
   coin flow: mints and sinks NAMED (pool-side first per sink law), no
   member attribution, no new tracker — computed from rows the server
   already stores, on the paper.mjs precedent. Identity: the fire's books
   are open.

4. **Month-day anniversaries (T91)** — an opt-in member stores MONTH+DAY
   only, never a year (LIMIT COLLECTION NOT ACCESS); surfaces as a Morning
   Paper section and a one-day badge. Clearable anytime. Identity: the
   calendar remembers without counting years.

5. **Server welcome card (T92)** — mod-configured greeting shown to new
   members once: t()-keyed template with server name + a mod-chosen blurb,
   off until configured (defaults law), re-showable on request. Identity:
   the server says hello its own way.

## Ruled N/A this wave

- **Slow mode**: exists — `api/messages.mjs:176-210` (phase-3 channel
  layers with BYPASS_SLOWMODE).
- **Custom status flags**: too near the PresenceHub DO (ephemeral
  presence, `api/presence.mjs`); a persisted status line would need a
  privacy ruling the owner hasn't given.

## Laws every lane rides (unchanged)

- Sink law: every mint names its sink (ledger page makes that VISIBLE).
- Defaults law: bookmarks, reaction tags, anniversaries, welcome card —
  opt-in, never default-on.
- No-copy sweep: every painted string rides t(); non-en fills →
  CARVE_GATES or stay en-only until ratified.
- Caps live in constants.mjs; never re-declared.
- RED first; isolated-worktree suite bind at the pushed SHA.
- Branch `fleet-wave-2026-11-18`; main stays at the owner's gate.
