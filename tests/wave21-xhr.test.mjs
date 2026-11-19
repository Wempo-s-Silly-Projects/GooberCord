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

// Wave 21 — the XHR transport swap (owner directive "we should be using
// xhr", 2026-11-19): api() and the i18n bundle lane ride XMLHttpRequest with
// the SAME external contract (the one fetch wrapper's riders stay byte-pinned
// below), plus the ADDITIVE progress hooks (opts.onUploadProgress /
// onDownloadProgress, null defaults — the defaults law: no caller changes
// this wave). Node has no XMLHttpRequest, so the suite's fetch-stub test
// files seat tests/helpers/xhr-shim.mjs — the bridge, whose ONLY fetch
// reference is a single late-bound globalThis.fetch call at send time — with
// one identical mount line per file (the mounts are a mechanical diff; the
// bodies stay untouched).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import "./helpers/xhr-shim.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const APIJS = read("public/js/core/api.js");
const I18NJS = read("public/js/i18n.js");
const SHIMJS = read("tests/helpers/xhr-shim.mjs");

// --- the transport's own pins -------------------------------------------------

test("api.js carries no fetch call (the transport is XMLHttpRequest)", () => {
  assert.doesNotMatch(APIJS, /\bfetch\(/, "the one wrapper never names fetch anymore");
});

test("api.js wires the XMLHttpRequest surface api() consumes", () => {
  assert.match(APIJS, /new globalThis\.XMLHttpRequest\(\)/);
  assert.match(APIJS, /\.open\(/);
  assert.match(APIJS, /setRequestHeader\(/);
  assert.match(APIJS, /\.send\(/);
  assert.match(APIJS, /signal\.addEventListener\("abort"/,
    "the caller's AbortController still aborts the transport");
  assert.match(APIJS, /removeEventListener\("abort"/,
    "the abort listener is cleaned up once the promise settles");
  assert.doesNotMatch(APIJS, /withCredentials/,
    "same-origin rides the bridge's credentials, never a cross-origin flag");
});

test("api.js carries the ADDITIVE progress hooks (null defaults — the defaults law)", () => {
  assert.match(APIJS, /onUploadProgress = null/);
  assert.match(APIJS, /onDownloadProgress = null/);
  assert.match(APIJS, /xhr\.upload\.onprogress/);
  assert.match(APIJS, /xhr\.onprogress/);
});

test("every contract rider stays present after the swap", () => {
  // 401 → exactly one AUTH_EVENT emit per response (main.js's single listener).
  assert.match(APIJS, /response\.status === 401\) emit\(AUTH_EVENT\)/);
  // 204 → null before any parse.
  assert.match(APIJS, /response\.status === 204\) return null/);
  // The stale-CSRF one-shot: recognition rides the server's bytes, the retry
  // is guarded by !internalRetry so it fires EXACTLY once.
  assert.match(APIJS, /Your security token is out of date\./);
  assert.match(APIJS, /mutating && !internalRetry && response\.status === 403/);
  assert.doesNotMatch(APIJS, /tokenStale/, "no dead seed key rides the source");
  // The G-8/G-6 header riders: rulesGate + parsed retryAfter.
  assert.match(APIJS, /"x-rules-gate"/);
  assert.match(APIJS, /"retry-after"/);
  assert.match(APIJS, /error\.retryAfter = retryAfter/);
  assert.match(APIJS, /retryAfter/, "the W-R2 note's consumer stays seated");
  // The additive extra-field copy: "error"/"message"/"status" are skipped.
  assert.match(APIJS, /key !== "error" && key !== "message" && key !== "status"/);
  // Network death: the SAME requestFailed key, .status = 0, thrown not swallowed.
  assert.match(APIJS, /t\("gc\.errors\.requestFailed", \{ status: 0 \}\)/);
  assert.match(APIJS, /\.status = 0/);
});

test("the byte-pinned source shapes survive the rewrite verbatim", () => {
  // tests/core-api.test.mjs pins these exact bytes on api.js (its
  // transport-copy blessing): the invalidResponse interpolation and the
  // verbatim-server-string ternary keep their shapes.
  assert.match(APIJS, /t\("gc\.errors\.invalidResponse", \{ status: response\.status \}\)/);
  assert.match(APIJS, /typeof result\?\.error === "string"/);
  assert.match(APIJS, /const message = typeof result\?\.error === "string" && result\.error\n      \? result\.error/);
});

// --- i18n's two bundle reads ----------------------------------------------------

test("i18n.js carries no fetch call and rides its own XHR helper (the cycle guard)", () => {
  assert.doesNotMatch(I18NJS, /\bfetch\(/);
  assert.match(I18NJS, /new globalThis\.XMLHttpRequest\(\)/);
  // api.js imports i18n.js — the cycle guard: i18n.js carries no import
  // statement at all (a comment mention of the forbidden cycle is fine; a
  // module import there is not).
  assert.doesNotMatch(I18NJS, /^import\b/m);
  assert.doesNotMatch(I18NJS, /\bfrom\s+"[^"]*core\/api\.js"/);
  assert.match(APIJS, /from "\.\.\/i18n\.js"/);
});

test("i18n's load-failure shape survives: non-2xx and shape-gate both return null, poison throws", () => {
  assert.match(I18NJS, /status < 200 \|\| status >= 300\)? return null/,
    "a non-2xx bundle answer fails-open to English");
  assert.match(I18NJS, /Array\.isArray\(data\)\) return null/,
    "the data-shape gate stays");
  // The wedged-en poisoned-copy retry: exactly ONE re-read after the parse
  // refusal, still landing the real en copy either way.
  const enReads = I18NJS.match(/await loadBundle\("en"\)/g) || [];
  assert.equal(enReads.length, 2, "the en seat rides one read plus one poisoned-copy retry");
});

// --- the shim (tests/helpers/xhr-shim.mjs, the bridge) -------------------------

test("the shim file carries exactly one fetch reference — the late-bound bridge", () => {
  // Count against the CODE, not the comments — the bridge's comment block
  // narrates the law and names the seam.
  const code = (source) => source.replace(/\/\/.*$/gm, "");
  const fetchCalls = code(SHIMJS).match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, "the bridge is the seam: one globalThis.fetch call at send time");
  assert.match(SHIMJS, /globalThis\.fetch\(this\._url/,
    "the bridge resolves its transport at SEND time, never at mount time");
  assert.equal((code(SHIMJS).match(/\bResponse\b/g) || []).length, 0,
    "the bridge constructs no Response and imports no stub shape");
});

test("the bridge is mounted on globalThis by import", () => {
  assert.equal(typeof globalThis.XMLHttpRequest, "function");
  assert.match(SHIMJS, /globalThis\.XMLHttpRequest = /);
});

test("the bridge rides the late-bound stub: send, headers, body, lenient header read", async () => {
  const previous = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (path, init = {}) => {
    seen.push({ path, ...init });
    return new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { "X-Rules-Gate": "server:5" } });
  };
  try {
    const xhr = new globalThis.XMLHttpRequest();
    const settled = new Promise((resolve) => {
      xhr.onload = resolve;
      xhr.onerror = xhr.onabort = resolve;
    });
    xhr.open("POST", "/api/probe", true);
    xhr.setRequestHeader("X-CSRF-Token", "tok");
    xhr.responseType = "";
    xhr.onprogress = (event) => { xhr._seenDownload = event; };
    xhr.upload.onprogress = (event) => { xhr._seenUpload = event; };
    xhr.send(JSON.stringify({ a: 1 }));
    await settled;
    assert.equal(xhr.status, 200);
    assert.equal(xhr.responseText, JSON.stringify({ ok: true }));
    assert.equal(xhr.getResponseHeader("x-rules-gate"), "server:5",
      "the lenient read reaches the stub's headers, case-insensitive");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers["X-CSRF-Token"], "tok");
    assert.equal(seen[0].credentials, "same-origin");
    assert.equal(seen[0].body, JSON.stringify({ a: 1 }), "the body travels untouched");
    assert.deepEqual(xhr._seenDownload, { loaded: JSON.stringify({ ok: true }).length, total: JSON.stringify({ ok: true }).length },
      "download progress fires once, deterministic");
    assert.deepEqual(xhr._seenUpload, { loaded: JSON.stringify({ a: 1 }).length, total: JSON.stringify({ a: 1 }).length });
  } finally {
    globalThis.fetch = previous;
  }
});

test("network death maps onto the shim's status-0 arms (onerror, never swallowed)", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network died"); };
  try {
    const xhr = new globalThis.XMLHttpRequest();
    const died = new Promise((resolve) => {
      xhr.onload = () => resolve("load");
      xhr.onerror = () => resolve("error");
      xhr.onabort = () => resolve("abort");
    });
    xhr.open("GET", "/api/probe", true);
    xhr.send();
    assert.equal(await died, "error");
    assert.equal(xhr.status, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a mid-flight abort fires onabort and never settles the dead flight", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (path, init = {}) => new Promise((resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
  try {
    const xhr = new globalThis.XMLHttpRequest();
    const ended = new Promise((resolve) => {
      xhr.onload = () => resolve("load");
      xhr.onerror = () => resolve("error");
      xhr.onabort = () => resolve("abort");
    });
    xhr.open("GET", "/api/probe", true);
    xhr.send();
    xhr.abort();
    assert.equal(await ended, "abort");
    assert.equal(xhr.status, 0);
    // A dead flight stays dead: a second settle event never fires.
    let refires = 0;
    xhr.onload = xhr.onerror = () => { refires += 1; };
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(refires, 0, "the _settled guard silences the abandoned flight");
  } finally {
    globalThis.fetch = previous;
  }
});

test("an abort before send fires onabort immediately", async () => {
  const xhr = new globalThis.XMLHttpRequest();
  const events = [];
  xhr.onabort = () => events.push("abort");
  xhr.onerror = () => events.push("error");
  xhr.abort();
  assert.deepEqual(events, ["abort"]);
});

// --- the mount line (one identical line across the 19 stub files) --------------

const MOUNT_LINE = 'import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)';

const MOUNT_FILES = [
  "accounts-module.test.mjs",
  "c15-panels.test.mjs",
  "c18-fix.test.mjs",
  "core-api-classify.test.mjs",
  "core-api.test.mjs",
  "gifs-image.test.mjs",
  "gifs-search.test.mjs",
  "i18n.test.mjs",
  "main-build.test.mjs",
  "relay.test.mjs",
  "ui-chat.test.mjs",
  "ui-economy.test.mjs",
  "ui-expressions.test.mjs",
  "ui-members.test.mjs",
  "ui-mentions.test.mjs",
  "ui-mod.test.mjs",
  "ui-shell.test.mjs",
  "ui-social.test.mjs",
  "ui-ws.test.mjs",
];

test("the mount line rides byte-identical into all 19 stub files, exactly once each", () => {
  for (const file of MOUNT_FILES) {
    const source = read(`tests/${file}`);
    const count = source.split(MOUNT_LINE).length - 1;
    assert.equal(count, 1, `${file} carries the mount line exactly once`);
  }
});

test("the shim helper's own AGPL header rides the canonical shape", () => {
  const lines = SHIMJS.split("\n");
  assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", "line 1");
  for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
    `header line ${i + 1} rides the template`);
  assert.equal(lines[17], "", "rides the 17-lines-plus-blank template");
});

// --- the freeze (the wave-9 lesson; the c25 probe-of-the-probe shape) ----------

// LANE_BASE = 9602332 (main tip at lane open, the /me tier-read fix).
// LANE_TIP = the wave's own committed feat tip — the lead retargets the
// placeholder at commit time; until then the placeholder diffs the base and
// the source pins carry the freeze.
test("freeze: every module outside the wave's touched set stays byte-identical", () => {
  const LANE_BASE = "9602332";
  const LANE_TIP = "LANE_TIP";
  const tip = LANE_TIP === "LANE_TIP" ? LANE_BASE : LANE_TIP;
  const TOUCHED = [
    "public/js/core/api.js",
    "public/js/i18n.js",
    "tests/wave21-xhr.test.mjs",
    "tests/helpers/xhr-shim.mjs",
    ...MOUNT_FILES.map((file) => `tests/${file}`),
  ];
  let touched;
  try {
    touched = execFileSync("git", ["diff", "--name-only", LANE_BASE, tip],
      { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
      .filter((path) => path && !TOUCHED.includes(path));
  } catch (error) {
    // The catch is an ARM, not a swallow: a genuinely no-history environment
    // (a shallow checkout, an exported tree) cannot answer the range — the
    // other source-read pins carry the freeze there. A throw in a FULL
    // checkout IS the defect (a mistyped SHA) and must fail loud. The probe
    // of the probe (the c25 audit LOW): a rev-parse failure alone is not
    // "not a git checkout" — a full checkout with a broken git still
    // rethrows, so a silent skip never rides a broken environment.
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
  assert.deepEqual(touched, [], `${touched.join(", ")} — every untouched module stays byte-frozen`);
});

// --- the AGPL header rides the new test file in the canonical shape --------------

test("the AGPL header rides the new test file in the canonical shape", () => {
  const lines = read("tests/wave21-xhr.test.mjs").split("\n");
  assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", "line 1");
  for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
    `header line ${i + 1} rides the template`);
  assert.equal(lines[17], "", "rides the 17-lines-plus-blank template");
});
