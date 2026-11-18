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

// T83: Goober of the Day (docs/drafts/t83-goober-of-the-day-spec.md) — the
// per-server spotlight. Kindness as a game; a gift, NOT a ladder. The laws
// the module encodes:
//   * one vote per member per day is the votes PK itself (the INSERT's
//     ON CONFLICT DO NOTHING + its changes verdict are the 409 answer);
//   * anonymity: the ballot mapping is NEVER a read surface — no statement
//     SELECTs who voted for whom, during the window OR after it. The CARD
//     (the tallied winner of a completed day) is the only reveal;
//   * per-server visibility: every statement carries the server seat INSIDE
//     its own WHERE — nothing aggregates across servers, and no ladder
//     route exists;
//   * roll-over has ZERO timers: it is a pure date-key comparison at read
//     time, and the completed day's card is written lazily ONCE (guarded
//     ON CONFLICT DO NOTHING + changes verdict — a racing pair of readers
//     writes one card and both answer the identical winner);
//   * candidacy is default-in per the slate with an explicit opt-OUT
//     toggle; the opt-out arm rides INSIDE the winner pick's SQL, so an
//     opted-out member can never be painted;
//   * the winner's tagline slot is a FREE gift lane — nothing mints,
//     nothing sinks; only the CURRENTLY CARD member of THIS server writes.
//   * caps from constants.mjs only.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_GOOBER_DAY_MIN_VOTES_FOR_CARD,
  GC_GOOBER_DAY_SECONDS,
  GC_GOOBER_DAY_TAGLINE_MAX,
} from "../constants.mjs";

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The votee's eligibility: a member of THIS server (the 404 shape if not).
const VOTEE_MEMBER_READ_SQL =
  "SELECT 1 FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// A non-candidate is the same unknown shape to the vote route (candidacy is
// not published — the vote never explains WHY a member is not on the ballot).
const TARGET_OPTOUT_READ_SQL =
  "SELECT 1 FROM gc_goober_optouts WHERE server_id = ? AND user_id = ? LIMIT 1";

// The caller's own candidacy state (the toggle panel's one-row read).
const OWN_OPTOUT_READ_SQL =
  "SELECT user_id FROM gc_goober_optouts WHERE server_id = ? AND user_id = ? LIMIT 1";

// The caller's OWN one-row vote check — the ONLY voter-keyed read the lane
// has (the caller's own "did I vote"), never anyone else's.
const OWN_VOTE_READ_SQL =
  "SELECT 1 FROM gc_goober_votes WHERE server_id = ? AND day_key = ? AND voter_id = ? LIMIT 1";

// The vote: one vote per member per server per day — the PK's own conflict
// arm, its changes verdict the 409 answer.
const VOTE_INSERT_SQL =
  "INSERT INTO gc_goober_votes (server_id, day_key, voter_id, votee_id, created_at) " +
    "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT (server_id, day_key, voter_id) DO NOTHING";

const OPTOUT_UPSERT_SQL =
  "INSERT INTO gc_goober_optouts (server_id, user_id, updated_at) " +
    "VALUES (?, ?, ?) " +
  "ON CONFLICT (server_id, user_id) DO UPDATE SET updated_at = ?";

const OPTOUT_DELETE_SQL =
  "DELETE FROM gc_goober_optouts WHERE server_id = ? AND user_id = ?";

// The winner pick: the completed day's tally, aggregated BY VOTEE only, with
// the opt-out filter riding INSIDE the SQL (a member who toggled out mid-day
// can never be painted even by votes already cast) and the deterministic
// tie-break (votes DESC, votee_id ASC) — the same key always answers the
// same Goober, forever. No LIMIT in-statement: the caller takes the first.
const WINNER_PICK_SQL =
  "SELECT votee_id, COUNT(*) AS votes FROM gc_goober_votes " +
    "WHERE server_id = ? AND day_key = ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_goober_optouts oo " +
      "WHERE oo.server_id = gc_goober_votes.server_id " +
      "AND oo.user_id = gc_goober_votes.votee_id) " +
    "GROUP BY votee_id ORDER BY votes DESC, votee_id ASC";

// The card of a completed day — the roll-over read's first stop.
const CARD_READ_SQL =
  "SELECT winner_id, votes_count, tagline FROM gc_goober_cards " +
    "WHERE server_id = ? AND day_key = ? LIMIT 1";

// The lazily written card: idempotent by the PK's DO NOTHING; the changes
// verdict answers the racer (which re-reads and answers the same winner).
const CARD_INSERT_SQL =
  "INSERT INTO gc_goober_cards (server_id, day_key, winner_id, votes_count) " +
    "VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (server_id, day_key) DO NOTHING";

// The winner's free tagline slot: ONLY the currently-card member of THIS
// server, ONLY for the CURRENT day card — all three seats inside the WHERE.
const TAGLINE_UPDATE_SQL =
  "UPDATE gc_goober_cards SET tagline = ? " +
    "WHERE server_id = ? AND day_key = ? AND winner_id = ?";

// The carded member's painted identity (name + avatar only — the card's
// whole human surface).
const CARD_MEMBER_READ_SQL =
  "SELECT id, username, avatar_status, avatar_mime, avatar_version " +
    "FROM users WHERE id = ? LIMIT 1";

function gooberOfDayCard(row, member) {
  return {
    id: Number(row.winner_id),
    name: member?.username ?? null,
    avatar: member?.avatar_mime
      ? "/api/avatars/" + Number(row.winner_id) + "?v=" + Number(member.avatar_version)
      : null,
    tagline: row.tagline ?? null,
    votesCount: Number(row.votes_count),
  };
}

// The shared member gate: non-members share the unknown-server 404 — no
// server-existence oracle.
async function memberGate(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return userId;
}

async function handleGooberDayVoteRoute(request, env, serverId, userId) {
  await rateLimit(request, env, "write", "goober-day:vote:" + serverId + ":" + userId);
  const payload = await readJson(request);
  const voteeId = payload?.voteeId;
  if (!Number.isInteger(voteeId) || voteeId < 1) {
    throw new HttpError(400, "That vote target is invalid.");
  }
  if (Number(voteeId) === userId) {
    throw new HttpError(400, "You cannot spotlight yourself.");
  }
  const now = nowSeconds();
  const todayKey = now - (now % GC_GOOBER_DAY_SECONDS);
  const voteeMember = await env.GOOBER_DB.prepare(VOTEE_MEMBER_READ_SQL)
    .bind(serverId, voteeId).first();
  if (!voteeMember) {
    throw new HttpError(404, "That member is not on today's ballot.");
  }
  const optedOut = await env.GOOBER_DB.prepare(TARGET_OPTOUT_READ_SQL)
    .bind(serverId, voteeId).first();
  if (optedOut) {
    throw new HttpError(404, "That member is not on today's ballot.");
  }
  const result = await env.GOOBER_DB.prepare(VOTE_INSERT_SQL).bind(
    serverId, todayKey, userId, voteeId, now,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(409, "You already voted today.");
  }
  return json({ voted: true, dayKey: todayKey }, 201);
}

async function handleGooberDayCandidacyRoute(request, env, serverId, userId) {
  await rateLimit(request, env, "write", "goober-day:candidacy:" + serverId + ":" + userId);
  const payload = await readJson(request);
  if (typeof payload?.optedOut !== "boolean") {
    throw new HttpError(400, "That candidacy toggle is invalid.");
  }
  const now = nowSeconds();
  if (payload.optedOut) {
    await env.GOOBER_DB.prepare(OPTOUT_UPSERT_SQL)
      .bind(serverId, userId, now, now).run();
    return json({ candidacy: "out" });
  }
  await env.GOOBER_DB.prepare(OPTOUT_DELETE_SQL)
    .bind(serverId, userId).run();
  return json({ candidacy: "in" });
}

async function handleGooberDayTodayRoute(request, env, serverId, userId) {
  await rateLimit(request, env, "read", "goober-day:today:" + serverId + ":" + userId);
  const now = nowSeconds();
  const todayKey = now - (now % GC_GOOBER_DAY_SECONDS);
  const completedKey = todayKey - GC_GOOBER_DAY_SECONDS;

  // Roll-over: the completed day's card — read first, computed lazily once,
  // and the SAME winner answers every reader of the same key.
  let card = await env.GOOBER_DB.prepare(CARD_READ_SQL)
    .bind(serverId, completedKey).first();
  if (!card) {
    const pick = (await env.GOOBER_DB.prepare(WINNER_PICK_SQL)
      .bind(serverId, completedKey).all()).results?.[0] || null;
    if (pick && Number(pick.votes) >= GC_GOOBER_DAY_MIN_VOTES_FOR_CARD) {
      await env.GOOBER_DB.prepare(CARD_INSERT_SQL).bind(
        serverId, completedKey, Number(pick.votee_id), Number(pick.votes),
      ).run();
      card = await env.GOOBER_DB.prepare(CARD_READ_SQL)
        .bind(serverId, completedKey).first();
    }
  }
  let goober = null;
  if (card) {
    const member = await env.GOOBER_DB.prepare(CARD_MEMBER_READ_SQL)
      .bind(Number(card.winner_id)).first();
    goober = gooberOfDayCard(card, member);
  }
  const votedRow = await env.GOOBER_DB.prepare(OWN_VOTE_READ_SQL)
    .bind(serverId, todayKey, userId).first();
  const optedOutRow = await env.GOOBER_DB.prepare(OWN_OPTOUT_READ_SQL)
    .bind(serverId, userId).first();
  return json({
    dayKey: todayKey,
    goober,
    votedToday: Boolean(votedRow),
    candidacy: optedOutRow ? "out" : "in",
  });
}

async function handleGooberDayTaglineRoute(request, env, serverId, userId) {
  await rateLimit(request, env, "write", "goober-day:tagline:" + serverId + ":" + userId);
  const payload = await readJson(request);
  let tagline = null;
  if (payload?.tagline !== null && payload?.tagline !== undefined) {
    if (typeof payload.tagline !== "string") {
      throw new HttpError(400, "That tagline is invalid.");
    }
    tagline = payload.tagline.trim();
    if (tagline.length < 1 || tagline.length > GC_GOOBER_DAY_TAGLINE_MAX) {
      throw new HttpError(400, "A tagline needs between 1 and 64 characters.");
    }
  }
  const now = nowSeconds();
  const todayKey = now - (now % GC_GOOBER_DAY_SECONDS);
  const result = await env.GOOBER_DB.prepare(TAGLINE_UPDATE_SQL).bind(
    tagline, serverId, todayKey, userId,
  ).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, "No day card of yours is up right now.");
  }
  return json({ tagline });
}

export async function handleGooberDayRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const serverMatch = path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/goober(?:\/([a-z]+))?$/);
  if (serverMatch) {
    const serverId = Number(serverMatch[1]);
    const seat = serverMatch[2] || "";
    if (method === "POST" && seat === "vote") {
      const userId = await memberGate(request, env, serverId);
      return handleGooberDayVoteRoute(request, env, serverId, userId);
    }
    if (method === "POST" && seat === "candidacy") {
      const userId = await memberGate(request, env, serverId);
      return handleGooberDayCandidacyRoute(request, env, serverId, userId);
    }
    if (method === "GET" && seat === "today") {
      const userId = await memberGate(request, env, serverId);
      return handleGooberDayTodayRoute(request, env, serverId, userId);
    }
    if (method === "POST" && seat === "tagline") {
      const userId = await memberGate(request, env, serverId);
      return handleGooberDayTaglineRoute(request, env, serverId, userId);
    }
    return undefined;
  }

  return undefined;
}
