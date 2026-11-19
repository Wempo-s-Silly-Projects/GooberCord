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

// GooberCord's channel + category + overwrite routes (T-R25-SPLIT-SERVERS-2:
// the wave-25's second family off api/servers.mjs — moved VERBATIM: the
// create's role-aware guarded INSERTs, the PATCH/delete with the R2 purge
// ride, the 0007 categories, and the named-bit overwrites). The shared
// read helpers (readActorContext/viewerPayload/rolePayload/ROLE_LIST_SQL)
// stay ONE implementation in api/servers.mjs, imported here (call-time use —
// the module-scope fragments stay local so the circular import stays inert);
// the guard fragments keep the sibling-lane local-mirror idiom.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import { GC_CATEGORIES_MAX_PER_SERVER, MAX_CHANNELS_PER_SERVER } from "../constants.mjs";
import {
  holdsRolesBitsParams,
  holdsRolesBitsSql,
  OVERWRITE_BITS,
  permissionNames,
  SERVER_PERMISSIONS,
  SLOWMODE_CHOICES,
} from "./permissions.mjs";
import { scheduleAttachmentObjectDelete } from "./media.mjs";
import {
  CHANNEL_NAME_MAX,
  readActorContext,
  ROLE_LIST_SQL,
  ROLE_NAME_MAX,
  rolePayload,
  viewerPayload,
} from "./servers.mjs";

// The manage-guard fragments mirror the sibling lanes' exact copies (invite,
// soundboard, soundpacks keep them local by the same design note; a guard
// change must be re-mirrored and the parity tests pin the copies' behavior).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// The member's strongest role position (-1 when roleless — the hierarchy
// sentinel the category routes' strictly-lower rules compare against).
const TOP_POSITION_SELECT =
  "(SELECT COALESCE(MAX(hr.position), -1) FROM gc_member_roles hmr " +
    "JOIN gc_roles hr ON hr.id = hmr.role_id " +
    "WHERE hmr.server_id = ? AND hmr.user_id = ?)";

// --- channel create (role-aware, still under the per-server cap) --------------

// The whole authorization + cap check in one statement. Zero changes means
// either "no Manages-Channels anywhere on the caller" (string tier owner /
// moderator, or the gc_roles MANAGE_CHANNELS bit) or "the server is at the
// channel cap" — only then is one diagnostic read made, purely to pick the
// 403 vs the 400. The two INSERT shapes (bare, and the phase-3 variant with
// category_id + slowmode_seconds) share the identical WHERE, so the extended
// fields can only ever ride an already-authorized create.
const CAP_CHANNEL_INSERT_SQL =
  "INSERT INTO gc_channels (id, server_id, name, kind, position, created_at) " +
    "SELECT ?, ?, ?, ?, " +
    "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_channels WHERE server_id = ?), ? " +
    "WHERE (EXISTS (" +
      "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? " +
      "AND role IN ('owner','moderator')" +
    ") OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ") " +
    "AND (SELECT COUNT(*) FROM gc_channels WHERE server_id = ?) <= " +
    (MAX_CHANNELS_PER_SERVER - 1);

const LAYERED_CHANNEL_INSERT_SQL =
  "INSERT INTO gc_channels (id, server_id, name, kind, position, created_at, category_id, slowmode_seconds) " +
    "SELECT ?, ?, ?, ?, " +
    "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_channels WHERE server_id = ?), ?, ?, ? " +
    "WHERE (EXISTS (" +
      "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? " +
      "AND role IN ('owner','moderator')" +
    ") OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ") " +
    "AND (SELECT COUNT(*) FROM gc_channels WHERE server_id = ?) <= " +
    (MAX_CHANNELS_PER_SERVER - 1) +
    // A category_id must resolve INSIDE this server (the NULL move through is
    // always free).
    " AND (? IS NULL OR EXISTS (" +
      "SELECT 1 FROM gc_channel_categories WHERE id = ? AND server_id = ?))";

// The PRIVATE-CHANNEL toggle (the filed how-to's creation shortcut — the UI
// affordance over the layer, no new schema): one @everyone deny-VIEW row plus
// one allow-VIEW row per gc_role. BOTH rows ride the CREATE's own batch, bound
// the create's PRE-READ literal id — the servers.mjs discipline (no id is ever
// derived INSIDE a batch; the same 0005/0055 stale-rowid lesson that forced
// the compensated server create, live-verified e0bb49c): last_insert_rowid()
// never rides a batch statement and a last_row_id can only be read AFTER the
// batch answers. A changes-0 create never aborts a D1 batch — zero rows is
// not an error — so BOTH overwrite rows ride a channel-EXISTS no-op arm: on a
// refused create the pair no-ops in-batch (no FOREIGN KEY constraint failure
// against the absent id, which would 500 the refusal) and the 403/400
// classification answers off stmt[0]'s changes verdict. The private channel
// plus its overwrites still commits atomically: a successful create can never
// finish without the pair riding the same transaction.
// Concurrency note: two simultaneous creates can pre-read the same max+1 —
// the loser's UNIQUE(id) failure rolls the whole batch back clean and the
// client retries (note-only at this traffic, no retry logic).
const NEXT_CHANNEL_ID_SQL =
  "SELECT COALESCE(MAX(id), 0) + 1 AS next_channel_id FROM gc_channels";
const PRIVATE_EVERYONE_DENY_SQL =
  "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
    "SELECT ?, NULL, 0, ? WHERE EXISTS (SELECT 1 FROM gc_channels WHERE id = ? AND server_id = ?)";
const PRIVATE_ROLE_ALLOWS_SQL =
  "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
    "SELECT ?, id, ?, 0 FROM gc_roles WHERE server_id = ? " +
    "AND EXISTS (SELECT 1 FROM gc_channels WHERE id = ? AND server_id = ?)";

function slowmodeFrom(value) {
  if (value === undefined || value === null) return 0;
  const seconds = Number(value);
  if (!SLOWMODE_CHOICES.includes(seconds)) {
    throw new HttpError(
      400,
      "slowmode_seconds must be one of " + SLOWMODE_CHOICES.join(", ") + ".",
    );
  }
  return seconds;
}

function categoryIdFrom(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "category_id must be a category id or null.");
  }
  return value;
}

async function handleCreateChannelRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const body = await readJson(request);

  if (body.kind !== "text" && body.kind !== "voice") {
    throw new HttpError(400, "Channel kind must be either text or voice.");
  }

  const name = requiredText(body.name, "channel name", CHANNEL_NAME_MAX);
  const userId = Number(session.user.id);
  const now = nowSeconds();
  const manageBits = SERVER_PERMISSIONS.MANAGE_CHANNELS;
  // The phase-3 fields, each validated BEFORE any statement runs (a private
  // channel is a bare create plus its overwrite rows in the same batch).
  const slowmode = slowmodeFrom(body.slowmode_seconds);
  const categoryId = categoryIdFrom(body.category_id);
  if (body.private !== undefined && body.private !== true && body.private !== false) {
    throw new HttpError(400, "private must be true or false.");
  }
  const privateChannel = body.private === true;
  const layered = categoryId !== null || slowmode !== 0;

  // The create's id, PRE-READ (the servers.mjs discipline: no id is ever
  // derived INSIDE a batch) — the literal that binds the channel row AND,
  // for a private create, its overwrite pair's channel_id.
  const nextIdRow = await env.GOOBER_DB.prepare(NEXT_CHANNEL_ID_SQL).first();
  const channelId = Number(nextIdRow?.next_channel_id);
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    throw new HttpError(500, "The channel could not be created. Please try again.");
  }

  // ONE batch: the guarded channel row, then — only for a private create —
  // its overwrite pair, bound the SAME literal id and gated on the channel's
  // EXISTS. A refused create (stmt[0] zero changes) never aborts a D1 batch,
  // so the pair no-ops itself against the absent id in-batch and the 403/400
  // taxonomy answers off stmt[0]'s changes verdict — never a 500.
  const createStatements = [
    env.GOOBER_DB.prepare(
      layered ? LAYERED_CHANNEL_INSERT_SQL : CAP_CHANNEL_INSERT_SQL,
    ).bind(
      channelId, serverId, name, body.kind, serverId, now,
      ...(layered
        ? [categoryId !== null ? categoryId : null, slowmode]
        : []),
      // The owner/moderator tier pair, then the per-bit EXISTS pair.
      serverId, userId, serverId, userId,
      serverId,
      ...(layered
        ? [categoryId !== null ? categoryId : null, categoryId !== null ? categoryId : null, serverId]
        : []),
    ),
  ];
  if (privateChannel) {
    createStatements.push(
      env.GOOBER_DB.prepare(PRIVATE_EVERYONE_DENY_SQL)
        .bind(channelId, SERVER_PERMISSIONS.VIEW, channelId, serverId),
      env.GOOBER_DB.prepare(PRIVATE_ROLE_ALLOWS_SQL)
        .bind(channelId, SERVER_PERMISSIONS.VIEW, serverId, channelId, serverId),
    );
  }
  const results = await env.GOOBER_DB.batch(createStatements);

  if (Number(results[0]?.meta?.changes) !== 1) {
    // Diagnostic only: authority already rode the guarded INSERT. A member
    // with channel-managing authority anywhere (string tier or the role bit)
    // sees the cap message, everyone else — including non-members, so no
    // server-existence oracle — sees the permission message.
    const membership = await env.GOOBER_DB.prepare(
      "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, userId).first();

    if (membership) {
      const tierAuthority = membership.role === "owner" || membership.role === "moderator";
      let roleAuthority = false;
      if (!tierAuthority) {
        // The roles half of the same question: only asked for a plain-tier
        // member (an owner/moderator row already answers it). The RBAC-audit
        // H1 per-bit EXISTS — no SUM carry.
        const allowed = await env.GOOBER_DB.prepare(
          "SELECT 1 AS allowed FROM gc_server_members m " +
            "WHERE m.server_id = ? AND m.user_id = ? AND " +
            holdsRolesBitsSql(manageBits) + " LIMIT 1",
        ).bind(serverId, userId, serverId, userId).first();
        roleAuthority = allowed !== null;
      }
      if (tierAuthority || roleAuthority) {
        throw new HttpError(400, "That server has reached its channel limit.");
      }
    }

    throw new HttpError(403, "You do not have permission to do that.");
  }

  // The channel id is the pre-read literal already — no last_row_id re-derivation.
  const channel = await env.GOOBER_DB.prepare(
    "SELECT id, name, kind, position FROM gc_channels WHERE id = ? AND server_id = ? LIMIT 1",
  ).bind(channelId, serverId).first();

  // The layered fields ride the response only when a layered create sent
  // them — a bare create answers exactly the pre-0007 shape (one read, and
  // never a new SQL shape for the plain path).
  let layeredFields = {};
  if (slowmode !== 0 || categoryId !== null) {
    const extra = await env.GOOBER_DB.prepare(
      "SELECT category_id, slowmode_seconds FROM gc_channels WHERE id = ? LIMIT 1",
    ).bind(channelId).first();
    layeredFields = {
      ...(categoryId !== null ? { categoryId: categoryIdFrom(extra?.category_id) } : {}),
      ...(slowmode !== 0 ? { slowmodeSeconds: slowmodeFrom(extra?.slowmode_seconds) } : {}),
      ...(privateChannel ? { private: true } : {}),
    };
  } else if (privateChannel) {
    layeredFields = { private: true };
  }

  return json({
    channel: {
      id: channelId,
      name: channel.name,
      kind: channel.kind,
      position: Number(channel.position),
      ...layeredFields,
    },
  }, 201);
}


// --- channel PATCH: spoiler flag, slowmode, category move (GC-OWNED) ----------

async function handleUpdateChannelRoute(request, env, serverId, channelId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);

  // Each PATCH field block only sets its own flag, so a successor field rides
  // by adding one block + one SET clause. All validation happens at collection
  // time, before any statement can run.
  const nameField = { present: false, value: null };
  const spoilerField = { present: false, value: 0 };
  const slowmodeField = { present: false, value: 0 };
  const categoryField = { present: false, value: null };

  if (body.name !== undefined) {
    // The same rule the create route plus the schema CHECK set (1..100 after
    // trim): requiredText is the server truth, the DB never re-judges.
    nameField.present = true;
    nameField.value = requiredText(body.name, "channel name", CHANNEL_NAME_MAX);
  }
  if (body.is_spoiler !== undefined) {
    if (body.is_spoiler !== true && body.is_spoiler !== false) {
      throw new HttpError(400, "is_spoiler must be true or false.");
    }
    spoilerField.present = true;
    spoilerField.value = body.is_spoiler ? 1 : 0;
  }
  if (body.slowmode_seconds !== undefined) {
    slowmodeField.present = true;
    slowmodeField.value = slowmodeFrom(body.slowmode_seconds);
  }
  if (body.category_id !== undefined) {
    categoryField.present = true;
    categoryField.value = categoryIdFrom(body.category_id);
  }

  if (!nameField.present && !spoilerField.present && !slowmodeField.present && !categoryField.present) {
    throw new HttpError(
      400,
      "Nothing to change. Send a name, a spoiler flag, a slowmode_seconds, or a category_id.",
    );
  }

  const setClauses = [];
  const setBinds = [];
  if (nameField.present) {
    setClauses.push("name = ?");
    setBinds.push(nameField.value);
  }
  if (spoilerField.present) {
    setClauses.push("is_spoiler = ?");
    setBinds.push(spoilerField.value);
  }
  if (slowmodeField.present) {
    setClauses.push("slowmode_seconds = ?");
    setBinds.push(slowmodeField.value);
  }
  if (categoryField.present) {
    setClauses.push("category_id = ?");
    setBinds.push(categoryField.value);
  }

  // The empty-category clean-up needs the channel's category BEFORE the move
  // (a plain diagnostic read — the UPDATE's own guard still carries all the
  // authority).
  let sourceCategoryId = null;
  if (categoryField.present) {
    const previous = await env.GOOBER_DB.prepare(
      "SELECT category_id FROM gc_channels WHERE id = ? AND server_id = ? LIMIT 1",
    ).bind(channelId, serverId).first();
    if (previous && previous.category_id !== null && previous.category_id !== undefined) {
      sourceCategoryId = Number(previous.category_id);
    }
  }

  // The channel fields' authority rides the UPDATE (owner OR MANAGE_CHANNELS);
  // the server_id IS NOT NULL rider excludes the dm/group channels that are
  // not server channels at all. A category MOVE carries its own rider: the
  // target category must resolve inside this same server.
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_channels SET " + setClauses.join(", ") +
      " WHERE id = ? AND server_id = ? AND server_id IS NOT NULL AND (" +
        OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ")" +
      (categoryField.present && categoryField.value !== null
        ? " AND EXISTS (SELECT 1 FROM gc_channel_categories WHERE id = ? AND server_id = ?)"
        : ""),
  ).bind(
    ...setBinds, channelId, serverId,
    serverId, userId, serverId, userId,
    ...(categoryField.present && categoryField.value !== null
      ? [categoryField.value, serverId]
      : []),
  ).run();

  if (Number(result.meta?.changes) !== 1) {
    // Diagnostic only: a caller with channel authority hit an unknown (or
    // non-server) channel → 404; everyone else gets the shared 403.
    const membership = await env.GOOBER_DB.prepare(
      "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, userId).first();

    let authoritative = membership && (membership.role === "owner" || membership.role === "moderator");
    if (membership && !authoritative) {
      const perms = await env.GOOBER_DB.prepare(
        "SELECT 1 AS allowed FROM gc_servers s WHERE s.id = ? AND (" +
          OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) +
          ") LIMIT 1",
      ).bind(serverId, userId, serverId, userId).first();
      authoritative = perms !== null;
    }

    if (authoritative) {
      throw new HttpError(404, "That channel does not exist.");
    }

    throw new HttpError(403, "You do not have permission to do that.");
  }

  // The EMPTY-CATEGORY auto-delete (Discord's "folder empty → deleted" rule):
  // one guarded DELETE removes the category the channel LEFT, and only when
  // no channel references it anymore (the UPDATE re-pointed the channel, so
  // its old folder may now be empty — the DELETE's own NOT EXISTS decides).
  if (categoryField.present) {
    const sourceId = sourceCategoryId;
    if (sourceId !== null && sourceId !== categoryField.value) {
      await env.GOOBER_DB.prepare(
        "DELETE FROM gc_channel_categories WHERE id = ? AND server_id = ? " +
          "AND NOT EXISTS (SELECT 1 FROM gc_channels WHERE category_id = gc_channel_categories.id)",
      ).bind(sourceId, serverId).run();
    }
  }

  return json(
    {
      channel: {
        id: channelId,
        serverId,
        // Each field's echo rides ONLY when that field was sent (the plain
        // spoiler PATCH keeps the exact pre-0007 response shape).
        ...(nameField.present ? { name: nameField.value } : {}),
        ...(spoilerField.present ? { isSpoiler: spoilerField.value === 1 } : {}),
        ...(slowmodeField.present ? { slowmodeSeconds: slowmodeField.value } : {}),
        ...(categoryField.present ? { categoryId: categoryField.value } : {}),
      },
    },
    200,
  );
}

// --- channel DELETE: the audit's servers POST-only gap (SHAVERS 1) ---------------

// The SAME tier guard every statement of the delete batch carries — the
// discipline the message DELETE set (an unauthorized caller must strip
// NOTHING even in a pre-cleanup statement), expressed in this module's shapes
// (string-tier owner OR the MANAGE_CHANNELS per-bit EXISTS; binds in fragment
// order OWNER(serverId, actorId) bits(serverId, actorId)).
function channelManageGuard(serverId, actorId) {
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ")",
    params: [serverId, actorId, ...holdsRolesBitsParams(
      serverId,
      actorId,
      SERVER_PERMISSIONS.MANAGE_CHANNELS,
    )],
  };
}

async function handleDeleteChannelRoute(request, env, serverId, channelId, ctx) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The channel's category BEFORE the delete rides the same diagnostics read
  // the PATCH's move uses, so an emptied folder can follow its channel out
  // (the SAME guarded NOT EXISTS rule the move applies — only where a channel
  // LEFT; the DELETE's own changes verdict is still the whole authority).
  const previous = await env.GOOBER_DB.prepare(
    "SELECT category_id FROM gc_channels WHERE id = ? AND server_id = ? LIMIT 1",
  ).bind(channelId, serverId).first();
  const sourceCategoryId = previous && previous.category_id !== null && previous.category_id !== undefined
    ? Number(previous.category_id)
    : null;

  // ONE batch, all-or-nothing, EVERY statement carrying the SAME guard:
  //   1–2. the attachment pre-clean (gc_attachments.message_id carries no ON
  //        DELETE action — chunks → attachments LAST-to-channel, the exact
  //        ordering the message DELETE mirrors, so the channel's implicit
  //        message CASCADE never meets a live attachment row);
  //   3. the doomed bookmarks' sweep (gc_bookmarks carries NO message FK —
  //        migration 0053's shape is bare; the orphan pointers die behind the
  //        same guard);
  //   4. the guarded channel DELETE itself — whose cascades take the messages,
  //      read states, overwrites, filter alerts, and conversation members.
  const guard = channelManageGuard(serverId, userId);
  // The object purge list's pre-read (the servers.mjs discipline: no id is
  // ever derived INSIDE a batch) — the doomed attachments the pre-clean
  // statements below will kill.
  const doomedRows = (await env.GOOBER_DB.prepare(
    "SELECT id FROM gc_attachments WHERE message_id IN (SELECT id FROM gc_messages WHERE channel_id = ?)",
  ).bind(channelId).all()).results || [];
  const doomedAttachmentIds = doomedRows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachment_chunks WHERE attachment_id IN " +
        "(SELECT a.id FROM gc_attachments a WHERE a.message_id IN " +
          "(SELECT id FROM gc_messages WHERE channel_id = ?)) AND " + guard.sql,
    ).bind(channelId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachments WHERE message_id IN " +
        "(SELECT id FROM gc_messages WHERE channel_id = ?) AND " + guard.sql,
    ).bind(channelId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_bookmarks WHERE message_id IN " +
        "(SELECT id FROM gc_messages WHERE channel_id = ?) AND " + guard.sql,
    ).bind(channelId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_channels WHERE id = ? AND server_id = ? AND server_id IS NOT NULL AND " + guard.sql,
    ).bind(channelId, serverId, ...guard.params),
  ]);
  if (Number(results[3]?.meta?.changes) !== 1) {
    // Same diagnostics discipline as the PATCH: a caller WITH channel
    // authority hit an unknown (or non-server) channel → 404; everyone else
    // gets the shared 403 (never an existence oracle).
    const membership = await env.GOOBER_DB.prepare(
      "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, userId).first();

    let authoritative = membership && (membership.role === "owner" || membership.role === "moderator");
    if (membership && !authoritative) {
      const perms = await env.GOOBER_DB.prepare(
        "SELECT 1 AS allowed FROM gc_servers s WHERE s.id = ? AND (" +
          OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) +
          ") LIMIT 1",
      ).bind(serverId, userId, serverId, userId).first();
      authoritative = perms !== null;
    }

    if (authoritative) {
      throw new HttpError(404, "That channel does not exist.");
    }

    throw new HttpError(403, "You do not have permission to do that.");
  }

  // The bucket rides the D1 verdict BEFORE anything else that can await and
  // throw past the batch: a category-cleanup failure below must never strand
  // already-purged objects (the row deletion committed; the ride stays
  // best-effort — scheduleAttachmentObjectDelete catches its own errors —
  // through the caller's waitUntil).
  for (const attachmentId of doomedAttachmentIds) {
    scheduleAttachmentObjectDelete(env, ctx, attachmentId);
  }

  // The emptied-folder cleanup (only where the deleted channel LEFT a folder):
  // the identical guarded NOT EXISTS delete the category move runs.
  if (sourceCategoryId !== null) {
    await env.GOOBER_DB.prepare(
      "DELETE FROM gc_channel_categories WHERE id = ? AND server_id = ? " +
        "AND NOT EXISTS (SELECT 1 FROM gc_channels WHERE category_id = gc_channel_categories.id)",
    ).bind(sourceCategoryId, serverId).run();
  }

  return json({ ok: true });
}


// --- phase-3 channel categories (0007) + the overwrite routes --------------------
//
// Categories are the filed folder layer: owner-OR-MANAGE_CHANNELS to manage,
// membership to read. The empty-category rule is NOT a sweeping background
// reclaim — it fires only where a channel MOVED (the PATCH's guarded clean-up
// above), so a deliberately-created empty category survives until its channel
// leaves some other folder.

function categoryPayload(row) {
  return {
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: row.name,
    position: Number(row.position),
  };
}

const CATEGORY_SELECT_SQL =
  "SELECT id, server_id, name, position FROM gc_channel_categories " +
    "WHERE id = ? AND server_id = ? LIMIT 1";

async function handleCreateCategoryRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const body = await readJson(request);
  const name = requiredText(body.name, "category name", ROLE_NAME_MAX);
  const userId = Number(session.user.id);

  // Position appends after the current max INSIDE the statement (never a
  // client-roundtripped number); the authority + the parity-law category cap
  // (docs/parity-limits.md: Categories per server 50, verified 2026-11-17)
  // both ride the INSERT ... SELECT. Zero changes means "no
  // MANAGE_CHANNELS authority anywhere on the caller" OR "the server is at
  // the category cap" — only then is one diagnostic read made, purely to
  // pick the 403 vs the 400 (the channel create's exact diagnostic shape).
  const CATEGORY_INSERT_SQL =
    "INSERT INTO gc_channel_categories (server_id, name, position, created_at) " +
      "SELECT ?, ?, " +
      "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_channel_categories WHERE server_id = ?), ? " +
      "WHERE (" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ") " +
      "AND (SELECT COUNT(*) FROM gc_channel_categories WHERE server_id = ?) <= " +
      (GC_CATEGORIES_MAX_PER_SERVER - 1);

  const result = await env.GOOBER_DB.prepare(CATEGORY_INSERT_SQL)
    .bind(
      serverId, name, serverId, nowSeconds(),
      serverId, userId, serverId, userId,
      serverId,
    ).run();

  if (Number(result.meta?.changes) !== 1) {
    // Diagnostic only: authority already rode the guarded INSERT — the same
    // classification the channel create makes (authority sees the cap
    // message, everyone else the permission message, so no server-existence
    // oracle).
    const membership = await env.GOOBER_DB.prepare(
      "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, userId).first();

    if (membership) {
      const tierAuthority = membership.role === "owner" || membership.role === "moderator";
      let roleAuthority = false;
      if (!tierAuthority) {
        const perms = await env.GOOBER_DB.prepare(
          "SELECT 1 AS allowed FROM gc_servers s WHERE s.id = ? AND (" +
            OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) +
            ") LIMIT 1",
        ).bind(serverId, userId, serverId, userId).first();
        roleAuthority = perms !== null;
      }
      if (tierAuthority || roleAuthority) {
        throw new HttpError(400, "That server has reached its category limit.");
      }
    }

    throw new HttpError(403, "You do not have permission to do that.");
  }

  const category = await env.GOOBER_DB.prepare(CATEGORY_SELECT_SQL)
    .bind(Number(result.meta.last_row_id), serverId).first();
  return json({ category: category ? categoryPayload(category) : null }, 201);
}

async function handleListCategoriesRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  const viewerId = Number(session.user.id);
  await rateLimit(request, env, "read", "categories:" + serverId + ":" + viewerId);

  const viewer = await readActorContext(env, serverId, viewerId);
  if (!viewer) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const { results } = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, position FROM gc_channel_categories " +
      "WHERE server_id = ? ORDER BY position, id",
  ).bind(serverId).all();

  return json(
    { categories: (results || []).map(categoryPayload), viewer: viewerPayload(viewer) },
    200,
  );
}

async function handleUpdateCategoryRoute(request, env, serverId, categoryId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const actor = await readActorContext(env, serverId, userId);
  if (!actor) throw new HttpError(403, "You do not have permission to do that.");

  const category = await env.GOOBER_DB.prepare(CATEGORY_SELECT_SQL)
    .bind(categoryId, serverId).first();
  if (!category) throw new HttpError(404, "That category does not exist.");

  const nameField = { present: false, value: null };
  let targetPosition = null;
  if (body.name !== undefined) {
    nameField.present = true;
    nameField.value = requiredText(body.name, "category name", ROLE_NAME_MAX);
  }
  if (body.position !== undefined) {
    if (!Number.isSafeInteger(body.position) || body.position < 0) {
      throw new HttpError(400, "position must be a non-negative integer.");
    }
    targetPosition = body.position;
  }
  if (!nameField.present && targetPosition === null) {
    throw new HttpError(400, "Nothing to change. Send a name or a position.");
  }

  if (targetPosition !== null) {
    // Moving to an occupied slot is a SWAP (batched), a free slot is a plain
    // move — the same guard on both statements.
    const maxRow = await env.GOOBER_DB.prepare(
      "SELECT COALESCE(MAX(position), -1) AS max_position FROM gc_channel_categories WHERE server_id = ?",
    ).bind(serverId).first();
    const maxPosition = Number(maxRow?.max_position ?? -1);
    if (targetPosition > maxPosition) {
      throw new HttpError(400, "position must be between 0 and " + maxPosition + ".");
    }
    const partner = targetPosition === Number(category.position)
      ? null
      : await env.GOOBER_DB.prepare(
          "SELECT id FROM gc_channel_categories WHERE server_id = ? AND position = ? AND id <> ? LIMIT 1",
        ).bind(serverId, targetPosition, categoryId).first();

    const CATEGORY_MOVE_UPDATE_SQL =
      "UPDATE gc_channel_categories SET position = ? WHERE id = ? AND server_id = ? AND position = ? AND (" +
        OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ")";
    const statements = [
      env.GOOBER_DB.prepare(CATEGORY_MOVE_UPDATE_SQL).bind(
        targetPosition, categoryId, serverId, Number(category.position),
        serverId, userId, serverId, userId,
      ),
    ];
    if (partner) {
      statements.push(
        env.GOOBER_DB.prepare(CATEGORY_MOVE_UPDATE_SQL).bind(
          Number(category.position), Number(partner.id), serverId, targetPosition,
          serverId, userId, serverId, userId,
        ),
      );
    }
    const results = await env.GOOBER_DB.batch(statements);
    if (Number(results[0]?.meta?.changes) !== 1) {
      throw new HttpError(403, "You do not have permission to do that.");
    }
  } else {
    const result = await env.GOOBER_DB.prepare(
      "UPDATE gc_channel_categories SET name = ? WHERE id = ? AND server_id = ? AND (" +
        OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ")",
    ).bind(
      nameField.value, categoryId, serverId,
      serverId, userId, serverId, userId,
    ).run();
    if (Number(result.meta?.changes) !== 1) {
      throw new HttpError(403, "You do not have permission to do that.");
    }
  }

  const updated = await env.GOOBER_DB.prepare(CATEGORY_SELECT_SQL)
    .bind(categoryId, serverId).first();
  return json({ category: updated ? categoryPayload(updated) : null }, 200);
}

async function handleDeleteCategoryRoute(request, env, serverId, categoryId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // ONE guarded DELETE: the channels UN-FILE via the FK's ON DELETE SET NULL,
  // the category's own overwrite rows cascade away. zero changes → the shared
  // 403 (non-members and unknown categories alike).
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_channel_categories WHERE id = ? AND server_id = ? AND (" +
      OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ")",
  ).bind(
    categoryId, serverId,
    serverId, userId, serverId, userId,
  ).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ deleted: true, categoryId }, 200);
}

// --- overwrites (PUT/DELETE /channels/:cid/overwrites/{everyone|:role_id}) --------

// The named-bit wire form over an overwrite row (roster payload style).
function overwritePayload(row) {
  return {
    id: Number(row.id),
    channelId: Number(row.channel_id),
    roleId: row.role_id === null || row.role_id === undefined ? null : Number(row.role_id),
    allow: permissionNames(row.allow_mask),
    deny: permissionNames(row.deny_mask),
  };
}

// allow_mask/deny_mask arrive as arrays of named bits; anything outside the
// overwrite vocabulary (the channel-granted powers) 400s.
function overwriteMaskFrom(value, field) {
  const list = Array.isArray(value) ? value : [];
  return list.reduce((mask, name) => {
    const bit = SERVER_PERMISSIONS[name];
    if (!bit || !OVERWRITE_BITS.includes(bit)) {
      throw new HttpError(400, "Unknown " + field + " permission: " + String(name));
    }
    return mask | bit;
  }, 0);
}

// overwriteGuard(serverId, userId, channelId, roleId): the FULL guard both
// overwrite writes share. The authority is owner OR any MANAGE_CHANNELS
// holder, plus the role-targeted OR-arm — the MANAGE_ROLES holder may edit
// overwrites for a role strictly below their top position (the role editor's
// rule, re-asserted inside the statement). The channel rider pins the channel
// to this server as a text/voice channel; the role rider pins the role to
// this server.
function overwriteGuardSql(serverId, userId, channelId, roleId) {
  const sql =
    "EXISTS (SELECT 1 FROM gc_channels gc WHERE gc.id = ? AND gc.server_id = ? " +
      "AND gc.kind IN ('text','voice'))" +
    (roleId !== null
      ? " AND EXISTS (SELECT 1 FROM gc_roles gr WHERE gr.id = ? AND gr.server_id = ?)"
      : "") +
    " AND (" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) +
      (roleId !== null
        ? " OR (" + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_ROLES) + " AND " +
          "(SELECT position FROM gc_roles WHERE id = ? AND server_id = ?) < " +
          TOP_POSITION_SELECT + ")"
        : "") +
    ")";
  const params = [
    channelId, serverId,
    ...(roleId !== null ? [roleId, serverId] : []),
    // the owner arm, then the MANAGE_CHANNELS per-bit EXISTS…
    ...holdsRolesBitsParams(serverId, userId, SERVER_PERMISSIONS.MANAGE_CHANNELS),
    // …then the MANAGE_ROLES + position arm (role-targeted rows only).
    ...(roleId !== null
      ? [...holdsRolesBitsParams(serverId, userId, SERVER_PERMISSIONS.MANAGE_ROLES), roleId, serverId, serverId, userId]
      : []),
  ];
  return { sql, params };
}

// PUT: the upsert is one batch of two FULLY-guarded statements — the DELETE
// (removing any existing row for this layer) and the INSERT ... SELECT. Both
// carry the identical WHERE, so a refused batch deletes nothing ahead of a
// refused insert; the INSERT's changes classify the outcome.
async function handlePutOverwriteRoute(request, env, serverId, channelId, roleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);

  const allowMask = overwriteMaskFrom(body.allow_mask, "allow");
  const denyMask = overwriteMaskFrom(body.deny_mask, "deny");
  if (allowMask === 0 && denyMask === 0) {
    throw new HttpError(
      400,
      "Nothing to set. Send allow_mask and/or deny_mask permission names.",
    );
  }

  const guard = overwriteGuardSql(serverId, userId, channelId, roleId);
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_channel_overwrites WHERE channel_id = ? AND role_id IS ? AND " + guard.sql,
    ).bind(channelId, roleId, ...guard.params),
    env.GOOBER_DB.prepare(
      "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
        "SELECT ?, ?, ?, ? WHERE " + guard.sql,
    ).bind(channelId, roleId, allowMask, denyMask, ...guard.params),
  ]);

  if (Number(results[1]?.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json(
    {
      overwrite: {
        channelId,
        roleId: roleId === null ? null : Number(roleId),
        allow: permissionNames(allowMask),
        deny: permissionNames(denyMask),
      },
    },
    201,
  );
}

async function handleDeleteOverwriteRoute(request, env, serverId, channelId, roleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  const guard = overwriteGuardSql(serverId, userId, channelId, roleId);
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_channel_overwrites WHERE channel_id = ? AND role_id IS ? AND " + guard.sql,
  ).bind(channelId, roleId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    // The shared 403 covers not-set (an inherit-with-no-row layer), refused
    // authority, unknown channels, and unknown roles alike — one answer, no
    // oracle between them.
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ deleted: true, channelId, roleId: roleId === null ? null : Number(roleId) }, 200);
}

// GET: the channel settings editor's data — the channel's own overwrite rows
// (named bits) beside the roles list and the viewer block, roster style.
async function handleListOverwritesRoute(request, env, serverId, channelId) {
  const session = await requireSignedInRead(request, env);
  const viewerId = Number(session.user.id);
  await rateLimit(request, env, "read", "overwrites:" + serverId + ":" + viewerId);

  const viewer = await readActorContext(env, serverId, viewerId);
  if (!viewer) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const channel = await env.GOOBER_DB.prepare(
    "SELECT id, server_id FROM gc_channels WHERE id = ? AND server_id = ? AND server_id IS NOT NULL LIMIT 1",
  ).bind(channelId, serverId).first();
  if (!channel) throw new HttpError(404, "That channel does not exist.");

  const rows = (await env.GOOBER_DB.prepare(
    "SELECT id, channel_id, role_id, allow_mask, deny_mask FROM gc_channel_overwrites " +
      "WHERE channel_id = ? ORDER BY id",
  ).bind(channelId).all()).results || [];
  const roles = (await env.GOOBER_DB.prepare(ROLE_LIST_SQL).bind(serverId).all()).results || [];

  return json(
    {
      channel: { id: Number(channel.id), serverId },
      overwrites: rows.map(overwritePayload),
      roles: (roles || []).map(rolePayload),
      viewer: viewerPayload(viewer),
    },
    200,
  );
}


// The family's own dispatch (the arms moved VERBATIM from api/servers.mjs's
// router — the router forwards here, and the returned `undefined` is the
// module's fall-through, never a route). The ctx threads through (the channel
// delete purge rides the caller waitUntil).
export async function handleServerChannelsRoutes(request, env, url, path, method, ctx) {
  void url;

  const channelsMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/channels$/)
    : null;
  if (channelsMatch) {
    return handleCreateChannelRoute(request, env, Number(channelsMatch[1]));
  }

  const channelPatchMatch = (method === "PATCH" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/channels\/(0|[1-9][0-9]*)$/)
    : null;
  if (channelPatchMatch) {
    return method === "PATCH"
      ? handleUpdateChannelRoute(
          request, env, Number(channelPatchMatch[1]), Number(channelPatchMatch[2]),
        )
      : handleDeleteChannelRoute(
          request, env, Number(channelPatchMatch[1]), Number(channelPatchMatch[2]), ctx,
        );
  }

  const overwritesListMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/channels\/(0|[1-9][0-9]*)\/overwrites$/)
    : null;
  if (overwritesListMatch) {
    return handleListOverwritesRoute(
      request, env, Number(overwritesListMatch[1]), Number(overwritesListMatch[2]),
    );
  }

  const overwritesItemMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/channels\/(0|[1-9][0-9]*)\/overwrites\/(everyone|([1-9][0-9]*))$/)
    : null;
  if (overwritesItemMatch) {
    const roleId = overwritesItemMatch[4] === undefined
      ? null
      : Number(overwritesItemMatch[4]);
    return method === "PUT"
      ? handlePutOverwriteRoute(
          request, env, Number(overwritesItemMatch[1]), Number(overwritesItemMatch[2]), roleId,
        )
      : handleDeleteOverwriteRoute(
          request, env, Number(overwritesItemMatch[1]), Number(overwritesItemMatch[2]), roleId,
        );
  }

  // --- phase-3 channel categories (0007) --------------------------------------
  const categoriesMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/categories$/)
    : null;
  if (categoriesMatch) {
    return method === "GET"
      ? handleListCategoriesRoute(request, env, Number(categoriesMatch[1]))
      : handleCreateCategoryRoute(request, env, Number(categoriesMatch[1]));
  }

  const categoryItemMatch = (method === "PATCH" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/categories\/(0|[1-9][0-9]*)$/)
    : null;
  if (categoryItemMatch) {
    return method === "PATCH"
      ? handleUpdateCategoryRoute(
          request, env, Number(categoryItemMatch[1]), Number(categoryItemMatch[2]),
        )
      : handleDeleteCategoryRoute(
          request, env, Number(categoryItemMatch[1]), Number(categoryItemMatch[2]),
        );
  }


  return undefined;
}