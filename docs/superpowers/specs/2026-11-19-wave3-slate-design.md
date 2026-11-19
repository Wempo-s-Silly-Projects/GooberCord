# Wave-3 slate — R2 becomes the byte store of record (2026-11-19)

Owner-away autonomous slate under Section A. Grounding: owner verbatim
"R2 acquired, migrate ALL D1 blob/byte storage to wempos-forum-r2 bucket;
relational rows stay D1" (2026-11-18) and "time to get feature coding and
r2 migrating". The brainstorm gate is waived by the standing opt-out
orders ("go fully atonomous", "NO STOP IF STOP U FAIL", "assuming no human
intervention is required") — this doc records the owner's decided approach
as the design.

## Intent

The shared R2 bucket `wempos-forum-r2` (binding GC_MEDIA, live in prod
since 307d9b7) is currently a BEST-EFFORT byte MIRROR: D1
`gc_attachment_chunks` (64,000-byte BLOB rows) remains the store of record
and serving primary; R2 rides through `ctx.waitUntil`, swallows its own
errors, and serving falls back to D1 chunks. The owner order makes R2 the
store of record: blob/byte storage leaves D1 entirely; relational rows
(`gc_attachments`, `gc_sounds`, avatar identity rows) stay in D1.

## Goals

- New uploads write bytes to R2 as the durable leg (awaited, not
  waitUntil best-effort), with the D1 chunk write retained as the
  transition fallback until the backfill verifies.
- All currently-stored bytes migrate D1 → R2 (backfill), verified by
  NAME-PRESENCE (counts by name, never count alone).
- Serving: R2-first everywhere bytes exist (attachments, avatars, sound
  bytes through the same pipeline), D1-chunk serving survives ONLY as the
  fallback for pre-migration rows.

## Non-goals / anti-goals

- No relational row migration, no schema drop of `gc_attachment_chunks`
  in this wave — the drop is gated behind backfill verification + the
  fallback's retirement in a later wave (the D1-migration hazard law + the
  wave law both apply to any schema change).
- No feature drift: zero route-shape changes; upload/serving response
  bytes unchanged.
- prod-D1 writes stay name-presence-ritual-only; R2 writes are not the
  denied class.

## Approaches (considered)

1. **Flip first, backfill after (R2-primary immediately).** Rejected:
   rows whose bytes never reached R2 (best-effort mirror swallows errors)
   would serve from D1 chunks until the backfill lands anyway, and the
   flip's fallback legs hide whether the migration is complete. Two
   unverifiable states in prod at once.
2. **Backfill first, flip after**, with the flip writing R2 awaited and
   retaining D1 chunk write-through until the backfill's name-presence
   check passes. CHOSEN: each step independently verifiable; prod never
   holds bytes in only one unverifiable place; the write-through removal
   is its own later commit backed by the backfill evidence.
3. **Big-bang cutover + schema drop in one wave.** Rejected: violates the
   staged-migration posture; a schema drop on the shared D1 rides the
   NAME-PRESENCE ritual and the ledger, not a feature wave.

## Lanes

- **lane-r2-backfill** (backend): `scripts/r2-backfill.mjs` — stream every
  `gc_attachments` row's chunk bytes out of D1 (read-only D1 access +
  wrangler), upload each to `wempos-forum-r2` at its existing object key,
  report counts by name (uploaded / absent-in-R2 / zero-byte mismatches).
  Then RUN it, verify, record the receipt.
- **lane-r2-flip** (backend): intake flips to R2-awaited-primary in
  `api/media.mjs` (+ the avatars/sound pipelines that share it), D1 chunk
  write-through retained behind the flip; serving order pinned by tests
  (R2-first, chunk fallback for stragglers); zero route-shape changes.
  A follow-up commit removes the chunk write-through ONLY after the
  backfill's verified receipt lands on the taskboard.

## Version discipline

Rides `prototype` + COMMIT_SHA stamps; the ritual deploy + probes close the
wave; the full suite (currently 1551/1551) must stay unmasked-green at every
pushed tip.
