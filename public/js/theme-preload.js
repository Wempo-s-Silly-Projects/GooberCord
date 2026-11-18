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

// Applied before styles.css paints (same-origin script, allowed by the
// vendored CSP's script-src 'self'). Reads BOTH appearance keys of the
// GC storage family — theme (light/dark, with the forum's legacy
// "forum-theme" as a read-only fallback) and skin ("goober-skin") — and
// sets the matching data attributes so the first paint is already themed.
// Skin default ruling (2026-11-17, the owner's mock night): the approved
// gc-shell/shop mocks are the DISCORD skin ("discord skin fidelity"), so
// the absent value now carries "discord" — a stored "brand" still wins
// for anyone who deliberately kept the warm papers.
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
if (storedTheme === "dark" || storedTheme === "light") {
  document.documentElement.dataset.theme = storedTheme;
}
document.documentElement.dataset.skin = storedSkin === "brand" ? "brand" : "discord";

// The a11y rows ride the same pre-paint beat (T81, spec §3.4): high
// contrast and the font scale land before styles.css, so neither ever
// flashes on a re-theme. FONT_STEPS is pinned to shell.js's list (the
// preload can't import); the token default lives in styles.css :root.
var FONT_STEPS = [0.875, 1, 1.25];
var storedHighContrast = null;
try {
  storedHighContrast = localStorage.getItem("goober-hc");
} catch {
  // Storage blocked — the :root tokens apply for this beat.
}
if (storedHighContrast === "on") {
  document.documentElement.dataset.hc = "on";
}
var storedFontScale = Number.NaN;
try {
  storedFontScale = parseFloat(localStorage.getItem("goober-font-scale"));
} catch {
  // Ditto — the :root default (1) applies for this beat.
}
if (FONT_STEPS.includes(storedFontScale)) {
  document.documentElement.style.setProperty("--font-scale", String(storedFontScale));
}
