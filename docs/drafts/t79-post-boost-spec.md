# T79 — forum post boost → server announcement channel (mirror card)

Status: SPEC + RED (draft; no implementation, no migration, no commit).
Branch: `fleet-wave-2026-11-18` @ c215561. Slate row 6 (the identity row:
"the shared DB and the twin cookies become a feature instead of plumbing;
the fleet is one community with two rooms").

## 1. What the feature is

A wempos-forum member boosts one of the forum's threads into a server's
**announcement channel** in GooberCord. The forum side MINTS the boost; the
GC side RENDERS one mirrored card message in the announcement channel. The
member sees the same community from both rooms.

- Forum side (mint): a session-gated forum endpoint records the boost row.
- GC side (render): a session-gated GC endpoint renders pending boosts as
  card messages into an announcement channel.
- ONE shared D1 holds the boost rows, exactly like identity + sessions.

## 2. The twin contract

### 2.1 Shared edge (cited from docs/drafts/t64-cross-app-deletion-shape-draft.md)

- **G1 — ONE D1, `users` as the single identity row** (t64 §1): the boost
  row keys its author to the SAME `users` row; the card shows that identity,
  not a copy.
- **G2 — one shared `sessions` table; `__Host-wempo_session` twin per t64
  G4** (t64 §1): the mint is authenticated by the forum's own session; the
  GC render is authenticated by GC's session; no cross-app token ever
  trades hands.
- **Deletion law (t64 §2 idiom): `fleet_boosts.author_id` rides `ON DELETE
  CASCADE` on `users`** — a deleted member's boost rows vanish WITH the
  author, and already-rendered card messages die through the same
  `gc_messages.author_id` CASCADE t64 records — no ghost cards, no orphan
  boost rows.

### 2.2 The shared table (`fleet_boosts`, migration on BOTH sides)

New shared table, authored as a forum-origin migration with an IF-NOT-EXISTS
vendored copy in GC's `migrations/`, exactly the G2 vendored-copy pattern
(`GooberCord/migrations/0002_vendored_core_tables.sql`). Sketched DDL — the
migration itself is a separate lane, NOT this deliverable:

```sql
CREATE TABLE IF NOT EXISTS gc_fleet_boosts (
  id INTEGER PRIMARY KEY,
  forum_post_id INTEGER NOT NULL REFERENCES posts(id),
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_title TEXT NOT NULL,
  thread_excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rendered_channel_id INTEGER NULL,
  rendered_message_id INTEGER NULL,
  -- no rendered_at column (the card message row carries the render
  -- timestamp) and no pair CHECK: the card's SET-NULL deletion action
  -- clears rendered_message_id while rendered_channel_id stays — a
  -- both-or-neither CHECK would refuse every card delete at its own
  -- action (the scoping pin found both while probing)
);
```

(`forum_post_id` + `rendered_channel_id` make a boost idempotent: one boost
  renders at most ONE card per announcement channel (UNIQUE partial index on
  `(forum_post_id, rendered_channel_id)` where `rendered_message_id IS NOT
  NULL`). Duplicate render returns the existing card, not a second copy.
- NULL `rendered_message_id` = pending mirror. GC renders PENDING rows for
  the target channel and stamps the rendered ids back. The render timestamp
  rides the card message row (the boost carries no rendered_at column — a
  SET-NULL deletion action can never clear a plain column).
- Retract: DELETE the forum boost row → the GC mirror pass, on its next
  run, deletes the stamped card message by `rendered_message_id` (the card
  is the boost's shadow, not an independent message).
- Name + FK notes (GREEN-lane resolution): the table rides GC's scoping
  pin as `gc_fleet_boosts` (tests/migration-scoping.test.mjs requires
  GC-created tables to be gc_-prefixed); the forum mint's later IF NOT
  EXISTS copy carries the same name. `posts` is the canonical posts table
  in the shared schema — the surviving name after the forum-ledger
  rebuilds (forum 0002 + 0034; GC code reads it at api/coins.mjs:179) —
  and the GC ledger vendors it IF NOT EXISTS per the 0002 pattern so its
  own-chain fresh-DB apply keeps FK-valid. The stamps carry no
  rendered_at and no inter-column CHECK (the SET-NULL deletion actions
  cannot clear a plain column and would break a pair CHECK at its own
  action).)

### 2.3 Forum side (mint)

- `POST /api/boost` (session-gated, the `__Host-wempo_session` cookie per
  t64 G4), body `{ post_id, reason? }`. Rate-limited by the existing binding
  idiom (`constants.mjs` is the cap source of truth). Server validates the
  post is visible and the session member authored the post — boosting is
  the author's act; a moderator MAY ride the existing role gate later.
- Row lands pending (`rendered_message_id NULL`). Forum does NOT insert into
  `gc_*` tables — the GC render pass owns every card byte, per the render
  section. Forum responds `{ boostId }` + the mirror card preview.

### 2.4 GC side (render)

- New channel kind: **`announcement`** joins the `gc_channels.kind` CHECK
  IN-list (`migrations/0001_initial_goobercord.sql:21` currently
  `('text','voice','dm','group')`) via the same migration lane. Announcement
  = server-wide `text`-like read surface; send rights stay permission-gated
  exactly as text today (`messages.mjs` send-denied note at
  api/messages.mjs:998 already treats announcement-style channels as
  view-alone for history).
- `api/boost.mjs` is the render module:
  - `validateAnnouncementChannel(channel)` — the channel-id gate. Unknown
    channel → 404; channel kind ≠ `announcement` → 409. The GC route
    `POST /api/servers/:serverId/channels/:channelId/consume-boosts`
    (session-gated, SEND-in-channel permission) validates FIRST, before any
    row moves.
  - `renderBoostCard(boost, forumOrigin)` — pure card composer. The card
    rides the same `gc_messages` INSERT path as every message
    (api/messages.mjs:143); the message body is the card. SHAPE below.
- The rendered card's `author_id` is the BOOSTING member (the shared users
  row, per G1) — deletion cascades wipe it, per 2.2. Card carries no
  cross-app auth state.

### 2.5 The mirrored card shape (the contract `renderBoostCard` pins)

```text
[Forum boost] {thread_title}
{thread_excerpt — capped at 240 chars, ellipsized}
Posted in the forum by {authorName} — read it at {forumOrigin}/posts/{forum_post_id}
```

Deterministic bytes: title line, single blank line, excerpt line, blank
line, provenance line. No markdown beyond line breaks (the card must survive
the filter pipeline exactly as plain text). `{forum_post_id}` rides the
forum's canonical `/posts/:id` addressable URL (the 5.0 one-surface model).

## 3. RED evidence (this deliverable)

`tests/boost-mirror-lane.test.mjs` pins the two lead-named rows RED against
the spec'd exports (module `api/boost.mjs` does not exist yet — import
failure IS the red state):

1. **announcement channel id validation** — unknown id 404s; a `text`
   channel 409s; an `announcement` channel passes.
2. **the mirrored card shape** — title/excerpt/provenance lines,
   240-char excerpt cap, canonical forum URL.

GREEN lane for a later commit: write `api/boost.mjs` to the spec (§2.4-2.5),
run `node --test tests/boost-mirror-lane.test.mjs` to green, then build the
route + migration lane.
