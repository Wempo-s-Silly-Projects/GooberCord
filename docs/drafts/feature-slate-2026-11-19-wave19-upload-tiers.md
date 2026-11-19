# feature-slate — wave-19: the upload tiers (2026-11-19)

Through-line: the Goober+ upload tiers are the owner's BLESSED matrix
(memory: uploads 50MB Mini / 1GB Plus; constants.mjs:245-248 carries the
pairs, plus.mjs's attachmentCapBytes resolves tier to a cap pair and the
chunk lane already full-plus-GATES at api/uploads.mjs:234) — but the
enforcement is partial and the live lane bound (GC_UPLOAD_LANE_MAX_BYTES
125 MiB) undercuts the Plus ceiling "the 1 GiB tier row is the table's
wording, this is the lane" (constants comment). This wave lands the
owner-sequenced UPLOAD TIERS stage: the caps the matrix blesses become
the caps the routes admit, and the client mirrors compute against the
same truth. This is a BACKEND WAVE (the wave-12 precedent: additive/
constants-tier enforcement, no verb mutations, the untouched modules
byte-frozen and pinned).

## The feature

- **Tier-aware caps**: free 20 MiB single-shot (unchanged); Mini 50 MiB
  (GC_MINI_ATTACHMENT_BYTES) rides the single-shot routes for Mini-term
  members; Plus 20 MiB single-shot PLUS the chunked lane admitting the
  FULL blessed 1 GiB (GC_PLUS_ATTACHMENT_BYTES) — the lane bound becomes
  the tier's own ceiling, not a separate 125 MiB wording.
- **Verbatim refusals**: size-class refusals carry the tier's own copy
  (the route's TOO_LARGE/PART/SIZE error families extended only at the
  size number); a mid-lane refusal never locks a member out of the
  small file's retry (the single-shot door stays open beside the lane).
- **Client mirrors**: uploads.js's UI mirrors recompute from the truth —
  free/mini/plus boundaries ride payload or constants-mirrors pinned
  computed-equality (the wave-14 C1 lesson); the composer never invents
  a threshold.

## Laws the wave rides

- enforcement never widens access beyond the blessed matrix (free stays
  free; Mini gets exactly the 50 MiB pair; Plus gets exactly 1 GiB) —
  the parity numbers carry their sources (discord-parity-caps memory,
  verified 2026-11-17: uploads 50MB Aug 2026 + 1GB Oct 2026 raises).
- sink law: no coins. defaults law: no new client acts (lanes open only
  when a file's size demands them, as today).
- no-copy sweep: new refusal copy rides t() keys ×9 real translations;
  any reused copy verified seated.
- freeze pins: the wave fingerprints its own committed range per-module
  — the modules the wave truly touches ride the range pins' exempt list
  (wave-12 precedent); untouched modules byte-identical.
- no migration DDL expected; if the cap plumbing needs a column the
  append-only migration law holds (0045/0055/0056 idioms).

## Sequencing

lane-w19-uploads: backend truth map (turn 1) + RED-first pins, GREEN,
uncommitted handback → lead review → commit → retarget freeze pins →
isolated verify ×2 → deslop → merge → push → ritual deploy → probe
stamp == pushed SHA → board.
