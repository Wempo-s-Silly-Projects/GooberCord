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

// GooberCord's discovery + invites routes (T-R25-SPLIT-SERVERS: the wave-25
// area-3 seam — moved VERBATIM out of api/servers.mjs, whose dispatch
// forwards here). Every write keeps the family's rule: the authorization
// predicate rides INSIDE the SQL, and a changes=0 result is classified
// afterwards by a single diagnostic read that only picks an error message —
// it never gates a write.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json } from "./core/http.mjs";
import { GC_INVITES_MAX_PER_SERVER, GC_SERVERS_JOIN_MAX_FREE, GC_SERVERS_JOIN_MAX_PLUS } from "../constants.mjs";
import { holdsRolesBitsSql, SERVER_PERMISSIONS } from "./permissions.mjs";

// The manage-guard fragments mirror the sibling lanes' exact copies (emoji,
// soundboard, soundpacks keep them local by the same design note; a guard
// change must be re-mirrored and the parity tests pin the copies' behavior).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

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

// Exported for tests/guard-binds.test.mjs (the real-SQLite guard gate; no
// behavior rides the retag).
export const INVITE_LIST_SQL =
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
    .bind(serverId, serverId, userId, serverId, userId).all();

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

// Exported for tests/guard-binds.test.mjs (real-SQLite guard gate).
export const INVITE_REVOKE_SQL =
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
    .bind(now, code, serverId, serverId, userId, serverId, userId).run();
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
  ).bind(serverId, serverId, userId, serverId, userId).first();
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


// The family's own dispatch (moved VERBATIM from api/servers.mjs's
// "discovery + invites" block — the router forwards here, and the returned
// `undefined` is the module's fall-through, never a route).
export async function handleServerInviteRoutes(request, env, path, method) {
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

  return undefined;
}
