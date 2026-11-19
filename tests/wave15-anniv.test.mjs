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

// Wave 15 — the anniversary seat (the 2026-11-19 slate): the client face the
// live, byte-frozen backend (api/paper.mjs:291-341 — PUT + DELETE
// /api/users/me/anniversary) already earned. STRUCTURAL ONLY: the client
// mirrors month 0-11 / day 1-31 (G-4, declared ONCE in anniversary.js),
// invents no per-month day counts and no leap math. The seat opens EMPTY
// (defaults law: no pre-filled month), the PUT is the one explicit save, the
// DELETE is one explicit clear with no confirm ceremony (absence IS the
// off-state), and the truth line paints the route's own answer — never a
// year, never an age (LIMIT COLLECTION NOT ACCESS).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE15_PATHS = ["api", "worker.mjs", "constants.mjs", "public/js/core", "public/js/main.js"];

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

const ANNIV = () => source("public/js/ui/anniversary.js");
const SHELL = read("public/js/ui/shell.js");
const MAIN = read("public/js/main.js");

// The byte-frozen backend shapes the client rides (read, never edited).
const PAPER = read("api/paper.mjs");
const CONSTANTS = read("constants.mjs");
const CLEAR_ARM =
  PAPER.match(/async function handleAnniversaryClearRoute[\s\S]{0,600}\}/)?.[0] || "";

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW keys — single strings, no plural arms (the wave law).
const NEW_KEYS = [
  "gc.anniversary.heading",
  "gc.anniversary.description",
  "gc.anniversary.monthLabel",
  "gc.anniversary.monthOption",
  "gc.anniversary.dayLabel",
  "gc.anniversary.unset",
  "gc.anniversary.save",
  "gc.anniversary.clear",
  "gc.anniversary.current",
  "gc.anniversary.empty",
];

// --- the frozen constants are the single source -------------------------------

test("constants.mjs seats the two structural bounds (read, never edited)", () => {
  assert.match(CONSTANTS, /export const GC_USER_ANNIVERSARY_MONTH_MAX = 11;/);
  assert.match(CONSTANTS, /export const GC_USER_ANNIVERSARY_DAY_MAX = 31;/);
});

test("the client mirrors ride the G-4 literal law with provenance, declared ONCE", () => {
  assert.match(ANNIV(), /export const UI_ANNIVERSARY_MONTH_MAX = 11;/);
  assert.match(ANNIV(), /export const UI_ANNIVERSARY_DAY_MAX = 31;/);
  assert.match(ANNIV(), /G-4: GC_USER_ANNIVERSARY_MONTH_MAX and GC_USER_ANNIVERSARY_DAY_MAX/,
    "the provenance comment names the constants.mjs sources");
  assert.match(ANNIV(), /GC_USER_ANNIVERSARY_DAY_MAX\s*\(constants\.mjs\)/);
  assert.doesNotMatch(ANNIV(), /from "\.\.\/\.\.\/constants\.mjs"|constants\.mjs";/,
    "the client never imports constants.mjs");
});

test("the mirrors EQUAL the constants.mjs literals — computed, not asserted", () => {
  const monthMax = Number(CONSTANTS.match(/export const GC_USER_ANNIVERSARY_MONTH_MAX = (\d+);/)?.[1]);
  const dayMax = Number(CONSTANTS.match(/export const GC_USER_ANNIVERSARY_DAY_MAX = (\d+);/)?.[1]);
  const monthMirror = Number(ANNIV().match(/export const UI_ANNIVERSARY_MONTH_MAX = (\d+);/)?.[1]);
  const dayMirror = Number(ANNIV().match(/export const UI_ANNIVERSARY_DAY_MAX = (\d+);/)?.[1]);
  assert.equal(monthMirror, monthMax, "UI_ANNIVERSARY_MONTH_MAX EQUALS GC_USER_ANNIVERSARY_MONTH_MAX");
  assert.equal(dayMirror, dayMax, "UI_ANNIVERSARY_DAY_MAX EQUALS GC_USER_ANNIVERSARY_DAY_MAX");
});

// --- the frozen backend route table (read, never edited) ---------------------

test("the frozen route table keeps its two arms (api/paper.mjs:291-341)", () => {
  assert.match(PAPER, /path === "\/api\/users\/me\/anniversary";/, "the exact-match seat arm");
  assert.match(PAPER,
    /method === "PUT"\s*\n\s*\? handleAnniversarySetRoute\(request, env\)\s*\n\s*: handleAnniversaryClearRoute\(request, env\);/,
    "PUT is the save act, DELETE is the clear act");
  assert.match(PAPER,
    /const ANNIVERSARY_SET_SQL =\s*"INSERT INTO gc_user_anniversaries \(user_id, month, day\) VALUES \(\?, \?, \?\) " \+\s*\n\s*"ON CONFLICT \(user_id\) DO UPDATE SET month = excluded\.month, day = excluded\.day";/,
    "a second PUT overwrites in place on the user_id PK (no history, no tombstone)");
  assert.match(PAPER,
    /const ANNIVERSARY_CLEAR_SQL = "DELETE FROM gc_user_anniversaries WHERE user_id = \?";/,
    "the whole off-transition is the row's absence");
});

test("both arms answer their state and never a 404 (absence IS the off-state)", () => {
  assert.match(PAPER, /return json\(\{ month, day \}\);/,
    "the PUT answers the saved truth (the seat's paint source)");
  assert.match(PAPER, /return json\(\{ month: null, day: null \}\);/,
    "the DELETE answers the cleared state — an untouched member's clear answers too");
  assert.doesNotMatch(CLEAR_ARM, /404/, "the clear arm never answers 404 (idempotent, no oracle)");
});

test("the route's one refusal paints verbatim — the 400 copy is the contract", () => {
  assert.match(PAPER,
    /throw new HttpError\(400, "An anniversary wants a month \(0-11\) and a day \(1-31\)\."\);/,
    "the structural refusal's exact copy (api/paper.mjs:309)");
});

// --- the seat (public/js/ui/anniversary.js) -----------------------------------

test("the seat paints month+day and NEVER a year, never a derived age", () => {
  assert.doesNotMatch(ANNIV(), /year|FullYear|birth|\bage\b/i,
    "LIMIT COLLECTION NOT ACCESS holds at the door too");
});

test("the seat opens EMPTY — the defaults law, no pre-filled month", () => {
  assert.match(ANNIV(),
    /\{ value: "", label: t\("gc\.anniversary\.unset"\) \},/,
    "both selects open on the unset option, never a pre-filled month");
  assert.doesNotMatch(ANNIV(), /"selected"|\.selected/, "no option preselects anything");
});

test("the selects ride the mirrors — month 0-11, day 1-31, no invented day counts", () => {
  assert.match(ANNIV(), /for \(let month = 0; month <= UI_ANNIVERSARY_MONTH_MAX; month \+= 1\)/,
    "the month loop rides the mirror (0-11, the UTC month index the celebrant join binds)");
  assert.match(ANNIV(), /for \(let day = 1; day <= UI_ANNIVERSARY_DAY_MAX; day \+= 1\)/,
    "the day loop rides the mirror (1-31, STRUCTURAL ONLY — Feb 30 stores verbatim)");
});

test("the ONE save is the PUT and the ONE clear is the DELETE, no confirm ceremony", () => {
  assert.match(ANNIV(),
    /api\("\/api\/users\/me\/anniversary", \{\s*method: "PUT",\s*body: \{ month, day \},\s*\}\)/,
    "PUT /api/users/me/anniversary { month, day } (api/paper.mjs:297)");
  assert.match(ANNIV(), /api\("\/api\/users\/me\/anniversary", \{ method: "DELETE" \}\)/,
    "DELETE /api/users/me/anniversary (api/paper.mjs:319)");
  assert.doesNotMatch(ANNIV(), /confirm(\(|Dialog)/, "the clear needs no confirm ceremony");
  assert.match(ANNIV(), /saveButton\.disabled = !/, "the save speaks only with both keys picked");
});

test("the seat reflects the saved truth from the route's own answer", () => {
  assert.match(ANNIV(), /store\.set\(\{ meAnniversary: \{ month: answer\.month, day: answer\.day \} \}\);/,
    "the lane paints the ANSWER, never the form's hope");
  // TEST-MOVE (lane-c22-fix, GO-HAYWIRE F1 2026-11-19): the paint passes the
  // human month (state.month + 1) at the ONLY truthLine paint site — the same
  // face the month selector paints via gc.anniversary.monthOption — while the
  // day stays verbatim. The old pin (month: state.month raw) BAKED the
  // defect: a member saved "Month 12" and read "Saved: month 11" (ja/zh read
  // "11月" for December, nonsense "0月" for January).
  assert.match(ANNIV(), /t\("gc\.anniversary\.current", \{ month: state\.month \+ 1, day: state\.day \}\)/,
    "the saved truth paints the selector's month face (raw index + 1) + the verbatim day");
  assert.match(ANNIV(), /t\("gc\.anniversary\.empty"\)/,
    "the absence paints the empty face — no invented state");
});

test("the 400/401 families paint verbatim — no client oracle", () => {
  assert.match(ANNIV(), /errorLine\.textContent = error\.message;/,
    "the refusal's exact server copy, kept with the input (G-2)");
});

test("the sink law: the seat accounts nothing", () => {
  assert.doesNotMatch(ANNIV(), /coin|ledger|balance/, "no coins ride the seat");
});

// --- the mount (the shell-owned wire; main.js untouched) ---------------------

test("the seat's route registers in shell.js (main.js's route table stays untouched)", () => {
  assert.match(SHELL, /router\.addRoute\("\/anniversary", "anniversary", renderAnniversaryPanel\);/,
    "the shell-owned wire (the wave-13 idiom)");
  assert.match(SHELL, /renderAnniversaryPanel \} from "\.\/anniversary\.js";/,
    "the panel import rides the one module");
  assert.doesNotMatch(MAIN, /anniversary/, "main.js carries no wave-15 edit");
});

// --- the freeze (the wave-9 lesson, six instances) ---------------------------

// LANE_BASE = b8f19c6 (main tip at lane open). LANE_TIP = the wave's own
// committed feat tip — the lead retargets the placeholder at commit time
// (the wave-9 freeze-pin lesson, sixth instance: the pin fingerprints the
// lane's own range, never HEAD). Until the commit, the placeholder diffs the
// base — the uncommitted handback has no committed range to fingerprint.
test("diff scope: the frozen paths stay untouched across LANE_BASE..LANE_TIP", () => {
  const LANE_BASE = "b8f19c6";
  const LANE_TIP = "5654da2"; // wave-15 feat tip (retargeted by the lead 2026-11-19 — the wave-9 freeze-pin lesson, seventh instance: the pin fingerprints the lane own range, never HEAD)
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, tip, "--", ...FROZEN_WAVE15_PATHS,
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

// TEST-MOVE (lane-c22-fix, GO-HAYWIRE F2 2026-11-19): the empty face is
// session-honest client interim copy (board row T-PARITY-ANNIV-GET — the
// honest GET arm is owner-gated). The old bare "You have no anniversary
// saved." painted a false truth for a member whose anniversary IS live
// server-side: meAnniversary is session-local, so the line means absence in
// THIS session, and the copy says exactly that.
const HONEST_EMPTY = {
  en: "No anniversary is saved in this session yet. Once you save one, its month and day appear here.",
  de: "In dieser Sitzung ist noch kein Jahrestag gespeichert. Sobald du einen speicherst, erscheinen Monat und Tag hier.",
  es: "Todavía no hay ningún aniversario guardado en esta sesión. Cuando guardes uno, su mes y día aparecerán aquí.",
  fr: "Aucun anniversaire n'est encore enregistré dans cette session. Une fois le vôtre enregistré, son mois et son jour s'affichent ici.",
  pt: "Nenhum aniversário está salvo nesta sessão ainda. Depois de salvar o seu, o mês e o dia aparecem aqui.",
  ru: "В этой сессии годовщина ещё не сохранена. После сохранения здесь появятся ваш месяц и день.",
  ja: "このセッションではまだ記念日が保存されていません。保存すると、月と日がここに表示されます。",
  zh: "本次会话尚未保存纪念日。保存后，你的月份和日期会显示在这里。",
  ar: "لا يوجد ذكرى محفوظة في هذه الجلسة بعد. بعد الحفظ، يظهر الشهر واليوم هنا.",
};

test("the empty face is the session-honest interim copy in every bundle", () => {
  for (const langKey of ["en", ...STAGED]) {
    const bundle = JSON.parse(read(`public/locales/${langKey}.json`));
    assert.equal(bundle["gc.anniversary.empty"], HONEST_EMPTY[langKey],
      `${langKey} seats the session-honest empty face verbatim`);
  }
  const translated = STAGED.filter((langKey) =>
    HONEST_EMPTY[langKey] !== HONEST_EMPTY.en);
  assert.equal(translated.length, STAGED.length, "no bundle rides the en placeholder");
});

test("the en seats interpolate the slots the paint passes", () => {
  assert.match(enData["gc.anniversary.monthOption"], /\{\{number\}\}/);
  assert.match(enData["gc.anniversary.current"], /\{\{month\}\}/);
  assert.match(enData["gc.anniversary.current"], /\{\{day\}\}/);
});

test("the AGPL header rides every new file in the canonical shape", () => {
  const head = (sourceText) => sourceText.slice(0, 1200);
  for (const [label, sourceText] of [["anniversary.js", ANNIV()], ["wave15-anniv.test.mjs", read("tests/wave15-anniv.test.mjs")]]) {
    assert.equal(head(sourceText).indexOf(head(sourceText).replace(/^\s+/, "").slice(0, 24)), 0,
      `${label} opens the header (no leading whitespace)`);
    const lines = sourceText.split("\n");
    assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", `${label} line 1`);
    for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
      `${label} header line ${i + 1} rides the template`);
    assert.equal(lines[17], "", `${label} rides the 17-lines-plus-blank template`);
  }
});
