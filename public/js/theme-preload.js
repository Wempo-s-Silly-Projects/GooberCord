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

// Applied before styles.css paints (same-origin script, allowed by the
// vendored CSP's script-src 'self'). Reads BOTH appearance keys of the
// GC storage family — theme (light/dark, with the forum's legacy
// "forum-theme" as a read-only fallback) and skin ("goober-skin") — and
// sets the matching data attributes so the first paint is already themed.
// The color-scheme contract: the <meta name="color-scheme"> hint is the
// runtime source and the CSS :has() mapping follows it, so the stored pin
// lands on the hint (and re-paints the chrome pair, media dropped) — the
// absent case keeps "light dark" and the site follows the system preference
// even if this script never succeeds.
// Skin default ruling (2026-11-17, the owner's mock night): the approved
// gc-shell/shop mocks are the DISCORD skin ("discord skin fidelity"), so
// the absent value now carries "discord" — a stored "brand" still wins
// for anyone who deliberately kept the warm papers.
var SYSTEM_SCHEME = "light dark";
var CHROME_COLORS = { light: "#f7efdc", dark: "#131b27" };
var storedTheme = null;
try {
  storedTheme = localStorage.getItem("goober-theme") || localStorage.getItem("forum-theme");
} catch {
  // Storage can be blocked; CSS prefers-color-scheme remains the fallback.
}
var storedSkin = null;
try {
  storedSkin = localStorage.getItem("goober-skin");
} catch {
  // Ditto — the default (discord) skin applies.
}
var isPinnedTheme = storedTheme === "dark" || storedTheme === "light";
if (isPinnedTheme) {
  document.documentElement.dataset.theme = storedTheme;
  var pinnedChrome = CHROME_COLORS[storedTheme];
  for (var meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.removeAttribute("media");
    meta.content = pinnedChrome;
  }
}
var colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
if (colorSchemeMeta) {
  colorSchemeMeta.content = isPinnedTheme ? storedTheme : SYSTEM_SCHEME;
}
document.documentElement.dataset.skin = storedSkin === "brand" ? "brand" : "discord";
