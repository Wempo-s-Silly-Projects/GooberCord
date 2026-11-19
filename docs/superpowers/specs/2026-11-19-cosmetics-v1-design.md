# Cosmetics v1 slate — the coin shop grows a recurring sink (2026-11-19)

Owner-away autonomous slate under Section A. Grounding: the owner's economy
re-rule verbatim (2026-11-17) — "economy is community-earn +
coins-for-cosmetics", "accent/tagline stay FREE" — and the Goober+ tier
matrix sequencing ("cosmetics-last": this wave only ever runs after the
upload-tier and boost-level rows are landed or explicitly waived by the
lead). VERSION stays `"prototype"`; the 1.0 flip is owner-gated everywhere.

## Intent + why

The coin shop's v1 catalog (banner / flair / pack) is a ONE-WAY drain: the
whole lifetime catalog costs 200–350 coins against a ~165-coin/day mint,
so every member's balance goes inert within ~5 days of catalog exhaustion.
The sim receipt is unambiguous:

- Sink coverage is **13.1%** of mint (45/35/15/5% lurker/chatter/voice/builder
  mix, 90 d) — `/tmp/gc-economy-sim.md` §3, run 2026-11-17 against
  `constants.mjs` + `api/coins.mjs` at git 49d3844.
- "No earn-side or price-side tuning can balance this … the economy is
  structurally net-accumulating at ~87% of mint" (§3, structural-ceiling
  line).
- The only lever that moves the owner's "worth nothing" verdict is
  sink-side: "a recurring, low-ticket cosmetic/comsumable cycle of
  ~50–200 coins per member per week would alone lift sink coverage from
  13% to the 40–50% needed" (§6).

Cosmetics v1 therefore picks its slots to be RECURRING (consumable) first,
one-time second. Every new item is a named sink for the economy-skill sink
law (mint already happened on the earn side; the purchase is the debit —
the sink law's "names its sink before shipping" is satisfied by the ledger
spend row itself).

## The existing surface (design around it, do not rebuild it)

A cosmetic shop already exists; v1 rides it:

- `gc_cosmetics` (migration 0013): `banner_color`, `flair_text` — profile
  apply surface, GC-owned, absence-is-the-shape (api/accounts.mjs:523-537).
- `gc_cosmetic_ownership` (migration 0019): `item TEXT CHECK (item IN
  ('banner','flair'))`, composite PK (user_id, item), `ON DELETE CASCADE`
  to users.
- Shop items + prices: `constants.mjs:144-146` (`GC_COSMETIC_PACK_PRICE`
  250 / `GC_COSMETIC_BANNER_PRICE` 100 / `GC_COSMETIC_FLAIR_PRICE` 100),
  route-side 50% plus discount (`api/coins.mjs:284-286`,
  `GC_PLUS_SINK_DISCOUNT_PERCENT` constants.mjs:107).
- Purchase idiom: one atomic batch — ledger spend guarded by the
  sufficient-coins arm + ownership INSERT double-guarded by the ledger
  fingerprint and NOT EXISTS (`api/coins.mjs:240-258`) — the economy-skill
  claim idiom verbatim.
- Apply route: `PATCH /api/me/cosmetics` (api/accounts.mjs:471) with the
  "Buy that cosmetic in the coin shop first" ownership gate
  (api/accounts.mjs:489-496).
- UI: `public/js/ui/economy.js` shop route (line 169) renders item rows
  (line 291) + the post-purchase apply panel (line 321).

**One migration hazard:** the 0019 CHECK enumerates items — expanding it
means a rename-rebuild, exactly the dance that burned 0053-0055 (FK
enforcement + populated-parent DROP). v1 does NOT touch
`gc_cosmetic_ownership`. New item kinds get their OWN table (below);
banner/flair/pack stay where they are.

## v1 scope — 3 slots

| Slot | Kind | Parity check (house rule: URL + date, else honest) |
|---|---|---|
| 1. **Message effects — coin-bought emoji burst** (Super-Reaction-shape reaction animation; consumable, N uses) | consumable | Analog exists on Discord: Super Reactions (bursting reaction animation). NO-URL-RECEIPT in this doc — the parity lane must fetch the support-artifact URL + date before any "Discord parity" claim is published; treat as NO-DISCORD-PARITY until then. On Discord this is Nitro-gated; on GC it is coin-bought — that delta is the point, not a bug. |
| 2. **Avatar frames** (persistent equip ring on the profile avatar) | own | Discord analog: avatar decorations are Shop items in profile customization. NO-URL-RECEIPT — same rule: fetch URL + date before publishing any parity claim. GC-local design otherwise. |
| 3. **Channel banner skins** (server-owner-set channel banner tint/pattern) | own, server-scoped | NO-DISCORD-PARITY, honest: Discord does not sell user-facing channel banner skins. GC-local flourish, rides the existing server-settings surface. |

Dropped from v1 (parked, not argued): server badge skins (parity unclear,
UI surface busy in v1) and profile accent — accent stays free by owner
order, full stop.

## Inventory table shape (draft DDL — migration 0056)

ONE new table, ONE migration, nothing else touched (0052 discipline). The
equip state rides a column here instead of an ALTER on `gc_cosmetics`;
`item_key` values live in `constants.mjs` as the single source of truth
(clients import, never re-declare). FK action: CASCADE on the user row —
account deletion takes its cosmetics with it, same as
`gc_cosmetic_ownership` and the capsule family.

```sql
CREATE TABLE IF NOT EXISTS gc_cosmetic_inventory (
  -- Copyright header: full 17-lines-plus-blank AGPLv3 template, as 0052 rides it.
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (item_key IN ('fx_burst_confetti', 'frame_gold', 'frame_neon', 'channel_banner_dusk')),
  kind TEXT NOT NULL CHECK (kind IN ('consumable', 'own')),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0),
  equipped INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  server_id INTEGER NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_gc_cosmetic_inventory_equipped
  ON gc_cosmetic_inventory(user_id, equipped);
```

- `kind = 'own'` rows hold qty = 1 forever (CHECK above floors at 0; the
  route-side arm enforces 1); `kind = 'consumable'` rows decrement via the
  same guarded-claim shape (a use that loses the race is all-zero + 409,
  original row survives — economy-skill law 3).
- `server_id` is NULL for profile-scoped items (frames, effects). The
  channel-banner row is per-server; a channel's skin read joins the
  server-scoped row only.
- Equips: `equipped = 1` on the active item per slot; "one equipped per
  slot" is enforced route-side inside the PATCH-shaped transaction (set the
  picked row to 1, siblings in the same slot to 0), never by a trigger.
- No `deleted_at`, no timers, no cron — uninstall is the hard row delete
  the user makes, capsule law.

## Earn paths → sink math

- **Earn paths:** every existing earn event funds purchases — daily claim,
  message, voice, rollup, server mints (`/tmp/gc-economy-sim.md` §1). No
  new mint is added by this wave, so the sink law's rule holds trivially
  and the pool-funded redistribution question never arises.
- **Sink math line:** current coverage 13.1% (sim §3, V0). Consumable
  effects priced so a regular member cycles 50–200 coins/week moves
  coverage toward the 40–50% the sim names as the fix (sim §6). One-time
  frames at 100 ride the owner's blessed 100-tier pacing (banner/flair @
  100, constants.mjs:145-146).

## Shop pricing tiers (v1)

| Item | Price | Plus price | Notes |
|---|---|---|---|
| fx_burst_confetti — burst pack (5 uses) | 50 | 25 (rides the route-side 50% discount) | the recurring low-ticket sink, ~10 coins/use |
| frame_gold | 100 | 50 | matches the banner/flair 100-tier |
| frame_neon | 100 | 50 | ditto |
| channel_banner_dusk | 150 | 75 | one tier above frames; per-server |

No pack SKU re-uses: the existing pack stays plus-only flat. The new SKUs
sit in `constants.mjs` next to `GC_COSMETIC_*` (:144-146) as
`GC_COSMETIC_FX_BURST_PRICE` = 50, `GC_COSMETIC_FRAME_PRICE` = 100,
`GC_COSMETIC_CHANNEL_BANNER_PRICE` = 150 — one value each, no re-declares.

## Non-goals (owner law, verbatim where quoted)

- `accent/tagline stay FREE` — forever; never priced, never tiered, never
  metered.
- No real money — cosmetics are coins only; the only cash SKUs remain the
  owner-blessed Plus/Mini bundles.
- No NFT-type scarcity: no limited mints, no resale market, no
  auction/blockchain mechanics of any kind.
- No trading (until the owner rules — see decisions below).
- No server-badge skins, no profile-accent work, no 1.0-adjacent claims.

## Phased build order (with rough test-count estimates)

1. **Phase 1 — schema + shop backend** (migration 0056, constants additions,
   shop payload extension in `api/coins.mjs`, purchase/equip/consume routes,
   PATCH-style equip arm): ~70 tests (coins-module purchase idiom, consume
   race serialization per economy-skill law 3/6, equip sibling-swap,
   migration shape).
2. **Phase 2 — shop UI + i18n** (`public/js/ui/economy.js` new item rows +
   equip panel, `en.json` keys + the 7 non-en bundles, carve gates only if
   a byte-identical row sneaks in): ~40 tests (source-read DOM pins +
   i18n both-directions).
3. **Phase 3 — effects runtime** (client render of the burst on the
   Super-Reaction-shape trigger + qty decrement round-trip): ~35 tests.

Rough total ≈ 145 new tests; the full suite (currently 1551/1551) must stay
unmasked-green at every pushed tip.

## Open decisions for the owner (parked — human must rule)

1. **Tradeable cosmetics?** Is any owned cosmetic giftable/tradeable
   member-to-member (the gift-chain lanes already exist)? Default assumed
   in v1: NO trading, purchases are personal.
2. **Seasonal / limited-time items?** The sim's recurring-sink fix is
   strongest with rotation; a rotating catalog is a product call, not a
   code call. Default assumed in v1: catalog is permanent, rotation parked.
3. **Effects earnable directly?** Should a small coin grant (or free daily
   uses) accompany effects, or are they coins-only? Default assumed in v1:
   coins-only.

## Lead routing

- **lane-cosmetics-schema** (backend): migration 0056 + constants.mjs SKUs
  + `api/coins.mjs` payload/purchase/equip/consume routes + phase-1 tests.
- **lane-cosmetics-shop-ui**: `public/js/ui/economy.js` rows + panel +
  `public/locales/*` keys + phase-2 tests.
- **lane-cosmetics-effects**: the client burst runtime + consumption
  round-trip + phase-3 tests (depends on lane-cosmetics-schema's consume
  route existing; starts after phase 1 lands).
