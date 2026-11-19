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

// T-R26-POLLS: the polls family's home (the wave-26 seam off the largest
// residual module — the same forward contract the pins family rides). The
// vote arm (ONE vote claim per member per poll — the changeable vote is
// the 0061 UNIQUE(poll_id, user_id) floor's upsert conflict arm, refused
// entirely once closed) and the close arm (the creator's authority rides
// INSIDE the statement: the close UPDATE names the message's own author —
// no reopen arm exists) answer here; the payload builder feeds the
// grouped read stack (groupedPayloadReads hands it a chunk, never a new
// parallel stack). The REST arms carry the caller's echo; the rooms DO's
// poll_vote/poll_close frames fan out the SAME shared helpers and cast
// the EXISTING {type:"msg", message} frame — no new DO state, no new
// client frame type (rooms.mjs owns that fan-in; api/ws.mjs's upgrade
// gate already walked the VIEW/SEND pair at the door).
//
// The shared read helpers (channelForUser/enforceChannelBits/
// enforceMemberGatesForChannel, MESSAGE_SELECT/publicMessage) stay ONE
// implementation in messages.mjs, imported at CALL time (the circular
// import stays inert — a module-scope use would TDZ during the cycle;
// the T-R25-SPLIT-SERVERS-1 lesson). The caps ride constants.mjs (never
// a second literal).

import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { POLL_MAX_OPTIONS, GC_POLL_QUESTION_MAX, GC_POLL_OPTION_MAX } from "../constants.mjs";
// The call-time shared helpers (the circular import stays inert):
import {
  channelForUser,
  enforceChannelBits,
  enforceMemberGatesForChannel,
  MESSAGE_SELECT,
  publicMessage,
} from "./messages.mjs";

// pollFromBody(body): the send route's poll kind intake (the body's ONE
// new field). A kind-less body is a plain send (the exact contract it has
// always had — the additive default); kind "poll" validates the
// question/options shape into the send batch's poll arm (POLL_INSERT_TUP
// _SQL in messages.mjs); any other kind 400s — never silently degraded.
// The question IS the message body (it rides the send pipeline's filter
// gate with every other body); the caps ride constants.mjs (never a
// second literal).
export function pollFromBody(body) {
  if (body === null || typeof body !== "object" || body.kind === undefined || body.kind === null) {
    return null;
  }
  if (body.kind !== "poll") {
    throw new HttpError(400, 'That message kind is unknown. Only "poll" messages carry one.');
  }
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    throw new HttpError(400, "A poll needs a question.");
  }
  if (body.body.length > GC_POLL_QUESTION_MAX) {
    throw new HttpError(400, "A poll's question is at most " + GC_POLL_QUESTION_MAX + " characters.");
  }
  if (!Array.isArray(body.options)) throw new HttpError(400, "A poll needs an options array.");
  const options = [];
  for (const raw of body.options) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new HttpError(400, "Every poll option is non-empty text.");
    }
    if (raw.length > GC_POLL_OPTION_MAX) {
      throw new HttpError(400, "A poll option is at most " + GC_POLL_OPTION_MAX + " characters.");
    }
    options.push(raw);
  }
  if (options.length < 2 || options.length > POLL_MAX_OPTIONS) {
    throw new HttpError(400, "A poll needs 2 to " + POLL_MAX_OPTIONS + " options.");
  }
  if (body.multiple !== undefined && body.multiple !== null && typeof body.multiple !== "boolean") {
    throw new HttpError(400, "multiple must be a boolean.");
  }
  return { question: body.body, options, multiple: body.multiple === true };
}

// The poll read: one row per message (0060's message_id UNIQUE).
export const POLL_READ_SQL =
  "SELECT id, message_id, channel_id, question, options_json, multiple, closed_at, closed_by, created_at " +
    "FROM gc_polls WHERE message_id = ? LIMIT 1";

// The vote claim: ONE row per (poll, member) — the changeable vote is the
// conflict arm's replace, never a second row; a closed poll's claim never
// changes (the route gates on the poll's close state before the cast).
export const POLL_VOTE_UPSERT_SQL =
  "INSERT INTO gc_poll_votes (poll_id, user_id, choices_json, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(poll_id, user_id) DO UPDATE SET " +
    "choices_json = excluded.choices_json, updated_at = excluded.updated_at";

// The close: the creator's authority rides INSIDE the statement — the
// message's own author — so a stale read can never close someone else's
// poll, and an already-closed poll's second close changes 0 (the route
// answers the same echo either way — idempotent, never a second oracle).
export const POLL_CLOSE_SQL =
  "UPDATE gc_polls SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL AND " +
    "? = (SELECT m.author_id FROM gc_messages m WHERE m.id = gc_polls.message_id)";

// The grouped tally: one COUNT row per poll-option pair across the chunk,
// driven by json_each over the stored claims (the LIMIT COLLECTION side:
// counts only — per-member ballots beyond the caller's own never leave
// the DB). Chunk-composed with the poll ids' IN tail at the call sites.
export const POLL_TALLY_SQL =
  "SELECT v.poll_id AS poll_id, je.value AS option_index, COUNT(*) AS votes " +
    "FROM gc_poll_votes v, json_each(v.choices_json) je " +
    "WHERE v.poll_id IN (";

// The caller's own claims: never inside the tally's counts (personal
// state reads its own arm), one read across the chunk.
export const POLL_VIEWER_ROWS_SQL =
  "SELECT poll_id, choices_json FROM gc_poll_votes WHERE user_id = ? AND poll_id IN (";

// The poll rows across the chunk (keyed to their messages — 0060's
// message_id UNIQUE is the read arm's index).
export const POLL_CHUNK_READ_SQL =
  "SELECT id, message_id, channel_id, question, options_json, multiple, closed_at, closed_by, created_at " +
    "FROM gc_polls WHERE message_id IN (";

function inTail(items) {
  return items.map(() => "?").join(",") + ")";
}

// appendPollPayloads(env, viewerId, chunk, pollPayloadsByMessage): the
// grouped read's polls leg. THREE chunked reads — the rows, the tally's
// json_each GROUP BY, the viewer's own claims — keyed to the message ids
// the grouped loop already carries. Zero polls in the chunk cost one
// always-empty read (a chunk walks messages that mostly are not polls —
// the reads answer no rows and the map stays empty).
export async function appendPollPayloads(env, viewerId, chunk, pollPayloadsByMessage) {
  if (!chunk || chunk.length === 0) return;
  const pollRows = (await env.GOOBER_DB.prepare(
    POLL_CHUNK_READ_SQL + inTail(chunk),
  ).bind(...chunk).all()).results || [];
  if (pollRows.length === 0) return;

  const pollIdChunk = pollRows.map((row) => Number(row.id));
  const pollPlaceholders = inTail(pollIdChunk);

  // One count array per poll, aligned to its option indexes (stable
  // ordering: zeroed first, the tally rows fill by index).
  const tallyRows = (await env.GOOBER_DB.prepare(
    POLL_TALLY_SQL + pollPlaceholders + " GROUP BY je.value ORDER BY je.value",
  ).bind(...pollIdChunk).all()).results || [];

  const viewerRows = (await env.GOOBER_DB.prepare(
    POLL_VIEWER_ROWS_SQL + pollPlaceholders,
  ).bind(Number(viewerId), ...pollIdChunk).all()).results || [];
  const myByPoll = new Map();
  for (const row of viewerRows) {
    myByPoll.set(Number(row.poll_id), JSON.parse(row.choices_json));
  }

  for (const row of pollRows) {
    const pollId = Number(row.id);
    const tallyByIndex = JSON.parse(row.options_json).map(() => 0);
    for (const tallyRow of tallyRows) {
      if (Number(tallyRow.poll_id) !== pollId) continue;
      const index = Number(tallyRow.option_index);
      if (index >= 0 && index < tallyByIndex.length) {
        tallyByIndex[index] = Number(tallyRow.votes);
      }
    }
    pollPayloadsByMessage.set(
      Number(row.message_id),
      {
        question: row.question,
        options: JSON.parse(row.options_json),
        multiple: Number(row.multiple) === 1,
        closed: row.closed_at !== null,
        closedAt: row.closed_at === null
          ? null
          : new Date(Number(row.closed_at) * 1000).toISOString(),
        votes: tallyByIndex,
        myChoices: myByPoll.get(pollId) || [],
        totalVotes: tallyByIndex.reduce((sum, count) => sum + count, 0),
      },
    );
  }
}

// voteIntake(body): the ballot shape — an array of option indexes,
// duplicates folded (a ballot is a set), order normalized by sort.
function voteIntake(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.choices)) {
    throw new HttpError(400, "A vote needs a choices array.");
  }
  const choices = [];
  for (const raw of body.choices) {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new HttpError(400, "Every choice is an option index.");
    }
    if (!choices.includes(raw)) choices.push(raw);
  }
  if (choices.length === 0) throw new HttpError(400, "A vote needs at least one choice.");
  return choices.sort((a, b) => a - b);
}

// The mutation's shared pre-checks (REST and DO fan-in walk the SAME
// chain, exactly as the send's both transports walk its primitive): the
// message row resolves its channel, the voter rides the visibility + SEND
// pair (a vote participates — the send class) and the member-state gates
// (a timed-out member's cast never lands).
async function pollGate(env, messageId, userId) {
  const messageRow = await env.GOOBER_DB.prepare(
    "SELECT id, channel_id FROM gc_messages WHERE id = ? LIMIT 1",
  ).bind(Number(messageId)).first();
  if (!messageRow) throw new HttpError(404, "Message not found.");
  const channel = await channelForUser(env, Number(messageRow.channel_id), Number(userId));
  if (!channel) throw new HttpError(404, "This channel does not exist or you cannot view it.");
  await enforceChannelBits(env, channel, Number(userId), ["VIEW", "SEND"]);
  await enforceMemberGatesForChannel(env, Number(channel.id), Number(userId));
  return messageRow;
}

async function pollRowFor(env, messageId) {
  const row = await env.GOOBER_DB.prepare(POLL_READ_SQL)
    .bind(Number(messageId)).first();
  if (!row) throw new HttpError(404, "That message carries no poll.");
  return row;
}

// The mutation echo's re-shape: the row re-selects through MESSAGE_SELECT
// (the history page's own select — the DO fan-out's same shape), the
// poll's payload rides the additive 4th publicMessage arm.
async function publicMessageWithPoll(env, viewerId, messageId) {
  const row = await env.GOOBER_DB.prepare(
    MESSAGE_SELECT + " WHERE m.id = ? LIMIT 1",
  ).bind(nowSeconds(), Number(messageId)).first();
  if (!row) throw new HttpError(404, "Message not found.");
  const payload = new Map();
  await appendPollPayloads(env, viewerId, [Number(messageId)], payload);
  return publicMessage(row, [], null, payload.get(Number(messageId)) ?? null);
}

// castPollVote(env, userId, channelId, messageId, rawChoices): the shared
// mutation both transports walk. The poll must be open (a closed poll's
// claim never changes); single/multi is the ROW's own law; the UPSERT
// replaces the claim. The `channelId` argument is the caller's carried
// channel id (the REST path's segment or the DO's attached room) — a
// mismatch with the message's own channel 404s, never a cross-channel
// cast.
export async function castPollVote(env, userId, channelId, messageId, rawChoices) {
  const choices = Array.isArray(rawChoices)
    ? voteIntake({ choices: rawChoices })
    : voteIntake(rawChoices);
  const messageRow = await pollGate(env, messageId, userId);
  if (Number(messageRow.channel_id) !== Number(channelId)) {
    throw new HttpError(404, "Message not found.");
  }
  const poll = await pollRowFor(env, messageId);
  if (poll.closed_at !== null) throw new HttpError(400, "That poll has closed.");
  const options = JSON.parse(poll.options_json);
  for (const choice of choices) {
    if (!Number.isSafeInteger(choice) || choice < 0 || choice >= options.length) {
      throw new HttpError(400, "Every choice is an option index.");
    }
  }
  const multiple = Number(poll.multiple) === 1;
  if (!multiple && choices.length > 1) {
    throw new HttpError(400, "A single-choice vote is exactly one choice.");
  }
  const now = nowSeconds();
  await env.GOOBER_DB.prepare(POLL_VOTE_UPSERT_SQL).bind(
    Number(poll.id), Number(userId), JSON.stringify(choices), now, now,
  ).run();
  return { message: await publicMessageWithPoll(env, Number(userId), messageId) };
}

// closePoll(env, userId, channelId, messageId): the creator's close — the
// authority rides INSIDE the statement (the message's own author). An
// already-closed poll's second close by its creator is an idempotent
// no-op echo; a non-creator's arm never had the authority — the
// already-read row classifies the zero-changes path (an unclosed poll's
// zero changes is the refusal, no second oracle).
export async function closePoll(env, userId, channelId, messageId) {
  const messageRow = await pollGate(env, messageId, userId);
  if (Number(messageRow.channel_id) !== Number(channelId)) {
    throw new HttpError(404, "Message not found.");
  }
  const poll = await pollRowFor(env, messageId);
  const result = await env.GOOBER_DB.prepare(POLL_CLOSE_SQL).bind(
    nowSeconds(), Number(userId), Number(poll.id), Number(userId),
  ).run();
  if (Number(result.meta?.changes) !== 1 && poll.closed_at === null) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  return { message: await publicMessageWithPoll(env, Number(userId), messageId) };
}

// The REST arms (the client's own echo — the DO frames fan out to
// everyone ELSE, exactly as the send transport's split rides).
async function handlePollVoteRoute(request, env, channelId, messageId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "message", "user:" + userId);
  const choices = voteIntake(await readJson(request));
  const result = await castPollVote(env, userId, channelId, messageId, choices);
  return json({ message: result.message }, 200);
}

async function handlePollCloseRoute(request, env, channelId, messageId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "message", "user:" + userId);
  const result = await closePoll(env, userId, channelId, messageId);
  return json({ message: result.message }, 200);
}

export async function handleMessagesPollsRoutes(request, env, url, path, method) {
  void url;

  const voteMatch = method === "POST"
    ? path.match(/^\/api\/channels\/([1-9][0-9]{0,14})\/messages\/([1-9][0-9]{0,14})\/poll\/vote$/)
    : null;
  if (voteMatch) {
    return handlePollVoteRoute(
      request, env, Number(voteMatch[1]), Number(voteMatch[2]),
    );
  }

  const closeMatch = method === "POST"
    ? path.match(/^\/api\/channels\/([1-9][0-9]{0,14})\/messages\/([1-9][0-9]{0,14})\/poll\/close$/)
    : null;
  if (closeMatch) {
    return handlePollCloseRoute(
      request, env, Number(closeMatch[1]), Number(closeMatch[2]),
    );
  }

  return undefined;
}
