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
  GC_SERVERS_JOIN_MAX_FREE,
  GC_SERVERS_JOIN_MAX_PLUS,
  MAX_CHANNELS_PER_SERVER,
} from "../constants.mjs";
// Server icons ride the media module's intake engine-to-engine in the seam
// modules (the PATCH icon write in server-body.mjs) — nothing in this
// module touches media any more.
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

// T-R25-SPLIT-SERVERS-6: the server's own body (create, list, PATCH) rides
// api/server-body.mjs (the wave-25 sixth seam). Its deps (media's icon
// intake, the coins mint, the body's permission machinery) thread to the
// seam; the owner-guard fragment + the server-name law keep their local
// mirrors there. The owner's one-act DELETE shaver does NOT ride the body:
// its single home is api/server-leave.mjs (the double-move was caught at
// the body lane's rebase — single-home ruling).
import { handleServerBodyRoutes } from "./server-body.mjs";

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


// errorName(error): the failure's compact label for the best-effort ride
// logs below — D1/R2 errors carry a name/message pair worth one line of
// context, never a swallowed void (the messages.mjs pattern, same idiom).
export function errorName(error) {
  return error && error.name ? error.name : "UnknownError";
}

export async function handleServerRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) threads to the forwards: the seam
  // families' purge rides (the leave teardown's + the channel DELETE's
  // doomed attachments' R2 objects) hangs off the caller's waitUntil
  // (media.mjs's scheduleAttachmentObjectDelete in the seam modules).
  void url;

  // T-R25-SPLIT-SERVERS-6: the server's own create/list/PATCH body rides
  // api/server-body.mjs. The family's head arms are the router's first
  // dispatch positions — the owner's DELETE server teardown is NOT in the
  // body family (it rode api/server-leave.mjs at T-R25-SPLIT-SERVERS-5, the
  // sibling double-move caught at this lane's rebase) — so the forward sits
  // at the create arm's original position and answers create/list/PATCH;
  // its `undefined` fall-through keeps the router's remaining arms running
  // exactly as before (no other family's path overlaps a body path).
  const bodyForward = await handleServerBodyRoutes(request, env, url, path, method, ctx);
  if (bodyForward !== undefined) {
    return bodyForward;
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
