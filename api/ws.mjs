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

// WebSocket upgrade route (Phase 1, Task 8): GET /api/ws?channel=<id>.
// Read-only GET, so the session gate is Task 5's `requireSignedInRead` (cookie,
// no CSRF) and the channel access check is the SAME single-SQL read gate as
// the message history route — one membership-look EXISTS, no row → 404 (never
// 403: a non-member must not learn the channel exists). The validated identity
// rides query params to the DO (`userId`/`username`/`channelKind`), which tags
// each accepted socket with them; the browser never chooses them.
//
// The DO is addressed by the pinned name `channel:<channelId>` so every socket
// to one channel lands in one ChatRoom instance; with hibernation the
// connections persist across the DO's eviction.
import { requireSignedInRead } from "./core/auth.mjs";
import { HttpError } from "./core/http.mjs";
import {
  channelForUser,
  enforceChannelBits,
  enforceMemberGates,
} from "./messages.mjs";

const CHANNEL_ID_TEST = /^[1-9][0-9]{0,14}$/;

export async function handleWsRoutes(request, env, url, path, method, ctx) {
  // ctx completes the dispatch loop's handler signature; this route schedules
  // no background work.
  void ctx;

  if (method !== "GET" || path !== "/api/ws") return undefined;

  const channelParam = url.searchParams.get("channel");
  if (channelParam === null || !CHANNEL_ID_TEST.test(channelParam)) {
    throw new HttpError(400, "That channel is invalid.");
  }

  const session = await requireSignedInRead(request, env);
  const user = session.user;
  const channelId = Number(channelParam);

  // Task 5's read gate — identical SQL, so the two callers can never drift.
  const channel = await channelForUser(env, channelId, Number(user.id));
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");

  // Phase-3 layers, enforced exactly when a deny touches this viewer. A text
  // socket needs the VIEW/SEND pair (it relays chat messages); a VOICE
  // channel's join is refused when CONNECT — or SPEAK (the audience pattern
  // is out of scope, so a Speak-denied member gets the same refusal at the
  // door) — is denied for them. Both refusals ride the shared 403.
  await enforceChannelBits(
    env,
    channel,
    Number(user.id),
    channel.kind === "voice" ? ["CONNECT", "SPEAK"] : ["VIEW", "SEND"],
  );

  // The mod desk's voice-join door (0008): a timed-out holder may not join
  // voice (the time-out FAQ's second gate), and the server's verification
  // level gates joining voice the same as sending. The upgrade is never even
  // negotiated for a refused joiner — the 403 rides the plain HTTP response.
  // Over this same door the CONNECT layer check above is the filed "voice
  // gate" location; the relay DO's own voice_join frame stays a relay concern.
  if (channel.kind === "voice") {
    await enforceMemberGates(env, Number(channel.server_id), Number(user.id));
  }

  if (!env.ROOMS) throw new HttpError(503, "Chat is not available right now.");

  const identity = new URL(request.url);
  identity.searchParams.set("userId", String(user.id));
  identity.searchParams.set("username", String(user.username ?? ""));
  identity.searchParams.set("channelKind", channel.kind == null ? "text" : String(channel.kind));

  const stub = env.ROOMS.get(env.ROOMS.idFromName("channel:" + channelId));
  // Forward the upgrade headers verbatim — the DO answers with the 101 + pair.
  return stub.fetch(new Request(identity.toString(), { headers: request.headers }));
}
