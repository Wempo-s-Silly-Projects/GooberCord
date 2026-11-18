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

// T78 Starter Grove (docs/drafts/t78-starter-grove-spec.md): the server-
// template lane — a Grove is DATA naming permission bits, and the apply
// produces EXACTLY the explicit overwrites hand-rolling would, never a
// hidden grant. validateTemplate is PURE (no env, no DB — every refusal is
// unbound); applyTemplate pre-checks the caps and name collisions with
// cheap reads (the route's own count idiom), then runs ONE all-or-nothing
// batch whose statements are the hand-rolled shapes (the role INSERT's
// authority rider + cap precondition, the cap-guarded channel INSERT, and
// the private toggle's pair) — the overwrite rows bind their channel/role
// seats by NAME-reselect, never a rowid (the remote-D1 batch rowid reset,
// live-verified at api/servers.mjs's compensated create).
import {
  GC_CATEGORIES_MAX_PER_SERVER,
  GC_ROLES_MAX_PER_SERVER,
  MAX_CHANNELS_PER_SERVER,
} from "../constants.mjs";
import {
  holdsRolesBitsParams,
  holdsRolesBitsSql,
  OVERWRITE_BITS,
  SERVER_PERMISSIONS,
  SLOWMODE_CHOICES,
} from "./permissions.mjs";
import { requireUser } from "./core/auth.mjs";
import { HttpError, json, readJson } from "./core/http.mjs";

export const GROVE_SCHEMA_VERSION = 1;

const GROVE_NAME_MAX = 64;
const GROVE_DESCRIPTION_MAX = 280;
const GROVE_ROW_NAME_MAX = 32;
const GROVE_REFUSAL_PREFIX = "That Grove";

// The hand-rolled shapes' rider (the server-create route's own owner arm,
// api/servers.mjs's OWNER_EXISTS_SQL).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// The two vocabularies the no-hidden-grants law reads: a role mask names the
// SERVER_PERMISSIONS bit words; an overwrite layer names ONLY the
// OVERWRITE_BITS tri-state words (VIEW, SEND, CONNECT, SPEAK, ADD_REACTIONS).
const ROLE_BIT_NAMES = Object.freeze(Object.keys(SERVER_PERMISSIONS));
const OVERWRITE_BIT_NAMES = Object.freeze(OVERWRITE_BITS.map((bit) =>
  Object.keys(SERVER_PERMISSIONS).find((name) => SERVER_PERMISSIONS[name] === bit)));
const CHANNEL_KINDS = Object.freeze(["text", "voice", "category"]);

// --- author-time validation (PURE — the refusal is never a bound statement) --

function groveRefusal(reason) {
  return `${GROVE_REFUSAL_PREFIX}: ${reason}`;
}

function maskFromNames(raw, allowedNames) {
  if (!Array.isArray(raw)) return groveRefusal(`permission seats must be an array (got ${typeof raw}).`);
  let mask = 0;
  for (const name of raw) {
    if (!allowedNames.includes(name)) {
      return groveRefusal(`unknown permission bit: ${String(name)}.`);
    }
    mask |= Number(SERVER_PERMISSIONS[name]);
  }
  return mask;
}

const deepFreeze = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
    return value;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
    return value;
  }
  return value;
};

export function validateTemplate(grove) {
  if (grove === null || typeof grove !== "object" || Array.isArray(grove)) {
    return { ok: false, refusal: groveRefusal("the document must be an object.") };
  }
  const { schema, name, description = "", roles, channels, overwrites } = grove;
  if (schema !== GROVE_SCHEMA_VERSION) {
    return { ok: false, refusal: groveRefusal(`unknown schema: ${String(schema)}.`) };
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > GROVE_NAME_MAX) {
    return { ok: false, refusal: groveRefusal(`name must be 1-${GROVE_NAME_MAX} characters.`) };
  }
  if (typeof description !== "string" || description.length > GROVE_DESCRIPTION_MAX) {
    return { ok: false, refusal: groveRefusal(`description must be ${GROVE_DESCRIPTION_MAX} or fewer characters.`) };
  }
  if (!Array.isArray(roles) || !Array.isArray(channels) || !Array.isArray(overwrites)) {
    return { ok: false, refusal: groveRefusal("roles, channels, and overwrites must be arrays.") };
  }
  if (roles.length > GC_ROLES_MAX_PER_SERVER) {
    return { ok: false, refusal: groveRefusal(`roles exceed ${GC_ROLES_MAX_PER_SERVER}.`) };
  }
  if (channels.length > MAX_CHANNELS_PER_SERVER) {
    return { ok: false, refusal: groveRefusal(`channels exceed ${MAX_CHANNELS_PER_SERVER}.`) };
  }

  const roleRows = [];
  const roleNames = new Set();
  for (const role of roles) {
    if (role === null || typeof role !== "object" || Array.isArray(role)) {
      return { ok: false, refusal: groveRefusal("a role row must be an object.") };
    }
    const { name: roleName, color = null, permissions = [] } = role;
    if (typeof roleName !== "string" || roleName.trim() === ""
      || roleName.length > GROVE_ROW_NAME_MAX) {
      return { ok: false, refusal: groveRefusal(`role name must be 1-${GROVE_ROW_NAME_MAX} characters.`) };
    }
    if (roleNames.has(roleName)) {
      return { ok: false, refusal: groveRefusal(`duplicate role name: ${roleName}.`) };
    }
    if (color !== null && !/^#([a-f0-9]{3}|[a-f0-9]{6})$/.test(color)) {
      return { ok: false, refusal: groveRefusal(`role ${roleName}: color must be lowercase #rgb or #rrggbb.`) };
    }
    const mask = maskFromNames(permissions, ROLE_BIT_NAMES);
    if (typeof mask === "string") return { ok: false, refusal: mask };
    roleNames.add(roleName);
    roleRows.push({ name: roleName, color, permissions: mask });
  }

  const channelRows = [];
  const channelNames = new Set();
  for (const channel of channels) {
    if (channel === null || typeof channel !== "object" || Array.isArray(channel)) {
      return { ok: false, refusal: groveRefusal("a channel row must be an object.") };
    }
    const { name: channelName, kind, topic = "", slowmode = 0, private: isPrivate = false } = channel;
    if (typeof channelName !== "string" || channelName.trim() === ""
      || channelName.length > GROVE_ROW_NAME_MAX) {
      return { ok: false, refusal: groveRefusal(`channel name must be 1-${GROVE_ROW_NAME_MAX} characters.`) };
    }
    if (channelNames.has(channelName)) {
      return { ok: false, refusal: groveRefusal(`duplicate channel name: ${channelName}.`) };
    }
    if (!CHANNEL_KINDS.includes(kind)) {
      return { ok: false, refusal: groveRefusal(`unknown channel kind: ${String(kind)}.`) };
    }
    if (!SLOWMODE_CHOICES.includes(slowmode)) {
      return { ok: false, refusal: groveRefusal(`unknown slowmode: ${String(slowmode)}.`) };
    }
    if (typeof isPrivate !== "boolean") {
      return { ok: false, refusal: groveRefusal(`channel ${channelName}: private must be a boolean.`) };
    }
    if (isPrivate && kind !== "text") {
      return { ok: false, refusal: groveRefusal(`channel ${channelName}: only a text channel rides the private toggle.`) };
    }
    if (typeof topic !== "string" || topic.length > 1024) {
      return { ok: false, refusal: groveRefusal(`channel ${channelName}: topic must be 1024 or fewer characters.`) };
    }
    channelNames.add(channelName);
    channelRows.push({ name: channelName, kind, topic, slowmode, private: isPrivate });
  }

  const overwriteRows = [];
  for (const row of overwrites) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, refusal: groveRefusal("an overwrite row must be an object.") };
    }
    const { channel: channelName, role: roleName, deny = [], allow = [] } = row;
    if (typeof channelName !== "string" || !channelNames.has(channelName)) {
      return { ok: false, refusal: groveRefusal(`overwrite names an unknown channel: ${String(channelName)}.`) };
    }
    if (roleName !== null && (typeof roleName !== "string" || !roleNames.has(roleName))) {
      return { ok: false, refusal: groveRefusal(`overwrite names an unknown role: ${String(roleName)}.`) };
    }
    const denyMask = maskFromNames(deny, OVERWRITE_BIT_NAMES);
    if (typeof denyMask === "string") return { ok: false, refusal: denyMask };
    const allowMask = maskFromNames(allow, OVERWRITE_BIT_NAMES);
    if (typeof allowMask === "string") return { ok: false, refusal: allowMask };
    if ((denyMask & allowMask) !== 0) {
      return { ok: false, refusal: groveRefusal(`overwrite ${channelName}: a bit cannot ride deny and allow together.`) };
    }
    if (denyMask === 0 && allowMask === 0) {
      return { ok: false, refusal: groveRefusal(`overwrite ${channelName}: a layer with no deny and no allow states nothing.`) };
    }
    const target = channelRows.find((channel) => channel.name === channelName);
    if (roleName === null && target.private === true
      && (denyMask & SERVER_PERMISSIONS.VIEW) === 0) {
      return { ok: false, refusal: groveRefusal(
        `channel ${channelName}: the private @everyone deny carries the toggle's VIEW seat.`,
      ) };
    }
    overwriteRows.push({ channel: channelName, role: roleName, deny: denyMask, allow: allowMask });
  }

  return {
    ok: true,
    template: deepFreeze({
      schema: GROVE_SCHEMA_VERSION,
      name,
      description,
      roles: roleRows,
      channels: channelRows,
      overwrites: overwriteRows,
    }),
  };
}

// --- the apply (pre-checked caps, then ONE all-or-nothing batch) --------------

// The hand-rolled role INSERT shape (api/servers.mjs's ROLE_INSERT_SQL): the
// authority rider inside the INSERT … SELECT, the position appends inside the
// statement, and the explicit-role cap precondition rides the same WHERE.
const GROVE_ROLE_INSERT_SQL =
  "INSERT INTO gc_roles (server_id, name, color, position, permissions, created_at) " +
    "SELECT ?, ?, ?, " +
    "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_roles WHERE server_id = ?), ?, ? " +
    "WHERE (" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_ROLES) + ") " +
    "AND (SELECT COUNT(*) FROM gc_roles WHERE server_id = ?) < " + (GC_ROLES_MAX_PER_SERVER - 1);

// The cap-guarded channel INSERT shape (api/servers.mjs's CAP_CHANNEL_INSERT_
// SQL's WHERE). The apply's text/voice channels carry no category and no
// slowmode seat, so the bare shape covers them.
const GROVE_CHANNEL_INSERT_SQL =
  "INSERT INTO gc_channels (server_id, name, kind, position, created_at) " +
    "SELECT ?, ?, ?, " +
    "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_channels WHERE server_id = ?), ? " +
    "WHERE (EXISTS (" +
      "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? " +
      "AND role IN ('owner','moderator')" +
    ") OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + ") " +
    "AND (SELECT COUNT(*) FROM gc_channels WHERE server_id = ?) <= " + (MAX_CHANNELS_PER_SERVER - 1);

// The category INSERT shape (api/servers.mjs's CATEGORY_INSERT_SQL).
const GROVE_CATEGORY_INSERT_SQL =
  "INSERT INTO gc_channel_categories (server_id, name, position, created_at) " +
    "SELECT ?, ?, " +
    "(SELECT COALESCE(MAX(position), -1) + 1 FROM gc_channel_categories WHERE server_id = ?), ? " +
    "WHERE " + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_CHANNELS) + " " +
    "AND (SELECT COUNT(*) FROM gc_channel_categories WHERE server_id = ?) <= " + (GC_CATEGORIES_MAX_PER_SERVER - 1);

// The private toggle's pair (api/servers.mjs's PRIVATE_* shapes), re-seated by
// NAME because the apply's channels are rowid-invisible inside the batch (the
// live-verified remote-D1 reset), and the channel id binds as a literal only
// when the route resolves it OUTSIDE the batch. A document @everyone layer on
// a private channel carries the toggle's own VIEW seat (validated above), so
// that row is the author's stated deny mask standing for the toggle's.
const PRIVATE_EVERYONE_DENY_SQL =
  "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
    "SELECT id, NULL, 0, ? FROM gc_channels WHERE server_id = ? AND name = ?";

// The per-role allow arm covers every role the document itself does not name
// for the private channel (the toggle's blanket allow, minus the seats the
// author's own rows make more specific).
function privateRoleAllowSql(coveredNames) {
  const except = coveredNames.map(() => "?").join(", ");
  return "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
    "SELECT id, id, ?, 0 FROM gc_roles WHERE server_id = ?" +
    (coveredNames.length > 0 ? " AND name NOT IN (" + except + ")" : "");
}

// A document overwrite row: the channel seat rides gc_channels by name; the
// role seat rides gc_roles by name, or rides NULL for the @everyone layer.
const DOCUMENT_ROLE_TARGET_SQL =
  "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
    "SELECT c.id, r.id, ?, ? FROM gc_channels c JOIN gc_roles r ON r.server_id = c.server_id " +
    "WHERE c.server_id = ? AND c.name = ? AND r.name = ?";

const DOCUMENT_EVERYONE_TARGET_SQL =
  "INSERT INTO gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask) " +
    "SELECT c.id, NULL, ?, ? FROM gc_channels c WHERE c.server_id = ? AND c.name = ?";

export async function applyTemplate(db, ctx, grove) {
  const { serverId, creatorId } = ctx;
  const now = Math.floor(Date.now() / 1000);

  // Pre-checked caps (the route's count idiom): cheap reads BEFORE one
  // statement binds, so a refusal never leaves a partial batch behind.
  const channelCount = await db.prepare(
    "SELECT COUNT(*) AS n FROM gc_channels WHERE server_id = ?",
  ).bind(serverId).first();
  if ((Number(channelCount?.n) || 0) + grove.channels.length > MAX_CHANNELS_PER_SERVER) {
    return { ok: false, refusal: "That server has reached its channel limit." };
  }
  const roleCount = await db.prepare(
    "SELECT COUNT(*) AS n FROM gc_roles WHERE server_id = ?",
  ).bind(serverId).first();
  if ((Number(roleCount?.n) || 0) + grove.roles.length > GC_ROLES_MAX_PER_SERVER) {
    return { ok: false, refusal: "That server has reached its role limit." };
  }

  // Name collisions: a Grove row cannot rename over an existing seat (the
  // fork's honest refusal — names are the seats the reselects resolve by).
  const channelNameRide = await db.prepare(
    "SELECT name FROM gc_channels WHERE server_id = ?",
  ).bind(serverId).all();
  const channelNamesPresent = new Set((channelNameRide.results || []).map((row) => row.name));
  for (const row of grove.channels) {
    if (channelNamesPresent.has(row.name)) {
      return { ok: false, refusal: `A channel named ${row.name} already exists here.` };
    }
  }
  const roleNameRide = await db.prepare(
    "SELECT name FROM gc_roles WHERE server_id = ?",
  ).bind(serverId).all();
  const roleNamesPresent = new Set((roleNameRide.results || []).map((row) => row.name));
  for (const row of grove.roles) {
    if (roleNamesPresent.has(row.name)) {
      return { ok: false, refusal: `A role named ${row.name} already exists here.` };
    }
  }

  const statements = [];

  // Roles: one INSERT per row, the hand-rolled shape's full bind order.
  for (const row of grove.roles) {
    statements.push(
      db.prepare(GROVE_ROLE_INSERT_SQL).bind(
        serverId, row.name, row.color, serverId, row.permissions, now,
        serverId, creatorId,
        ...holdsRolesBitsParams(serverId, creatorId, SERVER_PERMISSIONS.MANAGE_ROLES),
        serverId,
      ),
    );
  }

  // Channels: text/voice ride the channel INSERT; categories ride the
  // category INSERT. The private seat never touches the INSERT itself — it
  // lives in the overwrite pair below.
  for (const row of grove.channels) {
    const sql = row.kind === "category" ? GROVE_CATEGORY_INSERT_SQL : GROVE_CHANNEL_INSERT_SQL;
    statements.push(
      db.prepare(sql).bind(
        serverId, row.name, row.kind, serverId, now,
        serverId, creatorId,
        ...holdsRolesBitsParams(serverId, creatorId, SERVER_PERMISSIONS.MANAGE_CHANNELS),
        serverId,
      ),
    );
  }

  // The overwrite surface: the private toggle's pair for every private
  // channel (a document @everyone layer carries the deny arm's seat — it is
  // the author's stated mask standing in for the toggle's — and the blanket
  // role-allow arm covers every role the document itself does not name for
  // the channel), then every document row verbatim.
  const overwriteStatements = [];
  for (const row of grove.channels.filter((channel) => channel.private === true)) {
    const documentEveryone = grove.overwrites.find(
      (layer) => layer.channel === row.name && layer.role === null,
    );
    if (documentEveryone !== undefined) {
      overwriteStatements.push(
        db.prepare(PRIVATE_EVERYONE_DENY_SQL)
          .bind(documentEveryone.deny, serverId, row.name),
      );
    } else {
      // No document layer: the toggle's own deny seat rides untouched.
      overwriteStatements.push(
        db.prepare(PRIVATE_EVERYONE_DENY_SQL)
          .bind(SERVER_PERMISSIONS.VIEW, serverId, row.name),
      );
    }
    const documentRoles = new Set(grove.overwrites
      .filter((layer) => layer.channel === row.name && layer.role !== null)
      .map((layer) => layer.role));
    overwriteStatements.push(
      db.prepare(privateRoleAllowSql([...documentRoles]))
        .bind(SERVER_PERMISSIONS.VIEW, serverId, ...documentRoles),
    );
  }
  for (const row of grove.overwrites) {
    // A private channel's document @everyone layer already rode the private
    // pair's deny seat (the merge above) — emitting it again would be a
    // second row for one (channel, role) seat, the unique key's violation.
    const consumed = (() => {
      if (row.role !== null) return false;
      const target = grove.channels.find((channel) => channel.name === row.channel);
      return target !== undefined && target.private === true;
    })();
    if (consumed) continue;
    overwriteStatements.push(
      row.role === null
        ? db.prepare(DOCUMENT_EVERYONE_TARGET_SQL)
            .bind(row.allow, row.deny, serverId, row.channel)
        : db.prepare(DOCUMENT_ROLE_TARGET_SQL)
            .bind(row.allow, row.deny, serverId, row.channel, row.role),
    );
  }

  const results = await db.batch([...statements, ...overwriteStatements]);

  // The all-or-nothing verdict: a batch is one transaction, so any statement
  // whose changes verdict is not the one is a refusal and the transaction
  // carries no partial rows.
  for (const result of results) {
    if (Number(result.meta?.changes) !== 1) {
      return { ok: false, refusal: "That Grove could not apply to this server." };
    }
  }

  return {
    ok: true,
    applied: {
      roles: grove.roles.length,
      channels: grove.channels.length,
      overwrites: overwriteStatements.length,
    },
  };
}

// --- the route (wired in the servers dispatch) ---------------------------------

// The route body: POST /api/servers/:serverId/grove (spec §3). The gate: the
// applicant is the owner, a moderator, or holds BOTH managing bits (the Grove
// writes roles AND channels in one batch — a single-bit holder cannot ride it).
// A non-member shares the same 403 copy — no server-existence oracle. The
// author-time refusal is a 400 before one statement binds; the apply's
// pre-check refusals (caps, name collisions) ride the same 400 after the gate
// let them in.
export async function handleApplyGroveRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  const membership = await env.GOOBER_DB.prepare(
    "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  const tierAuthority = membership?.role === "owner" || membership?.role === "moderator";
  let roleAuthority = false;
  if (!tierAuthority && membership) {
    // The RBAC half of the question, the per-bit EXISTS (no SUM carry).
    const manageBits = SERVER_PERMISSIONS.MANAGE_ROLES | SERVER_PERMISSIONS.MANAGE_CHANNELS;
    const allowed = await env.GOOBER_DB.prepare(
      "SELECT 1 AS allowed FROM gc_server_members m " +
        "WHERE m.server_id = ? AND m.user_id = ? AND " +
        holdsRolesBitsSql(manageBits) + " LIMIT 1",
    ).bind(serverId, userId, serverId, userId).first();
    roleAuthority = allowed !== null;
  }
  if (!tierAuthority && !roleAuthority) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const grove = await readJson(request);
  const validated = validateTemplate(grove);
  if (!validated.ok) {
    throw new HttpError(400, validated.refusal);
  }
  const applied = await applyTemplate(
    env.GOOBER_DB, { serverId, creatorId: userId }, validated.template,
  );
  if (!applied.ok) {
    throw new HttpError(400, applied.refusal);
  }
  return json({ applied: applied.applied });
}
