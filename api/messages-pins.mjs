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

// T-R25-SPLIT-MSGS-1: the pins family's home (the wave-25 area-10 seam,
// off the largest residual module). The 0026 pins family answers here —
// the pin/unpin write (the manage-pin grant's classifier read + the
// guarded cap UPDATE) and the channel's newest-first pinned read. The ONE
// forward below hands the route to the dispatcher from the pin arm's
// ORIGINAL position (the router's LAST arms — the two pins arms are
// contiguous, no interior interloper) with an 'undefined' fall-through —
// route order is semantically byte-unchanged, and every guard rides
// INSIDE the SQL exactly as before (an extraction moves bytes, not
// behavior).
//
// The payload/gate machinery the pins read shares with the history page
// (channelForUser/enforceChannelBits/MESSAGE_SELECT/groupedPayloadReads/
// publicMessage) stays ONE implementation in messages.mjs and is imported
// at CALL time (the circular import stays inert — a module-scope const
// reference would TDZ during the cycle; the T-R25-SPLIT-SERVERS-1
// lesson).
//
// The family keeps no guard mirrors: it owns no module-scope guard SQL of
// its own (the cap arm rides the UPDATE's WHERE byte-verbatim, and the
// manage-grant fragment rides the family's own PIN_MANAGER_READ_SQL).

import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { GC_PINS_MAX_PER_CHANNEL } from "../constants.mjs";
// The manage-pin read rides the shared role-mask machinery (the mask
// column one implementation in permissions.mjs) and the DELETE_MESSAGES
// grant — the manage family, exactly as the patched grant family moves.
import { parseMergedMask, roleMaskColumnSql, SERVER_PERMISSIONS } from "./permissions.mjs";
// The call-time shared helpers (the circular import stays inert):
import {
  channelForUser,
  enforceChannelBits,
  MESSAGE_SELECT,
  groupedPayloadReads,
  publicMessage,
} from "./messages.mjs";

// --- pins (0026) ------------------------------------------------------------------
//
// The manage-pin grant, CITED: Discord's Aug-2025 permission patch split
// Manage Messages into narrower grants (the modern Manage Messages/Pins
// family); GC carries no separate pin bit, so the pin right binds the
// message-moderation grant DELETE_MESSAGES (permissions.mjs) — the two
// moderation powers move together, exactly as the patched family does. The
// read mirrors the expression manage family's shape (api/emoji.mjs): the
// server's owner/moderator string tiers pass unconditionally, everyone
// else's role aggregate must hold the bit, and platform staff pass like the
// message delete always has. Per-channel overwrites are the SEND/VIEW
// family's concern; manage-family grants ride the role aggregate.
const PIN_MANAGER_READ_SQL =
  "SELECT COALESCE((SELECT sm.role FROM gc_server_members sm WHERE sm.server_id = ? AND sm.user_id = ?), '') AS tier, " +
    roleMaskColumnSql() + " AS mask";

function pinRights(session, classifierRow, grants) {
  const userId = Number(session.user.id);
  if (Number(classifierRow.author_id) === userId) return true; // own-message pin, both directions
  if (session.user.role === "owner" || session.user.role === "admin") return true;
  // grants is null exactly when the classifier said non-server (a DM/group
  // channel rides own-or-staff only) — the caller already split on it.
  if (grants === null) return false;
  const tier = String(grants.tier || "");
  if (tier === "owner" || tier === "moderator") return true;
  return (parseMergedMask(grants.mask) & Number(SERVER_PERMISSIONS.DELETE_MESSAGES)) !== 0;
}

async function handlePinRoute(request, env, messageId, pinned) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  // The write-bucket rider (review NIT-1): a pin/unpin is a mutation route
  // (PUT or DELETE /pin — this handler serves both), so the write limiter
  // rides BEFORE any table work, the same per-actor shape the other
  // write-routed lanes carry.
  await rateLimit(request, env, "write", "pin:" + userId);

  // The classifier read: the message's own pinned state and its channel's
  // server (a DM/group channel rides own-or-staff only). Unknown id → the
  // shared 404; no write ever fires for one.
  const row = await env.GOOBER_DB.prepare(
    "SELECT m.author_id AS author_id, m.is_pinned AS is_pinned, " +
      "c.server_id AS server_id " +
      "FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id " +
      "WHERE m.id = ? LIMIT 1",
  ).bind(messageId).first();
  if (!row) throw new HttpError(404, "Message not found.");

  let grants = null;
  if (row.server_id !== null && row.server_id !== undefined) {
    grants = await env.GOOBER_DB.prepare(PIN_MANAGER_READ_SQL)
      .bind(Number(row.server_id), userId, Number(row.server_id), userId).first();
  }
  if (!pinRights(session, row, grants)) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  if (pinned) {
    // Pin repeat = the reaction repeat precedent: already-pinned is a no-op
    // 200, never a refusal.
    if (row.is_pinned) return json({ pinned: true, id: Number(messageId) });
    // The cap rides INSIDE the statement (the count arm): zero changes means
    // the channel is at the cap — the classification is honest, since the
    // unknown-id and unauthorized shapes already answered above.
    const result = await env.GOOBER_DB.prepare(
      "UPDATE gc_messages SET is_pinned = 1 WHERE id = ? AND " +
        "(SELECT COUNT(*) FROM gc_messages WHERE channel_id = " +
          "(SELECT channel_id FROM gc_messages WHERE id = ?) AND is_pinned = 1) < ?",
    ).bind(messageId, messageId, GC_PINS_MAX_PER_CHANNEL).run();
    if (Number(result.meta?.changes) !== 1) {
      throw new HttpError(400, "This channel already has " + GC_PINS_MAX_PER_CHANNEL + " pins.");
    }
    return json({ pinned: true, id: Number(messageId) });
  }

  // Unpin: authorized (own or the manage-pin grant) and idempotent — an
  // unpinned row's unpin is the same 200, never a second oracle read.
  await env.GOOBER_DB.prepare(
    "UPDATE gc_messages SET is_pinned = 0 WHERE id = ?",
  ).bind(messageId).run();
  return json({ pinned: false, id: Number(messageId) });
}

// The channel's pinned set, newest-first (message id order = Discord's
// reverse-chronological pins read), one page bounded by the cap itself. The
// gate mirrors the history route's exact read (membership + VIEW bit), and
// the payloads are the history read's own shape — the client renders the
// same message objects from either route.
async function handleChannelPinsRoute(request, env, channelId) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);

  const channel = await channelForUser(env, channelId, userId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");
  await enforceChannelBits(env, channel, userId, ["VIEW"]);

  const page = (await env.GOOBER_DB.prepare(
    MESSAGE_SELECT +
      " WHERE m.channel_id = ? AND m.is_pinned = 1" +
      " ORDER BY m.id DESC LIMIT " + GC_PINS_MAX_PER_CHANNEL,
  ).bind(nowSeconds(), channelId).all()).results || [];

  // Attachments and reactions ride the SAME grouped reads the history page
  // uses (one read each for the whole payload, never per-row) — the shared
  // fan-out chunks them under the D1 bind limit exactly as the history
  // page's grouped reads do.
  const messageIds = page.map((row) => Number(row.id));
  const attachmentIdsByMessage = new Map();
  const reactionGroupsByMessage = new Map();
  if (messageIds.length) {
    await groupedPayloadReads(env, userId, messageIds, attachmentIdsByMessage, reactionGroupsByMessage);
  }

  return json({
    messages: page.map((row) =>
      publicMessage(row, attachmentIdsByMessage.get(Number(row.id)) || [],
        reactionGroupsByMessage.get(Number(row.id)) || null)),
  });
}

export async function handleMessagesPinsRoutes(request, env, path, method) {
  // The pins lane (0026): PUT/DELETE /api/messages/:id/pin and the channel's
  // newest-first GET — the dispatch patterns stay the bare-id family, and a
  // /pins path never collides with the plain /messages match above.
  const pinMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/messages\/([1-9][0-9]{0,14})\/pin$/)
    : null;
  if (pinMatch) {
    return handlePinRoute(request, env, Number(pinMatch[1]), method === "PUT" ? 1 : 0);
  }

  const pinsMatch = method === "GET"
    ? path.match(/^\/api\/channels\/([1-9][0-9]{0,14})\/pins$/)
    : null;
  if (pinsMatch) {
    return handleChannelPinsRoute(request, env, Number(pinsMatch[1]));
  }

  return undefined;
}
