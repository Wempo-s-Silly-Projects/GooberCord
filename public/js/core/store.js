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

// The ONLY cross-module bus. State reads go through here, events go through
// here; no module reaches into another module's DOM or internals.
//
// The state primitive is Kit's createStore (vendored designer/kit.mjs) —
// the house rule that no shared-looking store is rebuilt app-side. The kit's
// store is single-value (get/set/subscribe with notify-after-swap), so this
// module keeps the WHOLE state object as that one value and layers the
// keyed-contract the shell and waves code against on top of it:
//   get(key) / set(patch) / subscribe(key | key[], fn) with fn(state, key)
//   firing only for the keys a patch actually touched.
// The named-event lane (the api layer's "auth:unauthorized") is not state, so
// it stays its own small map. No DOM, no persistence — persistence is a
// module's own concern — so the whole file pins and runs in node as-is.

import { createStore } from "../vendor/designer/kit.mjs";

const bus = createStore({});
const keySubscribers = new Map(); // key -> Set<fn(state, key)>
const eventSubscribers = new Map(); // name -> Set<fn(payload)>

// One kit subscription for the whole bus: every value swap diffs against the
// previous, and only the touched keys' subscribers hear about it.
bus.subscribe((next, previous) => {
  for (const [key, fns] of keySubscribers) {
    if (fns.size === 0 || previous[key] === next[key]) continue;
    for (const fn of [...fns]) fn(next, key);
  }
});

// get(key) -> the current value (undefined when never set).
export function get(key) {
  return bus.get()[key];
}

// set(patch) — shallow-merge one or more keys, then notify every subscriber
// of the keys actually touched. A value compared with !== must have changed
// to notify; set({}) is a legal no-op.
export function set(patch) {
  const previous = bus.get();
  const next = { ...previous, ...patch };
  if (Object.keys(patch).every((key) => previous[key] === next[key])) return;
  bus.set(next);
}

// subscribe(key | key[], fn) -> unsubscribe. The fn receives (state, key).
export function subscribe(keys, fn) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    if (!keySubscribers.has(key)) keySubscribers.set(key, new Set());
    keySubscribers.get(key).add(fn);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const key of list) {
      keySubscribers.get(key)?.delete(fn);
    }
  };
}

// on(name, fn) -> unsubscribe; emit(name, payload) — the one-shot lane.
// Unlike key updates, events fire for every registered listener each emit.
export function on(name, fn) {
  if (!eventSubscribers.has(name)) eventSubscribers.set(name, new Set());
  eventSubscribers.get(name).add(fn);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    eventSubscribers.get(name)?.delete(fn);
  };
}

export function emit(name, payload) {
  for (const fn of eventSubscribers.get(name) || []) fn(payload);
}

// reset() — wipes state and every subscription; tests (and only tests) use
// it to get a pristine bus between cases.
export function reset() {
  keySubscribers.clear();
  eventSubscribers.clear();
  bus.set({});
}

export default { get, set, subscribe, on, emit, reset };
