# T76 — economy uniqueness slate spec: the Well, the Campfire, gift chains

Draft for the overnight uniqueness lanes (branch `fleet-wave-2026-11-18`, tip c215561).
Source slate rows 1–3: `docs/drafts/feature-slate-lead-2026-11-18.md`. Sink ledger: the T62
memo (`docs/drafts/economy-sink-levers.md` — baseline sink coverage 13.1%, no mint-side lever
balances the economy). RED rows shipped beside this spec:
`tests/economy-slate-red.test.mjs` (fails today by construction; GREEN lane turns it pass).
No code, no migration, no commit in this lane.

**SINK LAW (every mint names its sink):**
- The Well streak bonus (a mint) is absorbed by the sink-side cycle lane — the Campfire pool
  disbursements plus the rotating-cosmetic catalog the T62 sequencing requires. Its cap is set
  BY that coverage ceiling (§1 constant note). It does not ship alone.
- The Campfire is a pure sink: its pool only ever receives coins that already left circulation
  (stokes, chain fees); its draws pay out no more than the pool holds; overflow at the pool cap
  burns. Campfire net supply change: ≤ 0. Always.
- Gift chains transfer coins member→member (supply-neutral) and SINK the fee into the Campfire
  pool. Net supply change: − fee. Always.

## 1. The Well — daily claim streaks (the claim gains a rhythm)

State per member, private to the member (no streak surface anywhere else in the payload; the
shop's claim panel is the only renderer):

```sql
CREATE TABLE gc_well_streaks (
  user_id INTEGER PRIMARY KEY,
  streak_days INTEGER NOT NULL DEFAULT 0,
  bonus_percent INTEGER NOT NULL DEFAULT 0,
  last_claim_day INTEGER,            -- UTC day-floor of the last claim, NULL = never
  updated_at INTEGER NOT NULL
);
```

Flow (rider on the EXISTING `POST /api/coins/claim`, `api/coins.mjs:684-712`): after the daily
mint lands, one streak upsert (same `dayFloor(now)` basis):

- `last_claim_day == today` → nothing (the once-per-day arm already refused the mint).
- `last_claim_day == yesterday` → `streak_days += 1`;
  `bonus_percent = MIN(bonus_percent + GC_WELL_STREAK_STEP_PERCENT, GC_WELL_STREAK_MAX_BONUS_PERCENT)`.
- `last_claim_day == today - 2` (ONE missed day) → streak halved:
  `bonus_percent = FLOOR(bonus_percent / 2)`, `streak_days = FLOOR(streak_days / 2)` — never
  zeroed (the slate's "gentle decay").
- `last_claim_day < today - GC_WELL_MISSED_DAYS_BEFORE_RESET` (5 missed days) →
  `streak_days = 0, bonus_percent = 0` (reset to the base claim).
- First claim ever (`last_claim_day IS NULL`) → `streak_days = 1, bonus_percent = step`.

The mint itself: `delta = GC_COIN_DAILY_GRANT * (1 + bonus_percent / 100)` (base 25 → up to
50), still inside the existing ceiling arm (250 / 500) and the once-per-day arm; the streak
upsert rides only a minted claim (changes = 1), never a refusal.

Response shape: `{ claimed: true, streak: streakDays, bonusPercent, ...snapshot }`.

Constants (cap note: mixed-mint cost ≈ +10 coins/member/day at full bonus; coverage math in
T62 §3 holds the ceiling — the Well ships with the Campfire, never before a sink exists):

| Constant | Value | Meaning |
|---|---|---|
| GC_WELL_STREAK_STEP_PERCENT | 20 | bonus per consecutive day |
| GC_WELL_STREAK_MAX_BONUS_PERCENT | 100 | claim tops at 2× (50) |
| GC_WELL_MISSED_DAYS_BEFORE_RESET | 5 | missed days before reset |

Routes/state touched: `handleClaimRoute` only. No new route, no public streak anywhere.

## 2. The Campfire — server-wide meter, shared pool, zero ranking

New module `api/campfire.mjs` (registered in `worker.mjs` `API_HANDLERS`). Tables (next migration
numbers after 0028):

```sql
CREATE TABLE gc_campfires (
  server_id INTEGER PRIMARY KEY,
  fuel INTEGER NOT NULL DEFAULT 0,
  pool INTEGER NOT NULL DEFAULT 0,     -- counts SUNK coins only
  bonus_until INTEGER,                 -- active banner cosmetic window
  last_draw_at INTEGER,                -- draw gap gate
  fuel_today INTEGER NOT NULL DEFAULT 0, fuel_today_day INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

- Fuel accrual (server-side, no new client surface): the same code paths that mint message and
  voice coins for a server-bound channel/thread increment `fuel +1` per posted message and per
  voice tick — capped by `GC_CAMPFIRE_FUEL_DAILY_CAP` per server per UTC day. DMs and DM-group
  activity mint no fuel (the fire belongs to a server).
- Draw (evaluated server-side when fuel crosses the threshold, max one per
  `GC_CAMPFIRE_DRAW_GAP_SECONDS`): compute the online-member set via the presence lane; coin
  path costs `count * GC_CAMPFIRE_DRAW_ONLINE_BONUS`. If `pool >= cost` → each online member
  gets one `source = 'campfire'` ledger row (a POOL-FUNDED redistribution, not new mint — the
  statement is pool-guarded: `pool >= ?` arm, `pool -= paid` in the same batch; pool-funded
  payouts ride NO daily ceiling, the pool IS the bound). If the pool is short → the banner path:
  `bonus_until = now + GC_CAMPFIRE_BANNER_HOURS` hours, pool untouched. Either way `fuel`
  returns to 0 and the coin-less draw never mints a single coin.
- Pool credits (the only two): a member stoke — `POST /api/servers/:id/campfire/stoke`
  `{ amount }` — one `source = 'campfire_stoke'` negative ledger row under the
  sufficient-coins arm, pool += amount (capped per stoke by `GC_CAMPFIRE_STOKE_MAX`); and the
  gift-chain fee (§3). Pool is hard-capped at `GC_CAMPFIRE_MAX_POOL` — a credit at cap burns
  (pure sink at the top).
- Reads: `GET /api/servers/:id/campfire` answers
  `{ fuel, threshold, pool, bannerUntil, lastDrawAt }` to members only. **No ranking surface of
  any kind**: no per-member fuel attribution, no top-list, no per-member ledger exposure — the
  fire is the server's. (Privacy-native by construction: the fuel statement keys on the server,
  never the member.)
- Server banner draw consumes the pool's identity as a TEMPORARY cosmetic window the client
  renders server-wide while `bonus_until` stands (client lane's surface, outside this spec).

Constants:

| Constant | Value | Meaning |
|---|---|---|
| GC_CAMPFIRE_FUEL_THRESHOLD | 400 | fuel per draw |
| GC_CAMPFIRE_FUEL_DAILY_CAP | 200 | fuel accrual cap per server-day |
| GC_CAMPFIRE_DRAW_GAP_SECONDS | 86400 | ≥1 day between draws |
| GC_CAMPFIRE_DRAW_ONLINE_BONUS | 10 | per online member, pool-funded |
| GC_CAMPFIRE_BANNER_HOURS | 24 | banner draw window |
| GC_CAMPFIRE_MAX_POOL | 5000 | pool cap; overflow burns |
| GC_CAMPFIRE_STOKE_MAX | 500 | per-stoke cap |

## 3. Pay-it-forward gift chains — anonymous, depth-capped, fee sinks to the pool

Routes (ride `api/coins.mjs`'s router; all requireUser + new rate-limit bindings
`coins:chain:read/write`):

- `POST /api/coins/chain` `{ to, amount }` — send an anonymous chain gift.
  Validated: `amount` integer within `[GC_CHAIN_MIN_AMOUNT, GC_CHAIN_MAX_AMOUNT]`, target
  exists, not self. The spend statement is the existing PLUS_SPEND shape generalized: ONE
  batch = `source = 'chain_gift'` − amount row (the receive), PLUS the fee spend
  `source = 'chain_fee'` − fee row where `fee = MAX(1, CEIL(amount * GC_CHAIN_FEE_PERCENT / 100))`.
  The sender's two ledger rows are visible to the sender only (their own ledger page); the fee
  row's `related_user_id` is the credited campfire's `pool` marker — no member identity.
- Hop token: one random 32-byte base64url token (the established randomToken shape); the
  recipient NEVER sees the sender. Tables:

```sql
CREATE TABLE gc_chain_hops (
  hop_token TEXT PRIMARY KEY,        -- opaque, unguessable
  depth INTEGER NOT NULL,
  amount INTEGER NOT NULL,           -- coins riding the hop (fee already banked)
  pool_server_id INTEGER NOT NULL,   -- which campfire pool the NEXT fee credits
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- NO member columns on gc_chain_hops. The only identity pointer is the
-- receive map, readable by its owner alone, deleted on resolve:
CREATE TABLE gc_chain_hold (
  hop_token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL
);
```

- Recipient surfaces: `GET /api/coins/chains` → the member's pending hops
  (`{ token, amount, depth, expiresAt }` — no sender, ever). The member chooses:
  - `POST /api/coins/chain/:token/keep` — keep the coins: the hop's amount converts to one
    `source = 'chain_gift'` positive ledger row and the chain ends (no fee — keeping is free,
    the fee already rode the send).
  - `POST /api/coins/chain/:token/pass` `{ to }` — pay it forward: new hop
    (`depth + 1, amount − newFee` credited to next hop; the new fee banks to the target's own
    shared-server campfire — `pool_server_id` = a server the two share), the old hop row and
    its hold row deleted. Ledger rows carry `related_user_id = NULL` on BOTH hops' rows.
- Depth/decay: `GC_CHAIN_DEPTH_MAX = 7` — a pass at depth 7 refuses (400). An expired hop
  (`GC_CHAIN_HOP_TTL_SECONDS = 172800`, 48 h) converts itself to `keep` on the recipient's
  next /coins/chains read (no silent loss, no fee).
- Anonymity invariants (pinned in RED): hop ledger rows never carry a username; no route ever
  answers "who sent me this"; the chain_fee row answers nothing but the pool it fed.
- Sink: every pass re-sinks a fee into a Campfire pool; the send sinks the first fee. Supply
  change per chain: strictly negative in fees, zero otherwise.

**PARKED FOR OWNER — board row R9 (2026-11-18, ship-reviewer flag; NOT a backend decision):**
the anonymous chain lanes are open to banned members today (requireUser answers any live
session; the hop lanes never surface the sender, so a ban check rides no identity the module
sees). Whether a ban should freeze coin movement — receive-lane writes, the chain send, and
the hop conversion — is an OWNERSHIP ruling (does a ban freeze coins?) and STAYS UNDECIDED
here until the owner calls it. No backend lane may close or "fix" this unilaterally.

Constants:

| Constant | Value | Meaning |
|---|---|---|
| GC_CHAIN_FEE_PERCENT | 5 | pool fee per pass |
| GC_CHAIN_FEE_MIN_COINS | 1 | minimum fee |
| GC_CHAIN_MIN_AMOUNT | 5 | minimum gift |
| GC_CHAIN_MAX_AMOUNT | 200 | gift cap (the sink stays small-ticket) |
| GC_CHAIN_DEPTH_MAX | 7 | chain depth cap |
| GC_CHAIN_HOP_TTL_SECONDS | 172800 | hop expiry (48 h) |

## 4. Shipped constants ledger (all live in constants.mjs with the cap comments)

17 new constants (§1.3 + §2 + §3 tables). Every one is an economy cap, not a Discord parity
number — the comment rule stands, the T62 coverage ceiling is the cited source, and the Campfire
pool cap + chain caps keep every new mint inside what named sink absorbs.

## 5. RED rows delivered (tests/economy-slate-red.test.mjs)

Constants-existence row + 11 behavior rows: streak advance/halve/first-claim/reset via the
claim route's response shape; the chain send's spend+fee batch SQL naming `gc_campfires`; the
fee's campfire pool credit; depth-cap refusal; the identity-free hop ledger row; keep-ends-chain;
expiry-converts; the campfire read's member gate + no-ranking payload shape. All ride the
coins-module fakeDb idiom (seeded ledger, pinned-SQL handlers, session scaffolding copied from
`tests/coins-module.test.mjs`). Failing today by construction — GREEN lane implements to them.

— Level & Economy Designer, T76, 2026-11-18. Sources: feature-slate rows 1–3; T62 sink memo;
api/coins.mjs @ c215561.
