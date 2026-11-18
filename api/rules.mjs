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

// The server rules gate's routes (0012): the member-facing trio behind the
// gate the shared enforceMemberGates enforces. The model is the forum's
// rules feature (an owner-edited rules text with an accept step) adapted to
// GC's per-server schema — where the forum stores its one site-wide rules
// under a site_settings key, GC carries the same document per-server on
// gc_servers.rules_text (set/cleared through the owner-only server PATCH in
// api/servers.mjs, so the owner edit rides the settings dialog idiom).
//
//   GET    /api/servers/:id/rules                      — member-only read: the
//        document (null = the gate is OFF) and the caller's own acceptance
//        timestamp. This is the dialog's re-read AND the voice door's
//        preflight (the browser's WS handshake never shows the upgrade's 403
//        body, so the join flow pre-reads instead — the ws door still
//        re-asserts every gate server-side).
//   POST   /api/servers/:id/rules/accept               — any member, for
//        themselves; idempotent (a replay keeps the FIRST accepted_at).
//   POST   /api/servers/:id/members/:uid/rules-verify  — the manual verify:
//        owner or KICK_MEMBERS (the moderationGuardSql authority, with the
//        position rule and the owner row immune) records a specific member's
//        acceptance; idempotent the same way.
//
// The module's rule is the house one: the authorization rides INSIDE every
// write's SQL, a zero-change write is classified afterwards by one
// diagnostic read that only picks an error message, and non-members get the
// one shared 403 with no existence oracle anywhere.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { SERVER_PERMISSIONS } from "./permissions.mjs";
import { isoTimestamp, moderationGuardSql } from "./servers.mjs";

const SHARED_403 = "You do not have permission to do that.";

// The member-only rules read: the server's document LEFT JOINed to the
// caller's own membership row — the EXISTS preconditions the WHERE with the
// membership, so a non-member (or an unknown server) matches no row at all
// and answers the same 403 a refused read always has. An accepted state of
// null rides the response for a gate-off server too (the client treats a
// null rules value as the OFF gate).
const RULES_READ_SQL =
  "SELECT s.rules_text AS rules_text, m.rules_accepted_at AS accepted_at " +
    "FROM gc_servers s LEFT JOIN gc_server_members m " +
      "ON m.server_id = s.id AND m.user_id = ? " +
    "WHERE s.id = ? AND EXISTS (" +
      "SELECT 1 FROM gc_server_members gm WHERE gm.server_id = s.id AND gm.user_id = ?" +
    ") LIMIT 1";

async function handleGetRulesRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  const viewerId = Number(session.user.id);
  await rateLimit(request, env, "read", "rules:" + serverId + ":" + viewerId);

  const row = await env.GOOBER_DB.prepare(RULES_READ_SQL)
    .bind(viewerId, serverId, viewerId).first();
  if (!row) throw new HttpError(403, SHARED_403);

  const rules = typeof row.rules_text === "string" ? row.rules_text : null;
  return json({ serverId, rules, acceptedAt: isoTimestamp(row.accepted_at) }, 200);
}

// The self-accept write: the guard is the membership row itself (any member
// may accept — the owner and KICK members are bypassed at check time anyway,
// and their accepting is harmless truth). COALESCE keeps the FIRST
// accepted_at, so a replay is a real no-op — the idempotency the retry path
// (the composer's re-send after an accepted dialog) leans on. Zero changes
// is classified afterwards: already accepted is the idempotent answer,
// anything else (never was a member) is the shared 403 — the diagnostic read
// only picks between those two, it never gates the write.
const ACCEPT_UPDATE_SQL =
  "UPDATE gc_server_members SET rules_accepted_at = " +
    "COALESCE(rules_accepted_at, ?) WHERE server_id = ? AND user_id = ?";

async function handleAcceptRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "rules:" + serverId + ":" + userId);
  const now = nowSeconds();

  const result = await env.GOOBER_DB.prepare(ACCEPT_UPDATE_SQL)
    .bind(now, serverId, userId).run();

  if (Number(result.meta?.changes) !== 1) {
    const membership = await env.GOOBER_DB.prepare(
      "SELECT rules_accepted_at AS accepted_at FROM gc_server_members " +
        "WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, userId).first();
    if (!membership) throw new HttpError(403, SHARED_403);
    return json(
      { accepted: true, changed: false, acceptedAt: isoTimestamp(membership.accepted_at) },
      200,
    );
  }

  return json({ accepted: true, changed: true, acceptedAt: isoTimestamp(now) }, 201);
}

// The manual verify: the moderationGuardSql authority (owner OR KICK_MEMBERS,
// with the position rule) pinned INSIDE the UPDATE, the owner row immune
// (`role <> 'owner'` — the owner bypasses the gate at check time, so there is
// nothing for them to verify). The COALESCE makes the same-first-at-keep
// idempotency of the self-accept route hold here too.
const VERIFY_UPDATE_SQL =
  "UPDATE gc_server_members SET rules_accepted_at = COALESCE(rules_accepted_at, ?) " +
    "WHERE server_id = ? AND user_id = ? AND role <> 'owner' AND ";

async function handleVerifyRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "rules:" + serverId + ":" + userId);
  const now = nowSeconds();

  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const result = await env.GOOBER_DB.prepare(VERIFY_UPDATE_SQL + guard.sql)
    .bind(now, serverId, targetUserId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    // Zero changes: already verified (the idempotent answer — kept only when
    // the target's row is present and carrying an accepted_at), the owner
    // row (immune), refused authority, or no such member. Everything that is
    // not the idempotent replay is the one shared 403, and nothing beyond
    // the replay is ever confirmed to a caller.
    const target = await env.GOOBER_DB.prepare(
      "SELECT rules_accepted_at AS accepted_at, role FROM gc_server_members " +
        "WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, targetUserId).first();
    if (target && target.role !== "owner" && Number(target.accepted_at) > 0) {
      return json(
        { verified: true, changed: false, serverId, userId: targetUserId,
          acceptedAt: isoTimestamp(target.accepted_at) },
        200,
      );
    }
    throw new HttpError(403, SHARED_403);
  }

  return json(
    { verified: true, changed: true, serverId, userId: targetUserId, acceptedAt: isoTimestamp(now) },
    200,
  );
}

// Both write routes are bodyless by shape: the accept and the verify POSTs
// read nothing from the request body (a stray body is never parsed — the
// statements are parameterless beyond their ids), so there is no request
// shape to validate and no body-limit surface to open.

export async function handleRulesRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) completes the dispatch loop's
  // handler signature; these routes schedule no background work today.
  void url;
  void ctx;

  const readMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/rules$/)
    : null;
  if (readMatch) {
    return handleGetRulesRoute(request, env, Number(readMatch[1]));
  }

  const acceptMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/rules\/accept$/)
    : null;
  if (acceptMatch) {
    return handleAcceptRoute(request, env, Number(acceptMatch[1]));
  }

  const verifyMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/members\/(0|[1-9][0-9]*)\/rules-verify$/)
    : null;
  if (verifyMatch) {
    return handleVerifyRoute(request, env, Number(verifyMatch[1]), Number(verifyMatch[2]));
  }

  return undefined;
}
