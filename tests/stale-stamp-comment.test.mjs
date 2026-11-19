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

// Stale-build stamp placement pin. The stamp injector used a first-match
// replace on the raw bytes, and index.html's entry comment carried the raw
// head-close tag — the FIRST occurrence — so the stamp landed inside the
// comment, the doc parsed to nothing, and the client's stale-build strip
// went silently inert on live (query-confirmed 2026-11-17). Three pins here:
// (1) the shell's comments carry no head-close bytes — the root cause can
//     never creep back into the page source;
// (2) the hardened injector anchors on the closing-head/body boundary and
//     falls back to the LAST bare head close — source-level;
// (3) end-to-end runs against the REAL shell bytes: the served document
//     carries the stamp OUTSIDE every comment.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker.mjs";

const WORKER_SOURCE = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
const SHELL = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const BUILD = { VERSION: "0.1.0", COMMIT_SHA: "tests123" };
const STAMP = '<meta name="app-build" content="0.1.0@tests123">';
const stubAssets = (html, type = "text/html; charset=utf-8") => ({
  fetch: async () => new Response(html, { headers: { "content-type": type } }),
});
async function serveShell(html, type) {
  const response = await worker.fetch(
    new Request("https://goobercord.itswempo.workers.dev/"),
    { ...BUILD, ASSETS: stubAssets(html, type) },
    {},
  );
  assert.equal(response.status, 200);
  return response.text();
}

function assertStampOutsideComments(html) {
  const comments = html.match(/<!--[\s\S]*?-->/g) || [];
  for (const comment of comments) {
    assert.ok(
      !comment.includes(STAMP),
      `the stamp leaked inside a comment: ${comment.slice(0, 140)}`,
    );
  }
  assert.ok(html.includes(STAMP), "the stamp is missing entirely");
}

// (1) root cause: no comment in the shell carries the head-close bytes.
test("public/index.html comments carry no head-close bytes", () => {
  const comments = SHELL.match(/<!--[\s\S]*?-->/g) || [];
  assert.ok(comments.length > 0, "the shell is expected to carry comments");
  for (const comment of comments) {
    assert.ok(!comment.includes("</head>"), "an index.html comment shadowed the real head close");
  }
});

// (2) the injector is anchored, not first-match.
test("stampedAssetResponse anchors on the head/body boundary, last head close as fallback", () => {
  assert.ok(
    WORKER_SOURCE.includes('html.match(/<\\/head>\\s*<body/)'),
    "the boundary anchor is missing",
  );
  assert.ok(
    WORKER_SOURCE.includes('html.lastIndexOf("</head>")'),
    "the last-close fallback is missing",
  );
  assert.ok(!/html\.replace\("<\/head>"/.test(WORKER_SOURCE), "first-match replace is gone");
});

// (3) end-to-end against the REAL shell bytes: served stamp is outside
// every comment and sits inside the real head.
test("the served shell carries the stamp inside the real head, never a comment", async () => {
  const html = await serveShell(SHELL);
  assertStampOutsideComments(html);
  const stampPos = html.indexOf('<meta name="app-build"');
  const closePos = html.lastIndexOf("</head>");
  assert.ok(stampPos !== -1, "stamp present");
  assert.ok(stampPos < closePos, "the stamp belongs inside the head, not after it");
});

// Edge: a comment carrying head-close bytes BEFORE the real head close —
// the boundary anchor must win over the earlier comment literal.
test("a stray head-close inside a comment does not shadow the real close", async () => {
  const stray = "<!-- a stray " + "</head" + " literal lives here -->\n";
  const html = await serveShell(
    stray + "<head><title>x</title></head>\n<body>live</body>",
  );
  assertStampOutsideComments(html);
});

// Edge: a shell without any head close passes through unstamped, unbroken.
test("a shell without a head close passes through untouched", async () => {
  const raw = "<p>no head here</p>";
  const html = await serveShell(raw);
  assert.equal(html, raw);
});

// Non-HTML assets are never stamped.
test("a non-html asset passes through unstamped", async () => {
  const html = await serveShell('<p>not html, plain text</p>', "text/plain; charset=utf-8");
  assert.ok(!html.includes("app-build"));
});
