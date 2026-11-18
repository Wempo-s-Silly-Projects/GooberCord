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

// The one router. History-API routes with named ":param" segments (the old
// client was hash-based; the rewrite moves to real paths — the boot carries
// a one-shot shim that maps any legacy "#/route" fragment onto the equal
// path so old deep links survive the swap). Routes are registered by name
// with patterns; the router matches, extracts params, clears the mount node,
// and hands the mount to the route's render. Everything the route renders
// stays inside its own subtree — modules never reach across.

// addRoute(pattern, name, render) — parameter-free patterns outrank
// parameterized ones at equal length.
// navigate(path, { replace }) — programmatic moves; popstate drives back/forward.
// renderCurrent() — re-renders the matched route without touching history.
// current() -> { name, params, path } | null.

const listeners = {};

let routes = [];
let mountNode = null;
let currentRoute = null;

function compile(pattern) {
  const params = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        params.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp("^" + source + "$"), params };
}

export function addRoute(pattern, name, render) {
  routes = routes.filter((route) => route.name !== name);
  routes.push({ ...compile(pattern), name, render });
  // Exact (parameter-free) patterns outrank parameterized ones of equal size.
  routes.sort((a, b) => Number(b.params.length === 0) - Number(a.params.length === 0));
}

function matchRoute(path) {
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (!match) continue;
    const entry = { name: route.name, params: {}, path, render: route.render };
    route.params.forEach((param, index) => {
      entry.params[param] = match[index + 1];
    });
    return entry;
  }
  return null;
}

function renderRoute(route) {
  currentRoute = route;
  if (mountNode) {
    mountNode.replaceChildren();
    // The render owns nothing outside its node: the router clears it before
    // each render and hands the node over. A render's own death is caught by
    // the shared failure painter below — navigation stays usable.
    try {
      route.render(route, mountNode);
    } catch (caught) {
      renderFailurePane(mountNode, caught);
    }
  }
}

// renderFailurePane(mountNode, error) — the render-guard's card: the thrown
// render paints one pane into the mount instead of dying to the console, and
// the full stack still rides the console for the QA lane (the pane is the
// user's channel; the console is the developer's). The humanizer's assert is
// the gate: only a live, connected mount takes the pane (the detached class —
// a node already swapped out — paints nothing, silently); and the node-pinning
// test half (no document at all) paints nothing too.
function renderFailurePane(mountNode, error) {
  console.error("Route render failed:", error);
  if (!mountNode || (typeof mountNode.isConnected === "boolean" && !mountNode.isConnected)) return;
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== "function") return;
  const pane = doc.createElement("div");
  pane.className = "router-error";
  const title = doc.createElement("h2");
  title.textContent = "This view failed to render.";
  const body = doc.createElement("p");
  body.textContent = (error && error.message) || "An unknown error stopped this view.";
  pane.append(title, body);
  mountNode.append(pane);
}

function resolve(path, { history: historyMode = false } = {}) {
  const route = matchRoute(path);
  if (!route) {
    if (mountNode) {
      mountNode.replaceChildren();
      listeners.notFound?.(path);
    }
    return null;
  }
  // History-API moves when a browser history actually exists (node pins the
  // matching/rendering half without one).
  const historyApi = typeof history !== "undefined" ? history : null;
  if (historyApi) {
    if (historyMode === "replace") {
      historyApi.replaceState(null, "", path);
    } else if (historyMode === "push") {
      historyApi.pushState(null, "", path);
    }
  }
  renderRoute(route);
  return route;
}

export function navigate(path, { replace = false } = {}) {
  return resolve(path, { history: replace ? "replace" : "push" });
}

export function renderCurrent() {
  if (currentRoute) {
    // Same arg contract as renderRoute: the render receives (route, mountNode).
    // The same guard: a render's death paints the failure pane and stops
    // propagating.
    try {
      currentRoute.render(currentRoute, mountNode);
    } catch (caught) {
      renderFailurePane(mountNode, caught);
    }
  }
  return currentRoute;
}

export function current() {
  return currentRoute;
}

export function notFoundHandler(fn) {
  listeners.notFound = fn;
}

// mount(node) — attach to a container, render whatever the address bar
// already points at (nothing pushed: the URL is already there), then stay
// live for popstate and for every internal anchor click.
export function mount(node) {
  mountNode = node;
  // The browser-only half: a node-pinning importer mounts with neither
  // window nor document — the live wiring skips cleanly, the render half
  // (renderRoute/renderCurrent) works without it.
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  window.addEventListener("popstate", () => {
    resolve(location.pathname);
  });
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey) return;
    const anchor = event.target && event.target.closest
      ? event.target.closest("a")
      : null;
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    resolve(url.pathname + url.search + url.hash, { history: "push" });
  });
  return resolve(location.pathname, { history: "replace" });
}

export default { addRoute, navigate, current, renderCurrent, notFoundHandler, mount };
