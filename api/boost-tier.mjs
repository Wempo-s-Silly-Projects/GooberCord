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

// Boost tier (wave-12): ONE additive read that gives the 0023 matrix its
// face. The route rides api/boost-level.mjs's own resolver (serverBoostTier,
// the ONE shared lookup the caps already read — zero new resolver logic, zero
// new SQL beyond the resolver's recount-trueful PK read) and derives only the
// next floor the panel paints progress against:
//   * nextLevel: GC_BOOST_LEVELS ascending, the first entry whose floor sits
//     ABOVE the server's current boosts — level 0 answers the level-1 entry
//     (2 boosts); L3 (the 14-boost floor and every count past it) answers
//     null, and the panel paints the top level instead of a bar;
//   * levelPerks rides the resolver's own null-entry law (level 0 answers
//     null) and the full level entry otherwise — as-is, never rewritten;
//   * caps ride the resolver's max-of-base-and-level shape untouched (a
//     level can never LOWER an inventory);
//   * the sink law and the privacy surface: the route reads ONLY
//     gc_server_members (the shared membership gate) and the boosts column —
//     no write arm exists anywhere in the module.
import { requireUser } from "./core/auth.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { GC_BOOST_LEVELS } from "../constants.mjs";
import { serverBoostTier } from "./boost-level.mjs";

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The shared unknown-server 404 body: non-member, unknown id, and wrong
// server are indistinguishable to the asker (no existence oracle) —
// welcome-card.mjs's exact idiom.
const SHARED_UNKNOWN_404 = "This server does not exist or you cannot view it.";

async function memberGate(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) throw new HttpError(404, SHARED_UNKNOWN_404);
  return userId;
}

// The next floor above the server's current boosts. GC_BOOST_LEVELS is
// ordered ascending, so the first strictly-greater floor is the answer; a
// level-0 server answers the level-1 entry, and a floor-holding count (L3's
// 14 and every count past it) answers null.
function nextLevelFor(boosts) {
  return GC_BOOST_LEVELS.find((entry) => Number(entry.boosts) > boosts) ?? null;
}

// GET /api/servers/:id/boost-tier — the member's tier read. Membership gates
// the whole route, the read-rate wall keys server + member, and the payload
// rides the resolver verbatim plus the derived next floor. Every number the
// panel paints traces to this payload — the client mirrors nothing.
async function handleBoostTierGetRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "boost-tier:" + serverId + ":" + userId);
  const tier = await serverBoostTier(env, serverId);
  return json({
    boosts: tier.boosts,
    level: tier.level,
    caps: tier.caps,
    levelPerks: tier.levelPerks,
    nextLevel: nextLevelFor(tier.boosts),
  });
}

export async function handleBoostTierRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const tierMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/boost-tier$/)
    : null;
  if (!tierMatch) return undefined;
  return handleBoostTierGetRoute(request, env, Number(tierMatch[1]));
}
