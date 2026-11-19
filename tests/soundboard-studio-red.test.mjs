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

// T85 Soundboard Studio (the spec's RED rows): pack CRUD behind the mod
// gate, the 5MB clip cap read from the constants seat (never redeclared),
// the no-autoplay law, and the t()-key pairing. The module these rows pin
// is public/js/ui/soundboard-studio.js and the constants seat rides
// constants.mjs — until the implementing lane lands both, every row loads
// or reads them itself and fails named, so the file reads four red rows,
// not one dead import.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const MODULE = "../public/js/ui/soundboard-studio.js";
const CONSTANTS = readFileSync(join(HERE, "../constants.mjs"), "utf8");
const EN = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

const loadStudio = () => import(MODULE);

test("pack create, list, and delete ride the mod gate (T85 row 1)", async () => {
  await loadStudio();
  // The CRUD consults, exactly the spec's route shapes:
  const source = readFileSync(join(HERE, MODULE), "utf8");
  assert.match(source, /export (async )?function listPacks\(serverId\)/,
    "list is a named consult");
  assert.match(source, /export (async )?function createPack\(serverId, name\)/,
    "create is a named consult");
  assert.match(source, /export (async )?function deletePack\(serverId, packId\)/,
    "delete is a named consult");
  assert.match(source, /\/api\/servers\/\$\{serverId\}\/sound-packs/,
    "the packs API path is the spec's shape");
  // The mod gate is the roster's manage shape, client-mirrored: a refused
  // viewer gets the shared 403 string, never a fabricated form.
  const chat = await import("../public/js/ui/expressions.js").catch(() => null);
  assert.ok(chat, "the expressions lane (the studio's manage-surface neighbor) loads");
  assert.match(source, /canManageExpressions|serverAdminRights/,
    "the studio's arms ride the roster's manage gate shape");
  assert.match(source, /["'`]\/api\/servers\/\$\{serverId\}\/sound-packs\/\$\{?/,
    "the per-pack arm rides the packs path, never a separate root");
  // The mod-only delete arm carries its one confirm (no bulk, no auto).
  assert.match(source, /openDialog\(/, "the delete arm confirms through the shared dialog");
});

test("the 5MB clip cap is the constants seat, mirrored once, never a second declaration (T85 row 2)", async () => {
  // The constants floor: pack clips admit the tier caps law's floor — 5 MB.
  assert.match(CONSTANTS,
    /export const GC_SOUND_PACK_CLIP_MAX_BYTES = 5_242_880;/,
    "the cap is the ONE constants seat (docs/parity-limits.md's 512KB board row stays untouched)");
  // The G-4 mirror: the client can't read the un-served root constants, so
  // the studio carries EXACTLY ONE equality-pinned mirror (the chat.js:52
  // pattern), commented as its source — nothing else redeclares the cap.
  const source = readFileSync(join(HERE, MODULE), "utf8");
  assert.match(source,
    /export const UI_SOUND_PACK_CLIP_MAX_BYTES = 5242880; \/\/ GC_SOUND_PACK_CLIP_MAX_BYTES \(G-4\)/,
    "the studio's mirror names its constants source and keeps the bytes equal");
  const studio = await loadStudio();
  assert.equal(studio.UI_SOUND_PACK_CLIP_MAX_BYTES, 5_242_880, "equality with constants.mjs");
  // One mirror only: no other client file redeclares the cap.
  const uiTree = readFileSync(join(HERE, "../public/js/ui/chat.js"), "utf8")
    + readFileSync(join(HERE, "../public/js/ui/expressions.js"), "utf8")
    + readFileSync(join(HERE, "../public/js/ui/economy.js"), "utf8");
  assert.doesNotMatch(uiTree, /SOUND_PACK_CLIP/, "no shadow seat outside the studio");
  // The client mirror refuses above-cap BEFORE the staging POST (fail fast).
  assert.match(code_only(source), /file\.size > UI_SOUND_PACK_CLIP_MAX_BYTES/,
    "the intake checks the file against the cap before any upload consult");
});

test("pack surfaces never auto-play (T85 row 3)", async () => {
  const source = readFileSync(join(HERE, MODULE), "utf8");
  const codeOnly = code_only(source);
  assert.doesNotMatch(codeOnly, /autoplay/, "no autoplay attribute anywhere");
  assert.match(codeOnly, /preload: "none"/, "pack audio preloads nothing (the rider's law)");
  assert.doesNotMatch(codeOnly, /\.play\(\s*\)/, "no render-time play() call");
  // The rider's quoted law stays quoted: playing into chat or voice is a
  // LATER lane, and this module says so in its own header comment.
  assert.match(source, /LOCAL preview only|never auto/i,
    "the module carries the rider's law verbatim in its header");
  await loadStudio();
});

test("every painted string pairs its en key (T85 row 4)", async () => {
  const KEYS = [
    "gc.studio.heading", "gc.studio.packHeading", "gc.studio.packCreate",
    "gc.studio.packDelete", "gc.studio.packDeleteConfirm", "gc.studio.candidates",
    "gc.studio.approve", "gc.studio.drop", "gc.studio.empty", "gc.studio.candidatesEmpty",
    "gc.studio.capNote", "gc.studio.overCap",
  ];
  for (const key of KEYS) {
    assert.ok(typeof EN[key] === "string" && EN[key].length > 0,
      `en.json carries ${key} (the spec §5's paired fill)`);
  }
  const source = readFileSync(join(HERE, MODULE), "utf8");
  for (const key of KEYS) {
    assert.match(source, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
  en_literal_sweep(source);
  await loadStudio();
});

function code_only(source) {
  return source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function en_literal_sweep(source) {
  // No painted literal copy outside the keys: a quoted UI string in the
  // module's paint calls (text:/aria-label:/placeholder:) is the defect.
  const codeOnly = code_only(source);
  const painted = codeOnly.match(/(?:text|aria-label|placeholder): ["'`][A-Za-z]/g) || [];
  assert.deepEqual(painted, [], "painted copy rides t() keys, never inline literals");
}
