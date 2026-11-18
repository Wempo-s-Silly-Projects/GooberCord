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

# Feature slate — wave 6 (2026-11-18): wire the boost ladder

Source of truth: the owner's blessed Goober+ / boost matrix (Nov 16 2026 night,
corrected the same week to Discord-real level-0 numbers). Ground truth found in
code: `api/boost-level.mjs` ships the ONE shared resolver (`boostLevelFor`,
0023) and constants.mjs carries the base caps (`GC_EMOJI_MAX_PER_SERVER=50`,
`GC_STICKER_MAX_PER_SERVER=5`, `GC_SOUNDBOARD_MAX_PER_SERVER=8`) — but grep
shows NO route module consumes the ladder (only boost-level.mjs imports those
symbols). The wave wires the ladder everywhere it should govern. This is the
wave-5 shape repeated: spec + RED per lane, GREEN serial on constants.mjs.

Economy framing (blessed): boosts stay server-owned; slots are server perks,
NOT purchasable cosmetics; accent/tagline stay free; cosmetics-last queue holds
(animated assets, name styles, per-server profiles, custom sounds as account
perks, app icons, video backgrounds — each is owner-gated before any lane).

## T93 — Emoji slot ladder (static/animated split)

- Caps: L0 50 total, L1 100, L2 150, L3 250 (the matrix rows).
- Split: animated emoji ride the SAME ladder seats but parity needs the
  static/animated split shape the matrix correction called out ("needs
  static/animated split") — verify Discord's current shape (animated slots
  per level) with a parity receipt (URL + date) BEFORE the migration; if the
  split cannot be receipted, wire the ladder totals-only and leave the split
  as its own follow-up row (never guess a parity number).
- Route: api/emoji.mjs creation gate reads boostLevelFor(server) → the level's
  cap; over-cap legacy rows stay (disabled-not-deleted law), only new creates
  blocked.
- Migration: only if the split receipts require a column; otherwise NONE
  (CREATE-only if any).

## T94 — Sticker slot ladder

- Caps: 5 base / 15 / 30 / 60 (the ladder the uniform-50 correction replaced).
- Route enforcement in the sticker creation path (same shape as T93),
  boostLevelFor-driven; over-cap legacy disabled-not-deleted.

## T95 — Soundboard slot ladder

- Caps: 8 base (the corrected level-0) / 24 / 36 / 48.
- api/soundboard.mjs / soundpacks.mjs wire the resolver; the shared
  slots-cap resolver comment (api/soundpacks.mjs:42) is the seat.

## T96 — Server-wide upload boost

- L1 10 MiB, L2 50 MiB, L3 100 MiB per-file upload limit for SERVER actions
  (distinct from the account tier column, already exact in
  GC_BOOST_LEVELS rows at constants.mjs:160-191).
- Wire: attachment intake (api/uploads.mjs attachmentCapBytes call sites)
  takes the GREEDIER of account tier and server level (a member uploads to a
  boosted server under the boost ceiling; their own DMs keep the tier cap).
  Statement: the gate reads gc_servers boosts once (the same recounted column
  the resolver trusts).

## Cross-wave riders (not wave-6 lanes; queued by their own rows)

- T97 = audit-stage findings (4 seats running) become lanes only if verdicts
  raise CRITICAL/HIGH rows.
- T-FIX-1, T90-c, T-DOCS-2 ride their in-flight seats.
- Cosmetics-last queue untouched (owner-gated per perk).
- Parity law: every number in a T93-T96 spec carries its URL + verification
  date before the lane's RED is allowed to pin it.

## File-collision plan

constants.mjs is the wave's single shared write-surface → lane dispatch is
SERIAL on that file (T93 → T94 → T95 → T96), each lane landing behind its
predecessor's green suite. api/ modules are lane-distinct. Dispatch waits for
the audit verdicts + the bork fixer (worker.mjs/client contention free, but
the merge/deploy chain must stay single-writer).

---
WAVE CLOSE (2026-11-18 ~22:45 EST): T93 emoji ladder (728a283), T94 sticker ladder (5c36b83),
T95 soundboard ladder (adc1f9c), T96 upload boost (a2c0653) — all LANDED + DEPLOYED, suite
1635/1635, probes green at every step. Open rows handed to audit: staged-lane destination
contract decision (frontend consult before client builds against the matrix), inert
GC_MINI_ATTACHMENT_BYTES pair, parity receipt riders. Next per standing order: audit sweep,
then wave-7.
