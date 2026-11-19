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

// Wave 16 — the staff filter desk (the 2026-11-19 slate): the client face of
// the live, byte-frozen word-filter backend (api/filterstore.mjs:89-170 —
// GET /api/admin/filter + POST /api/admin/filter/entries, requireStaff).
// Scope truth: /api/admin/* is PLATFORM-staff (owner/admin role, no server
// id in the URL — one shared site_settings key, "filtered_words"; no
// per-server lane keys). The backend serves the GET/POST pair the desk
// paints plus a byte-frozen PUT full-list editor (out of this wave) and NO
// delete arm anywhere — the desk paints what exists, nothing more. The desk
// GET rides its own open (defaults law: one auto-load per visit), the POST
// adds ONE entry behind the one explicit submit, and every staff-gate /
// validation refusal paints the backend's verbatim copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE16_PATHS = ["api", "worker.mjs", "constants.mjs", "public/js/core", "public/js/main.js"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

// The seat is RED-first: the module may not exist when this file runs — each
// test reads it fresh and fails NAMED, never one dead import (the
// soundboard-studio-red idiom).
const source = (relative) => {
  try {
    return read(relative);
  } catch {
    throw new Error(`RED: ${relative} is not written yet`);
  }
};

const DESK = () => source("public/js/ui/filterdesk.js");
const SHELL = read("public/js/ui/shell.js");
const MOD = read("public/js/ui/mod.js");
const MAIN = read("public/js/main.js");

// The byte-frozen backend shapes the client rides (read, never edited).
const FILTERSTORE = read("api/filterstore.mjs");
const AUTH = read("api/core/auth.mjs");

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW keys — single strings, no plural arms (the wave law).
const NEW_KEYS = [
  "gc.filterdesk.heading",
  "gc.filterdesk.stateEntries",
  "gc.filterdesk.stateSource",
  "gc.filterdesk.stateUpdated",
  "gc.filterdesk.stateNeverUpdated",
  "gc.filterdesk.entryLabel",
  "gc.filterdesk.entryHelp",
  "gc.filterdesk.submit",
  "gc.filterdesk.result",
];

// --- the frozen backend is the single source (read, never edited) ---------------

test("the frozen route pair keeps its two arms (api/filterstore.mjs:89-146)", () => {
  assert.match(FILTERSTORE, /path !== "\/api\/admin\/filter" && path !== "\/api\/admin\/filter\/entries"/,
    "the exact two-path seat");
  assert.match(FILTERSTORE, /method === "GET" && path === "\/api\/admin\/filter"/,
    "GET is the state arm");
  assert.match(FILTERSTORE, /method === "POST" && path === "\/api\/admin\/filter\/entries"/,
    "POST is the add-entry arm");
  assert.match(FILTERSTORE, /const session = await requireStaff\(request, env, false\);/,
    "the GET rides the read-only staff gate (mutating=false)");
  assert.match(FILTERSTORE, /const session = await requireStaff\(request, env\);/,
    "the POST rides the mutating staff gate (CSRF armed)");
});

test("the GET envelope is exactly words/source/totalEntries/updatedAt — no invented columns", () => {
  assert.match(FILTERSTORE,
    /return json\(\{\s*\n(?:\s*\/\/[^\n]*\n\s*)*words: filterWords\(env\),\s*\n\s*source: filterWordsSource\(env\),\s*\n\s*totalEntries: splitFilterEntries\(filterWords\(env\)\)\.filter\(\(entry\) => entry\.trim\(\)\)\.length,\s*\n\s*updatedAt: row \? filterUpdatedAt\(row\) : null,\s*\n\s*\}\);/m,
    "the desk's paint source is the backend's own envelope");
});

test("the POST answers added/skipped/totalEntries from the backend's own door", () => {
  assert.match(FILTERSTORE,
    /return json\(\{\s*\n\s*added: additions\.length,\s*\n\s*skipped: incoming\.length - additions\.length,\s*\n\s*totalEntries: splitFilterWordsCount\(filterWords\(env\)\),\s*\n\s*\}\);/,
    "the desk's result line paints the POST's own answer");
});

test("the DELETE-existence truth: NO delete arm anywhere — the PUT rides byte-frozen, unpainted", () => {
  assert.doesNotMatch(FILTERSTORE, /method === "DELETE"/,
    "no delete arm exists in the backend — the desk invents none");
  assert.match(FILTERSTORE, /method === "PUT" && path === "\/api\/admin\/filter"/,
    "the full-list editor exists byte-frozen; this wave paints only the GET/POST pair");
  assert.doesNotMatch(DESK(), /method:\s*"DELETE"/, "the desk carries no delete act");
});

test("the staff gate's refusal copy is the verbatim contract (api/core/auth.mjs)", () => {
  assert.match(AUTH, /throw new HttpError\(403, "Only admins can do that\."\);/,
    "the 403's exact copy the desk paints verbatim");
});

test("the validation refusals' copies are the verbatim contract", () => {
  assert.match(FILTERSTORE, /throw new HttpError\(400, "Paste at least one entry to add\."\);/,
    "the empty-paste 400's exact copy");
  assert.match(FILTERSTORE, /throw new HttpError\(413, "The filter list is full \(256 KiB cap\)\. Remove entries first\."\);/,
    "the filter-full 413's exact copy");
});

test("the list is ONE shared platform row — no per-server lane keys", () => {
  assert.match(FILTERSTORE, /const FILTER_KEY = "filtered_words";/,
    "one site_settings key; the desk scopes nothing per server (the /api/admin/* URL carries no server id)");
});

// --- the desk (public/js/ui/filterdesk.js) ---------------------------------------

test("the desk GETs once per visit — the defaults law, one auto-load, no poll loop", () => {
  const loads = DESK().match(/api\("\/api\/admin\/filter", \{ method: "GET" \}\)/) || [];
  assert.equal(loads.length, 1, "exactly one GET call site — one auto-load per visit");
  assert.doesNotMatch(DESK(), /setInterval|setTimeout/,
    "no invented refresh loop — the desk rides its own open");
});

test("the desk paints the GET's own envelope — count, source, updatedAt, no invented columns", () => {
  assert.match(DESK(), /t\("gc\.filterdesk\.stateEntries", \{ total: state\.totalEntries \}\)/,
    "the count paints the envelope's totalEntries");
  assert.match(DESK(), /t\("gc\.filterdesk\.stateSource", \{ source: state\.source \}\)/,
    "the source paints the envelope's verbatim source (database | secret | none)");
  assert.match(DESK(), /state\.updatedAt\s*\n\s*\? t\("gc\.filterdesk\.stateUpdated", \{ at: state\.updatedAt \}\)\s*\n\s*: t\("gc\.filterdesk\.stateNeverUpdated"\)/,
    "the stamp paints the envelope's updatedAt — or its honest never-updated face");
  assert.doesNotMatch(DESK(), /\.words|state\.words/,
    "the desk paints the COUNT, never renders the envelope's words payload (the PUT editor's job, byte-frozen out)");
});

test("the ONE entry arm: one explicit submit POSTs the single entry to the frozen door", () => {
  assert.match(DESK(), /api\("\/api\/admin\/filter\/entries", \{\s*method: "POST",\s*body: \{ entries \},\s*\}\)/,
    "POST /api/admin/filter/entries { entries } (api/filterstore.mjs:109)");
  assert.match(DESK(), /\.trim\(\)/, "the one entry rides the backend's own trim");
  assert.doesNotMatch(DESK(), /split\(|FormData/,
    "no client re-splitting, no bulk/import invention — ONE entry per submit");
});

test("the POST's own answer paints the result line and repaints the count — never the form's hope", () => {
  assert.match(DESK(), /t\("gc\.filterdesk\.result", \{\s*\n?\s*added: answer\.added,\s*\n?\s*skipped: answer\.skipped,\s*\n?\s*total: answer\.totalEntries,\s*\n?\s*\}\)/,
    "added / skipped / totalEntries straight from the POST's answer");
  assert.match(DESK(), /t\("gc\.filterdesk\.stateEntries", \{ total: answer\.totalEntries \}\)/,
    "the count line repaints from the POST's own answer");
});

test("the refusal families paint verbatim — no client oracle", () => {
  const verbatim = DESK().match(/errorLine\.textContent = error\.message;/g) || [];
  assert.ok(verbatim.length >= 2, "both the GET catch and the POST catch paint verbatim");
});

test("the staff gate mirrors the attachment queue's idiom — the staff-gated absence face, never a fake desk", () => {
  assert.match(DESK(), /if \(!user \|\| !\["admin", "owner"\]\.includes\(user\.role\)\) \{/,
    "the platform-staff gate, the renderStaffQueue idiom verbatim");
  assert.match(DESK(), /t\("gc\.settings\.errors\.permission"\)/,
    "the shared permission face renders before any desk body");
  assert.doesNotMatch(DESK(), /role === |role !== /, "no invented role ladder");
});

test("the scope truth and the empty-source truth are named in the module header", () => {
  assert.match(DESK(), /platform-staff|platform staff/, "the /api/admin/* scope truth is stated");
  assert.match(DESK(), /api\/filterstore\.mjs/, "the backend pointer rides the header");
});

test("the sink law and the mirror law: the desk accounts nothing and invents no cap", () => {
  assert.doesNotMatch(DESK(), /coin|ledger|balance/, "no coins ride the desk");
  assert.doesNotMatch(DESK(), /256|FILTER_MAX/, "no client oracle — the 413 copy is the backend's truth (no constants seat for filter caps exists)");
});

// --- the mount (the shell-owned wire + the queue's additive nav link) ------------

test("the desk's route registers in shell.js (main.js stays untouched)", () => {
  assert.match(SHELL, /router\.addRoute\("\/admin-filter", "staff-filter", renderFilterDesk\);/,
    "the shell-owned wire (the wave-15 idiom)");
  assert.match(SHELL, /renderFilterDesk \} from "\.\/filterdesk\.js";/,
    "the desk import rides the one module");
  assert.doesNotMatch(MAIN, /filterdesk/, "main.js carries no wave-16 edit");
});

test("the staff queue carries the desk's additive nav link (nodes.push idiom, no refactor)", () => {
  assert.match(MOD, /h\("a", \{ href: "\/admin-filter", text: t\("gc\.filterdesk\.heading"\) \}\)/,
    "one additive link on the attachment queue, the only mod.js edit");
});

// --- the freeze (the wave-9 lesson, the seventh+ instance) -----------------------

// LANE_BASE = 587e5b8 (main tip at lane open). LANE_TIP = the wave's own
// committed feat tip — the lead retargets the placeholder at commit time
// (the wave-9 freeze-pin lesson: the pin fingerprints the lane's own range,
// never HEAD). Until the commit, the placeholder diffs the base — the
// uncommitted handback has no committed range to fingerprint.
test("diff scope: the frozen paths stay untouched across LANE_BASE..LANE_TIP", () => {
  const LANE_BASE = "587e5b8";
  // retargeted by the lead 2026-11-19 — the wave-9 freeze-pin lesson,
  // eighth instance: the pin fingerprints the wave own committed range.
  const LANE_TIP = "c7fb209";
  const tip = LANE_TIP;
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, tip, "--", ...FROZEN_WAVE16_PATHS,
    ], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    // The catch is an ARM, not a swallow: a genuinely no-history
    // environment (a shallow checkout, an exported tree) cannot answer the
    // range — the other source-read pins carry the freeze there. A throw in
    // a FULL checkout IS the defect (a mistyped SHA) and must fail loud.
    let isShallow;
    try {
      isShallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"],
        { cwd: ROOT, encoding: "utf8" }).trim() === "true";
    } catch {
      return; // not a git checkout at all (an exported tree)
    }
    if (isShallow) return;
    throw error;
  }
  assert.equal(touched, "", `${touched ? touched : ""} — the frozen paths must stay untouched`);
});

// --- the i18n sweep ------------------------------------------------------------

test("every wave key is en-seated real copy", () => {
  for (const key of NEW_KEYS) {
    assert.ok(typeof enData[key] === "string" && enData[key].length > 0, `${key} is en-seated real copy`);
  }
});

test("the key scheme rides the dotted gc.* law — single strings, no plural arms", () => {
  const scheme = /^gc(\.[a-z][a-zA-Z0-9]*)+$/;
  for (const key of NEW_KEYS) assert.match(key, scheme, `the scheme rides: ${key}`);
  for (const key of NEW_KEYS) assert.ok(!/_(one|other|few|many|zero|two)$/.test(key), `${key} is no plural arm`);
});

test("the eight staged bundles carry every wave key TRANSLATED", () => {
  for (const langKey of STAGED) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    for (const key of NEW_KEYS) {
      const value = bundle[key];
      assert.equal(typeof value, "string", `${langKey} seats ${key}`);
      assert.ok(value.length > 0, `${langKey} seats ${key} with real copy`);
      assert.notEqual(value, enData[key], `${langKey} carries ${key} TRANSLATED — no en placeholder`);
    }
  }
});

test("the en seats interpolate the slots the paint passes", () => {
  assert.match(enData["gc.filterdesk.stateEntries"], /\{\{total\}\}/);
  assert.match(enData["gc.filterdesk.stateSource"], /\{\{source\}\}/);
  assert.match(enData["gc.filterdesk.stateUpdated"], /\{\{at\}\}/);
  assert.match(enData["gc.filterdesk.result"], /\{\{added\}\}/);
  assert.match(enData["gc.filterdesk.result"], /\{\{skipped\}\}/);
  assert.match(enData["gc.filterdesk.result"], /\{\{total\}\}/);
});

test("the AGPL header rides every new file in the canonical shape", () => {
  const head = (sourceText) => sourceText.slice(0, 1200);
  for (const [label, sourceText] of [["filterdesk.js", DESK()], ["wave16-filter.test.mjs", read("tests/wave16-filter.test.mjs")]]) {
    const lines = sourceText.split("\n");
    assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", `${label} line 1`);
    for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
      `${label} header line ${i + 1} rides the template`);
    assert.equal(lines[17], "", `${label} rides the 17-lines-plus-blank template`);
  }
});
