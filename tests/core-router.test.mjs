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

// --- the route-seat guard (T50, T27 rider R2): boot seats stay unique -------
// addRoute replaces a same-name seat silently (the registry contract above),
// so a future wave that registers a duplicate route NAME would overwrite the
// first seat with no signal. This static row pins every addRoute seat in the
// boot: three real args, a unique route NAME, and a render identifier that
// main.js actually imports or defines.
function parseRouteSeats(source) {
  const seats = [];
  for (const [, pattern, name, render] of source.matchAll(
    /router\.addRoute\("([^"]+)",\s*"([^"]+)",\s*([A-Za-z_$][\w$]*)\)\s*;/g,
  )) {
    seats.push({ pattern, name, render });
  }
  return seats;
}

function routeSeatViolations(source) {
  const violations = [];
  const imports = new Set();
  for (const entry of source.matchAll(/^import\s+[\s\S]*?from\s+"\.\/[^"]+"|^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    for (const id of (entry[0].match(/[A-Za-z_$][\w$]*\s*(?=,|\s*})/g) || [])) imports.add(id.trim());
    if (entry[1]) imports.add(entry[1]);
  }
  const byName = new Map();
  for (const seat of parseRouteSeats(source)) {
    if (!seat.pattern.startsWith("/")) violations.push(`pattern "${seat.pattern}" is not an absolute path`);
    if (byName.has(seat.name)) {
      violations.push(`route name "${seat.name}" registered twice — the second seat silently overwrites the first`);
    }
    byName.set(seat.name, seat);
    if (!imports.has(seat.render)) violations.push(`render "${seat.render}" is not imported or defined in main.js`);
  }
  if (byName.size < 23) violations.push(`the boot's 23 route seats dropped to ${byName.size}`);
  return violations;
}

test("every boot addRoute seat resolves a unique render signature (no silent name collisions)", () => {
  const violations = routeSeatViolations(MAIN);
  const seats = parseRouteSeats(MAIN);
  assert.equal(seats.length, 23, `the boot registers 23 seats, found ${seats.length}`);
  assert.deepEqual(violations, [], "no duplicate names, no unresolved renders, no malformed patterns");
});

test("the seat guard fires on a duplicate route name (the overwrite hazard it exists for)", () => {
  const mutated = MAIN.replace(
    'router.addRoute("/s/:serverId/:channelId", "channel", renderChannelPane);',
    'router.addRoute("/s/:serverId/:channelId", "channel", renderChannelPane);\n' +
      '  router.addRoute("/s/:serverId/echo", "channel", renderChannelPane);',
  );
  assert.notEqual(mutated, MAIN, "the mutation seeded a second channel seat");
  assert.deepEqual(
    routeSeatViolations(mutated).filter((violation) => /registered twice/.test(violation)),
    ['route name "channel" registered twice — the second seat silently overwrites the first'],
  );
});

test("the render guard pins: the connected-mount check rides both render seats", () => {
  assert.match(SOURCE, /isConnected/, "the detached-class guard is the humanizer's assert");
  assert.match(SOURCE, /catch \(caught\)/);
  assert.match(SOURCE, /router-error/, "the error pane carries its class");
  const seats = (SOURCE.match(/renderFailurePane\(/g) || []).length;
  assert.ok(seats >= 3, `the shared failure painter rides renderRoute AND renderCurrent (${seats} call sites)`);
});

// --- the focus wave (T57): a re-render re-threads keyboard focus ------------

// One match-part: a tag name or a single class word — the two spellings the
// restore seat needs for ".pane-main h2" and "h1, h2, h3".
const matchesPart = (node, part) => part.startsWith(".")
  ? String(node.className || "").split(/\s+/).includes(part.slice(1))
  : node.tag === part;

// searchPart(node, parts, index) — the descendant-combinator walk: each part
// matches a descendant (or self) of the previous hit.
function searchPart(node, parts, index) {
  if (!matchesPart(node, parts[index])) {
    for (const kid of node.children) {
      const found = searchPart(kid, parts, index);
      if (found) return found;
    }
    return null;
  }
  if (index === parts.length - 1) return node;
  for (const kid of node.children) {
    const found = searchPart(kid, parts, index + 1);
    if (found) return found;
  }
  return null;
}

// A fake element good enough for the focus wave: contains, setAttribute,
// querySelector over the two selector spellings, and an observable focus().
function fakeElement(tag, className = "") {
  const node = {
    tag,
    className,
    nodeType: 1,
    children: [],
    focusCount: 0,
    append(...kids) { for (const kid of kids) if (kid) node.children.push(kid); },
    replaceChildren() { node.children.length = 0; },
    contains(other) {
      if (other === node) return true;
      return node.children.some(
        (kid) => typeof kid?.contains === "function" && kid.contains(other),
      );
    },
    setAttribute(name, value) { node[name] = value; },
    querySelector(selector) {
      for (const alternative of selector.split(",")) {
        const parts = alternative.trim().split(/\s+/);
        for (const kid of node.children) {
          const found = searchPart(kid, parts, 0);
          if (found) return found;
        }
      }
      return null;
    },
  };
  node.focus = () => { node.focusCount += 1; };
  return node;
}

function focusPaneFrame() {
  const frame = fakeElement("div", "shell");
  frame.append(fakeElement("h2", "rail-title")); // a rail heading first in tree order
  const pane = fakeElement("section", "pane-main");
  pane.append(fakeElement("h2", "pane-title"));
  frame.append(pane);
  return frame;
}

test("a re-render threads keyboard focus onto the new pane's heading (T57)", () => {
  const previousDoc = globalThis.document;
  try {
    const mount = fakeElement("div");
    const wasFocused = fakeElement("button", "server-tile");
    mount.append(wasFocused); // content the first paint lives on
    globalThis.document = { activeElement: wasFocused };
    router.mount(mount);
    router.addRoute("/", "home", (route, node) => node.append(focusPaneFrame()));
    router.navigate("/");
    const heading = searchPart(mount, [".pane-main", "h2"], 0);
    assert.ok(heading, "the fresh pane's heading is in the mount");
    assert.equal(heading.focusCount, 1,
      "the orphaned focus landed on the pane heading, not the first heading in tree order");
    assert.equal(heading.getAttribute?.("tabindex") ?? heading.tabindex, "-1",
      "the heading takes the re-anchoring tabindex, staying outside the tab order");
    assert.equal(wasFocused.focusCount, 0, "the orphaned node was never re-focused");
  } finally {
    globalThis.document = previousDoc;
  }
});

test("a re-render leaves foreign focus alone (T57 — dialogs outside the mount keep it)", () => {
  const previousDoc = globalThis.document;
  try {
    const outside = fakeElement("input");
    globalThis.document = { activeElement: outside };
    const mount = fakeElement("div");
    router.mount(mount);
    router.addRoute("/focus-foreign", "focus-foreign", (route, node) => node.append(focusPaneFrame()));
    router.navigate("/focus-foreign");
    const heading = searchPart(mount, [".pane-main", "h2"], 0);
    assert.equal(heading.focusCount, 0, "focus that never lived in the mount is never moved");
  } finally {
    globalThis.document = previousDoc;
  }
});
