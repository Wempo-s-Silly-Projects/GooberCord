# T89 — Reaction tags spec

Wave-5 lane (slate: `docs/drafts/feature-slate-wave5-2026-11-18.md`). Branch
`fleet-wave-2026-11-18`. Spec + RED only in this lane — no implementation, no
commit; GREEN rides the next lane turn.

Identity: **collecting moments into a tag.**

Through-line: a mod pins a handful of emoji→tag pairs that name the moments
the server cares about; a member opts in per tag with one act, and the server
profile paints the tags they opted into — own only. The seat RIDES the
existing reaction surface: the map keys on the same emoji vocabulary
`gc_message_reactions` paints (migrations/0009_social.sql:86,
api/social.mjs:141-147 `REACTION_GROUPED_SQL`), so a tag chip reads exactly
like a reaction in the client; NO message-reaction engine is built here and
no reaction row is written by any route in this seat.

Economy re-rule honored (memory: goobercord-project-decisions): tags are FREE
cosmetics. No mint, no price, no coin statement anywhere in the seat. Members
earn through community acts; cosmetics are given, not sold.

## 1. User stories

- As a mod, I map an emoji to a tag for my server with one PUT (defaults
  law: no tag exists for any server until a mod maps one — no seed rows, no
  default map).
- As a member, I see my server's tag map and opt into a tag with one POST;
  re-opting is idempotent (still one opt row, still 200).
- As a member, I remove my opt with one DELETE by me, for me; un-opting a
  tag I never opted (or a tag that does not exist) answers the SAME shared
  404 body — "not yours/never opted" and "no such row" are indistinguishable.
- As a member of another server (or a non-member), an opt against a tag id
  outside my reach answers the same shared 404 — reachability lives INSIDE
  the statement, no existence oracle.
- As a non-mod, a PUT/DELETE against the tag map makes zero changes and
  answers the shared 404 — never a 403 (statement-gate class,
  api/paper.mjs:64-73).
- As an un-signed visitor, every reaction-tag route answers 401.
- As a member, the server-profile read (`GET .../reaction-tags/mine`) lists
  ONLY the tags I opted into — no other member's tags, ids, handles, or any
  count across members; no leaderboard exists.

## 2. Acceptance criteria

- [ ] Seat shape is EXACTLY two rows: `gc_server_reaction_tags` (the mod's
      map: id, server_id, emoji, tag_text, created_by, created_at) and
      `gc_reaction_tag_opts` (membership: tag_id, user_id, opted_at). No
      message column anywhere — the seat never anchors a message; the
      reaction store (gc_message_reactions) is untouched.
- [ ] PUT upserts ONE map row mod-gated inside the statement: a non-mod's
      write answers changes-0 → the shared unknown-server 404, NEVER a 403.
- [ ] PUT beyond GC_REACTION_TAGS_MAX answers changes-0 → the shared 404
      (the cap rides the statement's WHERE, no pre-read oracle).
- [ ] Member opt POST is self-scoped, idempotent (ON CONFLICT DO NOTHING),
      and deletable; a changes-0 opt resolves to 200 {opted: true,
      duplicate: true} when the caller's OWN opt row already exists, else
      the shared 404 (bookmark idiom, api/bookmarks.mjs BK_SAVE_SQL).
- [ ] GET mine answers only the caller's opted tags, newest-first
      (`ORDER BY o.opted_at DESC, t.id DESC`), capped at GC_REACTION_TAGS_MAX;
      no member column painted, no cross-member count.
- [ ] Un-authed: every route answers 401 before any seat statement fires
      (Origin present).
- [ ] Tag text law: `tag_text` is a locale-key REFERENCE (matches
      `/^[a-z0-9_]+(\.[a-z0-9_]+)+$/`, e.g. `gc.tags.snow_melt`) OR a short
      server-native string of ≤ GC_REACTION_TAG_TEXT_MAX (32) unicode
      code points — NO painted free-text of unbounded length; anything else
      answers 400 before any seat statement.
- [ ] No-mint guard: NO route in this seat fires a `gc_coin_ledger` or coin
      statement (spec §6) — tags are free cosmetics.
- [ ] Migration 0041 is CREATE-only: two CREATE TABLEs, ONE index, NO FK, no
      shared-table edit, no ALTER of gc_messages/gc_message_reactions.
- [ ] Every painted string rides t() at GREEN; the en key list this lane
      adds: `tags.title`, `tags.empty`, `tags.opt`, `tags.opted`,
      `tags.remove`.
- [ ] Caps ride constants.mjs imports (GC_REACTION_TAGS_MAX,
      GC_REACTION_TAG_TEXT_MAX) — never re-declared in route code.
- [ ] Suite rides the isolated-worktree bind at the pushed SHA.

## 3. Routes (GREEN surface — api/reaction-tags.mjs, worker.mjs API_HANDLERS
next-to-handleBookmarkRoutes)

| Method | Path | Gate | Body |
|---|---|---|---|
| PUT | `/api/servers/:id/reaction-tags` | requireUser + rateLimit("write") + mod statement-gate | `{emoji, tag}` → `{tag: {id, emoji, tag}}` |
| GET | `/api/servers/:id/reaction-tags` | requireUser + read + membership-in-statement | `{tags: [{id, emoji, tag}]}` |
| DELETE | `/api/servers/:id/reaction-tags` | requireUser + write + mod statement-gate | `{emoji}` → `{}` (200) or shared 404 |
| POST | `/api/servers/:id/reaction-tags/:tagId/opt` | requireUser + write + reachability-in-statement | `{opted: true}` |
| DELETE | `/api/servers/:id/reaction-tags/:tagId/opt` | requireUser + write, self-scoped | `{}` (200) or shared 404 |
| GET | `/api/servers/:id/reaction-tags/mine` | requireUser + read | `{tags: [{id, emoji, tag}]}` — own opts ONLY |

The shared 404 body for the whole tag family is `Reaction tag not found.` —
non-mod write, unknown tag, non-member, never-opted un-opt: ONE body, no
oracle between any of them.

## 4. The SQL (pinned bind orders — RED's fake encodes these)

```js
// The mod-gated upsert: BOTH arms gated (2026-11-18 lead ruling on the
// t89-review CRITICAL — a bare VALUES upsert takes the plain-INSERT arm
// where no WHERE is ever evaluated, so the role gate and the map cap ride
// the SELECT-WHERE for the insert arm AND the DO UPDATE's WHERE for the
// update arm; a gated arm answers changes-0 either way → the shared 404).
// Upsert refreshes in place (paper idiom, api/paper.mjs:64-69).
const TAG_PUT_SQL =
  "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) " +
  "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "AND (SELECT COUNT(*) FROM gc_server_reaction_tags t WHERE t.server_id = ?) < " + GC_REACTION_TAGS_MAX + " " +
  "ON CONFLICT (server_id, emoji) DO UPDATE SET tag_text = excluded.tag_text, " +
    "created_by = excluded.created_by, created_at = excluded.created_at " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "AND (SELECT COUNT(*) FROM gc_server_reaction_tags t WHERE t.server_id = ?) < " + GC_REACTION_TAGS_MAX;
// .bind(server_id, emoji, tag_text, created_by, created_at,
//        server_id, user_id, server_id,   — the INSERT arm's role + cap
//        server_id, user_id, server_id)   — the update arm's role + cap
//   — 11 binds, this order

// The mod-gated unmap: role inside the DELETE's WHERE; wrong role / wrong
// emoji → changes-0 → shared 404.
const TAG_DELETE_SQL =
  "DELETE FROM gc_server_reaction_tags WHERE server_id = ? AND emoji = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm WHERE pm.server_id = ? " +
    "AND pm.user_id = ? AND pm.role IN ('owner','moderator'))";
// .bind(server_id, emoji, server_id, user_id)   — 4 binds

// The member read of the map: membership inside the WHERE — a non-member
// read answers [] only via a real reachable read... no: answers through the
// statement gate, changes-classified to the shared 404 by the route.
const TAG_MAP_READ_SQL =
  "SELECT id, emoji, tag_text FROM gc_server_reaction_tags WHERE server_id = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm WHERE pm.server_id = ? AND pm.user_id = ?) " +
  "ORDER BY created_at DESC, id DESC LIMIT " + GC_REACTION_TAGS_MAX;
// .bind(server_id, server_id, user_id)   — 3 binds

// The opt: reachability (tag row in THIS server + THIS member) INSIDE the
// statement; ON CONFLICT DO NOTHING = idempotent. changes-0 → route reads
// the caller's OWN opt row to split "already mine" from "not reachable".
const TAG_OPT_SQL =
  "INSERT INTO gc_reaction_tag_opts (tag_id, user_id, opted_at) SELECT ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_reaction_tags t " +
    "JOIN gc_server_members pm ON pm.server_id = t.server_id " +
    "WHERE t.id = ? AND pm.user_id = ?) " +
  "ON CONFLICT (tag_id, user_id) DO NOTHING";
// .bind(tag_id, user_id, opted_at, tag_id, user_id)   — 5 binds

const TAG_OPT_OWN_READ_SQL =
  "SELECT opted_at FROM gc_reaction_tag_opts WHERE tag_id = ? AND user_id = ?";

// The un-opt: self-scoped, owner IS the only key (bookmark idiom).
const TAG_UNOPT_SQL =
  "DELETE FROM gc_reaction_tag_opts WHERE tag_id = ? AND user_id = ?";
// .bind(tag_id, user_id)   — 2 binds

// The mine read: the caller's opted tags for THIS server, own only, no
// count across members, capped.
const TAG_MINE_READ_SQL =
  "SELECT t.id, t.emoji, t.tag_text FROM gc_reaction_tag_opts o " +
  "JOIN gc_server_reaction_tags t ON t.id = o.tag_id " +
  "WHERE o.user_id = ? AND t.server_id = ? " +
  "ORDER BY o.opted_at DESC, t.id DESC LIMIT " + GC_REACTION_TAGS_MAX;
// .bind(user_id, server_id)   — 2 binds
```

## 5. Migration sketch (0041 — per lane brief; CREATE-only)

```sql
CREATE TABLE gc_server_reaction_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  tag_text TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (server_id, emoji)
);
CREATE TABLE gc_reaction_tag_opts (
  tag_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  opted_at INTEGER NOT NULL,
  PRIMARY KEY (tag_id, user_id)
);
CREATE INDEX idx_gc_reaction_tags_server
  ON gc_server_reaction_tags (server_id);
```

- NO FK anywhere: a deleted tag leaves an orphan opt row the mine read's
  JOIN naturally drops — no CASCADE arm, no shared-table edit.
- Two tables, one index, nothing else — 0041 is byte-identical to the
  PROD-applied migration (owner applied 2026-11-18, d1_migrations ids 84-86;
  NEVER touch it after an apply). PARKED candidate migration 0043
  (gc_reaction_tag_opts user index, t89-review LOW) sits in migrations/
  unapplied. No message anchoring, no per-message reaction write, no
  leaderboard table, no count rollup — the map + the opt row ARE the whole
  feature.
- LOCAL floor 0017; remote applies only under the full NAME-PRESENCE ritual.

## 6. Laws (this lane's version)

- **Defaults law**: no tag rows and no opts exist until someone acts; an
  untouched member's mine-read answers `{tags: []}` — the empty list is a
  valid answer, not an error.
- **Economy re-rule (the seat's core law)**: tags are FREE cosmetics — no
  mint, no sink, no price, no coin statement; a paid tag cap or tag price is
  a ladder-shaped idea and is OUT, owner-gated (§7).
- **Statement-gate idiom** (api/paper.mjs:64-73, api/bookmarks.mjs): mod
  role, membership, reachability, and the map cap live INSIDE the
  statements; changes-0 classifies to the shared 404 — no pre-read oracle,
  no 403 anywhere in the seat.
- **Privacy law**: the mine read carries the caller's rows only; the map
  read carries no member column at all; NO count across members, no
  leaderboard, no activity rollup (paper.mjs's GROUP BY law rides as its
  absence — this seat aggregates nothing).
- **Tag text law**: locale-key reference OR ≤ GC_REACTION_TAG_TEXT_MAX (32)
  code points; 400 before any seat statement otherwise.
- **Cap**: GC_REACTION_TAGS_MAX = 20 per server (ours, ≤ the 25-lane brief
  bound, aligned with GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE = 20;
  constants.mjs:524 parity), GC_REACTION_TAG_TEXT_MAX = 32
  (same family as GC_GOOBER_DAY_TAGLINE_MAX = 64's "short server-native
  string" ruling, constants.mjs:386 — both named constants.mjs imports,
  never re-declared).
- **Ride law**: the emoji vocabulary keys into the existing reaction paint
  (gc_message_reactions, migrations/0009_social.sql:86); this seat writes
  no reaction row and touches no message route — the reaction engine is
  NOT reinvented.
- D1-only, vanilla imperative, AGPLv3 header, no third-party anything.

## 7. OWNER_GATED

- **Discord parity claim**: Discord's "custom reaction role/tag" surfaces
  (e.g. reaction-role bots) are not a pinned first-party parity doc — per
  the parity-numbers law, any Discord cap/limit claim for tags rides GREEN
  with a source URL + date, or ships as GooberCord-native (20 and 32 are
  ours, claimed).
- **Tag unlock by reacting**: a future rule where a member EARNS a tag's opt
  by having reacted with its emoji in the server (riding gc_message_reactions
  rows as evidence) would join the two stores — OUT of this lane's scope;
  owner ruling required before any such bridge.
- **Tag color/cosmetic variants**: tags are text+emoji chips; per-tag color
  or animated paint is a cosmetic-ladder idea, owner-gated.

— Backend lane, T89, 2026-11-18. Sources: migrations/0009_social.sql:86
(existing reaction store),
api/social.mjs:141-147/:532-588 (reaction surface + ADD_REACTIONS gate),
api/paper.mjs:64-73 (statement-gate mod idiom),
tests/bookmarks-red.test.mjs (fake-DB harness + self-scoped DELETE idiom),
constants.mjs:513-524 (GC_PLUS_REACTIONS / GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE).
