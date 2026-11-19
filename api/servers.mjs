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

// T-R25-SPLIT-SERVERS: the invites/discovery family's home (the wave-25
// area-3 seam). The owner-member fragment keeps its local copy here (the
// sibling-lane idiom); the router forwards the family's paths below.
import { handleServerInviteRoutes } from "./server-invites.mjs";

// The family's lifecycle shelves re-export (the existing consumers' import —
// tests/invite-lifecycle.test.mjs reads them from here — is untouched by the
// seam; ONE definition lives in api/server-invites.mjs).
export {
  INVITE_LIST_LIMIT,
  INVITE_MAX_AGE_MAX,
  INVITE_MAX_AGE_MIN,
  INVITE_MAX_USES_MAX,
} from "./server-invites.mjs";

// T-R25-SPLIT-SERVERS-2: the channels/categories family rides
// api/server-channels.mjs (the wave-25 second seam). The shared read helpers
// above stay ONE implementation here, exported for the seam; the family's
// own SQL fragments and guards keep their verbatim home there.
import { handleServerChannelsRoutes } from "./server-channels.mjs";

// T-R25-SPLIT-SERVERS-3: the roles/roster/nicknames family rides
// api/server-roles.mjs (the wave-25 third seam). The shared read helpers stay
// ONE implementation here, exported for both seams; the family's guard
// fragment and nickname law keep their local mirrors there.
import { handleServerRolesRoutes } from "./server-roles.mjs";
import { handleServerLeaveRoutes } from "./server-leave.mjs";

// T-R25-SPLIT-SERVERS-4: the mod desk family (the AutoMod desk + the
// kicks/bans/timeouts/prune arm) rides api/server-mod.mjs (the wave-25
// fourth seam). The shared read helpers still live here, exported for all
// seams; the desk's guard fragments and the ban-reason law keep their local
// mirrors there.
import { handleServerModRoutes } from "./server-mod.mjs";

// gc_servers/gc_channels CHECK(length(trim(name)) BETWEEN 1 AND 100); the
// route-side limit mirrors it so oversized names 400 instead of 500-ing on the
// constraint.
const SERVER_NAME_MAX = 100;
// Exported for api/server-channels.mjs (the channel family's
// create + PATCH read the same law).
export const CHANNEL_NAME_MAX = 100;
// gc_roles name CHECK widened to the parity law (migration 0024) and the
// category names riding the same bound (gc_channel_categories names are
// widened in the same file; docs/parity-limits.md: Role name length 1–100,
// verified 2026-11-17). The nickname column is NOT part of the raise — its
// Change-Nickname bound is Discord's own 32 (0006) and stays. Exported for
// the seam's category routes (the same law, one definition).
export const ROLE_NAME_MAX = 100;

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

// Exported for api/server-mod.mjs (the kick/ban/prune fan-out re-derives
// the same counter — one definition, never a second recount that drifts).
export const BOOST_RECOUNT_SQL =
export const BOOST_RECOUNT_SQL =
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
export function errorName(error) {
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

export async function readActorContext(env, serverId, userId) {
  const row = await env.GOOBER_DB.prepare(ACTOR_CONTEXT_SQL)
    .bind(serverId, userId, serverId, userId, serverId, userId)
    .first();
  return row === null
    ? null
    : { ...row, permissions: parseMergedMask(row.permissions) };
}

export const ROLE_LIST_SQL =
  "SELECT id, name, color, position, permissions FROM gc_roles " +
    "WHERE server_id = ? ORDER BY position DESC, id DESC";

// The roster/roles `viewer` block: what the caller may do here as named bits
// (the UI gates its affordances on it; the server never trusts it).
export function viewerPayload(viewer) {
  const owner = viewer.role === "owner";
  const mask = Number(viewer.permissions) || 0;
  return {
    owner,
    // The owner's mask carries every bit (owner bypasses everything).
    permissions: permissionNames(owner ? ALL_SERVER_PERMISSIONS : mask),
    topPosition: Number(viewer.position) || -1,
  };
}

export function rolePayload(row) {
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


  // T-R25-SPLIT-SERVERS-5: the leave/transfer/delete arms (like the
  // family's other seam arms) ride api/server-leave.mjs. The forward sits
  // at the delete arm's original position and answers the WHOLE family; its
  // `undefined` fall-through keeps the router's remaining arms running
  // exactly as before (no other family's path overlaps a
  // leave/transfer/delete path).
  const leaveRoutes = await handleServerLeaveRoutes(request, env, path, method, ctx);
  if (leaveRoutes !== undefined) {
    return leaveRoutes;
  }

  // T-R25-SPLIT-SERVERS-2: the channel create's arm (like the family's other
  // arms) rides api/server-channels.mjs. The forward sits at the create arm's
  // original position and answers the WHOLE family; its `undefined`
  // fall-through keeps the router's remaining arms running exactly as before
  // (no other family's path overlaps a channels/categories path).
  const channelsForward = await handleServerChannelsRoutes(request, env, url, path, method, ctx);
  if (channelsForward !== undefined) {
    return channelsForward;
  }

  // T-R25-SPLIT-SERVERS-3: the roles/roster/nicknames family rides
  // api/server-roles.mjs. The forward sits at the family arm section's
  // original position and answers the WHOLE family; its `undefined`
  // fall-through keeps the router's remaining arms running exactly as before
  // (no other family's path overlaps a roles/roster/nick path).
  const rolesForward = await handleServerRolesRoutes(request, env, url, path, method);
  if (rolesForward !== undefined) {
    return rolesForward;
  }

  // T-R25-SPLIT-SERVERS-4: the mod desk family (the AutoMod desk — filter
  // rules + alerts — and its enforcement arm: kicks, bans, timeouts, prune)
  // rides api/server-mod.mjs. The forward sits at the filter desk's arm
  // section's original position and answers the WHOLE family; its
  // `undefined` fall-through keeps the router's remaining arms (the search
  // arm keeps its interloper position) running exactly as before (no other
  // family's path overlaps a mod desk path).
  const modForward = await handleServerModRoutes(request, env, url, path, method);
  if (modForward !== undefined) {
    return modForward;
  }

  const searchMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/search$/)
    : null;
  if (searchMatch) {
    return handleSearchServerRoute(request, env, Number(searchMatch[1]), url);
  }

  // The {everyone|role_id} tail: "everyone" pins role_id to NULL — the
  // @everyone base layer sentinel (a numeric id always outranks it).
  // --- discovery + invites dispatch -------------------------------------------
  // T-R25-SPLIT-SERVERS: the family rides api/server-invites.mjs (the wave-25
  // area-3 seam). The forward answers the family's paths; its `undefined`
  // fall-through keeps the boost arm below running exactly as before.
  const inviteForward = await handleServerInviteRoutes(request, env, path, method);
  if (inviteForward !== undefined) {
    return inviteForward;
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
