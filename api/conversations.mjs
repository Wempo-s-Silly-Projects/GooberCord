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

// Conversations routes (Phase 1, Task 7): DMs and group chats as server-less
// gc_channels rows (kind 'dm'/'group' with server_id NULL — the schema's CHECK
// pins that pairing) whose membership lives in gc_conversation_members. This
// is the plan's realization of the spec's gc_conversations: the spec's
// "conversation" IS a channel here, so messaging a conversation already rides
// Task 5's channel message routes (CHANNEL_ACCESS_SQL's server_id IS NULL arm)
// and sendMessageToChannel verbatim — this module only owns find-or-create,
// the list, and the leave.
//
// Authorization follows the module-wide rule: the guards ride INSIDE the SQL.
// The leave is a member-guarded DELETE whose WHERE carries the group-kind
// precondition, and the empty-channel delete is NOT-EXISTS-guarded in the same
// batch. Names are never stored: a DM's name is the other member's username
// and a group's is the other members joined — both computed at read time.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import { plusActiveExpr, publicIsPlus } from "./plus.mjs";
import { createAttachment, readMultipartWithImage } from "./media.mjs";

// The group cap counts the INVITES, not the roster: 1 id opens a DM, 2–9
// invite a group (self rides along, so the roster is at most 10 —
// docs/parity-limits.md: Group DM members 10, verified 2026-11-17).
const MAX_GROUP_INVITES = 9;
// Matches the route-id conventions (bare ids, bounded width).
const MAX_ID = 1e15;

// The canonical pair lookup: a dm-kind channel where BOTH members sit on the
// member rows and the roster is exactly two. Symmetric in both ids, so no
// canonical ordering is needed.
const DM_FIND_SQL =
  "SELECT c.id FROM gc_channels c " +
  "JOIN gc_conversation_members sm ON sm.channel_id = c.id AND sm.user_id = ? " +
  "JOIN gc_conversation_members om ON om.channel_id = c.id AND om.user_id = ? " +
  "WHERE c.kind = 'dm' " +
  "AND (SELECT COUNT(*) FROM gc_conversation_members fm WHERE fm.channel_id = c.id) = 2 " +
  "LIMIT 1";

// Either direction of the forum's read-only blocks pair refuses the request.
// Phase-3 social adds the gc_blocks tier to the SAME read (one UNION, four
// bind groups in the same selfId-then-targets order): a social block refuses
// a new conversation exactly like the forum blocks row always has.
function blocksReadSql(ids) {
  const marks = ids.map(() => "?").join(",");
  const pair = (table, extra = "") =>
    "SELECT 1 FROM " + table +
    " WHERE (blocker_id = ? AND blocked_id IN (" + marks + ")) " +
    "OR (blocked_id = ? AND blocker_id IN (" + marks + "))" + extra;
  // The gc_blocks arm carries the HARD tier only: an 'ignored' row is the
  // member's own cosmetic pref and must never gate a conversation they can
  // still open or answer normally (the filed soft tier).
  return pair("blocks") + " UNION ALL " + pair("gc_blocks", " AND kind = 'blocked'") +
    " LIMIT 1";
}

// The phase-3 DM gate: thread creation to a non-friend pair is refused when
// the recipient has requests closed (the filed Everyone vs OFF reading —
// GC's everyone-can-DM default stands otherwise). One read resolves both the
// COALESCE'd prefs row (absent row = everyone, so no backfill touches users)
// and the canonical friendship pair. The existing blocks read above has
// already refused the blocked pair by the time this runs.
const DM_REQUEST_GATE_SQL =
  "SELECT COALESCE((SELECT accept_requests FROM gc_social_prefs WHERE user_id = ?), 1) AS accept_requests, " +
    "EXISTS (SELECT 1 FROM gc_friends WHERE (user_a_id = ? AND user_b_id = ?) " +
      "OR (user_a_id = ? AND user_b_id = ?)) AS friends";

// The caller's dm/group channels, with the unread count derived from THEIR
// member row's cursor (gm.id > last_read_message_id) right in the SQL. The
// group icon reference (0015) rides the same row — a null degrades to no
// image, exactly the pre-0015 payload.
const CONVERSATIONS_LIST_SQL =
  "SELECT c.id, c.name AS stored_name, c.icon_media_id AS icon_media_id, c.kind, " +
    "c.last_message_id, c.last_message_at, m.last_read_message_id, " +
    "(SELECT COUNT(*) FROM gc_messages gm WHERE gm.channel_id = c.id " +
      "AND gm.id > m.last_read_message_id) AS unread " +
  "FROM gc_channels c JOIN gc_conversation_members m ON m.channel_id = c.id " +
  "WHERE m.user_id = ? AND c.kind IN ('dm','group') " +
  "ORDER BY c.last_message_id DESC, c.id DESC";

// The group rename (SHAVERS 2): a dm's name IS its member list and a dm is
// NEVER renamed, so this route is group-only in the SQL. A renamed group's
// stored name wins over the read-time joined-member name — the discriminator
// is the create-time value (the stored name IS the kind for a group that was
// never renamed), so no extra flag column rides the row.
function customName(storedName, kind) {
  return typeof storedName === "string" && storedName.length > 0 && storedName !== kind
    ? storedName
    : null;
}

// Icon URLs ride the shared serving gate exactly like the server icons
// (0003's bare column; the media id only ever moves in from a row the CALLER
// uploaded, guarded inside the route's UPDATE).
function attachmentUrl(mediaId) {
  return mediaId === null || mediaId === undefined ? null : "/api/attachments/" + Number(mediaId);
}

// The rosters and previews for exactly the listed channels — one IN-list read
// each, never a per-channel query (an empty list short-circuits to zero rows).
// The roster carries the plusActiveExpr badge: `?` sits in the SELECT list,
// so its `now` bind precedes the IN-list marks (callers bind nowSeconds()
// FIRST, in textual order).
const ROSTER_SQL =
  "SELECT m.channel_id, m.user_id AS member_id, u.username, " + plusActiveExpr("u.id") + " " +
  "FROM gc_conversation_members m JOIN users u ON u.id = m.user_id " +
  "WHERE m.channel_id IN (PLACEHOLDERS) ORDER BY m.channel_id, m.user_id";

const LAST_MESSAGE_SQL =
  "SELECT c.id AS channel_id, m.body, m.created_at, u.username AS author_name " +
  "FROM gc_messages m JOIN gc_channels c ON c.last_message_id = m.id " +
  "JOIN users u ON u.id = m.author_id " +
  "WHERE c.id IN (PLACEHOLDERS)";

// Leave is group-only: the member DELETE's WHERE carries the group-kind
// precondition so a dm channel answers 404 through the same statement.
const LEAVE_MEMBERS_DELETE_SQL =
  "DELETE FROM gc_conversation_members WHERE channel_id = ? AND user_id = ? " +
  "AND EXISTS (SELECT 1 FROM gc_channels c WHERE c.id = ? AND c.kind = 'group')";

// After the leaving member row: the channel dies only with the LAST member.
const LEAVE_CHANNEL_DELETE_SQL =
  "DELETE FROM gc_channels WHERE id = ? AND kind = 'group' AND NOT EXISTS " +
    "(SELECT 1 FROM gc_conversation_members cm WHERE cm.channel_id = ?)";

function conversationName(kind, members, selfId) {
  const others = members
    .filter((member) => member.userId !== selfId)
    .map((member) => member.username);
  return kind === "dm" ? (others[0] ?? null) : others.join(", ");
}

async function handleCreateConversationRoute(request, env) {
  const session = await requireUser(request, env);
  const body = await readJson(request);
  const raw = body.userIds;

  if (!Array.isArray(raw)) throw new HttpError(400, "Send the member ids as an array.");

  const selfId = Number(session.user.id);
  const ids = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1 || id >= MAX_ID) {
      throw new HttpError(400, "Member ids must be positive user ids.");
    }
    if (id === selfId) throw new HttpError(400, "You are already a member of the conversation.");
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length === 0) {
    throw new HttpError(400, "A conversation needs at least one other member.");
  }
  if (ids.length > MAX_GROUP_INVITES) {
    throw new HttpError(400, "A group chat can have at most 9 other members.");
  }
  const kind = ids.length === 1 ? "dm" : "group";

  // Every invited id must resolve from the users table — one read (carrying
  // the plusActiveExpr badge for the member shapes below; the `?` sits in the
  // SELECT list, so its `now` bind precedes the IN-list marks), and the
  // refusal happens BEFORE any blocks read or write.
  const rows = (await env.GOOBER_DB.prepare(
    "SELECT id, username, " + plusActiveExpr("id") +
      " FROM users WHERE id IN (" + ids.concat([selfId]).map(() => "?").join(",") + ")",
  ).bind(nowSeconds(), selfId, ...ids).all()).results || [];
  const usernameById = new Map(rows.map((row) => [Number(row.id), row.username]));
  const plusById = new Map(rows.map((row) => [Number(row.id), publicIsPlus(row)]));
  if (ids.some((id) => !usernameById.has(id))) {
    throw new HttpError(400, "One of those members does not exist.");
  }

  // Blocks (read-only use of the forum table plus the social tier): a
  // blocker-blocked pair with any requested member refuses — as DM or group
  // alike.
  const blockedRow = await env.GOOBER_DB.prepare(blocksReadSql(ids))
    .bind(selfId, ...ids, selfId, ...ids, selfId, ...ids, selfId, ...ids).first();
  if (blockedRow) {
    throw new HttpError(403, "You can't start a conversation with that member.");
  }

  // The filed DM gate (phase-3 social): direct thread creation to a non-friend
  // is refused only while the recipient keeps requests closed; with requests
  // open (the GC default) the cold DM stands. A missing prefs row is the
  // open default, so the absent-row read answers null and the create proceeds.
  if (kind === "dm") {
    const [otherId] = ids;
    const gate = await env.GOOBER_DB.prepare(DM_REQUEST_GATE_SQL)
      .bind(selfId, otherId, otherId, otherId, otherId).first();
    if (gate && Number(gate.accept_requests) === 0 && Number(gate.friends) !== 1) {
      throw new HttpError(403, "That member only accepts messages from friends.");
    }
  }

  const members = [
    { userId: selfId, username: session.user.username, isPlus: Boolean(plusById.get(selfId)) },
    ...ids.map((id) => ({ userId: id, username: usernameById.get(id), isPlus: Boolean(plusById.get(id)) })),
  ];

  // DM find-or-create: reuse the existing pair channel, answer 200 with it.
  if (kind === "dm") {
    const found = await env.GOOBER_DB.prepare(DM_FIND_SQL).bind(selfId, ids[0]).first();
    if (found) {
      return json({ conversation: { id: Number(found.id), name: usernameById.get(ids[0]), kind, members } }, 200);
    }
  }
  // Groups ALWAYS create new: no lookup, straight to the batch.

  const now = nowSeconds();
  // The channel INSERT runs FIRST, as its own statement, so every member
  // statement can bind the channel's LITERAL id. Deriving it inside the batch
  // with last_insert_rowid() is wrong once more than one member rides along:
  // each member INSERT completes and becomes the connection's last insert, so
  // members 2..N bind to the PREVIOUS member row's rowid (real-SQLite repro:
  // channel id 6 produced member rows (6,7),(3,9),(4,10)) — on D1 the member
  // FKs turn that into failed (or silent) corruption.
  const channelResult = await env.GOOBER_DB.prepare(
    "INSERT INTO gc_channels (server_id, name, kind, position, created_at) " +
      "VALUES (NULL, ?, ?, 0, ?)",
  ).bind(kind, kind, now).run();
  if (Number(channelResult?.meta?.changes) !== 1) {
    // Unreachable short of a constraint regression (server_id NULL + the
    // dm/group CHECK are pre-shaped); surfaced instead of a half-built row.
    throw new HttpError(500, "The conversation could not be created. Please try again.");
  }
  const channelId = Number(channelResult.meta.last_row_id);

  // ALL member inserts ride ONE batch, each bound to the literal channel id.
  // The memberless-window guard: the channel row is already COMMITTED, so any
  // member-batch failure (a D1 abort or a refused insert) must delete the
  // stranded row — no compensating delete would leave a memberless channel
  // on the shared DB, invisible to every member-join read but never cleaned.
  const DELETE_STRANDED_CHANNEL_SQL =
    "DELETE FROM gc_channels WHERE id = ? AND server_id IS NULL";
  let memberResults;
  try {
    memberResults = await env.GOOBER_DB.batch(
      members.map((member) =>
        env.GOOBER_DB.prepare(
          "INSERT INTO gc_conversation_members (channel_id, user_id, last_read_message_id) " +
            "VALUES (?, ?, 0)",
        ).bind(channelId, member.userId),
      ),
    );
  } catch (batchError) {
    await env.GOOBER_DB.prepare(DELETE_STRANDED_CHANNEL_SQL).bind(channelId).run();
    throw batchError;
  }
  if (memberResults.some((result) => Number(result?.meta?.changes) !== 1)) {
    await env.GOOBER_DB.prepare(DELETE_STRANDED_CHANNEL_SQL).bind(channelId).run();
    throw new HttpError(500, "The conversation could not be created. Please try again.");
  }

  return json(
    { conversation: { id: channelId, name: conversationName(kind, members, selfId), kind, members } },
    201,
  );
}

async function handleListConversationsRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const selfId = Number(session.user.id);

  const channels = (await env.GOOBER_DB.prepare(CONVERSATIONS_LIST_SQL)
    .bind(selfId).all()).results || [];

  const channelIds = channels.map((row) => Number(row.id));
  if (channelIds.length === 0) return json({ conversations: [] });

  const marks = channelIds.map(() => "?").join(",");
  const rosters = (await env.GOOBER_DB.prepare(
    ROSTER_SQL.replace("PLACEHOLDERS", marks),
  ).bind(nowSeconds(), ...channelIds).all()).results || [];
  const previews = (await env.GOOBER_DB.prepare(
    LAST_MESSAGE_SQL.replace("PLACEHOLDERS", marks),
  ).bind(...channelIds).all()).results || [];

  const membersByChannel = new Map();
  for (const row of rosters) {
    const channelId = Number(row.channel_id);
    const list = membersByChannel.get(channelId) || [];
    list.push({ userId: Number(row.member_id), username: row.username, isPlus: publicIsPlus(row) });
    membersByChannel.set(channelId, list);
  }

  const lastByChannel = new Map();
  for (const row of previews) {
    lastByChannel.set(Number(row.channel_id), {
      body: row.body,
      createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
      authorName: row.author_name,
    });
  }

  return json({
    conversations: channels.map((row) => {
      const channelId = Number(row.id);
      const members = membersByChannel.get(channelId) || [];
      const stored = customName(row.stored_name, row.kind);
      return {
        id: channelId,
        // A renamed group's stored name wins; dm channels and never-renamed
        // groups keep the read-time member-list name (the pre-SHAVERS-2
        // payload's exact shape).
        name: stored ?? conversationName(row.kind, members, selfId),
        // The 0015 group icon: present only when one was ever uploaded (the
        // payload grows no key otherwise, same additive idiom as the badges).
        ...(row.icon_media_id !== null && row.icon_media_id !== undefined
          ? { iconUrl: attachmentUrl(row.icon_media_id) }
          : {}),
        kind: row.kind,
        members,
        lastMessage: lastByChannel.get(channelId) ?? null,
        unread: Number(row.unread || 0),
      };
    }),
  });
}

async function handleLeaveConversationRoute(request, env, conversationId) {
  const session = await requireUser(request, env);
  const selfId = Number(session.user.id);

  // The member row delete runs FIRST and its result GATES the channel delete:
  // zero changes means "not a member, not a group, or no such channel" — all
  // answer the outsider shape, 404 (never 403) — and NOTHING else may run.
  // (A single batch cannot express that: an unconditional second statement
  // would fire for an outsider too, and against a memberless group channel its
  // NOT-EXISTS arm passes, destroying the channel while the caller is told
  // 404.) The channel delete itself stays NOT-EXISTS-guarded so it removes the
  // channel only when the departing caller truly was the LAST member.
  const memberResult = await env.GOOBER_DB.prepare(LEAVE_MEMBERS_DELETE_SQL)
    .bind(conversationId, selfId, conversationId).run();
  if (Number(memberResult?.meta?.changes) !== 1) {
    throw new HttpError(404, "This conversation does not exist or you cannot view it.");
  }
  await env.GOOBER_DB.prepare(LEAVE_CHANNEL_DELETE_SQL).bind(conversationId, conversationId).run();

  return json({ ok: true });
}

// --- SHAVERS 2: group-DM management (rename, icon, add/remove members) -----------
//
// The same inside-the-SQL discipline as this module's every route: membership
// rides INSIDE the statement (a non-member is 404, never a 403 that would
// oracle the channel's existence), dm channels are excluded right beside it
// (kind = 'group', server_id IS NULL — the schema's pinned pairing), and every
// response echoes the STORED row.

const GROUP_NAME_MAX = 100;
// The roster cap counts ALL members INCLUDING the caller (the create route's
// 8 invites + self = 9 shape).
const GROUP_MEMBERS_MAX = MAX_GROUP_INVITES + 1;

// The group-management gate: caller membership + the group kind, in one read
// (the UPDATE/INSERT guards re-express it inside their own statements — the
// read is diagnostics only, so a 404 is answered without a second probe).
const GROUP_GATE_SQL =
  "SELECT c.id, c.kind, c.name AS stored_name, c.icon_media_id AS icon_media_id, " +
    "(SELECT COUNT(*) FROM gc_conversation_members cm WHERE cm.channel_id = c.id) AS members " +
  "FROM gc_channels c WHERE c.id = ? AND c.server_id IS NULL AND EXISTS " +
    "(SELECT 1 FROM gc_conversation_members me WHERE me.channel_id = c.id AND me.user_id = ?) " +
  "LIMIT 1";

async function groupChannelFor(env, conversationId, userId) {
  const channel = await env.GOOBER_DB.prepare(GROUP_GATE_SQL)
    .bind(conversationId, userId).first();
  if (!channel) {
    // Non-member (or no such channel, or a server channel) — the outsider
    // shape, never a 403 existence oracle.
    throw new HttpError(404, "This conversation does not exist or you cannot view it.");
  }
  if (channel.kind !== "group") {
    throw new HttpError(400, "Group chats only. A dm IS its member list.");
  }
  return channel;
}

async function handleUpdateConversationRoute(request, env, conversationId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();

  const nameField = { present: false, value: null };
  const iconField = { present: false, value: null };

  if (contentType.startsWith("multipart/form-data")) {
    // Uploads ride the same limiter as the server-icon PATCH, then the SAME
    // multipart reader (the `image` file part is enforced there).
    await rateLimit(request, env, "upload", "user:" + userId);
    const { fields, files } = await readMultipartWithImage(request);
    if (fields.name !== undefined) {
      nameField.present = true;
      nameField.value = requiredText(fields.name, "group chat name", GROUP_NAME_MAX);
    }
    if (files.length > 1) throw new HttpError(400, "Attach exactly one image.");
    if (files.length > 0) {
      // The icon intake (free-cap default — icons are small, exactly like the
      // server icons): one attachment row per PATCH, pending moderation like
      // every attachment.
      const attachment = await createAttachment(env, userId, files[0]);
      iconField.present = true;
      iconField.value = attachment.id;
    }
  } else {
    const body = await readJson(request);
    if (body.name !== undefined) {
      nameField.present = true;
      nameField.value = requiredText(body.name, "group chat name", GROUP_NAME_MAX);
    }
    if (body.iconMediaId !== undefined) {
      // A named (uploaded-elsewhere) media id only ever moves into the slot
      // when it is the CALLER'S OWN attachment — the UPDATE's WHERE decides,
      // never a probe. null clears.
      iconField.present = true;
      iconField.value = body.iconMediaId === null ? null : Number(body.iconMediaId);
      if (!nameField.present && (iconField.value === null || !Number.isInteger(iconField.value) || iconField.value <= 0)) {
        throw new HttpError(400, "iconMediaId must be an attachment id, or null to clear it.");
      }
    }
  }

  if (!nameField.present && !iconField.present) {
    throw new HttpError(400, "Nothing to change. Send a name or an icon.");
  }

  const setClauses = [];
  const setBinds = [];
  if (nameField.present) {
    setClauses.push("name = ?");
    setBinds.push(nameField.value);
  }
  if (iconField.present) {
    setClauses.push("icon_media_id = ?");
    setBinds.push(iconField.value);
  }

  // Gate BEFORE the write (so a dm answers its 400 without touching a row).
  const channel = await groupChannelFor(env, conversationId, userId);

  // The UPDATE carries the membership + group guards INSIDE (the read above
  // is diagnostics only), and the icon guard rides it: icon_media_id may only
  // resolve to one of the CALLER'S OWN gc_attachments rows (the server-icon
  // rule, mirrored).
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_channels SET " + setClauses.join(", ") +
      " WHERE id = ? AND kind = 'group' AND server_id IS NULL AND EXISTS " +
        "(SELECT 1 FROM gc_conversation_members me WHERE me.channel_id = gc_channels.id AND me.user_id = ?)" +
      (iconField.present && iconField.value !== null
        ? " AND EXISTS (SELECT 1 FROM gc_attachments WHERE id = ? AND uploader_id = ?)"
        : ""),
  ).bind(
    ...setBinds, conversationId, userId,
    ...(iconField.present && iconField.value !== null ? [iconField.value, userId] : []),
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    // Unreachable through the gates above (the channel, kind, membership and
    // icon ownership all rode the same predicates); surfaced instead of
    // echoing a state nothing wrote.
    throw new HttpError(400, "That change did not apply.");
  }

  // Echo the STORED row (the same values the next list read serves).
  const row = await env.GOOBER_DB.prepare(
    "SELECT id, name AS stored_name, icon_media_id AS icon_media_id, kind FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(conversationId).first();
  return json({
    conversation: {
      id: Number(row.id),
      name: customName(row.stored_name, row.kind),
      ...(row.icon_media_id !== null && row.icon_media_id !== undefined
        ? { iconUrl: attachmentUrl(row.icon_media_id) }
        : {}),
      kind: row.kind,
      members: Number(channel.members),
    },
  });
}

async function handleAddConversationMemberRoute(request, env, conversationId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const targetId = Number(body.userId);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId > 1e15) {
    throw new HttpError(400, "A valid user id is required.");
  }

  // Gate: caller is a member of a group chat (diagnostics read; the INSERT
  // below re-expresses the guards so the verdict still rides its own SQL).
  const channel = await groupChannelFor(env, conversationId, userId);

  if (Number(channel.members) >= GROUP_MEMBERS_MAX) {
    throw new HttpError(409, "That group chat is full.");
  }

  // The added member must resolve from the forum users table — carrying the
  // plusActiveExpr badge for the echoed shape (the `?` sits in the SELECT
  // list, so its `now` bind precedes the WHERE binds).
  const target = await env.GOOBER_DB.prepare(
    "SELECT id, username, " + plusActiveExpr("id") + " FROM users WHERE id = ? LIMIT 1",
  ).bind(nowSeconds(), targetId).first();
  if (!target) throw new HttpError(400, "That member does not exist.");

  // The blocks gate (the SAME read the create route runs — either direction
  // of the forum's pair or the hard gc_blocks tier refuses): from the ADDED
  // member's seat, against every EXISTING member.
  const roster = (await env.GOOBER_DB.prepare(
    "SELECT user_id FROM gc_conversation_members WHERE channel_id = ?",
  ).bind(conversationId).all()).results || [];
  const existingIds = roster.map((row) => Number(row.user_id));
  if (existingIds.length > 0) {
    const blockedRow = await env.GOOBER_DB.prepare(blocksReadSql(existingIds))
      .bind(targetId, ...existingIds, targetId, ...existingIds,
            targetId, ...existingIds, targetId, ...existingIds).first();
    if (blockedRow) {
      throw new HttpError(403, "You can't add that member to this conversation.");
    }
  }

  // The guarded INSERT: the guard carries the group kind + caller membership +
  // target existence + the NOT-EXISTS duplicate arm; zero changes is a real
  // conflict (the member existed before this ran).
  const result = await env.GOOBER_DB.prepare(
    "INSERT INTO gc_conversation_members (channel_id, user_id, last_read_message_id) SELECT ?, ?, 0 WHERE " +
      "EXISTS (SELECT 1 FROM gc_channels c WHERE c.id = ? AND c.kind = 'group' AND c.server_id IS NULL) " +
      "AND EXISTS (SELECT 1 FROM gc_conversation_members me WHERE me.channel_id = ? AND me.user_id = ?) " +
      "AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM gc_conversation_members tm WHERE tm.channel_id = ? AND tm.user_id = ?)",
  ).bind(conversationId, targetId, conversationId, conversationId, userId, targetId, conversationId, targetId).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(409, "That member is already in this group chat.");
  }

  return json({
    member: { userId: Number(target.id), username: target.username, isPlus: publicIsPlus(target) },
  });
}

async function handleRemoveConversationMemberRoute(request, env, conversationId, targetUserId) {
  const session = await requireUser(request, env);
  const selfId = Number(session.user.id);

  // The member-row delete runs FIRST (its WHERE carries the caller's
  // membership, the group kind and the target row) and its result gates the
  // channel delete — the leave route's two-step shape, so zero changes is the
  // 404 outsider shape and NOTHING else ran.
  const memberResult = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_conversation_members WHERE channel_id = ? AND user_id = ? " +
      "AND EXISTS (SELECT 1 FROM gc_channels c WHERE c.id = ? AND c.kind = 'group' AND c.server_id IS NULL) " +
      "AND EXISTS (SELECT 1 FROM gc_conversation_members op WHERE op.channel_id = gc_conversation_members.channel_id AND op.user_id = ?)",
  ).bind(conversationId, targetUserId, conversationId, selfId).run();
  if (Number(memberResult?.meta?.changes) !== 1) {
    throw new HttpError(404, "This conversation does not exist or you cannot view it.");
  }

  // The channel dies only with the LAST member (the leave route's own guard).
  await env.GOOBER_DB.prepare(LEAVE_CHANNEL_DELETE_SQL)
    .bind(conversationId, conversationId).run();

  return json({ ok: true });
}

// The single-conversation read — a member's own view of ONE conversation: the
// read-time name rule, the roster, and the 0015 icon ride the same shapes the
// list route serves; the guard rides INSIDE the SQL (an outsider is 404).
async function handleReadConversationRoute(request, env, conversationId) {
  const session = await requireSignedInRead(request, env);
  const selfId = Number(session.user.id);

  const row = await env.GOOBER_DB.prepare(
    "SELECT c.id, c.kind, c.name AS stored_name, c.icon_media_id AS icon_media_id " +
      "FROM gc_channels c WHERE c.id = ? AND c.server_id IS NULL AND EXISTS " +
        "(SELECT 1 FROM gc_conversation_members me WHERE me.channel_id = c.id AND me.user_id = ?) " +
    "LIMIT 1",
  ).bind(conversationId, selfId).first();
  if (!row) {
    throw new HttpError(404, "This conversation does not exist or you cannot view it.");
  }

  const roster = (await env.GOOBER_DB.prepare(
    ROSTER_SQL.replace("PLACEHOLDERS", "?"),
  ).bind(nowSeconds(), Number(row.id)).all()).results || [];
  const members = roster.map((entry) => ({
    userId: Number(entry.member_id),
    username: entry.username,
    isPlus: publicIsPlus(entry),
  }));

  const stored = customName(row.stored_name, row.kind);
  return json({
    conversation: {
      id: Number(row.id),
      name: stored ?? conversationName(row.kind, members, selfId),
      ...(row.icon_media_id !== null && row.icon_media_id !== undefined
        ? { iconUrl: attachmentUrl(row.icon_media_id) }
        : {}),
      kind: row.kind,
      members,
    },
  });
}

// The read marker (0026): the caller advances THEIR OWN last_read_message_id
// (self-only by construction — the WHERE carries the member row), forward-
// only (never behind), and onto a message the thread actually holds (the
// position must be ≤ the thread's latest id). Discord's POST-ack shape: the
// marker is the sender's business, so the route takes { messageId } and
// answers the settled position. Behind and not-thread-held classify apart —
// the member read carries the current marker, so no oracle query is needed.
async function handleReadMarkerRoute(request, env, conversationId) {
  const session = await requireUser(request, env);
  const selfId = Number(session.user.id);
  // The write-bucket rider (review NIT-1): the marker advance is a mutation
  // (POST /read), so the write limiter rides before the member read keyed to
  // the caller, the shape the other write-routed lanes carry.
  await rateLimit(request, env, "write", "read-marker:" + selfId);
  const body = await readJson(request);
  const messageId = Number(body.messageId);
  if (!Number.isInteger(messageId) || messageId < 1) {
    throw new HttpError(400, "That read position is invalid.");
  }

  // The member row is the gate (a non-member keeps the outsider 404 shape)
  // and it carries the current marker for the classifier.
  const member = await env.GOOBER_DB.prepare(
    "SELECT last_read_message_id AS last_read FROM gc_conversation_members " +
      "WHERE channel_id = ? AND user_id = ? LIMIT 1",
  ).bind(conversationId, selfId).first();
  if (!member) {
    throw new HttpError(404, "This conversation does not exist or you cannot view it.");
  }
  if (messageId <= Number(member.last_read)) {
    throw new HttpError(400, "That read position is behind the current one.");
  }

  // The advance itself: zero changes here can ONLY mean the position sits
  // beyond the thread's messages (the membership, current-marker and forward
  // arms already answered) — the thread-held arm is the statement's own.
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_conversation_members SET last_read_message_id = ? " +
      "WHERE channel_id = ? AND user_id = ? AND last_read_message_id < ? " +
      "AND ? <= (SELECT COALESCE(MAX(id), 0) FROM gc_messages WHERE channel_id = ?)",
  ).bind(messageId, conversationId, selfId, messageId, messageId, conversationId).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(400, "That message is not part of this thread.");
  }
  return json({ lastReadMessageId: messageId });
}

export async function handleConversationRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) completes the dispatch loop's
  // handler signature; these routes schedule no background work today.
  void url;
  void ctx;

  if (path === "/api/conversations" && method === "POST") {
    return handleCreateConversationRoute(request, env);
  }
  if (path === "/api/conversations" && method === "GET") {
    return handleListConversationsRoute(request, env);
  }

  const match = method === "DELETE"
    ? path.match(/^\/api\/conversations\/([1-9][0-9]{0,14})$/)
    : null;
  if (match) {
    return handleLeaveConversationRoute(request, env, Number(match[1]));
  }

  // SHAVERS 2: the group's own management surface — the single read (GET),
  // the rename + icon (PATCH), and the members subresource.
  const itemMatch = (method === "GET" || method === "PATCH")
    ? path.match(/^\/api\/conversations\/([1-9][0-9]{0,14})$/)
    : null;
  if (itemMatch) {
    return method === "GET"
      ? handleReadConversationRoute(request, env, Number(itemMatch[1]))
      : handleUpdateConversationRoute(request, env, Number(itemMatch[1]));
  }

  const membersMatch = method === "POST"
    ? path.match(/^\/api\/conversations\/([1-9][0-9]{0,14})\/members$/)
    : null;
  if (membersMatch) {
    return handleAddConversationMemberRoute(request, env, Number(membersMatch[1]));
  }

  const memberMatch = method === "DELETE"
    ? path.match(/^\/api\/conversations\/([1-9][0-9]{0,14})\/members\/([1-9][0-9]{0,14})$/)
    : null;
  if (memberMatch) {
    return handleRemoveConversationMemberRoute(
      request, env, Number(memberMatch[1]), Number(memberMatch[2]),
    );
  }

  // The read-marker lane (0026): POST /api/conversations/:id/read advances
  // the CALLER'S OWN last_read_message_id — the same store the unread count
  // derives from, never another member's row.
  const readMatch = method === "POST"
    ? path.match(/^\/api\/conversations\/([1-9][0-9]{0,14})\/read$/)
    : null;
  if (readMatch) {
    return handleReadMarkerRoute(request, env, Number(readMatch[1]));
  }

  return undefined;
}
