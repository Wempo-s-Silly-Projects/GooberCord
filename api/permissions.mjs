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

// Phase-3 role foundation: the server-role permission bitmask and the
// hierarchy helpers it feeds. GC's permission model is DELIBERATELY additive:
// a plain member's base set (view channels, send, connect voice) stays
// implicit and is never gated by this module — roles only layer EXTRA
// moderation powers. A server with no roles row behaves exactly like the
// pre-roles server (the string membership tiers owner/moderator/member), so
// nothing existing is gated until the owner adds a role.
//
// Everything here is pure: the route module (api/servers.mjs) keeps its
// authorization inside the SQL itself, and these helpers feed both the bind
// ordering there and the roster payload the UI gates its affordances on.

// Bit positions, least-significant first. The stored value is a plain
// INTEGER column (gc_roles.permissions AND both gc_channel_overwrites masks,
// the shared vocabulary — one bit set means the same power in every table),
// so the set is stable file-wide.
export const SERVER_PERMISSIONS = Object.freeze({
  MANAGE_CHANNELS: 1 << 0,
  MANAGE_ROLES: 1 << 1,
  KICK_MEMBERS: 1 << 2,
  MANAGE_INVITES: 1 << 3,
  DELETE_MESSAGES: 1 << 4,
  VIEW: 1 << 5,
  // The overwrite vocabulary (channel-permissions guide): the granted-able
  // channel powers a deny/allow layer can move. They also ride a gc_roles
  // mask, where they act as SERVER-WIDE re-grants standing against an
  // @everyone deny elsewhere.
  SEND: 1 << 6,
  CONNECT: 1 << 7,
  SPEAK: 1 << 8,
  // Slowmode's bypass bit (slowmode FAQ): a role holding it (and the owner /
  // moderation tiers) never waits out the channel cooldown.
  BYPASS_SLOWMODE: 1 << 9,
  // The reactions power (permission-overview guide): the one NEW bit the
  // reactions feature itself brought into the mask vocabulary. It rides the
  // overwrite vocabulary (per-channel deny/allow like SEND) and sits in the
  // implicit base — a member can always react unless a deny layer strips it.
  ADD_REACTIONS: 1 << 10,
  // The express-yourself power (custom emoji + stickers CRUD): a
  // server-level role bit exactly like MANAGE_CHANNELS — it never rides a
  // channel overwrite (an emoji is not channel-scoped), so it stays OUT of
  // OVERWRITE_BITS on purpose. Owner/moderator tiers bypass structurally.
  MANAGE_EMOJI: 1 << 11,
  // The @everyone/@here send power (the mentions wave, owner direct ask):
  // Discord's MENTION_EVERYONE bit — a server-level role bit exactly like
  // MANAGE_EMOJI (it never rides a channel overwrite, so it stays OUT of
  // OVERWRITE_BITS on purpose). The message send/edit gate reads it from the
  // server-wide merged role mask; owner/moderator tiers bypass structurally.
  MENTION_EVERYONE: 1 << 12,
});

// The mentions gate's named import (the send/edit route reads the bit
// directly off the mask vocabulary above).
export const MENTION_EVERYONE = SERVER_PERMISSIONS.MENTION_EVERYONE;

// The implicit base (filed resolution order): every member starts with VIEW,
// SEND, and ADD_REACTIONS allowed before anything else applies — a deny (at
// any layer) flips them off unless a later allow re-grants. No Administrator
// bit exists on purpose: the owner bypasses everything structurally.
export const IMPLICIT_BASE_PERMISSIONS = SERVER_PERMISSIONS.VIEW | SERVER_PERMISSIONS.SEND |
  SERVER_PERMISSIONS.ADD_REACTIONS;

// The overwrite layers' editable bits, in the resolution walk's own order —
// the tri-state editor renders from this list. ADD_REACTIONS joins with the
// reactions feature (per-channel deny), so an owner can mute reaction chips
// in one channel without touching SEND anywhere.
export const OVERWRITE_BITS = Object.freeze([
  SERVER_PERMISSIONS.VIEW,
  SERVER_PERMISSIONS.SEND,
  SERVER_PERMISSIONS.CONNECT,
  SERVER_PERMISSIONS.SPEAK,
  SERVER_PERMISSIONS.ADD_REACTIONS,
]);

// Discord's slowmode menu (slowmode FAQ), the column values it stores.
export const SLOWMODE_CHOICES = Object.freeze([0, 900, 1800, 3600, 7200, 21600]);

// --- phase-3 mod desk: the pure constants + the verification helper -----------

// Discord's duration menu (time-out FAQ: 60s / 5m / 10m / 1h / 1d / 1w / 28d),
// the minute values the PUT body carries (0 is not on the menu — removal is
// its own DELETE route, which NULLs the column). The 28-day seat tops the
// AutoMod row (docs/parity-limits.md, verified 2026-11-17); the DB side's
// CHECK rode migration 0010 bound to the old menu and widened in 0027.
// docs/parity-limits.md: AutoMod timeout ≤ 28d.
export const TIMEOUT_MINUTE_CHOICES = Object.freeze([1, 5, 10, 60, 1440, 10080, 40320]);

// The verification-level ladder (verification-levels article), compressed to
// the two gates GC can derive — account age (users.created_at) and membership
// age (joined_at); email/phone levels are N/A. The mapping is documented in
// migrations/0008_mod_desk.sql and encoded here as the seconds each level
// demands (a level's missing gate demands 0 = no gate at all).
export const VERIFICATION_LEVELS = Object.freeze([0, 1, 2, 3, 4]);
const DAY = 86400;
const MINUTE = 60;
export const VERIFICATION_ACCOUNT_SECONDS = Object.freeze({
  0: 0,
  1: 1 * DAY,
  2: 7 * DAY,
  3: 0,
  4: 7 * DAY,
});
export const VERIFICATION_MEMBER_SECONDS = Object.freeze({
  0: 0,
  1: 0,
  2: 0,
  3: 10 * MINUTE,
  4: 10 * MINUTE,
});

// enforceVerificationLevel(level, accountCreatedAt, memberJoinedAt, now):
// the ONE verification gate both callers share (message send + voice join).
// Pure. The owner/mods bypass never rides this function — callers answer
// `owner` separately, exactly like hasPermission (the owner/owner-string tier
// and any KICK_MEMBERS holder skips the read that even reaches here).
//   Returns null when the member passes, otherwise the gate names they failed
//   (["account"] / ["member"] / ["account", "member"]) — the route turns that
//   into the one shared 403, never leaking either timestamp.
export function enforceVerificationLevel(level, accountCreatedAt, memberJoinedAt, now) {
  const verifiedLevel = Number(level) || 0;
  if (!VERIFICATION_LEVELS.includes(verifiedLevel) || verifiedLevel === 0) return null;
  const failed = [];
  const gateFails = (required, createdAt) => {
    if (required <= 0) return false;
    // Fail-closed: an unreadable timestamp can only ever look TOO NEW.
    const created = Number(createdAt);
    const age = now - created;
    return !Number.isFinite(created) || !Number.isFinite(age) || age < required;
  };
  if (gateFails(Number(VERIFICATION_ACCOUNT_SECONDS[verifiedLevel]) || 0, accountCreatedAt)) {
    failed.push("account");
  }
  if (gateFails(Number(VERIFICATION_MEMBER_SECONDS[verifiedLevel]) || 0, memberJoinedAt)) {
    failed.push("member");
  }
  return failed.length === 0 ? null : failed;
}

// the prune window menu (how-to-prune guide: 7 / 30 days).
export const PRUNE_DAYS = Object.freeze([7, 30]);

// The owner's effective set: every bit OR'd together, the single truth for
// what "owner bypasses everything" means.
export const ALL_SERVER_PERMISSIONS = Object.values(SERVER_PERMISSIONS).reduce(
  (all, bit) => all | bit,
  0,
);

const PERMISSION_NAMES = Object.entries(SERVER_PERMISSIONS).reduce(
  (names, [name, bit]) => {
    names[bit] = name;
    return names;
  },
  {},
);

// Owner check over a gc_server_members.role string (the pre-roles tier).
export function isMembershipOwner(role) {
  return role === "owner";
}

// hasPermission(role, permissions, bit): the single gate every caller passes
// through — the owner tier (or an explicit ALL-bit role) satisfies any bit,
// everyone else needs the bit set in their merged role mask.
export function hasPermission(role, permissions, bit) {
  if (isMembershipOwner(role)) return true;
  return ((Number(permissions) || 0) & (bit | 0)) !== 0;
}

// hasAllPermissions(role, permissions, bits): AND over a bit list, for the
// routes whose tool needs two powers at once (Manage-Nickname
// = KICK_MEMBERS + MANAGE_ROLES per the filed split).
export function hasAllPermissions(role, permissions, bits) {
  return bits.every((bit) => hasPermission(role, permissions, bit));
}

// permissionNames(permissions) -> ["MANAGE_CHANNELS", ...] in bit order: the
// wire form the roster's viewer payload carries (named bits survive a schema
// re-order; raw integers would not).
export function permissionNames(permissions) {
  const mask = Number(permissions) || 0;
  return Object.entries(SERVER_PERMISSIONS)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);
}

// highestPosition(roleRows) -> the member's strongest position, or -1 when
// they hold no role (the sentinel EVERY hierarchy rule compares against).
// roleRows: [{ position }] in any order.
export function highestPosition(roleRows) {
  let top = -1;
  for (const row of Array.isArray(roleRows) ? roleRows : []) {
    const position = Number(row?.position);
    if (Number.isInteger(position) && position > top) top = position;
  }
  return top;
}

// canManageRoleAt(actorIsOwner, actorTopPosition, position): the role
// hierarchy rule — a member cannot assign/modify/delete a role whose position
// is GREATER OR EQUAL to their own highest (the owner bypasses everything).
export function canManageRoleAt(actorIsOwner, actorTopPosition, position) {
  if (actorIsOwner) return true;
  return Number(actorTopPosition) > Number(position);
}

// canActOnMember(actorIsOwner, actorTopPosition, targetTopPosition): the
// KICK/MANAGE rule — acting on a member is allowed only when the target's
// strongest position is STRICTLY LOWER than the actor's own (the owner
// bypasses; members with no roles sit at the -1 sentinel, so a roleless actor
// can act on nobody, only fellow roleless can act on them, and a positioned
// moderator outranks them).
export function canActOnMember(actorIsOwner, actorTopPosition, targetTopPosition) {
  if (actorIsOwner) return true;
  return Number(actorTopPosition) > Number(targetTopPosition);
}

// --- the overwrite resolution walk (the filed evaluation algorithm) -----------
//
// RESOLUTION ORDER, pinned exactly as filed: start from the server-wide
// permission set (the member's merged role mask on top of the implicit
// VIEW/SEND base), then apply the channel's layer chain IN THIS ORDER:
//
//   @everyone deny -> @everyone allow ->
//   category role denies -> category role allows ->
//   channel role denies -> channel role allows
//
// Within one layer every qualifying row's deny_mask is applied (bits cleared)
// before the same layer's allow_mask (bits set), so an allow re-grants what a
// deny just took. role_id null is the @everyone sentinel and binds EVERY
// member; a role-targeted row binds only holders of that role. The
// member-specific tier is RESERVED — there is no member_id column to read, so
// an evaluator input can never carry one.
//
// Contract (pure — routes and tests share this one truth):
//   roleRows      [{ id, permissions }]   the member's gc_roles rows (any order)
//   overwriteRows the channel's LAYER CHAIN: the channel's own
//                 gc_channel_overwrites rows plus its category's rows, each
//                 { channel_id, category_id, role_id, allow_mask, deny_mask }.
//                 Row SHAPE separates the layers (a category_id-set row walks
//                 the category layer), and only rows whose role_id is NULL or
//                 one of the member's held roles apply.
//   returns       the effective INTEGER mask. The owner's bypass never rides
//               this function — callers answer `owner` separately, exactly
//               like hasPermission.
export function effectivePermissions(roleRows, overwriteRows) {
  const roles = Array.isArray(roleRows) ? roleRows : [];
  const rows = Array.isArray(overwriteRows) ? overwriteRows : [];
  const held = new Set(roles.map((role) => Number(role?.id)).filter(Number.isInteger));

  // The server-wide layer: implicit VIEW/SEND base plus every role's own
  // merged mask (a role grant stands server-wide, so it also counters an
  // @everyone deny the same way a channel allow does).
  let mask = IMPLICIT_BASE_PERMISSIONS;
  for (const role of roles) mask |= Number(role?.permissions) || 0;

  // One layer step: the row's deny clears first, its allow sets after.
  const applyLayer = (layerRows) => {
    const relevant = layerRows.filter(
      (row) => row !== null && typeof row === "object" &&
        (row.role_id === null || row.role_id === undefined || held.has(Number(row.role_id))),
    );
    if (relevant.length === 0) return;
    const deny = relevant.reduce((all, row) => all | (Number(row.deny_mask) || 0), 0);
    mask &= ~deny;
    const allow = relevant.reduce((all, row) => all | (Number(row.allow_mask) || 0), 0);
    mask |= allow;
  };

  const isCategory = (row) => row !== null && typeof row === "object" &&
    row.category_id !== null && row.category_id !== undefined;
  const isChannel = (row) => row !== null && typeof row === "object" &&
    row.channel_id !== null && row.channel_id !== undefined &&
    !isCategory(row);

  applyLayer(rows.filter(isCategory));
  applyLayer(rows.filter(isChannel));
  return mask >>> 0;
}

// overwritesTouchDeny(roleRows, overwriteRows): the graceful-default gate's
// ONE question — does any deny in the channel's layer chain actually bind
// THIS member (an @everyone row always binds; a role row binds only when the
// member holds that role)? When the answer is NO the channel behaves exactly
// like the pre-0007 server, no matter how many other members' overwrites
// exist.
export function overwritesTouchDeny(roleRows, overwriteRows) {
  const roles = Array.isArray(roleRows) ? roleRows : [];
  const held = new Set(roles.map((role) => Number(role?.id)).filter(Number.isInteger));
  for (const row of Array.isArray(overwriteRows) ? overwriteRows : []) {
    if (!row || typeof row !== "object") continue;
    const bindsViewer = row.role_id === null || row.role_id === undefined ||
      held.has(Number(row.role_id));
    if (bindsViewer && (Number(row.deny_mask) || 0) !== 0) return true;
  }
  return false;
}

// --- the RBAC-audit H1 repair: exact role-mask folds ----------------------------
//
// Neither mask authority may SUM: a member holding the SAME bit in two roles
// produces bit + bit, which reads as the NEXT-higher bit (2×MANAGE_EMOJI
// reads as MENTION_EVERYONE, 2×MANAGE_ROLES as KICK_MEMBERS, ...). SQLite
// carries no bitwise aggregate on today's engine, so every mask resolves
// EXACTLY through one of two shapes:
//   - holdsRolesBitsSql(serverId, actorId, bits): a GUARD — one EXISTS per
//     required bit, each answered by ANY single held role (the mask-consumer
//     "holds every bit" reading, exact; the bit constants ride the SQL text
//     so the bind pair stays serverId, actorId per bit).
//   - roleMaskColumnSql() + parseMergedMask: a SELECTED mask — GROUP_CONCAT
//     of the held rows' masks folded in JS (same (serverId, userId) bind
//     pair, an exact bitwise OR).
export function holdsRolesBitsSql(bits) {
  const list = Array.isArray(bits) ? bits : [bits];
  const parts = [];
  for (const bit of list) {
    const suffix = Number(bit);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new Error("holdsRolesBitsSql: a bit constant must be a positive integer");
    }
    parts.push(
      "EXISTS (SELECT 1 FROM gc_member_roles gbm" + suffix + " JOIN gc_roles gbr" + suffix +
        " ON gbr" + suffix + ".id = gbm" + suffix + ".role_id " +
        "WHERE gbm" + suffix + ".server_id = ? AND gbm" + suffix + ".user_id = ? " +
        "AND (gbr" + suffix + ".permissions & " + suffix + ") <> 0)",
    );
  }
  return "(" + parts.join(" AND ") + ")";
}

// The binds the per-bit EXISTS consumes, in fragment order (for .bind(...)).
export function holdsRolesBitsParams(serverId, actorId, bits) {
  const list = Array.isArray(bits) ? bits : [bits];
  const params = [];
  for (const _bit of list) {
    params.push(serverId, actorId);
  }
  return params;
}

// The mask COLUMN: the held rows' masks concatenated, folded in JS.
export function roleMaskColumnSql() {
  return "(SELECT COALESCE(GROUP_CONCAT(ar.permissions), '') FROM gc_member_roles gmr " +
    "JOIN gc_roles ar ON ar.id = gmr.role_id WHERE gmr.server_id = ? AND gmr.user_id = ?)";
}

export function parseMergedMask(raw) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text === "") return 0;
  let mask = 0;
  for (const part of text.split(",")) {
    const value = Number(part);
    if (Number.isSafeInteger(value) && value > 0) mask |= value;
  }
  return mask;
}
