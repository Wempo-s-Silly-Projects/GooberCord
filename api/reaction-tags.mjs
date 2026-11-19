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

// Reaction tags (recode lane, 2026-11-18): the cosmetic emoji→tag map. A
// mod pins a handful of emoji→tag pairs naming the moments the server
// cares about; a member opts in per tag with one act, and their own opts
// paint the profile.
//
// STORAGE: the PROD-APPLIED ledger already carries the feature's tables —
// gc_server_reaction_tags + gc_reaction_tag_opts ride migration 0041 and
// the opts side's user index rides 0043 (d1_migrations applied; both
// shapes exist and are IMMUTABLE). This seat rides them verbatim and adds
// NO migration file.
//
// LAWS: statement-gate idiom — the mod role, membership, the map cap, and
// opt reachability live INSIDE the statements; a changes-0 write
// classifies to the ONE shared 404 body, never a 403, no pre-read oracle.
// Defaults law — no tag rows and no opts exist until someone acts; an
// empty list is a valid answer, never default-on anything. Economy
// re-rule — tags are FREE cosmetics: no mint, no price, no coin
// statement. Every cap is a named constants.mjs import. PRIVACY — the map
// read carries no member column at all; the mine read carries ONLY the
// caller's rows (o.user_id rides the statement's WHERE): no cross-member
// read, no count across members, no leaderboard.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { GC_REACTION_TAG_EMOJI_MAX, GC_REACTION_TAG_TEXT_MAX, GC_REACTION_TAGS_MAX } from "../constants.mjs";

// The shared refusal body: a wrong role, a wrong emoji, an unreachable
// tag, and an unknown id all answer this ONE copy — no oracle between them.
const SHARED_404 = "Reaction tag not found.";

// The tag text law: a locale-key reference or a short server-native string
// of at most GC_REACTION_TAG_TEXT_MAX code points — NO painted free-text
// of unbounded length. Empty is neither.
const LOCALE_KEY_SHAPE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

function isValidTagText(tagText) {
  if (LOCALE_KEY_SHAPE.test(tagText)) return true;
  return [...tagText].length >= 1 && [...tagText].length <= GC_REACTION_TAG_TEXT_MAX;
}

// The emoji hygiene law (cycle-5): the emoji half of the pair is
// code-point-bounded like the tag text — an over-long emoji never reaches a
// statement on either door (the pin or the unmap).
function isValidEmoji(emoji) {
  return [...emoji].length >= 1 && [...emoji].length <= GC_REACTION_TAG_EMOJI_MAX;
}

// --- the statements -------------------------------------------------------------

// The mod-gated upsert: BOTH arms gated — the plain-INSERT arm takes its
// WHERE and the DO UPDATE arm its own, so a non-mod's write (or a PUT past
// the map cap) makes zero changes either way. The UNIQUE (server_id, emoji)
// pair is the conflict target; a re-PUT refreshes in place, never a second
// row. Binds, textual order (10): server_id, emoji, tag_text, created_by,
// created_at (5) | server_id, user_id, server_id (the insert arm's role +
// cap), user_id, server_id (the update arm's role + cap, server_id resolved
// against the target row). 10 binds, this order.
const TAG_PUT_SQL =
  "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) " +
  "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "AND (SELECT COUNT(*) FROM gc_server_reaction_tags t WHERE t.server_id = ?) < " + GC_REACTION_TAGS_MAX +
  " ON CONFLICT (server_id, emoji) DO UPDATE SET tag_text = excluded.tag_text, " +
    "created_by = excluded.created_by, created_at = excluded.created_at " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = gc_server_reaction_tags.server_id AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "AND (SELECT COUNT(*) FROM gc_server_reaction_tags t WHERE t.server_id = ?) < " + GC_REACTION_TAGS_MAX;

// The refreshed-row read after the upsert (both paths answer the same
// truth). Three binds: server_id, emoji, user_id.
const TAG_PUT_READ_SQL =
  "SELECT id, emoji, tag_text FROM gc_server_reaction_tags WHERE server_id = ? AND emoji = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = gc_server_reaction_tags.server_id AND pm.user_id = ?) " +
  "LIMIT 1";

// The mod-gated unmap: the role lives INSIDE the DELETE's WHERE. Four
// binds: server_id, emoji, server_id, user_id.
const TAG_UNMAP_SQL =
  "DELETE FROM gc_server_reaction_tags WHERE server_id = ? AND emoji = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm WHERE pm.server_id = ? " +
    "AND pm.user_id = ? AND pm.role IN ('owner','moderator'))";

// The member's map read: membership rides INSIDE the WHERE, so a
// non-member's read answers [] through the statement gate. No member
// column rides the SELECT list (privacy law). Three binds: server_id,
// server_id, user_id.
const TAG_MAP_READ_SQL =
  "SELECT id, emoji, tag_text FROM gc_server_reaction_tags WHERE server_id = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm WHERE pm.server_id = ? AND pm.user_id = ?) " +
  "ORDER BY created_at DESC, id DESC LIMIT " + GC_REACTION_TAGS_MAX;

// The opt: reachability (the tag row in a server this member belongs to)
// lives INSIDE the statement; ON CONFLICT (tag_id, user_id) — the opts
// table's own PK — DO NOTHING keeps the act idempotent. Five binds:
// tag_id, user_id, opted_at, tag_id, user_id.
const TAG_OPT_SQL =
  "INSERT INTO gc_reaction_tag_opts (tag_id, user_id, opted_at) SELECT ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_reaction_tags t " +
    "JOIN gc_server_members pm ON pm.server_id = t.server_id " +
    "WHERE t.id = ? AND pm.user_id = ?) " +
  "ON CONFLICT (tag_id, user_id) DO NOTHING";

// The zero-change opt's own-row read: splits "already mine" from "not
// reachable" against the CALLER's row only. Two binds: tag_id, user_id.
const TAG_OPT_OWN_SQL = "SELECT 1 AS mine FROM gc_reaction_tag_opts WHERE tag_id = ? AND user_id = ? LIMIT 1";

// The un-opt: self-scoped, the caller's (tag_id, user_id) row IS the only
// key. Two binds: tag_id, user_id.
const TAG_UNOPT_SQL =
  "DELETE FROM gc_reaction_tag_opts WHERE tag_id = ? AND user_id = ?";

// The mine read: ONLY the caller's opted tags for THIS server, newest opt
// first — no other member's row, no count across members (privacy law).
// Two binds: user_id, server_id.
const TAG_MINE_SQL =
  "SELECT t.id, t.emoji, t.tag_text FROM gc_reaction_tag_opts o " +
  "JOIN gc_server_reaction_tags t ON t.id = o.tag_id " +
  "WHERE o.user_id = ? AND t.server_id = ? " +
  "ORDER BY o.opted_at DESC, t.id DESC LIMIT " + GC_REACTION_TAGS_MAX;

// --- routes ---------------------------------------------------------------------

async function handleTagPutRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:map:" + userId);

  const body = await readJson(request);
  const emoji = typeof body?.emoji === "string" ? body.emoji : "";
  const tagText = typeof body?.tag === "string" ? body.tag : "";
  if (!isValidEmoji(emoji) || !isValidTagText(tagText)) {
    throw new HttpError(400, "Send an emoji plus a short tag (or a locale key like gc.tags.campfire).");
  }

  const result = await env.GOOBER_DB.prepare(TAG_PUT_SQL).bind(
    serverId, emoji, tagText, userId, nowSeconds(),
    serverId, userId, serverId,
    userId, serverId,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, SHARED_404);
  }
  const row = await env.GOOBER_DB.prepare(TAG_PUT_READ_SQL)
    .bind(serverId, emoji, userId).first();
  return json({ tag: { id: Number(row?.id) || 0, emoji, tag: String(row?.tag_text || tagText) } }, 200);
}

async function handleTagMapRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "reaction-tags:map-read:" + userId);

  const rows = (await env.GOOBER_DB.prepare(TAG_MAP_READ_SQL)
    .bind(serverId, serverId, userId).all()).results || [];
  return json({
    tags: rows.map((row) => ({ id: Number(row.id), emoji: row.emoji, tag: row.tag_text })),
  });
}

async function handleTagUnmapRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:unmap:" + userId);

  const body = await readJson(request);
  const emoji = typeof body?.emoji === "string" ? body.emoji : "";
  if (!isValidEmoji(emoji)) {
    throw new HttpError(400, "Send the emoji to unmap.");
  }
  const result = await env.GOOBER_DB.prepare(TAG_UNMAP_SQL)
    .bind(serverId, emoji, serverId, userId).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, SHARED_404);
  }
  return json({});
}

async function handleTagOptRoute(request, env, serverId, tagId) {
  void serverId;
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:opt:" + tagId + ":" + userId);

  const result = await env.GOOBER_DB.prepare(TAG_OPT_SQL)
    .bind(tagId, userId, nowSeconds(), tagId, userId).run();
  if (Number(result.meta?.changes) === 1) {
    return json({ opted: true });
  }
  const own = await env.GOOBER_DB.prepare(TAG_OPT_OWN_SQL).bind(tagId, userId).first();
  if (own) {
    return json({ opted: true, duplicate: true });
  }
  throw new HttpError(404, SHARED_404);
}

async function handleTagUnoptRoute(request, env, serverId, tagId) {
  void serverId;
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:unopt:" + tagId + ":" + userId);

  const result = await env.GOOBER_DB.prepare(TAG_UNOPT_SQL).bind(tagId, userId).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, SHARED_404);
  }
  return json({});
}

async function handleTagMineRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "reaction-tags:mine:" + userId);

  const rows = (await env.GOOBER_DB.prepare(TAG_MINE_SQL)
    .bind(userId, serverId).all()).results || [];
  return json({
    tags: rows.map((row) => ({ id: Number(row.id), emoji: row.emoji, tag: row.tag_text })),
  });
}

// --- dispatch --------------------------------------------------------------------

// Route table (ids stay bare, bounded-width — the route-id conventions):
//   PUT/GET/DELETE /api/servers/:id/reaction-tags              (mod map / member map)
//   POST/DELETE    /api/servers/:id/reaction-tags/:tagId/opt   (member opts)
//   GET            /api/servers/:id/reaction-tags/mine         (own opts)
export async function handleReactionTagRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  // The opt pair rides first: its paths contain the base path.
  const optMatch = (method === "POST" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/reaction-tags\/(0|[1-9][0-9]*)\/opt$/)
    : null;
  if (optMatch) {
    const serverId = Number(optMatch[1]);
    const tagId = Number(optMatch[2]);
    return method === "POST"
      ? handleTagOptRoute(request, env, serverId, tagId)
      : handleTagUnoptRoute(request, env, serverId, tagId);
  }

  const mineMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/reaction-tags\/mine$/)
    : null;
  if (mineMatch) return handleTagMineRoute(request, env, Number(mineMatch[1]));

  const baseMatch = (method === "PUT" || method === "GET" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/reaction-tags$/)
    : null;
  if (baseMatch) {
    const serverId = Number(baseMatch[1]);
    if (method === "PUT") return handleTagPutRoute(request, env, serverId);
    if (method === "GET") return handleTagMapRoute(request, env, serverId);
    return handleTagUnmapRoute(request, env, serverId);
  }

  return undefined;
}
