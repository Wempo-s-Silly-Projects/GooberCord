# T92 — Server Welcome Card (spec draft)

Lane: T92 · branch `fleet-wave-2026-11-18` · RED seat doc · status: RED delivered
Green-lane targets: `api/welcome-card.mjs` (new), `worker.mjs` handler registration,
`constants.mjs` seat cap, `migrations/0042_gc_welcome_cards.sql`.

## 1. Identity

The server says hello its own way. A server's mods write a short blurb once;
every member who then visits the server can pull that blurb exactly once —
a private, member-self-recorded greeting. The card is content the mods
authored for their members, not painted site chrome, and it mints nothing.

## 2. Defaults law

OFF until a mod configures it. No row, no card, nothing fires for new
members. Absence of the `gc_welcome_cards` row IS the off-state (the 0037
idiom): a server whose mods never touched the feature answers its GET with
the shared unknown-server 404 and nothing else is read or written for the
asking member. There is no default row, no tombstone, and no per-member
view rows written by any path other than the member's own fetch.

## 3. Seat — migration 0042_gc_welcome_cards.sql

CREATE-only, one migration file carrying BOTH tables, no FK constraints,
no ALTER, no seed INSERT.

- `gc_welcome_cards` — the config seat: `server_id` PRIMARY KEY,
  `blurb_text` (length capped by the constants seat, §5), `enabled`
  INTEGER NOT NULL DEFAULT 0. One row per server, ever.
- `gc_welcome_card_views` — the shown-once ledger: `(server_id, user_id)`
  composite PRIMARY KEY plus `shown_at`. No FK. "Shown once" is
  member-self-recorded: a member row exists only after the member
  themselves fetched the card — a view row can never pre-exist a member's
  own GET, and the row's only writer is that GET's INSERT.

## 4. Routes and gates

- **PUT /api/servers/:id/welcome-card `{ blurb }`** — mod write via the
  statement-gate class, the T89-ruled BOTH-ARMS pin (the fresh-INSERT arm
  AND the conflict arm each gated): the upsert's fresh-INSERT arm is
  `INSERT INTO gc_welcome_cards (server_id, blurb_text, enabled) SELECT ?,
  ?, 1 WHERE EXISTS (…gc_server_members owner/moderator gate on
  (server_id, actor_id)…)` and its `ON CONFLICT (server_id) DO UPDATE SET
  blurb_text = excluded.blurb_text, enabled = 1 WHERE EXISTS (the same
  owner/moderator gate)` rides the identical arm — so a non-mod's write
  makes changes-0 on whichever path it takes (first write or overwrite) and
  classifies to the shared unknown-server 404 — never a 403 existence
  oracle. Bind order: `[server_id, blurb, server_id, actor_id, server_id,
  actor_id]` (bound[0]/[1]/[3] stay the RED fake's pinned reads). Blurb
  over the cap → 400 validation (checked before any statement fires), and
  an empty or whitespace-only blurb rides that same 400 family — the arm
  checks emptiness on the trim BEFORE the length bound, while the stored
  text itself stays verbatim, never trimmed. A 200 PUT answers
  `{ blurb }` — the stored blurb echoed back verbatim, no member columns,
  no painted prose key (locale law §5). The view ledger's own insert is
  idempotent by key: `ON CONFLICT (server_id, user_id) DO NOTHING`, so two
  concurrent first GETs both serve the fetched blurb and neither 500s.
- **GET /api/servers/:id/welcome-card[?repeat=1]** — member-gated
  (pre-read membership; non-member → the shared 404). Contract:
  - No card configured → 404, shared unknown-server class — NOT a distinct
    "no card" body. The configured-but-absent states are indistinguishable
    to a non-configured server's members: no config-existence oracle.
  - First fetch answers `{ blurb, shown: true }` and records the view row.
  - Second fetch answers `{ shown: true, blurb: null }` unless `?repeat=1`
    is explicit — re-show on the member's own request (spec §1: the member
    can re-read their greeting, the silence is theirs, not the server's).
  - Un-authed → 401 (Origin present, no session).

## 5. Locale law

The blurb is member-authored server content, the same class as message
text: it is stored verbatim, painted verbatim, and never translated,
painted, or rewritten server-side. The chrome strings around the card ride
`t()` keys on the client; the API's payloads carry no painted prose key.
The blurb cap (`GC_WELCOME_CARD_BLURB_MAX`) is a HOUSE cap, not a parity
claim — no source URL rides it.

## 6. Economy and tracker law

No mint, no tracker guards: the card fetch fires no coin statements, and
view rows are the only new writes in the whole feature. The card reads no
member rollup beyond the fetching member's own view row.
