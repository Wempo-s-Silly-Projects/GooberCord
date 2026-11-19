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

// Contract parity (Phase 1, Task 1): this repo and wempos-forum share ONE
// production D1 database, so the vendored auth core must only differ from the
// forum's by the allow-listed token substitutions. This test pins the shared
// contract against the forum's live source so an accidental divergence in the
// rows that touch the shared tables (sessions, bans, banned_ips, known_ips)
// or the crypto constants fails CI instead of production.
//
// Allow-listed substitutions ONLY:
//   FORUM_DB      -> GOOBER_DB
//   wempo_session -> goober_session
//   (plus the relative constants.mjs import path, which is identical anyway)
// Everything else must be character-for-character identical.
//
// The Kitskey byte-parity pins were retired 2026-11-18 (owner order:
// project kitskey cancelled); the vendored files are app-owned copies now.

import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GOOBER_CORE = path.resolve(HERE, "../api/core");
const FORUM_CORE = "/Users/itswempo/wempos-forum/api/core";

// The substitution allow-list (ruled shape, same as GooberCord main's
// extension 027fc28): every pair is a named constant; the project-name pair
// rides the ruled extension — the twin's notices say the forum's name, ours
// say ours, and the map carries them; closed enumeration, no regex, whole-
// file equality still hard.
const FORUM_PROJECT = "Wempo's Forum";
const GOOBER_PROJECT = "GooberCord";

function vendorize(text) {
  return text.replaceAll("FORUM_DB", "GOOBER_DB").replaceAll(
    "wempo_session",
    "goober_session",
  ).replaceAll(FORUM_PROJECT, GOOBER_PROJECT);
}

function readCore(filename) {
  return readFileSync(path.join(GOOBER_CORE, filename), "utf-8");
}

function readForumCore(filename) {
  return readFileSync(path.join(FORUM_CORE, filename), "utf-8");
}

// (a) Every auth.mjs line whose SQL touches a shared table must match the
// forum's character-for-character after the allow-listed substitutions —
// re-aimed CONTENT-ANCHORED: the pin pairs a twin's line against the
// substituted forum copy's LINE SET, not against an index, so per-file
// license notices (which shift line numbers) cannot mis-index it. The pin
// keeps its teeth: one diverged shared-table line is red, and a file whose
// SQL lost those lines entirely still trips the vacuous check below.
test("auth.mjs shared-table SQL lines are identical to the forum's", () => {
  const gooberLines = readCore("auth.mjs").split("\n");
  const forumLineSet = new Set(vendorize(readForumCore("auth.mjs")).split("\n"));

  const SHARED_TABLES = ["sessions", "bans", "banned_ips", "known_ips"];
  let pinned = 0;

  for (const line of gooberLines) {
    if (!SHARED_TABLES.some((table) => line.includes(table))) continue;

    assert.ok(
      forumLineSet.has(line),
      `auth.mjs shared-table line diverges from the forum copy (content-anchored):\n  goober: ${line}`,
    );
    pinned++;
  }

  assert.ok(
    pinned > 0,
    "no shared-table SQL lines were found — the pin became vacuous",
  );
});

// (b) The HMAC data label: "wempo-forum-ip:" appears untransformed in both —
// the keyed IP hash must produce the SAME digest in both apps, since rows
// written by one must be readable as bans by the other.
test("auth.mjs HMAC data label literal is untransformed in both copies", () => {
  const LABEL = "wempo-forum-ip:";

  const gooberLine = readCore("auth.mjs").split("\n").find((l) => l.includes(LABEL));
  assert.ok(gooberLine, `vendored auth.mjs is missing the ${LABEL} literal`);
  assert.ok(
    gooberLine.includes('new TextEncoder().encode("' + LABEL + '" + ip)'),
    `the HMAC label line was altered: ${gooberLine}`,
  );
  assert.ok(
    !readCore("auth.mjs").includes("goobercord-ip"),
    "the HMAC label was wrongly rebranded",
  );

  assert.equal(
    gooberLine,
    vendorize(readForumCore("auth.mjs")).split("\n").find((l) => l.includes(LABEL)),
    "the HMAC label line differs from the forum copy",
  );
});

// --- phase 1 (experience/http) + phase 3 (experience/db): consumer shapes ----

// api/core/http.mjs became a pure consumer: the vocabulary (the typed error,
// rate limiting, body reading, field validation) lives in the vendor file and
// the leaf may not re-copy it. What it keeps app-side is the Turnstile wall,
// the limiter binding map, and the ONE intentional GooberCord header
// divergence (voice — microphone=(self)) that the byte-frozen vendor cannot
// carry.
test("api/core/http.mjs consumes the vendor instead of re-copying it", () => {
  const core = readCore("http.mjs");
  assert.ok(!core.includes("export class HttpError"), "the typed error class must come from the vendor");
  assert.ok(!core.includes("async function rateLimit("), "rate limiting must come from makeHttp");
  assert.ok(!core.includes("async function readLimitedBody("), "bounded body reading must come from makeHttp");
  assert.ok(!core.includes("async function readJson("), "readJson must come from makeHttp");
  assert.ok(!core.includes("function secureResponse("), "the static leg must come from the vendor");
  assert.match(core, /from "\.\.\/vendor\/http\.mjs"/, "the leaf imports the vendor");
  assert.match(
    core,
    /makeHttp\(\{[\s\S]*?rateLimitBindings: RATE_LIMIT_BINDINGS,[\s\S]*?securityHeaders,\s*\}\)/,
    "the leaf binds the app's limiter map AND its divergent securityHeaders through makeHttp",
  );
  assert.match(core, /export const secureResponse = app\.secureResponse/);
  assert.match(core, /export \{ unconditional, isDocumentRequest \} from "\.\.\/vendor\/http\.mjs"/,
    "the conditional-get trade is the framework verbatim, re-exported");
  assert.match(core, /microphone=\(self\)/, "the voice Permissions-Policy divergence survives app-side");
});

// Behavior through the re-exports: the vendor's HttpError is THE one core
// re-exports (so worker.mjs's apiError instanceof check classifies the same
// class), the vendor json still rides the security headers, and the
// microphone re-assert lands on exactly that stream.
test("the migrated core leaf answers through the vendor vocabulary", async () => {
  const core = await import("../api/core/http.mjs");
  const vendor = await import("../api/vendor/http.mjs");

  assert.equal(core.HttpError, vendor.HttpError, "one class across the re-export chain");
  const teapot = core.errorReply(new core.HttpError(418, "teapot"));
  assert.equal(teapot.status, 418);

  const response = core.json({ ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(
    response.headers.get("Permissions-Policy"),
    "camera=(), microphone=(self), geolocation=()",
    "the vendor json exits carry GooberCord's microphone=(self), not the framework default",
  );

  await assert.rejects(
    core.rateLimit(new Request("https://goobercord.itswempo.workers.dev/"), {}, "login"),
    (error) => error instanceof core.HttpError && error.status === 503,
    "a missing limiter stays the hard 503, never a silently unlimited route",
  );
});

// --- phase 3 (experience/db): the cursors leaf ----------------------------------

// api/core/cursors.mjs is the re-export seam — the codec bodies live only in
// the vendor file. (GC's routes walk bare-id cursors inline today; the leaf
// stays as the codecs' home.) The block-gate half of experience/db is
// forum-side only: GC's gc_blocks carries a `kind` column (the hard
// 'blocked' tier and the soft 'ignored' tier the DM surfaces use), a
// deliberate feature divergence the framework's gate does not model — routing
// it through makeBlockGate would change SQL, which a refactor-only migration
// never does. If the framework learns the kind filter, this comment's note
// becomes a migration TODO.
test("api/core/cursors.mjs re-exports the codecs instead of re-copying them", () => {
  const core = readCore("cursors.mjs");
  assert.ok(!core.includes("export function"), "the codec bodies must come from the vendor");
  assert.match(core, /export \{\s*parseActivityCursor,[\s\S]*from "\.\.\/vendor\/db\.mjs"/);
});

// Behavior through the seam (the deep pins live in forum's cursors suite via
// the byte-parity of the vendored source; these hold GC's seam together).
test("GC's cursor seam round-trips through the vendored codecs", async () => {
  const cursors = await import("../api/core/cursors.mjs");
  assert.deepEqual(
    cursors.parseActivityCursor(cursors.encodeActivityCursor({ pinned_at: 1729000000, last_activity_at: 1729000100, id: 42 })),
    { rank: 0, seconds: 1729000100, id: 42 },
  );
  assert.equal(cursors.encodeScoreCursor({ like_count: 0, dislike_count: 2, id: 9 }), "-2_9");
  assert.equal(cursors.parseActivityCursor("7_1_2_3"), null, "malformed shapes stay null at the seam");
});
