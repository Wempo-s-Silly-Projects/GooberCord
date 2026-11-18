# Wave plan — localization order across the fleet

Source counts from the inventories in this directory (unique client rows +
server-class strings, per `inventory-<repo>.md`).

## Baseline counts

| product | repo / path | unique client strings | server-class strings | total keys proposed |
|---|---|---|---|---|
| gc (legacy) | /Users/itswempo/GooberCord (main — being replaced) | ~708 | 321 | ~1,000 (NOT swept — see ordering law) |
| **gc (rewrite)** | /Users/itswempo/gc-rewrite @ `rewrite` | ~297 | 314 | ~611 |
| forum | /Users/itswempo/forum-5.0 | ~455 | 276 | ~731 |
| acct | /Users/itswempo/wempo-accounts | ~58 | 38 | ~96 |

Fleet total (sweepable products): ~1,438 proposed keys.

## Ordering law

The legacy GooberCord client is being REPLACED by the rewrite branch — **its
~708 client strings are NOT swept**; its `inventory-gc-main.md` stays as the
archaeology record only. All client-side i18n effort lands in `gc-rewrite`
first (it is the future client), then forum, then accounts.

## Wave 0 — kit (no languages)

- frontend-dev lands `public/js/i18n.js` + `public/locales/en.json` per
  catalog-design.md; en.json keyed from `inventory-gc-rewrite.md`.
- Deliverable: the loader module + `t()` sweep of the rewrite client
  (~297 keys, en-only). Nothing user-visible changes in English.
- Server strings stay English-answered (client maps them by key).

## Wave 1 — Spanish (es) + German (de)

- **es**: largest reachable growth base in the plan, and the lowest-cost
  first-language proof (Latin script, CLDR two-branch plurals, right-to-left
  machinery untouched). Scope: gc-rewrite (~611 keys incl. the server-mapped
  error set) + accounts (~96 keys — small product, full fleet "all products"
  proof in one wave).
- **de**: second language ships in the same wave to prove the fallback chain,
  the plural-branch table, and a non-`es` bundle shape (compound-word lengths
  stress the layout/CSS harder than es).
- Count per wave-1 product: es = 611 + 96 = **707 keys**; de same.

## Wave 2 — fr, pt, ru

- fr adds ~460 keys (forum ~455 client rows wave: forum localization starts
  here). pt follows fr (shared Latin-script pipeline, two-branch plurals).
- ru is the wave's stress test: `_few/_many` plural branches + Cyrillic + the
  relative-time stamp rewrites.

## Wave 3 — ja, zh-cn, zh-tw

- CJK: no plural branches (cheap), but the composer/username-length copies
  that say "12–128 characters" need script-aware phrasing; zh-cn and zh-tw are
  two bundles, not one with a script flag (glossary rows separate).

## Wave 4 — right-to-left wave: ar

- First RTL. Only wave that touches layout CSS (`dir="rtl"` pass), so it is
  deliberately alone and late; the glossary's ar rows gate it.

## Wave 5+ — hi, tr, then the ~50-language long tail

- hi, tr ride wave 5 with the wave-1 lessons applied; the remaining target
  languages fan out after the loader has proven itself through 4 scripts
  (Latin, Cyrillic, CJK, RTL) — each new language is a bundle file plus a
  glossary rows update, no code.

## Per-wave gates (every wave)

1. glossary rows updated for the wave's languages FIRST.
2. bundle complete against its inventory (zero `en`-fallback keys in the
   product's core flows: auth, composer, errors).
3. axe pass unchanged, layout rechecked at the wave-1 length stress level.
4. fallback chain proven: delete 3 random keys from the bundle → page still
   renders, dev console logs the misses.

## Sweep ledger — gc-rewrite (reviewer riders, Nov 17)

The dedicated review pass on the loader (commit 80278d4) ruled SHIP and left
three riders which live here:

1. **Painter rider** — if a sweep commit touches a surface where the
   one-paint first-paint window becomes visible (a slow en force-cache fetch
   leaving bound `data-i18n` nodes humanized for a paint), that commit adds
   the `applyDom()` call at en-bundle resolution. Never preempted across
   modules — each surface's commit carries its own painter call.
2. **Count keys** — when a sweep commit adds its FIRST plural/count key to
   `en.json`, that commit's en.json gains the `_one`/`_other` branches there
   (the first in-bundle exercise of the plural seat) and pins the pick in
   its test file.
3. **fr plural rule (before any fr bundle ships)** — fr's CLDR one-branch
   includes 0, but the loader currently maps every non-listed language to
   the en two-branch rule. The commit that first ships a `BUNDLE_LANGS`
   entry for fr must add the fr rule in `i18n.js`. No code change until
   then; noted so wave 2 cannot skip it.

## Sweep ledger — committerows (frontend-dev)

| commit | module | pin conversions (literal-pinned → key-pinned) | new keys |
|---|---|---|---|
| 726fe5f | main.js | tests/main-build.test.mjs: the strip copy + the Reload pin primed to the en bundle; literals assert now via `t()` seats + en.json values ("the sweep carries no copy" test added) | gc.boot.stale.reload |
| f189b24 | shell.js | tests/ui-shell.test.mjs: the first-run heading + next-action pins re-seat to `t("gc.shell.home.heading"/"body")`; tests/ui-ws.test.mjs: the G-9 strip paint stub made locale-aware + initI18n prime (the copy is "Reconnecting…" through `t("gc.shell.reconnecting")`) | 11 chrome keys (nav.short seats, fallback titles, Reconnecting…, loading …) |
| (sweep #3) | social.js | tests/ui-social.test.mjs: the null-username `member ${block.userId}` pin re-seats to `t("gc.social.blocks.member", { id })` | 22 keys (row labels, presence pair split, gc.controls.* back/set/keep/save/leave/stay/rename — shared seats later modules reuse) |
| a22f62a + 881242d | chat.js | tests/ui-chat.test.mjs: three literal pins re-seat to keys — the pending seat (`t("gc.chat.attach.pending")`), the attach refusal (`t("gc.chat.attach.one")`), the slowmode meter (`t("gc.chat.slowmode.wait", { seconds: left })`) | 25 keys (row labels, reactions heading, voice join/leave/mute/unmute, riders' titles, gc.controls.* done/more/send/retry/remove/search/fetching + back) |
| a0ec50b | (pin fix) | the pin/unpin pair's VALUES were swapped in en + the es/de pair (row.pin "Unpin"/"Fijar"-inverse, row.unpin inverse); the chat.js call site was always lawful, so the fix lands value-side with the seat pinned | 0 keys — value swap on 3 bundles |
| f08b80b | settings.js | tests/ui-settings.test.mjs: five literal pins re-seat 1:1 — the one-pool line (channels.full), the read-only arm (overwrites.readOnly), the invite-choices walk (expiry/uses label regex against the key seats + the use caps gain their own window pin), the echoed-counts (danger.done), the 403 inline (errors.permission); a two-part pin adds the seed values byte-equal + the cross-area reuse seats and a leftover-literal scan | 42 keys + 1 token reshape (invites.fresh gains {{code}}) — manage nav + task titles (nav.server/nav.expressions/roles.heading/roles.editor/invites.heading/overwrites.heading), General, Discovery, fields.name/position (the four Name fields unify), channel kind/text/voice/slowmode/off/spoiler, categories heading/create, roles colorHelp/you/owner/held/assign/fetchingRoster, overwrites order/clearAction, the invite expiry+uses choice keys, never/uses/usesOf/by/revoked, join.submit dropped in favor of gc.voice.join |
| 23ec4d3 | mod.js | tests/ui-mod.test.mjs: fourteen literal pins re-seat 1:1 (termsPlaceholder, exemptRoles/careFlag/screenNicknames, automod.full, alerts.empty + the channel placeholder with its unknown arm, prune.confirm/candidates, kick.note, markVerified, rejectNote, queue.empty, the 403) plus the collapse proofs (the three mod-side seeds asserted absent) and the leftover-literal scan | 24 keys (editTail/noActions/careSuffix/termsLabel; alerts.heading/unknown/matched; bans.heading/unban/button/open; prune.heading/days7/days30/anyRole/result; queue.approve/reject; timeout.label/choice/apply; card.heading; kick.open/button) + 3 collapsed seeds dropped (gc.mod.errors.permission → gc.settings.errors.permission, gc.mod.heading → gc.settings.sections.mod, gc.mod.bans.member → gc.social.blocks.member) — en.json 378→399, es/de realign rider: 24 adds + 3 drops + the token rows |
| 10f979c | members.js | tests/ui-members.test.mjs: the roster-alone pin re-seats to `t("gc.members.roster.alone")` plus two new pins (byte-equal seed values + collapse proofs, the leftover-literal scan with the Goober+ brand carve-out) | 6 keys (timedOut, timedOutUntil, rulesAccepted, verificationPending, nicknameHeading, nicknameHelp) + 2 collapsed seeds dropped (gc.members.card.friendsHeading → gc.social.friends.heading, gc.members.roster.fetching → gc.settings.roles.fetchingRoster) + gc.members.card.accountMade/joined/viaInvite/owesVerification/notesHeading wiring — en.json 399→403, es/de realign rider: 6 adds + 2 drops |
| a38c43f | expressions.js | tests/ui-expressions.test.mjs: six pins re-seat 1:1 (boost-tier count line + intro, deleteBytes, errors.full, inventory.empty + first, the 403) plus the byte-equal/collapse/dynamic-seat pins (t(kind.labelKey), t(kind.nameHintKey)) and the literal scan (blank capLine carve) | 6 keys (kinds.emojis/stickers/sounds, intro, upload, inventory.used) + 1 collapsed seed dropped (gc.expressions.errors.permission → gc.settings.errors.permission) — en.json 403→408, es/de realign rider: 6 adds + 1 drop |
| e6bd6f4 | rules-gate.js | tests/ui-rules-gate.test.mjs: a new pin — the four gc.gate.* values byte-equal + all four call sites; GATE_MESSAGE pinned STILL LITERAL (the server's own 403 bytes — never localizes, the seed stays a catalog row, no call site) | 0 keys, 4 call sites |
| 5a78b15 | landing.js | tests/ui-landing.test.mjs: the six gc.auth.* refusal-card values pin byte-equal + call sites | 0 keys, 6 call sites (both commits land 1103 total, not the 1104/1106 first typed) |
| 2bd17da | economy.js | tests/ui-economy.test.mjs: eight pins re-seat 1:1 (claim.button, plus.pitch, plus.grace, gift.priceNote, ledger.empty, history.older, plus the shop-route seat additions) plus the byte-equal/collapse/brand pins and the literal scan (Goober+ carve) | 10 keys (buy.button, items.heading/owned/cost, cosmetics.apply, gift.button/unnamed/section, ledger.heading, claim.ambient) + 1 collapsed seed dropped (gc.economy.ledger.older → gc.chat.history.older per the canon ruling) — en.json 408→417, es/de realign rider: 10 adds + 1 drop |
| f8240cd | core/api.js | tests/core-api.test.mjs: the blessing's batch — the transport's two failure words ride t("gc.errors.invalidResponse"/"gc.errors.requestFailed", {{status}}) with the en values pinned byte-equal, no rewording, no vanished pins (none existed); the verbatim law pinned: result.error passes through untouched and CSRF_STALE_PREFIX stays the server's bytes (recognition, never copy — rules-gate's law again) | 0 keys (both seeds rode gc.errors.*), en.json stays 417 — the sweep's lane ends: rewrite at f8240cd, suite 1106 |
| 73be38c | (orphan drop) | tests/ui-mod.test.mjs: the absence + no-reference law pinned (key absent from the canon, mod.js and i18n.js carry no "boundNote") | 1 key REMOVED — the gc.mod.rules.boundNote orphan seed dies (comment-only literal, zero call sites since the loader build); en.json 417→416 at rewrite 73be38c; es/de copies drop on the localizer's next realign after that sha; rewrite origin gained 01863bb beneath the drop (not frontend's) |
| 649eb94 | (rider 1) | both ui-settings and ui-mod seat scans gain the fourth arm (/, "(Clear|Delete|Revoke|Save|Keep|Done|Apply)",/) so positional confirm labels can never escape; gc.errors.tokenStale absent-pinned in core-api.test.mjs (recognition rides api.js's literal — the GATE_MESSAGE law) | 1 residual literal seated (settings.js:364's positional "Delete" → gc.chat.row.delete) + 1 dead seed dropped (tokenStale out of the canon) — en.json 416→415 at 649eb94 (origin gained 141ae81, not frontend's) |
| 7e2ca20 | mentions.js | tests/ui-mentions.test.mjs: the bundle + call-site + reuse pins and a literal scan (the channel-name fallbacks pinned to their keys) | 5 keys (inThread/threadUnnamed/inChannel/channelUnnamed with {{channel}} tokens, dismiss) + 1 reuse (gc.shell.nav.mentionsShort paints the heading) — en.json 415→420 at 7e2ca20, suite 1110/1110 (the commit message's 1109 was a miscount). TRUE LANE END: every public/js module speaks only t() + data. |
| 1bcfa9e | (wave-2 gate: i18n.js loader) | tests/i18n.test.mjs: the fr/pt arithmetic pin rides the ru/ar way (tiny seeded bundles through the full t() chain) — fr 0→one / 1→one / 2→other / 1e6→other, plus 0.5→one for the 0.0–1.5 decimal arm; pt 0→one (the en-map would fail this line red) / 1→one / 2→other | 0 keys (en.json stays 420), 2 rules seated: fr(n) + pt(n) both `n >= 0 && n <= 1 ? "one" : "other"` — CLDR fr/pt one includes 0 ("0 image" is grammatical), the range form so the decimal arm rides; pt's ~1e6 exponent "many" arm ruled OUT in the commit (the loader never writes exponent notation into a count key), so the reviewer's original fr LOW expires at 1bcfa9e, fr/pt bundles staged on top of this sha route 0 correctly. Suite 1111/1111. |
| 46f70fa | (rider refinement + seam: i18n.js loader) | tests/i18n.test.mjs: the corrected arithmetic (fr 0/0.5/1.5/1.9→one, 2→other, 1e6→many w/ 1500000+1000010+999999→other; pt 0/1→one, 2→other, 1e6→many) + a vars.count seam pin ({{count}} grammar keys route one/other/many under fr) + a bare-fallback pin (branch-less en/es/de rows unchanged) | 0 keys (en.json stays 420), two loader truths: (1) 46f70fa CORRECTS 1bcfa9e's ruling against the real CLDR 47 text — the shared locales="fr pt" block is one = i = 0..1 (read 0 ≤ n < 2, so 1.5/1.9 are singular-shaped — the rider refinement's decimal arm) and many = v=0 ∧ i≠0 ∧ i%1e6=0 (exact round millions: 1000000/2000000/10000000/35000000 → many; 1500000/1000010/1000000.5 → other — the lead brief's "1e6→other" and 1bcfa9e's "exponent-only" sentence both predate this; probe trail vs Intl.PluralRules cited in the commit; deviation = ICU's 3-digit operand fold slivers [1.9995,2)/[999999.9995,1e6), stated, unreachable); (2) THE PLURAL SEAT WAS DEAD CODE: t() engaged only on vars.n, zero {{n}} keys exist in any bundle and zero call sites pass vars.n — every grammar key interpolates {{count}} — so the rule table and the localizer's staged fr/pt/ru _one/_other(/_few/_many) rows could never fire; t() now engages vars.n OR vars.count, count-neutral/branch-less keys ride the bare-row fallback unchanged (pinned). COPY-LANE FOLLOW-UP (stated, not this commit): en/es/de bare grammar rows ("{{count}} usos"/"members" class) render plural-form at count 1 — the seven grammar keys need en/es/de branches or singular rewording on the copy lane. Suite 1112/1112. |









### Dedupe ruling (lead's save rider, confirmed in sweep #4)

- `gc.controls.save` has NO twin — it is the only bare-"Save" key; the
  context-typed saves ("Save rule", "Save role", "Save settings", "Save
  status", "Save nickname") are different strings, not synonyms. Nothing to
  merge.
- The remaining twin families came from the inventory's per-FILE rows and
  collapse per the same law as each module's sweep lands, reusing the
  first-swept key: chat.js already reuses `gc.shell.nav.dm` ("Direct
  messages"), `gc.chat.history.older` sits as the canon for economy's
  "Load earlier", `gc.chat.search.placeholder` is the "Search this server"
  heading's seat too. The permission trio (expressions/mod/settings), the
  "Mod desk" pair, "Friends & DMs" pair, "member {{id}}" pair and the dm
  placeholder pair collapse at THEIR modules' swept commits — en.json ends
  smaller, localizer realigns per its protocol.
- Symbol-only glyph seats deliberately stay code-side (the riders' 🖼/☺/▣/♪,
  the dialog hold's "…") — punctuation and pictographs, not translated copy.

### The pin/unpin coherence fix (bundle-side slip, found at the seat)

- The chat row's hover control called the keys RIGHT (`pinnedFlag ?
  t("gc.chat.row.unpin") : t("gc.chat.row.pin")` — a pinned row offers the
  unpin action) but the bundle seeded the pair's values swapped: en
  `gc.chat.row.pin: "Unpin"`, `gc.chat.row.unpin: "Pin"`, and the es/de pair
  mirrored the slip (es row.pin "Quitar el fijado", de row.pin "Lösen") when
  7021e3a seeded the sweep keys. Every pinned row offered "Pin", every
  unpinned row offered "Unpin" — rendered wrong-by-accident, right only if
  the call site ever flipped too.
- Fix lands value-side (the call site was always the lawful one): en row.pin
  "Pin" / row.unpin "Unpin", es "Fijar" / "Quitar el fijado", de "Anheften" /
  "Lösen" — {name,value,call-site} coherent. Pinned in
  tests/ui-chat.test.mjs: the two values byte-equal plus the call site's
  pinned→row.unpin order.

### Riders from the settings sweep (f08b80b)

- **es/de realign needed**: en went 336→373 with the 37 new keys plus the
  invites.fresh token reshape ("Fresh invite:" → "Fresh invite: {{code}}") —
  the pair needs the 38 rows at least, and the realign-per-sweep-push
  protocol's holding-keys rows for the token gain a row.
- **The invite choice labels resolve at render time**: the old
  INVITE_EXPIRY_CHOICES module consts froze labels at boot; the sweep moved
  the label mapping into inviteExpiryChoices()/inviteUseChoices() functions
  with statically named keys (the catalog and pins read the keys) — choice
  VALUES are data, labels are copy. The test's choices walk now greps the
  static key seats.
- **Twin collapses at this commit**: the four "Name" form fields unify into
  gc.settings.fields.name; "Position" (label) rides gc.settings.fields.position
  while the row-meta line keeps roles.position (label ≠ rendered line);
  "Delete"/"Edit" reuse gc.chat.row.delete/edit (chat swept first);
  "Channels" nav + title reuse gc.shell.nav.channels; the invite door's
  "Join" reuses gc.voice.join. gc.controls.* stays CLOSED — nothing joined
  it this sweep.
| 4570a38 | (fix-verdict pin symmetry, tests/i18n.test.mjs only) | fr gains 1.2→one (red-capable under any n<=1 predicate); pt mirrors the (1,2) boundary: 1.2→one, 1.9→one | 0 keys (en.json stays 420). The reviewer's fr/pt FIX verdict raced 46f70fa (it targeted the 1bcfa9e predicate); 4570a38 is only the verdict's requested pin symmetry — the verdict's remaining demands (n>=0 && n<2, mirrored boundaries, honest many-arm rationale, no BUNDLE_LANGS growth) were already landed at 46f70fa. The reviewer's fr LOW expires at 4570a38; localizer bundle batch can gate on this sha. Suite 1112/1112. |
| b663405 | (es arm + unreachability law, i18n.js loader) | tests/i18n.test.mjs: es pins 1→one / 0→other (red under any fr-style arm) / 1e6→many (red under the en fallback) / 1.5→other / 2000000→many / 1000010→other via the seeded-bundle pattern | 0 keys (en.json untouched at this commit), 1 rule seated: es(n) = one at exactly n=1, other at 0/fractions/non-round-millions, many at exact round millions (ICU fuzz-truth v. the reviewer: 1000000/2000000/35000000 → many; the n===0 guard is the fr/pt divergence). Comment law added: counts are non-negative (negatives unreachable — ICU es -1000000 → many, -1 → one, -1000000.5 → other, all consistent with the seated arm) and the ru seat's fractional/negative unreachability ruling stated (ru 0.5 → other, pre-existing, fuzz-clean, unchanged). En route to this SHA the localizer's wave-2 batch c78a8d6 (fr/pt/ru bundles for the 420-key canon) landed beneath — cleanly stacked, suite green. Suite 1112/1112. |
| cd378e1 | (en grammar ride, adjudicated) | ui-economy.test.mjs + ui-mod.test.mjs + tests/i18n.test.mjs scheme widening (a trailing CLDR plural arm is the one lawful key suffix) + ui-settings.test.mjs | en.json 420→425 — THE ADJUDICATED GRAMMAR LIST IS SIX SEATS; FIVE FLEXED (each _one pinned byte-equal beside its bare row in its module's test file): gc.economy.claim.button_one "Claim {{count}} coin", gc.economy.items.cost_one "{{count}} coin", gc.mod.prune.confirm_one "Prune {{count}} member?", gc.settings.invites.uses_one "{{count}} use", gc.settings.join.serverRow_one "Join {{name}} ({{count}} member)". THE SIXTH, gc.settings.invites.usesOf, judged NUMERAL-SAFE (its flexed noun attaches to {{max}} — "1 of 5 uses" elliptical-grammatical) and stays branch-less, ruling stated. ALSO SKIPPED numeral-safe: gc.mod.prune.result, gc.chat.rail.inHere, gc.mod.timeout.choice; composed cap rows channels.full/roles.count/rules.count branch-less per census. en rule picks _one at exactly count 1 (definition). LOCALIZER RIDER: es/de realign mirrors the five _one rows. Suite 1112/1112. |
| 0e5c344 | (carve-gate durable pin, tests/i18n.test.mjs only) | exhaustive per-bundle lists (es 10 / de 16 / fr 15 / pt 9 / ru 5 byte-equal-to-en rows) asserted set-exact in BOTH directions against a live scan of the staged files; classes-name/keys-enumerate reconcile note rides the comment; build-loop invariant stated (a branch-row rebuild never iterates en's full keyset as fallback — the 18b4b47 ordering-overwrite class; rebuilds touch only the branch-gaining keys, appending without reordering) | 0 keys, no bundle bytes. Scan-proven: es/de reproduced the reviewer's census key-for-key (zero diffs); fr/pt/ru enumerated by this scan. Red in both directions: an equal-but-undeclared copy or a flex of a carved row (de "Roles" someday) fails until the list updates with its ruling. Suite 1113/1113. |
| 93fd6b2 | (carve-gate wave-3 extension, tests/i18n.test.mjs only) | ja [mentions.loading] and zh [expressions.emojiTitle, kinds.emojis, mentions.loading] join CARVE_GATES — the 2c41d75 declarations, reviewer-scan-verified at 5e0140e | 0 keys, no bundle bytes. My live scan reproduced both lists key-for-key (zero diffs). ja/zh gate-visible set-exact both directions. Suite 1113/1113. |
| 46106e1 | (carve-gate ar extension, tests/i18n.test.mjs only) | ar [gif.short, mentions.loading] joins CARVE_GATES — the 212c883 declared two, reviewer-scan-verified | 0 keys, no bundle bytes. My live scan reproduced key-for-key (zero diffs — same set declared third time running). EIGHT locales en+es/de/fr/pt/ru/ja/zh/ar all gate-visible set-exact both directions; the i18n lane's wave structure ends (further locales = routine intake, same laws). Suite 1113/1113. |
| 1b9eaa8 | (§13 source seat, shell.js + en.json + tests/ui-shell.test.mjs) | the new test pins the GOOBER_SOURCE_URL const (canonical repo, remote-verified), the footer href seat, the key and the rel; en.json +1 | gc.shell.user.source ("Source (AGPLv3)") — the AGPL §13 source-offer as a quiet anchor in the shell's user footer beside sign-out, visible on every signed-in screen; en.json 425→426; ships at cutover (GC MAIN's live UI blocked this turn). LOCALIZER RIDER: es/de/... realign mirrors the one new chrome key. DISCLOSED (env, not this commit): the twin-loss harness drift — /Users/itswempo/wempos-forum is gone (forum-5.0 is the new home; auth.mjs already diverges), six byte-clone tests red identically with the commit's files stashed; harness repair = a ruling, not a path constant. Suite: 1108 pass / 6 env-fail of 1114. |

## DRAFT — ko + id glossary rows (T74, staged 2026-11-17)

The three-term rows for ko and id STAGED here as a draft, not promoted: the
wave-start pass (per-wave gate #1) validates and formalizes them in
docs/i18n/glossary.md — a draft row is a starting ruling, not law yet. No
bundle edit rides this section; the BUNDLE_LANGS stage gates stay exactly as
declared (no ko/id stage open). The term cells below mirror
glossary.md's expanded table — no divergence between the two docs is
intended; any conflict at validation time resolves toward glossary.md as the
approved copy.

| term | ko | id |
|---|---|---|
| free (libre) software | 자유 소프트웨어 | perangkat lunak bebas |
| gratis software | 무료 소프트웨어 | perangkat lunak gratis |
| proprietary software | 사유 소프트웨어 (독점 소프트웨어 in the freedom contrast) | perangkat lunak berpemilik |
| AGPLv3 | AGPLv3 (verbatim) | AGPLv3 (verbatim) |

Draft register notes:

- **ko register (DRAFT)**: 존댓말 -요 prose throughout (the same product-polite
  spirit ja's です・ます row ruled); buttons and row controls ride the plain
  noun form (저장/삭제 style) with no imperative sentence endings — declared
  once and held if validated. 자유 (freedom) vs 무료 (free-of-charge) is the
  never-collapse pair; 사유 is the UI row and 독점 only where the contrast to
  자유 is drawn explicitly, per glossary.md's expanded-table note.
- **id register (DRAFT)**: formal "Anda" (the standard software you-form,
  not the slangy "kamu"); no colloquial contractions in product copy. The
  pair pair holds: "bebas" is ONLY the freedom row, "gratis" is ONLY the
  price row — collapsing either erases the free(gratis) distinction the
  glossary's wording laws are built on. "berpemilik" rides as the settled
  proprietary form, per the expanded-table note.
- **no plural branch rows (DRAFT, ko + id both)** — per glossary.md's
  ja/zh no-arm law, count copy ships composed numeral-safe; the loader's
  seat lookup falls through to the en map for unlisted languages, and the
  key_other → key chain lands each bare row. No rule table edit and no
  branch gate rides this draft; if validation contradicts, the wave-start
  pass re-rules it in glossary.md, not here.
- **wave-5 fit**: the wave-plan assigns hi/tr to wave 5; ko/id stage here
  ahead of that intake with this same draft-first protocol — rows validate
  at their wave start, before a single key of their bundle is translated.

## T72 glossary draft rows — it + nl (DRAFT, UNRATIFIED, 2026-11-17)

Draft staged by tr-dept-1 at team-lead order; these are NOT glossary.md law
until the wave that fields it/nl ratifies them in wave-start pass. The
three-term frame stays the glossary's own (free (libre) / gratis /
proprietary, never collapsed into "free").

| term (en canon) | it | nl |
|---|---|---|
| free (libre) software | software libero | vrije software |
| gratis software | software gratuito | gratis software |
| proprietary software | software proprietario | proprietair software |

Draft register notes (ratification checklist):

- **it** — "libero" (freedom) vs "gratuito" (price) is the settled Italian
  community pair; never accept "gratuito" for the freedom row, and never let
  "gratis" (familiar price register) replace "gratuito" in product copy. If
  the it bundle ever fields, the product register is the informal "tu"
  (Italian product convention; never "Lei" in this product's voice).
- **nl** — "vrij" is the freedom row even though Dutch everyday "gratis"
  dominates the zero-cost collocation; the pair never collapses to "gratis
  software" for both. The proprietary cell is DRAFT-disputed: this draft
  picks "proprietair software" (indeclinable adjective, no final -e) over
  "onvrije software" (negative-contrast form) — pick one at ratification,
  hold it. Dutch copy drifts to the English loan "proprietary software";
  the loan is NOT an acceptable cell (untranslated seat, same class as the
  es raw-"Server" seat the register audit flagged).
- **Relation to the glossary.md expanded table**: the seed rows for it
  (software libero / gratuito / proprietario) already match this draft —
  ratification is a copy of them into the approved table's notes. The seed
  nl proprietary cell is raw English ("proprietary software") — the
  ratification pass REPLACES that cell with whichever term is ratified here;
  the cell must not survive another wave untranslated.
- **AGPLv3** stays verbatim in both (standing law, not restated as a row).

## T75 glossary draft rows — vi + sv (DRAFT, UNRATIFIED, 2026-11-17)

Draft staged by tr-dept-4 at team-lead order; these are NOT glossary.md law
until the wave that fields vi/sv ratifies them in wave-start pass. The
three-term frame stays the glossary's own (free (libre) / gratis /
proprietary, never collapsed into "free").

| term (en canon) | vi | sv |
|---|---|---|
| free (libre) software | phần mềm tự do | fri programvara |
| gratis software | phần mềm miễn phí | gratis programvara |
| proprietary software | phần mềm độc quyền | proprietär programvara |

Draft register notes (ratification checklist):

- **vi** — "tự do" (freedom) vs "miễn phí" (zero-cost) is the settled
  Vietnamese free-software community pair; the freedom row is never "miễn
  phí", and the zero-cost row never borrows "tự do". "Tự do" unmarked can
  read generically ("free/freedom") in everyday Vietnamese — the product
  copy keeps the compound "phần mềm tự do" so the libre sense never walks
  bare. Proprietary cell is "độc quyền" (exclusive/monopoly-grip) — the
  community-settled negative-contrast form; no English loan.
- **sv** — "fri programvara" is the GNU Svenska-settled libre row
  ("fri" as in freedom); "gratis" is the price row, never the freedom row.
  Unlike English, the pair does not lean on a single polysemous word —
  Swedish "gratis" already covers zero-cost on its own, so "fri" does not
  need a "(libre)" disambiguator riding it; the distinction survives
  unaided. Proprietary cell: "proprietär programvara" — settled form; the
  variant "proprietär mjukvara" (mjukvara/programvara both read "software")
  is a ratification fork — this draft holds "programvara" to match the fri
  and gratis rows' noun, and the ratification pass binds whichever is picked
  across all three cells.
- **Relation to the glossary.md expanded table**: the seed rows for vi and
  sv (phần mềm tự do / miễn phí / độc quyền; fri / gratis / proprietär
  programvara) already match this draft — ratification is a copy of them
  into the approved table's notes, no cell replacement needed (no
  untranslated-seat hazard in either language's seeds).
- **AGPLv3** stays verbatim in both (standing law, not restated as a row).

## T73 glossary draft rows — pl + uk (DRAFT, UNRATIFIED, 2026-11-18)

Draft staged by tr-dept-2 at team-lead order; these are NOT glossary.md law
until the wave that fields pl/uk ratifies them in wave-start pass. The
three-term frame stays the glossary's own (free (libre) / gratis /
proprietary, never collapsed into "free").

| term (en canon) | pl | uk |
|---|---|---|
| free (libre) software | wolne oprogramowanie | вільне програмне забезпечение |
| gratis software | darmowe oprogramowanie | безкоштовне програмне забезпечення |
| proprietary software | oprogramowanie własnościowe | пропрієтарне програмне забезпечение |

Draft register notes (ratification checklist):

- **pl** — "wolne" (freedom) vs "darmowe" (price) is the settled Polish
  community pair (the glossary.md expanded note); never accept "darmowe"
  for the freedom row, and never let "bezpłatny" or "gratis" (familiar
  price register) replace it there. If the pl bundle ever fields, the
  product register is the informal "ty" (Polish product convention; never
  "Pan/Pani" in this product's voice).
- **uk** — mirrors the ru community pair (вільне / пропрієтарне) with
  standard uk spelling (the glossary.md uk note, held); never copy ru word
  order. "безкоштовне" is strictly the price row, never the freedom row.
  If the uk bundle ever fields, the product register is the formal "ви"
  (Ukrainian product convention; "Ви" capitalized only in direct-address
  headers, never mid-sentence; never "ти" in this product's voice).
- **Relation to the glossary.md expanded table**: both seed rows already
  match the approved table cell-for-cell (pl: wolne / darmowe /
  własnościowe; uk: вільне / безкоштовне / пропрієтарне) — this draft
  stages the register picks for ratification; term cells are sourced from
  the approved expanded table, not re-invented here.
- **AGPLv3** stays verbatim in both (standing law, not restated as a row).
