# T85 — Soundboard Studio (spec draft, RED rows staged)

Slate lane 4 (docs/drafts/feature-slate-wave4-2026-11-18.md): server sound
packs riding the existing soundboard module (api/soundboard.mjs, 0023's
gc_sounds) and the upload staging lane (0025's gc_upload_parts): mod-approved
clips, the 5MB floor per the tier caps law, keys everywhere. Packs are
per-server, deletable, and never auto-play. Identity: the server's little
theater. This lane is the CLIENT half: spec + RED rows only — no server
files, no migrations, no commits (PROD-D1 forbidden).

Status: SPEC DRAFT — unratified until the chair passes it.

## 1. What rides what (no rewrite, no fork)

- The soundboard module stays AS SHIPPED. `gc_sounds` keeps its Discord-real
  intake — 512KB, MP3/OGG, ≤5.2s, slots 8/24/36/48 by boost level
  (docs/parity-limits.md SOUNDBOARD rows, verified 2026-11-17). No column,
  cap, or CHECK in that table moves for packs.
- A PACK is the groupings layer over approved clips: per-server, mod-owned,
  deletable. The backend draft (a later lane's migration + routes):
  `gc_sound_packs { id, server_id REFERENCES servers(id) ON DELETE CASCADE,
  name, created_by, created_at }`, one indexed owner
  (idx on server_id), pack names borrowing the sound name bounds
  (GC_SOUND_NAME_MIN/MAX/PATTERN — 2–32, A-Za-z0-9_).
- Clip candidates ride the STAGING lane verbatim: the member POSTS the clip
  the way the large-file lane already works (gc_upload_parts chunk rows by
  client-held upload id), then a create-candidate route references the
  staged bytes; the MOD's approve commit is the only path from candidate to
  the pack (a denied candidate rides the staging abandon route — nothing new
  is invented for refusal).

## 2. The clip cap — read, never redeclared

New ONE-LINE constants seat (the backend lane lands it next to the
soundboard block):

```js
// Pack clips (T85, GC-beyond-parity: the server's own theater packs — the
// PARITY board's sounds cap stays 512 KB untouched): the tier caps law's
// floor — a pack clip intake may never admit LESS than 5 MB.
export const GC_SOUND_PACK_CLIP_MAX_BYTES = 5_242_880;
```

- The studio module imports it; a local byte literal in the client module is
  the defect the RED row hunts (the T-W mirror rule: constants.mjs is the
  one source).
- Client mirror enforcement: the studio's intake refuses an above-cap file
  BEFORE any staging POST (fail fast, the verbatim over-cap copy inline);
  the server re-checks and stays the authority — the mirror is convenience,
  never the gate.
- Parity note carried verbatim: 5 MB is a GC-beyond-parity surface (packs
  are GC's own feature); it does NOT touch the parity board's 512KB
  soundboard row.

## 3. The mod-approval flow (the UI)

- Seat: the studio rides the expressions manage surface as the third kind
  (the emoji/sticker manage pane's neighbor in the /s/:serverId/expressions
  lane) — the pack CRUD and the candidates list live there, manager-gated
  the way canManageExpressions gates the roster's manage seats; a refused
  viewer gets the shared 403 string, never a fabricated form.
- States: `candidate` (awaiting mod review) → `approved` (inside the pack,
  browsable by the server's members through the sound rider's list arm);
  the mod arms are approve/drop per candidate row, each an explicit press
  (no bulk, no auto). A pack lists as: name, sound count vs the server's
  boost-laddered slots (GC_SOUNDBOARD_MAX_PER_SERVER through the shared
  resolver), created date — and the delete arm (mod-only, one confirm
  dialog: openDialog, the row's delete copy, quiet-controls stay out of
  rows where G-7 already rules).
- Client module: `public/js/ui/soundboard-studio.js` — the CRUD consults:
  `listPacks(serverId)`, `createPack(serverId, name)`,
  `deletePack(serverId, packId)` riding
  `/api/servers/:serverId/sound-packs(+:packId)` — and the candidate arms
  `approveClip` / `dropClip` riding the pack's clips path. Every failure
  renders the payload's error string VERBATIM inline (G-2).

## 4. NEVER auto-play (the defaults law, and the rider's law stays)

- Pack surfaces render audio exactly the way the chat rider already does:
  `preload: "none"`, user-initiated controls only. No `autoplay` attribute
  anywhere in the module; no `.play()` call on render, on list, or on
  open — sound starts only when the member presses play.
- The chat.js rider's existing law is quoted, extended, kept: "browses + a
  LOCAL preview only; playing into chat or voice is a later parity lane,
  never this rider." Packs change nothing there.

## 5. Every painted string is a paired key

The client lane's en.json additions (the GREEN lands these; non-en bundles
ride the translation-commit law as its own later lane):

- `gc.studio.heading` — "Soundboard Studio"
- `gc.studio.packHeading` — "Sound packs"
- `gc.studio.packCreate` — "Name a pack"
- `gc.studio.packDelete` — "Delete pack"
- `gc.studio.packDeleteConfirm` — "Delete this pack? Its approved sounds leave the server's board list."
- `gc.studio.candidates` — "Waiting for review"
- `gc.studio.approve` — "Add to pack"
- `gc.studio.drop` — "Drop"
- `gc.studio.empty` — "No packs yet."
- `gc.studio.candidatesEmpty` — "Nothing waiting."
- `gc.studio.capNote` — "Clips ride the 5 MB pack cap — MP3 or OGG."
- `gc.studio.overCap` — (the intake's over-cap copy: names the cap, no paraphrase)

All copy rides `t()`; a painted literal in the module is the defect the key-pairing RED row hunts.

## 6. Deliberately NOT in this lane

- No server files, no migrations, no gc_sound_packs table (the backend lane's).
- No changes to gc_sounds, the parity board's 512KB row, or GC_SOUNDBOARD_* constants.
- No autoplay, no chat/voice playback (the rider's quoted law).
- No bulk approval; no auto-anything (the defaults law twice).

## 7. The RED rows this lane stages

tests/soundboard-studio-red.test.mjs (module + constants seat absent → four named reds):

1. "pack create, list, and delete ride the mod gate" — the module exports +
   manage-gate source pins + the route paths (fails: module absent).
2. "the 5MB clip cap is the constants seat, never a redeclare" — constants
   row GC_SOUND_PACK_CLIP_MAX_BYTES = 5_242_880 + the import pin (fails:
   both absent).
3. "pack surfaces never auto-play" — preload:none / no autoplay / no
   render-time .play() source pins (fails: module absent).
4. "every painted string pairs its en key" — the gc.studio.* keys read from
   public/locales/en.json + the module's t() call-site regexes (fails:
   module absent; keys absent).
