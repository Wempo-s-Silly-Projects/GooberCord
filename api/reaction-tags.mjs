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

// T89: Reaction tags (docs/drafts/t89-reaction-tags-spec.md) — the cosmetic
// emoji→tag map. A mod pins a handful of emoji→tag pairs naming the moments
// the server cares about; a member opts in per tag with one act, and their
// own opts paint the profile. The seat RIDES the existing reaction surface:
// the map keys on the same emoji vocabulary the reaction store paints; NO
// reaction row is written by any route here and the reaction engine is NOT
// reinvented.
//
// PRIVACY: the map read carries no member column at all; the mine read
// carries ONLY the caller's rows (o.user_id rides the statement's WHERE) —
// no cross-member read, no count across members, no leaderboard.
//
// LAWS: statement-gate idiom — mod role, membership, reachability, and the
// map cap live INSIDE the statements; changes-0 classifies to the ONE shared
// 404 body, never a 403, no pre-read oracle. Defaults law — no tag rows and
// no opts exist until someone acts; an empty list is a valid answer. Economy
// re-rule — tags are FREE cosmetics: no mint, no price, no coin statement.
// Every cap is a named constants.mjs import.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { GC_REACTION_TAGS_MAX, GC_REACTION_TAG_TEXT_MAX } from "../constants.mjs";

// --- the SQL (spec §4's pinned statement-gate shapes and bind orders) ---------

// The mod-gated upsert: BOTH arms gated (2026-11-18 lead ruling on the
// t89-review CRITICAL — a bare VALUES upsert takes the plain-INSERT arm
// where no WHERE is ever evaluated, so the role gate and the map cap ride
// the SELECT-WHERE for the insert arm AND the DO UPDATE's WHERE for the
// update arm; a gated arm answers changes-0 either way → the shared 404).
// The cap is a CREATE cap (spec §4: it bounds the map's DISTINCT emoji
// slots — it never bounds a re-label): the update arm's exemption (`OR the
// row for THIS server's emoji already exists`, keyed through excluded.* with
// no new binds) lets at-cap members re-label an existing emoji while a row
// 21 with a fresh emoji still refuses through the count arm. Both arms
// classify to the shared 404 on changes-0.
// Upsert refreshes in place (paper idiom): ON CONFLICT the seat refreshes,
// never a second row.
const TAG_PUT_SQL =
  "INSERT INTO gc_server_reaction_tags (server_id, emoji, tag_text, created_by, created_at) " +
  "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "AND (SELECT COUNT(*) FROM gc_server_reaction_tags t WHERE t.server_id = ?) < " + GC_REACTION_TAGS_MAX + " " +
  "ON CONFLICT (server_id, emoji) DO UPDATE SET tag_text = excluded.tag_text, " +
    "created_by = excluded.created_by, created_at = excluded.created_at " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "AND ((SELECT COUNT(*) FROM gc_server_reaction_tags t WHERE t.server_id = ?) < " + GC_REACTION_TAGS_MAX +
    " OR EXISTS (SELECT 1 FROM gc_server_reaction_tags t " +
      "WHERE t.server_id = excluded.server_id AND t.emoji = excluded.emoji))";
// .bind(server_id, emoji, tag_text, created_by, created_at,
//        server_id, user_id, server_id,           — the INSERT arm's role + cap
//        server_id, user_id, server_id)           — the update arm's role + cap
//   — 11 binds, this order

// The post-upsert state read (paints {tag: {id, emoji, tag}}): the row that
// the upsert just refreshed — insert path and update path both answer the
// same truth. Membership rides the EXISTS so the read stays gated.
const TAG_PUT_ID_READ_SQL =
  "SELECT id, emoji, tag_text FROM gc_server_reaction_tags WHERE server_id = ? AND emoji = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = gc_server_reaction_tags.server_id AND pm.user_id = ?)";
// .bind(server_id, emoji, user_id)   — 3 binds, this order

// The mod-gated unmap: the role lives INSIDE the DELETE's WHERE — a wrong
// role (or a wrong emoji) answers changes-0, classified to the shared 404,
// never a 403 existence oracle.
const TAG_DELETE_SQL =
  "DELETE FROM gc_server_reaction_tags WHERE server_id = ? AND emoji = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm WHERE pm.server_id = ? " +
    "AND pm.user_id = ? AND pm.role IN ('owner','moderator'))";
// .bind(server_id, emoji, server_id, user_id)   — 4 binds, this order

// The member read of the map: membership lives INSIDE the WHERE — a
// non-member's read answers [] through the statement gate.
const TAG_MAP_READ_SQL =
  "SELECT id, emoji, tag_text FROM gc_server_reaction_tags WHERE server_id = ? " +
  "AND EXISTS (SELECT 1 FROM gc_server_members pm WHERE pm.server_id = ? AND pm.user_id = ?) " +
  "ORDER BY created_at DESC, id DESC LIMIT " + GC_REACTION_TAGS_MAX;
// .bind(server_id, server_id, user_id)   — 3 binds, this order

// The opt: reachability (the tag row in a server this member belongs to)
// lives INSIDE the statement; ON CONFLICT DO NOTHING = idempotent.
// changes-0 → the route reads the caller's OWN opt row to split "already
// mine" from "not reachable" without any other member's row riding it.
const TAG_OPT_SQL =
  "INSERT INTO gc_reaction_tag_opts (tag_id, user_id, opted_at) SELECT ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_reaction_tags t " +
    "JOIN gc_server_members pm ON pm.server_id = t.server_id " +
    "WHERE t.id = ? AND pm.user_id = ?) " +
  "ON CONFLICT (tag_id, user_id) DO NOTHING";
// .bind(tag_id, user_id, opted_at, tag_id, user_id)   — 5 binds, this order

// The changes-0 opt's own-row read: distinguishes "already mine" from "not
// reachable" — the caller's row only.
const TAG_OPT_OWN_READ_SQL =
  "SELECT opted_at FROM gc_reaction_tag_opts WHERE tag_id = ? AND user_id = ?";

// The un-opt: self-scoped, the owner IS the only key (bookmark idiom).
const TAG_UNOPT_SQL =
  "DELETE FROM gc_reaction_tag_opts WHERE tag_id = ? AND user_id = ?";
// .bind(tag_id, user_id)   — 2 binds

// The mine read: ONLY the caller's opted tags for THIS server, newest opt
// first, cut at the named cap — no member column, no cross-member count.
const TAG_MINE_READ_SQL =
  "SELECT t.id, t.emoji, t.tag_text FROM gc_reaction_tag_opts o " +
  "JOIN gc_server_reaction_tags t ON t.id = o.tag_id " +
  "WHERE o.user_id = ? AND t.server_id = ? " +
  "ORDER BY o.opted_at DESC, t.id DESC LIMIT " + GC_REACTION_TAGS_MAX;
// .bind(user_id, server_id)   — 2 binds, this order

// --- the gates ----------------------------------------------------------------

// The tag text law (spec §6): a locale-key REFERENCE or a short
// server-native string of at most GC_REACTION_TAG_TEXT_MAX code points —
// NO painted free-text of unbounded length. Empty is neither.
const LOCALE_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const SHARED_404 = "Reaction tag not found.";

function isValidTagText(tagText) {
  if (LOCALE_KEY_RE.test(tagText)) return true;
  const codePoints = [...tagText].length;
  return codePoints >= 1 && codePoints <= GC_REACTION_TAG_TEXT_MAX;
}

// --- the routes ----------------------------------------------------------------

export async function handleReactionTagRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  // The self-scoped opt pair rides first: the /opt path contains the base
  // path, so the pair's matches ride above the broad base reads.
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
  if (mineMatch) {
    return handleTagMineRoute(request, env, Number(mineMatch[1]));
  }

  const baseMatch = (method === "PUT" || method === "GET" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/reaction-tags$/)
    : null;
  if (baseMatch) {
    const serverId = Number(baseMatch[1]);
    if (method === "PUT") return handleTagPutRoute(request, env, serverId);
    if (method === "GET") return handleTagMapReadRoute(request, env, serverId);
    return handleTagUnmapRoute(request, env, serverId);
  }

  return undefined;
}

// PUT /api/servers/:id/reaction-tags — the mod's map act. The role gate and
// the map cap ride INSIDE the statement; a non-mod's write (or a PUT past
// the cap) makes zero changes → the shared 404, never a 403.
async function handleTagPutRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:map:" + userId);

  const body = await readJson(request);
  const emoji = typeof body?.emoji === "string" ? body.emoji : "";
  const tagText = typeof body?.tag === "string" ? body.tag : "";
  if (!emoji || !isValidTagText(tagText)) {
    throw new HttpError(400, "Invalid tag text.");
  }

  const result = await env.GOOBER_DB.prepare(TAG_PUT_SQL).bind(
    serverId, emoji, tagText, userId, nowSeconds(),
    serverId, userId, serverId,
    serverId, userId, serverId,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, SHARED_404);
  }
  // Paint the refreshed state from the row the upsert just wrote.
  const rows = (await env.GOOBER_DB.prepare(TAG_PUT_ID_READ_SQL)
    .bind(serverId, emoji, userId).all()).results || [];
  const row = rows.find((row) => row.emoji === emoji);
  return json({ tag: { id: Number(row?.id) || 0, emoji, tag: String(row?.tag_text || tagText) } });
}

// GET /api/servers/:id/reaction-tags — the server's map members can reach.
// Membership rides INSIDE the read's WHERE; the payload carries ids, emoji,
// tag only — no member identity, no count across members (privacy law).
async function handleTagMapReadRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "reaction-tags:map-read:" + userId);

  const rows = (await env.GOOBER_DB.prepare(TAG_MAP_READ_SQL)
    .bind(serverId, serverId, userId).all()).results || [];
  return json({
    tags: rows.slice(0, GC_REACTION_TAGS_MAX).map((row) => ({
      id: Number(row.id),
      emoji: row.emoji,
      tag: row.tag_text,
    })),
  });
}

// DELETE /api/servers/:id/reaction-tags — the mod's unmap. The role rides
// INSIDE the DELETE's WHERE; changes-0 → the shared 404 (non-mod, wrong
// emoji — indistinguishable, no oracle).
async function handleTagUnmapRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:unmap:" + userId);

  const body = await readJson(request);
  const emoji = typeof body?.emoji === "string" ? body.emoji : "";
  if (!emoji) {
    throw new HttpError(400, "Invalid tag text.");
  }

  const result = await env.GOOBER_DB.prepare(TAG_DELETE_SQL).bind(
    serverId, emoji, serverId, userId,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, SHARED_404);
  }
  return json({});
}

// POST /api/servers/:id/reaction-tags/:tagId/opt — the member's opt act.
// Reachability rides INSIDE the statement; changes-0 resolves via the
// caller's OWN opt row: already mine → the duplicate answer, otherwise the
// shared 404 (unknown tag and non-member indistinguishable).
async function handleTagOptRoute(request, env, serverId, tagId) {
  void serverId;
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "reaction-tags:opt:" + tagId + ":" + userId);

  const result = await env.GOOBER_DB.prepare(TAG_OPT_SQL).bind(
    tagId, userId, nowSeconds(), tagId, userId,
  ).run();
  if (Number(result.meta?.changes) === 1) {
    return json({ opted: true });
  }
  const own = await env.GOOBER_DB.prepare(TAG_OPT_OWN_READ_SQL)
    .bind(tagId, userId).first();
  if (own) {
    return json({ opted: true, duplicate: true });
  }
  throw new HttpError(404, SHARED_404);
}

// DELETE /api/servers/:id/reaction-tags/:tagId/opt — the self-scoped un-opt.
// Ownership IS the only key; never-opted and no-such-tag answer the SAME
// shared 404 (bookmark idiom — no 403 oracle).
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

// GET /api/servers/:id/reaction-tags/mine — the profile's own tag chips.
// ONLY the caller's opted tags (o.user_id rides the WHERE), newest opt
// first, capped — no other member's rows, no count (privacy law). The empty
// list is a valid answer (defaults law), never an error.
async function handleTagMineRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "reaction-tags:mine:" + userId);

  const rows = (await env.GOOBER_DB.prepare(TAG_MINE_READ_SQL)
    .bind(userId, serverId).all()).results || [];
  return json({
    tags: rows.slice(0, GC_REACTION_TAGS_MAX).map((row) => ({
      id: Number(row.id),
      emoji: row.emoji,
      tag: row.tag_text,
    })),
  });
}
