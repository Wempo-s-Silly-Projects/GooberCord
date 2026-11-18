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

// T88: Bookmarks (docs/drafts/t88-bookmarks-spec.md) — the reading list. A
// bookmark is a PRIVATE POINTER a member saves onto a message: one thin row
// (owner_user_id, message_id, saved_at — NOTHING else), no text copy, no
// read-state, no note. The pointer is only an address; the address is served
// by the message table it points at.
//
// PRIVACY (the seat's core law): owner_user_id rides EVERY statement's WHERE
// — there is no cross-member read, no mod override, no admin surface, no
// leaderboard. Wrong-owner and wrong-id deletes answer ONE shared 404 body
// (no 403 existence oracle); wrong message id and non-member saves answer
// the shared message-family 404 the same way — both classifications ride the
// statement gate (changes-0), never a pre-read. A deleted message drops its
// pointer off the list at read (no FK, no CASCADE, no orphan sweep).
//
// LAWS: defaults law — no rows exist until the member saves; an untouched
// member's GET answers the valid empty shape. Sink law N/A — no coin surface
// touches the list. Every cap is a named constants.mjs import.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { GC_BOOKMARKS_LIST_MAX } from "../constants.mjs";

// --- the SQL (spec §4's pinned statement-gate shapes and bind orders) ---------

// The statement-gated save: ONE statement answers membership + existence +
// idempotence. changes-0 = wrong message / non-member / server unknown OR an
// already-saved own row; the owner-scoped duplicate read below distinguishes
// the two without ever learning that another member saved the message.
const BK_SAVE_SQL =
  "INSERT INTO gc_bookmarks (owner_user_id, message_id, saved_at) " +
  "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_messages m " +
    "JOIN gc_server_members sm ON sm.server_id = m.server_id " +
    "WHERE m.id = ? AND sm.user_id = ? AND sm.server_id = m.server_id) " +
  "AND NOT EXISTS (SELECT 1 FROM gc_bookmarks b " +
    "WHERE b.owner_user_id = ? AND b.message_id = ?)";
// .bind(owner_user_id, message_id, saved_at, message_id, owner_user_id,
//        owner_user_id, message_id)   — 7 binds, this order

// The duplicate read after a changes-0 save: the caller's OWN row only — it
// can distinguish "already mine" from "not reachable" with no other member's
// existence ever riding the statement.
const BK_DUPLICATE_READ_SQL =
  "SELECT 1 FROM gc_bookmarks b WHERE b.owner_user_id = ? AND b.message_id = ? LIMIT 1";

// The private read: ONLY the caller's own pointers, newest save first, cut at
// the named cap (a constants.mjs import, never a magic number in route code).
const BK_LIST_SQL =
  "SELECT id, message_id, saved_at FROM gc_bookmarks WHERE owner_user_id = ? " +
  "ORDER BY saved_at DESC, id DESC LIMIT " + GC_BOOKMARKS_LIST_MAX;

// The statement-gated delete: ownership lives INSIDE the WHERE — a wrong
// owner (or an absent id) answers changes-0, classified to the shared
// unknown 404 body, never a 403.
const BK_DELETE_SQL =
  "DELETE FROM gc_bookmarks WHERE id = ? AND owner_user_id = ?";

// --- the routes ----------------------------------------------------------------

export async function handleBookmarkRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  // DELETE before the substring reads: /api/bookmarks/:id contains the list
  // path, so the delete match rides first.
  const deleteMatch = method === "DELETE"
    ? path.match(/^\/api\/bookmarks\/(0|[1-9][0-9]*)$/)
    : null;
  if (deleteMatch) {
    return handleBookmarkDeleteRoute(request, env, Number(deleteMatch[1]));
  }

  const saveMatch = method === "POST"
    ? path.match(/^\/api\/messages\/(0|[1-9][0-9]*)\/bookmark$/)
    : null;
  if (saveMatch) {
    return handleBookmarkSaveRoute(request, env, Number(saveMatch[1]));
  }

  const listMatch = method === "GET"
    ? path.match(/^\/api\/bookmarks$/)
    : null;
  if (listMatch) {
    return handleBookmarkListRoute(request, env);
  }

  return undefined;
}

// POST /api/messages/:messageId/bookmark — the save act. The message's
// reachability (its existence AND the caller's membership of its server)
// rides INSIDE the statement gate; a changes-0 is either an unreachable
// message (the shared message-family 404) or an already-saved own row
// (idempotent 200) — the owner-scoped duplicate read tells them apart.
async function handleBookmarkSaveRoute(request, env, messageId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "bookmarks:save:" + userId);

  const savedAt = nowSeconds();
  const result = await env.GOOBER_DB.prepare(BK_SAVE_SQL).bind(
    userId, messageId, savedAt, messageId, userId, userId, messageId,
  ).run();
  if (Number(result.meta?.changes) === 1) {
    return json({ saved: true, id: Number(result.meta?.last_row_id) || 0, savedAt });
  }

  const own = (await env.GOOBER_DB.prepare(BK_DUPLICATE_READ_SQL)
    .bind(userId, messageId).all()).results || [];
  if (own.length >= 1) {
    return json({ saved: true, duplicate: true });
  }
  throw new HttpError(404, "Message not found.");
}

// GET /api/bookmarks — the private list. The empty list is a valid answer
// (defaults law), never an error; the payload carries the caller's ids and
// timestamps only — no owner column (the caller IS the owner), no handles,
// no other member's rows or counts.
async function handleBookmarkListRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "bookmarks:list:" + userId);

  const rows = (await env.GOOBER_DB.prepare(BK_LIST_SQL).bind(userId).all()).results || [];
  return json({
    bookmarks: rows.slice(0, GC_BOOKMARKS_LIST_MAX).map((row) => ({
      id: Number(row.id),
      messageId: Number(row.message_id),
      savedAt: Number(row.saved_at),
    })),
  });
}

// DELETE /api/bookmarks/:bookmarkId — the owner-only unsave. changes-0 ->
// the shared unknown 404: wrong-owner and wrong-id are indistinguishable, so
// no existence oracle exists.
async function handleBookmarkDeleteRoute(request, env, bookmarkId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "bookmarks:remove:" + userId);

  const result = await env.GOOBER_DB.prepare(BK_DELETE_SQL).bind(bookmarkId, userId).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, "Bookmark not found.");
  }
  return json({});
}
