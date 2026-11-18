// Copyright 2026 ItsWempo
//
// This file is part of GooberCord.
//
// GooberCord is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

# T90 — The Campfire Ledger: the fire's books are open

Source slate row: `docs/drafts/feature-slate-wave5-2026-11-18.md` (T90).
Lane: spec + RED only (this draft + `tests/campfire-ledger-red.test.mjs`); the
GREEN half (migrations 0039 + constants + campfire.mjs append/read) rides the
backend implementer seat. Spec + RED are DELIVERED FAILING feature-absent.

Identity: the fire's books are open. The Campfire has always been a pure sink
with an anonymous meter (migration 0030, `api/campfire.mjs`'s header law) —
T90 opens the books WITHOUT opening the members: the ledger is a
derived-on-request, server-wide flow statement over rows the economy already
writes. No per-member attribution, no leaderboard, no second balance.

## 1. The surface

    GET /api/servers/:id/ledger

- Member-gated (the shared `memberGate` of `api/campfire.mjs:278`): un-authed
  → 401 (the fleet csrf law — Origin present, session absent); a signed-in
  non-member → the shared unknown-server 404 class verbatim
  ("This server does not exist or you cannot view it." — no existence oracle).
- Rate-limited `read` (`campfire:ledger:<serverId>:<userId>`, the campfire read
  lane's own key shape).
- `read`-lane only: NO query params in v1 (no cursor, no member filter, no
  window override — a filterable surface is a query surface, and the fire's
  books are one page). Route rides `handleCampfireRoutes` as a third match
  (`^/api/servers/:id/ledger$`) — no new dispatch registration, worker.mjs
  untouched.

## 2. Derived on request — and the storage audit that decides the migration

The T87 idiom (api/paper.mjs) is the house law: aggregates computed from
existing rows at read time, nothing persisted, and a read fires ZERO
coin-affecting statements. The audit of what the economy ALREADY stores:

| Row source | Keying | Verdict |
|---|---|---|
| `gc_coin_ledger` (0011) | `user_id`, `delta`, `source`, `related_user_id`, `created_at` — NO server column | Member-keyed only. A flow CANNOT be attributed to a server from this table without joining present-tense `gc_server_members` — which is exactly the per-member attribution T76 §2 bans (api/campfire.mjs:31-33: "no per-member attribution … no ledger exposure"). Rejected as the ledger's basis. |
| `gc_campfires` (0030) | `server_id` PK, `fuel`/`pool`/`fuel_today` single mutable columns | Server-keyed, but a METER, not a book: every stoke credit, chain-fee credit, draw debit, seat refund, and claim reversal overwrites the same `pool` column. There is no pool-flow history anywhere. |

**Migration verdict (explicit, as demanded):** NONE NEEDED would only hold if
pool-flow rows already existed — they do not. `gc_campfires.pool` is one
overwritten column; the ledger's history does not exist and cannot be derived
per-server from member-keyed `gc_coin_ledger` rows without attribution. So the
lane plans ONE small derived-support seat:

### Migration 0039_gc_campfire_pool_ledger.sql — CREATE-ONLY

- ONE `CREATE TABLE gc_campfire_pool_ledger`, no ALTER, no rebuild, no index
  beyond what the read needs (server_id + created_at).
- Columns: `id` PK AUTOINCREMENT; `server_id INTEGER NOT NULL REFERENCES
  gc_servers(id) ON DELETE CASCADE`; `class TEXT NOT NULL`; `source TEXT NULL`
  (the underlying `gc_coin_ledger` source label where one exists, NULL for
  pool-only corrections); `direction TEXT NOT NULL CHECK (direction IN
  ('in','out'))`; `delta INTEGER NOT NULL CHECK (delta <> 0)` (the positive
  MOVEMENT MAGNITUDE — the sign rides `direction`, never `delta`; this is the
  RED seed's operative convention and it outruns any earlier "signed" wording
  in this spec); `created_at INTEGER NOT NULL`.
- **NO member column, ever** — no `user_id`, no `related_user_id`. The
  no-attribution law rides the schema, not a query habit. A deleted server
  cascades its books away.
- **No backfill**: pre-0039 pool movements are not reconstructible without
  attribution; the books open at migration day. A server with no rows since
  0039 answers `flows: []` (not 404) — an empty book is a VALID book.

## 3. The append points (writes ride the writes, never the read)

The support table is appended ONLY from the pool-moving statements that ALREADY
exist — one companion INSERT inside the SAME batch, never a new write surface:

1. `handleCampfireStokeRoute` batch (api/campfire.mjs:339) — stoke lands → row
   `class='pool-credit', source='campfire_stoke', direction='in'`. The stoke
   spend's changes verdict governs the batch's meaning; a refused stoke banks
   no book row (the batch is atomic).
2. `campfirePoolCreditStatement` (api/campfire.mjs:161) — the chain-fee credit
   (the fine/sink lane, api/coins.mjs:1158/1268). The statement returns ONE
   prepared statement that callers spread into their own batch; the append
   therefore rides a statement-shape change (return pair / composed
   INSERT…SELECT) and the coins.mjs chain call sites spread the pair — the
   cross-file touch is the GREEN lane's wiring note. Row
   `class='pool-credit', source='chain_fee', direction='in'` — the SINK LAW
   EXHIBIT: the fee that left circulation names its source exactly as the
   member's own ledger row already records it (`chain_fee`).
3. The draw (api/campfire.mjs:221-274) — minted seats append
   `class='member-share-mint', source='campfire', direction='out'`, one row
   per minted seat batched with the payouts (changes-verdict-governed: a seat
   that did not mint does not book). The seat refund books
   `class='seat-refund', source=NULL, direction='in'`; the claim reversal
   books `class='draw-reversal', source=NULL, direction='in'`.
5. KNOWN v1 PARTIAL (parked as the T90-c completeness lane): the
   `campfirePoolCreditStatement` callers outside §3's file list —
   api/jobs.mjs job-finish pool shares and api/seasons.mjs seasonal credits —
   book NO ledger row (v1 scope ends at the four append points above;
   `campfirePoolCreditStatement` itself is C1-pinned single-statement and its
   callers are outside this spec's file list). For those servers the
   conservation read shows `in` visibly UNDER the true credit. T90-c books
   the job-finish/season classes with companion statements at those call
   sites and amends this section; until then the read's payload stays
   aggregate-per-class honest — the missing rows simply don't exist.
4. Cap burn PARKED: the pool-cap `MIN` arm (api/campfire.mjs:84,168) discards
   overflow silently today and stays silent in v1 — rows record the ACTUAL
   post-arm delta, so a later lane can derive burn as (requested − booked).
   No burn class ships in 0039.

## 4. The read (derived, never stored)

`handleCampfireLedgerRoute` in api/campfire.mjs:

1. `memberGate` → 401 / shared-404 as §1.
2. `rateLimit(request, env, "read", ...)`.
3. The window: `window = { startSeconds, endSeconds }`, a fixed lookback of
   `GC_CAMPFIRE_LEDGER_WINDOW_SECONDS = 2592000` (30 days) — a NEW
   constants.mjs export beside the GC_CAMPFIRE_* family, never a magic number
   (the paper's named-constants law). No query override (§1).
4. ONE aggregate read over `gc_campfire_pool_ledger` GROUP BY class, source,
   direction — SUM(delta) AS amount, COUNT(*) AS count — server-keyed by the
   WHERE, windowed by `created_at >= ?`. NO member column in any clause of the
   statement; the schema makes one impossible to name anyway (§2).
5. **The no-mint law (RED-pinned)**: the GET fires ZERO coin-affecting
   statements — no INSERT/UPDATE/DELETE touches `gc_coin_ledger`,
   `gc_campfire_pool_ledger`, `gc_campfires`, or any economy table. The
   existing `GET /api/servers/:id/campfire` runs the draw evaluation on its
   read (api/campfire.mjs:318); the ledger read must NOT — a book-keeper who
   stokes the fire during the audit is an auditor wearing gloves to print
   money. No `evaluateCampfireDraw`, no fuel accrual, no rollup mint.
6. No leaderboard: the payload is aggregate-per-class+direction, NEVER
   per-member, in word and in shape (no ids, no usernames, no top-list, no
   ranked rows beyond the flow lines themselves).

## 5. Response shape

```json
{
  "window": { "startSeconds": 1, "endSeconds": 2 },
  "flows": [
    { "class": "pool-credit", "source": "campfire_stoke", "direction": "in",  "amount": 300, "count": 3 },
    { "class": "pool-credit", "source": "chain_fee",      "direction": "in",  "amount": 25,  "count": 1 },
    { "class": "member-share-mint", "source": "campfire", "direction": "out", "amount": 20,  "count": 2 }
  ]
}
```

- `flows` is one line per (class, source, direction) present in the window;
  omitted lines are zero-activity lines (no zero rows — the delta-only rule's
  bookkeeping cousin: a zero flow line would be a lie).
- Class enums exactly: `pool-credit`, `member-share-mint`, `seat-refund`,
  `draw-reversal`. Direction enums exactly: `in`, `out`.
- Empty window → `{ window, flows: [] }` with status 200 — a quiet fire is
  VALID, never a 404 (the paper's empty-shape law).
- Conservation note (painted in the spec, not the payload): in − parked-burn ≥
  out holds by construction of the append points; the payload stays the raw
  lines, never a derived "net" (a net invites a balance column's drift).

## 6. Laws checklist (each RED-pinned)

- Member-gated: 401 un-authed (Origin per fleet csrf law); non-member → the
  shared unknown-server 404 body verbatim, not the dispatch tail's generic 404.
- Derived ON REQUEST: zero coin-affecting statements on read (the fake's
  call log must show no INSERT/UPDATE on economy tables).
- Aggregate per class+direction+source, never per-member: painted payload
  carries no member-level key.
- Sink law exhibit: every flow line names its SOURCE class exactly as the
  ledger rows already record them (`campfire_stoke`, `chain_fee`, `campfire`).
- No leaderboard, no ranking, no top-list.
- Migration: 0039 CREATE-only, ONE table, no member column, no backfill —
  and the spec STATES migration NONE-NEEDED is FALSE because pool-flow rows
  do not already exist (§2).
- RED delivered failing: the dispatch tail's generic 404
  ("That API endpoint does not exist.") answers every ledger request until
  GREEN lands.
