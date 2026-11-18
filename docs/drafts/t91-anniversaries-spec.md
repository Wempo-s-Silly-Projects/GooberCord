# T91 — Month-day anniversaries spec

Identity: **the calendar remembers without counting years.**

The load-bearing law is LIMIT COLLECTION NOT ACCESS: an anniversary stores
MONTH (0-11) + DAY (1-31) and nothing else. There is no year to protect
because no year is ever collected — not stored, not derived, not counted.

## 1. User stories

- As a member, I set my anniversary once (PUT) and the server remembers the
  month-day from then on.
- As a member, I clear it anytime (DELETE) — the act is always mine, and
  the clear is immediate and total.
- As a server member, I see who's celebrating TODAY in the Morning Paper's
  new anniversaries section — handles only.
- As the data, I carry no year: nothing on this seat can ever answer "how
  long have they been here".

## 2. Acceptance criteria

1. `PUT /api/users/me/anniversary` `{ month, day }` — self-scoped opt-in.
   Both must be integers inside the structural range (month 0-11, day 1-31)
   or the write answers the shared 400 validation shape. A PUT missing
   either key is a 400 — the off-state is never written on anyone's behalf
   (defaults law: nothing default-on).
2. Absence IS the off-state: no PUT = no row. There is no read-side
   "disabled" flag, no tombstone, no default row.
3. `DELETE /api/users/me/anniversary` — clears; idempotent; the route is
   self-scoped (`/me`), so a wrong-member clear cannot exist structurally.
4. Un-authed → 401 for every route (Origin present, the fleet csrf law).
5. The Paper ride-along: `GET /api/servers/:id/paper` (LIVE in prod)
   gains `sections.anniversaries` — members of that server whose
   (month, day) equals TODAY's UTC (month, day). Rows carry the member id
   and handle ONLY. Zero year data exists to ride; the join is read-only
   over `gc_user_anniversaries` ⋈ `gc_server_members` ⋈ `users`, no write,
   no aggregate.
6. No mint, no tracker: a set or a clear fires exactly ONE seat statement
   (the upsert / the delete) and ZERO coin statements (no gc_coin_ledger
   insert, no gc_job_counters / counter upsert, no delta of any kind).

## 3. Edge-case checklist

- **Feb 30**: ALLOWED. The validation is structural only — month 0-11,
  day 1-31 — with NO calendar knowledge (no per-month day counts, no leap
  math). Feb 30 is stored verbatim and simply never fires, because
  matching is pure `(month, day)` equality against the calendar's own
  today: a month-day the calendar never has can never equal today.
  Rejecting Feb 30 would mean teaching the validation the calendar —
  collection-side logic the storage seat does not need — and any
  "normalize Feb 30 → Feb 28" would be exactly the derived-math the
  no-year ban exists to keep out. Pinned: store what's structurally
  valid, let the calendar do the firing.
- **Feb 29**: stored; fires only on Feb 29 (leap years). A leap-year
  substitution (celebrate Feb 28 in common years) is longevity-adjacent
  calendar math and is BANNED by the same rule.
- **Day-key source**: today's (month, day) derives from the same
  `nowSeconds()` UTC clock the paper already rides (the T83 day-key idiom)
  — no timer, no per-server timezone (the paper's parked tz anchor stays
  parked).
- **Re-set**: a second PUT overwrites in place (upsert on the user_id PK)
  — there is no history, no previous value to preserve.
- **Account delete**: the row dies with the user via the users FK CASCADE
  (no orphan, GDPR shape free of charge because there is nothing to
  export).

## 4. Migration sketch (CREATE-only — ordinal 0040, per the T91 brief)

`migrations/0040_gc_anniversaries.sql`:

```sql
CREATE TABLE gc_user_anniversaries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month   INTEGER NOT NULL CHECK (month IN (0,1,2,3,4,5,6,7,8,9,10,11)),
  day     INTEGER NOT NULL CHECK (day >= 1 AND day <= 31),
  PRIMARY KEY (user_id)
);
```

- One member, at most one anniversary — the PK IS the seat.
- **The schema IS the privacy law**: no `year` column, no `since`, no
  `created_at`. A year column must be structurally impossible — any future
  migration adding one is a violation of LIMIT COLLECTION NOT ACCESS by
  definition and must be rejected on its face.
- The users FK cascades (account death takes the row). CREATE-only: no
  rebuild, no ALTER, one statement.

## 5. Laws (this lane's version)

- **LIMIT COLLECTION NOT ACCESS** (load-bearing): MONTH+DAY only. Hard
  ban on year, derived-year, joined-since, account-anchored longevity
  math, and leap-substitution. Nothing on this seat may ever feed a
  "member for N years" computation; the data to do so does not exist.
- **Defaults law**: the row is opt-in, never default-on; absence IS the
  off-state.
- **Caps in constants.mjs**: month/day structural bounds and the paper
  section cap ride named constants (GC_*), never re-declared in a handler.
- **Paper laws carry** (the T87 seat is LIVE): members-only read gate, the
  dedicated no-paper 404 rides ahead, read-time LIMIT, and the section-
  per-cap cut — the anniversaries join only fires after the config seat
  answers enabled, same dispatch order as every other section.
- **No existence oracle**: the 400 here is INPUT validation (a structurally
  impossible month/day), not an existence probe; the routes never answer
  403/404 distinction games — self-scoped means self-scoped.
- **Sink law**: N/A by spec §2.6 — the seat mints and sinks nothing.

## 6. OWNER_GATED

- Wave 5 slate row is the mandate; a GC-main "badge" surface (the one-day
  badge in the slate text) is the frontend seat's lane and is NOT speced
  here beyond the paper section's data shape.
- No parity number to cite: this seat is GooberCord-original (no Discord
  counterpart), so the parity-numbers law has nothing to carry.
