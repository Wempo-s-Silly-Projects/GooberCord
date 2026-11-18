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

// The mentions wave (owner direct ask): a message body STORES plain text —
// the @everyone / @here / @username forms resolve at gate time and at the
// client's render time, the same class as the 0020 expression tokens.
//
// W-B2 rides the persistence half onto the same parser: every SEND resolves
// its @username tokens against the channel's roster and writes ONE
// gc_mentions row per mentioned member (0028; repeated tokens dedupe onto
// the same row, INSERT OR IGNORE), so the inbox below is a plain indexed
// read. The roster read happens ONLY when the body carries an "@" — a
// mention-free send costs nothing. The rows SNAPSHOT at send: an EDIT (the
// PATCH lane) re-runs the gates on its body but never re-resolves the roster,
// so an edit's mention of an unmentioned member does not ping them.
//
// The client parses these the same way the gates do (the contract the lead
// relays): the flag tokens are case-insensitive and word-bounded, and a
// @username resolves against the channel's roster case-insensitively, the
// server nickname (the display name) before the username, with a candidate
// that matches MORE THAN ONE member resolving to nobody at all.

// The @everyone / @here flags. A match needs a non-name seam on both sides,
// so "@everyonehere" and "mail@everyone.com" are plain text — the flag is a
// send gate, not a spellchecker.
const EVERYONE_FLAG_RE = /(^|[^A-Za-z0-9_])@everyone(?![A-Za-z0-9_])/i;
const HERE_FLAG_RE = /(^|[^A-Za-z0-9_])@here(?![A-Za-z0-9_])/i;

// True when the body carries an @everyone or an @here (case-insensitive).
export function mentionsEveryoneFlag(text) {
  return EVERYONE_FLAG_RE.test(text) || HERE_FLAG_RE.test(text);
}

// matchRosterMentions(text, members): the @username resolution the gates
// pin and the client re-renders. members is the roster shape the payloads
// already carry: [{ id, username, nickname }].
//
//   One candidate: '@' then 2..32 name characters (letters, digits, and the
//   space/dot/dash seams a display name carries), greedily collected, then
//   matched LONGEST-FIRST — so a trailing-word display name
//   ("wempo two" from "@wempo two") wins over the shorter username ("wempo")
//   a strict prefix would have caught.
//
//   Resolution per candidate, in order: a UNIQUE case-insensitive hit against
//   nickname-or-username resolves; several hits (a nickname on one member
//   colliding with another member's username) are AMBIGUOUS and resolve to
//   nobody (the ambiguity must not be broken by shortening); no hit walks the
//   candidate down one seam and retries.
//
//   Returns the resolved user ids, one entry per MENTION TOKEN (an id
//   repeated by repeated tokens stays repeated — the count is the sender's
//   own punctuation, render-side), first-occurrence order.
const CANDIDATE_RE = /@[A-Za-z0-9_][A-Za-z0-9_ .-]{1,31}/g;

function memberMatches(member, lower) {
  const nickname = typeof member?.nickname === "string" ? member.nickname.trim().toLowerCase() : "";
  if (nickname.length > 0 && nickname === lower) return true;
  return String(member?.username || "").toLowerCase() === lower;
}

export function matchRosterMentions(text, members) {
  const roster = Array.isArray(members) ? members : [];
  const resolved = [];
  for (const raw of String(text).matchAll(CANDIDATE_RE)) {
    const collected = raw[0].slice(1).trim();
    let hit = null;
    for (let end = collected.length; end >= 2; end--) {
      const lower = collected.slice(0, end).toLowerCase();
      const hits = roster.filter((member) => memberMatches(member, lower));
      if (hits.length === 1) {
        hit = hits[0];
        break;
      }
      if (hits.length > 1) break; // ambiguous at this width: no shortening rescue
    }
    if (hit !== null) resolved.push(Number(hit.id));
  }
  return resolved;
}

// --- W-B2: the persisted mention rows + the inbox routes -------------------------
//
// The send-side writes land INSIDE the send batch (the statements this
// helper returns), using the same in-batch identity tuple the upload lane's
// move proved: the message id is re-derived from the batch's own insert
// shape (channel + author + created_at + the client id arm) rather than
// carried across statements — a replayed client id re-resolves to the
// ORIGINAL row and the INSERT OR IGNORE dedupes onto the stored rows, so an
// idempotent replay writes nothing twice.
//
// Mention persistence is best-effort per shape but NOT for SQL failures: the
// statements ride the same batch as the message, so either both land or
// neither does (the send's own atomicity).
import { GC_MENTIONS_MAX_PER_MESSAGE, GC_MENTIONS_PAGE_DEFAULT, GC_MENTIONS_PAGE_MAX } from "../constants.mjs";
import { requireUser } from "./core/auth.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";

// The roster reads a send's mention resolve needs. ONLY a body carrying an
// "@" spends one (the "@" pre-gate lives in mentionPersistStatements). The
// server read carries sm.nickname (the MED-3 fix: a server @mention that
// names a member's nickname only used to miss — the roster had no nickname
// to match; the DM read stays the username-only shape it always was).
const SERVER_ROSTER_SQL =
  "SELECT sm.user_id AS id, u.username AS username, sm.nickname AS nickname " +
  "FROM gc_server_members sm JOIN users u ON u.id = sm.user_id " +
  "WHERE sm.server_id = ?";
const DM_ROSTER_SQL =
  "SELECT cm.user_id AS id, u.username AS username " +
  "FROM gc_conversation_members cm JOIN users u ON u.id = cm.user_id " +
  "WHERE cm.channel_id = ?";

const MENTION_IDENTITY_SQL =
  "(SELECT id FROM gc_messages WHERE channel_id = ? AND author_id = ? AND created_at = ? AND ";

export async function mentionPersistStatements(env, serverId, channelId, authorId, createdAt, clientMessageId, text) {
  if (!text || !text.includes("@")) return [];
  const roster = (await env.GOOBER_DB.prepare(
    serverId === null || serverId === undefined ? DM_ROSTER_SQL : SERVER_ROSTER_SQL,
  ).bind(serverId === null || serverId === undefined ? Number(channelId) : Number(serverId)).all()).results || [];
  const resolved = [...new Set(matchRosterMentions(text, roster))];
  const capped = resolved.slice(0, GC_MENTIONS_MAX_PER_MESSAGE);
  return capped.map((userId) =>
    env.GOOBER_DB.prepare(
      "INSERT OR IGNORE INTO gc_mentions (message_id, user_id, created_at) SELECT " +
        MENTION_IDENTITY_SQL +
        (clientMessageId === null
          ? "client_message_id IS NULL ORDER BY id DESC LIMIT 1), ?, ?"
          : "client_message_id = ? ORDER BY id DESC LIMIT 1), ?, ?"),
    // The binds RIDE VARIADIC (the D1 bind takes each parameter position
    // separately — a bare array would bind as ONE blob parameter).
    ).bind(
      ...(
        clientMessageId === null
          ? [Number(channelId), authorId, createdAt, userId, createdAt]
          : [Number(channelId), authorId, createdAt, clientMessageId, userId, createdAt]
      ),
    ),
  );
}

const MENTION_LIST_SQL =
  "SELECT gm.message_id AS message_id, gm.created_at AS mentioned_at, " +
    "m.channel_id AS channel_id, c.name AS channel_name, c.kind AS channel_kind, " +
    "m.author_id AS author_id, gu.username AS author_username, " +
    "m.body AS body, m.created_at AS created_at " +
  "FROM gc_mentions gm " +
    "JOIN gc_messages m ON m.id = gm.message_id " +
    "JOIN users gu ON gu.id = m.author_id " +
    "JOIN gc_channels c ON c.id = m.channel_id " +
  "WHERE gm.user_id = ? " +
    // The viewer still keeps the channel where the mention lives: a server
    // they left or a conversation they exited never feeds the inbox (the
    // rows stay, the read guards).
    // The membership guard is ONE group (the server arm OR the conversation
    // arm): both parens balanced, else the page is a syntax error.
    "AND ((c.server_id IS NOT NULL AND EXISTS (SELECT 1 FROM gc_server_members fsm " +
      "WHERE fsm.server_id = c.server_id AND fsm.user_id = ?)) " +
      "OR (c.server_id IS NULL AND EXISTS (SELECT 1 FROM gc_conversation_members fcm " +
      "WHERE fcm.channel_id = c.id AND fcm.user_id = ?)))";

async function handleListMentionsRoute(request, env, url) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "user:" + userId);

  const limitRaw = url.searchParams.get("limit");
  let limit = GC_MENTIONS_PAGE_DEFAULT;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^[0-9]{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > GC_MENTIONS_PAGE_MAX) {
      throw new HttpError(400, "That mentions limit is invalid.");
    }
    limit = Number(limitRaw);
  }

  const rows = (await env.GOOBER_DB.prepare(MENTION_LIST_SQL + " ORDER BY gm.message_id DESC LIMIT " + limit)
    .bind(userId, userId, userId).all()).results || [];
  return json({
    mentions: rows.map((row) => ({
      messageId: Number(row.message_id),
      channelId: Number(row.channel_id),
      channelName: row.channel_name,
      channelKind: row.channel_kind,
      authorId: Number(row.author_id),
      authorUsername: row.author_username,
      body: row.body,
      createdAt: Number(row.created_at),
      mentionedAt: Number(row.mentioned_at),
    })),
  }, 200);
}

// Read-through deletion (the deprecated mentions endpoint's shape, whose {id}
// WAS the message id): the caller's own row for that message, never
// someone else's, and idempotent — a message already deleted from the inbox
// simply answers the empty-changes 200.
async function handleDeleteMentionRoute(request, env, messageId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  // The MED-4 limiter: the delete is a write-lane call (its own bucket —
  // the list's read bucket never covered it).
  await rateLimit(request, env, "write", "mentions:" + userId);
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_mentions WHERE message_id = ? AND user_id = ?",
  ).bind(messageId, userId).run();
  return json({ deleted: Number(result.meta?.changes) > 0 }, 200);
}

export async function handleMentionRoutes(request, env, url, path, method, ctx) {
  void ctx;
  if (path === "/api/mentions" && method === "GET") {
    return handleListMentionsRoute(request, env, url);
  }
  if (method === "DELETE") {
    const match = path.match(/^\/api\/mentions\/([1-9][0-9]{0,14})$/);
    if (match) return handleDeleteMentionRoute(request, env, Number(match[1]));
  }
  return undefined;
}
