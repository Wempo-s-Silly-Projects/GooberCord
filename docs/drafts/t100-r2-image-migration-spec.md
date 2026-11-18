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

# T100 — R2 storage migration spec (2026-11-18) — ALL D1 byte surfaces

Owner order 2026-11-18: "i have r2 now migrate the d1-based image storage to
the r2." — clarified the same day: "this is for all things that use the d1
btw", read as EVERY D1 blob/byte-storage surface, not only images.

## Scope boundary (explicit)

R2 is object storage, not a database. ONLY the byte/blob surfaces move to R2.
ALL relational rows stay in D1 unchanged: messages, users, servers, channels,
sessions, roles, coins/economy, bookmarks, capsules, seasons, jobs, filters,
emoji/sticker/sound METADATA rows, `gc_attachments` itself — every table whose
columns are scalars/text/integers. No order reading moves the whole DB.

### Exhaustive byte-column sweep (grep receipts, migrations/*.sql)

The full BLOB/byte-column sweep over every migration finds EXACTLY these byte
surfaces — there are no others (gifs are Tenor proxy URLs, never stored bytes;
emoji/stickers/sounds/icons carry NO byte columns of their own — they ride
`gc_attachment_chunks` via `gc_attachments.id`):

| Byte surface | Migration receipt |
|---|---|
| `gc_attachment_chunks.data` | 0001:105, rebuilt byte-identical 0014:33 |
| `users.avatar_data` / `users.pending_avatar_data` | 0002:32, 0002:36 |
| `gc_upload_parts.data` (large-lane staging) | 0025:18 |

Bucket: `wempos-forum-r2` (R2 Basin, account 1fd10e6f…). This order
REVOKES the storage rulings' R2-dead clause and the D1-ONLY owner note on
`constants.mjs:209-210` ("no park, and no r2") — that comment text must be
amended when the lane lands. Hard pins unchanged: NATIVE R2 binding (no S3
keys in worker code), per-file AGPL headers, tier caps byte-unchanged, no D1
schema DROP in v1 (the D1 byte copy stays as the serving fallback until the
R2 path is verified live; a separate cleanup migration follows on the lead's
ritual).

## 1. INVENTORY — every D1 byte surface (receipts)

### Byte tables

| Table (migration) | Role | Access class |
|---|---|---|
| `gc_attachment_chunks` (0001:105, rebuilt 0014:33) | ALL attachment/emoji/sticker/sound bytes, 64,000-B rows | READ-HEAVY (message attachments + emoji/sticker images fetched on every channel load); WRITE-ONCE (bytes never edited) |
| `gc_upload_parts` (0025:18) | large-lane staging ledger, transient | WRITE-HEAVY transient, self-healing flush (api/uploads.mjs:207) |
| `users.avatar_data` / `pending_avatar_data` (0002:32,36) | avatars on the SHARED forum table; GC is READ-ONLY (api/avatars.mjs:19-24 — lifecycle is forum-side) | READ-HEAVY (every roster/session payload URL) |

These three are the WHOLE byte inventory (sweep table above) — every one is
migrated in this design; nothing byte-bearing is left in D1 after the
post-verification cleanup. The staging table is transitional: it dies with the
cleanup migration once the R2 path is verified live.

Metadata table (STAYS in D1): `gc_attachments` (rebuilt 0022:40) — message_id,
uploader_id, mime, size_bytes, status pending/approved/rejected, review fields.
Every consumer points here: `gc_emoji`/`gc_stickers` (0020:31,44),
`gc_sounds` (0023), `gc_servers.icon_media_id` (0003:9),
`gc_channels.icon_media_id` (0015:11). No separate icon/emoji/sound byte
tables exist — they all ride `gc_attachment_chunks` via `gc_attachments.id`.

### Byte routes (GET / PUT / DELETE)

- PUT small intake, standalone: `api/media.mjs:190-226` (`createAttachment`,
  POST /api/attachments at :498) — metadata row + per-chunk INSERTs, one batch.
- PUT small intake, send-with-image: `api/media.mjs:256-273`
  (`messageAttachmentStatements`) appended to the message batch in
  `api/messages.mjs:1194-1210`.
- PUT small intake, emoji/sticker: `api/emoji.mjs:337,350` — calls
  `createAttachment` from media.mjs (the shared path).
- PUT small intake, soundboard MP3/OGG ≤512 KiB: `api/soundboard.mjs:170-181`
  (`createSoundAttachment` → `standaloneAttachmentStatements`);
  `prepareSoundAttachment` (:154-168) owns the audio sniff.
- PUT large lane (≤~125 MiB, Goober+ full): `api/uploads.mjs` — part staging
  (:122-136), commit (:282-361) births the row and MOVES staging chunks into
  `gc_attachment_chunks` in one batch (:341-349).
- GET serving: `api/media.mjs:372-423` (route :502-507) — auth gate on
  metadata (:382-389), small rows assemble in memory (:280-294), large rows
  stream paged from D1 (:311-370). Avatars: `api/avatars.mjs:34-62`.
- DELETE (orphan/lifecycle): reject-flip `api/media.mjs:476-485`; message
  delete `api/messages.mjs:1357-1364`; server/channel wipe
  `api/servers.mjs:2882,2998-3045`; emoji/sticker delete `api/emoji.mjs:520-538`;
  soundboard asset delete `api/soundboard.mjs:399-416` (RESTRICT guards keep
  shared rows alive while another consumer still points at them).

## 2. DESIGN — the R2-bound replacement

### Binding (wrangler.toml, after the d1 block)

```toml
[[r2_buckets]]
binding = "GC_MEDIA"
bucket_name = "wempos-forum-r2"
```

Native `env.GC_MEDIA` operations only — `.put(key, value)`,
`.get(key)` (returns `{ body: ReadableStream, etag }` or null), `.head(key)`,
`.delete(key)`. The owner's S3 endpoint/keys stay OUT of the repo and the
worker: no S3 client, no access-key env var, no wrangler secret for storage.

### Key scheme — deterministic from existing tables, no new columns

- Attachment/emoji/sticker/sound/icon object: `gc-attachments/<gc_attachments.id>`
  (the id is the single join key every consumer already holds; the soundboard's
  RESTRICT guard proves one object serves several consumers with no copy).
- Avatar: `users/<user id>/avatar` and `users/<user id>/pending-avatar` (shared
  with the forum app; see §3 caveat).
- Zero schema change in v1: no `r2_key` column — the key is DERIVED from the
  row id, so `gc_attachments` remains the single source of truth. If a later
  wave needs per-row keys (content-hash dedup), that is migration 0044 (§5).

### Route changes

PUT — small intake (media.mjs `createAttachment` / `messageAttachmentStatements`
/ soundboard / emoji): unchanged D1 metadata + chunk batch (the D1 copy is the
v1 fallback), then one `GC_MEDIA.put("gc-attachments/" + id, sanitized.bytes)`
AFTER the batch resolves the id. Put-failure handling: the attachment row is
NOT deleted (the D1 copy is complete and serving falls back); a `put` miss is
recorded (`console.error` context, no secret) and the orphan-sweep repair lane
(§3 step 5) back-fills it. No retry loop in the request path.

PUT — large lane (uploads.mjs): the part contract is UNCHANGED (1 MiB part
requests; a single 1 GiB PUT is refused by the Workers request-body limit, the
platform constraint the 1 MiB lane already solves — this is why the parts
ledger STAYS in D1 as a staging table). At commit, the existing batch runs
verbatim, then the object is written by STREAMING the D1 chunk set into R2 —
a `ReadableStream` fed by the same paged reader serving.mjs uses
(`SERVING_PAGE_ROWS`, api/media.mjs:304), piped into
`GC_MEDIA.put("gc-attachments/" + id, stream)`. The isolate never holds more
than one 4 MiB page. Same put-failure posture as the small lane.

GET serving (api/media.mjs serving route): metadata + auth gate UNCHANGED
(D1 stay). On gate pass: `GC_MEDIA.get(key)` — object present → return
`new Response(object.body, …)` with today's exact header set (:357-369 /
imageResponse for small). Object null OR body fails → fall back to the
existing D1 paths (assembled + streamed) verbatim. Egress verification
unchanged: `sniffImageMime` on the head bytes still runs — for the R2 path,
get the object, read the first bytes, re-verify, then pipe the remaining body.
Avatars (`api/avatars.mjs`): same get→fallback shape against
`users/<id>/avatar` / `pending-avatar`.

DELETE: every DELETE site above gains the sibling
`ctx.waitUntil(GC_MEDIA.delete("gc-attachments/" + id))` ride (best-effort —
a missed delete leaves an orphan object, garbage-collectable, never a dangling
reference since D1 is the authority). The RESTRICT-guarded shared deletes
unchanged (R2 delete fires only when the row actually died).

### What stays in D1

`gc_attachments` (all columns), `gc_upload_parts` (staging only, unchanged),
`gc_attachment_chunks` (v1 fallback copy + the large-lane stream source).
Size/type validation chain untouched: `prepareAttachmentBytes`
(api/media.mjs:152-164), `sniffImageMime`/`sanitizeImage` (api/core/images.mjs,
vendored), `prepareSoundAttachment` (api/soundboard.mjs:154), the tier-cap
gate (`attachmentCapBytes`, api/uploads.mjs:231-238, :295-298) — `constants.mjs`
cap constants unchanged, only the :209-210 comment amended.

## 3. MIGRATION — existing prod D1 bytes → R2 (OWNER-RITUAL gated)

The seat never touches prod-D1 writes or prod R2 writes — the LEAD runs the
scripted ritual. Script shape (`scripts/r2-backfill.mjs`, run with a
`wrangler d1 execute`-equivalent read pass + direct R2 binding via a
temporary variant, or `wrangler r2 object put`):

1. READ (prod D1, read-only): `SELECT a.id, a.mime, a.size_bytes FROM
   gc_attachments a WHERE a.status <> 'rejected'` — for each id, page
   `SELECT seq, data FROM gc_attachment_chunks WHERE attachment_id = ? ORDER
   BY seq` (64 rows/page, the serving.mjs paging shape), assemble in memory,
   re-verify `sniffImageMime(head) === a.mime` and assembled length ===
   `size_bytes` (a mismatch = do NOT upload, log the id as a data defect).
2. PUT: `GC_MEDIA.put("gc-attachments/" + id, bytes)` per object.
3. VERIFY — NAME-PRESENCE audit, count alone is never proof: for EVERY source
   row id, `head("gc-attachments/" + id)` must answer an object whose `size`
   equals `size_bytes`; the printed ledger is id-by-id (id → etag), rows
   missing from the ledger are backfill failures, not a rounding note.
4. Avatars: separate read pass over `users` (avatar_data /
   pending_avatar_data ≤1 MiB) → `users/<id>/avatar` / `…/pending-avatar`,
   same head-per-row audit. NOTE: this is the SHARED forum column — coordinate
   with the wempos-forum lane; GC flips its reader only after the forum half
   confirms.
5. Post-verify orphan hygiene: `GC_MEDIA.list()` minus the row-id key set =
   orphan objects; the sweep reports them to the lead for the GC motion —
   never a blind delete.
6. D1 chunk table: NOT dropped, NOT emptied in this step. The cleanup
   migration (drop `gc_attachment_chunks.data` aging-out, empty
   `gc_upload_parts`) is a SEPARATE migration, numbered after R2 serving is
   verified live on prod, applied only on the lead's full verify ritual.

## 4. RED test plan

New `tests/r2-binding.test.mjs`: the fake env models the binding as a
`Map`-backed stub `{ put(key, value), get(key), head(key), delete(key) }`
recording every call; tests assert the binding-CALL SHAPE against the stub —
`put` keyed `gc-attachments/<id>`, serving calls `get` BEFORE any
D1-chunk read, delete sites call `delete` in `waitUntil`. Files that gain
pins: `tests/media-module.test.mjs` (intake + serving + fallback shape),
`tests/uploads-lane.test.mjs` (large-lane commit put + failure-tolerant
posture), `tests/avatar-serving.test.mjs` (R2-first avatar read),
`tests/security-rbac.test.mjs` (auth gate runs BEFORE the R2 read — pending
rows must not leak via the object path). RED-first: the stub ships without
behavior, pins fail on current code, then the lane turns them green.

## 5. ORDINAL

No schema change in v1 → no migration lands with the lane. 0044 is the next
slot and is RESERVED for the post-verification cleanup migration (D1 chunk
aging-out); 0043 stays parked-reserved for the reaction-tag opts index — the
cleanup does NOT take it.
