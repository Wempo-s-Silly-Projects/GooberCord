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

// Bookmarks (lane2-lifecycle recode, migration 0053): the private reading
// queue. A bookmark is a THIN POINTER a member saves onto a message — the
// address columns (owner, message, saved_at) and NOTHING else: no text
// copy, no snippet, no read-state flag, no note, no auto rows (defaults
// law: nothing exists until the member themselves saves).
//
// PRIVACY (the module's core law): owner_user_id rides EVERY statement's
// WHERE — there is no cross-member read, no mod override, no admin surface,
// no leaderboard. A wrong-owner unsave and a wrong-id unsave answer the ONE
// shared 404 body (no 403 existence oracle); an unreachable message save
// answers the shared message-family 404 the same way — both classifications
// ride the statement gate (changes-0), never a pre-read. A deleted message
// leaves an orphan pointer (migration 0053 carries no FK by design) whose
// dead address answers nothing on the read — the save gate cannot match a
// row that no longer exists, so the pointer keeps nothing alive.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { GC_BOOKMARKS_LIST_MAX } from "../constants.mjs";
// The cycle-5 VIEW deny arm: the same layer walk the search route's per-hit
// gate rides — imported, never re-declared.
import { viewerCanViewChannel } from "./messages.mjs";

// The save's VIEW-gate read: the message's channel (server channels alone
// carry the layer walk; a missing row stays the statement's own 404).
const BOOKMARK_TARGET_SQL =
  "SELECT c.id AS id, c.server_id AS server_id FROM gc_messages m " +
    "JOIN gc_channels c ON c.id = m.channel_id WHERE m.id = ? LIMIT 1";

// The statement-gated save: ONE statement answers reachability +
// idempotence. changes-0 = an unreachable message OR an already-saved own
// row; the owner-scoped duplicate read below distinguishes the two without
// ever learning whether another member saved the same message.
// .bind(owner, message, saved_at, message, owner, owner, owner, message)
const BOOKMARK_SAVE_SQL =
  "INSERT INTO gc_bookmarks (owner_user_id, message_id, saved_at) " +
    "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_messages m " +
      "WHERE m.id = ? AND (EXISTS (SELECT 1 FROM gc_channels c " +
        "JOIN gc_server_members sm ON sm.server_id = c.server_id " +
        "WHERE c.id = m.channel_id AND sm.user_id = ?) " +
      "OR EXISTS (SELECT 1 FROM gc_conversation_members cm " +
        "WHERE cm.channel_id = m.channel_id AND cm.user_id = ?))) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_bookmarks b " +
      "WHERE b.owner_user_id = ? AND b.message_id = ?)";

// The duplicate read after a changes-0 save: the caller's OWN row only.
const BOOKMARK_DUPLICATE_READ_SQL =
  "SELECT 1 FROM gc_bookmarks b WHERE b.owner_user_id = ? AND b.message_id = ? LIMIT 1";

// The private read: ONLY the caller's own pointers, newest save first, cut
// at the named cap. No owner column in the payload (the caller IS the
// owner), no handles, no other member's rows or counts.
const BOOKMARK_LIST_SQL =
  "SELECT id, message_id, saved_at FROM gc_bookmarks WHERE owner_user_id = ? " +
    "ORDER BY saved_at DESC, id DESC LIMIT " + GC_BOOKMARKS_LIST_MAX;

// The statement-gated delete: ownership lives INSIDE the WHERE — a wrong
// owner (or an absent id) answers changes-0, classified to the shared
// unknown-bookmark 404, never a 403.
const BOOKMARK_DELETE_SQL = "DELETE FROM gc_bookmarks WHERE id = ? AND owner_user_id = ?";

// POST /api/messages/:messageId/bookmark — the save act. The message's
// reachability (its existence AND the caller's channel membership, server
// or conversation) rides INSIDE the statement gate; a changes-0 is either
// an unreachable message (the shared 404) or an already-saved own row
// (idempotent 200) — the owner-scoped duplicate read tells them apart.
// The cycle-5 deny arm rides BEFORE the statement: a channel the viewer's
// history read 404s (a deny-touched VIEW miss) answers the same shared 404
// instead of planting a pointer no inbox read can ever open — the
// classification adds no oracle the 404 shape didn't already answer.
async function handleBookmarkSaveRoute(request, env, messageId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "bookmarks:save:" + userId);

  const target = await env.GOOBER_DB.prepare(BOOKMARK_TARGET_SQL)
    .bind(messageId).first();
  if (target && target.server_id !== null && target.server_id !== undefined &&
      !(await viewerCanViewChannel(env, target, userId))) {
    throw new HttpError(404, "Message not found.");
  }

  const savedAt = nowSeconds();
  const result = await env.GOOBER_DB.prepare(BOOKMARK_SAVE_SQL).bind(
    userId, messageId, savedAt, messageId, userId, userId, userId, messageId,
  ).run();
  if (Number(result.meta?.changes) === 1) {
    return json({ saved: true, id: Number(result.meta?.last_row_id) || 0, savedAt });
  }

  const own = (await env.GOOBER_DB.prepare(BOOKMARK_DUPLICATE_READ_SQL)
    .bind(userId, messageId).all()).results || [];
  if (own.length >= 1) return json({ saved: true, duplicate: true });
  throw new HttpError(404, "Message not found.");
}

// GET /api/bookmarks — the private list. The empty list is a valid answer
// (defaults law), never an error.
async function handleBookmarkListRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "bookmarks:list:" + userId);

  const rows = (await env.GOOBER_DB.prepare(BOOKMARK_LIST_SQL)
    .bind(userId).all()).results || [];
  return json({
    bookmarks: rows.map((row) => ({
      id: Number(row.id),
      messageId: Number(row.message_id),
      savedAt: Number(row.saved_at),
    })),
  });
}

// DELETE /api/bookmarks/:bookmarkId — the owner-only unsave.
async function handleBookmarkDeleteRoute(request, env, bookmarkId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "bookmarks:remove:" + userId);

  const result = await env.GOOBER_DB.prepare(BOOKMARK_DELETE_SQL)
    .bind(bookmarkId, userId).run();
  if (Number(result.meta?.changes) !== 1) throw new HttpError(404, "Bookmark not found.");
  return json({ ok: true, id: Number(bookmarkId) });
}

export async function handleBookmarkRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  // The arms are disjoint by method and path (DELETE with an id, GET for the
  // bare list) — the delete arm rides first by convention only.
  const deleteMatch = method === "DELETE"
    ? path.match(/^\/api\/bookmarks\/(0|[1-9][0-9]*)$/)
    : null;
  if (deleteMatch) return handleBookmarkDeleteRoute(request, env, Number(deleteMatch[1]));

  const saveMatch = method === "POST"
    ? path.match(/^\/api\/messages\/(0|[1-9][0-9]*)\/bookmark$/)
    : null;
  if (saveMatch) return handleBookmarkSaveRoute(request, env, Number(saveMatch[1]));

  const listMatch = method === "GET" ? path.match(/^\/api\/bookmarks$/) : null;
  if (listMatch) return handleBookmarkListRoute(request, env);

  return undefined;
}
