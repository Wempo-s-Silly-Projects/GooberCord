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

// T-R25-SPLIT-COINS-2: the Goober+ purchase family's home (the second
// family off api/coins.mjs). The plus pair answers here verbatim: the
// coin spend (PLUS_SPEND_SQL) + the fingerprinted term upsert
// (PLUS_TERM_UPSERT_SQL), the gift target read (GIFT_TARGET_READ_SQL),
// the three handlers (renew / purchasePlusTerm / gift), and the two
// router arms (the dispatcher's tail pair, contiguous). The forward in
// coins.mjs sits at the renew arm's ORIGINAL position with an
// `undefined` fall-through — route order is semantically byte-unchanged.
//
// The plus reads + fingerprint machinery the coins snapshot shares
// (PLUS_READ_SQL / publicPlus / SPEND_NONCE_BYTES / BALANCE_READ_SQL)
// stay ONE implementation in coins.mjs, imported at CALL time (the
// circular import stays inert — every use lives inside a function body,
// the T-R25-SPLIT-SERVERS-1 lesson). The GC_PLUS_*/GC_MINI_* law
// constants keep their home in constants.mjs.

import { requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";

import {
  GC_PLUS_PRICE,
  GC_PLUS_RENEWAL_PRICE,
  GC_PLUS_TERM_DAYS,
  GC_MINI_PRICE,
  GC_MINI_RENEWAL_PRICE,
} from "../constants.mjs";
import { isValidUsername } from "./usernames.mjs";

import {
  PLUS_READ_SQL,
  publicPlus,
  SPEND_NONCE_BYTES,
  BALANCE_READ_SQL,
} from "./coins.mjs";

// --- the moved region (verbatim out of api/coins.mjs @ 2207501) --------

// The Goober+ coin spend (shared by the renewal and the gift): one negative
// row under the sufficient-coins arm — the check IS the statement, so two
// racing purchases can never both clear a one-purchase balance.
const PLUS_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at, spend_nonce) " +
  "SELECT ?, ?, ?, ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM users rp WHERE rp.id = ?) " +
  "AND (SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ?) >= ? LIMIT 1";
// The term upsert, conditioned on the spend row THIS batch minted (the
// fingerprint arm rides the INSERT's SELECT, so a skipped spend can never
// extend a term). The fingerprint matches on the spend's OWN nonce (0058) —
// a same-second repeat purchase can never satisfy it with the earlier
// spend's row, so a refused batch never extends a term for free.
const PLUS_TERM_UPSERT_SQL =
  "INSERT INTO gc_plus_state (user_id, renews_until, grace_until, tenure_started_at, gifted_by, updated_at, tier) " +
  // The MAX(...) + ? arm is ONE expression; the SELECT list carries exactly
  // seven values for the seven columns — the tier's ? was MISSING until
  // GO-HAYWIRE cycle-2 fix 1 (the fakeDb tests never prepared this
  // statement against a real SQLite engine; node:sqlite refused the
  // 6-for-7 count at prepare and the real-sqlite pins surfaced it).
  "SELECT ?, MAX(?, ?) + ?, NULL, ?, ?, ?, ? " +
  "WHERE (" +
    "SELECT 1 FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.source = ? AND le.delta = ? " +
    "AND le.created_at = ? AND le.related_user_id IS ? AND le.spend_nonce = ?" +
  ") " +
  "ON CONFLICT(user_id) DO UPDATE SET " +
    "renews_until = MAX(gc_plus_state.renews_until, ?) + ?, " +
    "grace_until = NULL, " +
    "gifted_by = COALESCE(?, gc_plus_state.gifted_by), " +
    // The purchased tier REPLACES the row's tier: a Mini -> full upgrade
    // carries the SAME row forward (never loses its term — tier only, never
    // re-mint), and a renewal writes its own tier again. A Mini buy against
    // an ACTIVE full term never reaches this arm (the route's 409 refuses
    // the downgrade spend; a legacy NULL row reads full exactly so it is
    // protected too).
    "tier = ?, " +
    "updated_at = ?";
const GIFT_TARGET_READ_SQL =
  "SELECT id, username FROM users WHERE username_key = ? LIMIT 1";
async function handleRenewRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:plus:" + userId);
  // The tier choice (the Mini SKU): absent bodies keep the FULL bundle (the
  // client's existing button never changes).
  const body = await readJson(request).catch(() => ({}));
  const tier = body && body.tier === undefined ? "plus" : body.tier;
  if (tier !== "mini" && tier !== "plus") {
    throw new HttpError(400, "That tier is not in the shop.");
  }
  return json(await purchasePlusTerm(env, userId, null, tier));
}

// One batch for the whole purchase: the coin spend and the term upsert, with
// the upsert fingerprinted to the spend row the batch itself mints (a skipped
// spend can never extend a term). Self-purchase and GIFT share it. The
// owner's pricing amendment: a target with NO gc_plus_state row pays the
// first-purchase price, every target who has one pays the renewal price.
// The Mini SKU: its own pair; a Mini -> full upgrade carries the SAME row
// forward (the upsert's tier arm), and a Mini buy against an ACTIVE full
// term is refused — a downgrade spend is a mis-sale, never a 200.
async function purchasePlusTerm(env, gifterId, recipientId, purchasedTier = "plus") {
  const now = nowSeconds();
  const source = recipientId === null ? "plus_renewal" : "plus_gift";
  const relatedUserId = recipientId === null ? null : recipientId;
  const gifterForTrail = recipientId === null ? null : gifterId;
  const term = GC_PLUS_TERM_DAYS * 86400;
  const targetId = recipientId === null ? Number(gifterId) : Number(recipientId);

  const existing = await env.GOOBER_DB.prepare(PLUS_READ_SQL).bind(targetId).first();
  // The Mini-refuse rule: an ACTIVE term that is NOT a Mini (tier 'plus', or
  // a legacy NULL row which READS full) never takes a Mini purchase. A lapsed
  // row's tier is off (everything is) — a Mini re-buy restores a fresh Mini
  // term like any lapsed re-buy.
  if (purchasedTier === "mini" && existing &&
      Number(existing.renews_until) > now &&
      existing.tier !== "mini") {
    throw new HttpError(409, "You already have full Goober+.");
  }
  const price = existing
    ? (purchasedTier === "mini" ? GC_MINI_RENEWAL_PRICE : GC_PLUS_RENEWAL_PRICE)
    : (purchasedTier === "mini" ? GC_MINI_PRICE : GC_PLUS_PRICE);

  // THIS batch's own fingerprint nonce (0058): the term upsert matches only
  // the spend row THIS request minted.
  const nonce = randomToken(SPEND_NONCE_BYTES);
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(PLUS_SPEND_SQL).bind(
      Number(gifterId), -price, source, relatedUserId, now, nonce,
      targetId,
      Number(gifterId),
      price,
    ),
    env.GOOBER_DB.prepare(PLUS_TERM_UPSERT_SQL).bind(
      // INSERT branch: user, MAX(now, now), +term, tenure start, gifted by, updated, tier.
      targetId, now, now, term, now, gifterForTrail, now, purchasedTier,
      // Fingerprint arm: the spend row THIS batch minted.
      Number(gifterId), source, -price, now, relatedUserId, nonce,
      // UPDATE arm: MAX(standing, now) + term, gifter, tier, updated.
      now, term, gifterForTrail, purchasedTier, now,
    ),
  ]);

  // changes = 0 on the term upsert: the spend's guard refused (the only
  // failure mode left after validation) — the house-style after-the-fact
  // classification, one copy, no probe.
  if (Number(results[1]?.meta?.changes) !== 1) {
    throw new HttpError(400, "Not enough Goober Coins for that.");
  }
  const [balanceRow, targetPlusRow] = await Promise.all([
    env.GOOBER_DB.prepare(BALANCE_READ_SQL).bind(Number(gifterId)).first(),
    env.GOOBER_DB.prepare(PLUS_READ_SQL).bind(targetId).first(),
  ]);
  return {
    balance: Number(balanceRow?.balance) || 0,
    price,
    plus: publicPlus(targetPlusRow, nowSeconds()),
  };
}

async function handleGiftRoute(request, env) {
  const session = await requireUser(request, env);
  const gifterId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:gift:" + gifterId);

  const body = await readJson(request);
  const username = isValidUsername(body.username) ? body.username.trim() : null;
  if (!username) {
    throw new HttpError(400, "Enter the member you want to gift Goober+.");
  }

  const target = await env.GOOBER_DB.prepare(GIFT_TARGET_READ_SQL).bind(username.toLowerCase()).first();
  if (!target) throw new HttpError(404, "No member by that name.");
  const targetId = Number(target.id);
  if (targetId === gifterId) {
    throw new HttpError(400, "Gifting Goober+ to yourself is a renewal — use the bundle's own button.");
  }

  const payload = await purchasePlusTerm(env, gifterId, targetId);
  return json({
    ...payload,
    giftedTo: { id: targetId, username: target.username },
  });
}
// The plus dispatcher (the family's arms cut VERBATIM from api/coins.mjs's
// dispatcher tail — the forward in coins.mjs sits at the renew arm's
// original position and hands the WHOLE family here).
export async function handleCoinsPlusRoutes(request, env, path, method) {
  if (path === "/api/plus/renew" && method === "POST") {
    return handleRenewRoute(request, env);
  }
  if (path === "/api/plus/gift" && method === "POST") {
    return handleGiftRoute(request, env);
  }
  return undefined;
}
