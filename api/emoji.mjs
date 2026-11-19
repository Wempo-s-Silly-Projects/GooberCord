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

// Server custom emoji + stickers (parity bundle, Nov 17 2026, migration
// 0020): CRUD exactly like the server-icon lane — the picture IS a
// gc_attachments row (same standalone intake, same pending moderation, same
// serving gate), the write authorization rides INSIDE the statements (owner
// tier OR the gc_roles MANAGE_EMOJI bit), and the inventory cap rides the
// create statement itself, so a burst of parallel creates can never
// overshoot 50 per server.
//
// THE WIRE TOKENS: a message body references an emoji as <e:name:id> and a
// sticker as <s:name:id> (GC's bracket form of Discord's :name:id). The id
// never changes even across a rename, so old messages keep rendering. The
// send-time rules live with the other message gates (api/messages.mjs): a
// token renders only when its id resolves (unknown ids are plain text), and
// a token pointing at a DIFFERENT server than the channel's own is a
// Goober+ perk (external emoji) — refused before anything is stored, and
// inside a DM/group channel EVERY resolved token is external.
//
// The read path hands rows out as { id, serverId, name, url, createdAt };
// loadServerExpressions is the message-list side table (one read per table,
// the channel's server), so the client resolves tokens locally.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_EMOJI_FILE_MAX,
  GC_EMOJI_NAME_MAX,
  GC_EMOJI_NAME_MIN,
  GC_EMOJI_NAME_PATTERN,
  GC_STICKER_FILE_MAX,
  GC_STICKER_NAME_MAX,
  GC_STICKER_NAME_MIN,
  GC_STICKER_NAME_PATTERN,
} from "../constants.mjs";
import { SERVER_PERMISSIONS, holdsRolesBitsSql, holdsRolesBitsParams, parseMergedMask, roleMaskColumnSql } from "./permissions.mjs";
import { plusMemberActive } from "./plus.mjs";
// The create intake IS the attachment intake (magic bytes, structural
// sanitizer, 64k chunks, pending moderation) reused end to end — no second
// storage gate can ever drift away from the message one.
import { createAttachment, readMultipartWithImage } from "./media.mjs";
import { serverBoostTier } from "./boost-level.mjs";
// The manage-guard fragments mirror the channel-delete lane's shapes
// (servers.mjs) — kept local rather than imported so the bundle's commit can
// stay atomic while that module is mid-flight; a guard change must be
// re-mirrored here (the parity tests pin BOTH copies' behavior).
const MERGED_PERMS_SELECT = roleMaskColumnSql();

const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// The token scanners. Both id parts are strict integers ([1-9][0-9]*) — a
// malformed token is never an expression, it is TEXT and renders as text.
export const EMOJI_TOKEN_PATTERN = /<e:([A-Za-z0-9_]{2,32}):([1-9][0-9]*)>/g;
export const STICKER_TOKEN_PATTERN = /<s:([A-Za-z0-9_]{2,30}):([1-9][0-9]*)>/g;

// The token BUILDERS (id-stable across renames — callers pass the row's id,
// never name-dependent state).
export function emojiToken(name, id) {
  return "<e:" + String(name) + ":" + Number(id) + ">";
}

export function stickerToken(name, id) {
  return "<s:" + String(name) + ":" + Number(id) + ">";
}

function attachmentUrl(attachmentId) {
  return "/api/attachments/" + Number(attachmentId);
}

// Every expression reference a body carries, both kinds, one pass. Duplicates
// are the CALLER's problem at render time; the gate de-duplicates its reads.
export function referencedExpressionIds(text) {
  const emojiIds = [];
  const stickerIds = [];
  for (const match of String(text || "").matchAll(EMOJI_TOKEN_PATTERN)) {
    emojiIds.push(Number(match[2]));
  }
  for (const match of String(text || "").matchAll(STICKER_TOKEN_PATTERN)) {
    stickerIds.push(Number(match[2]));
  }
  return { emojiIds, stickerIds };
}

// The send-time external-emoji gate (the owner's plus-at-SEND ruling). One
// read per kind over the referenced ids, then:
//   - unknown ids are ignored (not expressions — text);
//   - ids on the channel's own server are free for every member;
//   - everything else — another server inside a server channel, or ANY
//     resolved token inside a DM/group channel (no channel server at all) —
//     needs an ACTIVE Goober+ term (the matrix's "custom emoji anywhere"
//     rides Mini too, so the MINI-INCLUSIVE predicate answers; a
//     grace-window member rides the free tier only).
export async function enforceExpressionTokenAccess(env, senderId, channelServerId, text) {
  const { emojiIds, stickerIds } = referencedExpressionIds(text);
  if (emojiIds.length === 0 && stickerIds.length === 0) return;

  const isExternal = [];
  for (const [ids, table] of [[emojiIds, "gc_emoji"], [stickerIds, "gc_stickers"]]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) continue;
    const { results } = await env.GOOBER_DB.prepare(
      "SELECT id, server_id FROM " + table + " WHERE id IN (" +
        unique.map(() => "?").join(",") + ")",
    ).bind(...unique).all();
    for (const row of results || []) {
      const rowServerId = Number(row.server_id);
      if (channelServerId === null || !Number.isInteger(channelServerId) ||
          rowServerId !== channelServerId) {
        isExternal.push(Number(row.id));
      }
    }
  }
  if (isExternal.length === 0) return;

  if (await plusMemberActive(env, senderId, nowSeconds())) return;
  throw new HttpError(403, "Using another server's emoji is a Goober+ perk.");
}

export function expressionPayloadRow(row) {
  return {
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: row.name,
    url: attachmentUrl(row.attachment_id),
    createdAt: row.created_at === null || row.created_at === undefined
      ? null
      : new Date(Number(row.created_at) * 1000).toISOString(),
  };
}

// One read per table. The reads are NOT capped at the boost level's
// EFFECTIVE inventory: the sticker ladder's level-0 base is 5 (0025's parity
// pass) — a server whose inventory was built at a HIGHER level keeps its
// rows (never deleted; only new creates blocked), and tokens referencing
// those rows must still RESOLVE, so the reads bound on what exists. The
// create statement carries the cap and nothing else does.
export async function loadServerExpressions(env, serverId) {
  const emojis = [];
  const stickers = [];
  const tables = [
    ["gc_emoji", emojis],
    ["gc_stickers", stickers],
  ];
  for (const [table, into] of tables) {
    const { results } = await env.GOOBER_DB.prepare(
      "SELECT id, server_id, name, attachment_id, created_at FROM " + table +
        " WHERE server_id = ? ORDER BY name, id",
    ).bind(Number(serverId)).all();
    for (const row of results || []) into.push(expressionPayloadRow(row));
  }
  // The contract stays additive-free: the tier's level is derivable from the
  // boosts count every server payload already carries, so the expressions
  // table gains no new key.
  return { emojis, stickers };
}

// --- CRUD ---------------------------------------------------------------------
//
// The two kinds are ONE parameterized shape (the twin tables differ only in
// table name, token letter, and route word), so every statement below is
// written once against `kind` — the drift guard the twin-table ruling wanted
// by construction.
// The inventory caps are NOT part of these entries: the create route reads
// the BOOST LEVEL's effective cap per request (the resolver's max-of-base-
// and-level shape — a level never lowers an inventory), riding
// api/boost-level.mjs, and the side-table loader caps its reads the same
// way.
const KIND = {
  emoji: {
    table: "gc_emoji",
    word: "emoji",
    routes: "emojis",
    // The FILE cap (W-B0 parity law):
    // docs/parity-limits.md: Emoji file limit 256 KB (verified 2026-11-17).
    fileMax: GC_EMOJI_FILE_MAX,
    tooLargeCopy: "Emoji must be 256 KB or smaller.",
  },
  sticker: {
    table: "gc_stickers",
    word: "sticker",
    routes: "stickers",
    // docs/parity-limits.md: Sticker file limit 512 KB (verified 2026-11-17).
    fileMax: GC_STICKER_FILE_MAX,
    tooLargeCopy: "Stickers must be 512 KB or smaller.",
  },
};

// The SAME authority fragment every write carries — string-tier owner OR the
// MANAGE_EMOJI per-bit EXISTS (binds follow the fragment order
// OWNER(server, actor) bits(server, actor)).
function manageGuard(serverId, actorId) {
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_EMOJI) + ")",
    params: [serverId, actorId, ...holdsRolesBitsParams(serverId, actorId, SERVER_PERMISSIONS.MANAGE_EMOJI)],
  };
}

// Per-kind name bounds (the 0026 widenings): the sticker's 30 is EXACT —
// NOT a 32 superset (docs/parity-limits.md; a 31-char sticker name failing
// is parity-correct) — and the copy follows the bound it enforces.
const NAME_BOUNDS_BY_KIND = Object.freeze({
  emoji: {
    min: GC_EMOJI_NAME_MIN,
    max: GC_EMOJI_NAME_MAX,
    pattern: GC_EMOJI_NAME_PATTERN,
  },
  sticker: {
    min: GC_STICKER_NAME_MIN,
    max: GC_STICKER_NAME_MAX,
    pattern: GC_STICKER_NAME_PATTERN,
  },
});

function validExpressionName(value, kind) {
  const bounds = NAME_BOUNDS_BY_KIND[kind];
  if (typeof value !== "string" || !bounds.pattern.test(value)) {
    throw new HttpError(
      400,
      "Use a " + bounds.min + "-" + bounds.max +
      " character name of letters, numbers and underscores.",
    );
  }
  return value;
}

function validExpressionId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id >= 1_000_000_000_000) {
    throw new HttpError(400, "That id is invalid.");
  }
  return id;
}

// The read-tier membership gate (no membership → the shared 404, never an
// existence oracle).
async function memberGate(env, serverId, userId) {
  const exists = await env.GOOBER_DB.prepare(
    "SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  if (!exists) throw new HttpError(404, "That server does not exist or you are not in it.");
}

// The write-tier authority read, the channel-delete lane's exact two-step:
// string tiers first, then the merged role mask for everyone else.
async function expressionAuthority(env, serverId, actorId) {
  const membership = await env.GOOBER_DB.prepare(
    "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, actorId).first();
  if (!membership) return { isMember: false, authoritative: false };
  let authoritative =
    membership.role === "owner" || membership.role === "moderator";
  if (!authoritative) {
    const perms = await env.GOOBER_DB.prepare(
      "SELECT (" + MERGED_PERMS_SELECT + ") AS permissions " +
        "FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ? LIMIT 1",
    ).bind(serverId, actorId, serverId, actorId).first();
    authoritative = ((parseMergedMask(perms?.permissions)) &
      SERVER_PERMISSIONS.MANAGE_EMOJI) === SERVER_PERMISSIONS.MANAGE_EMOJI;
  }
  return { isMember: true, authoritative };
}

async function handleListExpressionsRoute(request, env, serverId, kind) {
  const session = await requireSignedInRead(request, env);
  await memberGate(env, Number(serverId), Number(session.user.id));
  const { emojis, stickers } = await loadServerExpressions(env, Number(serverId));
  // The caps rider (W-B0, the reviewer's payload-gap item): the manage UI
  // shows real slot counters, resolved per server — the shape the manage
  // surface reads verbatim (the sounds key mirrors the board's resolver).
  const tier = await serverBoostTier(env, Number(serverId));
  const caps = {
    emoji: tier.caps.emoji,
    stickers: tier.caps.stickers,
    sounds: tier.caps.soundboard,
  };
  return json(kind === "emoji" ? { emojis, caps } : { stickers, caps });
}

// --- create -------------------------------------------------------------------
//
// The manage guard, the CALLER'S-OWN-attachment rule (the server-icon rule—
// someone else's pending upload can never be referenced), the file cap
// (parity law: emoji 256 KB / sticker 512 KB), and the inventory cap all
// ride the SAME SELECT-arm INSERT, so an unauthorized, mismatched or
// over-cap create is a zero-changes statement, never a partial row.
// The shared-asset arms (W-B0, the reviewer's delete-then-serve-404 fix):
// an attachment already referenced by any expression or sound row, or
// carrying a message id, can never START a new expression life — so
// delete-while-referenced becomes UNschedulable, not merely survivable. A
// name collision is the UNIQUE violation the statement throws (never a
// silent skip), answered 409.
const EXPRESSION_INSERT_SQL = (table) =>
  "INSERT INTO " + table + " (server_id, name, attachment_id, created_by, created_at) " +
    "SELECT ?, ?, ?, ?, ? " +
    "WHERE (" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_EMOJI) + ") " +
    "AND EXISTS (SELECT 1 FROM gc_attachments a WHERE a.id = ? AND a.uploader_id = ? " +
      // Neither the file cap nor the message guard can ever be a race: both
      // columns are the row's own, frozen since the intake wrote them.
      "AND a.message_id IS NULL AND a.size_bytes <= ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?)";

async function handleCreateExpressionRoute(request, env, serverId, kind) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "emoji:" + session.user.id);
  const actorId = Number(session.user.id);
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();

  let attachmentId = null;
  let name = null;
  if (contentType.startsWith("multipart/form-data")) {
    await rateLimit(request, env, "upload", "user:" + actorId);
    // The kind's OWN file cap (the parity law's emoji 256 KB / sticker 512 KB
    // rows) rides the intake reader BEFORE anything is written — the exact
    // 413 copy, on the raw part size AND the post-read bytes both (the
    // sanitizer can only shrink, so a length check here is a fail-safe twin
    // of the reader's).
    const { fields, files } = await readMultipartWithImage(request, {
      maxFileBytes: KIND[kind].fileMax,
      maxRequestBytes: KIND[kind].fileMax + 512 * 1024,
      tooLargeCopy: KIND[kind].tooLargeCopy,
    });
    name = validExpressionName(fields.name, kind);
    if (files.length > 1) throw new HttpError(400, "Attach exactly one image.");
    if (files.length === 0) {
      throw new HttpError(400, "Attach the image for this " + KIND[kind].word + ".");
    }
    if (files[0].length > KIND[kind].fileMax) {
      throw new HttpError(413, KIND[kind].tooLargeCopy);
    }
    const created = await createAttachment(env, actorId, files[0]);
    attachmentId = Number(created.id);
  } else {
    const body = await readJson(request);
    name = validExpressionName(body.name, kind);
    attachmentId = Number(body.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId < 1) {
      throw new HttpError(400, "Reference one of your own uploaded images.");
    }
  }

  // The boost level's EFFECTIVE cap answers once per create (one PK-indexed
  // resolver read; level 0 answers the base caps the 0020 constants ship).
  const tier = await serverBoostTier(env, Number(serverId));
  const cap = tier.caps[kind === "emoji" ? "emoji" : "stickers"];

  // The multipart branch's upload already ran its limiter; the JSON branch's
  // write limiter is the rateLimit above.
  const result = await env.GOOBER_DB.prepare(
    EXPRESSION_INSERT_SQL(KIND[kind].table) +
      " AND (SELECT COUNT(*) FROM " + KIND[kind].table + " WHERE server_id = ?) < " +
      cap,
  ).bind(
    Number(serverId), name, attachmentId, actorId, nowSeconds(),
    Number(serverId), actorId,
    Number(serverId), actorId,
    // The own-attachment/size/message guard, then the three sibling-never
    // arms: an expression's asset is standalone (no message), within the
    // kind's parity-law file cap, and unreferenced by any row.
    KIND[kind].fileMax,
    attachmentId, attachmentId, attachmentId,
    Number(serverId),
  ).run().catch((error) => {
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(error))) {
      throw new HttpError(409, "That " + KIND[kind].word + " name is already taken in this server.");
    }
    throw error;
  });

  if (Number(result?.meta?.changes) !== 1) {
    // Zero changes — classify by the failing arm, in arm order. ONE read for
    // the cap + the caller-own/shared-asset/size questions, the authority
    // read reuses the channel-delete two-step.
    const state = await env.GOOBER_DB.prepare(
      "SELECT EXISTS (SELECT 1 FROM gc_attachments a WHERE a.id = ? AND a.uploader_id = ?) AS ownAttachment, " +
        "(SELECT size_bytes FROM gc_attachments WHERE id = ?) AS size, " +
        "(SELECT message_id FROM gc_attachments WHERE id = ?) AS messageId, " +
        "EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) AS emojiUsed, " +
        "EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) AS stickersUsed, " +
        "EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) AS soundsUsed, " +
        "(SELECT COUNT(*) FROM " + KIND[kind].table + " WHERE server_id = ?) AS count",
    ).bind(
      attachmentId, actorId,
      attachmentId, attachmentId,
      attachmentId, attachmentId, attachmentId,
      Number(serverId),
    ).first();
    const { isMember, authoritative } = await expressionAuthority(env, Number(serverId), actorId);
    if (!isMember) throw new HttpError(404, "That server does not exist or you are not in it.");
    if (!authoritative) throw new HttpError(403, "You do not have permission to do that.");
    if (Number(state?.count) >= cap) {
      throw new HttpError(400, "This server already has " + cap + " " + KIND[kind].word + ".");
    }
    if (state?.ownAttachment &&
        (state.emojiUsed || state.stickersUsed || state.soundsUsed || state.messageId !== null)) {
      // The shared-asset create arm (W-B0): the bytes already serve another
      // slot or a message — delete-while-referenced must stay unschedulable.
      // The shared arm answers before the size arm: a shared asset's
      // classification stays about the sharing, whichever bound it met.
      throw new HttpError(400, "That image is already referenced elsewhere.");
    }
    if (state?.ownAttachment && Number(state.size) > KIND[kind].fileMax) {
      throw new HttpError(413, KIND[kind].tooLargeCopy);
    }
    throw new HttpError(400, "Reference one of your own uploaded images.");
  }

  // The created row re-read (INSERT..SELECT cannot chain last_row_id into a
  // token — one indexed lookup answers both the id and the payload's shape).
  const row = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, attachment_id, created_at FROM " + KIND[kind].table +
      " WHERE server_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
  ).bind(Number(serverId), name).first();
  if (!row) {
    throw new HttpError(500, "The " + KIND[kind].word + " could not be saved. Please try again.");
  }
  return json({ [kind]: expressionPayloadRow(row) }, 201);
}

// --- rename -------------------------------------------------------------------

async function handleRenameExpressionRoute(request, env, serverId, expressionId, kind) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "emoji:" + session.user.id);
  const body = await readJson(request);
  const name = validExpressionName(body.name, kind);
  const expressionIdNum = validExpressionId(expressionId);
  const actorId = Number(session.user.id);
  const guard = manageGuard(Number(serverId), actorId);

  let result;
  try {
    result = await env.GOOBER_DB.prepare(
      "UPDATE " + KIND[kind].table + " SET name = ? WHERE id = ? AND server_id = ? AND " + guard.sql,
    ).bind(name, expressionIdNum, Number(serverId), ...guard.params).run();
  } catch (error) {
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(error))) {
      throw new HttpError(409, "That " + KIND[kind].word + " name is already taken in this server.");
    }
    throw error;
  }
  if (Number(result?.meta?.changes) !== 1) {
    // SAME diagnostics discipline as the channel family: with authority the
    // row is unknown (404); without it the shared 403 never probes existence.
    const { isMember, authoritative } = await expressionAuthority(env, Number(serverId), actorId);
    if (!isMember) throw new HttpError(404, "That server does not exist or you are not in it.");
    if (authoritative) throw new HttpError(404, "That " + KIND[kind].word + " does not exist.");
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const row = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, attachment_id, created_at FROM " + KIND[kind].table +
      " WHERE id = ? LIMIT 1",
  ).bind(expressionIdNum).first();
  return json({ [kind]: expressionPayloadRow(row) });
}

// --- delete -------------------------------------------------------------------
//
// The three-statement batch in the channel-delete ordering (chunks →
// expression → attachment LAST, because the attachment FK is RESTRICT — the
// reference must leave first). EVERY statement carries the SAME guard, so an
// unauthorized caller strips nothing even in a pre-cleanup statement. The
// trailing attachment delete carries the protection for every OTHER
// referencer of the same image: another expression row (either table), a
// soundboard row (the 0023 wave's twin — a shared asset is never stripped
// out from under the remaining rows either direction), any
// message attachment (the create intake is standalone-only, but the column
// guard is the cheap fail-safe), so a shared image can never be stripped
// out from under the remaining rows.
//
// The W-B0 fix (the reviewer's HIGH-1): the ROW delete leads the batch, and
// the CHUNK delete carries the sibling arms itself — the chunk statement ran
// FIRST with no arms, so a SHARED attachment's bytes were stripped while a
// sibling survived (serve-then-404, live data loss). Post-row-delete, the
// sibling NOT EXISTS reads decide honestly: shared → the bytes survive with
// the sibling; sole referencer → the bytes leave with the row.
async function handleDeleteExpressionRoute(request, env, serverId, expressionId, kind) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "emoji:" + session.user.id);
  const actorId = Number(session.user.id);
  const expressionIdNum = validExpressionId(expressionId);
  const guard = manageGuard(Number(serverId), actorId);

  const target = await env.GOOBER_DB.prepare(
    "SELECT attachment_id FROM " + KIND[kind].table +
      " WHERE id = ? AND server_id = ? LIMIT 1",
  ).bind(expressionIdNum, Number(serverId)).first();
  if (!target) {
    const { isMember, authoritative } = await expressionAuthority(env, Number(serverId), actorId);
    if (!isMember) throw new HttpError(404, "That server does not exist or you are not in it.");
    if (authoritative) throw new HttpError(404, "That " + KIND[kind].word + " does not exist.");
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM " + KIND[kind].table + " WHERE id = ? AND server_id = ? AND " + guard.sql,
    ).bind(expressionIdNum, Number(serverId), ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachment_chunks WHERE attachment_id = ? AND " +
        "NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) AND " +
        // The message guard in the chunks statement's own terms: the
        // attachment's bytes may only leave while the attachment itself is
        // standalone (the twin of the attachment delete's message_id arm).
        "EXISTS (SELECT 1 FROM gc_attachments a WHERE a.id = ? AND a.message_id IS NULL) AND " +
        guard.sql,
    ).bind(
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      ...guard.params,
    ),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachments WHERE id = ? AND " +
        "NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) AND " +
        "message_id IS NULL AND " + guard.sql,
    ).bind(
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      ...guard.params,
    ),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  return json({ ok: true });
}

// --- dispatch -----------------------------------------------------------------

export async function handleExpressionRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  for (const [kindName, kind] of Object.entries(KIND)) {
    const listMatch = (method === "GET" || method === "POST")
      ? path.match(new RegExp("^/api/servers/([1-9][0-9]*)/" + kind.routes + "$"))
      : null;
    if (listMatch) {
      return method === "GET"
        ? handleListExpressionsRoute(request, env, Number(listMatch[1]), kindName)
        : handleCreateExpressionRoute(request, env, Number(listMatch[1]), kindName);
    }

    const itemMatch = (method === "PATCH" || method === "DELETE")
      ? path.match(new RegExp("^/api/servers/([1-9][0-9]*)/" + kind.routes + "/([1-9][0-9]*)$"))
      : null;
    if (itemMatch) {
      return method === "PATCH"
        ? handleRenameExpressionRoute(request, env, Number(itemMatch[1]), itemMatch[2], kindName)
        : handleDeleteExpressionRoute(request, env, Number(itemMatch[1]), itemMatch[2], kindName);
    }
  }
  return undefined;
}
