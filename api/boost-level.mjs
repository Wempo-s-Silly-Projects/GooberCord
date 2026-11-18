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

// The server boost LEVEL resolver (0023, the 2026-11-17 matrix): ONE shared
// lookup every level-gated number reads. gc_servers.boosts rides the recount
// discipline (both boost writes REPLACE it from gc_server_boosts in their own
// batches), so one PK-indexed read answers the tier — no count aggregation at
// any call site.
import {
  GC_BOOST_LEVELS,
  GC_EMOJI_MAX_PER_SERVER,
  GC_SOUNDBOARD_MAX_PER_SERVER,
  GC_STICKER_MAX_PER_SERVER,
} from "../constants.mjs";

// The matrix's counts are floor thresholds in ascending order: L1 at 2
// boosts, L2 at 7, L3 at 14; anything below the lowest floor is level 0.
export function boostLevelFor(boosts) {
  let level = 0;
  for (const entry of GC_BOOST_LEVELS) {
    if (Number(boosts) >= entry.boosts) level = entry.level;
  }
  return level;
}

const LEVEL_BASE_CAPS = {
  emoji: GC_EMOJI_MAX_PER_SERVER,
  stickers: GC_STICKER_MAX_PER_SERVER,
  soundboard: GC_SOUNDBOARD_MAX_PER_SERVER,
};

function levelEntry(level) {
  return GC_BOOST_LEVELS.find((entry) => entry.level === level) ?? null;
}

// The standalone boosts read's one SQL shape (T-AUD-M1): the same
// PK-indexed walk the recounts' column always got — both the standalone
// helpers and the folded gate read (messages.mjs SERVER_GATE_SQL, which now
// carries boosts too) answer the tier from THIS statement or its folded twin.
const BOOSTS_READ_SQL =
  "SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1";

// The FOLDED-row resolver (T-AUD-M1): a caller already holding the folded
// gc_servers row (messages.mjs SERVER_GATE_SQL — verification_level,
// rules_text, and now boosts in one read) derives the level's upload
// blessing OFF that row, no second ladder probe. The exact numbers
// serverUploadBytesCap always answered: 0 for a missing row (a lapsed recount
// lifts nothing), the level's uploadBytes otherwise.
export function uploadBytesForServerRow(serverRow) {
  return Number(levelEntry(boostLevelFor(Number(serverRow?.boosts ?? 0)))?.uploadBytes) || 0;
}

// The ONE read every consumer rides. `caps` carries the effective inventory
// numbers (a level can never LOWER an inventory — the effective cap is the
// larger of the shipped base and the level's blessing; the 0020 sticker base
// reads as its 0025-correction 5 against the 15/30/60 blessings, and the
// soundboard's base is its Discord-real 8 against 24/36/48 — max() keeps a
// level from ever lowering what a server built). `levelPerks` hands
// the full level entry (stream height/fps, bitrate, upload size, seats, the
// named feature gates) as-is for the payloads to expose; level 0 answers a
// null entry and the base caps only.

export async function serverBoostTier(env, serverId) {
  const row = await env.GOOBER_DB.prepare(BOOSTS_READ_SQL)
    .bind(Number(serverId)).first();
  const boosts = Number(row?.boosts ?? 0);
  const level = boostLevelFor(boosts);
  const entry = levelEntry(level);
  const caps = { ...LEVEL_BASE_CAPS };
  if (entry) {
    for (const key of Object.keys(LEVEL_BASE_CAPS)) {
      caps[key] = Math.max(LEVEL_BASE_CAPS[key], Number(entry[key]) || 0);
    }
  }
  return { boosts, level, caps, levelPerks: entry };
}

export { LEVEL_BASE_CAPS };

// The SERVER-CHANNEL upload blessing (T96): the level's `uploadBytes` row —
// L1 10 MiB, L2 50 MiB, L3 100 MiB (constants.mjs GC_BOOST_LEVELS uploadBytes,
// the owner's blessed Nov 16 2026 matrix). A DM/group channel (null/undefined
// serverId) answers 0 WITHOUT a read — the merge's identity, so a
// destination-less seat never consults the ladder.
export async function serverUploadBytesCap(env, serverId) {
  if (serverId === null || serverId === undefined) return 0;
  return uploadBytesForServerRow(
    await env.GOOBER_DB.prepare(BOOSTS_READ_SQL).bind(Number(serverId)).first(),
  );
}

// The GREEDIER-of merge (T96): the effective per-file cap is the LARGER of
// the member's enforced account seat and the destination's blessing — a
// level can never LOWER a cap (the shared resolver's max-of law, applied to
// upload bytes), and a 0 answer is the no-raise identity.
export function greedierUploadFileBytes(accountFileBytes, serverUploadBytes) {
  return Math.max(Number(accountFileBytes) || 0, Number(serverUploadBytes) || 0);
}
