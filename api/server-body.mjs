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

// T-R25-SPLIT-SERVERS-6: the server-body family's home (the wave-25 area-7
// seam, off the phase-1 monolith). The server's own body answers here — the
// compensated create (server row + owner membership + #general, all-or-
// nothing), the member list, and the PATCH settings write (name + icon).
// The owner's one-act DELETE does NOT ride this module: its single home is
// api/server-leave.mjs (the double-move was caught at this lane's rebase —
// the copy that briefly landed here was cut byte-equal, proven by the
// parity audit). The head arms are contiguous, with no interior interloper;
// the ONE forward below hands the body to the router with an 'undefined'
// fall-through — route order is semantically byte-unchanged, and every
// write's guards ride INSIDE the SQL exactly as before (an extraction moves
// bytes, not behavior).
//
// The family pulls its own deps straight from the leaf modules (coins' mint,
// media's icon intake, permissions' payload machinery); it needs none of
// servers.mjs's shared read helpers, so the circular import carries only the
// two mirrors' origin note — the seam is inert in the cycle like its
// siblings.
//
// The module rides the 800-line soft ceiling with a deliberate exception:
// the three body stages (create, list, PATCH) read as ONE family (one wire
// surface — the server itself), no second caller exists to split into.

import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import {
  GC_RULES_MAX,
} from "../constants.mjs";
// The community-builder mint rides the create AFTER the build batch commits —
// failure-isolated, coins never fail a server.
import { grantServerCreateCoins } from "./coins.mjs";
// The rules gate's owner edit rides the word filter: a rules document the
// filter would mask is REFUSED (GC's reject semantics — masking is the
// forum's), so the owner never publishes copy different than they wrote.
import { ensureFilterWords, filterWords } from "./filterstore.mjs";
// The filtered-document refusal is the same law the PATCH's own intake
// runs for the server name.
import { applyWordFilter, containsFilteredWord } from "./filter.mjs";
// The PATCH icon reuses the media module's intake engine-to-engine (magic
// bytes, structural sanitizer, 64k chunks, pending moderation) — no new
// storage SQL, no second gate. The ctx attachment purge does NOT ride here:
// the owner's one-act DELETE lives in api/server-leave.mjs (the
// single-home ruling recorded at this lane's rebase).
import { createAttachment, readMultipartWithImage } from "./media.mjs";
// The payload machinery's permission names + the PATCH verification law stay
// ONE implementation in permissions.mjs, imported here like every sibling.
import {
  ALL_SERVER_PERMISSIONS,
  effectivePermissions,
  permissionNames,
  VERIFICATION_LEVELS,
} from "./permissions.mjs";
// The owner-guard fragment mirrors the sibling lanes' exact copies (invite,
// channels, roles, mod keep them local by the same design note; a guard
// change must be re-mirrored and the parity tests pin the copies' behavior).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// gc_servers/gc_channels CHECK(length(trim(name)) BETWEEN 1 AND 100); the
// route-side limit mirrors it so oversized names 400 instead of 500-ing on the
// constraint.
const SERVER_NAME_MAX = 100;

async function handleCreateServerRoute(request, env) {
  const session = await requireUser(request, env);
  const body = await readJson(request);
  const name = requiredText(body.name, "server name", SERVER_NAME_MAX);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  // One transaction: the server row, the owner's membership row, and the
  // #general text channel. The membership/channel statements used to pull
  // their server_id from last_insert_rowid() — but on the real (remote) D1
  // a batch()'s later statements no longer see the opener's rowid: every
  // create ran the membership/channel FK against a stale id and the whole
  // batch rolled back (live-confirmed via tail + a remote dev repro; the
  // local engine carried the rowid, which is why tests stayed green). So:
  // the server row inserts alone, the build batch binds its id explicitly,
  // and a failed build batch deletes the server row it opened — the
  // compensate keeps the create all-or-nothing.
  const serverInsert = await env.GOOBER_DB.prepare(
    "INSERT INTO gc_servers (name, owner_user_id, created_at) VALUES (?, ?, ?)",
  ).bind(name, userId, now).run();
  if (Number(serverInsert.meta?.changes) !== 1) {
    throw new HttpError(500, "The server could not be created. Please try again.");
  }
  const serverId = Number(serverInsert.meta.last_row_id);
  try {
    await env.GOOBER_DB.batch([
      env.GOOBER_DB.prepare(
        "INSERT INTO gc_server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
      ).bind(serverId, userId, "owner", now),
      env.GOOBER_DB.prepare(
        "INSERT INTO gc_channels (server_id, name, kind, position, created_at) VALUES (?, 'general', 'text', 0, ?)",
      ).bind(serverId, now),
    ]);
  } catch (error) {
    // The compensated create: the opener's row is removed with its id, so a
    // failed build batch leaves the caller exactly where they started.
    await env.GOOBER_DB.prepare(
      "DELETE FROM gc_servers WHERE id = ? AND owner_user_id = ?",
    ).bind(serverId, userId).run();
    throw error;
  }
  // The economy re-rule's community-builder mint: AFTER the build batch
  // commits, failure-isolated — coins never fail a server. The mint's own
  // guards (ceiling + the 2-mints-a-day cap) ride its INSERT.
  await grantServerCreateCoins(env, userId, now).catch(() => {
    /* a mint miss only delays the builder's coins, never the server */
  });

  const channel = await env.GOOBER_DB.prepare(
    "SELECT id, name, kind, position FROM gc_channels " +
      "WHERE server_id = ? AND name = 'general' LIMIT 1",
  ).bind(serverId).first();

  return json(
    {
      server: { id: serverId, name },
      channels: channel
        ? [{
            id: Number(channel.id),
            name: channel.name,
            kind: channel.kind,
            position: Number(channel.position),
          }]
        : [],
    },
    201,
  );
}

// Icon URLs ride the shared serving gate: /api/attachments/:id serves an
// approved row to anyone, a pending row only to its uploader (server icons
// upload pending), and anything else 404s. So the list hands every referenced
// media id out as a plain URL and visibility stays the media module's job.
function attachmentUrl(mediaId) {
  return mediaId === null || mediaId === undefined ? null : "/api/attachments/" + Number(mediaId);
}

// errorName(error): the failure's compact label for the best-effort ride
// logs below — D1/R2 errors carry a name/message pair worth one line of
// context, never a swallowed void (the messages.mjs pattern, same idiom).
function errorName(error) {
  return error && error.name ? error.name : "UnknownError";
}

// One query: memberships for the caller joined to their servers and the
// servers' text/voice channels. The join's server_id IS NOT NULL excludes
// DM/group conversation channels (they have none), and the ORDER BY pins the
// per-server (position, id) channel order.
async function handleListServersRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  // Goober+ boosts ride the same joined list: the stored counter plus the
  // caller's own-boost EXISTS, both additive columns on the rows.
  const { results } = await env.GOOBER_DB.prepare(
    "SELECT s.id AS server_id, s.name AS server_name, s.is_public AS server_is_public, " +
      "s.icon_media_id AS server_icon_media_id, m.role, " +
      "s.boosts AS server_boosts, " +
      "s.verification_level AS server_verification_level, " +
      "EXISTS (SELECT 1 FROM gc_server_boosts gb WHERE gb.server_id = s.id AND gb.user_id = ?) AS boosted_by_me, " +
      "c.id AS channel_id, c.name AS channel_name, " +
      "c.kind AS channel_kind, c.position AS channel_position, " +
      "c.is_spoiler AS channel_is_spoiler, " +
      "c.category_id AS channel_category_id, " +
      "c.slowmode_seconds AS channel_slowmode_seconds, " +
      // The rules gate's two flags (0012, additive columns): the server's
      // gate-on boolean (no 20-KiB document ever rides the list) and the
      // caller's own acceptance. Present-when-relevant in the payload below.
      "s.rules_text IS NOT NULL AS server_has_rules, " +
      "m.rules_accepted_at AS rules_accepted_at " +
      "FROM gc_server_members m " +
      "JOIN gc_servers s ON s.id = m.server_id " +
      "LEFT JOIN gc_channels c ON c.server_id = s.id AND c.server_id IS NOT NULL " +
      "WHERE m.user_id = ? " +
      "ORDER BY s.id, c.position, c.id",
  ).bind(Number(session.user.id), Number(session.user.id)).all();

  const servers = [];
  const byId = new Map();
  // The category ids the list itself referenced (a category with NO channels
  // yet — created empty, awaiting its first channel — still has to ride the
  // payload so the sidebar can render and fill it).
  const knownCategoryIds = new Map();

  for (const row of results) {
    let server = byId.get(row.server_id);

    if (!server) {
      // isPublic mirrors the migration's 0/1 flag (0004); a pre-0004 row shape
      // (undefined) degrades to false, never to a crash.
      server = {
        id: Number(row.server_id),
        name: row.server_name,
        isPublic: Number(row.server_is_public) === 1,
        role: row.role,
        iconUrl: attachmentUrl(row.server_icon_media_id),
        boosts: Number(row.server_boosts ?? 0),
        boostedByMe: Number(row.boosted_by_me) === 1,
        // The verification-level column (0008): a nonzero level rides only
        // when the owner has turned it on — a pre-0008 row shape (or level 0)
        // keeps the byte-identical payload.
        ...(Number(row.server_verification_level) > 0
          ? { verificationLevel: Number(row.server_verification_level) }
          : {}),
        // The rules gate (0012): the menu + dialog flags ride only when the
        // owner has actually set a document — a gate-off (or pre-0012) server
        // keeps the byte-identical payload.
        ...(Number(row.server_has_rules) === 1
          ? { hasRules: true, rulesAccepted: Number(row.rules_accepted_at) > 0 }
          : {}),
        channels: [],
      };
      byId.set(row.server_id, server);
      servers.push(server);
    }

    if (row.channel_id !== null && row.channel_id !== undefined) {
      server.channels.push({
        id: Number(row.channel_id),
        name: row.channel_name,
        kind: row.channel_kind,
        position: Number(row.channel_position),
        // The spoiler-channel toggle (0006): a pre-0006 row shape reads as
        // NOT a spoiler, exactly like today.
        isSpoiler: Number(row.channel_is_spoiler) === 1,
        // The layer columns (0007): a category id rides only when the channel
        // is filed under one, and a slowmode rides only when one is on — a
        // pre-0007 row shape (or an untouched channel) carries neither, so
        // the overwrite-free payload is byte-identical to the pre-0007 shape.
        ...(row.channel_category_id !== null && row.channel_category_id !== undefined
          ? { categoryId: Number(row.channel_category_id) }
          : {}),
        ...(Number(row.channel_slowmode_seconds) > 0
          ? { slowmodeSeconds: Number(row.channel_slowmode_seconds) }
          : {}),
      });
    }
    if (row.channel_category_id !== null && row.channel_category_id !== undefined) {
      const seen = knownCategoryIds.get(row.server_id) || new Set();
      seen.add(Number(row.channel_category_id));
      knownCategoryIds.set(row.server_id, seen);
    }
  }

  // --- phase-3 layer payload (graceful default) --------------------------------
  // The viewer's per-channel effective permissions attach ONLY to servers
  // that carry overwrite rows at all; categories attach only when the server
  // actually has one. Everything rides three small reads the empty database
  // answers with zero rows.
  if (byId.size > 0) {
    const userId = Number(session.user.id);
    const roleResult = await env.GOOBER_DB.prepare(
      "SELECT gmr.server_id AS server_id, r.id AS id, r.permissions AS permissions " +
        "FROM gc_member_roles gmr JOIN gc_roles r ON r.id = gmr.role_id " +
        "WHERE gmr.user_id = ?",
    ).bind(userId).all();
    const categoryResult = await env.GOOBER_DB.prepare(
      "SELECT id, server_id, name, position FROM gc_channel_categories",
    ).all();
    const overwriteResult = await env.GOOBER_DB.prepare(
      "SELECT channel_id, category_id, role_id, allow_mask, deny_mask FROM gc_channel_overwrites",
    ).all();

    const rolesByServer = new Map();
    for (const row of roleResult.results || []) {
      const list = rolesByServer.get(Number(row.server_id)) || [];
      list.push({ id: Number(row.id), permissions: Number(row.permissions) });
      rolesByServer.set(Number(row.server_id), list);
    }
    const categoriesByServer = new Map();
    for (const row of categoryResult.results || []) {
      const list = categoriesByServer.get(Number(row.server_id)) || [];
      list.push({ id: Number(row.id), name: row.name, position: Number(row.position) });
      categoriesByServer.set(Number(row.server_id), list);
    }
    const overwrites = overwriteResult.results || [];

    for (const server of servers) {
      if (overwrites.length === 0) break; // every server is overwrite-free: nothing to add
      const serverId = Number(server.id);
      const channelIds = new Set(server.channels.map((channel) => Number(channel.id)));
      const serverCategories = categoriesByServer.get(serverId) || [];
      const categoryIds = knownCategoryIds.get(serverId) || new Set();
      const serverOverwrites = overwrites.filter(
        (row) =>
          (row.channel_id !== null && row.channel_id !== undefined &&
            channelIds.has(Number(row.channel_id))) ||
          (row.category_id !== null && row.category_id !== undefined &&
            categoryIds.has(Number(row.category_id))),
      );
      if (serverOverwrites.length === 0) continue; // this server stays byte-identical

      if (serverCategories.length > 0) {
        // Named payloads, strongest-last position order (the sidebar render's
        // own order), and only the categories that survived.
        server.categories = serverCategories
          .sort((a, b) => a.position - b.position || a.id - b.id)
          .map((category) => ({
            id: category.id,
            name: category.name,
            position: category.position,
          }));
      }

      const roleRows = server.role === "owner" ? [] : (rolesByServer.get(serverId) || []);
      for (const channel of server.channels) {
        const chain = [];
        const categoryId = (channel.categoryId !== undefined) ? channel.categoryId : null;
        for (const row of serverOverwrites) {
          if (
            (row.channel_id !== null && row.channel_id !== undefined &&
              Number(row.channel_id) === Number(channel.id)) ||
            (row.category_id !== null && row.category_id !== undefined &&
              categoryId !== null && Number(row.category_id) === categoryId)
          ) {
            chain.push({
              channel_id: row.channel_id,
              category_id: row.category_id,
              role_id: row.role_id,
              allow_mask: Number(row.allow_mask) || 0,
              deny_mask: Number(row.deny_mask) || 0,
            });
          }
        }
        // The owner (string tier) bypasses everything; everyone else rides the
        // filed resolution walk.
        channel.effectivePermissions = permissionNames(
          server.role === "owner"
            ? ALL_SERVER_PERMISSIONS
            : effectivePermissions(roleRows, chain),
        );
      }
    }
  }

  return json({ servers });
}

// --- PATCH /api/servers/:id (server settings: name + icon) -----------------------
//
// Owner-only, and the ownership never leaves the UPDATE's WHERE — a caller
// that is not the owner (or a caller pointing the icon at an attachment they
// do not own) fails the SAME statement with zero changes, answered by one
// shared 403 that never probes the server's existence. The icon reference is
// guarded inside that same WHERE: icon_media_id may only resolve to one of
// the CALLER'S OWN gc_attachments rows, so a pending attachment that the
// serving gate would refuse to another session can never be smuggled into
// the server's icon slot.
//
// Body shape: application/json { name?, iconMediaId? } (iconMediaId null
// clears the icon) or multipart/form-data { name?, image } — the image part
// runs the media module's exact standalone intake (createAttachment), so the
// icon row is stored pending moderation and chunked like every attachment.
async function handleUpdateServerRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();

  // --- PATCH: intake -----------------------------------------------------------
  // Each PATCH field owns ONE clearly-marked block, and the blocks below only
  // ever set their own flag — merge-friendly by construction, so a parallel
  // worker can stack another field (a flag, a second column, ...) by adding
  // one more block without re-touching the intake or the UPDATE assembly.
  const nameField = { present: false, value: null };
  const iconField = { present: false, value: null };
  const isPublicField = { present: false, value: false };
  const verificationField = { present: false, value: 0 };
  const rulesField = { present: false, value: null };

  if (contentType.startsWith("multipart/form-data")) {
    // Uploads ride the same limiter as the standalone attachment intake, then
    // the SAME multipart reader (the `image` file part is enforced there). An
    // owner-only route: the guard rides the UPDATE below either way.
    await rateLimit(request, env, "upload", "user:" + userId);
    const { fields, files } = await readMultipartWithImage(request);

    // [PATCH field block: name] — same validation as create (multipart text
    // field), run at collection time so an invalid name 400s before the intake
    // ever stores anything.
    if (fields.name !== undefined) {
      nameField.present = true;
      nameField.value = requiredText(fields.name, "server name", SERVER_NAME_MAX);
    }

    // [PATCH field block: icon] — an uploaded image is stored through
    // createAttachment (magic bytes, sanitizer, 64k chunks, status='pending'),
    // and only the returned media id moves into the server's icon_media_id
    // column. Exactly one image per PATCH, like the standalone intake.
    if (files.length > 1) {
      throw new HttpError(400, "Attach exactly one image.");
    }
    if (files.length > 0) {
      const attachment = await createAttachment(env, userId, files[0]);
      iconField.present = true;
      iconField.value = attachment.id;
    }
  } else {
    // The rules document (0012) rides this PATCH: a 20-KiB document plus the
    // JSON envelope never fits under the vendored 16-KiB default, so the
    // body bound follows the document cap + envelope slack (every small
    // PATCH keeps its exact old shape).
    const body = await readJson(request, GC_RULES_MAX + 4096);

    // [PATCH field block: name] — same validation as create, at collection
    // time (before anything can be written below).
    if (body.name !== undefined) {
      nameField.present = true;
      nameField.value = requiredText(body.name, "server name", SERVER_NAME_MAX);
    }

    // [PATCH field block: is_public] — discovery visibility (the owner's
    // public/private toggle; JSON only, UI never needs a multipart flip).
    if (Object.hasOwn(body, "is_public")) {
      if (body.is_public !== true && body.is_public !== false) {
        throw new HttpError(400, "is_public must be true or false.");
      }
      isPublicField.present = true;
      isPublicField.value = body.is_public;
    }

    // [PATCH field block: icon] — iconMediaId is an attachment id (or null to
    // clear); anything else is a 400 before any statement runs.
    if (body.iconMediaId !== undefined) {
      const mediaId = body.iconMediaId;
      if (mediaId !== null && (!Number.isInteger(mediaId) || mediaId < 1)) {
        throw new HttpError(400, "iconMediaId must be an attachment id or null.");
      }
      iconField.present = true;
      iconField.value = mediaId;
    }

    // [PATCH field block: verification_level] — the server-wide verification
    // switch (0008): the filed reading is OWNER-ONLY (no MANAGE_SERVER-style
    // bit exists at GC, and "SERVER-WIDE means one owner call"), which is
    // exactly what the UPDATE's owner_user_id WHERE already enforces. The
    // value must ride the filed ladder.
    if (Object.hasOwn(body, "verification_level")) {
      if (body.verification_level === null || !Number.isSafeInteger(body.verification_level) ||
          !VERIFICATION_LEVELS.includes(body.verification_level)) {
        throw new HttpError(400, "verification_level must be one of 0, 1, 2, 3, 4.");
      }
      verificationField.present = true;
      verificationField.value = body.verification_level;
    }

    // [PATCH field block: rules_text] — the rules gate's owner edit (0012):
    // a string sets the document (the gate turns ON), null clears it (the
    // gate turns OFF — NULL is the column's OFF state, pre-0012 servers
    // included). JSON only, like is_public/verification_level — the UI never
    // needs a multipart rules flip. Validation at collection time: trimmed,
    // bounded (GC_RULES_MAX, the forum rules page's own 20 KiB), and REJECTED
    // when the word filter would mask anything (GC's send-path semantics, so
    // the gate never publishes masked copy).
    if (Object.hasOwn(body, "rules_text")) {
      const value = body.rules_text;
      if (value !== null && (typeof value !== "string" || value.trim() === "")) {
        throw new HttpError(400, "rules_text must be a rules document or null to clear it.");
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > GC_RULES_MAX) {
          throw new HttpError(
            400,
            "The rules must be " + GC_RULES_MAX + " characters or fewer.",
          );
        }
        await ensureFilterWords(env);
        if (applyWordFilter(trimmed, filterWords(env)) !== trimmed) {
          throw new HttpError(400, "That rules text isn't allowed.");
        }
        rulesField.value = trimmed;
      }
      rulesField.present = true;
    }
  }

  if (!nameField.present && !iconField.present && !isPublicField.present &&
      !verificationField.present && !rulesField.present) {
    throw new HttpError(400, "Nothing to change. Send a new name and/or a new icon.");
  }

  // --- PATCH: one guarded UPDATE ----------------------------------------------
  // The SET fragments assemble per present field; the WHERE always carries
  // id + owner_user_id, and a present icon adds its own-attachment EXISTS
  // guard to the same statement. No read-then-write gates anywhere.
  const setClauses = [];
  const setBinds = [];
  let iconGuardBinds = [];

  if (isPublicField.present) {
    setClauses.push("is_public = ?");
    setBinds.push(isPublicField.value ? 1 : 0);
  }

  if (verificationField.present) {
    // Already ladder-validated at collection time.
    setClauses.push("verification_level = ?");
    setBinds.push(verificationField.value);
  }

  if (rulesField.present) {
    // Already trimmed/bounded/filter-checked at collection time (or NULL to
    // clear — the gate's OFF state).
    setClauses.push("rules_text = ?");
    setBinds.push(rulesField.value);
  }

  if (nameField.present) {
    // Already validated at collection time, exactly like create (the server
    // name CHECK constraint mirrors it).
    setClauses.push("name = ?");
    setBinds.push(nameField.value);
  }

  if (iconField.present) {
    setClauses.push("icon_media_id = ?");
    setBinds.push(iconField.value);
    if (iconField.value !== null) {
      // The icon slot may only take an attachment the CALLER uploaded. The
      // guard rides the UPDATE, so a stranger's (or merely guessed) id can
      // never land — zero changes, one shared 403, no existence oracle.
      iconGuardBinds = [iconField.value, userId];
    }
  }

  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_servers SET " + setClauses.join(", ") +
      " WHERE id = ? AND owner_user_id = ?" +
      (iconField.present && iconField.value !== null
        ? " AND EXISTS (SELECT 1 FROM gc_attachments WHERE id = ? AND uploader_id = ?)"
        : ""),
  ).bind(...setBinds, serverId, userId, ...iconGuardBinds).run();

  if (Number(result.meta?.changes) !== 1) {
    // Zero changes: not the owner, an unknown server, or an icon id that is
    // not the caller's own attachment — all the same 403, none of them
    // confirmed by any follow-up read (nothing else is queried).
    throw new HttpError(403, "You do not have permission to do that.");
  }

  // Read back the merged row (owner-guarded, so the response is only ever the
  // caller's own server state). The rules gate's document itself is NOT echoed
  // here — the settings dialog re-reads it through the member-only rules read
  // (api/rules.mjs), which is also where the 20-KiB text stays.
  const row = await env.GOOBER_DB.prepare(
    "SELECT id, name, icon_media_id, is_public, verification_level FROM gc_servers WHERE id = ? AND owner_user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  if (!row) {
    // Unreachable short of a concurrent ownership change: never echo a state
    // the UPDATE did not just write.
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json(
    {
      server: {
        id: Number(row.id),
        name: row.name,
        isPublic: Number(row.is_public) === 1,
        iconUrl: attachmentUrl(row.icon_media_id),
        // Present-when-relevant: a zero (or unturned) level is the same
        // pre-0008 "none" the payload has always carried.
        ...(Number(row.verification_level) > 0
          ? { verificationLevel: Number(row.verification_level) }
          : {}),
      },
    },
    200,
  );
}

export async function handleServerBodyRoutes(request, env, url, path, method, ctx) {
  // url and ctx have no family consumer anymore: the ctx-threaded owner
  // DELETE (the shaver) rode api/server-leave.mjs at T-R25-SPLIT-SERVERS-5
  // (the sibling double-move caught at this lane's rebase — the family here
  // is create/list/PATCH only, arms unchanged otherwise).
  void url;
  void ctx;
  if (path === "/api/servers" && method === "POST") {
    return handleCreateServerRoute(request, env);
  }
  if (path === "/api/servers" && method === "GET") {
    return handleListServersRoute(request, env);
  }

  const serverPatchMatch = (method === "PATCH")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)$/)
    : null;
  if (serverPatchMatch) {
    return handleUpdateServerRoute(request, env, Number(serverPatchMatch[1]));
  }

  return undefined;
}
