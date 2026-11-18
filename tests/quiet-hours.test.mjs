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

// T77 quiet hours (the spec's RED rows): opt-in default OFF (the defaults
// law), a held DM ping lands in the digest queue, and the wake digest
// DRAINS it. The module these rows pin is public/js/ui/quiet-hours.js —
// until the implementing seat lands, each row loads it itself and fails
// named, so the file reads three red rows, not one dead import.
import test from "node:test";
import assert from "node:assert/strict";

const MOD = "../public/js/ui/quiet-hours.js";

test("quiet hours is opt-in with a default of OFF (the defaults law)", async () => {
  const qh = await import(MOD);
  // No saved row: the schedule reads as the OFF default — never on.
  const schedule = qh.normalizeSchedule(null);
  assert.deepEqual(schedule, { on: false, start: "23:00", end: "07:00" });
  // A member who never opted in: their DM ping rides immediately, and a
  // ping that rode was never held — the queue stays empty.
  const queue = qh.makeDigestQueue();
  const date = new Date("2026-11-18T01:30:00");
  assert.equal(queue.offer({ conversationId: 9, senderId: 2 }, schedule, date), "passed",
    "no opt-in, no hold: the dispatch is the member's default");
  assert.deepEqual(queue.drain(), [], "a ping that rode was never parked in the digest");
});

test("a DM ping during the member's quiet window is HELD into the digest queue", async () => {
  const qh = await import(MOD);
  const schedule = qh.normalizeSchedule({ on: 1, start: "23:00", end: "07:00" });
  assert.equal(schedule.on, true, "the opted-in row reads as engaged");
  // 01:30 sits inside the 23:00 → 07:00 window — the window crosses midnight.
  const date = new Date("2026-11-18T01:30:00");
  assert.equal(qh.isQuietAt(schedule, date), true, "the window spans the midnight seam");
  const before = new Date("2026-11-17T22:30:00");
  assert.equal(qh.isQuietAt(schedule, before), false, "22:30 sits outside the window");
  const after = new Date("2026-11-18T07:05:00");
  assert.equal(qh.isQuietAt(schedule, after), false, "07:05 sits past the window's end");

  const queue = qh.makeDigestQueue();
  assert.equal(queue.offer({ conversationId: 9, senderId: 2 }, schedule, date), "held",
    "inside the window, the ping parks");
  // Same conversation, later, another sender: the row coalesces (the digest
  // is one line per conversation), never a second row.
  assert.equal(queue.offer({ conversationId: 9, senderId: 3 }, schedule, date), "held");
  const rows = queue.entries();
  assert.equal(rows.length, 1, "pings for one conversation coalesce into one digest row");
  assert.equal(rows[0].conversationId, 9);
  assert.equal(rows[0].count, 2, "the row carries how many, never message bodies");
  assert.ok(rows[0].senderIds.includes(2) && rows[0].senderIds.includes(3),
    "the row names the senders, nothing more");
  // The queue stores the row's shape and nothing else (the spec's NOT-stored list).
  assert.ok(!("body" in rows[0]) && !("messageIds" in rows[0]),
    "no message text and no message ids ride the queue");
});

test("the wake digest drains the queue", async () => {
  const qh = await import(MOD);
  const schedule = qh.normalizeSchedule({ on: 1, start: "23:00", end: "07:00" });
  const quiet = new Date("2026-11-18T01:30:00");
  const queue = qh.makeDigestQueue();
  queue.offer({ conversationId: 9, senderId: 2 }, schedule, quiet);
  queue.offer({ conversationId: 12, senderId: 4 }, schedule, quiet);
  queue.offer({ conversationId: 12, senderId: 4 }, schedule, quiet);
  // The wake: one drain carries the held rows — one per conversation,
  // coalesced — and EMPTIES the queue behind it.
  const digest = queue.drain();
  assert.equal(digest.length, 2, "the wake digest carries every held conversation once");
  assert.equal(digest.find((row) => row.conversationId === 12).count, 2);
  assert.deepEqual(queue.drain(), [], "the wake digest DRAINS: a second wake is empty");
  // A held ping after the wake starts a fresh holding — the schedule keeps
  // working across nights, no residue.
  assert.equal(queue.offer({ conversationId: 9, senderId: 2 }, schedule, quiet), "held");
  assert.deepEqual(queue.entries().map((row) => row.conversationId), [9]);
});
