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

// The expressions manage lane: caps live IN THE PAYLOAD (never re-derived),
// the name bounds are PER KIND (the sticker 30 is EXACT), the upload rides
// the multipart FormData arm, and the manage affordances render only where
// MANAGE_EMOJI (or the owner) says so — read-only rows otherwise.
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const calls = [];
let responses = [];
globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, method: init.method || "GET", body: init.body });
  const response = responses.shift();
  return new Response(typeof response === "string" ? response : JSON.stringify(response),
    { status: response?.status ?? 200 });
};

const expressions = await import("../public/js/ui/expressions.js");
const store = (await import("../public/js/core/store.js")).default;
const constants = await import("../constants.mjs");
const EXPR = readFileSync(join(HERE, "../public/js/ui/expressions.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("the mirrored constants equal the backend's (G-4)", () => {
  assert.equal(expressions.UI_EMOJI_FILE_MAX, constants.GC_EMOJI_FILE_MAX);
  assert.equal(expressions.UI_STICKER_FILE_MAX, constants.GC_STICKER_FILE_MAX);
  assert.equal(expressions.UI_SOUND_FILE_MAX, constants.GC_SOUNDBOARD_SOUND_MAX_BYTES);
  assert.equal(expressions.UI_EMOJI_NAME_PATTERN.source, constants.GC_EMOJI_NAME_PATTERN.source);
  assert.equal(expressions.UI_STICKER_NAME_PATTERN.source, constants.GC_STICKER_NAME_PATTERN.source);
  assert.equal(expressions.UI_SOUND_NAME_PATTERN.source, constants.GC_SOUND_NAME_PATTERN.source);
  // The sticker 30 is EXACT — a 2–32 blanket validator would be the defect.
  assert.doesNotMatch(expressions.UI_STICKER_NAME_PATTERN.source, /32/);
});

test("the three GETs ride one envelope; the payload's caps land untouched", async () => {
  responses = [
    { emojis: [{ id: 1, serverId: 5, name: "blob", url: "/api/attachments/2", createdAt: null }],
      caps: { emoji: 50, stickers: 5, sounds: 8 } },
    { stickers: [], caps: { emoji: 50, stickers: 5, sounds: 8 } },
    { sounds: [], caps: { emoji: 50, stickers: 5, sounds: 8 } },
  ];
  const payload = await expressions.loadExpressions(5);
  assert.equal(payload.emojis.length, 1);
  assert.deepEqual(payload.caps, { emoji: 50, stickers: 5, sounds: 8 });
  assert.equal(expressions.expressionsOf(5), payload);
  assert.equal(calls[0].path, "/api/servers/5/emojis");
  assert.equal(calls[1].path, "/api/servers/5/stickers");
  assert.equal(calls[2].path, "/api/servers/5/sounds");
});

test("the caps cite the payload and are never re-derived (the ladder is the server's)", () => {
  assert.match(EXPR, /caps\[kind\.key\]/, "the count line cites the payload's caps");
  assert.match(EXPR, /t\("gc\.expressions\.inventory\.count"/);
  assert.match(EXPR, /t\("gc\.expressions\.intro"/);
  assert.doesNotMatch(EXPR, /Math\.max/, "no client-side ladder arithmetic (G-4)");
});

test("the manage bit is one bit, three lanes: owner OR MANAGE_EMOJI", () => {
  assert.equal(expressions.canManageExpressions(
    { viewer: { owner: true, permissions: [] } }), true);
  assert.equal(expressions.canManageExpressions(
    { viewer: { owner: false, permissions: ["MANAGE_EMOJI"] } }), true);
  assert.equal(expressions.canManageExpressions(
    { viewer: { owner: false, permissions: ["MANAGE_CHANNELS"] } }), false);
  assert.equal(expressions.canManageExpressions(null), false);
});

test("routes: the inventories page and its separate upload route (G-6)", () => {
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/expressions\/new", "expression-new"/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/expressions", "expressions"/);
  // The upload form is its own route, not a dialog — and registers FIRST,
  // before the shorter "expressions" path and the channel catch-all.
  assert.ok(MAIN.indexOf('"expression-new"') < MAIN.indexOf('"expressions", renderExpressions'));
  assert.ok(MAIN.indexOf('"expressions", renderExpressions') < MAIN.indexOf('"channel", renderChannelPane'));
});

test("the upload arm is multipart FormData with per-kind fields (never JSON)", () => {
  assert.match(EXPR, /new FormData\(\)/);
  assert.match(EXPR, /data\.append\("name"/);
  assert.match(EXPR, /fileField: "image"/, "the emoji field");
  assert.match(EXPR, /fileField: "sound"/, "the sound field — and only for sounds");
  assert.match(EXPR, /accept: "image\/\*"/);
  assert.match(EXPR, /accept: "audio\/mpeg,audio\/ogg"/);
  assert.match(EXPR, /method: "POST", body: data/);
});

test("rename and delete: the per-kind paths, the 409 keeps the name, the delete confirms the bytes", () => {
  assert.match(EXPR, /PATCH", body: \{ name: field\.querySelector\("input"\)\.value \}/);
  assert.match(EXPR, /error\.message; \/\/ verbatim \(G-2\) — input intact/, "a 409 keeps the name");
  assert.match(EXPR, /DELETE", \{ method: "DELETE" \}\)|`\/api\/servers\/\$\{serverId\}\/\$\{kind\.key\}\/\$\{row\.id\}`, \{ method: "DELETE"/);
  assert.match(EXPR, /t\("gc\.expressions\.confirm\.deleteBytes"\)/,
    "the one delete confirmation states the byte consequence (G-6)");
});

test("cap reached: the create affordance disables with the server's 400 shape; rows stay ACTIVE", () => {
  assert.match(EXPR, /t\("gc\.expressions\.errors\.full", \{ cap, kind: kind\.singular \}\)/);
  // Comments tell the law; the pin sees only the code — no purge branch may
  // filter the rows by cap state (the items disable, never delete).
  const codeOnly = EXPR.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(codeOnly, /\blapsed\b/);
  assert.doesNotMatch(codeOnly, /\.filter\(/, "no purge branch over the rows");
  assert.match(EXPR, /rows\.map\(\(row\)/, "the rows loop maps over the FULL inventory");
});

test("empty inventory: the G-5 sentence per kind", () => {
  assert.match(EXPR, /t\("gc\.expressions\.inventory\.empty", \{ kind: kind\.singular \}\)/);
  assert.match(EXPR, /t\("gc\.expressions\.inventory\.first"/);
});

test("plain members see the shared 403 string; staff without the bit see read-only rows", () => {
  assert.match(EXPR, /canManageExpressions\(payload\)/);
  assert.match(EXPR, /staffViewing\(payload\)/);
  assert.match(EXPR, /t\("gc\.settings\.errors\.permission"\)/,
    "the 403 rides settings' swept seat (the expressions twin collapsed)");
  assert.match(EXPR, /\bmanage\b/, "the manage flag carries the control gating");
});

// --- the expressions lane speaks through the bundle ----------------------------

const EN = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

test("expressions.js speaks through gc.expressions.* (and the swept seats only)", () => {
  // The per-kind labels resolve through t(kind.labelKey) — their VALUES pin
  // below, the seat pins once:
  for (const [key, value] of [["kinds.emojis", "Emoji"], ["kinds.stickers", "Stickers"],
    ["kinds.sounds", "Sounds"]]) {
    assert.equal(EN[`gc.expressions.${key}`], value, `the bundle carries ${key}`);
  }
  const pinned = {
    "gc.expressions.intro": "Emoji, stickers, and soundboard sounds — counts ride the current cap (a boost blessing shows here; history stays quiet).",
    "gc.expressions.inventory.count": "{{count}} / {{cap}} — the cap rides the current boost tier.",
    "gc.expressions.inventory.used": "{{count}} / {{cap}} used.",
    "gc.expressions.inventory.empty": "This server hasn't added any {{kind}}s yet.",
    "gc.expressions.errors.full": "This server already has {{cap}} {{kind}}s. Delete one to add another.",
    "gc.expressions.name.save": "Save name",
    "gc.expressions.confirm.delete": "Delete “{{name}}”?",
    "gc.expressions.upload": "Upload",
    "gc.expressions.dialog.heading": "Add an expression",
    "gc.expressions.dialog.question": "What are you adding?",
    "gc.expressions.file.label": "File (emoji/sticker ≤256 KB image; sound ≤512 KB MP3 or OGG)",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(EN[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.match(EXPR, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
  // The collapsed twin reuses settings' swept seat; the seed died at this commit.
  assert.equal(EN["gc.expressions.name.help"], "2–32 characters: letters, numbers and underscores.",
    "the emoji/sound hint (resolved per kind)");
  assert.equal(EN["gc.expressions.name.helpShort"], "2–30 characters: letters, numbers and underscores.",
    "the sticker hint is EXACT, not a 32 superset");
  assert.equal(EN["gc.expressions.errors.permission"], undefined);
  assert.match(EXPR, /t\("gc\.settings\.errors\.permission"\)/);
  assert.match(EXPR, /t\("gc\.settings\.nav\.expressions"\)/,
    "the page heading rides the manage nav's swept seat");
  assert.match(EXPR, /t\("gc\.settings\.fields\.name"/);
  assert.match(EXPR, /t\("gc\.controls\.rename"\)/);
  assert.match(EXPR, /t\("gc\.controls\.back"\)/);
  assert.match(EXPR, /t\("gc\.controls\.keep"\)/);
  assert.match(EXPR, /t\("gc\.chat\.row\.delete"/);
  assert.match(EXPR, /t\(kind\.labelKey\)/, "the per-kind heading resolves its key");
  assert.match(EXPR, /t\(kind\.nameHintKey\)/, "the per-kind name hint resolves its key");
});

test("expressions.js holds NO sweep's leftover literals (the seat scan)", () => {
  const codeOnly = EXPR
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/t\("gc\.[^"]*"[^)]*\)/g, "")
    .replace(/t\(kind\./g, "t(")
    .replace(/t\(KINDS\[0\]\.nameHintKey\)/g, "t(")
    // the empty capLine starts blank and speaks after sync()
    .replace(/text: ""/g, "");
  assert.doesNotMatch(codeOnly, /text: "[A-Z←"'][^"]*"/);
  assert.doesNotMatch(codeOnly, /label: "[A-Z][^"]*"/);
  assert.doesNotMatch(codeOnly, /description: "[A-Z0-9][^"]*"/);
});
