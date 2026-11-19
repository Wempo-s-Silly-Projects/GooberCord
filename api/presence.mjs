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

// PresenceHub Durable Object + presence REST (Phase 1, Task 9). The hub is
// ONE DO at the pinned name "hub": an in-memory Map of userId → presence that
// every ChatRoom and the REST routes talk to through stub fetches carrying the
// pinned text frames ({"type":"connect"|"heartbeat"|"leave"|"list"}, plus
// phase 2's voice markers {"type":"voice"|"voice_leave"}). There is
// deliberately no WebSocket on the hub and no D1 write from it — the map lives
// in DO memory for the lifetime of a busy hub (Workers Free is fine with that:
// an empty hub hibernates at zero cost) and the persisted custom status lives
// in gc_member_status, which the hub re-reads on each heartbeat so a PATCH
// survives hub eviction without the hub needing a write path.
//
// Hibernation-native by construction: presence traffic never wakes any room
// pair (the hub owns presence, the rooms own fan-out), and the auto-response
// pair pinned at construction means WS pings on the hub's sockets, if ever
// added later, are answered at the edge without waking the instance.
import { json, HttpError, readJson } from "./core/http.mjs";
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";

let workerd = null;
try {
  workerd = await import("cloudflare:workers");
} catch {
  /* node --test: no workerd builtins — the class runs on its own base */
}

async function ensureWorkerd() {
  if (!workerd) {
    try {
      workerd = await import("cloudflare:workers");
    } catch {
      /* keep the inert-base path */
    }
  }
  return workerd;
}

class DurableObjectBase {}

// The single hub identity every relay and route shares.
export const PRESENCE_HUB_NAME = "hub";

// The status overlay the REST route persists; the hub re-reads it per
// heartbeat, so an eviction between write and heartbeat never wedges status.
const STATUS_MAX_CHARS = 128;

// The presence tier rides the same persisted row (0016's presence_state
// column: NULL = online, else 'idle'|'dnd') — the only two overlay values
// ever non-online on the wire. "online" is accepted on the PATCH and
// normalizes to NULL so the stored tier's vocabulary stays exactly the
// column's CHECK.
const PRESENCE_STATES = new Set(["idle", "dnd"]);
function normalizePresenceState(value) {
  if (value === null || value === undefined) return null;
  if (value === "online") return null;
  if (typeof value === "string" && PRESENCE_STATES.has(value)) return value;
  return undefined; // the PATCH's anything-else refusal
}

export class PresenceHub extends (workerd?.DurableObject ?? DurableObjectBase) {
  constructor(state, env) {
    super(state, env);
    // workerd's DurableObject base assigns neither field; the explicit
    // assignment keeps the class identical under `node --test`, where the
    // guarded import fell back to an inert base.
    this.state = state;
    this.env = env;
    // userId → {username, lastSeen, statusText, statusUntil, channelLabel,
    //           voiceChannel}
    this.presence = new Map();
    // userId → live-socket count (GO-HAYWIRE cycle-4). Every room DO
    // forwards one connect per accepted socket, so the hub is the ONE
    // instance that can count a user's sockets across rooms; a leave drops
    // the roster entry only when that count reaches zero, or a second
    // channel's close flickered the user out of the roster while their
    // other socket was still live. DO-internal scratch state: an eviction
    // resets counts together with the presence map itself.
    this.connectCounts = new Map();
    if (typeof state?.setWebSocketAutoResponse === "function") {
      try {
        state.setWebSocketAutoResponse(
          workerd?.WebSocketRequestResponsePair
            ? new workerd.WebSocketRequestResponsePair("ping", "pong")
            : { ping: "ping", pong: "pong" },
        );
      } catch {
        /* a stale runtime without the pair class must not block boot */
      }
    }
  }

  // One stub-fetch entry point for every presence frame (ChatRoom's connect/
  // leave/heartbeat relays and the REST list). The reply is always the pinned
  // presence envelope; a bad frame is a plain 400, never a throw.
  async fetch(request) {
    let frame = null;
    try {
      frame = JSON.parse(await request.text());
    } catch {
      frame = null;
    }
    const type = frame && typeof frame === "object" && !Array.isArray(frame) ? frame.type : null;

    if (type === "connect" || type === "heartbeat") {
      if (Number.isInteger(frame.userId)) {
        if (type === "heartbeat") await this.overlayStatus(frame.userId, frame.username);
        else {
          // The count arm: one connect per accepted socket, never on the
          // client-driven 60s beats.
          this.connectCounts.set(frame.userId, (this.connectCounts.get(frame.userId) ?? 0) + 1);
          this.upsert(frame.userId, frame.username);
        }
      }
      return json(this.snapshot());
    }

    if (type === "leave") {
      if (Number.isInteger(frame.userId)) {
        // GO-HAYWIRE cycle-12: the count CLAMPS the delete — the row goes
        // only when a POSITIVE count decrements to exactly 0. A leave for
        // a user the hub never counted (an announce-only REST user's
        // count is 0/absent) deletes NOTHING: the old `remaining <= 0`
        // branch let any socket's leave frame for their userId drop an
        // announce-only member from the roster until the next announce
        // beat re-added them. Both branches are plain map reads/writes
        // inside the DO's serialized per-instance execution, so the
        // read-modify-write cannot interleave with a connect.
        const current = this.connectCounts.get(frame.userId) ?? 0;
        if (current > 1) {
          // Live sockets remain: one closed, the count drops.
          this.connectCounts.set(frame.userId, current - 1);
        } else if (current === 1) {
          // The last counted socket closed: drop them for real.
          this.connectCounts.delete(frame.userId);
          this.presence.delete(frame.userId);
        }
      }
      return json(this.snapshot());
    }

    if (type === "list") {
      return json(this.snapshot());
    }

    // Voice (phase 2): the room's ChatRoom DO forwards a join/leave. The
    // marker rides the same in-memory map (channelId → NULL), so the sidebar
    // can list who's in which voice channel without polling every room DO.
    // A join with a bad channelId still marks presence but with no channel.
    if (type === "voice") {
      if (Number.isInteger(frame.userId)) {
        this.upsert(frame.userId, frame.username);
        const entry = this.presence.get(frame.userId);
        if (entry) {
          entry.voiceChannel = Number.isInteger(frame.channelId) ? frame.channelId : null;
        }
      }
      return json(this.snapshot());
    }

    if (type === "voice_leave") {
      if (Number.isInteger(frame.userId)) {
        const entry = this.presence.get(frame.userId);
        // Presence itself is untouched: being out of voice ≠ being offline.
        if (entry) entry.voiceChannel = null;
      }
      return json(this.snapshot());
    }

    return json({ error: "Unknown presence frame." }, 400);
  }

  // Upsert (connect): refresh identity + lastSeen, never clobber an existing
  // status overlay, presence tier or a live voice marker (a text-channel
  // reconnect may not carry a voice frame; clearing the marker is
  // voice_leave's job, not this one's).
  upsert(userId, username) {
    const existing = this.presence.get(userId);
    this.presence.set(userId, {
      username: typeof username === "string" && username.length > 0 ? username : existing?.username,
      lastSeen: nowSeconds(),
      statusText: existing?.statusText ?? null,
      statusUntil: existing?.statusUntil ?? null,
      presenceState: existing?.presenceState ?? null,
      channelLabel: existing?.channelLabel ?? null,
      voiceChannel: existing?.voiceChannel ?? null,
    });
  }

  // gc_member_status is the persisted truth for the custom status AND the
  // presence tier; the hub re-reads and overlays both on every heartbeat, so
  // a PATCH survives an eviction between the write and the next beat. A read
  // failure keeps whatever the map already had.
  async overlayStatus(userId, username) {
    // Upsert first so a user's first-ever heartbeat is a full identity + beat.
    this.upsert(userId, username);
    const db = this.env?.GOOBER_DB;
    if (!db) return;
    try {
      const row = await db
        .prepare("SELECT status_text, status_until, presence_state FROM gc_member_status WHERE user_id = ?")
        .bind(userId)
        .first();
      const entry = this.presence.get(userId);
      if (!row || !entry) return;
      entry.statusText = row.status_text ?? null;
      entry.statusUntil = row.status_until ?? null;
      entry.presenceState = row.presence_state ?? null;
    } catch {
      /* best-effort overlay — the roster stays truthful even without D1 */
    }
  }

  // The pinned presence envelope: online[] in userId order, and a status whose
  // statusUntil has already passed is hidden (nulls) rather than stale. The
  // tier never hides: idle/dnd persist until the member picks online again.
  snapshot() {
    const now = nowSeconds();
    const online = [];
    for (const userId of [...this.presence.keys()].sort((a, b) => a - b)) {
      const entry = this.presence.get(userId);
      const stale =
        entry.statusUntil !== null && entry.statusUntil !== undefined && entry.statusUntil < now;
      online.push({
        userId,
        username: entry.username,
        statusText: stale ? null : entry.statusText,
        statusUntil: stale ? null : entry.statusUntil,
        presenceState: entry.presenceState ?? null,
        // Voice channel the member is speaking in (channelId), or null. The
        // client maps the id to a channel name via its server list.
        voiceChannel: entry.voiceChannel ?? null,
      });
    }
    return { type: "presence", online };
  }
}

// REST side: GET /api/presence (server-side hub roundtrip) and
// PATCH /api/me/status (persisted custom status). Registered in worker.mjs's
// API_HANDLERS like every other topic module.
export async function handlePresenceRoutes(request, env, url, path, method, ctx) {
  void ctx;
  void url;

  if (method === "GET" && path === "/api/presence") {
    await requireSignedInRead(request, env);
    if (!env.PRESENCE) throw new HttpError(503, "Presence is not available right now.");
    return json({ online: await hubOnline(env, { type: "list" }) });
  }

  // The app-wide presence beat (the channel-socket gap): the chat heartbeat
  // only fires while a channel view holds a socket, so the home/friends/
  // shop lanes showed the member's own dot OFFLINE while they sat on the
  // site (owner-reported, QA-reproduced). This route is the socket-free
  // claim: a signed-in POST beats the hub (connect + heartbeat — the
  // upsert-then-overlay idempotency means an already-present member just
  // refreshes their beat), and returns the same envelope the GET answers,
  // so the client's one refresh loop can claim itself AND read the hub in
  // a single roundtrip.
  if (method === "POST" && path === "/api/presence/announce") {
    const session = await requireUser(request, env);
    if (!env.PRESENCE) throw new HttpError(503, "Presence is not available right now.");
    const who = { userId: Number(session.user.id), username: session.user.username };
    const online = await hubOnline(env, { type: "heartbeat", ...who });
    return json({ online });
  }

  if (method === "PATCH" && path === "/api/me/status") {
    const session = await requireUser(request, env);
    // The shared bounded read (GO-HAYWIRE cycle-4): request.json() read the
    // body with no cap, the one route on this file off the readJson path.
    // Over-cap answers the shared 413, garbage the shared 400 — the row's
    // own shape check below stays.
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "That status is invalid.");
    }

    let statusText = body.statusText ?? null;
    if (statusText !== null && typeof statusText === "string" && statusText.trim().length === 0) {
      statusText = null;
    }
    if (statusText !== null && typeof statusText !== "string") {
      throw new HttpError(400, "That status is invalid.");
    }
    if (statusText !== null && statusText.length > STATUS_MAX_CHARS) {
      throw new HttpError(400, "Custom status must be 128 characters or fewer.");
    }

    let statusUntil = body.statusUntil ?? null;
    if (statusUntil !== null && (!Number.isInteger(statusUntil) || statusUntil <= 0)) {
      throw new HttpError(400, "That status expiry is invalid.");
    }

    // The presence tier is an ADDITIVE field: an absent key keeps whatever the
    // row already carries (the UPDATE arm never mentions the column), while a
    // present key always sets it — null and "online" both mean online (the
    // column's NULL).
    const hasPresenceState = Object.prototype.hasOwnProperty.call(body, "presenceState");
    let presenceState = null;
    if (hasPresenceState) {
      presenceState = normalizePresenceState(body.presenceState);
      if (presenceState === undefined) {
        throw new HttpError(400, "That presence state is invalid.");
      }
    }

    const SET_STATE_ARM = hasPresenceState
      ? ", presence_state = excluded.presence_state"
      : "";
    await env.GOOBER_DB.prepare(
      "INSERT INTO gc_member_status (user_id, status_text, status_until, presence_state, updated_at) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE " +
        "SET status_text = excluded.status_text, status_until = excluded.status_until" +
        SET_STATE_ARM +
        ", updated_at = excluded.updated_at",
    ).bind(
      Number(session.user.id), statusText, statusUntil, hasPresenceState ? presenceState : null,
      nowSeconds(),
    ).run();

    const status = { statusText, statusUntil };
    if (hasPresenceState) status.presenceState = presenceState;
    return json({ status });
  }

  return undefined;
}

async function hubOnline(env, frame) {
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_HUB_NAME));
  const response = await stub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify(frame),
    }),
  );
  const payload = await response.json().catch(() => ({ online: [] }));
  return Array.isArray(payload?.online) ? payload.online : [];
}
