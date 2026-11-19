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

// Goober+ perks accent validator (free-for-everyone cosmetics, $0).
//
// users.profile_accent is deliberately NOT reused for this feature: the
// forum defines it as a whitelisted palette KEY (one of its fixed preset
// names) — the shared D1 keeps the forum's rendering contract, so GooberCord
// adds its own accent_color column (migration 0005) and never stores hex in
// profile_accent. Everything that touches the wire or a comment's markup
// with these values reads them back through the SAME validator so an inline
// style can never carry anything but strict lowercase #rgb/#rrggbb hex.
export const ACCENT_HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

export function isStrictHexAccent(value) {
  return typeof value === "string" && ACCENT_HEX_PATTERN.test(value);
}

// The public shape's accent: strict hex passes through verbatim (REST history
// and the WS/DO fan-out both expose it only then), everything else is absent.
export function publicAccent(value) {
  return isStrictHexAccent(value) ? value : null;
}
