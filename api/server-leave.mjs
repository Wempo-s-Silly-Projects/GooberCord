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

// GooberCord's leave + ownership-transfer + server-delete routes
// (T-R25-SPLIT-SERVERS-5: the wave-25's fifth family off api/servers.mjs —
// moved VERBATIM: the member exit, the owner handover, and the owner's
// one-act server teardown, plus their own dispatch). The boost-recount
// fragment (BOOST_RECOUNT_SQL) and the failure-label helper (errorName)
// stay ONE implementation in api/servers.mjs, imported here (call-time
// use — the circular import stays inert); the family's own membership
// row and race message move with it; the owner guard fragment keeps the
// sibling-lane local-mirror idiom.

import { requireUser } from "./core/auth.mjs";
import { rateLimit, readJson, HttpError, json } from "./core/http.mjs";
import { GC_SERVER_DELETE_ATTACHMENT_LIMIT, PINS_READ_BIND_CHUNK } from "../constants.mjs";
import { scheduleAttachmentObjectDelete } from "./media.mjs";
import { BOOST_RECOUNT_SQL, errorName } from "./servers.mjs";

// The manage-guard fragments mirror the sibling lanes' exact copies (the
// roles/roster lane's mirrors-comment rides the same idiom: a guard change
// must be re-mirrored and the parity tests pin the copies' behavior).

const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// --- wave 8 (T-PARITY-LEAVE): leave server + transfer ownership -----------------

// The membership gate/classification row: the string-tier role plus the
// fields the transfer demote re-inserts (one read — never a second shape).
const MEMBERSHIP_ROW_SQL =
  "SELECT role, joined_at, nickname, timed_out_until, created_by_invite, rules_accepted_at " +
  "FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// POST /api/servers/:id/leave — a member removes their OWN membership row.
// All authority in-statement: the DELETE's WHERE binds the caller's own row,
// the membership arm that row rides, and the owner-refusal NOT-EXISTS arm —
// a plain member's run deletes only their own row, and the owner's refusal
// holds even race-on. Non-members share the unknown-server 404 (no
// existence oracle), and mentions/bookmarks survive a leave by design
// (history-kept law; no mint, no spend — outside economy scope).
async function handleLeaveServerRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-leave:" + serverId + ":" + userId);

  // The gate read: a non-member 404s, and the owner refusal (parity-mirrored)
  // is decided here before any write — the 409 points at the transfer route.
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_ROW_SQL)
    .bind(serverId, userId).first();
  if (!membership) {
    throw new HttpError(404, "That server does not exist or you are not in it.");
  }
  if (membership.role === "owner") {
    throw new HttpError(
      409,
      "Transfer ownership before leaving. POST /api/servers/" + serverId +
        "/transfer-ownership",
    );
  }

  // ONE batch, kick's shape: the row's RBAC assignments, the departing
  // booster's gc_server_boosts row, and the member row leave together, each
  // statement carrying the same guard arms — the caller's own row, the
  // membership arm, the owner-refusal NOT-EXISTS arm. ORDER IS LOAD-BEARING
  // (D1's batch is one sequential transaction, the same class the transfer
  // demote's promote-landed rider relies on): the strips ride BEFORE the
  // member-row delete, because their membership-EXISTS arms go false the
  // moment that delete fires — a member-first batch commits them as refuted
  // zero-changes no-ops. Assignments (gc_member_roles carries no membership
  // FK) survive a bare member-row delete, so a stripless leave would re-arm
  // them on rejoin; and the boost row (no FK/trigger ties it to membership
  // either) would keep counting toward the boost level — the caps a departed
  // booster grants — unless it strips in the same breath. The recount rides
  // LAST, in-batch (the boost routes' idiom): the count derives from the
  // stripped rows, so no post-batch failure can leave a stale
  // gc_servers.boosts. The verdict reads the member-row delete's changes
  // (results[2]); the race path is intact — a vanished row refutes the
  // strips at batch start AND deletes 0, so the classification re-read
  // answers 404 exactly as before.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ?) " +
        "AND NOT " + OWNER_EXISTS_SQL,
    ).bind(serverId, userId, serverId, userId, serverId, userId),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ?) " +
        "AND NOT " + OWNER_EXISTS_SQL,
    ).bind(serverId, userId, serverId, userId, serverId, userId),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ?) " +
        "AND NOT " + OWNER_EXISTS_SQL,
    ).bind(serverId, userId, serverId, userId, serverId, userId),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);
  const deletedChanges = Number(results[2]?.meta?.changes) || 0;

  if (deletedChanges !== 1) {
    // The row vanished between the gate and the DELETE (race-on leave): the
    // one delete stays a no-op — never a double-delete — and the
    // classification re-read answers 404, or the 409 when a raced transfer
    // made the caller the owner.
    const current = await env.GOOBER_DB.prepare(MEMBERSHIP_ROW_SQL)
      .bind(serverId, userId).first();
    if (current && current.role === "owner") {
      throw new HttpError(
        409,
        "Transfer ownership before leaving. POST /api/servers/" + serverId +
          "/transfer-ownership",
      );
    }
    throw new HttpError(404, "That server does not exist or you are not in it.");
  }

  return json({ left: true, serverId }, 200);
}

// POST /api/servers/:id/transfer-ownership — the owner hands the server to an
// active member. The whole swap is ONE batch (D1 commits or rolls back
// whole): the promote whose WHERE carries the caller's owner arm AND the
// target's active-member arm, the demote riding the promote-landed rider, and
// the server-row owner swap LAST behind its own promote-landed rider — a
// refused promote strands the swap at changes=0 (D1 commits zero-changes
// statements silently; the rider is the guarantee). The demote is DELETE +
// exact re-INSERT,
// because the owner guard trigger (migration 0001) ABORTs any UPDATE that
// demotes an owner row — the trigger's intent (no STRAY demote) transfers
// WITH the ownership flow; the re-insert preserves the row's fields verbatim
// from the gate read.
const TRANSFER_RACE_MESSAGE =
  "The server's ownership changed while you were transferring. Reload and try again.";

async function handleTransferOwnershipRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const me = Number(session.user.id);
  const body = await readJson(request);
  if (!Number.isSafeInteger(body.userId) || body.userId < 1) {
    throw new HttpError(400, "userId must be a user id.");
  }
  const targetUserId = body.userId;

  await rateLimit(request, env, "write", "servers-transfer:" + serverId + ":" + me);

  // The gate read: non-members share the unknown-server 404; non-owners the
  // shared 403 (authority also rides the promote's owner arm in-statement).
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_ROW_SQL)
    .bind(serverId, me).first();
  if (!membership) {
    throw new HttpError(404, "That server does not exist or you are not in it.");
  }
  if (membership.role !== "owner") {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  // The owner handing to themselves: an idempotent no-op, never an error.
  if (targetUserId === me) {
    return json({ transferred: false, serverId, ownerId: me }, 200);
  }

  // Statement 3 (rides LAST): the server-brain swap — gc_servers.owner_user_id
  // moves to the target only AFTER the promote chain landed, behind the
  // promote-landed EXISTS rider: a refused promote (a target who left or was
  // kicked between the gate read and the batch) forces the swap's changes=0,
  // so D1's silent zero-changes commits can never strand the server's owner
  // field on a departed non-member. The batch is atomic either way; the
  // 4-changes verdict gate below classifies any mismatch 409/404 with the
  // swap never landed.
  const serverSwap = env.GOOBER_DB.prepare(
    "UPDATE gc_servers SET owner_user_id = ? WHERE id = ? AND owner_user_id = ? " +
      "AND EXISTS (SELECT 1 FROM gc_server_members pt WHERE pt.server_id = ? AND pt.user_id = ? AND pt.role = 'owner')",
  ).bind(targetUserId, serverId, me, serverId, targetUserId);

  // Statement 0: promote the active member. The demote below fires only
  // behind the promote-landed rider, so any refused arm leaves the batch a
  // committed no-op — never an ownerless or half-swapped server. 'blocked'
  // tiers don't exist on the roster schema (owner/moderator/member, every
  // member row active); the target arm's role IS NOT NULL is the active
  // predicate.
  const promote = env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET role = 'owner' WHERE server_id = ? AND user_id = ? " +
      "AND EXISTS (SELECT 1 FROM gc_server_members od WHERE od.server_id = ? AND od.user_id = ? AND od.role = 'owner') " +
      "AND EXISTS (SELECT 1 FROM gc_server_members mb WHERE mb.server_id = ? AND mb.user_id = ? AND mb.role IS NOT NULL)",
  ).bind(serverId, targetUserId, serverId, me, serverId, targetUserId);

  // Statement 1: demote the old owner — the row leaves, guarded by the owner
  // arm AND the promote having landed.
  const demoteDelete = env.GOOBER_DB.prepare(
    "DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ? AND role = 'owner' " +
      "AND " + OWNER_EXISTS_SQL +
      " AND EXISTS (SELECT 1 FROM gc_server_members pt WHERE pt.server_id = ? AND pt.user_id = ? AND pt.role = 'owner')",
  ).bind(serverId, me, serverId, me, serverId, targetUserId);

  // Statement 2: the exact re-insert — the demoted owner keeps their row as a
  // plain member, fields preserved verbatim, guarded by the row-is-gone rider
  // and the promote-landed rider. The preserved fields ride the gate read's
  // values, so a concurrent nickname/timeout write landing between that gate
  // and this batch is re-inserted from the older snapshot: a bounded
  // one-round-trip window (the trigger shape forces the row out before any
  // fresh read inside the batch), never a half-swapped state.
  const demoteInsert = env.GOOBER_DB.prepare(
    "INSERT INTO gc_server_members (server_id, user_id, role, joined_at, nickname, timed_out_until, created_by_invite, rules_accepted_at) " +
      "SELECT ?, ?, 'member', ?, ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ?) " +
      "AND EXISTS (SELECT 1 FROM gc_server_members pt WHERE pt.server_id = ? AND pt.user_id = ? AND pt.role = 'owner')",
  ).bind(
    serverId, me, membership.joined_at, membership.nickname,
    membership.timed_out_until, membership.created_by_invite,
    membership.rules_accepted_at,
    serverId, me, serverId, targetUserId,
  );

  const results = await env.GOOBER_DB.batch([promote, demoteDelete, demoteInsert, serverSwap]);
  const swapChanges = Number(results[3]?.meta?.changes) || 0;
  const promoteChanges = Number(results[0]?.meta?.changes) || 0;
  const demoteChanges = Number(results[1]?.meta?.changes) || 0;
  const reinsertChanges = Number(results[2]?.meta?.changes) || 0;
  if (
    swapChanges === 1 && promoteChanges === 1 &&
    demoteChanges === 1 && reinsertChanges === 1
  ) {
    return json({ transferred: true, serverId, ownerId: targetUserId }, 200);
  }

  // Diagnostic only: authority already rode the batch's arms. The caller
  // still owning the server means the TARGET arm refused (404 — the same
  // wording a kick's missing target answers); anything else is the ownership
  // racing away underneath, answered 409.
  const current = await env.GOOBER_DB.prepare(MEMBERSHIP_ROW_SQL)
    .bind(serverId, me).first();
  if (current && current.role === "owner") {
    throw new HttpError(404, "That member is not in this server.");
  }
  throw new HttpError(409, TRANSFER_RACE_MESSAGE);
}

// --- server DELETE: the owner's one-act delete (the shaver) -----------------------

// Owner-only, and the SAME discipline the channel DELETE set: every statement
// of the batch carries the owner-membership guard in its OWN WHERE, so an
// unauthorized caller strips NOTHING even in a pre-cleanup statement. The
// ordering is the FK graph's: message attachments (chunks → rows, the exact
// shape the channel DELETE mirrors — gc_attachments.message_id carries no ON
// DELETE action, so the channels' implicit message CASCADE must never meet a
// live attachment row), the expression tables' standalone attachments the
// same way (with their gc_emoji/gc_stickers rows deleted FIRST — RESTRICT,
// so freeing an attachment row needs its expression row gone), member_roles
// → roles (their CASCADEs take the overwrite rows), then the server row
// itself — whose implicit CASCADE takes members, invites, boosts, the
// remaining overwrites, filter rules/alerts, and server bans (gc_channels'
// FK to gc_servers is NO ACTION, which is exactly why the channels went
// first). The two icon statements run AFTER the server-row DELETE: their
// authority is the data, not the caller — `NOT EXISTS (a server still
// pointing at the attachment)` means the batch stripped nothing for any
// server alive to point (an unauthorized caller's dying server never died),
// and a genuinely shared icon (the PATCH's uploader guard allows one
// uploaded attachment to icon two servers of the same owner) keeps its
// bytes. The attachment pre-read's ceiling is the inventories' widest caps'
// sum (GC_SERVER_DELETE_ATTACHMENT_LIMIT — 358 at the boost ladder's top, the
// lane-haywire6-servers fix for the old flat 127 that orphaned ~231 max-tier
// rows), and every literal-id statement + the survivor read chunk at
// PINS_READ_BIND_CHUNK so no statement rides the 100-bind ceiling.

async function handleDeleteServerRoute(request, env, serverId, ctx) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The pre-reads bind the batch's literal ids (the remote-D1 lesson: no id
  // is ever derived INSIDE a batch): this server's expression + soundboard
  // attachments (caps hold the lists small; the LIMIT only pins a
  // corrupted-DB loud failure instead of a bind limit) and the icon pointer.
  const emojiRows = (await env.GOOBER_DB.prepare(
    "SELECT attachment_id FROM gc_emoji WHERE server_id = ?",
  ).bind(serverId).all()).results || [];
  const stickerRows = (await env.GOOBER_DB.prepare(
    "SELECT attachment_id FROM gc_stickers WHERE server_id = ?",
  ).bind(serverId).all()).results || [];
  const soundRows = (await env.GOOBER_DB.prepare(
    "SELECT attachment_id FROM gc_sounds WHERE server_id = ?",
  ).bind(serverId).all()).results || [];
  const expressionAttachmentIds = [...emojiRows, ...stickerRows, ...soundRows]
    .map((row) => Number(row.attachment_id))
    .slice(0, GC_SERVER_DELETE_ATTACHMENT_LIMIT);
  const iconRow = await env.GOOBER_DB.prepare(
    "SELECT icon_media_id FROM gc_servers WHERE id = ? LIMIT 1",
  ).bind(serverId).first();
  const iconMediaId =
    iconRow?.icon_media_id === null || iconRow?.icon_media_id === undefined
      ? null
      : Number(iconRow.icon_media_id);
  // The message attachments' own ids (the object store's purge list rides
  // the same pre-read discipline — no id is ever derived INSIDE a batch).
  const doomedAttachmentIds = [...expressionAttachmentIds];
  if (iconMediaId !== null) doomedAttachmentIds.push(iconMediaId);
  doomedAttachmentIds.push(...((await env.GOOBER_DB.prepare(
    "SELECT a.id FROM gc_attachments a " +
      "WHERE a.message_id IN (SELECT id FROM gc_messages WHERE channel_id IN (SELECT id FROM gc_channels WHERE server_id = ?))",
  ).bind(serverId).all()).results || []).map((row) => Number(row.id)));

  const guard = { sql: "(" + OWNER_EXISTS_SQL + ")", params: [serverId, userId] };

  // [key, sql, binds] — keys become the 200's deleted counts.
  const statements = [];
  const push = (key, sql, binds) => statements.push({ key, sql, binds });

  push("messageAttachmentChunks",
    "DELETE FROM gc_attachment_chunks WHERE attachment_id IN (SELECT a.id FROM gc_attachments a " +
      "WHERE a.message_id IN (SELECT id FROM gc_messages WHERE channel_id IN (SELECT id FROM gc_channels WHERE server_id = ?))) " +
      "AND " + guard.sql,
    [serverId, ...guard.params]);
  push("messageAttachments",
    "DELETE FROM gc_attachments WHERE message_id IN (SELECT id FROM gc_messages WHERE channel_id IN (SELECT id FROM gc_channels WHERE server_id = ?)) " +
      "AND " + guard.sql,
    [serverId, ...guard.params]);

  // The literal-id statements chunk at PINS_READ_BIND_CHUNK (the full-cap
  // ceiling is 358 ids — one statement would ride 360 binds, past D1's 100):
  // each chunked statement keeps the FK ordering (the chunk rows strip before
  // the expression rows, whose deletes sit between the chunk families).
  const pushIdChunks = (key, head, tail, ids, extraBinds = []) => {
    for (let start = 0; start < ids.length; start += PINS_READ_BIND_CHUNK) {
      const chunk = ids.slice(start, start + PINS_READ_BIND_CHUNK);
      const idList = chunk.map(() => "?").join(", ");
      push(key, head + idList + tail, [...chunk, ...extraBinds]);
    }
  };

  pushIdChunks("expressionAttachmentChunks",
    "DELETE FROM gc_attachment_chunks WHERE attachment_id IN (", ") AND " + guard.sql,
    expressionAttachmentIds, guard.params);
  push("emoji",
    "DELETE FROM gc_emoji WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  push("stickers",
    "DELETE FROM gc_stickers WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  pushIdChunks("expressionAttachments",
    "DELETE FROM gc_attachments WHERE id IN (",
    ") AND message_id IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = gc_attachments.id) " +
      "AND NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = gc_attachments.id) " +
      "AND " + guard.sql,
    expressionAttachmentIds, guard.params);

  push("memberRoles",
    "DELETE FROM gc_member_roles WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  push("roles",
    "DELETE FROM gc_roles WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  // The orphan sweeps (lane-r2-sweep): these server-scoped tables carry NO FK
  // to gc_servers (the welcome pair is migration 0054's bare PK shape; the
  // reaction-tag pair rides the prod-applied migration 0041 outside this
  // tree), so the purge sweeps them behind the SAME guard — the opts rows
  // before their tag rows, whichever FK law the prod ledger carries. The
  // doomed messages' gc_bookmarks pointers are their own statement
  // (messageBookmarks below — also FK-less, migration 0053). FK-covered
  // siblings (gc_read_state, gc_message_reactions, gc_mentions, gc_sounds,
  // the members/invites/bans family) ride the schema's CASCADEs instead —
  // see tests/r2-sweep-fk-pins.test.mjs.
  push("messageBookmarks",
    "DELETE FROM gc_bookmarks WHERE message_id IN (SELECT id FROM gc_messages WHERE channel_id IN (SELECT id FROM gc_channels WHERE server_id = ?)) " +
      "AND " + guard.sql,
    [serverId, ...guard.params]);
  push("welcomeCardViews",
    "DELETE FROM gc_welcome_card_views WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  push("welcomeCards",
    "DELETE FROM gc_welcome_cards WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  push("reactionTagOpts",
    "DELETE FROM gc_reaction_tag_opts WHERE tag_id IN (SELECT id FROM gc_server_reaction_tags WHERE server_id = ?) " +
      "AND " + guard.sql,
    [serverId, ...guard.params]);
  push("reactionTags",
    "DELETE FROM gc_server_reaction_tags WHERE server_id = ? AND " + guard.sql,
    [serverId, ...guard.params]);
  push("servers",
    "DELETE FROM gc_servers WHERE id = ? AND " + OWNER_EXISTS_SQL,
    [serverId, ...guard.params]);

  if (iconMediaId !== null) {
    push("iconAttachmentChunks",
      "DELETE FROM gc_attachment_chunks WHERE attachment_id = ? " +
        "AND NOT EXISTS (SELECT 1 FROM gc_servers WHERE icon_media_id = ?)",
      [iconMediaId, iconMediaId]);
    push("iconAttachments",
      "DELETE FROM gc_attachments WHERE id = ? AND message_id IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM gc_servers WHERE icon_media_id = ?)",
      [iconMediaId, iconMediaId]);
  }

  const results = await env.GOOBER_DB.batch(
    statements.map((statement) => env.GOOBER_DB.prepare(statement.sql).bind(...statement.binds)),
  );
  const deleted = {};
  statements.forEach((statement, index) => {
    // Chunked statements share their key — the tally sums the chunks.
    const changes = Number(results[index]?.meta?.changes) || 0;
    deleted[statement.key] = (deleted[statement.key] ?? 0) + changes;
  });

  if (deleted.servers !== 1) {
    // Same diagnostics discipline as the channel DELETE — the verdict rides
    // the ONE guarded server-row statement; a caller WITH the authority hit
    // an unknown server → 404, everyone else gets the shared 403 (never an
    // existence oracle), and the pre-clean statements stripped NOTHING.
    const membership = await env.GOOBER_DB.prepare(
      "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, userId).first();

    if (membership && membership.role === "owner") {
      throw new HttpError(404, "That server does not exist.");
    }

    throw new HttpError(403, "You do not have permission to do that.");
  }

  // The bucket follows the D1 verdict: the doomed-ids pre-read IS the purge
  // list (the dead `doomedAttachmentIds` list wired, no second attachment
  // read), swept MINUS the post-batch survivors — an attachment still
  // referenced by a cross-server expression row or still pointed at by
  // another server's icon keeps its bytes (the NOT EXISTS survivor law, the
  // same honesty the sibling arms post-batch). The survivor read failing is
  // diagnosed best-effort and skips ONLY the ride, never the verdict.
  try {
    const survivors = new Set();
    if (expressionAttachmentIds.length > 0) {
      // Per-table chunked reads (the bind budget): the old one-statement
      // UNION bound its id list 3x — 1074 binds at the full-cap ceiling, past
      // D1's 100 per query. Each chunked statement binds its chunk once.
      const survivorTables = [
        "SELECT attachment_id FROM gc_emoji WHERE attachment_id IN (",
        "SELECT attachment_id FROM gc_stickers WHERE attachment_id IN (",
        "SELECT attachment_id FROM gc_sounds WHERE attachment_id IN (",
      ];
      for (let start = 0; start < expressionAttachmentIds.length; start += PINS_READ_BIND_CHUNK) {
        const chunk = expressionAttachmentIds.slice(start, start + PINS_READ_BIND_CHUNK);
        const idList = chunk.map(() => "?").join(", ");
        const chunksResults = [];
        for (const head of survivorTables) {
          const tableRows = ((await env.GOOBER_DB.prepare(
            head + idList + ")",
          ).bind(...chunk).all()).results) || [];
          chunksResults.push(...tableRows);
        }
        for (const row of chunksResults) survivors.add(Number(row.attachment_id));
      }
    }
    if (iconMediaId !== null) {
      const iconSurvivorRows = ((await env.GOOBER_DB.prepare(
        "SELECT icon_media_id FROM gc_servers WHERE icon_media_id = ?",
      ).bind(iconMediaId).all()).results) || [];
      if (iconSurvivorRows.length > 0) survivors.add(iconMediaId);
    }
    for (const attachmentId of doomedAttachmentIds) {
      if (!survivors.has(attachmentId)) {
        scheduleAttachmentObjectDelete(env, ctx, attachmentId);
      }
    }
  } catch (error) {
    // The ride itself is best-effort — but never silent (the module's error
    // law): the lost sweep surfaces for the desk, and the response completes
    // with only the ride skipped, never the verdict.
    console.error("Attachment object sweep read failed — the R2 ride is skipped:", errorName(error), {
      serverId: Number(serverId),
    });
  }

  return json({ ok: true, deleted });
}

// The family's own dispatch (the arms moved VERBATIM from api/servers.mjs's
// router — the router forwards here, and the returned undefined is the
// module's fall-through, never a route).
//
// The owner fragment's local mirror rides the family (the sibling-lane
// idiom).


export async function handleServerLeaveRoutes(request, env, path, method, ctx) {
  // The one-act delete (the shaver): owner-only, guarded one-batch teardown.
  const serverDeleteMatch = (method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)$/)
    : null;
  if (serverDeleteMatch) {
    return handleDeleteServerRoute(request, env, Number(serverDeleteMatch[1]), ctx);
  }

  // Wave 8 (T-PARITY-LEAVE): the member exit + the owner handover, beside the
  // server-wide mutations they mirror.
  const leaveMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/leave$/)
    : null;
  if (leaveMatch) {
    return handleLeaveServerRoute(request, env, Number(leaveMatch[1]));
  }

  const transferMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/transfer-ownership$/)
    : null;
  if (transferMatch) {
    return handleTransferOwnershipRoute(request, env, Number(transferMatch[1]));
  }
  return undefined;
}
