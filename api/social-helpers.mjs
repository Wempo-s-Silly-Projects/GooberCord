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

import { holdsRolesBitsSql, holdsRolesBitsParams } from "./permissions.mjs";

// The moderation guard family, moved verbatim out of api/social.mjs (the
// T-SOCIAL-800 size-compliance refactor) — the fragment builder only, no
// route handlers rode along.

// --- the moderation guard (replicated from api/servers.mjs) ----------------------
//
// Same three fragments servers.mjs builds its guard from — the string-tier
// owner row, the per-bit role EXISTS (exact OR — SUM carried duplicate bits
// into phantom higher bits), and the two hierarchy positions. Kept verbatim
// (including the bind order) because the mod desk's routes and the reactions
// route must refuse the same actor/target pairs.

export const TOP_POSITION_SELECT =
  "(SELECT COALESCE(MAX(hr.position), -1) FROM gc_member_roles hmr " +
    "JOIN gc_roles hr ON hr.id = hmr.role_id " +
    "WHERE hmr.server_id = ? AND hmr.user_id = ?)";

export const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// moderationGuardSql(serverId, actorId, targetId, bits): the mod-desk family
// guard — actor is the string-tier owner, OR holds EVERY bit (one per-bit
// EXISTS arm per bit, exact OR semantics) AND outranks the target (strictly
// greater top position).
export function moderationGuardSql(serverId, actorId, targetId, bits) {
  const list = Array.isArray(bits) ? bits : [bits];
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR (" +
        holdsRolesBitsSql(list) + " AND " +
        TOP_POSITION_SELECT + " > " + TOP_POSITION_SELECT + "))",
    params: [serverId, actorId, ...holdsRolesBitsParams(serverId, actorId, list), serverId, actorId, serverId, targetId],
  };
}
