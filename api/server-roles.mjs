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

// GooberCord's roles/roster/nickname routes (T-R25-SPLIT-SERVERS-3: the
// wave-25's third family off api/servers.mjs — moved VERBATIM: the roles
// CRUD + assignment, the member-list payload, and the nicknames, plus
// their own dispatch). The shared read helpers
// (readActorContext/ROLE_LIST_SQL/viewerPayload/rolePayload) and the law
// constants the earlier seam lanes exported stay ONE implementation in
// api/servers.mjs, imported here (call-time use — the module-scope fragments
// stay local so the circular import stays inert); the family's guard
// fragment and the nickname law keep the sibling-lane local-mirror idiom.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import { GC_ROLES_MAX_PER_SERVER } from "../constants.mjs";
import {
  canManageRoleAt,
  enforceVerificationLevel,
  permissionNames,
  holdsRolesBitsParams,
  holdsRolesBitsSql,
  highestPosition,
  SERVER_PERMISSIONS,
} from "./permissions.mjs";
import { applyWordFilter, containsFilteredWord, normalizeUsernameForFilter } from "./filter.mjs";
import { ensureFilterWords, filterWords } from "./filterstore.mjs";
import { FILTERED_NAME_ERROR, loadServerRules, nameRuleHit } from "./filterrules.mjs";
import { plusActiveExpr, publicIsPlus } from "./plus.mjs";
import {
  isoTimestamp,
  moderationGuardSql,
  readActorContext,
  ROLE_LIST_SQL,
  ROLE_NAME_MAX,
  rolePayload,
  viewerPayload,
} from "./servers.mjs";

// The manage-guard fragments mirror the sibling lanes' exact copies (invite,
// channels, soundboard keep them local by the same design note; a guard
// change must be re-mirrored and the parity tests pin the copies' behavior).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// The member's strongest role position (-1 when roleless — the hierarchy
// sentinel the strictly-lower rules compare against).
const TOP_POSITION_SELECT =
  "(SELECT COALESCE(MAX(hr.position), -1) FROM gc_member_roles hmr " +
    "JOIN gc_roles hr ON hr.id = hmr.role_id " +
    "WHERE hmr.server_id = ? AND hmr.user_id = ?)";

// The nickname column is Discord's own 32 (0006) — the nickname law rides
// its family here (the ROLE_NAME_MAX raise never touched it).
const NICKNAME_MAX = 32;

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

// The family's own dispatch (the arms moved VERBATIM from api/servers.mjs's
// router — the router forwards here, and the returned undefined is the
// module's fall-through, never a route).
export async function handleServerRolesRoutes(request, env, url, path, method) {
  void url;

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
  return undefined;
}
