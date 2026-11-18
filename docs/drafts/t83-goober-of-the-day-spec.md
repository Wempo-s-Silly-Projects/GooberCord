# T83 — Goober of the Day spec

Wave-4 lane 2 (slate: `docs/drafts/feature-slate-wave4-2026-11-18.md`). Branch
`fleet-wave-2026-11-18`. Spec + RED only in this lane:
`tests/goober-of-the-day-red.test.mjs` (RED today by construction — the module
and the tables do not exist; the file's first statement fails on the import —
that IS the raw RED error and the GREEN seed).

Identity: kindness as a game; the spotlight is a gift, NOT a ladder.

## 1. The seat (three small tables, nothing else)

```sql
CREATE TABLE gc_goober_votes (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  day_key INTEGER NOT NULL,
  voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  votee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, day_key, voter_id)
);
CREATE INDEX idx_gc_goober_votes_day
  ON gc_goober_votes(server_id, day_key, votee_id);

CREATE TABLE gc_goober_optouts (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE gc_goober_cards (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  day_key INTEGER NOT NULL,
  winner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  votes_count INTEGER NOT NULL CHECK (votes_count >= 1),
  tagline TEXT NULL CHECK (tagline IS NULL OR length(trim(tagline)) BETWEEN 1 AND 64),
  PRIMARY KEY (server_id, day_key)
);
```

- **One vote per member per day** is the votes PK itself — the INSERT rides
  `ON CONFLICT DO NOTHING` and its changes verdict is the 409 answer; a
  racing pair cannot double-vote (the guarded-INSERT idiom).
- **Vote rows carry voter / votee / server / day-key and NOTHING else** — no
  ballot text, no per-candidate counters beyond the read-time aggregate.
- **Roll-over computed on read from the date key** (`nowSeconds() - now %
  GC_GOOBER_DAY_SECONDS` = UTC day key; the PREVIOUS key is the completed
  day): no timers, no cron, no background writer. The completed day's card
  is lazily written on the first read past roll-over — ONE guarded INSERT
  (`ON CONFLICT (server_id, day_key) DO NOTHING`), idempotent, so a racing
  pair of readers writes one card and both answer the same winner. The
  winner is a PURE function of the stored votes (aggregate + deterministic
  tie-break `ORDER BY votes DESC, votee_id ASC LIMIT 1`), so the same key
  always answers the same Goober — forever.
- **The opt-out seat** keeps candidacy default-IN per the slate, and the
  TOGGLE is the explicit act (defaults law): a member opts out of THIS
  server's candidacy with one POST, opts back in with the same toggle. The
  roll-over pick carries `NOT EXISTS (... gc_goober_optouts ...)` INSIDE the
  aggregate arm, so an opted-out member can never be painted — even if
  votes for them were already cast before the toggle (the pick filters at
  pick time, not at vote time).
- **The tagline column** is the winner's ONE FREE cosmetic tagline slot (a
  gift lane — nothing mints, nothing sinks; sink law N/A, and the app-wide
  tagline-free rule from the owner's economy ruling carries). The slot is
  empty by default; the winner CHOOSES to fill it.

## 2. API surface (all `requireUser`, all rate-limited, member-gated 404)

- `POST /api/servers/:serverId/goober/vote` `{ voteeId }` — the acting
  member's one vote. Refusals: a votee who is not a member of THIS server
  (404 shape), a votee who is opted out (404 shape — candidacy is not
  published, so an opted-out member is simply not a target), a self-vote
  (400 — you cannot spotlight yourself), a double vote (409 — the PK's own
  verdict). Anonymity: the vote INSERT reveals NOTHING; no route ever
  answers who voted for whom, during the window OR after it — only the
  WINNER is ever painted (stronger than "revealed at roll-over": the CARD
  is the only reveal; the mapping is never a surface).
- `POST /api/servers/:serverId/goober/candidacy` `{ optedOut: boolean }` —
  the defaults-law toggle: `true` upserts the opt-out row, `false` deletes
  it; the response answers `{ candidacy: "out" | "in" }`.
- `GET /api/servers/:serverId/goober/today` — the Day card + the caller's
  own two one-row states. Shape:
  `{ dayKey, goober: { id, name, avatar, tagline, votesCount } | null,
     votedToday, candidacy }`. The aggregate read inside carries ONLY the
  COMPLETED day key (`day_key <= today - GC_GOOBER_DAY_SECONDS`) — today's
  tally is never answered by anybody, and the pick runs the opt-out filter.
  A server whose first card-eligible day has no votes answers `goober: null`
  (nothing is painted; nothing is default-on).
- `POST /api/servers/:serverId/goober/tagline` `{ tagline }` — the winner's
  free slot: ONE guarded UPDATE whose WHERE carries
  `server_id = ? AND day_key = ? (the CURRENT key) AND winner_id = ?` — only
  the CURRENTLY CARD member of THIS server can write it, 1..64 trimmed
  chars or NULL (clearing also rides the winner's own seat). Nobody else,
  no other day, no other server.
- NO other routes on this lane. There is no candidates list (that would be
  a ladder), no vote-history read, no cross-server anything. Route
  registration rides worker.mjs's API_HANDLERS at GREEN (the dispatch-chain
  position after handleCoinRoutes's family), plus the migration (next free
  number at GREEN time — 0032 is T86's: `migrations/0033_gc_goober_day.sql`).

## 3. Laws (this lane's version)

- **Per-server visibility ONLY**: every statement of the surface carries the
  server seat INSIDE its WHERE — a card, a vote, a toggle, a tagline is
  scoped to one server by construction; no statement exists that aggregates
  across servers, and no global ranking surface exists anywhere.
- **No ladder**: the only painted facts are the current card (name, avatar,
  the winner's own optional tagline, the votes COUNT of that completed day)
  and the caller's own two states. No candidate list, no vote mapping, no
  all-time board, no votee leaderboard. Yesterday's card is not re-served as
  a history route (the card row survives for its OWN day's reads only; the
  today route answers exactly one completed day — the most recent one).
- **Anonymity during the window (and after)**: the vote mapping is never a
  read. The aggregate read carries voter identity nowhere (its GROUP BY is
  on votee_id; no SELECT returns voter_id).
- **Defaults law**: a server with no votes paints nothing (`goober: null`);
  candidacy is default-in per the slate with an explicit opt-OUT toggle;
  the tagline slot ships empty.
- **No timers**: roll-over arithmetic is a pure date-key comparison at read
  time; the card's lazy write is read-triggered, idempotent, and best-effort
  (a failed write answers `goober: null` next read and retries then).
- **Caps from constants.mjs, never re-declared:**
  | Constant | Proposed | Meaning |
  |---|---|---|
  | GC_GOOBER_DAY_SECONDS | 86400 | the UTC day-key unit |
  | GC_GOOBER_DAY_TAGLINE_MAX | 64 | the winner's free tagline bound |
  | GC_GOOBER_DAY_MIN_VOTES_FOR_CARD | 1 | the smallest tallied day that cards |
- D1-only, vanilla imperative, AGPLv3 header, no third-party anything.

## 4. RED rows delivered (tests/goober-of-the-day-red.test.mjs)

1. constants row — the three GC_GOOBER_DAY_* pins (flips when the constants
   land); currently fails (undefined).
2. opt-out respected — a vote against an opted-out member refuses (404
   shape), and the roll-over pick's own aggregate arm carries the
   `NOT EXISTS` opt-out filter INSIDE the SQL.
3. per-server isolation — a second server's card read answers nothing for
   the first server's votes, and every fired statement binds ITS OWN
   server seat.
4. no global list — the ladder shapes (`/api/goober/leaders`, a
   candidates route, a vote-history read) answer the unknown 404 shape and
   fire ZERO gc_goober statements.
5. anonymity during the window — across the whole vote+read flow, no
   statement whose SQL names gc_goober_votes ever SELECTs the voter
   mapping (the aggregate's GROUP BY is on votee_id; the only voter-keyed
   read is the caller's OWN one-row "did I vote" check).
6. one vote per member per day — the INSERT carries
   `ON CONFLICT (server_id, day_key, voter_id) DO NOTHING` and a raced
   double vote answers changes 0 → the same 409.
7. roll-over determinism — the same completed day answers the SAME winner
   across repeated reads (pure aggregate + `votes DESC, votee_id ASC`
   tie-break: an exact tie resolves to the LOWER member id, deterministically,
   and a re-read minutes later answers the identical card).

— Backend lane, T83, 2026-11-18. Sources: feature-slate wave-4 lane 2; the
T82 lane's read-gates-themselves and guarded-INSERT idioms (api/capsules.mjs,
migrations/0031).
