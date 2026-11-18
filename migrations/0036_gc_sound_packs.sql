-- 0036: Soundboard Studio's pack tables (T85, docs/drafts/t85-soundboard-studio-spec.md §1)
-- — two small tables, nothing else (CREATE-only; no rebuild, no ALTER, no
-- backfill — a rebuild-class statement in this file is a STOP).
--
-- 1. gc_sound_packs — the mod-owned, per-server grouping row. Pack names
--    borrow the sound name bounds (GC_SOUND_NAME_MIN/MAX/PATTERN — 2–32,
--    A-Za-z0-9_, the same GLOB pair shape the 0020/0023 twins carry: the
--    first requires the pair start inside the set, the NOT GLOB requires
--    EVERY char inside the set — GLOB brackets are case-sensitive, so both
--    cases are listed). UNIQUE(server_id, name) so the create's collision is
--    the UNIQUE catch the soundboard lane answers 409.
--
-- 2. gc_sound_pack_sounds — the pack's clip rows, the two-state ladder the
--    spec §3 spells: 'candidate' (awaiting mod review) -> 'approved'
--    (inside the pack). A candidate references the STAGING lane verbatim
--    (0025's gc_upload_parts rows by the client-held upload id — no new
--    intake row shape is invented here); size/mime ride the row from the
--    stage read (the 5 MB tier-caps floor, GC_SOUND_PACK_CLIP_MAX_BYTES —
--    GC-beyond-parity; the PARITY board's 512KB gc_sounds row is untouched
--    and shares NOTHING with this table). Both states' DDL arms are
--    explicit: the pack dies with its server, its clips die with the pack,
--    and both cascades are written out — R2/KV never holds pack state and
--    the D1-only fleet deletes through D1's FK machinery.
--
-- Same contract as every sibling migration: the shared wempo-forum-data D1,
-- every object gc_-prefixed and independent of the later migrations —
-- applies cleanly right after 0035 (its only precondition).

CREATE TABLE gc_sound_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 2 AND 32
      AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
      AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(server_id, name)
);

CREATE INDEX idx_gc_sound_packs_server
  ON gc_sound_packs(server_id, created_at);

CREATE TABLE gc_sound_pack_sounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES gc_sound_packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL
    CHECK(length(name) BETWEEN 2 AND 32
      AND name GLOB '[A-Za-z0-9_][A-Za-z0-9_]*'
      AND name NOT GLOB '*[^A-Za-z0-9_]*'),
  upload_id TEXT NOT NULL,
  -- The 5 MB tier-caps floor: GC_SOUND_PACK_CLIP_MAX_BYTES (the clip cap is
  -- GC's own feature surface — the parity board's 512KB row is a separate
  -- contract, pinned in constants.mjs, untouched here).
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  mime TEXT NOT NULL CHECK (mime IN ('audio/mpeg', 'audio/ogg')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved')),
  added_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(pack_id, upload_id),
  UNIQUE(pack_id, name)
);

CREATE INDEX idx_gc_sound_pack_sounds_pack
  ON gc_sound_pack_sounds(pack_id, status);
