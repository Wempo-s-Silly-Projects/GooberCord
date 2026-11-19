// THE REWRITE BRIEF (2026-11-17 ~08:30 EST; amended 08:35 by owner rulings
// "REWRITE EVERYTHING FROM SQUARE ONE" + "AND JUST RETHINK EVERYTHING" +
// "MAKE SURE ITS LIKE THE FORUM AND DOESNT HAVE BUTTON SHIT") — owner
// directive: the client (public/) is rebuilt FROM SCRATCH by the agent team
// against the existing backend. The old client's 13,657 lines of accreted
// JS + 5,217-line stylesheet are replaced in full; the backend (worker.mjs,
// api/*, the parity-law constants, migrations 0001-0027) is NOT touched.
// Route truth: docs/rewrite/api-contract.md (researcher output) once it
// lands; until then the committed api/*.mjs handlers are authoritative.
//
// 2026-11-18 WITHDRAWN (owner: "project kitskey is cancelled", "just recode
// all future", "keep the new features", "BACKPORT EVERYTHING"): the
// revert-and-port replaced the rewrite lane; the KITSKEY FRAMEWORK
// mandate, the byte-parity pins, and the rewrite-era branch plans in this
// brief are DEAD LAW. The vendored api/vendor modules were recoded
// fleet-owned 2026-11-18. This brief is kept as a historical record only —
// do not execute lanes from it.

== WHAT TRAVELS vs WHAT DIES ==
Travels: the API shapes (unchanged server), the build-stamp contract in
index.html (the <meta> stamp vs /api/version reload offer), the theme/skin
pair (no-FOUC preload), the forum design language (below), the
upload/emoji/sticker/sound file-cap mirrors (new pins, same constants.mjs
exports), the accessibility floor.
Dies: every line of public/js and public/styles.css. No file is imported,
copied, or patched from the old client. New modules only.

== STACK + CENTRALIZATION LAW (owner final, 08:39 EST Nov 17) ==
1. NO React, NO Vite, NO new build steps — a short-lived React ruling is
   WITHDRAWN. The client is vanilla imperative, and the KITSKEY FRAMEWORK
   (/Users/itswempo/project-designer) is MANDATORY: vendor the used modules
   into public/js/vendor/ with byte-parity pins (the repo's house idiom —
   see the old client's phase-1 pattern): frontload/dom (el, openDialog,
   useDocument), frontload/tokens (makeAppearance — the theme engine AND
   the storage-key family; no bespoke theme module), designer/kit
   (createStore is the ONLY state primitive behind store.js; panel/
   heading/createForm/createInput/createSelect are the primitive
   vocabulary). A shared-looking primitive built app-side instead of
   Kit's is a design error; dialogs ride the openDialog idiom.
2. WEMPO ACCOUNTS IS THE DOOR AND THE SETTINGS HOME: the new client builds
   NO registration form (register → accounts.itswempo.workers.dev) and NO
   account-settings surface (profile fields, avatar, accent/tagline, TOTP,
   backups live in Accounts). GC keeps: sign-in (SSO redeem primary, the
   existing direct sign-in as the quiet secondary), server management, the
   shop/economy, and everything app-specific. The settings wave's scope is
   SERVER settings ONLY.

== THE DESIGN: the FORUM's language, extended to a chat app ==
WEMPOS-FORUM (~/wempos-forum/public/styles.css) is the house style and the
owner has ruled the new GC client MUST look like it. GC stops trying to be
a different product and becomes the forum's chat wing: same papers, same
ink, same hand-drawn grammar. Not Discord cosplay, not a new identity —
ONE family look across forum + GooberCord.

-- Tokens: adopt the forum's names and values VERBATIM (both themes) --
  Light (the warm papers): paper #fffaf0 · paper-shadow #e5d7bc ·
  desk #f7efdc · desk-dot #cfbf9c · ink #24364a · muted #586777 ·
  line #cbbd9f · green #397357 / dark #28583f · coral #c65343 / #9c4035 ·
  yellow #f3cf67 / hover #e9d9a7 · blue #c8e2e9 · focus #0758c9 ·
  field #fffdf8 / line #9a9d82 · link #245f49 / hover #8b382e ·
  soft-green #e7efd9 · error-ink #842f27 / soft #f5d5c5 · success-ink #215b41
  Dark (the forum's own dark block): desk #131b27 · paper #1d2836 ·
  paper-shadow #0c1219 · desk-dot #26344a · ink #e8e4d8 · muted #a4aeba —
  pull the remaining dark values FROM the forum's dark :root block, not
  from imagination.
  GC DEFAULT is the dark block (chat convention + prior default-skin
  ruling), with the warm papers as the full light sister theme.
  Chat canvas: desk is the app ground; paper is panels/modals/inputs;
  desk-dot makes the dotted desk texture where a quiet zone shows.

-- Type: the forum's stacks, no downloads --
  Body/UI: "Trebuchet MS", "Segoe UI", sans-serif.
  Hand-drawn accents (display, server initials, empty-state flourish,
  brand moments): "Comic Sans MS", "Chalkboard SE", "Trebuchet MS", cursive.
  Reflective/editorial copy (rules gates, about pages): Georgia, serif.
  Mono (timestamps, ids, code): ui-monospace, "SFMono-Regular", Menlo.
  NO web fonts, NO woff2 bundling, NO CDN — the forum's stacks are system
  stacks; GC inherits them.
  Scale: 14px chrome / 13.5px chat body (chat line length ~72ch, wrap
  never stretch) / 18px panel titles / 28px display.
  Weight: Trebuchet 700 for strong labels; Chalkboard bold for display.

-- BUTTON LAW (the owner's "NO BUTTON SHIT" ruling) --
  The forum's exact button grammar: 2px solid var(--ink) border,
  border-radius var(--button-radius) (the wobble: 0.45rem 0.65rem
  0.4rem 0.55rem), min-height 2.75rem (quiet 2.4rem), gap 0.35rem,
  padding 0.55rem 0.9rem, font-weight 700, hover translateY(-1px)
  rotate(-0.3deg) micro-tilt, :disabled opacity .62.
  Four roles only: .button-primary (white on green), .button-secondary
  (--on-yellow on yellow), .button-quiet (green-ink on field, hairline
  border #87917e), .button-danger (white on coral / coral-dark hover).
  THE DISCIPLINE: a button is a COMMIT (send, create, delete, join).
  Navigation is links. Secondary affordances are quiet inline text or
  quiet buttons. NO icon-soup toolbars, NO pill chips, NO floating chip
  rows, NO button-per-row-of-list. A list row offers itself (hover
  quiet-hover), never a button inside it. The compose riders (emoji/GIF/
  soundboard) are small quiet icon buttons INSIDE the compose well —
  the only icons that get button treatment anywhere in the chat surface.

-- Layout (three panes; forum grammar) --
  [server rail 72px paper] [channel+DM rail 250px paper] [main desk | members 240px paper]
  Rails carry the 2px-ink-border grammar at their outer edge only (no
  inner borders); panels separate from the desk by line, not shadow —
  the forum uses NO drop-shadow kit (paper-shadow is a flat depth tone,
  usable as a 2px undersurface, never a blur).
  Server rail: Chalkboard initials tiles, 2px ink border, active = green
  border + soft-green tint; unread ping = yellow tile dot. Home door tile
  = WEMPO (persona ruling). Add-server = one quiet + tile at the foot.
  Channel rail: 12px 700 caps section rows (channels, voice, DMs, inbox),
  hairline rules between sections — the forum's field/field-line pair for
  the section chrome; unread channel = yellow left tick + count pill
  (desk-dot outline, ink text).
  Main pane: channel header row with muted metadata hairline below;
  messages as compact forum comment rows (no bubbles): avatar + ink name
  + muted time, group only on day/author change; day dividers as
  hairline + tiny muted date.
  Composer: one paper well with field-line border; riders inside it.
  Empty states: one Chalkboard sentence + one quiet button for the next
  action, Blaxel decorating — never mood boards.
  Radius: the forum's wobble on controls; panels 0.6rem; pills 999px
  ONLY for status dots/unread counts.
  Alignment: everything left-aligned. Focus ring: #0758c9 (the forum's
  focus), always visible on keyboard nav.

== ARCHITECTURE (new client) ==
  public/index.html    rewritten, same stamp contract + theme-preload
  public/styles.css    from zero: tokens → base → components (one layer
                       order; component sections clearly separated so
                       wave builders append without selector fights)
  public/js/theme-preload.js  pre-paint theme setter (tiny)
  public/js/main.js    boot: stamp check → store init → router mount
  public/js/core/api.js       fetch wrapper: CSRF, error shapes, 401 → door
  public/js/core/store.js     state + subscriptions (the ONLY cross-module bus)
  public/js/core/router.js    History-API routes, params
  public/js/core/dom.js       element builder (one h() helper)
  public/js/ui/shell.js landing.js chat.js composer.js members.js
            settings.js expressions.js social.js economy.js mod.js
Rules: no module reaches into another's DOM; state reads go through store.js;
API calls go through api.js (never raw fetch); every cap number the UI shows
is imported from the backend-provided caps payload or mirrors constants.mjs
exports with an equality pin test.

== BUILD ORDER (team waves) ==
  W-R1 core + shell + landing + chat + composer (minimum visible app)
  W-R2 members + social + settings (user, server, channels, roles, invites)
  W-R3 expressions + economy + mod + the riders' depth
Each wave: new tests pinning its files (the OLD frontend pin tests are
deleted with the old files and re-pinned here), then the ritual build.

== VERIFICATION (NO PLAYWRIGHT — standing) ==
  Pins (node --test) per module · curl byte checks (stamps, headers, CSP) ·
  read-only D1 spot checks · the owner's eyes for final visual judgment.

== THE RETHINK (owner 08:34: "AND JUST RETHINK EVERYTHING" + 08:35 forum
 ruling) — ten decisive calls; they refine everything above where they touch.

 1. GooberCord is the forum's CHAT WING, not a Discord clone. Function =
    Discord-shaped (chat that works like chat muscle memory); identity =
    the forum's. Copy function, never cosplay visuals.
 2. ONE SURFACE MODEL: everything is a ROUTE (URL-addressable task pages in
    the shell), never nested dialog farms. Dialogs ONLY for a single fast
    confirmation (delete/kick/leave). Every management area is a page with
    a back affordance and its own heading. A builder reaching for a dialog
    stack is building the wrong thing.
 3. Navigation: three panes stay. The rail's home door is WEMPO (standing
    persona ruling). The channel rail unifies: channels, DMs, + the MENTIONS
    INBOX as a real rail item with an unread count (never a buried bell).
 4. First run is ONE screen: "You're in." Join with an invite link/code or
    create a server. Nothing else until they choose. Never a feature dump.
 5. The landing door: Blaxel greets; one line of what this place is; ONE
    primary button: "Sign in with your Wempo Account". No feature grid.
 6. Empty states are instructions: one sentence + the one next action.
 7. The economy is ambient: coins balance lives in the member footer and
    the quick-switcher line; the shop is a rail-level route. Earning toasts
    once a day and never nag. Goober+/boost status renders where the perk
    binds. Coins ARE the forum's yellow (the sink's color, already).
 8. Progressive disclosure in the composer: the 4000-char meter appears
    only past 1800; riders surface only where the member has the
    perk/channel. Defaults stay quiet.
 9. Manage = ONE task page per server (/channels, /roles, /invites,
    /mod AutoMod·bans·prune, /settings) — reachable from ONE gear at the
    channel-rail top. Not five dialog trees.
10. Unreads are a system, not a color: yellow server-rail dot (level 1),
    channel pill (level 2: count), global inbox (level 3), read markers
    clear them in order. The shell owns the levels; builders consume the
    store's unread API.

== BLAXEL + WEMPO (standing persona rulings, carried into the new client) ==
BLAXEL (axolotl, public/assets/blaxel.png) decorates CONTENTS: the landing
greeting, empty/loading/error states. WEMPO (Roblox avatar, wempo.png)
marks the DOOR (rail home tile) and speaks system messages (welcomes/mod
notices). Never both in the same moment's voice.
