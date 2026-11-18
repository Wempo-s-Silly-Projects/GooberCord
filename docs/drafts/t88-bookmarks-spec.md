# T88 — Bookmarks spec

Wave-5 lane (slate: `docs/drafts/feature-slate-wave5-2026-11-18.md`). Branch
`fleet-wave-2026-11-18`. Spec + RED only in this lane — no implementation, no
commit; GREEN rides the next lane turn.

Identity: **your reading list, nobody else's.**

Through-line: a bookmark is a PRIVATE POINTER a member saves onto a message —
one thin row (who saved it, which message, when), nothing else. No text copy,
no snippet, no read-state, no note field: the pointer is only an address, and
the address is served by the message table it already points at. Every
statement in the seat carries `owner_user_id` in its WHERE — there is no
cross-member read, no mod override, no admin surface, no leaderboard. A mod
gets NOTHING from this feature; ownership is the only key.

## 1. User stories

- As a member, I save a message to my reading list with one act (defaults
  law: the list is empty for every member until they save something — no
  auto-bookmark, no default rows, nothing exists until the member acts).
- As a member, I open my bookmarks and see ONLY my own pointers, newest
  save first, capped — I never see, and can never learn, what anyone else
  saved (not by id, not by count, not by the 404 shape).
- As a member, I delete one of MY bookmarks by id; deleting someone else's
  bookmark (or a bookmark id that does not exist) answers the SAME shared
  404 body — "not yours" and "no such row" are indistinguishable, so no
  existence oracle exists.
- As a member, I save a bookmark on a message in a server I belong to;
  a wrong message id or a message in a server I am not a member of answers
  the shared message-family 404 body — member and non-member see ONE body.
- As an un-signed visitor, every bookmarks route answers 401.
- As a member whose saved message was later deleted, the dead pointer drops
  off my list at read (the read joins the message table); the pointer row it
  self remains (no FK, no CASCADE) and never serves content — there is
  nothing to serve (the row IS just an address).

## 2. Acceptance criteria

- [ ] Row shape is EXACTLY `(id, owner_user_id, message_id, saved_at)` —
      no content column, no snippet, no read-state flag, no server_id (the
      server comes via the message join), no note.
- [ ] Every statement carries `owner_user_id` in its WHERE; no
      gc_bookmarks statement exists without it; no cross-member read exists.
- [ ] GET answers only the caller's own rows, newest-first
      (`ORDER BY saved_at DESC, id DESC`), cut at GC_BOOKMARKS_LIST_MAX.
- [ ] DELETE by id is owner-only via the statement gate
      (`WHERE id = ? AND owner_user_id = ?`): wrong-owner answers changes-0
      → the shared unknown 404 body, NEVER a 403 (no existence oracle).
- [ ] POST save answers changes-0 with the shared message-family 404 body
      for a wrong message id, a non-member, and a non-existent server —
      ONE body for all three (statement-gate idiom, T87's paper.mjs:172).
- [ ] Re-saving a message I already bookmarked is idempotent: still one
      row, still 200, no duplicate (NOT EXISTS guard inside the statement).
- [ ] Un-authed: every route answers 401 before any seat statement fires.
- [ ] Migration 0038 is CREATE-only: one CREATE TABLE + one CREATE INDEX,
      NO FK, NO shared-table edit, NO read-state column.
- [ ] Sink law: N/A — bookmarks mint and sink nothing (no coin surface
      touches the list; a paid bookmark limit is a ladder-shaped idea).
- [ ] Every painted string rides t() at GREEN; the en key list this lane
      adds: `bookmarks.title`, `bookmarks.empty`, `bookmarks.save`,
      `bookmarks.saved`, `bookmarks.remove`.
- [ ] Suite rides the isolated-worktree bind at the pushed SHA.

## 3. Routes (GREEN surface — api/bookmarks.mjs, worker.mjs API_HANDLERS)

| Method | Path | Gate | Body |
|---|---|---|---|
| POST | `/api/messages/:messageId/bookmark` | requireUser + rateLimit("write") | `{ saved: true, id, savedAt }` |
| GET | `/api/bookmarks` | requireUser + rateLimit("read") | `{ bookmarks: [{ id, messageId, savedAt }] }` |
| DELETE | `/api/bookmarks/:bookmarkId` | requireUser + rateLimit("write") | `{}` (200) or the shared 404 |

Channel-anchored shapes (`/api/channels/:id/bookmarks`) were rejected: a
bookmark anchors a MESSAGE, not a channel — a message-anchored POST carries
no body at all and needs no channel-id round-trip.

## 4. The SQL (pinned bind orders — RED's fake encodes these)

```js
// The statement-gated save: ONE statement answers membership + existence +
// idempotence. changes-0 = wrong message / non-member / server unknown →
// the shared message-family 404. Pre-duplicate (changes-0 but own row
// exists, owner-scoped read, no oracle) answers 200 { saved: true, duplicate: true }.
const BK_SAVE_SQL =
  "INSERT INTO gc_bookmarks (owner_user_id, message_id, saved_at) " +
  "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_messages m " +
    "JOIN gc_server_members sm ON sm.server_id = m.server_id " +
    "WHERE m.id = ? AND sm.user_id = ? AND sm.server_id = m.server_id) " +
  "AND NOT EXISTS (SELECT 1 FROM gc_bookmarks b " +
    "WHERE b.owner_user_id = ? AND b.message_id = ?)";
// .bind(owner_user_id, message_id, saved_at, message_id, owner_user_id,
//        owner_user_id, message_id)   — 7 binds, this order

const BK_LIST_SQL =
  "SELECT id, message_id, saved_at FROM gc_bookmarks WHERE owner_user_id = ? " +
  "ORDER BY saved_at DESC, id DESC LIMIT " + GC_BOOKMARKS_LIST_MAX;

const BK_DELETE_SQL =
  "DELETE FROM gc_bookmarks WHERE id = ? AND owner_user_id = ?";
```

The duplicate check after a changes-0 save reads the caller's OWN row only
(`b.owner_user_id = ?`) — it can distinguish "already mine" from "not
reachable" without ever learning that another member saved the message.

## 5. Migration sketch (0038 — next free after T87's 0037)

```sql
CREATE TABLE gc_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_bookmarks_owner_message
  ON gc_bookmarks (owner_user_id, message_id);
```

- NO FK anywhere (per lane ruling): a plain index on `(owner_user_id,
  message_id)` serves both the list scan and the duplicate guard. A deleted
  message leaves an orphan pointer that the read's JOIN naturally drops —
  no CASCADE arm to reason about, no shared-table edit, no FK arm on any
  other table's delete path.
- ONE table, ONE index, nothing else. No reads cursor, no archive, no
  read-state seat, no "later" table — the pointer IS the whole feature.
- LOCAL floor 0017; remote applies only under the full NAME-PRESENCE ritual.

## 6. Laws (this lane's version)

- **Defaults law**: no rows exist until the member saves; no auto-bookmark,
  no default-on anything; an untouched member's GET answers the empty list
  `{ bookmarks: [] }` — the empty list is a valid answer, not an error.
- **Privacy (the seat's core law)**: `owner_user_id` in EVERY WHERE; no mod
  gate exists because mods get nothing; the list payload never carries
  another member's handle, id, or any count of their saves; the 404 bodies
  are shared so wrong-owner and wrong-id are indistinguishable.
- **Statement-gate idiom** (api/paper.mjs:64-73, :172): ownership and
  reachability live INSIDE the statement; the route classifies a changes-0
  to the shared 404 — no pre-read oracle, no 403.
- **Sink law**: N/A — no mint, no sink, no coin touch.
- **Cap**: GC_BOOKMARKS_LIST_MAX = 100 (constants.mjs, never re-declared).
  A list beyond the cap is a pagination owner-gate (see §7), not a cap
  raise.
- D1-only, vanilla imperative, AGPLv3 header, no third-party anything.

## 7. OWNER_GATED

- **Discord parity claim**: Discord's "save message" surface has no pinned
  public doc URL in the fleet ledger — per the parity-numbers law, any
  cap/limit claim attributed to Discord rides GREEN with a source URL +
  date, or ships as a GooberCord-native choice (100 is ours, claimed).
- **List pagination**: v1 = newest 100, no cursor. A cursor surface beyond
  GC_BOOKMARKS_LIST_MAX is an owner ruling (the cap is an honest cut, the
  list does not silently pretend to be complete).
- **Orphan pointer GC**: pointer rows whose message is gone stay in the
  table (read-time filtering only). A periodic sweep would need a timer —
  the no-timers fleet idiom governs; only an owner ruling creates one.

— Backend lane, T88, 2026-11-18. Sources: api/paper.mjs (statement-gate
routes), tests/morning-paper-red.test.mjs (fake-DB harness),
docs/drafts/t87-morning-paper-spec.md (doc shape), constants.mjs export
surface (naming parity).
