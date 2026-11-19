# feature-slate — wave-20: the chunk lane's byte leg to R2, the 1 GiB arm unlocked (2026-11-19)

Through-line: the chunked-upload lane is D1-ONLY (api/uploads.mjs:20, the
2026-11-17 owner ruling "no park, and no r2") — but the R2 revival order is
Nov 18 and newer by date ("R2 acquired, migrate ALL D1 blob/byte storage to
the wempos-forum-r2 bucket; relational rows stay D1"), and wave-19 was forced
to HOLD the owner-blessed 1 GiB plus arm precisely because a 1 GiB staging
writes ~1 GiB of chunk rows into the SHARED forum D1 (500 MB free plan,
shared with forum/accounts). This wave lands the unlock in one sweep: the
chunked lane's byte leg rides GC_MEDIA (the shared bucket every other GC
byte path already uses), D1 keeps ONLY the relational rows (keys, sizes,
seqs), and the lane ceiling becomes the tier's own blessed 1 GiB. BACKEND
WAVE (wave-12 precedent) with the client mirror retargets riding the same
commit.

## The feature

- **Chunk bytes to R2**: each staging part writes its payload to
  `gc-lane-staging/<uploadId>/<seq>` (the key family the media module's
  idiom implies; GC_MEDIA, wempos-forum-r2); the gc_upload_parts staging
  rows keep their relational arms (upload_id, seq, size, uploader) but stop
  carrying a bytes column write; the commit route assembles/streams from R2
  and the abandon/sweep paths delete their objects (the D1 row lifecycle
  stays the gate; the bucket follows it, never leads — the media.mjs:108
  law).
- **No serving fallback for the staging half**: a failed object put is a
  failed part (the request answers its own error; no D1 byte leg rides
  behind it) — the staging table's remaining blob column stays for schema
  compat but goes unwritten (a later migration may drop it; not this wave).
- **The 1 GiB arm**: GC_UPLOAD_LANE_MAX_BYTES retires as the lane ceiling —
  the bound becomes GC_PLUS_ATTACHMENT_BYTES exactly (full-plus only; the
  tier gate is unchanged), the PARTS_MAX stays an engineering constant, the
  client mirrors (UI_UPLOAD_LANE_MAX_BYTES + ridesChunkLane's window) pin
  computed-equality BOTH ways against the new truth.
- **Verbatim refusals**: no new error copy; size refusals reuse the existing
  lane/tooLarge families ×9.

## Laws the wave rides

- the R2 revival order (owner, 2026-11-18): ALL D1 blob/byte storage to
  wempos-forum-r2, relational rows in D1 — the newer order supersedes the
  2026-11-17 lane ruling by date, and it unlocks the owner-blessed matrix
  wave-19 had to hold.
- one bucket, one key discipline: staging keys are lane-namespace
  (gc-lane-staging/…), never attachment keys; GC-attachments serving keeps
  its own path byte-identical.
- sink law: uploads mint nothing. defaults law: no new client acts.
- no-copy sweep: no new painted strings; refusals reuse existing keys.
- freeze pins: the wave fingerprints its own committed range per-module
  (exempt list = the wave's touched files, the wave-9 lesson, now 11
  instances).
- migration posture: NO DDL expected (staging rows keep their shape;
  the write simply stops). If a CHECK/constraint forces a hand, the
  append-only law + the COLUMN-DANCE idiom (D1 FK-enforce law) hold.
- local migrations floor: migrations local floor 0017; no prod-D1 writes by
  agents (the wave writes schema nothing).

## Sequencing

lane-w20-r2: byte-leg truth map (turn 1) + RED-first pins (route-level, the
c23 wiring-gap class), GREEN, uncommitted handback → lead review → commit →
retarget freeze pins → isolated verify ×2 → deslop → merge → push → ritual
deploy → probe stamp == pushed SHA → board.

## Held-arm riders this wave inherits

- T-LANE-TIER-COMMIT-RECHECK (c26 LOW): the commit route's tier re-check —
  fold into this wave's commit rewrite (one gate, both size and tier).
- T-LANE-LEGACY-NULL-TIER (c26 LOW, pre-existing): OUT of scope unless the
  commit touch makes it free; otherwise stays parked untouched.
