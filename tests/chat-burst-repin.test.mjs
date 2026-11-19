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

// The GO-HAYWIRE cycle-2 frontend pins: a channel socket msg frame inside
// the ~1s burst window rebuilds the column (laneRefresh's replaceChildren)
// and kills the one-shot overlay mid-animation — the live burst ids are
// tracked module-locally and re-pinned onto the rebuilt rows; and the
// common-arm picker's async onClick carried no catch (unhandled rejection
// where the super arm surfaces the verbatim 403). The client half pins by
// source, per the suite's contract.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const CHAT = readFileSync(join(HERE, "../public/js/ui/chat.js"), "utf8");

test("the burst overlay survives a mid-animation rebuild: live ids tracked, laneRefresh re-pins", () => {
  assert.ok(CHAT.includes("const activeBursts = new Set()"),
    "a module-local Set tracks the live burst message ids");
  const lane = CHAT.slice(
    CHAT.indexOf("function laneRefresh"),
    CHAT.indexOf("function dayLabel"),
  );
  const children = lane.indexOf("column.replaceChildren()");
  const repin = lane.indexOf("for (const messageId of activeBursts)");
  assert.ok(repin > children, "the re-pin sweeps AFTER the rebuild, onto the fresh rows");
  assert.match(lane, /\[data-message-id="\$\{messageId\}"\]/,
    "each live id re-pins to its message's rebuilt row");
  assert.match(lane, /activeBursts\.delete\(messageId\)/,
    "an id whose row is gone from the rebuilt column is swept (no leak)");
  const burst = CHAT.slice(
    CHAT.indexOf("function pinBurstOverlay"),
    CHAT.indexOf("function reactionPicker"),
  );
  const added = burst.indexOf("activeBursts.add(messageId)");
  const end = burst.indexOf("animationend");
  const cleared = burst.indexOf("activeBursts.delete(messageId)", end);
  assert.ok(added > -1 && end > -1 && cleared > end,
    "pinning adds the id; the overlay's own animationend clears it");
});

test("the common-arm picker's async onClick carries the super arm's catch (inline form-error)", () => {
  const picker = CHAT.slice(
    CHAT.indexOf("function reactionPicker"),
    CHAT.indexOf("const dialog = openDialog"),
  );
  const catches = [...picker.matchAll(
    /catch \(error\) \{\s*\n\s*grid\.append\(h\("p", \{ class: "form-error", text: error\.message \}\)\);/g,
  )].length;
  assert.equal(catches, 2, "one catch per arm (common + super) — the verbatim error, never swallowed");
});
