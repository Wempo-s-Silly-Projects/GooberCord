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

// Wave 14 — the chunked-upload door (the 2026-11-19 slate): the composer
// face the live, byte-frozen backend (api/uploads.mjs:415-427 — POST
// /api/uploads/chunks + POST :id/commit + DELETE :id) already earned. The
// client never mirrors tier numbers (payload-truth law): the tier gate
// stays server-side, the client's thresholds ride constants.mjs mirrors
// (G-4, declared ONCE in uploads.js). The progress face paints the slice
// count the door actually sent — never invented timers or fake bars. A
// cancel or a refused part is its own explicit abandon DELETE (one act,
// never folded into a refusal).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const FROZEN_WAVE14_PATHS = ["api", "worker.mjs", "constants.mjs", "public/js/core", "public/js/main.js"];

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const UPLOADS_UI = read("public/js/ui/uploads.js");
const CHAT = read("public/js/ui/chat.js");

// The byte-frozen backend shapes the client rides (read, never edited).
const UPLOADS_API = read("api/uploads.mjs");
const CONSTANTS = read("constants.mjs");

const STAGED = ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"];
const enData = JSON.parse(read("public/locales/en.json"));

// The wave's NEW keys — single strings, no plural arms (the wave law).
const NEW_KEYS = ["gc.chat.attach.laneProgress"];

// --- the frozen constants are the single source -------------------------------

test("constants.mjs seats the lane's own two caps (read, never edited)", () => {
  assert.match(CONSTANTS, /export const GC_UPLOAD_PART_BYTES = GC_UPLOAD_PART_CHUNKS \* ATTACHMENT_CHUNK_BYTES;/);
  assert.match(CONSTANTS, /export const GC_UPLOAD_LANE_MAX_BYTES = GC_UPLOAD_PARTS_MAX \* GC_UPLOAD_PART_BYTES;/);
  assert.match(CONSTANTS, /export const MAX_ATTACHMENT_BYTES = 20_971_520;/);
});

test("the client mirrors ride the G-4 literal law with provenance, declared ONCE", () => {
  assert.match(UPLOADS_UI, /G-4: MAX_ATTACHMENT_BYTES, GC_UPLOAD_PART_BYTES and/);
  assert.match(UPLOADS_UI, /GC_UPLOAD_LANE_MAX_BYTES \(constants\.mjs\)/);
  assert.match(UPLOADS_UI, /export const UI_ATTACHMENT_FREE_MAX = 20971520;/);
  assert.match(UPLOADS_UI, /export const UI_UPLOAD_PART_BYTES = 1024000;/);
  assert.match(UPLOADS_UI, /export const UI_UPLOAD_LANE_MAX_BYTES = 131072000;/);
  assert.doesNotMatch(UPLOADS_UI, /import .*constants\.mjs/, "the client never imports constants.mjs");
  // One seat: chat.js re-exports (the existing ui-chat pin keeps working) and
  // never re-declares the mirror out from under uploads.js.
  assert.doesNotMatch(CHAT, /export const UI_ATTACHMENT_FREE_MAX/);
  assert.match(CHAT, /export \{ UI_ATTACHMENT_FREE_MAX \};/);
});

test("the part-bytes mirror EQUALS the constants.mjs formula result — computed, not asserted", () => {
  // C1: the mirror once carried an invented MiB-rounded literal (1048576)
  // while the backend's GC_UPLOAD_PART_BYTES = 16 × 64_000 = 1,024,000 — a
  // green suite over a dead lane. The pin now computes the backend formula
  // from constants.mjs and demands byte-equality with the mirror, BOTH ways.
  const chunks = Number(CONSTANTS.match(/export const GC_UPLOAD_PART_CHUNKS = (\d+);/)?.[1]);
  const chunkBytes = Number(CONSTANTS.match(/export const ATTACHMENT_CHUNK_BYTES = (\d+);/)?.[1]);
  const partsMax = Number(CONSTANTS.match(/export const GC_UPLOAD_PARTS_MAX = (\d+);/)?.[1]);
  assert.equal(chunks * chunkBytes, 1024000, "the backend's own formula");
  const mirrorPart = Number(UPLOADS_UI.match(/export const UI_UPLOAD_PART_BYTES = (\d+);/)?.[1]);
  assert.equal(mirrorPart, chunks * chunkBytes,
    "UI_UPLOAD_PART_BYTES EQUALS GC_UPLOAD_PART_BYTES (constants.mjs), never an invented figure");
  const mirrorLane = Number(UPLOADS_UI.match(/export const UI_UPLOAD_LANE_MAX_BYTES = (\d+);/)?.[1]);
  assert.equal(mirrorLane, partsMax * (chunks * chunkBytes),
    "UI_UPLOAD_LANE_MAX_BYTES EQUALS GC_UPLOAD_PARTS_MAX × GC_UPLOAD_PART_BYTES");
});

// --- the frozen backend route table (read, never edited) ---------------------

test("the frozen route table keeps its three arms (api/uploads.mjs:415-427)", () => {
  assert.match(UPLOADS_API, /path === "\/api\/uploads\/chunks"/, "the chunk POST arm");
  assert.match(UPLOADS_API,
    /method === "POST"\s*\n\s*\? path\.match\(\/\^\\\/api\\\/uploads\\\/\(\[A-Za-z0-9_-\]\{12\}\)\\\/commit\$\//,
    "the commit POST arm");
  assert.match(UPLOADS_API,
    /method === "DELETE"\s*\n\s*\? path\.match\(\/\^\\\/api\\\/uploads\\\/\(\[A-Za-z0-9_-\]\{12\}\)\$\/\)/,
    "the abandon DELETE arm");
  assert.match(UPLOADS_API, /const CHUNK_FIELD = "chunk";/,
    "the part body rides ONE file field, named 'chunk' (the reader's 415/400 family)");
});

// --- the door (public/js/ui/uploads.js) --------------------------------------

test("the door slices bounded by GC_UPLOAD_PART_BYTES and reads the lane predicate", () => {
  assert.match(UPLOADS_UI, /export const UI_UPLOAD_PART_BYTES = 1024000;/);
  assert.match(UPLOADS_UI,
    /const partEnd = Math\.min\(\(seq \+ 1\) \* UI_UPLOAD_PART_BYTES, file\.size\);/,
    "the slice end is bounded — the final part may be short, never oversized");
  assert.match(UPLOADS_UI,
    /const part = file\.slice\(seq \* UI_UPLOAD_PART_BYTES, partEnd\);/,
    "each slice rides the mirrored part bytes, not an invented slice size");
  assert.match(UPLOADS_UI, /export function ridesChunkLane\(fileSize\)/);
  assert.match(UPLOADS_UI,
    /return fileSize > UI_ATTACHMENT_FREE_MAX && fileSize <= UI_UPLOAD_LANE_MAX_BYTES;/,
    "the chunked lane owns ONLY what the 20 MiB standalone intake cannot take");
});

test("the door wires the three LIVE arms with the server's own field names", () => {
  assert.match(UPLOADS_UI, /form\.append\("chunk", part, file\.name\);/,
    "the part body field is 'chunk' (api/uploads.mjs CHUNK_FIELD)");
  assert.match(UPLOADS_UI, /form\.append\("seq", String\(seq\)\);/,
    "the part position field (api/uploads.mjs fields.seq)");
  assert.match(UPLOADS_UI, /form\.append\("size", String\(file\.size\)\);/,
    "the FIRST part carries the declared total (api/uploads.mjs fields.size)");
  assert.match(UPLOADS_UI, /if \(seq > 0\) form\.append\("uploadId", uploadId\);/,
    "a continuation part carries the staged token (api/uploads.mjs:240-242 — fields.uploadId, 400 otherwise)");
  assert.match(UPLOADS_UI,
    /api\("\/api\/uploads\/chunks", \{\s*method: "POST",\s*body: form,\s*signal: controller\.signal,\s*\}\)/,
    "POST /api/uploads/chunks (api/uploads.mjs:415 route arm)");
  assert.match(UPLOADS_UI,
    /api\(`\/api\/uploads\/\$\{uploadId\}\/commit`, \{\s*method: "POST",\s*body: \{ size: file\.size \},\s*signal: controller\.signal,\s*\}\)/,
    "POST :id/commit carries the size the commit verifies (api/uploads.mjs:287)");
  assert.match(UPLOADS_UI,
    /api\(`\/api\/uploads\/\$\{id\}`, \{ method: "DELETE" \}\)/,
    "DELETE :id — the ONE abandon (api/uploads.mjs:377, empty staging still 200)");
});

test("the door gates the commit token on the server's own id shape", () => {
  assert.match(UPLOADS_UI, /const UPLOAD_ID_OK_RE = \/\^\[A-Za-z0-9_-\]\{12\}\$\/;/,
    "the token shape mirrors UPLOAD_ID_RE (api/uploads.mjs:211)");
  assert.match(UPLOADS_UI, /UPLOAD_ID_OK_RE\.test\(answer\.uploadId\)/,
    "a malformed first-part answer never reaches the commit route");
});

test("cancel and refusal are their own acts; the abandon never rides a refusal", () => {
  // ONE abandonment, in the catch arm AND in the cancel act — never folded
  // into the refusal text, never silent-partial.
  assert.match(UPLOADS_UI, /const abandonUpload = async \(\) => \{/);
  assert.match(UPLOADS_UI, /if \(id === null \|\| !UPLOAD_ID_OK_RE\.test\(id\)\) return;/,
    "a never-opened door abandons nothing — no oracle on a nonexistent token");
  assert.match(UPLOADS_UI, /const cancel = async \(\) => \{[\s\S]{0,400}abandonUpload\(\)/,
    "the cancel act fires its own explicit DELETE");
  assert.match(UPLOADS_UI, /catch \(error\) \{[\s\S]{0,400}await abandonUpload\(\)\.catch\(\(\) => null\);[\s\S]{0,200}throw error;/,
    "a refused part paints verbatim upward; the door's act is the one abandon");
  assert.match(UPLOADS_UI, /if \(cancelled\) return null;/,
    "a cancelled act resolves null so the composer paints no invented refusal");
  // H1: the wire is abortable and the cancelled return fires its own abandon —
  // an aborted act can never orphan a staging row past the abandon DELETE.
  assert.match(UPLOADS_UI, /const controller = new AbortController\(\);/,
    "the act's abort lives in the door");
  assert.match(UPLOADS_UI, /signal: controller\.signal/,
    "the chunk POST arm is abortable (core/api.js passes signal through to fetch)");
  assert.match(UPLOADS_UI,
    /const cancel = async \(\) => \{\s*cancelled = true;\s*controller\.abort\(\);[\s\S]{0,400}?await abandonUpload\(\)\.catch\(\(\) => null\);/,
    "the cancel act aborts the wire FIRST, then fires its explicit DELETE (flaky-network-proof, c21 F2)");
  assert.match(UPLOADS_UI,
    /if \(cancelled\) \{\s*await abandonUpload\(\);[\s\S]{0,120}?return null;\s*\}/,
    "the cancelled return between parts fires its own abandon — no orphan staging");
});

test("the progress face is the sent slice count — no invented timers or bars", () => {
  assert.doesNotMatch(UPLOADS_UI, /setInterval|setTimeout|performance\.now|new Date\(\)/,
    "no invented timing — the count only moves on sent slices");
  assert.doesNotMatch(UPLOADS_UI, /requestAnimationFrame/, "no fake bars — text paint only");
  assert.match(UPLOADS_UI, /Math\.ceil\(file\.size \/ UI_UPLOAD_PART_BYTES\)/,
    "the total is the file's own arithmetic, the parts it actually needs");
});

// --- the composer wiring (chat.js) ------------------------------------------

test("the composer routes beyond-the-threshold files through the door", () => {
  assert.match(CHAT, /import \{[^}]*openChunkedUpload[^}]*\} from "\.\/uploads\.js";/,
    "the mirrors + door import from the one module (the wave-13 idiom)");
  assert.match(CHAT, /import \{[^}]*ridesChunkLane[^}]*\} from "\.\/uploads\.js";/);
  assert.match(CHAT, /if \(ridesChunkLane\(file\.size\)\) \{/,
    "files the 20 MiB standalone intake cannot take ride the door");
  assert.match(CHAT, /openChunkedUpload\(file\)/, "one door act per composer act");
});

test("the lane bound paints the existing tooLarge key at the mirror, and the one-state gate holds", () => {
  assert.match(CHAT, /if \(file\.size > UI_UPLOAD_LANE_MAX_BYTES\) \{/,
    "sizes past the D1 lane's own cap are no door — the composer says so");
  assert.match(CHAT,
    /UI_UPLOAD_LANE_MAX_BYTES \/ 1048576/,
    "the MiB figure rides the mirror's arithmetic, never a re-declared number");
  assert.match(CHAT,
    /if \(pendingImage \|\| pendingLane \|\| laneDoor\) \{[\s\S]{0,120}t\("gc\.chat\.attach\.one"\)/,
    "one upload state per composer act — the single-shot state, the settled lane state and the in-flight door are the same slot");
});

test("the progress strip paints the slice count through t() and the remove button carries the abandon", () => {
  assert.match(CHAT,
    /t\("gc\.chat\.attach\.laneProgress", \{ done: 0, total: laneDoor\.totalParts \}\)/,
    "the strip opens at 0/total — real arithmetic before the first slice moves");
  assert.match(CHAT,
    /laneProgress\.textContent = t\("gc\.chat\.attach\.laneProgress", \{ done, total \}\);/,
    "the count moves only on the door's onPart report");
  assert.match(CHAT, /await laneDoor\.cancel\(\);/,
    "an in-flight cancel is its own act — the explicit abandon DELETE");
  assert.match(CHAT,
    /if \(laneAttachment === null\) \{\s*imageSeat\.replaceChildren\(\);\s*return; \/\/ the cancelled act/,
    "a cancelled act clears the strip, never a refusal paint");
  assert.match(CHAT, /pendingLane = \{ attachmentId: laneAttachment\.id, door: settledDoor \};/,
    "the settled lane attach holds the committed row's id and its door for the abandon arm");
  // H2: a refusal clears the in-flight strip — a dead laneRemove button
  // never rides a nulled door.
  assert.match(CHAT,
    /catch \(error\) \{\s*imageSeat\.replaceChildren\(\);[\s\S]{0,200}?laneDoor = null;\s*errorLine\.textContent = error\.message;/,
    "the lane catch clears imageSeat with the door; the refusal keeps its errorLine seat");
});

test("the send flow rides attach-by-id — the committed row links without re-riding the wire", () => {
  assert.match(CHAT, /laneAttachmentId: attachmentId \|\| null,/,
    "the optimistic pending row carries the id for the retry face");
  assert.match(CHAT,
    /body: \{ body, clientMessageId: clientMessageId_, attachmentId \},/,
    "the JSON send arm carries attachmentId (api/messages.mjs:1181 referenceFromBody)");
  assert.match(CHAT,
    /const sentLane = pendingLane;\s*try \{[\s\S]{0,200}?\{ imageFile: file \|\| undefined, attachmentId: sentLane\?\.attachmentId \|\| null \}\)/,
    "doSend passes the lane id (read at call time) beside its preview file; the multipart arm stays single-shot-only");
  assert.match(CHAT,
    /\{ imageFile: row\.localFile \|\| undefined, attachmentId: row\.laneAttachmentId \|\| null \}\)/,
    "retryFailed re-carries the id — a lane retry never re-uploads single-shot");
  assert.match(CHAT,
    /const lane = pendingLane;[\s\S]{0,200}?await lane\.door\.cancel\(\);/,
    "a settled attach's remove fires the door's abandon arm too (the explicit act, post-commit a 200 no-op)");
});

test("the single-shot flow stays byte-shaped (no neighboring refactor rode along)", () => {
  assert.match(CHAT, /const \{ attachment \} = await api\("\/api\/attachments", \{ method: "POST", body: data \}\);/,
    "the 20 MiB standalone intake arm keeps its shape");
  const multipartSeats = CHAT.match(/data\.append\("image", imageFile\);/g)?.length ?? 0;
  assert.equal(multipartSeats, 1, "the multipart send-with-image arm is untouched");
});

// --- the c21 audit fixes (GO-HAYWIRE) ---------------------------------------

test("the lane door gates doSend — an Enter beside an in-flight act posts nothing", () => {
  assert.match(CHAT,
    /if \(!body \|\| inFlight\) return;\s*if \(laneDoor\) \{[\s\S]{0,400}?errorLine\.textContent = t\("gc\.chat\.pending\.hint"\);\s*return;\s*\}/,
    "an Enter beside an open door paints the existing sending key and returns — a body text-only send can never ride an in-flight act, and no new i18n key is minted");
  assert.match(CHAT,
    /const sentLane = pendingLane;[\s\S]{0,300}?attachmentId: sentLane\?\.attachmentId \|\| null/,
    "the id doSend passes is the settled lane read at call time, not mutated by the await");
  assert.match(CHAT,
    /if \(pendingLane === sentLane\) pendingLane = null;/,
    "the success cleanup only drops the lane act it actually sent — a settled-in-window attach keeps its id");
});

test("cancel() cannot reject through to the composer's click handlers", () => {
  assert.match(UPLOADS_UI,
    /const cancel = async \(\) => \{\s*cancelled = true;\s*controller\.abort\(\);[\s\S]{0,400}?await abandonUpload\(\)\.catch\(\(\) => null\);/,
    "a network-flaky abandon DELETE stays in the door — the remove arms' `await laneDoor.cancel()` never fires an unhandled rejection");
});

// --- the sink + tier gates (payload-truth) ----------------------------------

test("the sink law: uploads mint nothing", () => {
  assert.doesNotMatch(UPLOADS_UI, /coin|ledger|balance/, "no coins ride the door");
});

test("the tier gate never rides the client — the mirrors carry no tier numbers", () => {
  assert.doesNotMatch(UPLOADS_UI, /mini|tier|tierCap|GC_MINI|GC_PLUS/i,
    "the door knows no tiers — attachmentCapBytes stays server-side (api/uploads.mjs:233)");
});

// --- the freeze (the wave-9 lesson, six instances) --------------------------

// LANE_BASE = 7aea317 (main tip at lane open). LANE_TIP = the wave's own
// committed feat tip (the lead retargeted the placeholder 2026-11-19 — the
// wave-9 freeze-pin lesson, sixth instance: the pin fingerprints the
// lane's own range, never HEAD, or a later audit fix breaks this pin).
test("diff scope: the frozen paths stay untouched across LANE_BASE..LANE_TIP", () => {
  const LANE_BASE = "7aea317";
  const LANE_TIP = "81efcae";
  let touched;
  try {
    touched = execFileSync("git", [
      "diff", "--name-only", LANE_BASE, LANE_TIP, "--", ...FROZEN_WAVE14_PATHS,
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

test("the en seats interpolate the two slots the paint passes", () => {
  const copy = enData["gc.chat.attach.laneProgress"];
  assert.match(copy, /\{\{done\}\}/);
  assert.match(copy, /\{\{total\}\}/);
});

test("the AGPL header rides every new file in the canonical shape", () => {
  const head = (source) => source.slice(0, 1200);
  for (const [label, source] of [["uploads.js", UPLOADS_UI], ["wave14-uploads.test.mjs", read("tests/wave14-uploads.test.mjs")]]) {
    assert.equal(head(source).indexOf(head(source).replace(/^\s+/, "").slice(0, 24)), 0,
      `${label} opens the header (no leading whitespace)`);
    const lines = source.split("\n");
    assert.equal(lines[0], "// Copyright 2026 YourLocalGoober", `${label} line 1`);
    for (let i = 1; i < 17; i += 1) assert.ok(lines[i].startsWith("//") || lines[i] === "/",
      `${label} header line ${i + 1} rides the template`);
    assert.equal(lines[17], "", `${label} rides the 17-lines-plus-blank template`);
  }
});
