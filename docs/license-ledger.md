# License pass ledger — GooberCord

The per-repo record of the AGPLv3 program: COPYING/README landings, per-file
notice passes, and the ruled coordinated pairs. Rows carry the SHAs the
reviewer (and every future audit) traces back through. The forum twin of this
file carries the same pair row with both SHAs.

## GooberCord main

| SHA | Step | Verification |
| --- | --- | --- |
| f39bebd | COPYING (rename of the hand-wrap-drifted LICENSE) + README born with the section 13 line | gnu.org canonical diff-clean |
| 23ffd72 | COPYING's canonical bytes actually land (the rename-before-replace slip shipped the old tail) | `git show HEAD:COPYING` cmp gnu.org 661 lines / 34523 bytes |
| 6b9deed | 143-file per-file notice pass (worker, constants, api, api/core, tests), +18 insert-only | suite failure set = the 4 pre-existing WIP-fixture failures only |
| 027fc28 | Ruled allow-list extension, GC side: FORUM_PROJECT/GOOBER_PROJECT named constants in vendorize(), the once-per-file token bound asserted, the filter pin made substitution-aware | full suite at the 4-failure baseline |
| a04a96b | GC twin-header: the five parity-locked files noticed (partner = forum 54c52a5) | contract-parity + messages-module gates green post-pair |

## The ruled coordinated twin-header pair

| Side | Twin files | SHA | Named partner |
| --- | --- | --- | --- |
| wempos-forum | api/core/auth.mjs, passwords.mjs, totp.mjs, images.mjs, api/filter.mjs | 54c52a5 | GooberCord a04a96b |
| GooberCord | api/core/auth.mjs, passwords.mjs, totp.mjs, images.mjs, api/filter.mjs | a04a96b | wempos-forum 54c52a5 |

Law of the pair: the substitution allow-list carries the project-name pair as
named constants (forum: "Wempo's Forum", GC: "GooberCord" — the tokens come
from each repo's own COPYING/README wording, never invented); the notices are
byte-identical across the twin copies except each repo's own project-token
line; each twin carries its own token exactly once per file, asserted in the
extension commits (GC 027fc28, forum c8df23b) while tokens were absent
(no-op) and forever after (red on duplication or rebrand); exactly one repo's
gate held transient-red between the two header commits (GC's).

## Already-noticed strays (recorded, legal, no gate change)

GC-side api/core/crypto.mjs, api/core/http.mjs, api/core/cursors.mjs carry
notices since 6b9deed; no whole-file parity gate covers them (their twin
lineage is comment-only). Recorded here per the ruling.

## Board five — the rewrite line (GooberCord, branch `rewrite`)

| SHA | Step | Verification |
| --- | --- | --- |
| 44f191f | Ruled substitution extension + the RE-AIM: FORUM_PROJECT/GOOBER_PROJECT named constants beside the FORUM_DB/wempo_session pair; the shared-table SQL pin re-aimed CONTENT-ANCHORED (line set, not index — notices can never mis-index it again); the filter pin name-mapped gate-locally | the content-anchored test green in-commit; the five whole-file gates red only pending this line's notices |
| c1cc727 | Root docs: the THIRD hand-wrap-drifted LICENSE found (same two lines) — rename to COPYING + canonical bytes; README born (the token is the repo's own identity, GooberCord, the same repository's rewrite branch) | COPYING cmp-identical to GC main's committed canonical |
| cce36fc | 121-file per-file notice pass — the five parity-locked twins take the identical-template notice (substituted-equal to forum's, verified byte-for-byte before the landing); template punctuation CONVERGED to the ruled pair's no-period bytes (a 1-byte template split was caught by the substituted gate going red and green only after the byte landed) | suite exit 0 — the six baseline twin-clone failures driven to zero |

## Framework root (project-designer — kitskey name RETIRED 2026-11-18)

Owner order 2026-11-18: "remove all references to kitskey"; the framework
project was cancelled and its repo deleted. This board entry is kept as a
historical record with the naming amended; the framework itself no longer
exists as a dependency (api/vendor recoded fleet-owned 2026-11-18).

| SHA | Step | Verification |
| --- | --- | --- |
| 34b1c43 | COPYING (canonical bytes, root docs ONLY — no framework-file notices: the app repos' vendor pins hold designer/experience/frontload byte-identical, so a framework notice would red the pins outward-in) + README born with the section 13 line | remote kitskey/main COPYING cmp gnu.org canonical, 34523 bytes; no pre-existing LICENSE (nothing deleted) |

The framework-file notice question is recorded as DEFERRED: if ever ruled for
the framework, per-file notices must land as a coordinated multi-repo wave
that moves the vendor pins in lockstep — never in place.

## Straddling copies

wempo-accounts api/filter.mjs (third twin of the same body) took its notice
in 3102c49 with its own project token; its body remains byte-identical to GC's.

## The client addendum (the charter-visibility gap closes)

| SHA | Step | Verification |
| --- | --- | --- |
| 6568635 | 32 committed un-noticed in-scope client files take the notice — the pins/read-markers arc's committed set (public/js/pins.js, read-markers.js, routes/app.js, styles.css, tests/pins-client.test.mjs, tests/button-language.test.mjs; freed by the arc's SHIP verdict) + the 26 long-committed public/js modules (api, attachments, boot, chat-store, dom, expression-manage, gifs, icons, konami, mascot, mentions, pac-man, petting, plus-ui, rules-dialog, routes/admin, routes/backup-codes, routes/discover, routes/shop, soundboard, state, theme-preload, theme, ui-helpers, voice, wempo-friend-gag, ws) | insert-only +578 (31 .js x 18 + styles.css x 20 in /* */ form); suite 1412/1412, exit 0 |

## Template unification

| SHA | Repo | Step | Verification |
| --- | --- | --- | --- |
| 1ddf4ea | wempo-accounts | the punctuation convergence: all 23 notices (a96be09's 22 + the filter copy 3102c49) drop the one-byte trailing period on the gnu.org pointer line, matching the GC-main/forum/rewrite family's shipped template | suite exit 0; 23 files x one replaced line each |

The fleet's per-file notices are now SINGLE-TEMPLATED everywhere byte for byte:
"Copyright 2026 YourLocalGoober" / "This file is part of <OWN PROJECT TOKEN>." /
the license phrase contiguous in exactly three places / "version 3 ... any
later version" / the pointer line ending `see <https://www.gnu.org/licenses/>`
(no period), 17 lines plus one blank on .mjs, the same words in /* */ form on
.css.
