// Copyright 2026 YourLocalGoober
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

// v4.0 core leaf: composite pagination cursors — wire formats the browser
// holds, so encode and parse are pinned by unit tests. Imports nothing.
//
//   activity: <rank>_<seconds>_<id>  (rank 0 = pinned block, 1 = unpinned; a
//             missing rank is the legacy 2-part form an already-open tab may
//             still send) — walks (pinned, last_activity_at, id) keysets.
//   score:    <score>_<id> (signed) — walks the suggestions board's
//             (net score, id) keyset.
// Bare-id cursors (mine=1's `[0-9]{1,15}` and replies' `[1-9][0-9]{0,14}`)
// stay inline at their call sites: their validators differ by design and
// their error messages are route-specific. (GC's routes use bare-id cursors
// inline today; this leaf is the codecs' home for the day a feed needs them.)
//
// Phase-3 Kitskey migration: the codecs now LIVE in api/vendor/db.mjs
// (experience/db — byte-identical to the framework source, pinned by
// contract-parity); this leaf is the unchanged re-export seam.
//
// NOTE on the block-gate half of experience/db: GC's own block vocabulary
// diverged deliberately (gc_blocks carries a `kind` column — the hard
// 'blocked' tier and the soft 'ignored' tier the DM surfaces use), so it
// does NOT go through makeBlockGate: routing it there would change SQL,
// which a refactor-only migration never does. The gate leg stays forum-side
// until the framework learns the kind filter.
export {
  parseActivityCursor,
  parseScoreCursor,
  encodeActivityCursor,
  encodeScoreCursor,
} from "../vendor/db.mjs";
