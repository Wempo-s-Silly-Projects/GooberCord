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

// Messages routes (Phase 1, Task 5 + Task 6): channel history with a bare-id
// cursor, the idempotent send (JSON and the multipart send-with-image
// variant), the author-only edit, and the three-tier delete with its
// attachment cleanup. The word filter and its site_settings store are the
// vendored forum primitives; the image intake comes from api/media.mjs; the
// http helpers, session gates, and cursors come from api/core. This module
// owns dispatch, request-shape validation, and the authorization — which
// always rides INSIDE the SQL: the channel access check is one
// membership-exists SELECT, the edit is an author-guarded UPDATE, and the
// delete is a single guarded DELETE whose WHERE carries the author, the
// server-moderator, and the platform-staff tiers together (with the
// attachment cleanup carrying that same guard). A failed write is diagnosed
// only after the fact.
//
// The send primitive `sendMessageToChannel` is also Task 8's DO contract:
// the Durable Object calls it with no HTTP route in between, so channel
// access is resolved by the CALLER there and the primitive owns everything
// downstream of it (validation + filter + idempotent insert + channel
// last_message_* bump in one batch, plus — when called with a prepared
// attachment — the attachment's intake INSERT and chunks in that same batch).
import { publicAccent } from "./accent.mjs";
import { grantMessageCoins } from "./coins.mjs";
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import {
  GC_FREE_MESSAGE_MAX,
  GC_MESSAGE_MAX,
  GC_PINS_MAX_PER_CHANNEL,
  GC_PLUS_MESSAGE_MAX,
  MAX_ATTACHMENT_BYTES,
  PINS_READ_BIND_CHUNK,
  RULES_GATE_MESSAGE,
} from "../constants.mjs";
import { applyWordFilter } from "./filter.mjs";
import {
  alertPreview,
  evaluateServerRules,
  filterAlertInsertSql,
  filterAlertPruneSql,
  loadServerRules,
  timeoutAsOwnerSql,
} from "./filterrules.mjs";
import { ensureFilterWords, filterWords } from "./filterstore.mjs";
import {
  SEND_ATTACHMENT_STORE_FAILED_ERROR,
  messageAttachmentSweepStatement,
  messageAttachmentStatements,
  prepareAttachmentBytes,
  putAttachmentObject,
  readMultipartWithImage,
  scheduleAttachmentObjectDelete,
} from "./media.mjs";
import { attachmentCapBytes, plusActiveExpr, plusPerkActive, publicIsPlus, singleShotAttachmentCaps } from "./plus.mjs";
import {
  effectivePermissions,
  enforceVerificationLevel,
  MENTION_EVERYONE,
  overwritesTouchDeny,
  parseMergedMask,
  roleMaskColumnSql,
  SERVER_PERMISSIONS,
} from "./permissions.mjs";
// The expression gates (parity bundle 0020): the send/edit-time external-
// emoji decision and the message-list side table ride the one module —
// importing it is safe (it never imports this module, the worker wires the
// REST routes directly from emoji.mjs).
import { enforceExpressionTokenAccess, loadServerExpressions } from "./emoji.mjs";
// The mentions gates' pure half + the persisted-row writes (W-B2): the flag
// parse both the send and edit lanes gate on, and the in-batch mention
// INSERT...SELECTs (the roster matcher is the contract piece — see
// api/mentions.mjs).
import { mentionPersistStatements, mentionsEveryoneFlag } from "./mentions.mjs";
// History page bounds: the bare-id cursor is the forum's replies convention
// (`[1-9][0-9]{0,14}`, inline at the call site), and a page is at most 100
// rows with 50 as the default.
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

// The forum MASKS stored bodies (posts, chat). GooberCord messages run the
// same masking pass but REJECT instead of storing masked text: a body that
// does not survive the filter unchanged is refused with this 400 copy. With
// an effective EMPTY list (the forum's disabled filter, today's production
// state) the pass is a strict no-op and nothing is ever rejected here.
export const FILTERED_MESSAGE_ERROR = "That message isn't allowed.";

// Extends HttpError so the worker's apiError mapping answers it with the 400
// body directly, while Task 8's DO can catch the class specifically.
export class FilterError extends HttpError {
  constructor() {
    super(400, FILTERED_MESSAGE_ERROR);
    this.name = "FilterError";
  }
}

// One SQL for both membership tiers: server text/voice channels via
// gc_server_members, dm/group conversations via gc_conversation_members. No
// row → 404 (never 403: a non-member must not learn that the channel exists).
const CHANNEL_ACCESS_SQL =
  "SELECT c.id, c.server_id, c.kind FROM gc_channels c WHERE c.id = ? AND (" +
    "(c.server_id IS NOT NULL AND EXISTS (SELECT 1 FROM gc_server_members m " +
      "WHERE m.server_id = c.server_id AND m.user_id = ?)) OR " +
    "(c.server_id IS NULL AND EXISTS (SELECT 1 FROM gc_conversation_members cm " +
      "WHERE cm.channel_id = c.id AND cm.user_id = ?))" +
  ") LIMIT 1";

// The author's Goober+ accent rides the same JOIN (one additive column): a
// strict-hex accent is exposed verbatim by publicMessage, anything else (a
// row with none, or junk data) is absent from the public shape. The is_plus
// column is the plusActiveExpr badge (api/plus.mjs) — publicMessage maps it
// to a boolean. THE `?` IN TEXTUAL ORDER: because the expr sits at the END
// of the SELECT list, its `now` bind lands BEFORE every WHERE bind — all
// three call sites below prepend nowSeconds() to their existing arrays.
const MESSAGE_SELECT =
  "SELECT m.id, m.author_id, u.username AS author_name, m.body, m.client_message_id, " +
    "m.source, m.created_at, m.edited_at, u.accent_color AS author_accent, " +
    plusActiveExpr("u.id") +
  " FROM gc_messages m JOIN users u ON u.id = m.author_id";

// Both last_message_* values are derived from the messages table itself, so
// an idempotent replay (whose DO NOTHING insert changed nothing but left
// last_insert_rowid() pointing elsewhere) can never move the channel cursor
// backward or stale — the re-derivation is the statement's own guard.
const CHANNEL_LAST_MESSAGE_UPDATE_SQL =
  "UPDATE gc_channels SET " +
    "last_message_id = (SELECT MAX(id) FROM gc_messages WHERE channel_id = ?), " +
    "last_message_at = (SELECT created_at FROM gc_messages WHERE channel_id = ? " +
      "ORDER BY id DESC LIMIT 1) " +
  "WHERE id = ?";

const MESSAGE_INSERT_SQL =
  "INSERT INTO gc_messages (channel_id, author_id, body, client_message_id, created_at) " +
    "VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id, author_id, client_message_id) DO NOTHING";

const MESSAGE_EDIT_SQL =
  "UPDATE gc_messages SET body = ?, edited_at = ? WHERE id = ? AND author_id = ?";

// The three-tier delete guard: author, or server owner/moderator for a server
// channel, or platform staff (the staff tier is a bound JS-side flag derived
// from the session's public role — never request data). Zero changes → 404.
const MESSAGE_DELETE_SQL =
  "DELETE FROM gc_messages WHERE id = ? AND (" +
    "author_id = ? " +
    "OR EXISTS (SELECT 1 FROM gc_channels c " +
      "JOIN gc_server_members sm ON sm.server_id = c.server_id " +
      "WHERE c.id = gc_messages.channel_id AND sm.user_id = ? " +
      "AND sm.role IN ('owner','moderator')) " +
    "OR ? = 1" +
  ")";

// Exported for api/ws.mjs (Task 8): the WebSocket upgrade route must run the
// IDENTICAL read gate, and sharing the one function is the drift guard.
export async function channelForUser(env, channelId, userId) {
  return env.GOOBER_DB.prepare(CHANNEL_ACCESS_SQL)
    .bind(Number(channelId), userId, userId).first();
}

// Read-time gate (Task 6): approved attachments are visible to everyone, a
// still-pending one ONLY to its uploader — one predicate, carried by both the
// single-message and the grouped page lookups.
const ATTACHMENT_GATE_SQL = "(status = 'approved' OR uploader_id = ?)";

// --- phase-3 channel layers: the VIEW/SEND/CONNECT gate + slowmode -------------
//
// The graceful-default contract: every gate here is a READ (never a write
// guard — authorization keeps riding each write's own SQL), and each one
// answers "does anything change for THIS member?" first. A channel with no
// overwrite rows that bind the viewer behaves exactly like the pre-0007
// server: the membership EXISTS check alone decides, nothing else is
// computed. Only when a deny touches the viewer does the filed resolution
// order (api/permissions.mjs) compute the effective mask.

// The member's role rows feed the walk's server-wide layer.
const LAYER_ROLE_ROWS_SQL =
  "SELECT r.id AS id, r.permissions AS permissions FROM gc_member_roles gmr " +
    "JOIN gc_roles r ON r.id = gmr.role_id " +
    "WHERE gmr.server_id = ? AND gmr.user_id = ?";

// The channel's whole layer chain in one read: its own rows plus its
// category's rows (the category subselect resolves the chain — a channel
// without a category resolves to NULL and matches no category row). The
// channel_id column rides the SELECT because the evaluator classifies each
// row BY SHAPE (channel-layer rows: channel_id set, category_id null) —
// servers.mjs's own chain read carries it for the same reason, so the gates
// and the list payload resolve identically.
const LAYER_CHAIN_SQL =
  "SELECT o.channel_id AS channel_id, o.role_id AS role_id, o.category_id AS category_id, " +
    "o.allow_mask AS allow_mask, o.deny_mask AS deny_mask " +
  "FROM gc_channel_overwrites o " +
    "WHERE o.channel_id = ? OR o.category_id = " +
      "(SELECT c2.category_id FROM gc_channels c2 WHERE c2.id = ?)";

// The slowmode bypass question (slowmode FAQ): the string-tier owner or
// moderator, OR any held role carrying KICK_MEMBERS or BYPASS_SLOWMODE.
const LAYER_BYPASS_MASK = SERVER_PERMISSIONS.KICK_MEMBERS | SERVER_PERMISSIONS.BYPASS_SLOWMODE;
// The mask rides the RBAC-audit H1 shape (exact OR via GROUP_CONCAT + the JS
// fold — SUM carried: 2×BYPASS_SLOWMODE(512) read as MENTION_EVERYONE).
const LAYER_BYPASS_SQL =
  "SELECT m.role AS role, " +
    roleMaskColumnSql() + " AS mask " +
  "FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ? LIMIT 1";

// The author's newest row in the channel: the cooldown's read side (the
// (channel_id, id) index carries the walk; the author filter runs on it).
const LAYER_LAST_MESSAGE_SQL =
  "SELECT id, created_at, client_message_id FROM gc_messages " +
    "WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1";

// --- phase-3 mod desk: the member-state gates (timeout + rules + verification) ---
//
// The time-out FAQ's send gate and the verification-levels article's send
// gate both live HERE, inside the shared send primitive — so the REST send
// and the DO's WS relay call one implementation and can never drift. The
// rules gate (0012) rides the same function for the same reason: one
// implementation answers every gate-protected door (channel send, voice join
// at the WS upgrade, and reactions when they ship get the SAME trio at their
// route).

// One read answers all three gates: the membership row's timeout + rules
// acceptance + tier + the joined_at the member gate needs, joined to the
// account age's source.
const MEMBER_GATE_SQL =
  "SELECT m.timed_out_until AS timed_out_until, m.rules_accepted_at AS rules_accepted_at, " +
    "m.role AS role, m.joined_at AS joined_at, " +
    "u.created_at AS account_created_at, " +
    roleMaskColumnSql() + " AS permissions " +
  "FROM gc_server_members m JOIN users u ON u.id = m.user_id " +
  "WHERE m.server_id = ? AND m.user_id = ? LIMIT 1";

// The server's two gate switches in one row read (0008's verification level +
// 0012's rules text): one statement, one indexed id walk.
const SERVER_GATE_SQL =
  "SELECT verification_level, rules_text FROM gc_servers WHERE id = ? LIMIT 1";

// The bypass mask: the filed "owner/mods bypassing" — the owner tier plus any
// KICK_MEMBERS holder (the v1 kick-lite reading) skips all three gates. The
// rules gate rides the SAME bypass as the verification gate beside it: a
// moderator who may act on members was never the person these rules are
// written for, and the manual-verify route is how they answer for one
// instead.
const MEMBER_GATE_BYPASS_MASK = SERVER_PERMISSIONS.KICK_MEMBERS;

// The rules gate's one shared 403 (0012): the stable message plus the
// payload — serverId and the rules text — that carries the client's dialog
// pointer (the worker's apiError maps HttpError payloads verbatim, and the
// DO's send_failed frame copies the same fields). The text itself is the
// owner's rules document, so this class is the only place it ever attaches
// to a 403.
export const RULES_GATE_NAME = "RulesGateError";

export class RulesGateError extends HttpError {
  constructor(serverId, rulesText) {
    // Payload, not message: the error body carries the pointer fields the
    // client keys on; the message stays the one shared stable copy.
    super(
      403,
      RULES_GATE_MESSAGE,
      { "X-Rules-Gate": "server:" + Number(serverId) },
      { error: RULES_GATE_MESSAGE, serverId: Number(serverId), rules: String(rulesText) },
    );
    this.name = RULES_GATE_NAME;
    this.serverId = Number(serverId);
    this.rules = String(rulesText);
  }
}

// enforceMemberGates(env, serverId, userId): the member-state 403s, shared by
// the send and the voice-join doors. Not a member: silent return — the
// caller's own channel-access gate answers first. Order inside: the timeout
// ALWAYS answers first (and a timed-out send never even reaches slowmode, per
// the filed "403, not a 429-class reply" wording), then the owner/KICK
// bypass, then the rules gate (0012: the one ONCE-per-member acceptance,
// answered before the continuous ladder because it is the one a member can
// clear by themselves), then the verification ladder (0 = none, the pre-0008
// behavior). Both server-side switches share the same one-row read, so a
// gate-free server costs one extra one-row read at most — and none at all
// for the bypass tiers.
export async function enforceMemberGates(env, serverId, userId) {
  const context = await env.GOOBER_DB.prepare(MEMBER_GATE_SQL)
    .bind(serverId, userId, serverId, userId).first();
  if (!context) return; // not even a member: the caller's own gate answers

  const now = nowSeconds();
  const timedOutUntil = Number(context.timed_out_until) || 0;
  if (timedOutUntil > now) {
    // The filed wording, verbatim: "You are timed out until <ISO timestamp>".
    throw new HttpError(
      403,
      "You are timed out until " + new Date(timedOutUntil * 1000).toISOString() + ".",
    );
  }

  // Owner + mods bypass (filed); everyone else rides the ladder.
  if (context.role === "owner" ||
      (parseMergedMask(context.permissions) & MEMBER_GATE_BYPASS_MASK) === MEMBER_GATE_BYPASS_MASK) {
    return;
  }

  const server = await env.GOOBER_DB.prepare(SERVER_GATE_SQL)
    .bind(Number(serverId)).first();

  // The rules gate (0012): NULL rules_text is the gate OFF (the same row the
  // verification ladder reads); a set document holds an un-accepted member at
  // the shared 403 whose payload carries the document.
  const rulesText = typeof server?.rules_text === "string" ? server.rules_text : "";
  if (rulesText !== "" && Number(context.rules_accepted_at) <= 0) {
    throw new RulesGateError(Number(serverId), rulesText);
  }

  const level = Number(server?.verification_level) || 0;
  if (level === 0) return;

  const failed = enforceVerificationLevel(
    level, Number(context.account_created_at), Number(context.joined_at), now,
  );
  if (failed !== null) {
    throw new HttpError(403, "You do not meet this server's verification level yet.");
  }
}

// --- phase-3 social layer: the DM send gate (the block side effect) -------------
//
// The filed block bullet: a BLOCKED member's DM is stopped at the send gate
// with the unsendable-DM copy ("Your message could not be delivered…",
// carrying the reason). ONE gate inside the shared send primitive — so the
// REST send and the DO's WS relay can never drift — that runs for the
// dm/group kinds only (server channels are covered by their own permission
// vocabulary, and a block in a shared SERVER channel hides rows client-side,
// it never mutes the send). Either direction of the pair refuses: the
// blocker's and the blocked's sends both stop, exactly like the conversation
// creation route's forum-side checks today.
export const UNSENDABLE_DM_COPY =
  "Your message could not be delivered. Someone in this conversation has " +
  "blocked messages from you.";

const SEND_CHANNEL_SHAPE_SQL =
  "SELECT kind, server_id FROM gc_channels WHERE id = ? LIMIT 1";

// Only the HARD tier gates: gc_blocks' 'ignored' rows are the viewer's own
// cosmetic pref (the filed soft tier keeps their DMs deliverable — "you can
// still tag/reply/DM them"), so the join itself carries kind = 'blocked' and
// no server read of an ignore row can ever stop a send.
const DM_BLOCK_GATE_SQL =
  "SELECT 1 FROM gc_conversation_members om JOIN gc_blocks b ON " +
    "((b.blocker_id = ? AND b.blocked_id = om.user_id) OR " +
    "(b.blocker_id = om.user_id AND b.blocked_id = ?)) " +
    "AND b.kind = 'blocked' " +
  "WHERE om.channel_id = ? LIMIT 1";

export async function enforceDmBlockGate(env, channelId, authorId) {
  const shape = await env.GOOBER_DB.prepare(SEND_CHANNEL_SHAPE_SQL)
    .bind(Number(channelId)).first();
  const kind = String(shape?.kind || "");
  if (kind !== "dm" && kind !== "group") return; // server channels: not this gate
  const blocked = await env.GOOBER_DB.prepare(DM_BLOCK_GATE_SQL)
    .bind(authorId, authorId, Number(channelId)).first();
  if (blocked) throw new HttpError(403, UNSENDABLE_DM_COPY);
}

// The channelId wrapper for the send primitive (and the voice-join door, which
// already holds the channel row): resolves the server once, passes dm/group
// channels through untouched.
export async function enforceMemberGatesForChannel(env, channelId, userId) {
  const channel = await env.GOOBER_DB.prepare(
    "SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(Number(channelId)).first();
  if (!channel || channel.server_id === null || channel.server_id === undefined) return;
  return enforceMemberGates(env, Number(channel.server_id), Number(userId));
}

// readLayerContext(env, channel, userId) -> { membershipRole, roleRows, chainRows }
// for a server channel; null for dm/group channels (which have no layers) or
// where the viewer holds no membership at all. Reads only — it classifies,
// never gates a write.
async function readLayerContext(env, channel, userId) {
  if (!channel || channel.server_id === null || channel.server_id === undefined) return null;
  const serverId = Number(channel.server_id);

  const membership = await env.GOOBER_DB.prepare(
    "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  if (!membership) return null;

  const roles = (await env.GOOBER_DB.prepare(LAYER_ROLE_ROWS_SQL)
    .bind(serverId, userId).all()).results || [];
  const chain = (await env.GOOBER_DB.prepare(LAYER_CHAIN_SQL)
    .bind(Number(channel.id), Number(channel.id)).all()).results || [];

  return { membershipRole: membership.role, roleRows: roles, chainRows: chain };
}

// viewerCanViewChannel(env, channel, userId): enforceChannelBits as a
// boolean — the search route's per-hit VIEW gate (a hit inside a channel the
// viewer cannot view is DROPPED, never a thrown 404 that would kill the
// page). Same contract: the graceful default admits when no deny touches the
// viewer, the owner bypasses, and a touched deny needs the effective mask's
// VIEW bit.
export async function viewerCanViewChannel(env, channel, userId) {
  const context = await readLayerContext(env, channel, userId);
  if (!context) return false; // not even a member of the channel's server
  if (context.membershipRole === "owner") return true;
  if (!overwritesTouchDeny(context.roleRows, context.chainRows)) return true;
  const relevantChain = context.chainRows.filter(
    (row) => row.role_id === null || row.role_id === undefined ||
      context.roleRows.some((role) => Number(role.id) === Number(row.role_id)),
  );
  const mask = effectivePermissions(context.roleRows, relevantChain);
  return (mask & Number(SERVER_PERMISSIONS.VIEW)) !== 0;
}

// enforceChannelBits(env, channel, userId, bitNames): throws only when a
// deny actually touches the viewer AND the effective mask misses a needed
// bit. A missing VIEW answers the history route's own 404 (the channel
// VANISHES for a denied text viewer, per the filed UX detail); every other
// missing bit answers the one shared 403.
export async function enforceChannelBits(env, channel, userId, bitNames) {
  const context = await readLayerContext(env, channel, userId);
  if (!context) return; // dm/group channel, or not even a member: the caller's own gate answers

  const { membershipRole, roleRows, chainRows } = context;
  if (membershipRole === "owner") return; // owner bypasses everything (filed)
  if (!overwritesTouchDeny(roleRows, chainRows)) return; // the graceful default

  const relevantChain = chainRows.filter(
    (row) => row.role_id === null || row.role_id === undefined ||
      roleRows.some((role) => Number(role.id) === Number(row.role_id)),
  );
  const mask = effectivePermissions(roleRows, relevantChain);

  for (const bitName of bitNames) {
    const bit = Number(SERVER_PERMISSIONS[bitName]);
    if ((mask & bit) === 0) {
      if (bitName === "VIEW") {
        throw new HttpError(404, "This channel does not exist or you cannot view it.");
      }
      throw new HttpError(403, "You do not have permission to do that.");
    }
  }
}

// enforceSlowmode(env, channelId, userId, clientMessageId): the send path's
// cooldown — reject a NEW message when the author's previous message in the
// channel is newer than slowmode_seconds. An idempotent replay of the same
// (channel, author, client_message_id) triple is never its own cooldown
// breaker (the retry must still confirm the stored row). Throws the 429 with
// the remaining seconds; no state is written either way.
export async function enforceSlowmode(env, channelId, userId, clientMessageId) {
  const channel = await env.GOOBER_DB.prepare(
    "SELECT server_id, slowmode_seconds FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(Number(channelId)).first();
  const slowmode = Number(channel?.slowmode_seconds) || 0;
  if (slowmode <= 0) return;

  const bypassRow = await env.GOOBER_DB.prepare(LAYER_BYPASS_SQL)
    .bind(Number(channel.server_id), userId, Number(channel.server_id), userId)
    .first();
  if (!bypassRow) return; // not even a member: the caller's access gate answers first
  const moderatorTier = bypassRow.role === "owner" || bypassRow.role === "moderator";
  const roleBypass = (parseMergedMask(bypassRow.mask) & LAYER_BYPASS_MASK) !== 0;
  if (moderatorTier || roleBypass) return;

  const now = nowSeconds();
  const last = await env.GOOBER_DB.prepare(LAYER_LAST_MESSAGE_SQL)
    .bind(Number(channelId), userId).first();
  if (!last) return;
  // A retry of the SAME unconfirmed send is a replay, not a fresh message.
  if (last.client_message_id !== null && last.client_message_id !== undefined &&
      last.client_message_id === clientMessageId) {
    return;
  }
  const elapsed = now - Number(last.created_at);
  if (elapsed < slowmode) {
    const remaining = Math.max(1, slowmode - elapsed);
    throw new HttpError(
      429,
      "Slowmode is on — wait " + remaining + "s before sending again.",
      { "Retry-After": String(remaining) },
    );
  }
}

async function loadAttachmentIds(env, messageId, viewerId) {
  const result = await env.GOOBER_DB.prepare(
    "SELECT id, message_id FROM gc_attachments " +
      "WHERE " + ATTACHMENT_GATE_SQL + " AND message_id = ? ORDER BY id",
  ).bind(viewerId, messageId).all();
  return (result.results || []).map((row) => Number(row.id));
}

function publicMessage(row, attachmentIds, reactionGroups = null) {
  const message = {
    id: Number(row.id),
    authorId: Number(row.author_id),
    authorName: row.author_name,
    body: row.body,
    editedAt:
      row.edited_at === null || row.edited_at === undefined
        ? null
        : new Date(Number(row.edited_at) * 1000).toISOString(),
    source: row.source ?? null,
    attachmentIds,
  };
  // Goober+ accent: exposed ONLY when the strict hex validator passes (the
  // value rides inline CSS in the client, so nothing else may ever slip
  // through). Additive — a message without an accent keeps the exact shape
  // it always had. Both the REST history and the WS/DO fan-out flow through
  // here, so the two paths can never drift.
  const accent = publicAccent(row.author_accent);
  if (accent !== null) message.accent = accent;
  // The Goober+ badge (contract point B): a boolean on EVERY message-shaped
  // payload — author joins, the REST history, the single-read, and the DO
  // fan-out (all three SELECTs above share MESSAGE_SELECT). publicIsPlus
  // maps the 0/1 (null-safe, so a legacy row reads false).
  message.isPlus = publicIsPlus(row);
  // The social layer's reaction groups ride the list payloads ADDITIVELY (a
  // caller that passes none — the DO's WS fan-out, the single-message read —
  // keeps the exact shape it always had): one entry per emoji, carrying the
  // per-emoji user list the chips' count + personal state derive from (the
  // client compares its own user id against the list; the count is a
  // client-side length, never a server-computed duplicate).
  if (Array.isArray(reactionGroups) && reactionGroups.length > 0) {
    message.reactions = reactionGroups;
  }
  return message;
}

// The tier bound (0021, owner-blessed): free keeps 2000, Goober+ admits
// 4000 — Nitro's shape. The strict perk predicate decides, so a grace member
// rides the FREE bound in every lane (send, edit, and the DO fan-in — one
// shared primitive answers all of the same callers). One indexed read.
async function messageBodyMax(env, userId, now) {
  return (await plusPerkActive(env, userId, now))
    ? GC_PLUS_MESSAGE_MAX
    : GC_FREE_MESSAGE_MAX;
}

// The grouped reaction reads' builder (the history page and the pins page
// share it — one loop, never a drifted pair). The fx_burst echo (0057, the
// cosmetics slate's Phase 3) rides ADDITIVELY: a flagged row's user entry
// gains fxBurst, an unflagged row keeps the exact entry shape it always had.
function groupReactionRows(rows, reactionGroupsByMessage) {
  for (const row of rows) {
    const messageId = Number(row.message_id);
    const groups = reactionGroupsByMessage.get(messageId) || [];
    const emoji = String(row.emoji);
    const user = row.fx_burst
      ? { id: Number(row.user_id), username: row.username, fxBurst: true }
      : { id: Number(row.user_id), username: row.username };
    const group = groups.find((entry) => entry.emoji === emoji);
    if (group) group.users.push(user);
    else groups.push({ emoji, users: [user] });
    reactionGroupsByMessage.set(messageId, groups);
  }
}

// The pages' grouped reads' fan-out (the history page and the pins page
// share it — one loop, never a drifted pair). The attachments + reactions
// IN-list reads chunk the id list at PINS_READ_BIND_CHUNK so no statement's
// bind list crosses D1's 100-bind per-query limit on a full page (the
// attachment chunk's bound list alone is 1 + its ids). A chunk is a
// partition of the id list — a message's rows all land in one — so the
// merged maps come out in the single read's exact grouping order.
async function groupedPayloadReads(env, userId, messageIds, attachmentIdsByMessage, reactionGroupsByMessage) {
  for (let start = 0; start < messageIds.length; start += PINS_READ_BIND_CHUNK) {
    const chunk = messageIds.slice(start, start + PINS_READ_BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const attachments = (await env.GOOBER_DB.prepare(
      "SELECT id, message_id FROM gc_attachments " +
        "WHERE " + ATTACHMENT_GATE_SQL + " AND message_id IN (" +
        placeholders + ") ORDER BY id",
    ).bind(userId, ...chunk).all()).results || [];
    for (const row of attachments) {
      const list = attachmentIdsByMessage.get(Number(row.message_id)) || [];
      list.push(Number(row.id));
      attachmentIdsByMessage.set(Number(row.message_id), list);
    }
    const reactions = (await env.GOOBER_DB.prepare(
      "SELECT r.message_id AS message_id, r.emoji AS emoji, r.user_id AS user_id, u.username AS username, r.fx_burst AS fx_burst " +
        "FROM gc_message_reactions r JOIN users u ON u.id = r.user_id " +
        "WHERE r.message_id IN (" + placeholders + ") " +
        "ORDER BY r.created_at, r.user_id",
    ).bind(...chunk).all()).results || [];
    groupReactionRows(reactions, reactionGroupsByMessage);
  }
}

// Validation + filter gate shared by the send and the edit. The forum's
// masking pass decides: a body that would mask is refused (FilterError), a
// body that survives unchanged is stored verbatim.
async function filterMessageBody(env, value, max = GC_MESSAGE_MAX) {
  const text = requiredText(value, "message body", max);
  // The message module may be reached without the worker's per-request
  // priming (the DO path), so the cache is checked here too — after the
  // first populate it is a TTL-guarded no-op.
  await ensureFilterWords(env);
  const filtered = applyWordFilter(text, filterWords(env));
  if (filtered !== text) throw new FilterError();
  return text;
}

// --- 0010: the per-server filter rules (the AutoMod batch) ----------------------
//
// The global list above decides FIRST (a body it refuses never reaches the
// per-server layer); the per-server rules add the filed per-rule surface on
// top: wildcard strategies per term, regex terms, exempt roles/channels, the
// combinable actions (block / alert / timeout AS the owner), and the Care
// class — whose hit NEVER blocks and NEVER writes anything, it only puts the
// careNotice on the send response.

// The rule evaluation only needs the member's own exemption context: their
// role ids (for rule.exempt_role_ids) and their merged permission mask +
// string tier (the structural exemption the checklist pins: owners of the
// filter — owner/moderator tier, any KICK_MEMBERS holder — are exempt from
// every keyword rule). Two cheap indexed reads, skipped entirely for
// DM/group channels and for servers with no rules in the TTL window.
const FILTER_MEMBER_TIER_SQL =
  "SELECT role AS role, " +
    roleMaskColumnSql() + " AS permissions " +
  "FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

const FILTER_MEMBER_ROLE_ROWS_SQL =
  "SELECT role_id FROM gc_member_roles WHERE server_id = ? AND user_id = ?";

// The mention gate (owner direct ask): @everyone and @here ride a plain-text
// parse of the body (no storage change — bodies store text, the flag resolve
// happens here at admission and render-side at the client). The sender's
// membership tier (owner or moderator) or the server-wide merged role mask's
// MENTION_EVERYONE bit admits it; a plain member send is refused BEFORE the
// insert with the 403 the composer error path surfaces. A DM/group channel
// (server_id NULL) never reaches the gate, and a @user mention gates not at
// all (any member may mention anyone; the resolution rules live in
// api/mentions.mjs for the contract both ends parse).
async function enforceMentionGate(env, serverId, userId, text) {
  if (serverId === null) return;
  if (!mentionsEveryoneFlag(text)) return;
  const membership = await env.GOOBER_DB.prepare(FILTER_MEMBER_TIER_SQL)
    .bind(serverId, userId, serverId, userId).first();
  if (!membership) return; // not even a member: the caller's access gate answers first
  const moderatorTier = membership.role === "owner" || membership.role === "moderator";
  if (moderatorTier) return;
  if ((parseMergedMask(membership.permissions) & MENTION_EVERYONE) === MENTION_EVERYONE) return;
  throw new HttpError(403, "You can't mention everyone here.");
}

// errorName(error): the failure's compact label for the best-effort write
// logs below — D1 errors carry a name/message pair worth one line of context,
// never a swallowed void.
function errorName(error) {
  return error && error.name ? error.name : "UnknownError";
}

// enforceFilterRules(env, channelId, userId, text, authorId):
//   -> { careNotice: string|null, pendingAlert: object|null } for the caller
//      to finish after the insert (an alert-only hit links the stored row),
//   or THROWS the block (the alert + owner-timeout writes land BEFORE the
//   throw — a blocked message is never stored anywhere, so its preview rides
//   the alert row).
// The timeout write acts AS the server's owner (filterrules' owner-immunity
// rider, no actor hierarchy), sharing the manual timeout's column and
// duration menu.
async function enforceFilterRules(env, channelId, userId, text, authorId) {
  const serverRow = await env.GOOBER_DB.prepare(
    "SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(Number(channelId)).first();
  if (!serverRow || serverRow.server_id === null || serverRow.server_id === undefined) {
    return { careNotice: null, pendingAlert: null }; // DM/group: no server rules
  }
  const serverId = Number(serverRow.server_id);
  const rules = await loadServerRules(env, serverId);
  if (rules.length === 0) return { careNotice: null, pendingAlert: null };

  const membership = await env.GOOBER_DB.prepare(FILTER_MEMBER_TIER_SQL)
    .bind(serverId, userId, serverId, userId).first();
  const memberRoleIds = ((await env.GOOBER_DB.prepare(FILTER_MEMBER_ROLE_ROWS_SQL)
    .bind(serverId, userId).all()).results || []).map((row) => Number(row.role_id));
  const kickBit = SERVER_PERMISSIONS.KICK_MEMBERS;
  const isMemberModeratorTier = Boolean(membership) && (
    membership.role === "owner" ||
    membership.role === "moderator" ||
    (parseMergedMask(membership.permissions) & kickBit) === kickBit
  );

  const outcome = evaluateServerRules(rules, text, {
    channelId: Number(channelId),
    memberRoleIds,
    isMemberModeratorTier,
  });
  if (outcome.kind === "care") {
    // The owner decision, verbatim: the message proceeds untouched, the
    // response carries the inline notice, and NOTHING is written or sent to
    // anyone else — no alert row, no notification, no log.
    return { careNotice: outcome.careNotice, pendingAlert: null };
  }
  if (outcome.kind === "none") return { careNotice: null, pendingAlert: null };

  const { rule, matched } = outcome;
  const actions = rule.actions.length > 0 ? rule.actions : ["block"];
  const now = nowSeconds();
  const timeoutStatement = actions.includes("timeout")
    ? env.GOOBER_DB.prepare(timeoutAsOwnerSql())
        .bind(now + (Number(rule.timeoutMinutes) || 10) * 60, serverId, Number(authorId))
    : null;

  if (outcome.kind === "blocked") {
    // The message is refused and stored NOWHERE — its preview (<= 280) rides
    // the alert row instead, and the feed is trimmed in the same batch.
    const statements = [
      env.GOOBER_DB.prepare(filterAlertInsertSql()).bind(
        serverId, Number(channelId), null, Number(authorId),
        Number(rule.id), rule.name, alertPreview(matched), alertPreview(text), now,
      ),
      env.GOOBER_DB.prepare(filterAlertPruneSql()).bind(serverId, serverId),
    ];
    if (timeoutStatement) statements.push(timeoutStatement);
    await env.GOOBER_DB.batch(statements);
    // The member's copy: the rule's own block message (<= 150) when the desk
    // wrote one, otherwise the filter's standing 400 copy.
    throw new HttpError(400, rule.blockMessage ? rule.blockMessage : FILTERED_MESSAGE_ERROR);
  }

  // Alert (± timeout) with NO block: the message stores, so the caller links
  // the alert to the stored row after the INSERT; the owner-timeout write
  // applies NOW (the flagged send itself may still land, but the flagged
  // member's NEXT send is the timeout gate's business).
  if (timeoutStatement) {
    try {
      await timeoutStatement.run();
    } catch (error) {
      // The timeout still never blocks the already-passing send, but a
      // swallowed gate write is a real condition — surface it for the desk.
      console.error("Timeout write failed:", errorName(error), {
        channelId: Number(channelId),
        serverId,
      });
    }
  }
  return {
    careNotice: null,
    pendingAlert: {
      serverId,
      ruleId: Number(rule.id),
      ruleName: rule.name,
      matched: alertPreview(matched),
    },
  };
}

// The attach-by-id shapes (the large-file lane): the batch's UPDATE resolves
// the message id by the SAME idempotency triple the multipart attachment
// inserts ride, and the pre-check owns the tier read. `client_message_id IS
// ?` and `ORDER BY id DESC` mirror the reselect, so a replayed send links to
// the SAME message.
const MESSAGE_ID_TRIPLE_SQL =
  "(SELECT id FROM gc_messages WHERE channel_id = ? AND author_id = ? " +
    "AND client_message_id IS ? ORDER BY id DESC LIMIT 1)";

const ATTACHMENT_REFERENCE_OWN_SQL =
  "SELECT size_bytes FROM gc_attachments WHERE id = ? AND message_id IS NULL AND uploader_id = ? " +
    "AND size_bytes <= ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = gc_attachments.id) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = gc_attachments.id) LIMIT 1";

const ATTACHMENT_REFERENCE_UPDATE_SQL =
  "UPDATE gc_attachments SET message_id = " + MESSAGE_ID_TRIPLE_SQL + " " +
    "WHERE id = ? AND message_id IS NULL AND uploader_id = ? AND size_bytes <= ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = gc_attachments.id) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = gc_attachments.id)";

// The shared send primitive (REST POST, JSON or multipart + Task 8's DO):
// validation, the word filter, the idempotent insert, the channel last_* bump,
// and the follow-up triple SELECT are ONE atomic batch; the resolved row is
// what both callers return. With `attachment` prepared (Task 6's multipart
// send), the attachment's metadata INSERT — and, without GC_MEDIA (local
// dev), its legacy chunk INSERTs — ride BETWEEN the last_* bump and the
// reselect in that same batch (with the binding the R2 bucket is the byte
// store of record and the AWAITED put rides after the commit, fail-closed —
// media.mjs owns the SQL and the sweep, so the idempotency/bump logic is
// never duplicated by the multipart branch). Returns { message, created } —
// `created` distinguishes a fresh insert from an idempotent replay of the
// same (channel, author, client_message_id) triple.
export async function sendMessageToChannel(
  env,
  user,
  channelId,
  body,
  clientMessageId = null,
  preparedAttachment = null,
  referencedAttachmentId = null,
) {
  const text = await filterMessageBody(
    env,
    body,
    await messageBodyMax(env, Number(user.id), nowSeconds()),
  );

  // The mod desk's member-state gates (0008, shared by the REST and DO
  // callers): an expired-or-absent timeout and a zero verification level both
  // cost one cheap indexed read at most on today's default server. A
  // timed-out member is answered HERE — the filed 403 wording, never the
  // slowmode 429 — so the cooldown is untouched by their sends.
  await enforceMemberGatesForChannel(env, channelId, Number(user.id));

  // The social layer's DM gate (phase-3, shared by the REST and DO callers):
  // a blocked pair inside this conversation answers the unsendable-DM copy
  // before the insert, so a refused send leaves no row behind.
  await enforceDmBlockGate(env, channelId, Number(user.id));

  // The expression gate (0020): the message body's <e:name:id>/<s:name:id>
  // tokens decide BEFORE anything is stored. One indexed read answers the
  // channel's server — a DM/group channel (server_id NULL, or a row the
  // gate's caller never resolved) makes every resolved token external;
  // inside a server channel only the other servers' emoji are the plus perk.
  const expressionChannel = await env.GOOBER_DB.prepare(
    "SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(Number(channelId)).first();
  if (expressionChannel) {
    await enforceExpressionTokenAccess(
      env,
      Number(user.id),
      expressionChannel.server_id === null || expressionChannel.server_id === undefined
        ? null
        : Number(expressionChannel.server_id),
      text,
    );
    // The mention gate rides the SAME channel read (one server_id, two gates):
    // an @everyone/@here send needs the sender's MENTION_EVERYONE tier or bit,
    // and a DM/group channel (server_id NULL) gates not.
    await enforceMentionGate(
      env,
      expressionChannel.server_id === null || expressionChannel.server_id === undefined
        ? null
        : Number(expressionChannel.server_id),
      Number(user.id),
      text,
    );
  }

  // Slowmode (phase-3, shared by the REST and DO callers): the channel
  // cooldown read + the bypass question + the newest-message check. A channel
  // with slowmode 0 (the default column) never reaches any of it.
  await enforceSlowmode(env, channelId, Number(user.id), clientMessageId);

  // The client id is the schema's idempotency key (UNIQUE(channel_id,
  // author_id, client_message_id)); NULL keys stay NULL so posts without one
  // never collide (SQLite treats NULLs as distinct in unique indexes).
  // Validated BEFORE the filter gate: a malformed send is a request-shape
  // 400, never a filter hit.
  if (
    clientMessageId !== null &&
    (typeof clientMessageId !== "string" ||
      clientMessageId.length < 8 ||
      clientMessageId.length > 64)
  ) {
    throw new HttpError(400, "Client message id must be between 8 and 64 characters.");
  }

  // 0010: the per-server rules gate — AFTER the member-state gates (a
  // timed-out send never reaches the filter machinery, matching the manual
  // timeout's "the gate answers first" order), shared by the REST and DO
  // callers. Blocked throws here (the alert + owner-timeout lands first);
  // a care hit returns the notice for the response; an alert-only hit hands
  // the pending alert back for the post-insert link.
  const { careNotice, pendingAlert } = await enforceFilterRules(
    env, channelId, Number(user.id), text, Number(user.id),
  );

  const authorId = Number(user.id);
  const now = nowSeconds();

  // The attach-by-id pre-check (the large-file lane, dormant in production
  // until the binding rules): the caller's own standalone row, not yet
  // attached, not an expression's asset, and within the caller's tier cap.
  // The batch re-guards everything (the pre-check costs no atomicity).
  let attachRefMaxBytes = 0;
  if (referencedAttachmentId !== null) {
    const caps = await attachmentCapBytes(env, authorId, now);
    if (caps.fileBytes <= MAX_ATTACHMENT_BYTES) {
      throw new HttpError(403, "Large-file uploads are a full Goober+ perk.");
    }
    const owned = await env.GOOBER_DB.prepare(ATTACHMENT_REFERENCE_OWN_SQL)
      .bind(referencedAttachmentId, authorId, caps.fileBytes).first();
    if (!owned) throw new HttpError(400, "That upload reference is invalid.");
    attachRefMaxBytes = caps.fileBytes;
  }

  const statements = [
    env.GOOBER_DB.prepare(MESSAGE_INSERT_SQL)
      .bind(channelId, authorId, text, clientMessageId, now),
    env.GOOBER_DB.prepare(CHANNEL_LAST_MESSAGE_UPDATE_SQL)
      .bind(channelId, channelId, channelId),
  ];
  // The attachment's batch slot is recorded BEFORE the pushes below — the
  // put gate reads that statement's result (changes==1 means THIS batch
  // wrote the row; a replay whose attachment already exists changed 0 and
  // neither re-puts nor re-sweeps).
  let attachmentInsertAt = -1;
  if (preparedAttachment) {
    attachmentInsertAt = statements.length;
    statements.push(
      ...messageAttachmentStatements(env, authorId, channelId, clientMessageId, preparedAttachment, now),
    );
  }
  if (referencedAttachmentId !== null) {
    // The large-file lane's attach-by-id: the pre-uploaded STANDALONE row
    // links to THIS message inside the same atomic batch. The batch's guard
    // (message_id IS NULL, the author's own row, within the caller's tier
    // cap, and no expression asset — an emoji's or sticker's media can never
    // be stolen onto a message) rides the UPDATE, so a race between two
    // referencings of the same upload loses cleanly and leaves the message
    // attached to neither — the reselect's attachmentIds simply omit it.
    statements.push(
      env.GOOBER_DB.prepare(ATTACHMENT_REFERENCE_UPDATE_SQL)
        .bind(channelId, authorId, clientMessageId, referencedAttachmentId, authorId, attachRefMaxBytes),
    );
  }
  // The persisted mentions (W-B2): the body's @username tokens resolve
  // against the channel's roster and each resolved member rides ONE in-batch
  // INSERT...SELECT (the identity tuple re-derives the row this batch itself
  // just inserted). A body without "@" costs nothing — not even the roster
  // read. The statement order keeps the message INSERT first (the tuple and
  // the FKs resolve in-batch).
  statements.push(
    ...await mentionPersistStatements(
      env,
      expressionChannel?.server_id ?? null,
      channelId,
      authorId,
      now,
      clientMessageId,
      text,
    ),
  );
  const reselect = env.GOOBER_DB.prepare(
    MESSAGE_SELECT +
      " WHERE m.channel_id = ? AND m.author_id = ? AND " +
      (clientMessageId === null ? "m.client_message_id IS NULL" : "m.client_message_id = ?") +
      // ORDER BY id DESC: with a NULL client id the (channel, author) pair can
      // match older rows from earlier cid-less sends — the reselect must echo
      // the row THIS batch just inserted, never the oldest one below it.
      " ORDER BY m.id DESC LIMIT 1",
  ).bind(...(clientMessageId === null
    ? [now, channelId, authorId]
    : [now, channelId, authorId, clientMessageId]));
  // The reselect is ALWAYS the batch's last statement, so the resolved row is
  // the last result either way.
  statements.push(reselect);

  const results = await env.GOOBER_DB.batch(statements);

  const created = Number(results[0]?.meta?.changes) === 1;
  const row = results[results.length - 1]?.results?.[0];
  if (!row) {
    throw new HttpError(500, "The message could not be saved. Please try again.");
  }

  // The attachment's store-of-record put (the send batch's twin of the
  // standalone intake): the message row is already committed — the batch is
  // one D1 execute — so the compensating path is the ATTACHMENT's. The put
  // is AWAITED before the send resolves (never a delivered send with an
  // R2-failed attachment), and a failed put sweeps the byte-less pending row
  // and fails the send 503. The idempotent retry re-rides the whole batch:
  // the message insert changes nothing, the attachment reinserts through the
  // batch's NOT EXISTS guard (the sweep emptied the slot) and re-puts. A
  // last_row_id the batch never named is treated exactly like a failed put.
  if (preparedAttachment && env.GC_MEDIA &&
      Number(results[attachmentInsertAt]?.meta?.changes) === 1) {
    const attachmentId = Number(results[attachmentInsertAt]?.meta?.last_row_id);
    let stored = false;
    if (Number.isInteger(attachmentId) && attachmentId > 0) {
      try {
        await putAttachmentObject(env, attachmentId, preparedAttachment.bytes);
        stored = true;
      } catch {
        stored = false;
      }
    }
    if (!stored) {
      // Best-effort sweep — the standalone twin of this rollback already
      // carries the same rule (media.mjs): a D1 failure inside the DELETE
      // must never mask the 503; the worst case leaves the byte-less
      // pending row for a retry to sweep (the NOT EXISTS gate reanswers).
      try {
        await messageAttachmentSweepStatement(env, Number(row.id)).run();
      } catch {
        // the 503 below is the contract; the sweep rides best-effort
      }
      throw new HttpError(503, SEND_ATTACHMENT_STORE_FAILED_ERROR);
    }
  }

  const attachmentIds = await loadAttachmentIds(env, Number(row.id), authorId);

  // Goober Coins (owner call: earned only by activity): a FRESH send earns its
  // per-message grant. The mint's caps ride INSIDE its INSERT (the ceiling and
  // the source cap are WHERE arms of api/coins.mjs's statement), so a
  // chatty member runs out of coins before the caps ever notice them; an
  // idempotent replay (created=false) never reaches this line. A grant failure
  // must never fail the send — the message already exists.
  if (created) {
    try {
      await grantMessageCoins(env, authorId, now);
    } catch (grantError) {
      console.warn("Coin grant skipped:", grantError && grantError.name ? grantError.name : "UnknownError");
    }
  }

  // The alert-only hit's bookkeeping, now that the message id exists — in a
  // batch with the feed trim, best-effort on the send's behalf (a filter
  // alert write can never 500 a delivered message, by the same principle as
  // the care class).
  if (pendingAlert) {
    try {
      await env.GOOBER_DB.batch([
        env.GOOBER_DB.prepare(filterAlertInsertSql()).bind(
          pendingAlert.serverId,
          Number(channelId),
          Number(row.id),
          authorId,
          pendingAlert.ruleId,
          pendingAlert.ruleName,
          pendingAlert.matched,
          null,
          Number(row.created_at) || nowSeconds(),
        ),
        env.GOOBER_DB.prepare(filterAlertPruneSql()).bind(pendingAlert.serverId, pendingAlert.serverId),
      ]);
    } catch (error) {
      // The alert is still swallowed on the message's behalf (the never-500
      // rule stands), but the desk can SEE the lost moderation signal now.
      console.error("Filter alert write failed:", errorName(error), {
        channelId: Number(channelId),
        messageId: Number(row.id),
      });
    }
  }

  // careNotice rides the response ONLY when the care class hit (additive —
  // the REST handlers inline it, the DO sends the care frame to the author).
  return { message: publicMessage(row, attachmentIds), created, careNotice: careNotice ?? null };
}

async function handleListMessagesRoute(request, env, url, channelId) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);

  const afterRaw = url.searchParams.get("after");
  let after = null;
  if (afterRaw !== null && afterRaw !== "") {
    // Bare-id cursor: [1-9][0-9]{0,14} — no leading zeros, bounded width,
    // validated inline per the forum convention.
    if (!/^[1-9][0-9]{0,14}$/.test(afterRaw)) {
      throw new HttpError(400, "That message cursor is invalid.");
    }
    after = Number(afterRaw);
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^[0-9]{1,4}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_PAGE_LIMIT) {
      throw new HttpError(400, "That message limit is invalid.");
    }
    limit = Number(limitRaw);
  }

  const channel = await channelForUser(env, channelId, userId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");

  // Phase-3 layers: VIEW is enforced only when a deny actually touches this
  // viewer (the graceful default — everyone else reads exactly as before).
  // History needs VIEW alone: a send-denied (announcement-style) channel is
  // still perfectly readable, per the filed read-only-pattern separation.
  await enforceChannelBits(env, channel, userId, ["VIEW"]);

  // Backward keyset walk: the newest rows without a cursor, the strictly
  // older ones with one — always id DESC, nextAfter the page's oldest id.
  const page = (await env.GOOBER_DB.prepare(
    MESSAGE_SELECT +
      " WHERE m.channel_id = ?" +
      (after === null ? "" : " AND m.id < ?") +
      " ORDER BY m.id DESC LIMIT " + limit,
  // MESSAGE_SELECT carries the is-plus expression's own `?` (the now bound
  // first, from plusActiveExpr) — the page's channel/id parameters ride
  // AFTER it in bind order, cursor or none (live-confirmed: binding only the
  // now on the first page answered D1_ERROR wrong-bindings for every
  // initial history load).
  ).bind(...(after === null ? [nowSeconds(), channelId] : [nowSeconds(), channelId, after])).all()).results || [];

  // Attachments ride the shared grouped read fan-out with the visibility
  // gate: approved rows for everyone, pending rows only for THIS viewer.
  const messageIds = page.map((row) => Number(row.id));
  const attachmentIdsByMessage = new Map();
  const reactionGroupsByMessage = new Map();
  if (messageIds.length) {
    await groupedPayloadReads(env, userId, messageIds, attachmentIdsByMessage, reactionGroupsByMessage);
  }

  // Discord marks-on-read: the tail read IS the ack. The caller's own member
  // row (gc_conversation_members.last_read_message_id — the 0026 wave's sole
  // marker, the schema gc_read_state's dropped lane was never wired to) is
  // the store; the advance is forward-only; and a server channel (no member
  // row) answers the page untouched — zero changes, never an extra round
  // trip. A cursor read (a history walk) never acks, only the tail does.
  if (after === null && page.length) {
    // The thread-held arm rides the /read route's exact discipline: a marker
    // never advances onto an id the thread no longer holds (a concurrent hard
    // delete between the page read and this write would strand one).
    await env.GOOBER_DB.prepare(
      "UPDATE gc_conversation_members SET last_read_message_id = ? " +
        "WHERE channel_id = ? AND user_id = ? AND last_read_message_id < ? " +
        "AND ? <= (SELECT COALESCE(MAX(id), 0) FROM gc_messages WHERE channel_id = ?)",
    ).bind(
      Number(page[0].id), channelId, userId, Number(page[0].id),
      Number(page[0].id), channelId,
    ).run();
  }

  return json({
    messages: page.map((row) =>
      publicMessage(row, attachmentIdsByMessage.get(Number(row.id)) || [],
        reactionGroupsByMessage.get(Number(row.id)) || null),
    ),
    nextAfter: page.length ? Number(page[page.length - 1].id) : null,
    // The expression side table (0020, ADDITIVE — server channels only, a DM
    // or group channel keeps the exact shape it always had): the channel's
    // server's full inventory (capped rows, `emojis` + `stickers`), so the
    // client resolves every <e:name:id>/<s:name:id> token on the page
    // locally without a second fetch.
    ...(channel.server_id !== null && channel.server_id !== undefined
      ? { expressions: await loadServerExpressions(env, Number(channel.server_id)) }
      : {}),
  });
}

async function handleSendMessageRoute(request, env, channelId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "message", "user:" + session.user.id);

  // The multipart branch is the ONLY send variant that differs; the JSON
  // variant below keeps the exact body/response contract it has always had.
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) {
    return handleSendMessageWithImageRoute(request, env, channelId, session);
  }

  const body = await readJson(request);

  const userId = Number(session.user.id);
  const channel = await channelForUser(env, channelId, userId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");

  // Phase-3 layers: VIEW miss 404s (a denied channel vanishes), SEND miss is
  // the one shared 403.
  await enforceChannelBits(env, channel, userId, ["VIEW", "SEND"]);

  const { message, created, careNotice } = await sendMessageToChannel(
    env,
    session.user,
    channelId,
    body.body,
    body.clientMessageId === undefined ? null : body.clientMessageId,
    null,
    referenceFromBody(body.attachmentId),
  );
  // The Care class's inline field (0010): present ONLY on a care hit, on top
  // of the standing { message } shape.
  return json(careNotice ? { message, careNotice } : { message }, created ? 201 : 200);
}

// The attach-by-id body field (the large-file lane): absent/null/empty =
// none (the multipart envelope hands "" for an empty field); a positive
// integer (as a number or the multipart's digit string) = the reference the
// send pipeline pre-checks; anything else is the request-shape 400.
function referenceFromBody(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && /^[1-9][0-9]{0,14}$/.test(raw)) return Number(raw);
  if (
    typeof raw === "number" && Number.isInteger(raw) &&
    raw > 0 && raw <= 9999999999999999
  ) return raw;
  throw new HttpError(400, "That upload reference is invalid.");
}

// Task 6's send-with-image variant: the same message pipeline, with up to one
// image intake attached INSIDE the send's batch. The image reads the 'image'
// file field and rides the same prepareAttachmentBytes intake (size cap, sniff,
// sanitize) as the standalone upload — a body field is still required.
async function handleSendMessageWithImageRoute(request, env, channelId, session) {
  // The plus upload tier rides the member's own row (the free pair for a
  // non-buyer or a grace member — attachmentCapBytes in api/plus.mjs). The
  // reader takes the SINGLE-SHOT pair mapped by singleShotAttachmentCaps
  // (wave-19: Mini rides the blessed 50 MiB here; a full-plus term's request
  // options never ride the raw tier pair — the 1 GiB row is the LANE's
  // ceiling, not this route's whole-buffered window).
  const caps = await attachmentCapBytes(env, Number(session.user.id), nowSeconds());
  const singleShot = singleShotAttachmentCaps(caps);
  const { fields, files } = await readMultipartWithImage(request, {
    maxFileBytes: singleShot.fileBytes,
    maxRequestBytes: singleShot.requestBytes,
  });
  if (files.length > 1) throw new HttpError(400, "Attach at most one image.");

  const userId = Number(session.user.id);
  const channel = await channelForUser(env, channelId, userId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");

  // Same pair of layer gates as the JSON send (VIEW vanishes, SEND 403s).
  await enforceChannelBits(env, channel, userId, ["VIEW", "SEND"]);

  const preparedAttachment =
    files.length === 1 ? prepareAttachmentBytes(files[0], singleShot.fileBytes) : null;
  const bodyValue = typeof fields.body === "string" ? fields.body : undefined;
  const clientMessageId =
    fields.clientMessageId === undefined || fields.clientMessageId === ""
      ? null
      : fields.clientMessageId;
  // A multipart send carries at most ONE image lane: the buffered file and a
  // large-file reference are never both on one message.
  const referencedAttachmentId = referenceFromBody(
    fields.attachmentId === "" || fields.attachmentId === undefined ? null : fields.attachmentId,
  );
  if (preparedAttachment !== null && referencedAttachmentId !== null) {
    throw new HttpError(400, "Attach at most one image.");
  }

  const { message, created, careNotice } = await sendMessageToChannel(
    env,
    session.user,
    channelId,
    bodyValue,
    clientMessageId,
    preparedAttachment,
    referencedAttachmentId,
  );
  return json(careNotice ? { message, careNotice } : { message }, created ? 201 : 200);
}

async function handleEditMessageRoute(request, env, messageId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  // The EDIT lane tiers identically: a lapsed member can never save an edit
  // whose body exceeds their current bound — the send bound is the floor of
  // every stored body's re-review, grace OFF like every other perk gate.
  const text = await filterMessageBody(
    env,
    body.body,
    await messageBodyMax(env, userId, nowSeconds()),
  );
  let editPendingAlert = null;

  // The expression gate on the EDIT lane too — an edit can never introduce a
  // token the send gate would have refused (the same channel-server read,
  // the same decision, run before the UPDATE stores anything).
  const editedChannel = await env.GOOBER_DB.prepare(
    "SELECT c.id AS channel_id, c.server_id AS server_id, c.kind AS kind " +
      "FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id " +
      "WHERE m.id = ? LIMIT 1",
  ).bind(Number(messageId)).first();
  if (editedChannel) {
    const channelIdNum = Number(editedChannel.channel_id);
    // The M2 (RBAC audit) edit-lane gates, in the send door's order: a server
    // channel's editor rides the same membership, VIEW/SEND and member-state
    // gates a send would — a lapsed member and a timed-out member store
    // nothing here. (The edit carries no slowmode and no DM-block gate; the
    // DM block-on-edit question is filed, not built.)
    if (editedChannel.server_id !== null && editedChannel.server_id !== undefined) {
      const serverIdNum = Number(editedChannel.server_id);
      const member = await env.GOOBER_DB.prepare(
        "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
      ).bind(serverIdNum, userId).first();
      if (!member) throw new HttpError(403, "You do not have permission to do that.");
      await enforceChannelBits(
        env,
        { id: channelIdNum, server_id: serverIdNum },
        userId,
        ["VIEW", "SEND"],
      );
      await enforceMemberGatesForChannel(env, channelIdNum, userId);
    }
    await enforceExpressionTokenAccess(
      env,
      userId,
      editedChannel.server_id === null || editedChannel.server_id === undefined
        ? null
        : Number(editedChannel.server_id),
      text,
    );
    // The mention gate on the EDIT lane too — an edit can never introduce an
    // @everyone/@here the send gate would have refused (the same channel
    // read, the same decision, run before the UPDATE stores anything).
    await enforceMentionGate(
      env,
      editedChannel.server_id === null || editedChannel.server_id === undefined
        ? null
        : Number(editedChannel.server_id),
      userId,
      text,
    );
    // The AutoMod gate on the EDIT lane too (M2): the send path's
    // evaluate-before-store pass. A blocked edit answers the rule's own copy
    // and lands the alert + owner-timeout writes NOWHERE-near the message
    // (the stored row stays untouched); an alert-only hit links after the
    // UPDATE below, best-effort; a care hit proceeds untouched (the edit
    // response carries no care notice — the send-only additive shape).
    editPendingAlert = (
      await enforceFilterRules(env, channelIdNum, userId, text, userId)
    ).pendingAlert;
  }

  const result = await env.GOOBER_DB.prepare(MESSAGE_EDIT_SQL)
    .bind(text, nowSeconds(), messageId, userId).run();
  if (Number(result.meta?.changes) !== 1) throw new HttpError(404, "Message not found.");

  if (editPendingAlert) {
    try {
      await env.GOOBER_DB.batch([
        env.GOOBER_DB.prepare(filterAlertInsertSql()).bind(
          editPendingAlert.serverId,
          Number(editedChannel.channel_id),
          Number(messageId),
          userId,
          editPendingAlert.ruleId,
          editPendingAlert.ruleName,
          editPendingAlert.matched,
          null,
          nowSeconds(),
        ),
        env.GOOBER_DB.prepare(filterAlertPruneSql()).bind(editPendingAlert.serverId, editPendingAlert.serverId),
      ]);
    } catch (error) {
      // The edit's alert write can still never 500 the stored edit, but the
      // lost moderation signal surfaces for the desk.
      console.error("Filter alert write failed:", errorName(error), {
        channelId: Number(editedChannel.channel_id),
        messageId: Number(messageId),
      });
    }
  }

  const row = await env.GOOBER_DB.prepare(MESSAGE_SELECT + " WHERE m.id = ? LIMIT 1")
    .bind(nowSeconds(), messageId).first();
  if (!row) throw new HttpError(404, "Message not found.");
  return json({ message: publicMessage(row, await loadAttachmentIds(env, Number(row.id), Number(session.user.id))) });
}

// The attachment cleanup's three-tier guard mirrors MESSAGE_DELETE_SQL's own
// tiers (author OR channel moderator OR platform-staff flag), so a doomed
// delete can never strip a message's attachments: an unauthorized viewer's
// batch matches zero rows in all three statements, and the authorized one
// removes chunks → attachments → message (the gc_attachments FK on
// gc_messages carries no ON DELETE action, which is why the message row dies
// LAST in this batch). The two guard bodies are structurally identical — the
// gc_attachments side is spelled with `a.` inside the chunk-delete's aliased
// subselect and by table name in the flat DELETE.
const ATTACHMENT_MODERATOR_TIER_SQL =
  "OR EXISTS (SELECT 1 FROM gc_channels c JOIN gc_server_members sm " +
    "ON sm.server_id = c.server_id " +
    "WHERE c.id = (SELECT m2.channel_id FROM gc_messages m2 WHERE m2.id = ?) " +
    "AND sm.user_id = ? AND sm.role IN ('owner','moderator')) ";

const MESSAGE_ATTACHMENT_CHUNKS_DELETE_SQL =
  "DELETE FROM gc_attachment_chunks WHERE attachment_id IN (" +
    "SELECT a.id FROM gc_attachments a WHERE a.message_id = ? AND (" +
      "EXISTS (SELECT 1 FROM gc_messages m WHERE m.id = a.message_id AND m.author_id = ?) " +
      ATTACHMENT_MODERATOR_TIER_SQL +
      "OR ? = 1))";

const MESSAGE_ATTACHMENTS_DELETE_SQL =
  "DELETE FROM gc_attachments WHERE message_id = ? AND (" +
    "EXISTS (SELECT 1 FROM gc_messages m WHERE m.id = gc_attachments.message_id AND m.author_id = ?) " +
    ATTACHMENT_MODERATOR_TIER_SQL +
    "OR ? = 1)";

// The doomed attachments' ids, pre-read with the SAME three tiers the batch's
// deletes carry — the object store's purge list rides the servers.mjs
// discipline (no id is ever derived INSIDE a batch). The bucket follows the
// batch's verdict, never leads: a 404 verdict schedules nothing.
const MESSAGE_ATTACHMENT_IDS_SELECT_SQL =
  "SELECT id FROM gc_attachments WHERE message_id = ? AND (" +
    "EXISTS (SELECT 1 FROM gc_messages m WHERE m.id = gc_attachments.message_id AND m.author_id = ?) " +
    ATTACHMENT_MODERATOR_TIER_SQL +
    "OR ? = 1)";

// The bookmarks sweep (0 orphan law): gc_bookmarks carries NO message FK
// (migration 0053's shape is owner/message/saved_at, bare), so the doomed
// pointers die in the batch behind the SAME tier guard. Every other
// message-scoped table (gc_message_reactions, gc_mentions) already rides the
// gc_messages FK CASCADE — see tests/r2-sweep-fk-pins.test.mjs.
const MESSAGE_BOOKMARKS_DELETE_SQL =
  "DELETE FROM gc_bookmarks WHERE message_id = ? AND (" +
    "EXISTS (SELECT 1 FROM gc_messages m WHERE m.id = gc_bookmarks.message_id AND m.author_id = ?) " +
    ATTACHMENT_MODERATOR_TIER_SQL +
    "OR ? = 1)";

async function handleDeleteMessageRoute(request, env, messageId, ctx) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  // Platform staff ('owner'/'admin' at the public tier) carry the flag into
  // the guard; server moderation stays a pure SQL membership EXISTS.
  const staff = session.user.role === "owner" || session.user.role === "admin" ? 1 : 0;
  // The object purge list's pre-read (same guard, same binds as the
  // attachments DELETE below).
  const doomedRows = (await env.GOOBER_DB.prepare(MESSAGE_ATTACHMENT_IDS_SELECT_SQL)
    .bind(messageId, userId, messageId, userId, staff).all()).results || [];
  const doomedIds = doomedRows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  // ONE batch: attachment cleanup + the bookmarks sweep + the guarded message
  // DELETE, all-or-nothing. Each of the first three statements carries the
  // SAME tier guard as the message DELETE itself, so the 404 path (changes 0)
  // also deleted nothing — the chunk rows die with the attachment rows, in
  // the same SQL.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(MESSAGE_ATTACHMENT_CHUNKS_DELETE_SQL)
      .bind(messageId, userId, messageId, userId, staff),
    env.GOOBER_DB.prepare(MESSAGE_ATTACHMENTS_DELETE_SQL)
      .bind(messageId, userId, messageId, userId, staff),
    env.GOOBER_DB.prepare(MESSAGE_BOOKMARKS_DELETE_SQL)
      .bind(messageId, userId, messageId, userId, staff),
    env.GOOBER_DB.prepare(MESSAGE_DELETE_SQL)
      .bind(messageId, userId, userId, staff),
  ]);
  if (Number(results[3]?.meta?.changes) !== 1) throw new HttpError(404, "Message not found.");

  // The bucket follows the D1 verdict: exactly the pre-read doomed ids'
  // objects die with the batch, best-effort (the ride never blocks or fails
  // the row deletion — scheduleAttachmentObjectDelete catches its own
  // errors), one R2 delete per doomed id, through the caller's waitUntil.
  for (const attachmentId of doomedIds) {
    scheduleAttachmentObjectDelete(env, ctx, attachmentId);
  }

  return json({ ok: true });
}

// --- pins (0026) ------------------------------------------------------------------
//
// The manage-pin grant, CITED: Discord's Aug-2025 permission patch split
// Manage Messages into narrower grants (the modern Manage Messages/Pins
// family); GC carries no separate pin bit, so the pin right binds the
// message-moderation grant DELETE_MESSAGES (permissions.mjs) — the two
// moderation powers move together, exactly as the patched family does. The
// read mirrors the expression manage family's shape (api/emoji.mjs): the
// server's owner/moderator string tiers pass unconditionally, everyone
// else's role aggregate must hold the bit, and platform staff pass like the
// message delete always has. Per-channel overwrites are the SEND/VIEW
// family's concern; manage-family grants ride the role aggregate.
const PIN_MANAGER_READ_SQL =
  "SELECT COALESCE((SELECT sm.role FROM gc_server_members sm WHERE sm.server_id = ? AND sm.user_id = ?), '') AS tier, " +
    roleMaskColumnSql() + " AS mask";

function pinRights(session, classifierRow, grants) {
  const userId = Number(session.user.id);
  if (Number(classifierRow.author_id) === userId) return true; // own-message pin, both directions
  if (session.user.role === "owner" || session.user.role === "admin") return true;
  // grants is null exactly when the classifier said non-server (a DM/group
  // channel rides own-or-staff only) — the caller already split on it.
  if (grants === null) return false;
  const tier = String(grants.tier || "");
  if (tier === "owner" || tier === "moderator") return true;
  return (parseMergedMask(grants.mask) & Number(SERVER_PERMISSIONS.DELETE_MESSAGES)) !== 0;
}

async function handlePinRoute(request, env, messageId, pinned) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  // The write-bucket rider (review NIT-1): a pin/unpin is a mutation route
  // (PUT or DELETE /pin — this handler serves both), so the write limiter
  // rides BEFORE any table work, the same per-actor shape the other
  // write-routed lanes carry.
  await rateLimit(request, env, "write", "pin:" + userId);

  // The classifier read: the message's own pinned state and its channel's
  // server (a DM/group channel rides own-or-staff only). Unknown id → the
  // shared 404; no write ever fires for one.
  const row = await env.GOOBER_DB.prepare(
    "SELECT m.author_id AS author_id, m.is_pinned AS is_pinned, " +
      "c.server_id AS server_id " +
      "FROM gc_messages m JOIN gc_channels c ON c.id = m.channel_id " +
      "WHERE m.id = ? LIMIT 1",
  ).bind(messageId).first();
  if (!row) throw new HttpError(404, "Message not found.");

  let grants = null;
  if (row.server_id !== null && row.server_id !== undefined) {
    grants = await env.GOOBER_DB.prepare(PIN_MANAGER_READ_SQL)
      .bind(Number(row.server_id), userId, Number(row.server_id), userId).first();
  }
  if (!pinRights(session, row, grants)) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  if (pinned) {
    // Pin repeat = the reaction repeat precedent: already-pinned is a no-op
    // 200, never a refusal.
    if (row.is_pinned) return json({ pinned: true, id: Number(messageId) });
    // The cap rides INSIDE the statement (the count arm): zero changes means
    // the channel is at the cap — the classification is honest, since the
    // unknown-id and unauthorized shapes already answered above.
    const result = await env.GOOBER_DB.prepare(
      "UPDATE gc_messages SET is_pinned = 1 WHERE id = ? AND " +
        "(SELECT COUNT(*) FROM gc_messages WHERE channel_id = " +
          "(SELECT channel_id FROM gc_messages WHERE id = ?) AND is_pinned = 1) < ?",
    ).bind(messageId, messageId, GC_PINS_MAX_PER_CHANNEL).run();
    if (Number(result.meta?.changes) !== 1) {
      throw new HttpError(400, "This channel already has " + GC_PINS_MAX_PER_CHANNEL + " pins.");
    }
    return json({ pinned: true, id: Number(messageId) });
  }

  // Unpin: authorized (own or the manage-pin grant) and idempotent — an
  // unpinned row's unpin is the same 200, never a second oracle read.
  await env.GOOBER_DB.prepare(
    "UPDATE gc_messages SET is_pinned = 0 WHERE id = ?",
  ).bind(messageId).run();
  return json({ pinned: false, id: Number(messageId) });
}

// The channel's pinned set, newest-first (message id order = Discord's
// reverse-chronological pins read), one page bounded by the cap itself. The
// gate mirrors the history route's exact read (membership + VIEW bit), and
// the payloads are the history read's own shape — the client renders the
// same message objects from either route.
async function handleChannelPinsRoute(request, env, channelId) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);

  const channel = await channelForUser(env, channelId, userId);
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");
  await enforceChannelBits(env, channel, userId, ["VIEW"]);

  const page = (await env.GOOBER_DB.prepare(
    MESSAGE_SELECT +
      " WHERE m.channel_id = ? AND m.is_pinned = 1" +
      " ORDER BY m.id DESC LIMIT " + GC_PINS_MAX_PER_CHANNEL,
  ).bind(nowSeconds(), channelId).all()).results || [];

  // Attachments and reactions ride the SAME grouped reads the history page
  // uses (one read each for the whole payload, never per-row) — the shared
  // fan-out chunks them under the D1 bind limit exactly as the history
  // page's grouped reads do.
  const messageIds = page.map((row) => Number(row.id));
  const attachmentIdsByMessage = new Map();
  const reactionGroupsByMessage = new Map();
  if (messageIds.length) {
    await groupedPayloadReads(env, userId, messageIds, attachmentIdsByMessage, reactionGroupsByMessage);
  }

  return json({
    messages: page.map((row) =>
      publicMessage(row, attachmentIdsByMessage.get(Number(row.id)) || [],
        reactionGroupsByMessage.get(Number(row.id)) || null)),
  });
}export async function handleMessageRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) threads into the DELETE ride: the
  // doomed attachments' R2 objects ride the caller's waitUntil (media.mjs's
  // scheduleAttachmentObjectDelete).

  const channelsMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/channels\/([1-9][0-9]{0,14})\/messages$/)
    : null;
  if (channelsMatch) {
    const channelId = Number(channelsMatch[1]);
    return method === "GET"
      ? handleListMessagesRoute(request, env, url, channelId)
      : handleSendMessageRoute(request, env, channelId);
  }

  const messageMatch = (method === "PATCH" || method === "DELETE")
    ? path.match(/^\/api\/messages\/([1-9][0-9]{0,14})$/)
    : null;
  if (messageMatch) {
    return method === "PATCH"
      ? handleEditMessageRoute(request, env, Number(messageMatch[1]))
      : handleDeleteMessageRoute(request, env, Number(messageMatch[1]), ctx);
  }

  // The pins lane (0026): PUT/DELETE /api/messages/:id/pin and the channel's
  // newest-first GET — the dispatch patterns stay the bare-id family, and a
  // /pins path never collides with the plain /messages match above.
  const pinMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/messages\/([1-9][0-9]{0,14})\/pin$/)
    : null;
  if (pinMatch) {
    return handlePinRoute(request, env, Number(pinMatch[1]), method === "PUT" ? 1 : 0);
  }

  const pinsMatch = method === "GET"
    ? path.match(/^\/api\/channels\/([1-9][0-9]{0,14})\/pins$/)
    : null;
  if (pinsMatch) {
    return handleChannelPinsRoute(request, env, Number(pinsMatch[1]));
  }

  return undefined;
}
