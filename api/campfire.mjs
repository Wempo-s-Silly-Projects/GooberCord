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

// T76: the Campfire (docs/drafts/t76-economy-slate-spec.md §2) — the server-
// wide meter, the shared pool, and ZERO ranking. The fire is a PURE sink:
//   * the pool only ever receives coins that already left circulation (stokes,
//     chain fees — every credit statement is its own cap arm);
//   * the coin draw pays out no more than the pool holds (pool-funded
//     redistribution, never new mint) and every payout statement is
//     pool-guarded; the pool column's CHECK (pool >= 0) is the batch's loud
//     backstop — a draw that runs the pool dry aborts wholesale;
//   * a short pool answers the banner path instead — fuel returns to 0 and
//     not ONE coin moves;
//   * fuel accrual is server-keyed and anonymous by construction (the fuel
//     statement keys on gc_campfires.server_id, never the member).
// Reads answer the no-ranking shape only: fuel, threshold, pool, banner
// window, last draw. No per-member attribution, no top-list, no ledger
// exposure — the fire is the server's.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_CAMPFIRE_BANNER_HOURS,
  GC_CAMPFIRE_DRAW_GAP_SECONDS,
  GC_CAMPFIRE_DRAW_ONLINE_BONUS,
  GC_CAMPFIRE_FUEL_DAILY_CAP,
  GC_CAMPFIRE_FUEL_THRESHOLD,
  GC_CAMPFIRE_MAX_POOL,
  GC_CAMPFIRE_STOKE_MAX,
} from "../constants.mjs";
import { PRESENCE_HUB_NAME } from "./presence.mjs";
import { recordJobProgress } from "./jobs.mjs";

const CAMPFIRE_DAY = 86400;

// The fuel accrual rider (grantCampfireFuel): ONE upsert, the day's own cap
// riding the DO UPDATE's WHERE arm — the fuel counter resets with its
// fuel_today_day seat, so a stale day's count never caps a fresh one. The
// statement keys on the server and nothing else: fuel carries no member
// identity, even in the schema.
const FUEL_ACCRUAL_SQL =
  "INSERT INTO gc_campfires (server_id, fuel, pool, fuel_today, fuel_today_day, updated_at) " +
    "VALUES (?, 1, 0, 1, ?, ?) " +
  "ON CONFLICT (server_id) DO UPDATE SET " +
    "fuel = gc_campfires.fuel + 1, " +
    "fuel_today = (CASE WHEN gc_campfires.fuel_today_day = ? THEN gc_campfires.fuel_today ELSE 0 END) + 1, " +
    "fuel_today_day = ?, " +
    "updated_at = ? " +
  "WHERE (CASE WHEN gc_campfires.fuel_today_day = ? THEN gc_campfires.fuel_today ELSE 0 END) + 1 <= ?";

// The stoke pair (the ONLY member-named surface the Campfire has, and even
// it stays ledger-anonymous): the spend statement carries BOTH guards inside
// — the sufficient-coins arm AND the pool-cap arm (a credit at the cap burns,
// so refusing the stoke is the honest answer) — then the pool credit upserts
// in the SAME batch. The SINK law in one line: no statement mints a pool
// coin the ledger never spent.
const STOKE_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
    "SELECT ?, ?, 'campfire_stoke', ? " +
    "WHERE (SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
      "WHERE le.user_id = ?) >= ? " +
    "AND COALESCE((SELECT cf.pool FROM gc_campfires cf WHERE cf.server_id = ?), 0) + ? <= " +
      GC_CAMPFIRE_MAX_POOL;

const POOL_CREDIT_UPSERT_SQL =
  "INSERT INTO gc_campfires (server_id, fuel, pool, updated_at) " +
    "VALUES (?, 0, ?, ?) " +
  "ON CONFLICT (server_id) DO UPDATE SET " +
    "pool = MIN(gc_campfires.pool + ?, " + GC_CAMPFIRE_MAX_POOL + "), " +
    "updated_at = ?";

// The one read the member gate and the shape answer share.
const CAMPFIRE_ROW_READ_SQL =
  "SELECT fuel, pool, bonus_until, last_draw_at FROM gc_campfires WHERE server_id = ? LIMIT 1";
const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The draw's read shape: fuel reset + last_draw + the banner window, or the
// pool-funded payouts + the decrement, all in one all-or-nothing batch. A
// payout that finds the pool short leaves the batch (the CHECK backstop) and
// the caller classifies after the fact.
const DRAW_BANNER_SQL =
  "UPDATE gc_campfires SET " +
    "fuel = 0, last_draw_at = ?, bonus_until = ?, updated_at = ? " +
  "WHERE server_id = ? AND fuel >= " + GC_CAMPFIRE_FUEL_THRESHOLD + " " +
    "AND (last_draw_at IS NULL OR last_draw_at <= ?)";

// The draw's shape (spec §2 line 90 — `pool -= paid in the same motion`).
// The CLAIM is ONE guarded statement (the compensated-create precedent): the
// pool debit, the fuel reset, and the draw gap all ride its WHERE, so a
// racing second draw finds fuel 0 and answers changes 0 BEFORE any payout
// commits. The payouts follow, each fingerprinted to THE claim's
// last_draw_at seat — a payout can only mint inside the draw that won — and
// the verdict walk refunds exactly the seats that could not mint (a member
// who left mid-draw never burns their coin: the pool takes it back, the
// ledger never shows a paid coin the pool did not debit).
const DRAW_CLAIM_SQL =
  "UPDATE gc_campfires SET " +
    "pool = pool - ?, fuel = 0, last_draw_at = ?, updated_at = ? " +
  "WHERE server_id = ? AND pool >= ? AND fuel >= " + GC_CAMPFIRE_FUEL_THRESHOLD + " " +
    "AND (last_draw_at IS NULL OR last_draw_at <= ?)";

const DRAW_PAYOUT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
    "SELECT ?, ?, 'campfire', ? " +
    "WHERE EXISTS (SELECT 1 FROM gc_server_members om " +
      "WHERE om.server_id = ? AND om.user_id = ?) " +
    "AND EXISTS (SELECT 1 FROM gc_campfires cf " +
      "WHERE cf.server_id = ? AND cf.last_draw_at = ?)";

const DRAW_SEAT_REFUND_SQL =
  "UPDATE gc_campfires SET " +
    "pool = pool + ?, updated_at = ? " +
  "WHERE server_id = ? AND last_draw_at = ?";

// The thrown-payout-batch refund: the debit banked but no coin paid, so the
// claim reverses — the pool gets its whole debit back AND the fire gets the
// fuel the draw consumed back (the fire never burned for a crashed payout).
const DRAW_CLAIM_REVERSAL_SQL =
  "UPDATE gc_campfires SET " +
    "pool = pool + ?, fuel = " + GC_CAMPFIRE_FUEL_THRESHOLD + ", " +
    "last_draw_at = ?, updated_at = ? " +
  "WHERE server_id = ? AND last_draw_at = ?";

const ROSTER_READ_SQL =
  "SELECT user_id FROM gc_server_members WHERE server_id = ?";

// The pool credit primitive (api/coins.mjs's chain lane calls it for the
// chain fee — the Campfire's second credit). Same upsert, same cap arm.

// --- grants ------------------------------------------------------------------

export async function grantCampfireFuel(env, serverId, now) {
  const dayStart = now - (now % CAMPFIRE_DAY);
  const result = await env.GOOBER_DB.prepare(FUEL_ACCRUAL_SQL).bind(
    serverId, dayStart, now,
    dayStart, dayStart, now,
    dayStart, GC_CAMPFIRE_FUEL_DAILY_CAP,
  ).run();
  return Number(result.meta?.changes) === 1;
}

// The pool credit the chain fee rides. Returns the statement — the CALLER
// binds it INTO its own batch (the fee and its credit move together), so the
// Campfire module ships the shape, never a free-running write.
export function campfirePoolCreditStatement(db, serverId, amount, now, fingerprint = null) {
  const fpSeat = fingerprint ? " WHERE " + fingerprint.sql : "";
  const fpBinds = fingerprint ? fingerprint.binds : [];
  return db.prepare(
    "INSERT INTO gc_campfires (server_id, fuel, pool, updated_at) " +
      "SELECT ?, 0, ?, ?" + fpSeat + " " +
    "ON CONFLICT (server_id) DO UPDATE SET " +
      "pool = MIN(gc_campfires.pool + ?, " + GC_CAMPFIRE_MAX_POOL + "), " +
      "updated_at = ?" + (fingerprint ? " WHERE " + fingerprint.sql : ""),
  ).bind(
    serverId, amount, now, ...fpBinds,
    amount, now, ...(fingerprint ? fpBinds : []),
  );
}

function publicCampfire(row, now2) {
  return {
    fuel: Number(row?.fuel) || 0,
    threshold: GC_CAMPFIRE_FUEL_THRESHOLD,
    pool: Number(row?.pool) || 0,
    bannerUntil: row?.bonus_until === null || row?.bonus_until === undefined
      ? null
      : Number(row.bonus_until),
    lastDrawAt: row?.last_draw_at === null || row?.last_draw_at === undefined
      ? null
      : Number(row.last_draw_at),
    bannerActive: row?.bonus_until !== null && row?.bonus_until !== undefined &&
      Number(row.bonus_until) > now2,
  };
}

// The presence lane's roster crossing: the hub snapshot carries userId per
// online member; the fire counts the ONLINE MEMBERS OF THIS SERVER by
// intersecting the snapshot with gc_server_members. No names ride anywhere —
// the count is a number and stays one. Exported for the Goober Jobs lane's
// finish step (T86): the member share splits across THESE members, the same
// privacy-shape intersection.
export async function onlineServerMembers(env, serverId) {
  if (!env.PRESENCE) return [];
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_HUB_NAME));
  const response = await stub.fetch(
    new Request("https://presence.internal/hub", {
      method: "POST",
      body: JSON.stringify({ type: "list" }),
    }),
  );
  const payload = await response.json().catch(() => ({ online: [] }));
  const onlineIds = new Set((Array.isArray(payload?.online) ? payload.online : [])
    .map((entry) => Number(entry?.userId))
    .filter((id) => Number.isInteger(id) && id > 0));
  const roster = (await env.GOOBER_DB.prepare(ROSTER_READ_SQL).bind(serverId).all()).results || [];
  return roster.map((row) => Number(row.user_id)).filter((id) => onlineIds.has(id));
}

// The draw's evaluation (spec §2): on the read, when fuel crosses the
// threshold and the gap arm stands. The CLAIM debits the pool and claims the
// draw in ONE guarded statement (its changes verdict answers the race — a
// losing draw never commits a payout); then the fingerprinted payouts mint
// exactly the debit's coins. failures swallow — a draw miss only delays the
// fire.
async function evaluateCampfireDraw(env, serverId, row, now2) {
  if ((Number(row?.fuel) || 0) < GC_CAMPFIRE_FUEL_THRESHOLD) return null;
  const lastDrawAt = row?.last_draw_at === null || row?.last_draw_at === undefined
    ? null
    : Number(row.last_draw_at);
  if (lastDrawAt !== null && lastDrawAt > now2 - GC_CAMPFIRE_DRAW_GAP_SECONDS) return null;

  const online = await onlineServerMembers(env, serverId).catch(() => []);
  const pool = Number(row?.pool) || 0;
  const cost = online.length * GC_CAMPFIRE_DRAW_ONLINE_BONUS;
  const db = env.GOOBER_DB;
  if (online.length > 0 && pool >= cost) {
    // THE claim: debit + fuel reset + gap in one WHERE. changes 0 = another
    // draw won (or the row moved since the read) — answer nothing, commit
    // nothing.
    const claim = await db.prepare(DRAW_CLAIM_SQL).bind(
      cost, now2, now2, serverId, cost, now2 - GC_CAMPFIRE_DRAW_GAP_SECONDS,
    ).run();
    if (Number(claim.meta?.changes) !== 1) return null;
    let results;
    try {
      // The payouts: each fingerprinted to THIS claim's last_draw_at — mint
      // exactly the debit's coins, never a second seat's worth.
      results = await db.batch(online.map((memberId) =>
        db.prepare(DRAW_PAYOUT_SQL).bind(
          memberId, GC_CAMPFIRE_DRAW_ONLINE_BONUS, now2,
          serverId, memberId,
          serverId, now2,
        )));
    } catch (error) {
      // The payout batch aborted: reverse the claim wholesale (pool AND fuel
      // back), so a crashed draw neither burns nor double-pays.
      await db.prepare(DRAW_CLAIM_REVERSAL_SQL).bind(
        cost, lastDrawAt, now2, serverId, now2,
      ).catch(() => { /* the reversal is best-effort */ });
      throw error;
    }
    // The verdict walk: a seat whose mint lost its membership (a member who
    // left mid-draw) refunds ITS bonus to the pool — conservation holds
    // (minted == paid == debited minus refunded), never a free coin.
    const mintedSeats = results.filter((seat) => Number(seat?.meta?.changes) === 1).length;
    const missedSeats = online.length - mintedSeats;
    if (missedSeats > 0) {
      await db.prepare(DRAW_SEAT_REFUND_SQL).bind(
        missedSeats * GC_CAMPFIRE_DRAW_ONLINE_BONUS, now2, serverId, now2,
      ).catch(() => { /* a missed refund only delays the fire */ });
    }
    return null;
  }
  return db.prepare(DRAW_BANNER_SQL).bind(
    now2, now2 + GC_CAMPFIRE_BANNER_HOURS * 3600, now2,
    serverId, now2 - GC_CAMPFIRE_DRAW_GAP_SECONDS,
  ).run();
}

// The shared member gate (both routes): non-members share the unknown-server
// 404 — no server-existence oracle.
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

export async function handleCampfireRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const stokeMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/campfire\/stoke$/)
    : null;
  if (stokeMatch) {
    const serverId = Number(stokeMatch[1]);
    return handleCampfireStokeRoute(request, env, serverId);
  }

  const readMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/campfire$/)
    : null;
  if (readMatch) {
    const serverId = Number(readMatch[1]);
    return handleCampfireReadRoute(request, env, serverId);
  }

  return undefined;
}

// GET /api/servers/:id/campfire — members only, the no-ranking shape ONLY.
async function handleCampfireReadRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "campfire:read:" + serverId + ":" + userId);
  const now2 = nowSeconds();
  const row = await env.GOOBER_DB.prepare(CAMPFIRE_ROW_READ_SQL).bind(serverId).first();
  await evaluateCampfireDraw(env, serverId, row, now2).catch(() => {
    /* a draw miss only delays the fire */
  });
  const fresh = await env.GOOBER_DB.prepare(CAMPFIRE_ROW_READ_SQL).bind(serverId).first();
  return json(publicCampfire(fresh ?? row, now2));
}

// POST /api/servers/:id/campfire/stoke { amount } — one batch: the paid spend
// (coins arm + pool-cap arm inside) and the pool credit upsert. Either
// statement refusing is the same "not today" answer — the batch is atomic, so
// nothing partial rides.
async function handleCampfireStokeRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "write", "campfire:stoke:" + serverId + ":" + userId);
  const body = await readJson(request);
  const amount = body && body.amount;
  if (!Number.isInteger(amount) || amount < 1 || amount > GC_CAMPFIRE_STOKE_MAX) {
    throw new HttpError(400, "That stoke amount is invalid.");
  }

  const now2 = nowSeconds();
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(STOKE_SPEND_SQL).bind(
      userId, -amount, now2,
      userId,
      amount,
      serverId, amount,
    ),
    env.GOOBER_DB.prepare(POOL_CREDIT_UPSERT_SQL).bind(
      serverId, amount, now2, amount, now2,
    ),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) {
    throw new HttpError(400, "Not enough Goober Coins for that.");
  }
  const row = await env.GOOBER_DB.prepare(CAMPFIRE_ROW_READ_SQL).bind(serverId).first();
  // The Goober Jobs stoke rider (T86): a landed stoke is the 'stoke' chore.
  // Best-effort, like every hook — a jobs miss only delays the finish, never
  // the stoke's own batch (which has already committed above).
  await recordJobProgress(env, serverId, "stoke", 1, now2).catch(() => {
    /* a jobs miss only delays the finish */
  });
  const fresh = await env.GOOBER_DB.prepare(CAMPFIRE_ROW_READ_SQL).bind(serverId).first();
  return json({ stoked: true, amount, ...publicCampfire(fresh ?? row, now2) });
}
