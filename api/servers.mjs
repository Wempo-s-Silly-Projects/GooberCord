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

// Servers and channels routes (Phase 1, Task 4 + Phase 3 role foundation):
// server creation + listing, the moderator-role-gated text/voice channel
// create, invites/discovery/boosts, and the role surface (roles CRUD, role
// assignment, roster, nicknames, spoiler channels, kicks). Sessions,
// CSRF/same-origin gates, and the http helpers are the vendored core's job;
// this module owns only dispatch, request-shape validation, and status codes.
//
// The authorization rule of the module: every write's guards ride INSIDE the
// SQL itself, never as a read-then-write check. So the server create is one
// atomic batch (server + owner membership + #general channel, the latter two
// deriving their server id from last_insert_rowid()), the channel create
// is a single guarded INSERT ... SELECT whose WHERE carries the membership
// role precondition and the per-server channel-cap precondition, and the
// server PATCH is a single guarded UPDATE whose WHERE carries both the
// ownership precondition and the icon-owner precondition. A channel-create
// failure is classified AFTER the fact by one diagnostic membership read — it
// only picks the error message (403 vs 400) and never gates any write; the
// PATCH, by contrast, has no failure classes to pick between (an owner that
// hits a 403 asked for an icon it does not own, and that answer deliberately
// leaks nothing about either the server or the attachment).
//
// Phase-3 graceful default: a server with NO gc_roles row still behaves like
// the pre-roles server (the stored string tiers owner/moderator/member).
// Roles only layer EXTRA moderation powers — every role-aware guard is
// OWNER OR <string tier / permission bit>, never a downgrade of what a
// member could already do.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import {
  GC_CATEGORIES_MAX_PER_SERVER,
  GC_INVITES_MAX_PER_SERVER,
  GC_ROLES_MAX_PER_SERVER,
  GC_RULES_MAX,
  GC_SEARCH_PAGE_MAX,
  GC_SEARCH_TERM_MAX,
  GC_SERVER_DELETE_ATTACHMENT_LIMIT,
  GC_SERVERS_JOIN_MAX_FREE,
  GC_SERVERS_JOIN_MAX_PLUS,
  MAX_CHANNELS_PER_SERVER,
  PINS_READ_BIND_CHUNK,
} from "../constants.mjs";
import { grantServerCreateCoins } from "./coins.mjs";
import {
  ALL_SERVER_PERMISSIONS,
  canManageRoleAt,
  effectivePermissions,
  enforceVerificationLevel,
  holdsRolesBitsParams,
  holdsRolesBitsSql,
  highestPosition,
  OVERWRITE_BITS,
  parseMergedMask,
  permissionNames,
  PRUNE_DAYS,
  roleMaskColumnSql,
  SERVER_PERMISSIONS,
  SLOWMODE_CHOICES,
  TIMEOUT_MINUTE_CHOICES,
  VERIFICATION_LEVELS,
} from "./permissions.mjs";
// Server icons reuse the media module's intake end to end: the standalone
// upload (magic bytes, structural sanitizer, 64k chunks, pending moderation)
// and the same multipart reader — no new storage SQL, no second gate to have
// drifted away from the attachment one.
import { createAttachment, readMultipartWithImage, scheduleAttachmentObjectDelete } from "./media.mjs";
// The search's per-hit VIEW gate rides the shared layer machinery (one
// boolean, never the throwing route gate — a denied hit is DROPPED, not a
// page-kill).
import { viewerCanViewChannel } from "./messages.mjs";
import { plusActiveExpr, publicIsPlus } from "./plus.mjs";
// The rules gate's owner edit (0012) rides the word filter too: a rules
// document the filter would mask is REFUSED (GC's reject semantics — masking
// is the forum's), so the owner never publishes different copy than they wrote.
// 0010 filter/AutoMod: the per-server rule rows and their caps, the nickname
// screen (the name-class rules over the check_names rules only) and the
// username-filter primitives the registration flow already runs.
import {
  dropServerRulesCache,
  FILTERED_NAME_ERROR,
  FILTER_ALERTS_PAGE_MAX,
  FILTER_RULE_ACTIONS,
  FILTER_RULE_BLOCK_MESSAGE_MAX,
  FILTER_RULE_DEFAULT_TIMEOUT_MINUTES,
  FILTER_RULE_MAX_PATTERNS,
  FILTER_RULE_MAX_RULES,
  FILTER_RULE_EXEMPT_ROLES_MAX,
  FILTER_RULE_EXEMPT_CHANNELS_MAX,
  loadServerRules,
  nameRuleHit,
  publicRule,
  termsFromBody,
} from "./filterrules.mjs";
import {
  applyWordFilter,
  containsFilteredWord,
  normalizeUsernameForFilter,
} from "./filter.mjs";
import { ensureFilterWords, filterWords } from "./filterstore.mjs";

// gc_servers/gc_channels CHECK(length(trim(name)) BETWEEN 1 AND 100); the
// route-side limit mirrors it so oversized names 400 instead of 500-ing on the
// constraint.
const SERVER_NAME_MAX = 100;
const CHANNEL_NAME_MAX = 100;
// gc_roles name CHECK widened to the parity law (migration 0024) and the
// category names riding the same bound (gc_channel_categories names are
// widened in the same file; docs/parity-limits.md: Role name length 1–100,
// verified 2026-11-17). The nickname column is NOT part of the raise — its
// Change-Nickname bound is Discord's own 32 (0006) and stays.
const ROLE_NAME_MAX = 100;
const NICKNAME_MAX = 32;
// gc_server_bans.CHECK(reason IS NULL OR length(reason) <= 280); the route-side
// limit mirrors it so an oversized reason 400s instead of 500-ing.
const BAN_REASON_MAX = 280;

// The member payloads carry ISO timestamps (roster payload style): a stored
// epoch second goes out as text, and a missing row shape degrades to null.
// Exported for api/rules.mjs's payload (same membership-timestamp → ISO
// convention, one helper — never a second formatter that drifts).
export function isoTimestamp(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const number = Number(seconds);
  return Number.isFinite(number) && number > 0 ? new Date(number * 1000).toISOString() : null;
}

// --- Goober+ server boosts (free, one per member per server) -------------------
// The boost is one guarded INSERT ... SELECT (the membership EXISTS rides the
// statement's own WHERE) with the PK conflict resolved by DO NOTHING, and the
// gc_servers.boosts counter is never incremented in place: every write REPLACES
// it from gc_server_boosts in the same batch, so an idempotent replay (or a
// retract whose first statement matched nothing) can never drift the count.
const BOOST_INSERT_SQL =
  "INSERT INTO gc_server_boosts (user_id, server_id, created_at) " +
    "SELECT ?, ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ?) " +
    "ON CONFLICT DO NOTHING";

const BOOST_RECOUNT_SQL =
  "UPDATE gc_servers SET boosts = (SELECT COUNT(*) FROM gc_server_boosts WHERE server_id = ?) " +
    "WHERE id = ?";

const BOOST_RESELECT_SQL =
  "SELECT boosts FROM gc_servers WHERE id = ? LIMIT 1";

const BOOST_DIAG_SQL =
  "SELECT 1 AS boosted FROM gc_server_boosts WHERE user_id = ? AND server_id = ? LIMIT 1";

const BOOST_DELETE_SQL =
  "DELETE FROM gc_server_boosts WHERE user_id = ? AND server_id = ?";

async function handleBoostRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  // ONE batch: the guarded boost row (or its no-op replay), the recount, and
  // the response-value read. The authorization lives ONLY inside the INSERT.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(BOOST_INSERT_SQL).bind(userId, serverId, now, serverId, userId),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
    env.GOOBER_DB.prepare(BOOST_RESELECT_SQL).bind(serverId),
  ]);

  if (Number(results[0]?.meta?.changes) !== 1) {
    // Diagnostic only — authority already rode the guarded INSERT. A repeated
    // boost is a 409; everyone else (including non-members, so no
    // server-existence oracle) gets the same permission 403.
    const existing = await env.GOOBER_DB.prepare(BOOST_DIAG_SQL)
      .bind(userId, serverId).first();
    if (existing) throw new HttpError(409, "You already boosted this server.");
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const boosts = Number(results[2]?.results?.[0]?.boosts ?? 0);
  return json(
    { server: { id: serverId, boosts, boostedByMe: true } },
    201,
  );
}

async function handleRetractBoostRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // ONE batch: the author-guarded delete and the recount together — the
  // boost count is re-derived from the boost rows either way, so a 404-path
  // (zero changes) replay still leaves gc_servers.boosts exactly truthful.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(BOOST_DELETE_SQL).bind(userId, serverId),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
    env.GOOBER_DB.prepare(BOOST_RESELECT_SQL).bind(serverId),
  ]);

  if (Number(results[0]?.meta?.changes) !== 1) {
    throw new HttpError(404, "You have not boosted this server.");
  }

  const boosts = Number(results[2]?.results?.[0]?.boosts ?? 0);
  return json(
    { server: { id: serverId, boosts, boostedByMe: false } },
    200,
  );
}

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

// --- shared role-aware SQL fragments -----------------------------------------
// Every role-aware guard reuses these scalar subqueries so the same member-
// mask arithmetic underlies each of them. gc_member_roles is keyed by
// (server_id, user_id, role_id), so the mask needs no membership join.

// The member's role permission masks, as the RBAC-audit H1 repair folds it:
// the COALESCEd GROUP_CONCAT the JS side folds with bitwise OR
// (parseMergedMask) — SUM carried (bit + bit reads as the NEXT-higher bit),
// the fold never does. The member's effective EXTRA-permission set ('' when
// they hold no role).
const MERGED_PERMS_SELECT = roleMaskColumnSql();

// The member's strongest role position (-1 when roleless — the hierarchy
// sentinel every strictly-lower rule compares against).
const TOP_POSITION_SELECT =
  "(SELECT COALESCE(MAX(hr.position), -1) FROM gc_member_roles hmr " +
    "JOIN gc_roles hr ON hr.id = hmr.role_id " +
    "WHERE hmr.server_id = ? AND hmr.user_id = ?)";

// The pre-roles tier's ownership: the string-membership owner row.
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// moderationGuard(serverId, actorId, targetServerId, targetUserId, bits):
// the KICK/MANAGE-family guard — the actor is the string-tier owner, OR holds
// EVERY bit in `bits` across their role set AND outranks the target
// (strictly greater top position, so -1/roleless members can act on nobody).
// bits is an ARRAY of named bit VALUES; the hold test is the RBAC-audit H1
// per-bit EXISTS (one role row may answer each bit independently — EXACT OR,
// never a SUM's arithmetic carry).
// Binds (in fragment order): serverId, actorId (the owner row), then
// serverId, actorId per required bit, then serverId, actorId ×2 (the
// hierarchy comparison's two top-position reads), then serverId, targetId.
// Exported so api/rules.mjs's manual-verify route guards with the SAME
// fragment (one implementation — the drift guard; the rules gate's verify
// authority is the KICK_MEMBERS pair this module already uses for kicks,
// bans, and timeouts).
export function moderationGuardSql(serverId, actorId, targetId, bits) {
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR (" +
        holdsRolesBitsSql(bits) + " AND " +
        TOP_POSITION_SELECT + " > " + TOP_POSITION_SELECT + "))",
    params: [
      serverId, actorId,
      ...holdsRolesBitsParams(serverId, actorId, bits),
      serverId, actorId,
      serverId, actorId,
      serverId, targetId,
    ],
  };
}

// roleManageGuard(serverId, actorId, bits): the role-CRUD guard for updating
// or removing a gc_roles row — the actor is the owner, OR holds every bit AND
// their top position exceeds the row's OWN position (`position` resolves to
// the modified row's column). Binds: serverId, actorId, then serverId,
// actorId per required bit, then serverId, actorId (the top-position read).
function roleManageGuardSql(serverId, actorId, bits) {
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR (" +
        holdsRolesBitsSql(bits) + " AND gc_roles.position < " +
        TOP_POSITION_SELECT + "))",
    params: [
      serverId, actorId,
      ...holdsRolesBitsParams(serverId, actorId, bits),
      serverId, actorId,
    ],
  };
}

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

// --- discovery + invites ---------------------------------------------------------
// Every write below keeps the module's rule: the authorization predicate rides
// INSIDE the SQL, and a changes=0 result is classified afterwards by a single
// diagnostic read that only picks an error message — it never gates a write.

// SHAVERS 3 (0017): the invite's lifecycle shelves. Both knobs default to the
// pre-0017 behavior — no expiry, no use cap — by sending nothing (or 0, which
// normalizes to the same null in the column).
export const INVITE_MAX_AGE_MIN = 60;
export const INVITE_MAX_AGE_MAX = 2592000; // the 30-day shelf
export const INVITE_MAX_USES_MAX = 100;
// The list is a mod-desk read, not a page: servers mint few invites; the cap
// is a safety rail, newest first.
export const INVITE_LIST_LIMIT = 500;

// The ONE active predicate (0017) the join lookup, the join INSERT's guard and
// the uses-bump's WHERE all share — a join racing an expiry or a use cap can
// never overshoot, and each statement's `?` binds the caller's now in its own
// textual order.
const INVITE_ACTIVE_SQL =
  "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) " +
  "AND (max_uses IS NULL OR uses < max_uses)";

// randomToken(6) is exactly 8 base64url chars (48 bits -> 8 x 6-bit chars, no
// padding to strip), so an invite link is always "#/join/<8 chars>".
function newInviteCode() {
  return randomToken(6);
}

async function handleCreateInviteRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  // The lifecycle knobs are optional (the live client still posts a bare
  // mint), so the body read is lenient — a missing or non-JSON body is the
  // unlimited/never shape, not an error.
  const body = (await request.json().catch(() => null)) || {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Send this form as JSON.");
  }

  let maxAgeSeconds = body.maxAgeSeconds ?? null;
  if (maxAgeSeconds === 0) maxAgeSeconds = null;
  if (
    maxAgeSeconds !== null &&
    (!Number.isInteger(maxAgeSeconds) ||
      maxAgeSeconds < INVITE_MAX_AGE_MIN ||
      maxAgeSeconds > INVITE_MAX_AGE_MAX)
  ) {
    throw new HttpError(400, "That invite expiry is invalid.");
  }

  let maxUses = body.maxUses ?? null;
  if (maxUses === 0) maxUses = null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_MAX_USES_MAX)) {
    throw new HttpError(400, "That invite use cap is invalid.");
  }

  const expiresAt = maxAgeSeconds === null ? null : now + maxAgeSeconds;

  // The authority rider inside the INSERT ... SELECT: the string-tier owner,
  // OR any member whose role mask carries MANAGE_INVITES (phase-3 extension —
  // the old owner-only guard is the no-roles server's behavior). A join
  // against a foreign server changes nothing, and the (rare) 8-char code
  // collision is the only reason to retry — same statement, fresh code.
  const INVITE_INSERT_SQL =
    "INSERT INTO gc_invites (code, server_id, created_by, created_at, expires_at, max_uses) " +
      "SELECT ?, ?, ?, ?, ?, ? WHERE (EXISTS (" +
        "SELECT 1 FROM gc_servers WHERE id = ? AND owner_user_id = ?" +
      ") OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_INVITES) + ") " +
      "AND (SELECT COUNT(*) FROM gc_invites WHERE server_id = ?) <= " +
        (GC_INVITES_MAX_PER_SERVER - 1);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = newInviteCode();
    let result;
    try {
      result = await env.GOOBER_DB.prepare(INVITE_INSERT_SQL)
        .bind(
          code, serverId, userId, now, expiresAt, maxUses,
          serverId, userId,
          serverId, userId,
          serverId,
        )
        .run();
    } catch (error) {
      const message = String(error?.message || "");
      if (!attemptMatchesUniqueViolation(message)) throw error;
      continue; // code collision (the PK): a fresh code, same statement
    }

    if (Number(result.meta?.changes) !== 1) {
      // Diagnostic only. A non-owner sees the permission message; an owner
      // whose row matched nothing means the server itself is gone (404).
      const membership = await env.GOOBER_DB.prepare(
        "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
      ).bind(serverId, userId).first();

      if (membership && membership.role === "owner") {
        throw new HttpError(404, "That server does not exist.");
      }

      throw new HttpError(403, "You do not have permission to do that.");
    }

    return json({ code, expiresAt, maxUses }, 201);
  }

  // Three successive PK collisions: astronomically unlikely, surfaced rather
  // than looped.
  throw new HttpError(500, "The invite could not be created. Please try again.");
}

function attemptMatchesUniqueViolation(message) {
  // D1 surfaces SQLite's PRIMARY KEY violation as a UNIQUE constraint error.
  return message.includes("UNIQUE") && message.includes("gc_invites.code");
}

// An invite join is NOT gated on is_public: private servers live off invites.
// One read (the ACTIVE invite row) then at most one membership write plus one
// uses counter tick; an invalid/lapsed/maxed/revoked code 404s before any
// write happens. The 0017 active predicate rides the lookup here AND the
// membership INSERT's EXISTS guard (so the SELECT → INSERT gap can't widen
// the race) AND the bump's WHERE (so the tick itself can't overshoot).
const INVITE_JOIN_SELECT_SQL =
  "SELECT server_id FROM gc_invites WHERE code = ? AND " + INVITE_ACTIVE_SQL + " LIMIT 1";
const INVITE_JOIN_INSERT_SQL =
  "INSERT INTO gc_server_members (server_id, user_id, role, joined_at, created_by_invite) " +
    "SELECT ?, ?, 'member', ?, ? WHERE EXISTS (SELECT 1 FROM gc_invites ij WHERE ij.code = ?" +
      " AND ij." + INVITE_ACTIVE_SQL + ")" +
    " AND NOT EXISTS (SELECT 1 FROM gc_server_members ijn WHERE ijn.server_id = ? AND ijn.user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM gc_server_bans ijb WHERE ijb.server_id = ? AND ijb.user_id = ?)" +
    " AND (SELECT COUNT(*) FROM gc_server_members ijw WHERE ijw.user_id = ?) < " +
      "(CASE WHEN EXISTS (SELECT 1 FROM gc_plus_state ijp WHERE ijp.user_id = ? AND ijp.renews_until > ?)" +
      " THEN " + GC_SERVERS_JOIN_MAX_PLUS + " ELSE " + GC_SERVERS_JOIN_MAX_FREE + " END)";
const INVITE_USES_BUMP_SQL =
  "UPDATE gc_invites SET uses = uses + 1 WHERE code = ? AND " + INVITE_ACTIVE_SQL;

const BANNED_JOIN_SQL =
  "SELECT 1 AS banned FROM gc_server_bans WHERE server_id = ? AND user_id = ? LIMIT 1";

// The changes=0 classification the two join routes share: already a member is
// the idempotent joined:false; a ban row answers the dedicated banned 403;
// anything else (their gate row vanished mid-flight) is the gate's own 404.
// Zero writes ever happened on this path.
async function classifyRefusedJoin(env, serverId, userId, gateNotFoundMessage, includeServerId) {
  const membership = await env.GOOBER_DB.prepare(
    "SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  if (membership) {
    return json(includeServerId ? { joined: false, serverId } : { joined: false });
  }

  const ban = await env.GOOBER_DB.prepare(BANNED_JOIN_SQL)
    .bind(serverId, userId).first();
  if (ban) {
    throw new HttpError(403, "You are banned from that server.");
  }

  throw new HttpError(404, gateNotFoundMessage);
}

async function handleInviteJoinRoute(request, env, code) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  const invite = await env.GOOBER_DB.prepare(INVITE_JOIN_SELECT_SQL)
    .bind(code, now).first();

  if (!invite) {
    // 404 with zero writes: a wrong or lapsed code never touches membership
    // or uses (the bearer-secret flat 404 — expired/maxed/revoked and unknown
    // all answer through this one copy, so nothing about existence leaks).
    throw new HttpError(404, "That invite is no longer valid.");
  }

  const serverId = Number(invite.server_id);
  // The guarded INSERT (an already-member re-join is idempotent — joined:false
  // and the uses counter does NOT move; only a fresh join counts). The active
  // predicate's two now binds ride beside the code inside the EXISTS.
  const join = await env.GOOBER_DB.prepare(INVITE_JOIN_INSERT_SQL)
    .bind(
      serverId, userId, now, code, now, now,
      serverId, userId, serverId, userId,
      userId, userId, now,
    ).run();
  const joined = Number(join.meta?.changes) === 1;

  if (joined) {
    await env.GOOBER_DB.prepare(INVITE_USES_BUMP_SQL).bind(code, now).run();
  } else {
    return classifyRefusedJoin(env, serverId, userId, "That invite is no longer valid.", true);
  }

  return json({ joined, serverId });
}

// --- SHAVERS 3: the invite list + the revoke ---------------------------------------
// Both mod-desk surfaces carry the SAME authority predicate the mint uses (the
// string-tier owner OR a merged role mask carrying MANAGE_INVITES), riding
// INSIDE the statement; an outsider without the bit sees a 404, never a 403
// existence oracle.

const INVITE_LIST_SQL =
  "SELECT i.code, i.created_by, i.created_at, i.uses, i.max_uses, i.expires_at, " +
    "i.revoked_at, u.username AS created_by_name " +
  "FROM gc_invites i JOIN users u ON u.id = i.created_by " +
  "WHERE i.server_id = ? AND (" + OWNER_EXISTS_SQL + " OR " +
    holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_INVITES) + ") " +
  "ORDER BY i.created_at DESC, i.code LIMIT " + INVITE_LIST_LIMIT;

async function handleListInvitesRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  const { results } = await env.GOOBER_DB.prepare(INVITE_LIST_SQL)
    .bind(serverId, userId, serverId, userId).all();

  const invites = (results || []).map((row) => {
    const expiresAt = row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at);
    const maxUses = row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses);
    return {
      code: String(row.code),
      createdBy: Number(row.created_by),
      createdByName: row.created_by_name,
      createdAt: Number(row.created_at),
      uses: Number(row.uses),
      maxUses,
      expiresAt,
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
      // The active gate at read time (revocation/expiry/cap state may have
      // changed since the row was written).
      active:
        row.revoked_at == null &&
        (expiresAt === null || expiresAt > now) &&
        (maxUses === null || Number(row.uses) < maxUses),
    };
  });

  return json({ invites });
}

const INVITE_REVOKE_SQL =
  "UPDATE gc_invites SET revoked_at = ? WHERE code = ? AND server_id = ? AND " +
    "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_INVITES) + ")";

async function handleRevokeInviteRoute(request, env, serverId, code) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  // The soft tombstone, guarded inside the statement. A zero-change result is
  // classified afterwards the module's usual way; an ALREADY-REVOKED row (the
  // caller can manage invites yet the UPDATE matched nothing) is the
  // idempotent ok — the state is exactly what they asked for.
  const revoke = await env.GOOBER_DB.prepare(INVITE_REVOKE_SQL)
    .bind(now, code, serverId, userId, serverId, userId).run();
  if (Number(revoke.meta?.changes) === 1) {
    return json({ ok: true });
  }

  const invite = await env.GOOBER_DB.prepare(
    "SELECT revoked_at FROM gc_invites WHERE code = ? AND server_id = ? LIMIT 1",
  ).bind(code, serverId).first();
  if (!invite) {
    throw new HttpError(404, "That invite does not exist.");
  }

  const allowed = await env.GOOBER_DB.prepare(
    "SELECT 1 AS allowed FROM gc_servers s WHERE s.id = ? AND (" +
      OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_INVITES) + ") LIMIT 1",
  ).bind(serverId, userId, serverId, userId).first();
  if (!allowed) {
    throw new HttpError(404, "That invite does not exist.");
  }

  return json({ ok: true });
}

// The discovery grid: public servers with a member count, already-member
// servers excluded SERVER-SIDE via NOT EXISTS (the roster never round-trips
// through the client), capped at 50.
const DISCOVER_SELECT_SQL =
  "SELECT s.id AS server_id, s.name AS server_name, " +
    "(SELECT COUNT(*) FROM gc_server_members m WHERE m.server_id = s.id) AS member_count " +
  "FROM gc_servers s " +
  "WHERE s.is_public = 1 AND NOT EXISTS (" +
    "SELECT 1 FROM gc_server_members me WHERE me.server_id = s.id AND me.user_id = ?" +
  ") ORDER BY s.id LIMIT 50";

async function handleDiscoverRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const { results } = await env.GOOBER_DB.prepare(DISCOVER_SELECT_SQL)
    .bind(Number(session.user.id)).all();

  return json({
    servers: (results || []).map((row) => ({
      id: Number(row.server_id),
      name: row.server_name,
      memberCount: Number(row.member_count),
    })),
  });
}

// The is_public = 1 precondition rides INSIDE the INSERT ... SELECT, so a
// stale client (grid re-rendered after a flip to private) still cannot join.
// The account-ban rider (0008) rides the same WHERE: discovery joins pause at
// the ban the same as invite joins.
const DISCOVER_JOIN_INSERT_SQL =
  "INSERT INTO gc_server_members (server_id, user_id, role, joined_at) " +
    "SELECT ?, ?, 'member', ? WHERE EXISTS (" +
      "SELECT 1 FROM gc_servers WHERE id = ? AND is_public = 1" +
    ") AND NOT EXISTS (SELECT 1 FROM gc_server_bans djb WHERE djb.server_id = ? AND djb.user_id = ?)" +
    " AND (SELECT COUNT(*) FROM gc_server_members djw WHERE djw.user_id = ?) < " +
      "(CASE WHEN EXISTS (SELECT 1 FROM gc_plus_state djp WHERE djp.user_id = ? AND djp.renews_until > ?)" +
      " THEN " + GC_SERVERS_JOIN_MAX_PLUS + " ELSE " + GC_SERVERS_JOIN_MAX_FREE + " END)";

async function handleDiscoverJoinRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  const join = await env.GOOBER_DB.prepare(DISCOVER_JOIN_INSERT_SQL)
    .bind(serverId, userId, now, serverId, serverId, userId, userId, userId, now).run();

  if (Number(join.meta?.changes) !== 1) {
    return classifyRefusedJoin(env, serverId, userId, "That server is not open for discovery.", false);
  }

  return json({ joined: true, serverId });
}

// --- phase-3 roles: shared read helpers ---------------------------------------
// The one actor-context read every route-classification needs: the caller's
// string tier, merged role mask, and top position in one statement. It feeds
// ONLY error classification and roster payloads — every write still carries
// its guard inside its own SQL.
const ACTOR_CONTEXT_SQL =
  "SELECT m.role AS role, m.nickname AS nickname, " +
    MERGED_PERMS_SELECT + " AS permissions, " +
    TOP_POSITION_SELECT + " AS position " +
  "FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ? LIMIT 1";

async function readActorContext(env, serverId, userId) {
  const row = await env.GOOBER_DB.prepare(ACTOR_CONTEXT_SQL)
    .bind(serverId, userId, serverId, userId, serverId, userId)
    .first();
  return row === null
    ? null
    : { ...row, permissions: parseMergedMask(row.permissions) };
}

// The avatar payload rides the media module's serving contract (accounts.mjs
// owns the shape): a pending avatar serves only to its uploader, so the
// roster hands out the plain URL and the serving gate keeps visibility.
function avatarUrlOf(row) {
  return row.avatar_mime
    ? "/api/avatars/" + Number(row.id) + "?v=" + Number(row.avatar_version)
    : null;
}

// Role colors share the accent validator's contract: the wire carries a
// strict lowercase #rrggbb hex string or null, enforced both here and by the
// column's GLOB CHECK.
const ROLE_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function validateRoleColor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !ROLE_COLOR_PATTERN.test(value)) {
    throw new HttpError(400, "Role color must be a #rrggbb hex string or null.");
  }
  return value;
}

// Body `permissions` is a list of named bits (the wire form survives schema
// re-orders); unknown names 400, everything else merges into the stored mask.
function permissionsFromNames(names) {
  let mask = 0;
  const list = Array.isArray(names) ? names : [];
  for (const name of list) {
    const bit = SERVER_PERMISSIONS[name];
    if (!bit) throw new HttpError(400, "Unknown permission: " + String(name));
    mask |= bit;
  }
  return mask;
}

// --- phase-3 roles: CRUD -------------------------------------------------------
// A server with no roles row never reaches these routes' gating (the UI only
// renders them after one exists), and CREATE appends at the bottom of the
// position order (MAX + 1). Creation is permission-gated only — assigning or
// editing the new role still obeys the position rule, so a moderator can
// layer powers the hierarchy rule lets them hand out, never powers it
// forbids.

const ROLE_LIST_SQL =
  "SELECT id, name, color, position, permissions FROM gc_roles " +
    "WHERE server_id = ? ORDER BY position DESC, id DESC";

const ROLE_SELECT_SQL =
  "SELECT id, name, color, position, permissions FROM gc_roles " +
    "WHERE id = ? AND server_id = ? LIMIT 1";

async function handleListRolesRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  const viewerId = Number(session.user.id);
  await rateLimit(request, env, "read", "roles:" + serverId + ":" + viewerId);

  const viewer = await readActorContext(env, serverId, viewerId);
  if (!viewer) {
    // One shared 403 (non-members and unknown servers alike — no oracle).
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const { results } = await env.GOOBER_DB.prepare(ROLE_LIST_SQL)
    .bind(serverId).all();

  return json(
    {
      roles: (results || []).map((row) => ({
        id: Number(row.id),
        name: row.name,
        color: row.color,
        position: Number(row.position),
        permissions: permissionNames(row.permissions),
      })),
      viewer: viewerPayload(viewer),
    },
    200,
  );
}

// The roster/roles `viewer` block: what the caller may do here as named bits
// (the UI gates its affordances on it; the server never trusts it).
function viewerPayload(viewer) {
  const owner = viewer.role === "owner";
  const mask = Number(viewer.permissions) || 0;
  return {
    owner,
    // The owner's mask carries every bit (owner bypasses everything).
    permissions: permissionNames(owner ? ALL_SERVER_PERMISSIONS : mask),
    topPosition: Number(viewer.position) || -1,
  };
}

async function handleCreateRoleRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const body = await readJson(request);
  const name = requiredText(body.name, "role name", ROLE_NAME_MAX);
  const color = validateRoleColor(body.color === undefined ? null : body.color);
  const permissions = permissionsFromNames(body.permissions);
  const userId = Number(session.user.id);
  const now = nowSeconds();

  // The authority rider inside the INSERT ... SELECT (owner OR MANAGE_ROLES);
  // the position appends after the current max INSIDE the statement, never a
  // client-roundtripped number.
  const ROLE_INSERT_SQL =
    "INSERT INTO gc_roles (server_id, name, color, position, permissions, created_at) " +
      "SELECT ?, ?, ?, " +
      "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_roles WHERE server_id = ?), ?, ? " +
      "WHERE (" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_ROLES) + ") " +
      "AND (SELECT COUNT(*) FROM gc_roles WHERE server_id = ?) <= " +
        (GC_ROLES_MAX_PER_SERVER - 1);

  const result = await env.GOOBER_DB.prepare(ROLE_INSERT_SQL)
    .bind(
      serverId, name, color, serverId, permissions, now,
      serverId, userId, serverId, userId,
      serverId,
    )
    .run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const role = await env.GOOBER_DB.prepare(ROLE_SELECT_SQL)
    .bind(Number(result.meta.last_row_id), serverId).first();
  if (!role) {
    // Unreachable short of a constraint regression (name/color/permission
    // shape is pre-validated); surfaced instead of a half-built response.
    throw new HttpError(500, "The role could not be created. Please try again.");
  }

  return json({ role: rolePayload(role) }, 201);
}

function rolePayload(row) {
  return {
    id: Number(row.id),
    name: row.name,
    color: row.color,
    position: Number(row.position),
    permissions: permissionNames(row.permissions),
  };
}

// The server's message search (W-B2): a LIKE over the text channels' bodies,
// member-gated and VIEW-gated. The escape discipline rides the SQL's own
// ESCAPE arm — the user's % and _ are LITERALIZED (a query containing them
// matches the characters, never the wildcards) — while the dispatch's
// "word-bounded" reading stays a later lane (SQLite's LIKE cannot express a
// word seam without a padded corpus; GC matches the whole-contains term,
// case-insensitive for ASCII via LIKE's own collation). A server carrying no
// channel overwrites admits every member to every text channel (the
// graceful default, documented at messages.mjs's layer comments) — the
// per-hit VIEW evaluation only runs when overwrites exist at all, so the
// common server spends one read on the question. The route is read-limited
// on the 'read' bucket, never the slowmode.
const SERVER_SEARCH_MEMBERSHIP_SQL =
  "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";
const SERVER_SEARCH_OVERWRITES_SQL =
  "SELECT EXISTS(SELECT 1 FROM gc_channel_overwrites o JOIN gc_channels c " +
    "ON c.id = o.channel_id WHERE c.server_id = ?) AS any_overwrites";
const SERVER_SEARCH_SQL =
  "SELECT m.id AS id, m.channel_id AS channel_id, c.name AS channel_name, " +
    "c.server_id AS server_id, m.author_id AS author_id, " +
    "gu.username AS author_username, m.body AS body, m.created_at AS created_at " +
  "FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id " +
    "JOIN users gu ON gu.id = m.author_id " +
  "WHERE c.kind = 'text' AND c.server_id = ? AND m.body LIKE ? ESCAPE '\\' " +
    "AND EXISTS (SELECT 1 FROM gc_server_members fsm WHERE fsm.server_id = c.server_id " +
      "AND fsm.user_id = ?) ";

async function handleSearchServerRoute(request, env, serverId, url) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "user:" + userId);

  const member = await env.GOOBER_DB.prepare(SERVER_SEARCH_MEMBERSHIP_SQL)
    .bind(serverId, userId).first();
  if (!member) throw new HttpError(403, "You do not have permission to do that.");

  const qRaw = url.searchParams.get("q");
  if (qRaw === null) throw new HttpError(400, "That search term is invalid.");
  const term = qRaw.trim();
  if (term.length < 1 || term.length > GC_SEARCH_TERM_MAX) {
    throw new HttpError(400, "That search term is invalid.");
  }
  // The channel param: an optional single-channel narrowing; malformed ids
  // 400, never silently broadened server-wide.
  const channelRaw = url.searchParams.get("channel");
  let channelId = null;
  if (channelRaw !== null && channelRaw !== "") {
    if (!/^[1-9][0-9]{0,14}$/.test(channelRaw)) {
      throw new HttpError(400, "That channel filter is invalid.");
    }
    channelId = Number(channelRaw);
  }

  const escaped = term.replace(/[\\%_]/g, (ch) => "\\" + ch);
  const sql =
    SERVER_SEARCH_SQL +
    (channelId === null ? "" : "AND c.id = ? ") +
    "ORDER BY m.id DESC LIMIT " + GC_SEARCH_PAGE_MAX;

  const rows = (await env.GOOBER_DB.prepare(sql)
    .bind(
      serverId,
      "%" + escaped + "%",
      userId,
      // The 4th placeholder ONLY exists when the channel arm rode the SQL —
      // a bind must never ride out of step with the placeholder count.
      ...(channelId === null ? [] : [channelId]),
    ).all()).results || [];

  // The VIEW gate: the graceful default's question first (one read), then
  // the per-hit evaluation only when the server carries overwrites at all.
  let hits = rows;
  if (rows.length > 0) {
    const overwrites = await env.GOOBER_DB.prepare(SERVER_SEARCH_OVERWRITES_SQL)
      .bind(serverId).first();
    if (Number(overwrites?.any_overwrites) === 1) {
      const allowed = [];
      for (const row of rows) {
        if (await viewerCanViewChannel(env, { id: row.channel_id, server_id: row.server_id }, userId)) {
          allowed.push(row);
        }
      }
      hits = allowed;
    }
  }

  return json({
    results: hits.map((row) => ({
      id: Number(row.id),
      channelId: Number(row.channel_id),
      channelName: row.channel_name,
      authorId: Number(row.author_id),
      authorUsername: row.author_username,
      body: row.body,
      createdAt: Number(row.created_at),
    })),
  }, 200);
}

async function handleUpdateRoleRoute(request, env, serverId, roleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const actor = await readActorContext(env, serverId, userId);
  if (!actor) throw new HttpError(403, "You do not have permission to do that.");

  const role = await env.GOOBER_DB.prepare(ROLE_SELECT_SQL)
    .bind(roleId, serverId).first();
  if (!role) throw new HttpError(404, "That role does not exist.");

  // Request-shape: name (1-100 — ROLE_NAME_MAX, the 0004 row), color
  // (#rrggbb or null), and/or position.
  // The reads above are only classification + merge; the write below re-runs
  // the whole authority guard inside its own WHERE.
  let name = null;
  let color = undefined; // undefined: untouched (the column may already be NULL)
  let targetPosition = null;
  if (body.name !== undefined) {
    name = requiredText(body.name, "role name", ROLE_NAME_MAX);
  }
  if (Object.hasOwn(body, "color")) {
    color = validateRoleColor(body.color);
  }
  if (body.position !== undefined) {
    if (!Number.isSafeInteger(body.position) || body.position < 0) {
      throw new HttpError(400, "position must be a non-negative integer.");
    }
    targetPosition = body.position;
  }
  if (name === null && color === undefined && targetPosition === null) {
    throw new HttpError(400, "Nothing to change. Send a name, a color, or a position.");
  }

  // The hierarchy rule, re-asserted against the CURRENT row and (for a move)
  // the DESTINATION position: a member cannot act on a role at a position
  // greater or equal to their own highest.
  const owner = actor.role === "owner";
  const actorTop = highestPosition([actor]);
  if (!canManageRoleAt(owner, actorTop, Number(role.position))) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  if (targetPosition !== null) {
    // Moving to an occupied slot is a SWAP (batched, both statements
    // position-guarded, so nothing collides); a free slot is a plain move.
    const maxRow = await env.GOOBER_DB.prepare(
      "SELECT COALESCE(MAX(position), -1) AS max_position FROM gc_roles WHERE server_id = ?",
    ).bind(serverId).first();
    const maxPosition = Number(maxRow?.max_position ?? -1);
    if (targetPosition > maxPosition) {
      throw new HttpError(
        400, "position must be between 0 and " + maxPosition + ".");
    }
    const partner = targetPosition === Number(role.position)
      ? null
      : await env.GOOBER_DB.prepare(
          "SELECT id FROM gc_roles WHERE server_id = ? AND position = ? AND id <> ? LIMIT 1",
        ).bind(serverId, targetPosition, roleId).first();

    // H2 (RBAC audit): the DESTINATION slot's hierarchy check rides BOTH
    // paths — the free-slot move used to check only the role's CURRENT
    // position, so a below-top role could climb through a deletion gap above
    // the actor's top. (On an exact self-move the check repeats the one that
    // already passed; harmless.)
    if (!canManageRoleAt(owner, actorTop, targetPosition)) {
      throw new HttpError(403, "You do not have permission to do that.");
    }

    const guard = roleManageGuardSql(serverId, userId, SERVER_PERMISSIONS.MANAGE_ROLES);
    const statements = [
      env.GOOBER_DB.prepare(
        "UPDATE gc_roles SET position = ? WHERE id = ? AND server_id = ? AND position = ? AND " + guard.sql,
      ).bind(targetPosition, roleId, serverId, Number(role.position), ...guard.params),
    ];
    if (partner) {
      statements.push(
        env.GOOBER_DB.prepare(
          "UPDATE gc_roles SET position = ? WHERE id = ? AND server_id = ? AND position = ? AND " + guard.sql,
        ).bind(Number(role.position), Number(partner.id), serverId, targetPosition, ...guard.params),
      );
    }
    const results = await env.GOOBER_DB.batch(statements);
    if (Number(results[0]?.meta?.changes) !== 1) {
      // The role row moved under us (or the guard refused after all): the
      // shared 403 says so without probing anything else.
      throw new HttpError(403, "You do not have permission to do that.");
    }
  } else {
    // Rename / recolor: the position precondition rides the same WHERE as the
    // authority guard (gc_roles.position < the caller's top).
    const setClauses = [];
    const binds = [];
    if (name !== null) {
      setClauses.push("name = ?");
      binds.push(name);
    }
    if (color !== undefined) {
      setClauses.push("color = ?");
      binds.push(color);
    }
    const guard = roleManageGuardSql(serverId, userId, SERVER_PERMISSIONS.MANAGE_ROLES);
    const result = await env.GOOBER_DB.prepare(
      "UPDATE gc_roles SET " + setClauses.join(", ") +
        " WHERE id = ? AND server_id = ? AND " + guard.sql,
    ).bind(...binds, roleId, serverId, ...guard.params).run();

    if (Number(result.meta?.changes) !== 1) {
      throw new HttpError(403, "You do not have permission to do that.");
    }
  }

  const updated = await env.GOOBER_DB.prepare(ROLE_SELECT_SQL)
    .bind(roleId, serverId).first();

  return json({ role: updated ? rolePayload(updated) : null }, 200);
}

async function handleDeleteRoleRoute(request, env, serverId, roleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // ONE batch: the guarded role delete (its WHERE carries the authority AND
  // the position rule), then the assignment fan-out — which only touches
  // rows when the role row itself vanished (NOT EXISTS), so a refused delete
  // can never strand an assignment delete ahead of it.
  const guard = roleManageGuardSql(serverId, userId, SERVER_PERMISSIONS.MANAGE_ROLES);
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_roles WHERE id = ? AND server_id = ? AND " + guard.sql,
    ).bind(roleId, serverId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE role_id = ? AND server_id = ? " +
        "AND NOT EXISTS (SELECT 1 FROM gc_roles WHERE id = ? AND server_id = ?)",
    ).bind(roleId, serverId, roleId, serverId),
  ]);

  if (Number(results[0]?.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ deleted: true, roleId }, 200);
}

// --- phase-3 roles: assignment (roles/:id/members/:user_id) --------------------

const ASSIGNMENT_SELECT_SQL =
  "SELECT role_id FROM gc_member_roles WHERE server_id = ? AND user_id = ? AND role_id = ? LIMIT 1";

async function handleAssignRoleRoute(request, env, serverId, roleId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // Classification reads first (only messages — the INSERT below re-runs the
  // whole rule): the role must exist in this server…
  const role = await env.GOOBER_DB.prepare(ROLE_SELECT_SQL).bind(roleId, serverId).first();
  if (!role) throw new HttpError(404, "That role does not exist.");
  // …the target must be a server member…
  const target = await env.GOOBER_DB.prepare(
    "SELECT (SELECT COALESCE(MAX(hr.position), -1) " +
      "FROM gc_member_roles hmr JOIN gc_roles hr ON hr.id = hmr.role_id " +
      "WHERE hmr.server_id = ? AND hmr.user_id = ?) AS position " +
      "FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, targetUserId, serverId, targetUserId).first();
  if (!target) throw new HttpError(404, "That member is not in this server.");
  // …and re-assigning is idempotent, never an error.
  const existing = await env.GOOBER_DB.prepare(ASSIGNMENT_SELECT_SQL)
    .bind(serverId, targetUserId, roleId).first();
  if (existing) {
    return json({ assigned: true, changed: false, roleId, userId: targetUserId }, 200);
  }

  // The guarded INSERT: assignment authority = owner OR MANAGE_ROLES, with
  // the position rule pinned INSIDE the statement (role position strictly
  // below the assigner's top position). No read-then-write gate anywhere.
  const ASSIGN_INSERT_SQL =
    "INSERT OR IGNORE INTO gc_member_roles (server_id, user_id, role_id) " +
      "SELECT ?, ?, ? WHERE EXISTS (" +
        "SELECT 1 FROM gc_server_members tm WHERE tm.server_id = ? AND tm.user_id = ?" +
      ") AND (" + OWNER_EXISTS_SQL + " OR (" +
        holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_ROLES) + " AND " +
        "(SELECT position FROM gc_roles WHERE id = ? AND server_id = ?) < " +
        TOP_POSITION_SELECT + "))";

  const result = await env.GOOBER_DB.prepare(ASSIGN_INSERT_SQL)
    .bind(
      serverId, targetUserId, roleId, serverId, targetUserId,
      serverId, userId, serverId, userId,
      roleId, serverId, serverId, userId,
    )
    .run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ assigned: true, changed: true, roleId, userId: targetUserId }, 201);
}

async function handleUnassignRoleRoute(request, env, serverId, roleId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The guarded DELETE: the same WHERE shape as assignment (owner OR
  // MANAGE_ROLES + the role sits strictly below the caller's top position).
  const UNASSIGN_DELETE_SQL =
    "DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? AND role_id = ? AND (" +
      OWNER_EXISTS_SQL + " OR (" +
      holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_ROLES) + " AND " +
      "(SELECT position FROM gc_roles WHERE id = ? AND server_id = ?) < " +
      TOP_POSITION_SELECT + "))";

  const result = await env.GOOBER_DB.prepare(UNASSIGN_DELETE_SQL)
    .bind(
      serverId, targetUserId, roleId,
      serverId, userId, serverId, userId,
      roleId, serverId, serverId, userId,
    )
    .run();

  if (Number(result.meta?.changes) !== 1) {
    // Refusal and not-assigned share one 403: another member's role state
    // stays unread this way.
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ assigned: false, roleId, userId: targetUserId }, 200);
}

// --- GET /api/servers/:id/roster (the member-list payload) ---------------------

async function handleRosterRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  const viewerId = Number(session.user.id);

  // Server-scoped read limiter: the roster is the member-listing endpoint the
  // UI re-reads, so its identity carries both sides of the (server, user)
  // pair — one noisy server can never exhaust another's budget.
  await rateLimit(request, env, "read", "roster:" + serverId + ":" + viewerId);

  const viewer = await readActorContext(env, serverId, viewerId);
  if (!viewer) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  // One membership-scoped query per concern; the member list itself is the
  // payload the filed gap asks for. Roles/colors ride with the payload only
  // because VIEW is implicit for every member (the graceful default). The
  // mod desk's per-member columns (0008) ride the same JOIN: joined-at, the
  // account age's source (users.created_at), the live timeout, and the join
  // attribution.
  const { results: memberRows } = await env.GOOBER_DB.prepare(
    "SELECT u.id AS id, u.username AS username, m.role AS membership_role, m.nickname AS nickname, " +
      "u.avatar_mime AS avatar_mime, u.avatar_version AS avatar_version, " +
      "m.joined_at AS joined_at, u.created_at AS account_created_at, " +
      "m.timed_out_until AS timed_out_until, m.rules_accepted_at AS rules_accepted_at, " +
      "m.created_by_invite AS created_by_invite, " + plusActiveExpr("u.id") + " " +
      "FROM gc_server_members m JOIN users u ON u.id = m.user_id " +
      "WHERE m.server_id = ? ORDER BY u.id",
  ).bind(nowSeconds(), serverId).all();
  const { results: roleRows } = await env.GOOBER_DB.prepare(
    ROLE_LIST_SQL,
  ).bind(serverId).all();
  const { results: assignmentRows } = await env.GOOBER_DB.prepare(
    "SELECT user_id, role_id FROM gc_member_roles WHERE server_id = ?",
  ).bind(serverId).all();

  // The mod desk's per-member "verification eligibility already resolved"
  // needs the server's current level; a pre-0008 (or never-set) column reads
  // as 0 = none and the whole question disappears. The rules gate's ON flag
  // (0012) rides the same read — the desk's per-member badges key on it.
  const serverRow = await env.GOOBER_DB.prepare(
    "SELECT verification_level, rules_text IS NOT NULL AS rules_on FROM gc_servers WHERE id = ? LIMIT 1",
  ).bind(serverId).first();
  const verificationLevel = Number(serverRow?.verification_level) || 0;
  const rulesOn = Number(serverRow?.rules_on) === 1;

  // roleIds are listed strongest-first (roles arrive position DESC), so the
  // first id IS the highest role and its color is the member's chat color.
  const byRolePosition = new Map((roleRows || []).map((row, index) => [Number(row.id), index]));
  const assignments = new Map();
  for (const row of assignmentRows || []) {
    const userId = Number(row.user_id);
    const list = assignments.get(userId) || [];
    list.push(Number(row.role_id));
    assignments.set(userId, list);
  }

  const members = (memberRows || []).map((row) => {
    const ids = (assignments.get(Number(row.id)) || [])
      .filter((roleId) => byRolePosition.has(roleId))
      .sort((a, b) => byRolePosition.get(a) - byRolePosition.get(b));
    const topRole = ids.length > 0
      ? (roleRows || []).find((role) => Number(role.id) === ids[0])
      : null;
    // The mod desk's per-member fields (0008), present-when-relevant: joinedAt
    // and the account-age source always ride (the members page reads them);
    // the timeout and the invite attribution ride ONLY when set, and the
    // verification eligibility rides ONLY when the server has a level on.
    const memberId = Number(row.id);
    const memberMask = (assignments.get(memberId) || [])
      .reduce((all, roleId) => all | (Number(
        (roleRows || []).find((role) => Number(role.id) === Number(roleId))?.permissions,
      ) || 0), 0);
    const bypassesVerification =
      row.membership_role === "owner" ||
      (memberMask & SERVER_PERMISSIONS.KICK_MEMBERS) === SERVER_PERMISSIONS.KICK_MEMBERS;
    const verificationFailed = verificationLevel > 0 && !bypassesVerification
      ? enforceVerificationLevel(
          verificationLevel, Number(row.account_created_at), Number(row.joined_at), nowSeconds(),
        ) !== null
      : false;
    return {
      id: Number(row.id),
      username: row.username,
      nickname: row.nickname ?? null,
      avatarUrl: avatarUrlOf(row),
      membershipRole: row.membership_role,
      isPlus: publicIsPlus(row),
      roleIds: ids,
      color: topRole?.color ?? null,
      topPosition: topRole ? Number(topRole.position) : -1,
      joinedAt: isoTimestamp(row.joined_at),
      accountCreatedAt: isoTimestamp(row.account_created_at),
      ...(Number(row.timed_out_until) > 0
        ? { timedOutUntil: isoTimestamp(row.timed_out_until) }
        : {}),
      // The rules gate (0012): the acceptance badge rides only when the
      // server actually has a gate on (a gate-off server's rows never move).
      ...(rulesOn ? { rulesAccepted: Number(row.rules_accepted_at) > 0 } : {}),
      ...(row.created_by_invite ? { createdByInvite: row.created_by_invite } : {}),
      ...(verificationLevel > 0 ? { verificationEligible: !verificationFailed } : {}),
    };
  });

  // The mod desk's bans (0008): the roster carries them ONLY for the members
  // page's viewer class (owner or KICK_MEMBERS) — they are ex-members, so a
  // plain member's list never includes the section at all.
  const kickAuthority = viewer.role === "owner" ||
    ((Number(viewer.permissions) || 0) & SERVER_PERMISSIONS.KICK_MEMBERS) ===
      SERVER_PERMISSIONS.KICK_MEMBERS;
  const payload = {
    server: {
      id: serverId,
      ...(verificationLevel > 0 ? { verificationLevel } : {}),
      ...(rulesOn ? { hasRules: true } : {}),
    },
    viewer: viewerPayload(viewer),
    roles: (roleRows || []).map(rolePayload),
    members,
  };
  if (kickAuthority) {
    const { results: banRows } = await env.GOOBER_DB.prepare(
      "SELECT b.user_id AS user_id, u.username AS username, b.reason AS reason, b.created_at AS created_at " +
        "FROM gc_server_bans b JOIN users u ON u.id = b.user_id " +
        "WHERE b.server_id = ? ORDER BY b.user_id",
    ).bind(serverId).all();
    payload.bans = (banRows || []).map((row) => ({
      id: Number(row.user_id),
      username: row.username,
      reason: row.reason ?? null,
      bannedAt: isoTimestamp(row.created_at),
    }));
  }

  return json(payload, 200);
}

// --- phase-3 nicknames (CHANGE is free; Manage rides the hierarchy) ------------

function nicknameFromBody(body) {
  // null (or an empty string) clears the nickname; a set value is 1-32 chars,
  // mirroring the column's trim CHECK.
  if (body.nickname === null || body.nickname === "") return null;
  if (body.nickname === undefined) {
    throw new HttpError(400, "Nothing to change. Send a nickname (or null to clear it).");
  }
  return requiredText(body.nickname, "nickname", NICKNAME_MAX);
}

// --- 0010: the filter's nickname screen ---------------------------------------
//
// The value changes ride the SAME screen on both nickname routes: the global
// word list first (the username standard the register flow runs — masking
// pass and normalized handle), then THIS server's name-class rules (the
// check_names rows only). A hit is the one shared 400 ("That name isn't
// allowed.") — never a 403, so the shape of the answer never reveals which
// rule tripped. A null nickname (a clear) screens nothing.
async function nicknameIsFiltered(env, serverId, nickname) {
  if (nickname === null) return false;
  await ensureFilterWords(env);
  const words = filterWords(env);
  if (typeof words === "string" && words.trim() !== "") {
    if (applyWordFilter(nickname, words) !== nickname) return true;
    if (containsFilteredWord(normalizeUsernameForFilter(nickname), words)) return true;
  }
  const rules = await loadServerRules(env, serverId);
  return nameRuleHit(rules, nickname);
}

async function handleSetOwnNicknameRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // Modest limiter (Discord's own cadence), riding the write tier.
  await rateLimit(request, env, "write", "nick:" + serverId + ":" + userId);

  const nickname = nicknameFromBody(await readJson(request));

  if (await nicknameIsFiltered(env, serverId, nickname)) {
    throw new HttpError(400, FILTERED_NAME_ERROR);
  }

  // CHANGE-NICKNAME is implied for every member (the filed split): the only
  // precondition is the membership row itself.
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET nickname = ? WHERE server_id = ? AND user_id = ?",
  ).bind(nickname, serverId, userId).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ member: { serverId, userId, nickname } }, 200);
}

async function handleSetMemberNicknameRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "nick:" + serverId + ":" + userId);
  const nickname = nicknameFromBody(await readJson(request));

  // The same screen the self-rename runs (0010): the member rename cannot
  // set a display name the member could not have set themselves.
  if (await nicknameIsFiltered(env, serverId, nickname)) {
    throw new HttpError(400, FILTERED_NAME_ERROR);
  }

  // MANAGE-NICKNAME = KICK_MEMBERS + MANAGE_ROLES, position rule inside the
  // statement (the target must sit strictly below the caller; the owner row
  // is never renamed away from its identity).
  const guard = moderationGuardSql(serverId, userId, targetUserId, [
    SERVER_PERMISSIONS.KICK_MEMBERS,
    SERVER_PERMISSIONS.MANAGE_ROLES,
  ]);
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET nickname = ? WHERE server_id = ? AND user_id = ? " +
      "AND role <> 'owner' AND " + guard.sql,
  ).bind(nickname, serverId, targetUserId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ member: { serverId, userId: targetUserId, nickname } }, 200);
}

// --- 0010: the per-server filter rules (the AutoMod desk) ----------------------
//
// Every write's authorization rides INSIDE the SQL like every other write in
// this module: the rules desk's guard is the members-desk viewer class (the
// string-tier owner or moderator, OR any KICK_MEMBERS holder — the same
// class that sees the alerts feed, and the same class the checklist names as
// structurally exempt from the filter). Binds, in fragment order:
// serverId, userId (the row class), serverId, userId (the per-bit role
// EXISTS). Zero changes → 403 (with the one
// diagnostic pick between 403 and 400 where a second failure class exists:
// the create's per-server rule cap).
//
// The intake mirrors Discord's AutoMod rule shape at GC scale (the filed
// caps): a name, the TERM LIST (one per line or an array — wildcard stars,
// /regex/ terms compile-checked HERE, plain text otherwise), combinable
// actions from block|alert|timeout, the care flag (its actions are ignored —
// care never acts), the check_names flag (the nickname screen), the exempt
// role/channel ids (validated as THIS server's), and the block message the
// blocked member alone sees.

const FILTER_RULES_GUARD_SQL =
  "(EXISTS (SELECT 1 FROM gc_server_members fg WHERE fg.server_id = ? AND fg.user_id = ? " +
    "AND fg.role IN ('owner','moderator')) OR " +
  holdsRolesBitsSql(SERVER_PERMISSIONS.KICK_MEMBERS) + ")";

// The four binds the guard always wants: the row class's (server, userId)
// pair, then the per-bit EXISTS's pair.
function filterRulesGuardParams(serverId, userId) {
  return [
    serverId, userId,
    ...holdsRolesBitsParams(serverId, userId, SERVER_PERMISSIONS.KICK_MEMBERS),
  ];
}

// The exemption ids must be THIS server's — a rule can never exempt a role
// or channel from another server. Unknown ids 400 (the intake's clear error)
// rather than silently storing an inert exemption. The list length is the
// parity cap (≤ 20 roles / ≤ 50 channels, docs/parity-limits.md AutoMod) —
// the guard rides BEFORE the membership read, so an oversized list never
// spends a query.
async function validExemptIds(env, serverId, ids, sql, message, cap) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, message);
  const requested = ids.map((id) => Number(id));
  for (const id of requested) {
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, message);
  }
  if (requested.length > cap) {
    throw new HttpError(400, "That list is too long — at most " + cap + ".");
  }
  const results = (await env.GOOBER_DB.prepare(sql).bind(serverId).all()).results || [];
  const valid = new Set(results.map((row) => Number(row.id)));
  for (const id of requested) {
    if (!valid.has(id)) throw new HttpError(400, message);
  }
  return requested;
}

function filterRuleBodyFrom(env, serverId, body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "A filter rule needs a name and at least one term.");
  }
  const name = requiredText(body.name, "rule name", 64);
  const isCare = body.isCare === true;
  const checkNames = body.checkNames === true;
  const terms = termsFromBody(body.terms, { maxPatterns: FILTER_RULE_MAX_PATTERNS });

  let actions = ["block"];
  if (body.actions !== undefined) {
    if (!Array.isArray(body.actions)) throw new HttpError(400, "actions must be an array.");
    for (const action of body.actions) {
      if (!FILTER_RULE_ACTIONS.includes(action)) {
        throw new HttpError(400, "actions rides one or more of " + FILTER_RULE_ACTIONS.join(", ") + ".");
      }
    }
    // De-duped, order kept (block|alert|timeout are combinable).
    actions = FILTER_RULE_ACTIONS.filter((action) => body.actions.includes(action));
  }
  if (isCare) actions = []; // care NEVER acts (the owner decision)

  let blockMessage = null;
  if (body.blockMessage === undefined || body.blockMessage === null || body.blockMessage === "") {
    blockMessage = null;
  } else {
    if (typeof body.blockMessage !== "string") throw new HttpError(400, "blockMessage must be a string.");
    blockMessage = requiredText(
      body.blockMessage, "block message", FILTER_RULE_BLOCK_MESSAGE_MAX,
    );
  }

  let timeoutMinutes = null;
  if (body.timeoutMinutes !== undefined && body.timeoutMinutes !== null) {
    if (!TIMEOUT_MINUTE_CHOICES.includes(body.timeoutMinutes)) {
      throw new HttpError(400, "timeoutMinutes must be one of " + TIMEOUT_MINUTE_CHOICES.join(", ") + ".");
    }
    timeoutMinutes = body.timeoutMinutes;
  }
  if (!isCare && actions.includes("timeout") && timeoutMinutes === null) {
    timeoutMinutes = FILTER_RULE_DEFAULT_TIMEOUT_MINUTES; // the mod desk's own default
  }

  return { name, isCare, checkNames, terms, actions, blockMessage, timeoutMinutes };
}

const FILTER_RULE_CREATE_SQL =
  "INSERT INTO gc_filter_rules (" +
    "server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions, " +
    "is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at" +
  ") SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_servers fs WHERE fs.id = ?) AND " +
  FILTER_RULES_GUARD_SQL + " AND " +
  "(SELECT COUNT(*) FROM gc_filter_rules fc WHERE fc.server_id = ?) < " + FILTER_RULE_MAX_RULES;

const FILTER_RULE_SELECT_SQL =
  "SELECT id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions, " +
    "is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at " +
  "FROM gc_filter_rules";

async function ruleFromRow(env, serverId, ruleId) {
  const row = await env.GOOBER_DB.prepare(
    FILTER_RULE_SELECT_SQL + " WHERE server_id = ? AND id = ? LIMIT 1",
  ).bind(serverId, ruleId).first();
  return row ? publicRule(row) : null;
}

async function handleListFilterRulesRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  // One guarded read: the viewer class's WHERE rides the same shape every
  // read in this module takes.
  const rows = (await env.GOOBER_DB.prepare(
    FILTER_RULE_SELECT_SQL + " WHERE server_id = ? AND " + FILTER_RULES_GUARD_SQL + " ORDER BY id",
  ).bind(serverId, ...filterRulesGuardParams(serverId, userId)).all()).results || [];
  return json({ rules: rows.map((row) => publicRule(row)) }, 200);
}

async function handleCreateFilterRuleRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const parsed = filterRuleBodyFrom(env, serverId, body);
  const exemptRoleIds = await validExemptIds(env, serverId, body.exemptRoleIds,
    "SELECT id FROM gc_roles WHERE server_id = ?", "exemptRoleIds must be role ids of this server.",
    FILTER_RULE_EXEMPT_ROLES_MAX);
  const exemptChannelIds = await validExemptIds(env, serverId, body.exemptChannelIds,
    "SELECT id FROM gc_channels WHERE server_id = ?",
    "exemptChannelIds must be channel ids of this server.",
    FILTER_RULE_EXEMPT_CHANNELS_MAX);
  const now = nowSeconds();

  const result = await env.GOOBER_DB.prepare(FILTER_RULE_CREATE_SQL).bind(
    serverId, parsed.name, JSON.stringify(parsed.terms),
    JSON.stringify(exemptRoleIds), JSON.stringify(exemptChannelIds),
    JSON.stringify(parsed.actions), parsed.isCare ? 1 : 0, parsed.checkNames ? 1 : 0,
    parsed.blockMessage, parsed.timeoutMinutes, userId, now, now,
    // The guard's own binds + the cap's server bind.
    serverId, ...filterRulesGuardParams(serverId, userId), serverId,
  ).run();

  if (Number(result.meta?.changes) === 1) {
    dropServerRulesCache(serverId);
    return json({ rule: await ruleFromRow(env, serverId, Number(result.meta?.last_row_id)) }, 201);
  }

  // Diagnostic only (the INSERT's guard decided): the cap is the one second
  // failure class a create has.
  const count = await env.GOOBER_DB.prepare(
    "SELECT COUNT(*) AS count FROM gc_filter_rules WHERE server_id = ?",
  ).bind(serverId).first();
  if (Number(count?.count) >= FILTER_RULE_MAX_RULES) {
    throw new HttpError(400, "This server already has " + FILTER_RULE_MAX_RULES + " filter rules.");
  }
  throw new HttpError(403, "You do not have permission to do that.");
}

async function handleUpdateFilterRuleRoute(request, env, serverId, ruleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const parsed = filterRuleBodyFrom(env, serverId, body);
  const exemptRoleIds = await validExemptIds(env, serverId, body.exemptRoleIds,
    "SELECT id FROM gc_roles WHERE server_id = ?", "exemptRoleIds must be role ids of this server.",
    FILTER_RULE_EXEMPT_ROLES_MAX);
  const exemptChannelIds = await validExemptIds(env, serverId, body.exemptChannelIds,
    "SELECT id FROM gc_channels WHERE server_id = ?",
    "exemptChannelIds must be channel ids of this server.",
    FILTER_RULE_EXEMPT_CHANNELS_MAX);

  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_filter_rules SET " +
      "name = ?, terms = ?, exempt_role_ids = ?, exempt_channel_ids = ?, actions = ?, " +
      "is_care = ?, check_names = ?, block_message = ?, timeout_minutes = ?, updated_at = ? " +
    "WHERE server_id = ? AND id = ? AND " + FILTER_RULES_GUARD_SQL,
  ).bind(
    parsed.name, JSON.stringify(parsed.terms),
    JSON.stringify(exemptRoleIds), JSON.stringify(exemptChannelIds),
    JSON.stringify(parsed.actions), parsed.isCare ? 1 : 0, parsed.checkNames ? 1 : 0,
    parsed.blockMessage, parsed.timeoutMinutes, nowSeconds(),
    serverId, ruleId, ...filterRulesGuardParams(serverId, userId),
  ).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  dropServerRulesCache(serverId);
  return json({ rule: await ruleFromRow(env, serverId, ruleId) }, 200);
}

async function handleDeleteFilterRuleRoute(request, env, serverId, ruleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_filter_rules WHERE server_id = ? AND id = ? AND " + FILTER_RULES_GUARD_SQL,
  ).bind(serverId, ruleId, ...filterRulesGuardParams(serverId, userId)).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  dropServerRulesCache(serverId);
  return json({ deleted: true, serverId, id: ruleId }, 200);
}

async function handleListFilterAlertsRoute(request, env, serverId, url) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw !== null && limitRaw !== "") {
    if (
      !/^[0-9]{1,3}$/.test(limitRaw) ||
      Number(limitRaw) < 1 ||
      Number(limitRaw) > FILTER_ALERTS_PAGE_MAX
    ) {
      throw new HttpError(400, "That alerts limit is invalid.");
    }
    limit = Number(limitRaw);
  }
  const rows = (await env.GOOBER_DB.prepare(
    "SELECT ga.id, ga.server_id, ga.channel_id, ga.message_id, ga.user_id, " +
      "ga.rule_id, ga.rule_name, ga.matched, ga.body, ga.created_at, " +
      "gu.username AS username " +
    "FROM gc_filter_alerts ga JOIN users gu ON gu.id = ga.user_id " +
    "WHERE ga.server_id = ? AND " + FILTER_RULES_GUARD_SQL + " " +
    "ORDER BY ga.id DESC LIMIT " + limit,
  ).bind(serverId, ...filterRulesGuardParams(serverId, userId)).all()).results || [];
  return json({
    alerts: rows.map((row) => ({
      id: Number(row.id),
      serverId: Number(row.server_id),
      channelId: row.channel_id === null ? null : Number(row.channel_id),
      messageId: row.message_id === null ? null : Number(row.message_id),
      userId: Number(row.user_id),
      username: row.username,
      ruleId: row.rule_id === null ? null : Number(row.rule_id),
      ruleName: row.rule_name,
      matched: row.matched,
      body: row.body,
      createdAt: isoTimestamp(row.created_at),
    })),
  }, 200);
}

// --- phase-3 kicks (KICK_MEMBERS + the position rule, batched) ------------------

async function handleKickMemberRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-kick:" + serverId + ":" + userId);

  // ONE batch mirroring leave's cycle-7 shape with the kick guard: the
  // member's role assignments, the kicked booster's gc_server_boosts row, and
  // the membership row leave together, and the boost recount rides in-batch
  // last. ORDER IS LOAD-BEARING (D1's batch is one sequential transaction —
  // the same class leave's strips rely on): the strips ride BEFORE the
  // member-row delete, because their membership-EXISTS arms go false the
  // moment that delete fires — a member-first batch commits them as refuted
  // zero-changes no-ops, and the surviving boost row would keep counting
  // toward the boost level (the caps the kicked booster grants) and re-grant
  // on rejoin via the guarded boost INSERT's DO NOTHING. Each strip carries
  // the SAME arm (the target's membership-EXISTS with the role <> 'owner'
  // rider — kick's mirror of the timeout routes' arm: one clause that is
  // both the membership arm the ordering needs and the owner immunity a
  // refused kick needs) plus the SAME moderation guard, so a refused kick —
  // an owner target included — strips nothing. The verdict reads the
  // member-row delete's changes (results[2]); the race path is intact — a
  // vanished row refutes the strips at batch start AND deletes 0, and the
  // shared 403 answers as before.
  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members ks " +
          "WHERE ks.server_id = ? AND ks.user_id = ? AND ks.role <> 'owner') AND " + guard.sql,
    ).bind(serverId, targetUserId, serverId, targetUserId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members ks " +
          "WHERE ks.server_id = ? AND ks.user_id = ? AND ks.role <> 'owner') AND " + guard.sql,
    ).bind(serverId, targetUserId, serverId, targetUserId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ? " +
        "AND role <> 'owner' AND " + guard.sql,
    ).bind(serverId, targetUserId, ...guard.params),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);

  if (Number(results[2]?.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ kicked: true, serverId, userId: targetUserId }, 200);
}

// --- phase-3 mod desk: bans (the invalid-invite taxonomy's BANNED case) --------
//
// A ban is kick + a ban flag the join routes check, so a valid invite can't
// re-admit a banned account. Bans are a SEPARATE flow from the kick route
// (kick stays kick), and the authority is the same: KICK_MEMBERS with the
// position rule (no ban on a holder above the actor; the owner is immune and
// the owner bypasses). Un-banning removes the row; the roster hands the list
// to the members page and no IP model exists (filed: account bans only).

function banReasonFrom(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "A ban reason must be a non-empty string or omitted.");
  }
  const reason = value.trim();
  if (reason.length > BAN_REASON_MAX) {
    throw new HttpError(400, "A ban reason must be at most " + BAN_REASON_MAX + " characters.");
  }
  return reason;
}

async function handleBanMemberRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The write wall keyed caller-first (the leave/transfer idiom): a
  // bad-shaped body spends the same bucket, the shared-bucket lesson.
  await rateLimit(request, env, "write", "servers-ban:" + serverId + ":" + userId);
  const body = await readJson(request);

  // No coercion: a string "22" is a request-shape error, not a user id.
  if (!Number.isSafeInteger(body.user_id) || body.user_id < 1) {
    throw new HttpError(400, "user_id must be a user id.");
  }
  const targetUserId = body.user_id;
  if (targetUserId === userId) {
    throw new HttpError(400, "You cannot ban yourself.");
  }
  const reason = banReasonFrom(body.reason);
  const now = nowSeconds();

  // ONE batch under the SAME guard: the ban row (its WHERE carries the user
  // EXISTS, the not-already-banned NOT EXISTS, the owner-immune rider — a
  // -1-sentinel owner row would otherwise fall under the position rule — and
  // the moderation guard) and the kick-style fan-out, whose two deletes ride a
  // "ban row now exists" rider so a refused ban can never kick a member who
  // stayed — and the SAME rider carries the boost strip (cycle-9: a banned
  // booster's gc_server_boosts row leaves in-batch, before the member delete,
  // or it keeps counting toward gc_servers.boosts and re-grants on rejoin).
  // The recount derives from the stripped set in-batch LAST.
  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "INSERT INTO gc_server_bans (server_id, user_id, created_by, reason, created_at) " +
        "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users bu WHERE bu.id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_server_members tb WHERE tb.server_id = ? AND tb.user_id = ? " +
          "AND tb.role = 'owner') AND " +
        guard.sql,
    ).bind(
      serverId, targetUserId, userId, reason, now, targetUserId,
      serverId, targetUserId, serverId, targetUserId, ...guard.params,
    ),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND user_id = ? AND " +
        "EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)",
    ).bind(serverId, targetUserId, serverId, targetUserId),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ? AND role <> 'owner' AND " +
        "EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)",
    ).bind(serverId, targetUserId, serverId, targetUserId),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? AND " +
        "EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)",
    ).bind(serverId, targetUserId, serverId, targetUserId),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);

  if (Number(results[0]?.meta?.changes) !== 1) {
    // Diagnostic only: the INSERT's guard decided. A ban already standing is
    // the idempotent answer, everyone else gets the shared 403.
    const existing = await env.GOOBER_DB.prepare(
      "SELECT reason, created_at FROM gc_server_bans WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, targetUserId).first();
    if (existing) {
      return json(
        {
          ban: {
            serverId, userId: targetUserId,
            reason: existing.reason ?? null,
            bannedAt: isoTimestamp(existing.created_at),
          },
          changed: false,
        },
        200,
      );
    }
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json(
    { ban: { serverId, userId: targetUserId, reason, bannedAt: isoTimestamp(now) }, changed: true },
    201,
  );
}

async function handleUnbanMemberRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-unban:" + serverId + ":" + userId);

  // The guarded DELETE: owner OR KICK_MEMBERS. Un-banning is not bound by the
  // position rule (a banned account is not a member to outrank anymore), and
  // not-banned refusals share the one 403 with refused authority — no oracle.
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_server_bans WHERE server_id = ? AND user_id = ? AND (" +
      OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.KICK_MEMBERS) + ")",
  ).bind(
    serverId, targetUserId,
    serverId, userId, serverId, userId,
  ).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ banned: false, serverId, userId: targetUserId }, 200);
}

// --- phase-3 mod desk: timeouts (the time-out FAQ) ------------------------------
//
// Kick-lite with an expiry on the membership row. The PUT sets
// timed_out_until from the filed duration menu (minutes); the DELETE removes
// it at any time (NULL). Both are owner OR KICK_MEMBERS with the position
// rule pinned inside the statement: no timeout on a holder above the actor,
// the owner row is immune, and the owner bypasses. The three gates the state
// enforces live elsewhere — the send path (api/messages.mjs), the voice-join
// door (api/ws.mjs), and reactions when they ship.

async function handleSetTimeoutRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-timeout:" + serverId + ":" + userId);
  const body = await readJson(request);

  if (!TIMEOUT_MINUTE_CHOICES.includes(body.minutes)) {
    throw new HttpError(400, "minutes must be one of " + TIMEOUT_MINUTE_CHOICES.join(", ") + ".");
  }

  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const until = nowSeconds() + body.minutes * 60;
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET timed_out_until = ? WHERE server_id = ? AND user_id = ? " +
      "AND role <> 'owner' AND " + guard.sql,
  ).bind(until, serverId, targetUserId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json(
    { member: { serverId, userId: targetUserId, timedOutUntil: isoTimestamp(until) } },
    200,
  );
}

async function handleRemoveTimeoutRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-untimeout:" + serverId + ":" + userId);

  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET timed_out_until = NULL WHERE server_id = ? AND user_id = ? " +
      "AND role <> 'owner' AND " + guard.sql,
  ).bind(serverId, targetUserId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ member: { serverId, userId: targetUserId, timedOutUntil: null } }, 200);
}

// --- phase-3 mod desk: member prune (the how-to-prune guide) --------------------
//
// Step 1 (dry_run) is ONE preview COUNT — cheap and kind; step 2 executes the
// kick as a batch of two deletes, both carrying the SAME candidate predicate
// and the SAME moderation guard (the kick route's shape, with the candidate
// set inside the WHERE). Candidates: members whose JOIN predates the cutoff
// with NO message activity in this server (the filed derivable signal: any
// gc_messages row via one of the server's channels), never the owner, and —
// for a non-owner actor — never a holder whose position is >= the actor's.

// The prune's per-statement candidates: the activity NOT EXISTS (no message
// by that member through any of this server's channels) and the role-filter
// EXISTS ("also include members with these roles"). Both statements reuse
// them by table alias — m.
function pruneActivitySql() {
  return "NOT EXISTS (SELECT 1 FROM gc_messages pa JOIN gc_channels pc ON pc.id = pa.channel_id " +
    "AND pc.server_id = ? WHERE pa.author_id = m.user_id)";
}

function pruneRoleFilterSql() {
  return "EXISTS (SELECT 1 FROM gc_member_roles fm JOIN gc_roles fr ON fr.id = fm.role_id " +
    "WHERE fm.server_id = ? AND fm.user_id = m.user_id AND fm.role_id = ?)";
}

async function handlePruneRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The write tier with the prune identity (server-scoped, hashed downstream).
  await rateLimit(request, env, "write", "prune:" + serverId + ":" + userId);
  const body = await readJson(request);

  if (!PRUNE_DAYS.includes(body.days)) {
    throw new HttpError(400, "days must be one of 7 or 30.");
  }
  if (body.dry_run !== true && body.dry_run !== false) {
    throw new HttpError(400, "dry_run must be true or false — preview counts, the false run kicks.");
  }
  const roleFilterId = body.role_filter_id === undefined || body.role_filter_id === null
    ? null
    : body.role_filter_id;
  if (roleFilterId !== null && (!Number.isSafeInteger(roleFilterId) || roleFilterId < 1)) {
    throw new HttpError(400, "role_filter_id must be a role id or omitted.");
  }

  // Classification read only: it picks the actor fragment the statements
  // embed (the owner prunes below the crown; a KICK_MEMBERS holder prunes
  // strictly below their own top position) and nothing else. The
  // authorization itself still rides inside every statement below, so a
  // stale tier could only ever produce a zero-change zero-count no-op.
  const actor = await readActorContext(env, serverId, userId);
  if (!actor) throw new HttpError(403, "You do not have permission to do that.");

  const isOwner = actor.role === "owner";
  const cutoff = nowSeconds() - body.days * 86400;

  // The shared fragment inventory: the actor guard (owner OR KICK_MEMBERS —
  // the owner arm alone is skipped in when the actor read said owner, purely
  // to keep the owner free of a -1-sentinel comparison against roleless
  // candidates), the position rule (skipped for the owner for the same
  // reason), and the optional role filter.
  const authorityGuardSql = isOwner
    ? "(" + OWNER_EXISTS_SQL + ")"
    : "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.KICK_MEMBERS) + ")";
  const authorityGuardBinds = isOwner
    ? [serverId, userId]
    : [
        // The owner arm's (server, actor) pair, then the per-bit EXISTS pair.
        serverId, userId,
        ...holdsRolesBitsParams(serverId, userId, SERVER_PERMISSIONS.KICK_MEMBERS),
      ];
  const positionGuardSql = isOwner
    ? "1 = 1"
    : "NOT EXISTS (SELECT 1 FROM gc_member_roles pm JOIN gc_roles pr ON pr.id = pm.role_id " +
        "WHERE pm.server_id = ? AND pm.user_id = m.user_id AND pr.position >= " +
        TOP_POSITION_SELECT + ")";
  const positionGuardBinds = isOwner ? [] : [serverId, userId, serverId, userId];
  const roleFilterSql = roleFilterId !== null ? pruneRoleFilterSql() : "1 = 1";
  const roleFilterBinds = roleFilterId !== null ? [serverId, roleFilterId] : [];

  // The authority is the candidate WHERE's FIRST clause, in-statement for the
  // preview AND both deletes (lane-haywire6-servers): the old shape carried
  // the guard only on the dry-run's `authorized` column, so the RUN batch
  // bound only the candidate predicate — a plain member (no KICKMembers bit)
  // who rode a stale actor read wiped every quiet member. The owner arm alone
  // stays the owner's crown (roleless candidates are the crown's to prune, so
  // no position rule and no mask arm rides the owner's statements).
  const candidateWhere =
    authorityGuardSql + " AND " +
    "m.server_id = ? AND m.role <> 'owner' AND m.joined_at <= ? AND " +
      pruneActivitySql() + " AND " + positionGuardSql + " AND " + roleFilterSql;
  const candidateBinds = [
    ...authorityGuardBinds,
    serverId, cutoff, serverId, ...positionGuardBinds, ...roleFilterBinds,
  ];

  if (body.dry_run) {
    // Step 1: the preview COUNT — cheap and kind. The same predicate as the
    // run, with the authorization riding the SELECT list itself (the
    // `authorized` column decides), so the count never leaks past a member
    // without the bit.
    const row = await env.GOOBER_DB.prepare(
      "SELECT COUNT(*) AS count, " + authorityGuardSql + " AS authorized " +
        "FROM gc_server_members m WHERE " + candidateWhere,
    ).bind(...authorityGuardBinds, ...candidateBinds).first();
    if (!row || Number(row.authorized) !== 1) {
      throw new HttpError(403, "You do not have permission to do that.");
    }
    return json({ dry_run: true, count: Number(row.count) }, 200);
  }

  // Step 2: the batched kick. ALL THREE deletes carry the identical candidate
  // set and guard; the assignments leave FIRST (their predicate joins the
  // membership row, which the aliased member statement's predicate would
  // lose), and the boost strip rides the SAME shape — a pruned booster's
  // gc_server_boosts row leaves in-batch (cycle-9: the orphan kept counting
  // toward gc_servers.boosts and re-granted on rejoin) before the member
  // delete refutes its EXISTS arm. The recount derives from the stripped set
  // in-batch LAST.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND EXISTS (" +
        "SELECT 1 FROM gc_server_members m WHERE " + candidateWhere + ")",
    ).bind(serverId, ...candidateBinds),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND EXISTS (" +
        "SELECT 1 FROM gc_server_members m WHERE " + candidateWhere + ")",
    ).bind(serverId, ...candidateBinds),
    env.GOOBER_DB.prepare(
      // The alias is what the candidate predicate binds against (SQLite takes
      // DELETE targets aliased; the roles statement above never needed it —
      // its predicate's alias rides the subquery).
      "DELETE FROM gc_server_members AS m WHERE " + candidateWhere,
    ).bind(...candidateBinds),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);

  return json(
    { dry_run: false, kicked: Number(results[2]?.meta?.changes) || 0 },
    200,
  );
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

export async function handleServerRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) threads into the purge rides: the
  // channel/server purges' doomed attachments' R2 objects ride the caller's
  // waitUntil (media.mjs's scheduleAttachmentObjectDelete).
  void url;

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

  const channelsMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/channels$/)
    : null;
  if (channelsMatch) {
    return handleCreateChannelRoute(request, env, Number(channelsMatch[1]));
  }

  // --- phase-3 roles, roster, nicknames, kicks, spoiler channels ---------------
  const rolesMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/roles$/)
    : null;
  if (rolesMatch) {
    return method === "GET"
      ? handleListRolesRoute(request, env, Number(rolesMatch[1]))
      : handleCreateRoleRoute(request, env, Number(rolesMatch[1]));
  }

  const roleItemMatch = (method === "PATCH" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/roles\/(0|[1-9][0-9]*)$/)
    : null;
  if (roleItemMatch) {
    return method === "PATCH"
      ? handleUpdateRoleRoute(request, env, Number(roleItemMatch[1]), Number(roleItemMatch[2]))
      : handleDeleteRoleRoute(request, env, Number(roleItemMatch[1]), Number(roleItemMatch[2]));
  }

  const roleMemberMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/roles\/(0|[1-9][0-9]*)\/members\/(0|[1-9][0-9]*)$/)
    : null;
  if (roleMemberMatch) {
    const serverId = Number(roleMemberMatch[1]);
    const roleId = Number(roleMemberMatch[2]);
    const targetUserId = Number(roleMemberMatch[3]);
    return method === "PUT"
      ? handleAssignRoleRoute(request, env, serverId, roleId, targetUserId)
      : handleUnassignRoleRoute(request, env, serverId, roleId, targetUserId);
  }

  const rosterMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/roster$/)
    : null;
  if (rosterMatch) {
    return handleRosterRoute(request, env, Number(rosterMatch[1]));
  }

  const nickSelfMatch = method === "PATCH"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/nick$/)
    : null;
  if (nickSelfMatch) {
    return handleSetOwnNicknameRoute(request, env, Number(nickSelfMatch[1]));
  }

  const nickOtherMatch = method === "PATCH"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/nick\/(0|[1-9][0-9]*)$/)
    : null;
  if (nickOtherMatch) {
    return handleSetMemberNicknameRoute(
      request, env, Number(nickOtherMatch[1]), Number(nickOtherMatch[2]),
    );
  }

  // --- 0010: the filter rules desk + the alerts feed ---------------------------
  const filterRulesMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/filter\/rules$/)
    : null;
  if (filterRulesMatch) {
    return method === "GET"
      ? handleListFilterRulesRoute(request, env, Number(filterRulesMatch[1]))
      : handleCreateFilterRuleRoute(request, env, Number(filterRulesMatch[1]));
  }

  const filterRuleItemMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/filter\/rules\/(0|[1-9][0-9]*)$/)
    : null;
  if (filterRuleItemMatch) {
    return method === "PUT"
      ? handleUpdateFilterRuleRoute(
          request, env, Number(filterRuleItemMatch[1]), Number(filterRuleItemMatch[2]),
        )
      : handleDeleteFilterRuleRoute(
          request, env, Number(filterRuleItemMatch[1]), Number(filterRuleItemMatch[2]),
        );
  }

  const filterAlertsMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/filter\/alerts$/)
    : null;
  if (filterAlertsMatch) {
    return handleListFilterAlertsRoute(request, env, Number(filterAlertsMatch[1]), url);
  }

  const searchMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/search$/)
    : null;
  if (searchMatch) {
    return handleSearchServerRoute(request, env, Number(searchMatch[1]), url);
  }

  const kickMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/members\/(0|[1-9][0-9]*)$/)
    : null;
  if (kickMatch) {
    return handleKickMemberRoute(
      request, env, Number(kickMatch[1]), Number(kickMatch[2]),
    );
  }

  // --- phase-3 mod desk: bans, timeouts, prune ---------------------------------
  const banMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/bans$/)
    : null;
  if (banMatch) {
    return handleBanMemberRoute(request, env, Number(banMatch[1]));
  }

  const unbanMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/bans\/(0|[1-9][0-9]*)$/)
    : null;
  if (unbanMatch) {
    return handleUnbanMemberRoute(
      request, env, Number(unbanMatch[1]), Number(unbanMatch[2]),
    );
  }

  const timeoutMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/members\/(0|[1-9][0-9]*)\/timeout$/)
    : null;
  if (timeoutMatch) {
    const serverId = Number(timeoutMatch[1]);
    const targetUserId = Number(timeoutMatch[2]);
    return method === "PUT"
      ? handleSetTimeoutRoute(request, env, serverId, targetUserId)
      : handleRemoveTimeoutRoute(request, env, serverId, targetUserId);
  }

  const pruneMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/prune$/)
    : null;
  if (pruneMatch) {
    return handlePruneRoute(request, env, Number(pruneMatch[1]));
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

  // The {everyone|role_id} tail: "everyone" pins role_id to NULL — the
  // @everyone base layer sentinel (a numeric id always outranks it).
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

  // --- discovery + invites dispatch -------------------------------------------
  const inviteCreateMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/invites$/)
    : null;
  if (inviteCreateMatch) {
    return handleCreateInviteRoute(request, env, Number(inviteCreateMatch[1]));
  }

  // SHAVERS 3: the mod-desk list (GET) and the revoke (DELETE on one code).
  const inviteListMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/invites$/)
    : null;
  if (inviteListMatch) {
    return handleListInvitesRoute(request, env, Number(inviteListMatch[1]));
  }

  const inviteRevokeMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/invites\/([A-Za-z0-9_-]{1,64})$/)
    : null;
  if (inviteRevokeMatch) {
    return handleRevokeInviteRoute(
      request, env, Number(inviteRevokeMatch[1]), inviteRevokeMatch[2],
    );
  }

  const inviteJoinMatch = method === "POST"
    ? path.match(/^\/api\/invites\/([A-Za-z0-9_-]{1,64})\/join$/)
    : null;
  if (inviteJoinMatch) {
    return handleInviteJoinRoute(request, env, inviteJoinMatch[1]);
  }

  if (path === "/api/discover" && method === "GET") {
    return handleDiscoverRoute(request, env);
  }

  const discoverJoinMatch = method === "POST"
    ? path.match(/^\/api\/discover\/(0|[1-9][0-9]*)\/join$/)
    : null;
  if (discoverJoinMatch) {
    return handleDiscoverJoinRoute(request, env, Number(discoverJoinMatch[1]));
  }

  // Goober+ boosts: one boost per member per server (the guarded INSERT's
  // PK DO NOTHING), member-only, with the counter re-derived on every write.
  const boostMatch = (method === "POST" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/boost$/)
    : null;
  if (boostMatch) {
    const serverId = Number(boostMatch[1]);
    return method === "POST"
      ? handleBoostRoute(request, env, serverId)
      : handleRetractBoostRoute(request, env, serverId);
  }

  return undefined;
}
