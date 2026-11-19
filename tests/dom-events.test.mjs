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

// The on* contract: the one element builder lowercases the event name once —
// "onClick" attaches "click", "onKeyDown" attaches "keydown" — and the
// lowercase spelling rides along unchanged. Every camelCase h() caller
// (ui/shell.js's pills and tiles, ui/chat.js, ...) is dead without
// this: DOM event types are case-sensitive and a user's click dispatches
// "click", never "Click".
import test from "node:test";
import assert from "node:assert/strict";

// A faithful-enough event stub: addEventListener queues by type and
// dispatchEvent runs the queue for the event's OWN type — the same case
// sensitivity a real click rides.
class EventStubNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.listeners = new Map();
    this.attributes = new Map();
    this.parentNode = null;
  }
  append(...kids) {
    for (const kid of kids) {
      if (!kid || typeof kid !== "object") continue;
      kid.parentNode = this;
      this.children.push(kid);
    }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, fn) {
    const queue = this.listeners.get(type) ?? [];
    queue.push(fn);
    this.listeners.set(type, queue);
  }
  dispatchEvent(event) {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn.call(this, event);
  }
}

test.beforeEach(() => {
  globalThis.Node = EventStubNode;
  globalThis.document = {
    createElement: (tag) => new EventStubNode(tag),
    createElementNS: (ns, tag) => new EventStubNode(tag),
    createTextNode: (text) => { const node = new EventStubNode("#text"); node.textContent = String(text); return node; },
  };
});

const DOM_SOURCE = () => import("../public/js/core/dom.js");

test("h() routes onClick to the dispatched 'click' type, not 'Click'", async () => {
  const { h } = await DOM_SOURCE();
  let clickFired = false;
  const button = h("button", { type: "button", onClick: () => { clickFired = true; } });
  button.dispatchEvent({ type: "click" });
  assert.equal(clickFired, true, "a user's click dispatches 'click' — the camel spelling must land there");
});

test("h() keeps the lowercase on* spellings working unchanged", async () => {
  const { h } = await DOM_SOURCE();
  let clickFired = false;
  const button = h("button", { type: "button", onclick: () => { clickFired = true; } });
  button.dispatchEvent({ type: "click" });
  assert.equal(clickFired, true, "the lowercase social.js / chat.js seats stay live");
});

test("h() routes onkeydown to a dispatched 'keydown'", async () => {
  const { h } = await DOM_SOURCE();
  let keyFired = false;
  const input = h("input", { onkeydown: () => { keyFired = true; } });
  input.dispatchEvent({ type: "keydown" });
  assert.equal(keyFired, true);
});

test("h() routes onAnimationEnd to the dispatched 'animationend'", async () => {
  const { h } = await DOM_SOURCE();
  let fired = false;
  const target = h("div", { onAnimationEnd: () => { fired = true; } });
  target.dispatchEvent({ type: "animationend" });
  assert.equal(fired, true, "camelCase on* names lowercase once at attach");
});
