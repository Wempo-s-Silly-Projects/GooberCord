# Economy sink levers — draft (T62)

Formalized from the coin economy simulation (engine `node /tmp/gc-economy-sim/sim.mjs`, full
write-up `/tmp/gc-economy-sim.md`; refresh confirmed the economy constants byte-identical at
main tip 36bd507 — `constants.mjs:140-158, 295-333`). Status: DRAFT for the owner's decision;
not a design commitment, no code or constants attached.

## 1. State of the economy (verified against shipped constants)

The coin economy is community-earn (claim/message/voice/rollup/server mints) with cosmetics as
its one sink (owner's coins-for-cosmetics re-rule). Shipped numbers:

| Constant | Value | Line |
|---|---|---|
| GC_COIN_DAILY_GRANT | 25 | constants.mjs:299 |
| GC_COIN_MESSAGE_GRANT / DAILY_CAP | 2 / 100 msgs | constants.mjs:302-303 |
| GC_COIN_VOICE_GRANT / TICK / DAILY_CAP | 5 / 600 s / 150 | constants.mjs:308-310 |
| GC_ROLLUP_GRANT / CAP / MIN_BODY | 3 / 5 / 40 ch | constants.mjs:140-143 |
| GC_SERVER_GRANT / MINT_DAILY_CAP | 50 / 2 | constants.mjs:146-148 |
| GC_COIN_DAILY_CEILING / GC_PLUS_DAILY_CEILING | 250 / 500 | constants.mjs:295, 130 |
| GC_COSMETIC_PACK / BANNER / FLAIR | 250 / 100 / 100 | constants.mjs:155-157 |
| GC_PLUS_SINK_DISCOUNT_PERCENT | 50 | constants.mjs:158 |
| GC_PLUS_PRICE / RENEWAL / TERM | 500 / 400 / 30 d | constants.mjs:319-321 |
| GC_MINI_PRICE / RENEWAL | 250 / 200 | constants.mjs:332-333 |

Sim result (90-day member mix 45% lurker / 35% chatter / 15% voice / 5% builder):

- Minted per member ≈ 14.9k; sunk per member 1.950k → **sink coverage 13.1%**.
- Average idle balance at day 90 ≈ 12.9k coins. Balances go inert within ~5 days of catalog
  exhaustion; coins only matter again at Plus renewal.
- Structural ceiling: the whole lifetime cosmetic catalog costs 200 (free) or 350 (plus) once,
  plus Plus renewals at 13.3 coins/day, against a ~165 coin/day mint. **No earn-side or
  price-side tuning balances this; the economy is structurally net-accumulating at ~87% of mint.**
- Goober+ earn multiplier buys nothing extra: a lurker gains +0/day from Plus (flat 25 claim at
  both tiers); actives gain coins that have nothing left to purchase within days.

Verdicts this drives: cosmetics pacing is healthy (first cosmetic day 1 for actives, day 4 for
lurkers); "coins are worth nothing" (post-day-5 inert balances) and "Goober+ earns fictitious
value" both fail — and both sit on the SINK side of the ledger.

## 2. The owner's two levers

### Lever 1 — GC_COIN_DAILY_GRANT 25 → 50 (palliative, mint side)

- Best of the grant/cap/price family for reach: lurker time-to-Plus 28 → 14 d, mix-average
  Plus start 14.9 → 8.4 d, first cosmetic 2.3 → 1.4 d. The only lever that reaches the lurker
  segment, which is where the complaint came from.
- Cost: makes inflation worse — sink coverage 13.1% → 11.4% — because there is nothing extra
  to buy with the doubled claim.
- Sim idles at 15.1k balance by day 90 (vs 12.9k baseline). Verdict flip on "worth nothing":
  NO. Verdict flip on "too grindy": marginal (already passes for actives).
- One-line: buys reach now, pays in worse inertness later.

### Lever 2 — recurring sink-side cycle (the only lever that flips the verdicts)

- Design shape: rotating/recolor cosmetics, consumables, or seasonal items priced so a regular
  member can cycle ~100–200 coins/week — owner-blessed price points (banner/flair 100, pack 250,
  50% Plus discount) are pacing anchors already in the constants.
- Effect: alone lifts sink coverage from 13% toward the 40–50% needed to make balances
  meaningful and to give the Plus earn multiplier (message 3/voice 8/rollup 5/server 75,
  ceiling 500) real purchasing power.
- Cost: a standing content/rotation lane (design + cadence), not a constants edit. Existing
  prices need no change; no mint-side migration risk.
- One-line: turns accumulated balances into spend, retroactively — every already-hoarded coin
  becomes liquid.

## 3. Recommendation row

| Lever | Fixes "too grindy" | Fixes "worth nothing" | Fixes "Plus hardly worth it" | Inflation |
|---|---|---|---|---|
| Grant 25→50 (mint) | partial (lurker reach 2×) | no (idle balance grows 12.9k→15.1k) | no (extra coins buy nothing) | worsens (13.1%→11.4%) |
| Sink-side cycle | yes, by definition | yes | yes (Plus multiplier buys the cycle) | improves (13.1%→40-50%) |

Sequenced, not either/or: the sink cycle is the lever that moves the verdicts; the grant
doubling is a palliative for lurker reach that is acceptable ONLY after a sink exists to
absorb it (grant-50 with no cycle drops coverage to 11.4%; grant-50 after a cycle is roughly
coverage-neutral at 40%+ target).

— Level & Economy Designer, T62, 2026-11-17 (engine: `node /tmp/gc-economy-sim/sim.mjs`; sources: /tmp/gc-economy-sim.md, constants.mjs @ 36bd507)
