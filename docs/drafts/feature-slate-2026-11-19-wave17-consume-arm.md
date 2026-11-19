# feature-slate — wave-17: the coin shop's use arm (2026-11-19)

Through-line: the coin shop's consumable sink is fully live server-side —
POST /api/coins/cosmetics/consume (api/coins.mjs:991-1022, wired at
handleCoinRoutes:1236) spends one use of an owned consumable row (the
qty>0 arm IS the claim), and the equip arm (api/coins.mjs:929-990)
explicitly admits the burst pack for the effects slot (the reaction route's
burst arm spends only the EQUIPPED row). But the shop client paints equip
only for `kind === "own"` rows and carries NO use button — an owned burst
pack cannot be equipped or spent from any surface. This is the
wave-10/13/14/15/16 pattern: the surface the backend already earned.
Backend BYTE-FROZEN for the wave (api, worker.mjs, core) — every change
client-side.

## The feature

- **Use button**: owned consumable rows gain one explicit use act — POST
  /api/coins/cosmetics/consume with the row's itemKey; the route's echoed
  inventory refreshes the row (router.renderCurrent, the shop buttons'
  shape). Refusals paint verbatim (403 buy-first / 409 empty pack / 400
  kind).
- **Burst-pack equip face**: the owned fx_burst row gains the equip /
  unequip toggle — the same buttons the own rows already paint, riding the
  same POST /api/coins/cosmetics/equip routes (the backend's admitted
  Phase-3 exception; NO second wire, NO slot naming invention — the body
  carries itemKey only). The equipped span paints from the payload's
  equipped flag like the own rows.
- **Paint truth**: the use/equip acts ride the echo the routes already
  answer — no optimistic qty math, no client-side pack countdown beyond
  the payload's qty (the payload is the single source).

## Laws the wave rides

- sink law: no coins — using an owned pack spends a USE, never a coin;
  no mint, no ledger touch client-side.
- defaults law: use and equip are member-initiated one-click acts (never
  default-on, no auto-use on low qty, no confirm ceremony beyond the
  shop's existing row buttons).
- no-copy sweep: every painted string rides t() keys; en real copy + real
  translations ×8; no byte-equal en carve; reused keys verified seated
  before use.
- payload truth: the row paints kind/qty/equipped the payload carries —
  no invented slots, no second consumable invented.
- backend byte-freeze (the wave-9 lesson, eight instances): the freeze
  pin fingerprints the wave's own committed range (LANE_TIP placeholder
  retargeted at commit time by the lead); the c20-forged disambiguating
  catch arm is mandatory.

## Sequencing

lane-w17-consume: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → retarget freeze pin → isolated verify ×2 → deslop →
merge → push → ritual deploy → probe stamp == pushed SHA → board.
