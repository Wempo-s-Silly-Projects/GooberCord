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

// Daily quests (recode lane, 2026-11-18). Three quests derive from the day
// the member already earned: message earn rows (the economy re-rule's msg
// earn 2-3), voice-presence ticks, and the day's total earn. LAZY DESIGN:
// progress is COUNTED from gc_coin_ledger's existing earn rows, so the lane
// adds NO table and NO migration (the 0052 slot stays empty) and no other
// module's write path is touched.
//
// ECONOMY (the re-rule's no-mint-inflation law): the quest claim is the
// claim — the flat 25, minted into the DAILY slot (source 'daily'), gated
// on finishing the day's three quests, once per UTC day, SHARED with the
// shop's claim (one NOT EXISTS pair; whichever door fires first wins and
// the other answers the duplicate). Every arm rides INSIDE the INSERT —
// the once-per-day pair, the three completion counts, and the caller's
// OWN daily ceiling — so a race, a replay, or a farm loop can never mint
// a row the plain claim could not have minted. The shop's plain claim
// stays untouched as the fallback door.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { plusPerkActive } from "./plus.mjs";
import {
  GC_COIN_DAILY_CEILING,
  GC_COIN_DAILY_GRANT,
  GC_PLUS_DAILY_CEILING,
  GC_QUEST_CLAIM,
  GC_QUEST_GOAL_EARNED,
  GC_QUEST_GOAL_MESSAGES,
  GC_QUEST_GOAL_VOICE,
} from "../constants.mjs";

// UTC day floor — the same boundary coins.mjs rides: "today" is one thing
// everywhere.
function dayFloor(now) {
  return now - (now % 86400);
}

// The one self-scoped read: the day's three progress counts and the
// claim-state pair. Eight binds, textual order: user, day (message),
// user, day (voice), user, day (earned), user, day (claimed).
const QUEST_DAY_READ_SQL =
  "SELECT " +
    "(SELECT COUNT(*) FROM gc_coin_ledger lm WHERE lm.user_id = ? AND lm.source = 'message' " +
      "AND lm.created_at >= ?) AS messages, " +
    "(SELECT COUNT(*) FROM gc_coin_ledger lv WHERE lv.user_id = ? AND lv.source = 'voice' " +
      "AND lv.created_at >= ?) AS voice, " +
    "(SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le WHERE le.user_id = ? " +
      "AND le.created_at >= ? AND le.delta > 0) AS earned, " +
    "EXISTS (SELECT 1 FROM gc_coin_ledger lq WHERE lq.user_id = ? AND lq.source = 'daily' " +
      "AND lq.created_at >= ?) AS claimed";

// The claim mint. The goals ride as bound values and their own arms, so a
// replay that races a rollback can never mint past completion; the
// not-exists pair is the SAME daily slot the shop claim's statement
// guards, and the ceiling is the caller's own tier. Eighteen binds,
// textual order: user, grant, now | user, day (not-exists) | user, day,
// message goal | user, day, voice goal | user, day, earn goal | user,
// day, grant, ceiling (the ceiling arm's sum).
const QUEST_CLAIM_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'daily', ? " +
  "WHERE NOT EXISTS (" +
    "SELECT 1 FROM gc_coin_ledger ld WHERE ld.user_id = ? AND ld.source = 'daily' " +
    "AND ld.created_at >= ?) " +
  "AND (" +
    "SELECT COUNT(*) FROM gc_coin_ledger lm WHERE lm.user_id = ? AND lm.source = 'message' " +
    "AND lm.created_at >= ?) >= ? " +
  "AND (" +
    "SELECT COUNT(*) FROM gc_coin_ledger lv WHERE lv.user_id = ? AND lv.source = 'voice' " +
    "AND lv.created_at >= ?) >= ? " +
  "AND (" +
    "SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le WHERE le.user_id = ? " +
    "AND le.created_at >= ? AND le.delta > 0) >= ? " +
  "AND (" +
    "SELECT COALESCE(SUM(lc.delta), 0) FROM gc_coin_ledger lc WHERE lc.user_id = ? " +
    "AND lc.created_at >= ? AND lc.delta > 0) + ? <= ? LIMIT 1";

// Quest goals are constants, never stored — a rebalance is a
// constants.mjs change, never a table rewrite.
const GOALS = [
  { kind: "message", goal: GC_QUEST_GOAL_MESSAGES, count: "messages" },
  { kind: "voice", goal: GC_QUEST_GOAL_VOICE, count: "voice" },
  { kind: "earn", goal: GC_QUEST_GOAL_EARNED, count: "earned" },
];

function questPayload(row) {
  return GOALS.map((entry) => {
    const progress = Math.min(Number(row?.[entry.count]) || 0, entry.goal);
    return { kind: entry.kind, goal: entry.goal, progress, complete: progress >= entry.goal };
  });
}

async function handleQuestDayReadRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "quests:day:" + userId);

  const now = nowSeconds();
  const row = await env.GOOBER_DB.prepare(QUEST_DAY_READ_SQL)
    .bind(userId, dayFloor(now), userId, dayFloor(now), userId, dayFloor(now), userId, dayFloor(now))
    .first();

  return json({
    day: dayFloor(now),
    quests: questPayload(row),
    claim: { claimed: Number(row?.claimed) === 1, reward: GC_QUEST_CLAIM },
  });
}

async function handleQuestClaimRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "quests:claim:" + userId);

  const now = nowSeconds();
  const today = dayFloor(now);
  const perks = await plusPerkActive(env, userId, now);
  const ceiling = perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING;

  // The classification reads are self-scoped; the INSERT is the one
  // statement whose arms answer every race. changes-1 the claim; changes-0
  // (after a not-claimed-read and a complete read — the ceiling bound and
  // same-door races both land here) answers the standing claim copy.
  const row = await env.GOOBER_DB.prepare(QUEST_DAY_READ_SQL)
    .bind(userId, today, userId, today, userId, today, userId, today).first();
  if (Number(row?.claimed) === 1) {
    throw new HttpError(409, "Already claimed today. Come back tomorrow.");
  }
  if (!questPayload(row).every((quest) => quest.complete)) {
    throw new HttpError(400, "Finish today's quests before claiming.");
  }

  const result = await env.GOOBER_DB.prepare(QUEST_CLAIM_SQL)
    .bind(
      userId, GC_COIN_DAILY_GRANT, now,
      userId, today,
      userId, today, GC_QUEST_GOAL_MESSAGES,
      userId, today, GC_QUEST_GOAL_VOICE,
      userId, today, GC_QUEST_GOAL_EARNED,
      userId, today, GC_COIN_DAILY_GRANT, ceiling,
    )
    .run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(409, "Already claimed today. Come back tomorrow.");
  }

  return json({ claim: { claimed: true, reward: GC_COIN_DAILY_GRANT } });
}

// --- dispatch ---------------------------------------------------------------------

//   GET  /api/quests        → the day's quests + the claim state
//   POST /api/quests/claim  → the completed day's claim (the flat 25, daily slot)
export async function handleQuestRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  if (path === "/api/quests" && method === "GET") {
    return handleQuestDayReadRoute(request, env);
  }
  if (path === "/api/quests/claim" && method === "POST") {
    return handleQuestClaimRoute(request, env);
  }

  return undefined;
}
