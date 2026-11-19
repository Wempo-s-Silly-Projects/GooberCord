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

// UTC day floor — the same boundary every economy cap (the daily grant, the
// per-source caps, and the ceiling) plus the daily-quest gate rides: "today"
// is one thing everywhere.

/**
 * Floor a seconds timestamp to its UTC day start.
 * @param {number} seconds - POSIX seconds timestamp
 * @returns {number} the start of that timestamp's UTC day, in seconds
 */
export function dayFloor(seconds) {
  return seconds - (seconds % 86400);
}
