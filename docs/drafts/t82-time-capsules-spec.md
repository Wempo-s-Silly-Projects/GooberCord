# T82 — Time Capsules spec

Wave-4 lane 1 (slate: `docs/drafts/feature-slate-wave4-2026-11-18.md`). Branch
`fleet-wave-2026-11-18`. Spec + RED only in this lane:
`tests/time-capsules-red.test.mjs` (RED today by construction — the module and
the table do not exist; the file's first statement fails on the import —
that IS the RED raw error and the GREEN seed).

Identity: a letter to your future self, postmarked by the server. One
schedule, one reveal, zero timers.

## 1. The seat (one table, nothing else)

```sql
CREATE TABLE gc_time_capsules (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  channel_id INTEGER NULL REFERENCES gc_channels(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  reveal_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_time_capsules_author ON gc_time_capsules(author_id, server_id);
CREATE INDEX idx_gc_time_capsules_channel ON gc_time_capsules(channel_id, reveal_at);
```

- `channel_id IS NULL` is the SELF-SEAL: the letter rides to the author alone.
- A channel target is the mod desk's own allow: the capsule rides the SAME
  channel-overwrite layers the message send does — the mod desk allows by not
  denying the author's SEND seat in that channel. No second config table, no
  new toggle (the one-table law; the desk's existing seat IS the switch).
- NO `revealed_at` column, NO `deleted_at` column: the reveal state reads
  from `reveal_at <= now` at read time (no timers, no cron, no lazy
  write-back), and deletion is a hard row delete while it is legal — the
  GDPR shape (the letter goes when the author says it goes).
- Deletion law: the author's account row CASCADEs; the target channel's
  deletion CASCADEs (a dead channel's capsules die with it).

## 2. API surface (all `requireUser`, all rate-limited, member-gated 404)

- `POST /api/servers/:serverId/capsules` `{ body, revealAt, channelId? }` —
  opt-in by construction: NOTHING is ever default-on; a capsule exists only
  because a member acted. Refusals: body 1..2000 trimmed chars; `reveal_at`
  strictly future between GC_CAPSULE_MIN_AHEAD_SECONDS and
  GC_CAPSULE_MAX_AHEAD_SECONDS ahead; `channelId` absent = self-seal, present
  = a real channel of THIS server the author may send in (404 shape if not);
  the author's OPEN-capsule cap (the count of their pre-reveal rows) rides
  the create INSERT's own `COUNT(*) < ?` WHERE arm (the guarded-INSERT idiom,
  api/servers.mjs's shape — a racing burst can never overshoot).
- `GET /api/servers/:serverId/capsules/mine` — the author's OWN rows only
  (sealed AND revealed states answered, keyed on `author_id = ?` INSIDE the
  read — cross-member rows are unreachable by construction, the privacy law).
- `DELETE /api/servers/:serverId/capsules/:id` — author-only, and ONLY while
  `reveal_at > now` (the delete gate rides the arm — a revealed letter is
  locked; the refusal is the 409 copy "Your letter has been revealed — it
  stays where it was posted."). Hard delete, one row, gone.
- `GET /api/servers/:serverId/capsules/:id` — THE reveal gate, one row, one
  time comparison in the statement: `reveal_at <= ?` opens the body,
  `reveal_at > ?` keeps it sealed.
  - the author before reveal: the SEALED shape only —
    `{ id, revealAt, sealed: true }` and nothing of the body. The surprise
    stays sealed even from its writer (the lane's identity — the letter is
    read at the postmark, not before; the author's own control rides
    DELETE-while-locked-open instead).
  - the author after reveal: `sealed: false` plus the body.
  - a non-author before reveal: the 404 shape (no existence oracle — nobody
    learns the capsule exists).
  - a non-author AFTER reveal: readable only inside the target channel's
    own VIEW gate (channelForUser's member read), and a self-sealed capsule
    NEVER leaves its author (404 for everyone else, forever).
  - the revealed channel surface: the capsule answers at its `id` through
    this gate; the CHANNEL read's own render (the client lane painting
    revealed capsules into the room) is OUT of backend scope here — reads
    gate themselves, one row at a time, on the same comparison.
- Route registration rides worker.mjs's API_HANDLERS at GREEN (the
  handleCoinRoutes dispatch-chain position), plus the migration
  (next free number — 0030 is taken: `migrations/0031_gc_time_capsules.sql`).

## 3. Laws (this lane's version)

- Defaults law: opt-in only — no capsule is ever created, revealed, or
  rendered without the acting member's own request; nothing ships a
  notification, a timer, or a background writer. The reveal is a property of
  the ROW, checked server-side by time comparison at read time.
- Deletion control: hard-delete until reveal, locked after — the author's
  control ENDS at the postmark (their letter becomes the room's).
- Privacy law: pre-reveal the body exists in exactly one read path (the
  author's post-reveal metadata read never carries the body either). No
  cross-member read exists anywhere in the surface, and the list route
  carries the author seat inside one indexed WHERE.
- No-copy sweep: every client-painted string rides t() keys; the backend's
  refusal copies stay en-only until the tr-dept ratifies (CARVE_GATES when
  they fill).
- Caps from constants.mjs, never re-declared:
  | Constant | Proposed | Meaning |
  |---|---|---|
  | GC_CAPSULE_BODY_MAX | 2000 | the letter's text bound |
  | GC_CAPSULE_MIN_AHEAD_SECONDS | 300 | the postmark's floor (no instant letters) |
  | GC_CAPSULE_MAX_AHEAD_SECONDS | 2592000 | 30 days ahead — the schedule's ceiling |
  | GC_CAPSULES_MAX_OPEN_PER_MEMBER | 10 | one member's open-capsule cap |
- Sink law N/A (no mints); D1-only, vanilla imperative, AGPLv3 header, no
  third-party anything.

## 4. RED rows delivered (tests/time-capsules-red.test.mjs)

1. constants row — the four GC_CAPSULE_* pins (flips when the constants
   land); currently fails (undefined).
2. the create answers the acting member a sealed letter (201, sealed shape,
   no third party's rows).
3. the list answers ONLY the member's own capsules (the author seat rides
   the read, not the filter).
4. delete-before-reveal succeeds (the GDPR shape: the row is GONE).
5. the delete gate locks at the postmark (revealed → 409, the letter stays).
6. the reveal gate: 404 before (no existence oracle for a non-author),
   200 after — inside the channel's own view gate; a SELF-SEAL stays 404 to
   everyone but its author, forever.
7. the no-cross-member-reads row: no statement of the surface can carry an
   author it does not filter on (the read SQL's own author seat).

— Backend lane, T82, 2026-11-18. Sources: feature-slate wave-4 lane 1; the
T76 lane's guarded-INSERT and member-gate idioms (api/coins.mjs,
api/campfire.mjs, api/servers.mjs @ 900).
