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

// Quiet hours (T77, the spec's client lane): the schedule holds DM PINGS,
// never messages — a ping dispatch site consults this module before it
// fires. The choice lives per member via the store's quiet:schedule seat;
// an absent seat reads as the OFF default (the defaults law: opt-in, never
// on — save happens only through the hub's explicit action). The digest
// queue coalesces one row per conversation and DRAINS on wake.
// Deliberately stored: the choice, the queue's
// { conversationId, senderIds, count, at } rows, nothing else (no bodies,
// no read ledger, no analytics — the spec's NOT-stored list).

import store from "../core/store.js";

// The saved choice's seat, and the queue's seat (the reload-mid-quiet carry).
export const SCHEDULE_KEY = "quiet:schedule";
export const DIGEST_KEY = "quiet:digest";

// The defaults: OFF, never on; the times are suggestions and stay inert
// until the member's own toggle turns the schedule on.
export const DEFAULT_SCHEDULE = Object.freeze({ on: false, start: "23:00", end: "07:00" });

const QUEUE_CAP = 50; // conversations held — the digest is a courtesy, not retention

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// normalizeSchedule(prefs) — a saved seat (raw API shape included) or an
// absent one becomes the plain schedule the module reasons about. Invalid
// times fall back to the defaults; an absent schedule is the OFF default.
export function normalizeSchedule(prefs) {
  if (!prefs) return { ...DEFAULT_SCHEDULE };
  const savedStart = CLOCK_RE.test(String(prefs.start || "")) ? String(prefs.start) : DEFAULT_SCHEDULE.start;
  const savedEnd = CLOCK_RE.test(String(prefs.end || "")) ? String(prefs.end) : DEFAULT_SCHEDULE.end;
  return { on: Boolean(prefs.on), start: savedStart, end: savedEnd };
}

// isQuietAt(schedule, date) — wall-clock window membership against the
// member's device clock at hold time. `on` false is never quiet; start ==
// end is the explicitly empty window (legal, never engaged); the window may
// cross midnight.
export function isQuietAt(schedule, date) {
  if (!schedule || !schedule.on) return false;
  if (!CLOCK_RE.test(schedule.start) || !CLOCK_RE.test(schedule.end)) return false;
  if (schedule.start === schedule.end) return false;
  const minutes = (day) => Number(day.slice(0, 2)) * 60 + Number(day.slice(3, 5));
  const held = date.getHours() * 60 + date.getMinutes();
  const from = minutes(schedule.start);
  const until = minutes(schedule.end);
  if (from < until) return held >= from && held < until;
  return held >= from || held < until;
}

// makeDigestQueue(rows = []) — one coalesced row per conversation; the wake
// digest DRAINS it (once — a second drain is empty). Entries() returns a
// snapshot copy; the queue never hands its own array out.
export function makeDigestQueue(rows = []) {
  const held = [];
  for (const row of rows) {
    if (Number.isInteger(row?.conversationId)) held.push({ ...row });
  }
  const coalesce = (ping, when) => {
    const existing = held.find((row) => row.conversationId === ping.conversationId);
    if (existing) {
      existing.count += 1;
      if (!existing.senderIds.includes(ping.senderId)) existing.senderIds.push(ping.senderId);
      existing.at = when.toISOString();
      return existing;
    }
    const row = { conversationId: ping.conversationId, senderIds: [ping.senderId],
      count: 1, at: when.toISOString() };
    held.push(row);
    if (held.length > QUEUE_CAP) held.shift(); // the oldest row drops silently
    return null;
  };
  return {
    // offer(ping, schedule, when) -> "held" | "passed". A passed ping is
    // the member's ordinary dispatch; nothing is parked.
    offer(ping, schedule, when) {
      if (!isQuietAt(schedule, when)) return "passed";
      if (!ping || !Number.isInteger(ping.conversationId)) return "passed";
      coalesce(ping, when);
      return "held";
    },
    entries() { return held.map((row) => ({ ...row, senderIds: [...row.senderIds] })); },
    drain() {
      const wake = held.map((row) => ({ ...row, senderIds: [...row.senderIds] }));
      held.length = 0;
      return wake;
    },
  };
}

// dueDigest(queue, schedule, now) — the wake seat. Inside the window the
// rows stay parked; the moment the window no longer holds, the member's
// next DM-surface consult wakes the whole queue (the spec's wake reading).
// An empty queue renders nothing — never an empty-state card.
export function dueDigest(queue, schedule, now) {
  if (isQuietAt(schedule, now)) return [];
  const rows = queue.entries();
  if (rows.length === 0) return [];
  return queue.drain();
}

// The ONE schedule seat: the member's saved (or absent) choice right now.
export function scheduleOf() {
  return normalizeSchedule(store.get(SCHEDULE_KEY));
}

// saveSchedule(schedule) — the hub's explicit save ONLY. Never called on a
// render, a hover, or a toggle flip; the defaults law lives here.
export function saveSchedule(schedule) {
  const clean = normalizeSchedule(schedule);
  store.set({ [SCHEDULE_KEY]: { ...clean, on: Boolean(clean.on) } });
  return scheduleOf();
}

// The ONE queue seat the ping consult rides, mirrored into the store so a
// page reload mid-quiet carries the held rows forward.
export const wakeQueue = (() => {
  const queue = makeDigestQueue(store.get(DIGEST_KEY) || []);
  const mirror = () => store.set({ [DIGEST_KEY]: queue.entries() });
  return {
    offer(ping, schedule, when) {
      const result = queue.offer(ping, schedule, when);
      if (result === "held") mirror();
      return result;
    },
    entries() { return queue.entries(); },
    drain() {
      const wake = queue.drain();
      if (wake.length > 0) mirror();
      return wake;
    },
  };
})();

// holdDmPing(thread, meId, when = new Date()) — the conversations lane's
// hold point: the ping shape is what the payload already carries
// (conversationId + the member's best-known sender seat), nothing extra is
// read. Not opted in, or outside the window: "passed".
export function holdDmPing(thread, meId, when = new Date()) {
  const others = (thread.members || []).filter((member) => member.userId !== meId);
  return wakeQueue.offer(
    { conversationId: thread.id, senderId: (others[others.length - 1]?.userId) ?? 0 },
    scheduleOf(),
    when,
  );
}
