# feature-slate — wave-12: the boost-tier surface (2026-11-19)

Through-line: the boost-level matrix (0023) is fully live SERVER-SIDE —
every emoji/sticker/soundboard write caps against api/boost-level.mjs's
resolver (max of base and level; a level never lowers what a server built) —
but no member can SEE their server's tier, its progress to the next level,
or what it blessed. Wave-12 gives the tier its face: one read payload, one
server-settings panel. The owner's matrix sequencing lands its "boost
levels" stage; cosmetics stay last.

## The feature

- **Backend (one additive read)**: `GET /api/servers/:id/boost-tier` —
  memberGate + read rateLimit (the capsule-mine route's wall family), rides
  serverBoostTier (zero new resolver logic, zero new SQL beyond the one
  resolver read); answers `{ boosts, level, caps, levelPerks, nextLevel }`
  where nextLevel derives from GC_BOOST_LEVELS ascending (level 0 → level 1
  at 2 boosts; L3 answers nextLevel: null). Envelope carries no member
  privacy surface — the boosts count is already on every server payload.
- **Client (one panel)**: server-settings boost-tier panel — the tier badge,
  the boosts count, the next-level progress bar (the wave-10 quests
  `{{progress}}/{{goal}}` neutral-seat idiom), the effective caps (emoji /
  stickers / soundboard — the resolver's caps directly), and levelPerks as
 -is (stream height/fps, bitrate, upload size, seats — never rounded
  client-side, never invented). Level 0 paints the base caps and the
  progress to level 1.
- **Parity law**: every number the panel paints traces to GC_BOOST_LEVELS /
  the LEVEL_BASE_CAPS family in constants.mjs (owner's verified matrix, the
  discord-parity-caps memory's sources at 2026-11-17) — no prose numeral,
  no client mirror of the level table (payload-carried by law).

## Laws the wave rides

- sink law: no coins — boosts are granted server-side, the panel mints
  nothing.
- defaults law: the panel's GET rides the settings page's own open (one
  auto-load per visit like the welcome-card/manage gates).
- no-copy sweep: every painted string rides t() keys, en + all 8 staged
  bundles; the parity numerals are data ({{seats}}), never prose literals.
- caps from constants: the panel NEVER mirrors the level table client-side;
  payload is the single source.
- backend byte-freeze (the wave-10/11 idiom): api/boost-level.mjs and every
  OTHER api/ module beyond the one new read stay byte-frozen; freeze pin
  fingerprints the wave's own committed range (the wave-9 lesson ×3).

## Sequencing

lane-w12-boost: RED-first pins, GREEN, uncommitted handback → lead commit →
isolated verify ×2 → deslop → merge → push → ritual deploy → probe stamp ==
pushed SHA → board.
