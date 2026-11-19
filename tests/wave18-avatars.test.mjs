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

// Wave 18 — the avatar face (the 2026-11-19 slate): the client face of the
// live, byte-frozen avatar backend (GC serves /api/avatars/:id?v=; the
// payload carries the URL as data — publicUser's avatarUrl and the server
// roster row's avatarUrl). The roster rail and the member card paint the
// payload's own URL verbatim; a null paints exactly today's shape; an
// in-flight failure removes the img and leaves the row standing (the
// attachment-404 idiom). No chat paint — message payloads carry NO
// avatarUrl (the wave-13 tag-chip scope guard). Backend BYTE-FROZEN: this
// suite edits nothing under api/, worker.mjs, core/ — the freeze pin
// fingerprints the wave's own committed range.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE18_PATHS = ["api", "worker.mjs", "core"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

// The seat is RED-first: the module edits are uncommitted when the pins run
// first — each client read is fresh and fails NAMED (the wave-16 idiom).
const MEMBERS = () => {
  try {
    return read("public/js/ui/members.js");
  } catch (error) {
    throw new Error(`RED: members.js unreadable — ${error.message}`);
  }
};
const STYLES = () => read("public/styles.css");

// --- the frozen backend is the single source (read, NEVER edited) -----------

const ROSTER = read("api/servers.mjs");
const ACCOUNTS = read("api/accounts.mjs");

test("the payload carries the avatar as data (the backend truth the paint rides)", () => {
  assert.match(ROSTER, /avatarUrl: avatarUrlOf\(row\),/,
    "the server roster row ships avatarUrl");
  assert.match(ACCOUNTS, /\n {4}avatarUrl: row\.avatar_mime/, "publicUser ships avatarUrl");
  assert.doesNotMatch(ROSTER.slice(0, ROSTER.indexOf("avatarUrlOf")), /avatarUrl/,
    "the payload arms ahead of the shared helper carry no avatar field (roster row is the only server-side arm)");
});

// --- the roster rail paints the payload's own URL ----------------------------

test("the roster row paints the avatar from the rider's own field, src verbatim", () => {
  const source = MEMBERS();
  const rowArm = source.slice(source.indexOf("for (const member of members) {"),
    source.indexOf("// saveNickname(serverId, uid, nickname)"));
  assert.match(rowArm, /avatarPaint\(member\.avatarUrl,\s*\n?\s*member\.nickname \|\| member\.username\)/,
    "the row paints the avatar seat where the payload already speaks the member's identity");
  assert.doesNotMatch(source, /"\/api\/avatars\/"|\+ "?v="|\/api\/avatars\/\$\{/, "no client-built URL — the src is the payload's own string, verbatim");
});

test("a null avatarUrl paints EXACTLY today's shape (no invented placeholder)", () => {
  const source = MEMBERS();
  const avatarPaint = source.slice(source.indexOf("function avatarPaint("),
    source.indexOf("\n}\n", source.indexOf("function avatarPaint(")));
  assert.ok(avatarPaint.includes("function avatarPaint("), "the paint is its own named arm");
  assert.match(avatarPaint, /typeof url !== "string"/,
    "null/absent/short arms paint NOTHING (no placeholder block, no invented initials for the roster)");
  assert.doesNotMatch(avatarPaint, /initials|placeholder/i, "the null arm invents nothing");
});

// --- the member card face ----------------------------------------------------

test("the member card paints the avatar the same way, and the OWN card falls to the store's user payload", () => {
  const source = MEMBERS();
  const card = source.slice(source.indexOf("export function renderMemberCard("),
    source.indexOf("// startDmControl"));
  assert.match(card, /cardAvatarUrl/, "the card computes its avatar seat once");
  assert.match(card, /member\.avatarUrl/, "the card's first arm is the roster row's own field, verbatim");
  assert.match(card, /me\.avatarUrl/, "the own card's fallback is the store user payload's own field, verbatim");
  assert.match(card, /me\.id === uid/, "the store-user fallback rides ONLY the signed-in member's self seat");
});

// --- fail soft (the attachment-404 idiom family) -----------------------------

test("an in-flight avatar failure leaves the row standing (fail soft, img removed)", () => {
  const source = MEMBERS();
  const avatarPaint = source.slice(source.indexOf("function avatarPaint("),
    source.indexOf("\n}\n", source.indexOf("function avatarPaint(")));
  assert.match(avatarPaint, /onError/, "the img carries the error arm");
  assert.match(avatarPaint, /currentTarget\.remove\(\)/,
    "a load failure removes the img itself — the row keeps its shape, never a broken image");
  assert.doesNotMatch(avatarPaint, /console|alert/, "the failure is silent in the DOM sense, loud nowhere");
});

// --- the css seat -----------------------------------------------------------

test("the avatar img rides ONE new class, seated in styles.css (no existing rule touched)", () => {
  const css = STYLES();
  const matches = css.match(/\.member-avatar \{[\s\S]*?\n\}/g) || [];
  assert.ok(matches.length >= 1, ".member-avatar is seated");
  assert.match(matches[0], /border-radius/, "the avatar reads as the round seat");
  // The card's placement rider (the c25 audit LOW): the card face's avatar
  // is a grid child above the header, so a scoped margin rule seats it —
  // the rail row keeps its flex-gap spacing untouched.
  assert.match(css, /\.task-page \.member-avatar \{[\s\S]*?margin/,
    "the card's avatar seat carries its own margin (never a rule edit to the shared class)");
  // The rule rides the file's END — nothing above it was touched (the diff
  // is append-only; the wave's own freeze guard on the client arms is the
  // shape-of-the-day pins above).
});

// --- the chat scope guard (the wave-13 tag-chip precedent) ------------------

test("NO avatar reference enters the messages/chat payload surface", () => {
  const chat = read("public/js/ui/chat.js");
  assert.doesNotMatch(chat, /avatarUrl/,
    "message payloads carry NO avatarUrl — the chat lane gains no avatar paint in this wave");
});

// --- the freeze (the wave-9 lesson, the TENTH instance) ------------------------------

// LANE_BASE = 44bed23 (main tip at lane open). LANE_TIP = the wave's own
// committed feat tip — the lead retargets the placeholder at commit time
// (the wave-9 freeze-pin lesson: the pin fingerprints the lane's own range,
// never HEAD). Until the commit, the placeholder diffs the base — the
// uncommitted handback has no committed range to fingerprint.
test("freeze: the frozen paths stay untouched across LANE_BASE..LANE_TIP", () => {
  const LANE_BASE = "44bed23";
  const LANE_TIP = "5c5e42f";
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, tip, "--", ...FROZEN_WAVE18_PATHS,
    ], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    // The catch is an ARM, not a swallow: a genuinely no-history
    // environment (a shallow checkout, an exported tree) cannot answer the
    // range — the other source-read pins carry the freeze there. A throw in
    // a FULL checkout IS the defect (a mistyped SHA) and must fail loud.
    // The probe of the probe (the c25 audit LOW): a rev-parse failure
    // alone is not "not a git checkout" — a full checkout with a broken
    // git still rethrows, so a silent skip never rides a broken
    // environment.
    let isShallow = null;
    try {
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    } catch {
      return; // git itself unusable (no repo at all — an exported tree)
    }
    try {
      isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"],
        { cwd: ROOT, encoding: "utf8" }).trim() === "true";
    } catch {
      throw error; // git answers HEAD but refuses the probe — not a swallow
    }
    if (isShallow) return;
    throw error;
  }
  assert.equal(touched, "", `${touched ? touched : ""} — the frozen paths must stay untouched`);
});

// --- the AGPL header rides the new file in the canonical shape --------------

test("the AGPL header rides the new file in the canonical shape", () => {
  const sourceText = read("tests/wave18-avatars.test.mjs");
  const lines = sourceText.split("\n");
  assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", "line 1");
  for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
    `header line ${i + 1} rides the template`);
  assert.equal(lines[17], "", "rides the 17-lines-plus-blank template");
});
