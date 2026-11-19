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

// Cycle-19 MEDIUMs, pinned (lane-c19-fix). The lane's targets:
// F1 — gc.settings.danger.removed (the server-delete consequence dialog
// line) and gc.settings.invites.revoke (the revoke button label / confirm
// verb) are UNSEATED in all nine bundles, so ar/zh/ja members read English
// in a translated dialog (t() falls through to humanize()); both keys seat
// real en copy and translate in the eight staged bundles (the wave i18n
// sweep idiom, scoped to these two keys);
// F2 — the boost-tier panel's uploads seat contradicts reality (GC_BOOST_
// LEVELS L1 uploadBytes sits BELOW the live free attachment cap and has
// ZERO enforcement consumers — paint-only); the perk line drops from the
// panel's seats (constants + locale keys STAY SEATED for the enforcement
// wave; header provenance at both removal sites);
// F3 — header truth only: migration 0053's header and api/bookmarks.mjs's
// header claim the list read JOIN-classifies dropped orphan pointers, but
// the shipped BOOKMARK_LIST_SQL (no join) carries them; both headers
// correct to the truth (classification is parked: T-PARITY-BOOKMARK-ORPHANS).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const SETTINGS_UI = read("public/js/ui/settings.js");
const CONSTANTS = read("constants.mjs");
const MIGRATION_0053 = read("migrations/0053_gc_bookmarks.sql");
const BOOKMARKS_API = read("api/bookmarks.mjs");

const BUNDLES = ["en", "de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const STAGED = BUNDLES.slice(1);
const bundleCopy = {};
for (const langKey of BUNDLES) {
  bundleCopy[langKey] = JSON.parse(read(`public/locales/${langKey}.json`));
}
const enData = bundleCopy.en;

// F1 — the two unseated keys -------------------------------------------------

const C19_KEYS = ["gc.settings.danger.removed", "gc.settings.invites.revoke"];

test("the call sites still paint both c19 keys (seating fixes the fall-through in place)", () => {
  assert.match(SETTINGS_UI, /t\("gc\.settings\.danger\.removed"\)/,
    "the consequence dialog line rides gc.settings.danger.removed");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.invites\.revoke"\)/,
    "the revoke button/confirm verb rides gc.settings.invites.revoke");
});

test("both c19 keys are en-seated real copy (never a humanize fall-through)", () => {
  for (const key of C19_KEYS) {
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0,
      `${key} is en-seated real copy`);
  }
});

test("the eight staged bundles carry both c19 keys TRANSLATED (the sweep idiom, 2 keys)", () => {
  for (const langKey of STAGED) {
    for (const key of C19_KEYS) {
      const value = bundleCopy[langKey][key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
      assert.notEqual(value, enData[key],
        `${langKey} carries ${key} TRANSLATED — no en placeholder (byte-equal carve)`);
    }
  }
});

test("no plural arms on the c19 keys (single strings, the wave law)", () => {
  for (const key of C19_KEYS) {
    assert.ok(!/_(one|other|few|many|zero|two)$/.test(key), `${key} is no plural arm`);
  }
});

// F2 — the upload perk face drops from the panel only ------------------------

test("the boost-tier panel drops the uploads seat but keeps the other four perk lines", () => {
  const panelSource = SETTINGS_UI.slice(SETTINGS_UI.indexOf("function boostTierPanel"));
  assert.doesNotMatch(panelSource, /perks\.upload/,
    "the unenforced upgrade-reading blessing no longer paints (c19 MED-2)");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.stream", \{ height: perks\.streamHeight, fps: perks\.streamFps \}\)/,
    "the stream/audio/stage family stays");
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.audio", \{ bitrate: perks\.audioBitrate \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.stage", \{ seats: perks\.stageSeats \}\)/);
  assert.match(SETTINGS_UI, /t\("gc\.settings\.boostTier\.perks\.heading"\)/);
});

test("gc.settings.boostTier.perks.upload STAYS SEATED in all nine bundles (the enforcement wave reclaims it)", () => {
  for (const langKey of BUNDLES) {
    assert.ok(typeof bundleCopy[langKey]["gc.settings.boostTier.perks.upload"] === "string",
      `${langKey} keeps gc.settings.boostTier.perks.upload seated`);
  }
});

test("the upload truth rides comment seats at BOTH removal sites (c19 MED-2 provenance)", () => {
  assert.match(CONSTANTS, /c19 MED-2/,
    "constants.mjs's GC_BOOST_LEVELS block names the paint-only truth");
  assert.match(SETTINGS_UI, /c19 MED-2/,
    "settings.js names the provenance where the perk line rode");
});

// F3 — header truth only (no SQL change in this lane) ------------------------

test("migration 0053's header states the orphan truth (no JOIN-classification claim)", () => {
  assert.ok(!/JOIN-classification/.test(MIGRATION_0053),
    "the false classification claim is gone from the header");
  assert.match(MIGRATION_0053, /T-PARITY-BOOKMARK-ORPHANS/,
    "the parked feature's ticket rides the corrected header");
  assert.match(MIGRATION_0053, /UNCLASSIFIABLE pointer row/,
    "the truth: orphan pointers ride the capped page as unclassifiable pointer rows");
});

test("api/bookmarks.mjs's header states the orphan truth (the list keeps the pointer rows)", () => {
  const header = BOOKMARKS_API.slice(0, BOOKMARKS_API.indexOf("import "));
  assert.ok(!/dead address answers nothing on the read/.test(header),
    "the false drop claim is gone from the header");
  assert.match(header, /T-PARITY-BOOKMARK-ORPHANS/,
    "the parked feature's ticket rides the corrected header");
  assert.match(header, /UNCLASSIFIABLE pointer row/,
    "the truth: the owner's list keeps them; unsave stays the manual owner-scoped removal");
});
