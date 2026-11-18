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

// Subresource stamping pin (v4.3.2). The shell is no-store, but the JS/CSS
// it references live at FIXED urls riding content-derived ETags — a browser
// entry cached under an earlier deploy's headers stayed fresh past every
// later deploy at the same URL, serving old bytes nothing could evict (the
// live "CSS still borked / nothing works / says I'm offline" rot). The fix:
// every document points its same-origin js/css refs at ?v=BUILD, so a
// build's bytes always sit at a URL the browser has never seen. Here: the
// REAL shell bytes through worker.fetch, the three live refs stamped, api
// paths untouched, already-stamped urls never double-stamped, and non-HTML
// passes through unmodified.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker.mjs";

const SHELL = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BUILD = { VERSION: "0.1.0", COMMIT_SHA: "tests123" };
const stubAssets = (html, type = "text/html; charset=utf-8") => ({
  fetch: async () => new Response(html, { headers: { "content-type": type } }),
});
async function serve(html, type) {
  const response = await worker.fetch(
    new Request("https://goobercord.itswempo.workers.dev/"),
    { ...BUILD, ASSETS: stubAssets(html, type) },
    {},
  );
  assert.equal(response.status, 200);
  return response.text();
}

test("every same-origin js/css ref in the served shell carries the build query", async () => {
  const html = await serve(SHELL);
  assert.match(html, /src="\/js\/theme-preload\.js\?v=0\.1\.0@tests123"/);
  assert.match(html, /href="\/styles\.css\?v=0\.1\.0@tests123"/);
  assert.match(html, /src="\/js\/main\.js\?v=0\.1\.0@tests123"/);
});

test("api hrefs are never rewritten", async () => {
  const html = await serve(SHELL.replace(
    'href="/styles.css"',
    'href="/api/version"',
  ));
  assert.ok(html.includes('href="/api/version"'), "the api url must pass through unmodified");
});

test("a url that already carries ?v is left alone (idempotent)", async () => {
  const html = await serve(SHELL.replace(
    'href="/styles.css"',
    'href="/styles.css?v=different"',
  ));
  assert.match(html, /href="\/styles\.css\?v=different"/);
  assert.ok(!html.includes("styles.css?v=different?v="), "no double stamping");
});

test("the stamp never invents bytes outside the url (comment-injection safety)", async () => {
  const html = await serve(SHELL);
  for (const comment of html.match(/<!--[\s\S]*?-->/g) || []) {
    assert.ok(!comment.includes("0.1.0@tests123"), "a query stamp leaked inside a comment");
  }
});

test("non-HTML responses pass through untouched (styles.css is never rewritten)", async () => {
  const css = await serve(".gc-app { color: var(--ink); }", "text/css");
  assert.equal(css, ".gc-app { color: var(--ink); }");
});

test("a document without a build stamp serves its subresources unmodified", async () => {
  const response = await worker.fetch(
    new Request("https://goobercord.itswempo.workers.dev/"),
    { ASSETS: stubAssets(SHELL) },
    {},
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('src="/js/main.js"'));
});
