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

// The one router. Node-runnable half: route registration (same-name
// replacement, parameter-free outranking), :param extraction, and rendering
// without touching history when nothing mounts. The browser half (popstate,
// the anchor intercept, the legacy "#/" shim in main.js) pins by source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const router = await import("../public/js/core/router.js");

const SOURCE = readFileSync(join(HERE, "../public/js/core/router.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");

test("the named route registry replaces by name and keeps the live render", async () => {
  const seen = [];
  router.addRoute("/s/:serverId/:channelId", "channel", () => seen.push("first"));
  router.addRoute("/s/:serverId/:channelId", "channel", () => seen.push("second"));
  const route = router.navigate("/s/7/12");
  assert.equal(route.name, "channel");
  router.renderCurrent();
  assert.deepEqual(seen, ["second"], "the replace dropped the old render, not the registration");
});

test(":params extract; a parameter-free pattern outranks a parameterized one", () => {
  router.addRoute("/", "home", () => {});
  router.addRoute("/inbox", "inbox", () => {});
  const inbox = router.navigate("/inbox");
  assert.equal(inbox.name, "inbox");
  const home = router.navigate("/");
  assert.deepEqual(home.params, {});
  assert.equal(router.current().name, "home");
});

test("an unknown path clears the mount (when attached) and can be caught", () => {
  router.notFoundHandler(() => {});
  assert.equal(router.navigate("/nowhere"), null);
});

test("an unmatched path with no mount returns null without throwing", () => {
  assert.equal(router.current() === null || router.current().name === "home", true);
});

test("the browser half rides History-API urls; the legacy hash shim lives in the boot", () => {
  assert.match(SOURCE, /historyApi\.replaceState|historyApi\.pushState/);
  assert.match(SOURCE, /addEventListener\("popstate"/);
  assert.match(SOURCE, /closest\("a"\)/, "internal anchors navigate, never a full load");
  assert.match(MAIN, /location\.hash\.startsWith\("#\/"\)/,
    "the boot rewrites a legacy #/ fragment onto the equal path exactly once");
});

// --- the render guard (T-W23): a thrown render never kills navigation ------

test("a thrown render paints the error pane into the connected mount and navigation stays usable", () => {
  const previousDoc = globalThis.document;
  const children = [];
  const mount = {
    isConnected: true,
    children,
    replaceChildren() { children.length = 0; },
    append(...kids) { children.push(...kids); },
  };
  globalThis.document = { createElement: (tag) => ({ tag, className: "", textContent: "", children: [],
    append(...kids) { this.children.push(...kids); } }) };
  try {
    router.mount(mount);
    router.addRoute("/boom", "boom-guard", () => { throw new Error("the render died"); });
    router.addRoute("/calm", "calm-guard", (route, node) => node.append("calm-pane"));
    router.navigate("/boom");
    const pane = children[0];
    assert.ok(pane && /router-error/.test(String(pane.className || "")),
      "the thrown render paints the error pane, never a blank mount");
    assert.match(String((pane.children[1] && pane.children[1].textContent) || ""),
      /the render died/, "the error's message rides the pane");
    router.navigate("/calm");
    assert.equal(children[0], "calm-pane", "a later navigation renders normally — navigation stays usable");
    assert.equal(router.current().name, "calm-guard");
  } finally {
    globalThis.document = previousDoc;
  }
});

test("a thrown render into a detached mount silently paints nothing and never escapes", () => {
  router.mount({ isConnected: false, children: [], replaceChildren() {}, append() {} });
  router.addRoute("/boom-detached", "boom-detached", () => { throw new Error("dies"); });
  const route = router.navigate("/boom-detached");
  assert.equal(route.name, "boom-detached", "the resolve completes — the render throw never escapes");
});

test("the render guard pins: the connected-mount check rides both render seats", () => {
  assert.match(SOURCE, /isConnected/, "the detached-class guard is the humanizer's assert");
  assert.match(SOURCE, /catch \(caught\)/);
  assert.match(SOURCE, /router-error/, "the error pane carries its class");
  const seats = (SOURCE.match(/renderFailurePane\(/g) || []).length;
  assert.ok(seats >= 3, `the shared failure painter rides renderRoute AND renderCurrent (${seats} call sites)`);
});
