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

// Goober Coins routes + the Goober+ term state (owner decisions, 2026-11-16).
//
// COINS ARE EARNED ONLY BY ACTIVITY: never purchased, never transferable,
// never expiring, account-tied. There is deliberately NO purchase route —
// tests/coins-module.test.mjs pins that no pay/purchase/checkout path exists
// anywhere in the dispatch. The balance is always SUM(gc_coin_ledger.delta);
// no balance column exists anywhere.
//
// Every mint rides INSIDE the SQL (house pattern): the per-source day cap,
// the ONE daily ceiling across all grant sources, and the spend's
// sufficient-coins check are WHERE arms of the INSERT that writes the row, so
// a replayed or racing request can never mint past its caps. A failed mint is
// only classified afterwards (changes = 0 → the same no-coins-today copy).
//
// Routes (all user-owned reads, self-actioned writes; nothing here mints for
// anyone but the session member, and the gift route is the one guarded
// exception — it spends the GIFTING member's coins on a CHOSEN member's term):
//   GET  /api/coins          → balance, today's earned breakdown, plus state
//   GET  /api/coins/ledger   → the member's own ledger page (bare-id cursor)
//   GET  /api/coins/shop     → the blaxel shop payload (bundle + balance)
//   POST /api/coins/claim    → the daily activity grant (once per UTC day)
//   POST /api/coins/voice/tick → a voice-presence time grant (per window)
//   POST /api/plus/renew     → extend the member's own Goober+ term
//   POST /api/plus/gift      → spend coins to gift Goober+ to another member
//
// The renewal is MONTHLY from the current term (MAX(renews_until, now) + term,
// so a re-buy inside the grace window restores rather than stacks a stale
// term); grace is materialized lazily on the first touch after a lapse — no
// cron exists on the free plan. tenure_started_at NEVER moves after the first
// term (gc_plus_state's UPDATE arms leave it untouched), and boosts stay FREE
// (owner call: never monetize permissions/channels). DATED SUPERSESSION
// (2026-11-17, the Nitro-perks lane): the earlier "nothing in this bundle
// touches upload caps" ruling is retired by the owner's new ruling — an
// ACTIVE Goober+ term now mints the GC_PLUS_* tier values (the 1.5x earns:
// claim 75, message 2, voice 8, daily ceiling 500) and rides the 25 MB
// upload tier; message LENGTH and permissions remain untouched. The two
// predicates (perks = strict active term; the coins payload's display
// active = shipped grace-inclusive shape) are documented in api/plus.mjs.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_CHAIN_DEPTH_MAX,
  GC_CHAIN_FEE_MIN_COINS,
  GC_CHAIN_FEE_PERCENT,
  GC_CHAIN_HOP_TTL_SECONDS,
  GC_CHAIN_MAX_AMOUNT,
  GC_CHAIN_MIN_AMOUNT,
  GC_COIN_DAILY_CEILING,
  GC_COIN_DAILY_GRANT,
  GC_COIN_MESSAGE_DAILY_CAP,
  GC_COIN_MESSAGE_GRANT,
  GC_COIN_VOICE_DAILY_CAP,
  GC_COIN_VOICE_GRANT,
  GC_COIN_VOICE_TICK_SECONDS,
  GC_COSMETIC_BANNER_PRICE,
  GC_COSMETIC_FLAIR_PRICE,
  GC_COSMETIC_PACK_PRICE,
  GC_MINI_BUNDLE_NAME,
  GC_MINI_PRICE,
  GC_MINI_RENEWAL_PRICE,
  GC_PLUS_BUNDLE_NAME,
  GC_PLUS_DAILY_CEILING,
  GC_PLUS_GRACE_DAYS,
  GC_PLUS_MESSAGE_GRANT,
  GC_PLUS_PRICE,
  GC_PLUS_RENEWAL_PRICE,
  GC_PLUS_ROLLUP_GRANT,
  GC_PLUS_SINK_DISCOUNT_PERCENT,
  GC_PLUS_TERM_DAYS,
  GC_PLUS_VOICE_GRANT,
  GC_PLUS_SERVER_GRANT,
  GC_ROLLUP_DAILY_CAP,
  GC_ROLLUP_GRANT,
  GC_ROLLUP_MIN_BODY,
  GC_SERVER_GRANT,
  GC_SERVER_MINT_DAILY_CAP,
  GC_WELL_MISSED_DAYS_BEFORE_RESET,
  GC_WELL_STREAK_MAX_BONUS_PERCENT,
  GC_WELL_STREAK_STEP_PERCENT,
} from "../constants.mjs";
import { plusPerkActive } from "./plus.mjs";
import { isValidUsername } from "./usernames.mjs";
import { campfirePoolCreditStatement, grantCampfireFuel } from "./campfire.mjs";

// UTC day floor. Every cap — the daily grant, the per-source caps, and the
// ceiling — rides this one boundary, so "today" is one thing everywhere.
function dayFloor(now) {
  return now - (now % 86400);
}

// --- the guard SQL (the economy's teeth) ------------------------------------

// Daily activity grant: the NOT EXISTS arm is the once-per-UTC-day claim, the
// SUM arm is the ceiling. Deltas bound explicitly so a rebalance is a
// constants.mjs change, never a re-read of stored math.
const CLAIM_INSERT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'daily', ? " +
  "WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = ?) " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_coin_ledger ld WHERE ld.user_id = ? AND ld.source = 'daily' " +
    "AND ld.created_at >= ?) " +
  "AND (" +
    "SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.created_at >= ? AND le.delta > 0" +
  ") + ? <= ? LIMIT 1";

// Per-message earned points (api/messages.mjs calls this after a FRESH send —
// an idempotent replay returns created=false and never reaches the grant).
// Arm 1 is the shared ceiling, arm 2 the source's own day cap; earned sums
// filter delta > 0 so spends never refund a cap (never a farm loop).
const MESSAGE_GRANT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'message', ? " +
  "WHERE (" +
    "SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.created_at >= ? AND le.delta > 0" +
  ") + ? <= ? " +
  "AND (" +
    "SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.created_at >= ? AND le.delta > 0 " +
    "AND le.source = 'message'" +
  ") + ? <= ?";

// Voice-presence time grant. The membership arm rides inside the INSERT: the
// tick's channel must be a voice channel the member belongs to (server-owned
// voice channels join gc_server_members), so a stray request to a foreign or
// text channel mints nothing.
const VOICE_GRANT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at) " +
  "SELECT ?, ?, 'voice', NULL, ? " +
  "WHERE EXISTS (" +
    "SELECT 1 FROM gc_channels vc " +
    "JOIN gc_server_members vm ON vm.server_id = vc.server_id AND vm.user_id = ? " +
    "WHERE vc.id = ? AND vc.kind = 'voice' AND vc.server_id IS NOT NULL) " +
  "AND (" +
    "SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.created_at >= ? AND le.delta > 0" +
  ") + ? <= ? " +
  "AND (" +
    "SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.created_at >= ? AND le.delta > 0 " +
    "AND le.source = 'voice'" +
  ") + ? <= ?";

// The Goober+ coin spend (shared by the renewal and the gift): one negative
// row under the sufficient-coins arm — the check IS the statement, so two
// racing purchases can never both clear a one-purchase balance.
const PLUS_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, related_user_id, created_at) " +
  "SELECT ?, ?, ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM users rp WHERE rp.id = ?) " +
  "AND (SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ?) >= ? LIMIT 1";

// The FORUM-POST ROLLUP (the economy re-rule): one LAZY row per member per UTC
// day, minted at the member's next coins touch. The NOT EXISTS arm is the
// user+day gate; the count sub-query (GC's read-only forum lane) counts the
// day's PUBLIC posts of >= GC_ROLLUP_MIN_BODY trimmed chars from the shared
// `posts` table; the tier's rate and the post cap ride as binds, MIN() caps
// the counted posts, and the delta expression repeats inside the ceiling arm
// (caps' math stays INSIDE the statement). A member with zero qualifying
// posts mints nothing — the rate-and-count arm keeps an idle day a zero-row
// day. Binds (textual order): user, rate, user, dayStart, minBody, cap, now,
// rate, user, dayStart, rate, user, dayStart, minBody, cap, ceiling, user,
// dayStart.
const ROLLUP_INSERT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ? * MIN(" +
    "(SELECT COUNT(*) FROM posts p WHERE p.author_id = ? AND p.visibility = 'public' " +
      "AND p.created_at >= ? AND length(trim(p.body)) >= ?), ?" +
  "), 'rollup', ? " +
  "WHERE ? > 0 " +
  "AND (" +
    "SELECT COALESCE(SUM(le2.delta), 0) FROM gc_coin_ledger le2 " +
    "WHERE le2.user_id = ? AND le2.created_at >= ? AND le2.delta > 0" +
  ") + (? * MIN(" +
    "(SELECT COUNT(*) FROM posts p2 WHERE p2.author_id = ? AND p2.visibility = 'public' " +
      "AND p2.created_at >= ? AND length(trim(p2.body)) >= ?), ?" +
  ")) <= ? " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_coin_ledger rl WHERE rl.user_id = ? AND rl.source = 'rollup' " +
    "AND rl.created_at >= ?" +
  ")";

// The SERVER-CREATE mint (the economy re-rule): the community-builder's
// grant, minted ONCE per created server (the create route calls this after
// the build batch commits). The ceiling arm keeps the one-daily-ceiling
// contract and the mint-EVENT cap is the COUNT of today's 'server' rows.
const SERVER_MINT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'server', ? " +
  "WHERE (" +
    "SELECT COALESCE(SUM(le3.delta), 0) FROM gc_coin_ledger le3 " +
    "WHERE le3.user_id = ? AND le3.created_at >= ? AND le3.delta > 0" +
  ") + ? <= ? " +
  "AND (" +
    "SELECT COUNT(*) FROM gc_coin_ledger sv WHERE sv.user_id = ? " +
    "AND sv.source = 'server' AND sv.created_at >= ?" +
  ") < ?";

// The Well's streak rider (T76 §1): the state read + the explicit-delta
// upsert (every number rides a bind — no stored math). The upsert rides
// AFTER the claim's mint (only a minted claim renews the streak).
const WELL_READ_SQL =
  "SELECT streak_days, bonus_percent, last_claim_day FROM gc_well_streaks " +
  "WHERE user_id = ? LIMIT 1";

const WELL_UPSERT_SQL =
  "INSERT INTO gc_well_streaks (user_id, streak_days, bonus_percent, last_claim_day, updated_at) " +
  "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT (user_id) DO UPDATE SET " +
    "streak_days = ?, bonus_percent = ?, last_claim_day = ?, updated_at = ?";

// The gift chains (T76 §3): the anonymous hop chain. The send's spend pair
// (gift + fee) rides the PLUS_SPEND shape generalized — BOTH rows are
// sender-owned spends, NEITHER carries a related_user_id column (the hop's
// anonymity law: the chain_fee row answers nothing but the pool it fed),
// and the fee's pool credit upsert names gc_campfires in the SAME batch.
const CHAIN_SEND_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'chain_gift', ? " +
  "WHERE (SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ?) >= ? LIMIT 1";

const CHAIN_FEE_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'chain_fee', ? " +
  "WHERE (SELECT COALESCE(SUM(le.delta), 0) FROM gc_coin_ledger le " +
    "WHERE le.user_id = ?) >= ? LIMIT 1";

const CHAIN_HOP_INSERT_SQL =
  "INSERT INTO gc_chain_hops (hop_token, depth, amount, pool_server_id, expires_at, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?)";

const CHAIN_HOLD_INSERT_SQL =
  "INSERT INTO gc_chain_hold (hop_token, user_id, created_at) VALUES (?, ?, ?)";

const CHAIN_DELETE_HOP_SQL =
  "DELETE FROM gc_chain_hops WHERE hop_token = ?";

const CHAIN_DELETE_HOLD_SQL =
  "DELETE FROM gc_chain_hold WHERE hop_token = ?";

// The member's own inbox (the only chain read): the hop rows join the
// holder's own hold rows — the join names gc_chain_hold, never users (no
// sender name can ride a row of this page by construction).
const CHAIN_INBOX_READ_SQL =
  "SELECT h.hop_token, h.depth, h.amount, h.expires_at " +
  "FROM gc_chain_hops h JOIN gc_chain_hold c ON c.hop_token = h.hop_token " +
  "WHERE c.user_id = ? ORDER BY h.created_at DESC, h.rowid DESC";

// The expired-hop sweep (lazy, read-side): a hop past its TTL converts to
// keep for its holder on the next inbox read — no silent loss, no fee.
const CHAIN_EXPIRED_READ_SQL =
  "SELECT h.hop_token, h.depth, h.amount, h.expires_at " +
  "FROM gc_chain_hops h JOIN gc_chain_hold c ON c.hop_token = h.hop_token " +
  "WHERE c.user_id = ? AND h.expires_at <= ?";

const CHAIN_KEEP_MINT_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, 'chain_gift', ? " +
  "WHERE EXISTS (" +
    "SELECT 1 FROM gc_chain_hops gh JOIN gc_chain_hold gc ON gc.hop_token = gh.hop_token " +
    "WHERE gh.hop_token = ? AND gc.user_id = ?)";

// The chain's one hop read: the caller's own hold joins the hop (the ONLY
// seat the token resolves through — a foreign token answers the same 404 as
// a made-up one).
const CHAIN_HOP_READ_SQL =
  "SELECT h.hop_token, h.depth, h.amount, h.expires_at " +
  "FROM gc_chain_hops h JOIN gc_chain_hold c ON c.hop_token = h.hop_token " +
  "WHERE h.hop_token = ? AND c.user_id = ? LIMIT 1";

// The two-hop shared-server pick: a server the two members share (the pass
// fee banks there); falls back to the sender's own membership for the send.
const SHARED_SERVER_READ_SQL =
  "SELECT one.server_id AS server_id FROM gc_server_members one " +
  "WHERE one.user_id = ? AND EXISTS (" +
    "SELECT 1 FROM gc_server_members two " +
    "WHERE two.server_id = one.server_id AND two.user_id = ?) " +
  "ORDER BY one.server_id LIMIT 1";

const OWN_SERVER_READ_SQL =
  "SELECT server_id FROM gc_server_members WHERE user_id = ? ORDER BY server_id LIMIT 1";

// The term upsert, conditioned on the spend row THIS batch minted (the
// fingerprint arm rides the INSERT's SELECT, so a skipped spend can never
// extend a term and a granted spend always does). A same-second repeat
// purchase could satisfy the fingerprint with the earlier spend's row; a
// member cannot issue two purchases inside one second through the rate
// limiter, and both buys would be the member's own — the corner stays closed
// in practice and is pinned in the tests.
const PLUS_TERM_UPSERT_SQL =
  "INSERT INTO gc_plus_state (user_id, renews_until, grace_until, tenure_started_at, gifted_by, updated_at, tier) " +
  "SELECT ?, MAX(?, ?) + ?, NULL, ?, ?, ? " +
  "WHERE (" +
    "SELECT 1 FROM gc_coin_ledger le " +
    "WHERE le.user_id = ? AND le.source = ? AND le.delta = ? " +
    "AND le.created_at = ? AND le.related_user_id IS ?" +
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

// Grace materialization (lazy — no cron): the first touch after a term lapses
// stamps the window. No row, no grace; an expired member's row simply waits.
const PLUS_GRACE_TOUCH_SQL =
  "UPDATE gc_plus_state SET grace_until = renews_until + ?, updated_at = ? " +
  "WHERE user_id = ? AND grace_until IS NULL AND renews_until <= ?";

// The cosmetic sink (the economy re-rule): one atomic batch per purchase — the
// negative ledger row and the ownership row, BOTH guarded by the sufficient-
// coins arm, and the ownership INSERT additionally by its own NOT EXISTS (a
// re-spend is the 409, never a second ownership row). The REPLAY guard rides
// the spend statement itself (T31): a caller who already holds every item the
// purchase would grant takes a zero-changes ledger INSERT, so a replayed
// double-submit is 409 with NO second negative row — before the fix the
// balance arm alone let the replay re-charge. The NOT-EXISTS slots the items
// through (one bind pair or the pack's two); the caller's tier's price rides
// as a bind; the pack is two ownership INSERTs and one ledger row.
const COSMETIC_LEDGER_SPEND_SQL = (slots) =>
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at) " +
  "SELECT ?, ?, ?, ? " +
  "WHERE (SELECT COALESCE(SUM(le4.delta), 0) FROM gc_coin_ledger le4 " +
    "WHERE le4.user_id = ?) >= ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_cosmetic_ownership ow " +
      "WHERE ow.user_id = ? AND ow.item IN (" +
      Array.from({ length: slots }, () => "?").join(", ") + ")) " +
  "LIMIT 1";

const COSMETIC_OWNERSHIP_INSERT_SQL =
  "INSERT INTO gc_cosmetic_ownership (user_id, item, purchased_at) " +
  "SELECT ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_coin_ledger cl WHERE cl.user_id = ? " +
    "AND cl.source = ? AND cl.delta = ? AND cl.created_at = ?) " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_cosmetic_ownership ow WHERE ow.user_id = ? AND ow.item = ?" +
  ")";

const OWNERSHIP_READ_SQL =
  "SELECT item FROM gc_cosmetic_ownership WHERE user_id = ?";

// --- reads -------------------------------------------------------------------

const BALANCE_READ_SQL =
  "SELECT COALESCE(SUM(le.delta), 0) AS balance FROM gc_coin_ledger le WHERE le.user_id = ?";

const DAY_EARNED_READ_SQL =
  "SELECT " +
    "COALESCE(SUM(CASE WHEN le.delta > 0 THEN le.delta ELSE 0 END), 0) AS earned, " +
    "COALESCE(SUM(CASE WHEN le.delta > 0 AND le.source = 'daily' THEN le.delta ELSE 0 END), 0) AS daily, " +
    "COALESCE(SUM(CASE WHEN le.delta > 0 AND le.source = 'message' THEN le.delta ELSE 0 END), 0) AS message, " +
    "COALESCE(SUM(CASE WHEN le.delta > 0 AND le.source = 'voice' THEN le.delta ELSE 0 END), 0) AS voice, " +
    "COALESCE(SUM(CASE WHEN le.delta > 0 AND le.source = 'rollup' THEN le.delta ELSE 0 END), 0) AS rollup, " +
    "COALESCE(SUM(CASE WHEN le.delta > 0 AND le.source = 'server' THEN le.delta ELSE 0 END), 0) AS server " +
  "FROM gc_coin_ledger le WHERE le.user_id = ? AND le.created_at >= ?";

const PLUS_READ_SQL =
  "SELECT renews_until, grace_until, tenure_started_at, gifted_by, tier " +
  "FROM gc_plus_state WHERE user_id = ? LIMIT 1";

const GIFT_TARGET_READ_SQL =
  "SELECT id, username FROM users WHERE username_key = ? LIMIT 1";

const LEDGER_PAGE_SQL =
  "SELECT le.id, le.delta, le.source, le.related_user_id, lu.username AS related_username, le.created_at " +
  "FROM gc_coin_ledger le LEFT JOIN users lu ON lu.id = le.related_user_id " +
  "WHERE le.user_id = ?";

// --- shaping -----------------------------------------------------------------

// The plus discount's route-side math (the owner's amendment: 50% off the
// coin prices for Goober+). The pack is the exception — the plus-lane item
// carries its flat 250 and is plus-only. The plusPrice field is the price
// a plus member WOULD pay (a constant attribute of the item), while cost is
// the CALLER's own price.
function discountedPrice(price, perks) {
  return perks ? Math.round(price * (100 - GC_PLUS_SINK_DISCOUNT_PERCENT) / 100) : price;
}
// The Goober+ bundle's public shape: ONE bundle, the FIRST-purchase price and
// the renewal price echo constants.mjs, and the free-things rider is the
// owner's own copy. The coin-shop ITEMS ride their own payload builder (the
// shop route adds ownership + balance context).
function publicBundle() {
  return {
    name: GC_PLUS_BUNDLE_NAME,
    blaxel: true,
    price: GC_PLUS_PRICE,
    renewalPrice: GC_PLUS_RENEWAL_PRICE,
    termDays: GC_PLUS_TERM_DAYS,
    graceDays: GC_PLUS_GRACE_DAYS,
    perks: ["Boosted daily + activity earnings", "Cosmetics: banner + flair", "Bigger upload cap", "Bigger coin ceiling"],
    // Dated supersession (2026-11-17): the old "never moves your upload cap"
    // line was retired by the owner's Nitro-perks ruling — the upload CAP
    // move is the blessed tier (constants.mjs GC_PLUS_*); permissions,
    // channels, and message length REMAIN untouched (the original owner call
    // about permissions stands).
    note: "Server boosts stay free. Goober+ never moves your permissions, channels, or message length — but it does raise your upload cap (25 MB) and earn ceiling since 2026-11-17.",
  };
}

// The Mini SKU's public shape (the 2026-11-17 matrix's lighter tier): the
// emoji/sticker/reaction/upload perks WITHOUT the economy, streaming, or
// message-length riders, at its own price pair. The upgrade note is the
// owner's rule spelled for the buyer: a Mini -> full upgrade carries the
// SAME term forward.
function publicMiniBundle() {
  return {
    name: GC_MINI_BUNDLE_NAME,
    blaxel: true,
    price: GC_MINI_PRICE,
    renewalPrice: GC_MINI_RENEWAL_PRICE,
    termDays: GC_PLUS_TERM_DAYS,
    graceDays: GC_PLUS_GRACE_DAYS,
    perks: ["Custom emoji anywhere + animated", "Stickers", "Super Reactions",
      "50 MB uploads", "The Goober+ badge"],
    note: "The lighter tier: emoji, stickers, reactions, and the 50 MB upload cap — no economy or streaming riders. Upgrading to full Goober+ keeps your term.",
  };
}

// The cosmetic sink's payload (the economy re-rule): every item exposes BOTH
// the list and the plus price, plus the caller's actual cost and ownership.
function publicCosmeticItems(ownedItems, perks) {
  const owned = (item) => ownedItems.includes(item);
  return [
    {
      item: "banner",
      price: GC_COSMETIC_BANNER_PRICE,
      // The plus price is an ITEM attribute (what a plus member would pay),
      // never the caller's — cost is the caller's own.
      plusPrice: discountedPrice(GC_COSMETIC_BANNER_PRICE, true),
      cost: discountedPrice(GC_COSMETIC_BANNER_PRICE, perks),
      owned: owned("banner"),
    },
    {
      item: "flair",
      price: GC_COSMETIC_FLAIR_PRICE,
      plusPrice: discountedPrice(GC_COSMETIC_FLAIR_PRICE, true),
      cost: discountedPrice(GC_COSMETIC_FLAIR_PRICE, perks),
      owned: owned("flair"),
    },
    {
      item: "pack",
      price: GC_COSMETIC_PACK_PRICE,
      plusPrice: GC_COSMETIC_PACK_PRICE, // flat — the pack never discounts
      cost: GC_COSMETIC_PACK_PRICE,
      plusOnly: true,
      owned: owned("banner") && owned("flair"),
    },
  ];
}

// The plus payload: absence (never bought) is a shape, a lapsed term is
// "active: false" with the grace window the member sits in, an active term is
// "active: true". Tenure and the gifter trail always ride along.
function publicPlus(row, now) {
  if (!row) return { hasPlus: false, active: false, inGrace: false };
  const renewsUntil = Number(row.renews_until) || 0;
  const graceUntil = row.grace_until === null || row.grace_until === undefined
    ? null
    : Number(row.grace_until);
  const active = renewsUntil > now || (graceUntil !== null && graceUntil > now);
  return {
    hasPlus: true,
    active,
    inGrace: !active ? false : renewsUntil <= now && graceUntil !== null && graceUntil > now,
    renewsUntil,
    graceUntil,
    tenureStartedAt: Number(row.tenure_started_at) || 0,
    giftedBy: row.gifted_by === null || row.gifted_by === undefined
      ? null
      : Number(row.gifted_by),
    // The 0022 tier (additive): a legacy NULL row reads null — the READ side
    // still answers full Goober+ everywhere the strict perk predicate rides;
    // the tier key exists so the shop can never mis-sell a Mini onto it.
    tier: typeof row.tier === "string" ? row.tier : null,
  };
}

function publicLedgerEntry(row) {
  return {
    id: Number(row.id),
    delta: Number(row.delta),
    source: String(row.source || ""),
    relatedUserId: row.related_user_id === null || row.related_user_id === undefined
      ? null
      : Number(row.related_user_id),
    relatedUsername: typeof row.related_username === "string" && row.related_username.length > 0
      ? row.related_username
      : null,
    createdAt:
      typeof row.created_at === "number"
        ? new Date(row.created_at * 1000).toISOString()
        : null,
  };
}

// --- grant primitives (also the send pipeline's contract) --------------------

// The message send's grant hook. Kept tiny and failure-isolated upstream: the
// send already happened, so a grant failure must never fail it — api/messages
// mjs wraps the call itself.
export async function grantMessageCoins(env, userId, now) {
  const dayStart = dayFloor(now);
  // The perk tier rides the same statement shape: an active term mints the
  // PLUS values (the ECONOMY RE-RULE's 3-vs-2 message rate — the tier read is
  // one indexed PK walk, and the mint arms see the FINAL delta either way).
  // Caps do NOT scale with the tier — they are coin caps, so plus values
  // simply reach the same cap sooner.
  const perks = await plusPerkActive(env, userId, now);
  const per = perks ? GC_PLUS_MESSAGE_GRANT : GC_COIN_MESSAGE_GRANT;
  const ceiling = perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING;
  const result = await env.GOOBER_DB
    .prepare(MESSAGE_GRANT_SQL)
    .bind(
      userId, per, now,
      userId, dayStart, per, ceiling,
      userId, dayStart, per, GC_COIN_MESSAGE_DAILY_CAP,
    )
    .run();
  return Number(result.meta?.changes) === 1;
}

// The server-create mint hook (the economy re-rule): called by the create
// route AFTER the build batch commits — failure-isolated there (coins never
// fail a server). An active term mints the 75 tier under the same guards.
export async function grantServerCreateCoins(env, userId, now) {
  const dayStart = dayFloor(now);
  const perks = await plusPerkActive(env, userId, now);
  const per = perks ? GC_PLUS_SERVER_GRANT : GC_SERVER_GRANT;
  const ceiling = perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING;
  const result = await env.GOOBER_DB
    .prepare(SERVER_MINT_SQL)
    .bind(
      userId, per, now,
      userId, dayStart, per, ceiling,
      userId, dayStart, GC_SERVER_MINT_DAILY_CAP,
    )
    .run();
  return Number(result.meta?.changes) === 1;
}

// The rollup's LAZY half (the economy re-rule): one guarded mint per user+day
// at the member's next coins touch. Failure-isolated (a rollup miss only
// delays the member's rollup coins to the next touch).
export async function mintRollupCoins(env, userId, now) {
  const dayStart = dayFloor(now);
  const perks = await plusPerkActive(env, userId, now);
  const per = perks ? GC_PLUS_ROLLUP_GRANT : GC_ROLLUP_GRANT;
  const ceiling = perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING;
  await env.GOOBER_DB
    .prepare(ROLLUP_INSERT_SQL)
    .bind(
      userId, per,
      userId, dayStart, GC_ROLLUP_MIN_BODY, GC_ROLLUP_DAILY_CAP,
      now,
      per,
      userId, dayStart, per,
      userId, dayStart, GC_ROLLUP_MIN_BODY, GC_ROLLUP_DAILY_CAP,
      ceiling,
      userId, dayStart,
    )
    .run();
}

// Internal: run one mint, answer "minted" (changes = 1). Shared by the claim
// and the voice tick (both respond with the standing numbers either way).
async function mint(env, sql, binds) {
  const result = await env.GOOBER_DB.prepare(sql).bind(...binds).run();
  return Number(result.meta?.changes) === 1;
}

// Internal: the standing read every coin route answers with.
async function coinsSnapshot(env, userId, now) {
  const dayStart = dayFloor(now);
  await mintRollupCoins(env, userId, now).catch(() => {
    /* the rollup is lazy-benevolent: a miss delays to the next touch */
  });
  const [balanceRow, dayRow, plusRow] = await Promise.all([
    env.GOOBER_DB.prepare(BALANCE_READ_SQL).bind(userId).first(),
    env.GOOBER_DB.prepare(DAY_EARNED_READ_SQL).bind(userId, dayStart).first(),
    plusRowFor(env, userId, now),
  ]);
  // The standing numbers answer the member's OWN tier: the claim is FLAT now
  // (the re-rule retires the 75 tier), while message/voice/rollup/server
  // still carry the plus values; grace days show the free values (the perk
  // predicate is strict, api/plus.mjs).
  const perks = await plusPerkActive(env, userId, now);
  return {
    balance: Number(balanceRow?.balance) || 0,
    dailyCeiling: perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING,
    earnedToday: Number(dayRow?.earned) || 0,
    daily: { grant: GC_COIN_DAILY_GRANT, claimedToday: (Number(dayRow?.daily) || 0) > 0 },
    message: { per: perks ? GC_PLUS_MESSAGE_GRANT : GC_COIN_MESSAGE_GRANT, cap: GC_COIN_MESSAGE_DAILY_CAP, earnedToday: Number(dayRow?.message) || 0 },
    voice: {
      per: perks ? GC_PLUS_VOICE_GRANT : GC_COIN_VOICE_GRANT,
      windowSeconds: GC_COIN_VOICE_TICK_SECONDS,
      cap: GC_COIN_VOICE_DAILY_CAP,
      earnedToday: Number(dayRow?.voice) || 0,
    },
    rollup: {
      per: perks ? GC_PLUS_ROLLUP_GRANT : GC_ROLLUP_GRANT,
      cap: GC_ROLLUP_DAILY_CAP,
      minBody: GC_ROLLUP_MIN_BODY,
      earnedToday: Number(dayRow?.rollup) || 0,
    },
    server: { per: perks ? GC_PLUS_SERVER_GRANT : GC_SERVER_GRANT, mintCapPerDay: GC_SERVER_MINT_DAILY_CAP, earnedToday: Number(dayRow?.server) || 0 },
    plus: plusRow,
  };
}

// Plus reads materialize grace on the way through: one guarded UPDATE riding
// the same connection, then the read (the stamped window survives for later
// touches; the read's own shape answers for this request either way).
async function plusRowFor(env, userId, now) {
  await env.GOOBER_DB
    .prepare(PLUS_GRACE_TOUCH_SQL)
    .bind(GC_PLUS_GRACE_DAYS * 86400, now, userId, now)
    .run();
  const row = await env.GOOBER_DB.prepare(PLUS_READ_SQL).bind(userId).first();
  return publicPlus(row, now);
}

// --- routes ------------------------------------------------------------------

async function handleCoinsReadRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "coins:" + userId);
  return json(await coinsSnapshot(env, userId, nowSeconds()));
}

async function handleCoinsShopRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "coins:shop:" + userId);
  const snapshot = await coinsSnapshot(env, userId, nowSeconds());
  // The cosmetic sink's payload: BOTH prices per item, the caller's own
  // discount side, and the caller's ownership state.
  const perks = await plusPerkActive(env, userId, nowSeconds());
  const ownership = (await env.GOOBER_DB.prepare(OWNERSHIP_READ_SQL).bind(userId).all()).results || [];
  return json({
    ...snapshot,
    bundle: publicBundle(),
    mini: publicMiniBundle(),
    items: publicCosmeticItems(ownership.map((row) => String(row.item || "")), perks),
  });
}

// The cosmetic SINK's one write route (the economy re-rule): buy banner,
// flair, or the pack. The tier's price (50% off for an ACTIVE term on
// banner/flair; the pack flat, plus-only) is computed ROUTE-SIDE per the
// owner's amendment, and the batch's guards carry the balance + the NOT-
// EXISTS-ownership (on the SPEND too — the T31 replay guard — beside the
// ownership INSERT) + (for the pack) the plus gate into the statements.
async function handleCosmeticBuyRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:cosmetic:" + userId);
  const body = await readJson(request);
  const perks = await plusPerkActive(env, userId, nowSeconds());

  const item = body && body.item;
  if (item !== "banner" && item !== "flair" && item !== "pack") {
    throw new HttpError(400, "That cosmetic is not in the shop.");
  }
  if (item === "pack" && !perks) {
    throw new HttpError(403, "That one is a Goober+ pack. Get Goober+ in the shop first.");
  }

  const now = nowSeconds();
  const price = item === "pack"
    ? GC_COSMETIC_PACK_PRICE
    : discountedPrice(item === "banner" ? GC_COSMETIC_BANNER_PRICE : GC_COSMETIC_FLAIR_PRICE, perks);
  const source = item === "pack" ? "cosmetic_pack" : "cosmetic";
  const items = item === "pack" ? ["banner", "flair"] : [item];

  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(COSMETIC_LEDGER_SPEND_SQL(items.length)).bind(
      userId, -price, source, now,
      userId,
      price,
      userId,
      ...items,
    ),
    ...items.map((owned) =>
      env.GOOBER_DB.prepare(COSMETIC_OWNERSHIP_INSERT_SQL).bind(
        userId, owned, now,
        userId, source, -price, now,
        userId, owned,
      )),
  ]);

  const bought = results.slice(1).every((r) => Number(r?.meta?.changes) === 1);
  if (!bought) {
    // Classified after the fact, one probe: insufficient coins is the spend
    // refusal's copy, anything else is the ownership one (the batch is
    // atomic, so nothing persisted either way).
    const balanceRow = await env.GOOBER_DB.prepare(BALANCE_READ_SQL).bind(userId).first();
    if ((Number(balanceRow?.balance) || 0) < price) {
      throw new HttpError(400, "Not enough Goober Coins for that.");
    }
    throw new HttpError(409, "You already own that cosmetic.");
  }
  const ownership = (await env.GOOBER_DB.prepare(OWNERSHIP_READ_SQL).bind(userId).all()).results || [];
  return json({
    bought: true,
    cost: price,
    items: publicCosmeticItems(ownership.map((row) => String(row.item || "")), perks),
  });
}

async function handleLedgerReadRoute(request, env, url) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "coins:ledger:" + userId);

  // The messages route's cursor convention: the bare-id `before`, id DESC.
  const beforeRaw = url.searchParams.get("before");
  let before = null;
  if (beforeRaw !== null && beforeRaw !== "") {
    if (!/^[1-9][0-9]{0,14}$/.test(beforeRaw)) {
      throw new HttpError(400, "That ledger cursor is invalid.");
    }
    before = Number(beforeRaw);
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null || limitRaw === ""
    ? 25
    : (/^[0-9]{1,4}$/.test(limitRaw) && Number(limitRaw) >= 1 && Number(limitRaw) <= 100
        ? Number(limitRaw)
        : null);
  if (limit === null) throw new HttpError(400, "That ledger page size is invalid.");

  let sql = LEDGER_PAGE_SQL;
  const binds = [userId];
  if (before !== null) {
    sql += " AND le.id < ?";
    binds.push(before);
  }
  sql += " ORDER BY le.id DESC LIMIT " + limit;
  const page = (await env.GOOBER_DB.prepare(sql).bind(...binds).all()).results || [];

  // nextAfter is the page's OLDEST id — the strictly-older walk.
  const nextAfter = page.length ? Number(page[page.length - 1].id) : null;
  return json({
    entries: page.map(publicLedgerEntry),
    nextAfter,
  });
}

// The Well's streak arithmetic (T76 §1 — route-side math, explicit binds):
//   * first claim ever (no row)           → streak 1, bonus = step;
//   * yesterday's claim (gap 1)           → streak +1, bonus capped step;
//   * missed days (gap 2..4)              → THE gentle decay: each missed day
//     halves streak AND bonus (floor, never zeroed — a half of 1 stays 1);
//   * gap >= MISSED_DAYS_BEFORE_RESET     → reset: today's claim reads the
//     base shape (streak 1, bonus 0);
//   * a same-day re-claim never reaches this (the mint's once-per-day arm
//     refuses first — the upsert rides ONLY a minted claim).
function nextWell(prevRow, today) {
  if (!prevRow) {
    return { streakDays: 1, bonusPercent: GC_WELL_STREAK_STEP_PERCENT };
  }
  const priorStreak = Number(prevRow.streak_days) || 0;
  const priorBonus = Number(prevRow.bonus_percent) || 0;
  const priorDay = Number(prevRow.last_claim_day) || 0;
  const gapDays = Math.floor((today - priorDay) / 86400);
  if (gapDays >= GC_WELL_MISSED_DAYS_BEFORE_RESET) {
    return { streakDays: 1, bonusPercent: 0 };
  }
  const missedDays = Math.max(gapDays - 1, 0);
  if (missedDays === 0) {
    return {
      streakDays: priorStreak + 1,
      bonusPercent: Math.min(
        priorBonus + GC_WELL_STREAK_STEP_PERCENT,
        GC_WELL_STREAK_MAX_BONUS_PERCENT,
      ),
    };
  }
  let streakDays = Math.max(priorStreak, 0);
  let bonusPercent = Math.max(priorBonus, 0);
  for (let i = 0; i < missedDays; i += 1) {
    streakDays = Math.floor(streakDays / 2);
    bonusPercent = Math.floor(bonusPercent / 2);
  }
  return { streakDays: Math.max(streakDays, 1), bonusPercent: Math.max(bonusPercent, 0) };
}

// The claim's multiplied grant (T76 §1): the minted delta IS the Well's
// math — 25 base up to 50 at the cap — still under the existing ceiling arm
// (the multiplied delta rides the grant seat, so the ceiling guards what
// actually mints).
function wellGrantAmount(bonusPercent) {
  return Math.round(GC_COIN_DAILY_GRANT * (1 + bonusPercent / 100));
}

async function handleClaimRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:daily:" + userId);

  const now = nowSeconds();
  const dayStart = dayFloor(now);
  // One statement, both guards inside: the once-per-day arm and the ceiling
  // arm. changes = 0 → the same "come back tomorrow" copy either way (no
  // oracle between the two refusals; both are "no coins for you today").
  // The ECONOMY RE-RULE retires the claim's TIER (25 FLAT) but the ceiling
  // stays the member's own (250 / 500); the WELL rider (T76) multiplies the
  // grant by the streak's bonus.
  const perks = await plusPerkActive(env, userId, now);
  // The Well state read happens BEFORE the mint (the multipliers come from
  // yesterday's row; the upsert rides only a minted claim, so a refused
  // claim never renews the streak).
  const prevRow = await env.GOOBER_DB.prepare(WELL_READ_SQL).bind(userId).first();
  const next = nextWell(prevRow, dayStart);
  const delta = wellGrantAmount(next.bonusPercent);
  const minted = await mint(env, CLAIM_INSERT_SQL, [
    userId, delta, now,
    userId,
    userId, dayStart,
    userId, dayStart,
    delta,
    perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING,
  ]);
  if (!minted) {
    throw new HttpError(409, "Already claimed today. Come back tomorrow.");
  }
  await env.GOOBER_DB.prepare(WELL_UPSERT_SQL).bind(
    userId, next.streakDays, next.bonusPercent, dayStart, now,
    next.streakDays, next.bonusPercent, dayStart, now,
  ).run();
  const snapshot = await coinsSnapshot(env, userId, nowSeconds());
  return json({ claimed: true, streak: next.streakDays, bonusPercent: next.bonusPercent, ...snapshot });
}

async function handleVoiceTickRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:voice:" + userId);

  const body = await readJson(request);
  const channelId = body.channelId;
  if (typeof channelId !== "number" || !Number.isInteger(channelId) || channelId <= 0) {
    throw new HttpError(400, "That voice channel is invalid.");
  }

  const now = nowSeconds();
  const dayStart = dayFloor(now);
  // Cap hits (and non-membership) are routine here, never errors: a tick that
  // mints nothing answers granted:false with the standing numbers. No oracle —
  // a foreign channel and a reached cap both look exactly the same.
  const perks = await plusPerkActive(env, userId, now);
  // The Campfire's voice rider (T76 §2): one indexed channel read answers the
  // server the tick sits in (a DM/group or unknown channel reads NULL/none and
  // feeds no fire); the fuel accrual rides ONLY a minted tick, best-effort —
  // a fuel miss delays the fire, never the voice mint.
  const channelRow = await env.GOOBER_DB.prepare(
    "SELECT server_id FROM gc_channels WHERE id = ? LIMIT 1",
  ).bind(channelId).first();
  const tickServerId = channelRow === null || channelRow === undefined ||
    channelRow.server_id === null || channelRow.server_id === undefined
    ? null
    : Number(channelRow.server_id);
  const voiceGrant = perks ? GC_PLUS_VOICE_GRANT : GC_COIN_VOICE_GRANT;
  const voiceCeiling = perks ? GC_PLUS_DAILY_CEILING : GC_COIN_DAILY_CEILING;
  const minted = await mint(env, VOICE_GRANT_SQL, [
    userId, voiceGrant, now,
    userId, channelId,
    userId, dayStart, voiceGrant, voiceCeiling,
    userId, dayStart, voiceGrant, GC_COIN_VOICE_DAILY_CAP,
  ]);
  if (minted && tickServerId !== null) {
    await grantCampfireFuel(env, tickServerId, now).catch(() => {
      /* a fuel miss only delays the fire */
    });
  }
  const snapshot = await coinsSnapshot(env, userId, nowSeconds());
  return json({ granted: minted, ...snapshot });
}

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

  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(PLUS_SPEND_SQL).bind(
      Number(gifterId), -price, source, relatedUserId, now,
      targetId,
      Number(gifterId),
      price,
    ),
    env.GOOBER_DB.prepare(PLUS_TERM_UPSERT_SQL).bind(
      // INSERT branch: user, MAX(now, now), +term, tenure start, gifted by, updated, tier.
      targetId, now, now, term, now, gifterForTrail, now, purchasedTier,
      // Fingerprint arm: the spend row THIS batch minted.
      Number(gifterId), source, -price, now, relatedUserId,
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

// --- T76 §3: the pay-it-forward gift chains ----------------------------------

// The fee's route-side math (explicit, never stored): MAX(1, ceil(amount * 5%)).
function chainFee(amount) {
  return Math.max(GC_CHAIN_FEE_MIN_COINS, Math.ceil(amount * GC_CHAIN_FEE_PERCENT / 100));
}

const CHAIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function chainTokenOr400(raw) {
  if (typeof raw !== "string" || !CHAIN_TOKEN_PATTERN.test(raw)) {
    throw new HttpError(400, "That chain hop is invalid.");
  }
  return raw;
}

// The target read + the not-self arm (the send and the pass share it).
async function chainTarget(env, rawName, selfId) {
  const username = isValidUsername(rawName) ? String(rawName).trim().toLowerCase() : null;
  if (!username) throw new HttpError(400, "Enter the member you want to send to.");
  const target = await env.GOOBER_DB.prepare(GIFT_TARGET_READ_SQL).bind(username).first();
  if (!target) throw new HttpError(404, "No member by that name.");
  const targetId = Number(target.id);
  if (targetId === selfId) {
    throw new HttpError(400, "A chain cannot ride back to its sender.");
  }
  return { targetId, targetName: String(target.username) };
}

// The pool pick: a server the two members share; the send's fallback is the
// sender's own membership; the no-membership corner (fresh DM-only pairs)
// banks the fee at the marker pool 0 (migration 0030's noted seat) — the fee
// still leaves circulation either way.
async function chainPoolServer(env, aId, bId) {
  const shared = (await env.GOOBER_DB.prepare(SHARED_SERVER_READ_SQL)
    .bind(aId, bId).all()).results || [];
  if (shared.length > 0) return Number(shared[0].server_id);
  if (aId === bId) return 0;
  const own = (await env.GOOBER_DB.prepare(OWN_SERVER_READ_SQL)
    .bind(aId).all()).results || [];
  return own.length > 0 ? Number(own[0].server_id) : 0;
}

// POST /api/coins/chain { to, amount } — the anonymous chain gift. ONE batch:
// the gift spend (− amount, chain_gift, no related identity), the fee spend
// (− fee, chain_fee), the fee's Campfire pool credit (the SINK law — named
// in-batch), the hop row, and the recipient's hold row. The recipient NEVER
// sees the sender: the hold maps the token to the member, nothing else does.
async function handleChainSendRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:chain:write:" + userId);
  const body = await readJson(request);

  const amount = body && body.amount;
  if (!Number.isInteger(amount) || amount < GC_CHAIN_MIN_AMOUNT || amount > GC_CHAIN_MAX_AMOUNT) {
    throw new HttpError(400, "That gift amount is invalid.");
  }
  const { targetId } = await chainTarget(env, body && body.to, userId);
  const fee = chainFee(amount);
  const now = nowSeconds();
  const hopToken = randomToken(32);
  const poolServerId = await chainPoolServer(env, userId, targetId);

  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(CHAIN_SEND_SPEND_SQL).bind(userId, -amount, now, userId, amount + fee),
    env.GOOBER_DB.prepare(CHAIN_FEE_SPEND_SQL).bind(userId, -fee, now, userId, fee),
    campfirePoolCreditStatement(env.GOOBER_DB, poolServerId, fee, now),
    env.GOOBER_DB.prepare(CHAIN_HOP_INSERT_SQL).bind(
      hopToken, 1, amount, poolServerId, now + GC_CHAIN_HOP_TTL_SECONDS, now,
    ),
    env.GOOBER_DB.prepare(CHAIN_HOLD_INSERT_SQL).bind(hopToken, targetId, now),
  ]);
  const spent = results[0] && Number(results[0].meta?.changes) === 1;
  if (!spent) {
    throw new HttpError(400, "Not enough Goober Coins for that.");
  }
  // The hop's coins never lose their anonymity either way: the statements
  // named no member column — a refused spend refuses only the spend.
  return json({ sent: true, amount, fee });
}

// GET /api/coins/chains — the member's pending hops, then the lazy expiry
// sweep (an out-of-TTL hop converts to keep on this read: the coins land,
// the hop goes, no fee). The page carries token/amount/depth/expiresAt and
// NOTHING about a sender — the join names gc_chain_hold, never users.
async function handleChainsReadRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "read", "coins:chain:read:" + userId);
  const now = nowSeconds();

  // The expiry conversion rides the SAME keep-conversion the explicit keep
  // route uses (one batch per hop: the mint, the hop delete, the hold delete).
  const expired = (await env.GOOBER_DB.prepare(CHAIN_EXPIRED_READ_SQL)
    .bind(userId, now).all()).results || [];
  for (const hop of expired) {
    const token = String(hop.hop_token);
    await env.GOOBER_DB.batch([
      env.GOOBER_DB.prepare(CHAIN_KEEP_MINT_SQL).bind(
        userId, Number(hop.amount), now, token, userId,
      ),
      env.GOOBER_DB.prepare(CHAIN_DELETE_HOP_SQL).bind(token),
      env.GOOBER_DB.prepare(CHAIN_DELETE_HOLD_SQL).bind(token),
    ]);
  }

  const page = (await env.GOOBER_DB.prepare(CHAIN_INBOX_READ_SQL)
    .bind(userId).all()).results || [];
  return json({
    hops: page.map((hop) => ({
      token: String(hop.hop_token),
      amount: Number(hop.amount),
      depth: Number(hop.depth),
      expiresAt: Number(hop.expires_at),
    })),
  });
}

// The keep conversion (route + the read-side sweep): the hop's amount lands
// as ONE positive chain_gift row for the holder, the chain ENDS (no fee —
// the fee rode the send), and both the hop row and the hold row go.
async function handleChainKeepRoute(request, env, token) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:chain:write:" + userId);
  const now = nowSeconds();

  const hop = await env.GOOBER_DB.prepare(CHAIN_HOP_READ_SQL).bind(token, userId).first();
  if (!hop) throw new HttpError(404, "That chain hop does not exist.");
  await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(CHAIN_KEEP_MINT_SQL).bind(
      userId, Number(hop.amount), now, token, userId,
    ),
    env.GOOBER_DB.prepare(CHAIN_DELETE_HOP_SQL).bind(token),
    env.GOOBER_DB.prepare(CHAIN_DELETE_HOLD_SQL).bind(token),
  ]);
  return json({ kept: true, amount: Number(hop.amount) });
}

// POST /api/coins/chain/:token/pass { to } — pay it forward: the NEW fee
// banks to the shared campfire, the carried coins shrink by it, the old hop
// and its hold die, the new hop + hold ride in the same batch. Depth caps at
// GC_CHAIN_DEPTH_MAX (the pass at the cap is a 400); the floor amount keeps
// the chain from decaying into dust; every ledger row stays identity-free.
async function handleChainPassRoute(request, env, token) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:chain:write:" + userId);
  const body = await readJson(request);

  const now = nowSeconds();
  const hop = await env.GOOBER_DB.prepare(CHAIN_HOP_READ_SQL).bind(token, userId).first();
  if (!hop) throw new HttpError(404, "That chain hop does not exist.");
  const depth = Number(hop.depth);
  const ridingAmount = Number(hop.amount);
  if (depth >= GC_CHAIN_DEPTH_MAX) {
    throw new HttpError(400, "This chain has gone as deep as it goes.");
  }
  const { targetId } = await chainTarget(env, body && body.to, userId);
  const fee = chainFee(ridingAmount);
  const carriedAmount = ridingAmount - fee;
  if (carriedAmount < GC_CHAIN_MIN_AMOUNT) {
    throw new HttpError(400, "What rides the chain has worn too thin.");
  }
  const poolServerId = await chainPoolServer(env, userId, targetId);
  const newToken = randomToken(32);

  await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(CHAIN_DELETE_HOLD_SQL).bind(token),
    env.GOOBER_DB.prepare(CHAIN_DELETE_HOP_SQL).bind(token),
    env.GOOBER_DB.prepare(CHAIN_FEE_SPEND_SQL).bind(userId, -fee, now, userId, fee),
    campfirePoolCreditStatement(env.GOOBER_DB, poolServerId, fee, now),
    env.GOOBER_DB.prepare(CHAIN_HOP_INSERT_SQL).bind(
      newToken, depth + 1, carriedAmount, poolServerId, now + GC_CHAIN_HOP_TTL_SECONDS, now,
    ),
    env.GOOBER_DB.prepare(CHAIN_HOLD_INSERT_SQL).bind(newToken, targetId, now),
  ]);
  return json({
    passed: true,
    depth: depth + 1,
    amount: carriedAmount,
    fee,
  });
}

export async function handleCoinRoutes(request, env, url, path, method) {
  if (path === "/api/coins" && method === "GET") {
    return handleCoinsReadRoute(request, env);
  }
  if (path === "/api/coins/shop" && method === "GET") {
    return handleCoinsShopRoute(request, env);
  }
  if (path === "/api/coins/cosmetics" && method === "POST") {
    return handleCosmeticBuyRoute(request, env);
  }
  if (path === "/api/coins/ledger" && method === "GET") {
    return handleLedgerReadRoute(request, env, url);
  }
  if (path === "/api/coins/claim" && method === "POST") {
    return handleClaimRoute(request, env);
  }
  if (path === "/api/coins/voice/tick" && method === "POST") {
    return handleVoiceTickRoute(request, env);
  }
  if (path === "/api/coins/chain" && method === "POST") {
    return handleChainSendRoute(request, env);
  }
  if (path === "/api/coins/chains" && method === "GET") {
    return handleChainsReadRoute(request, env);
  }
  const chainActionMatch = method === "POST"
    ? path.match(/^\/api\/coins\/chain\/([A-Za-z0-9_-]{1,64})\/(keep|pass)$/)
    : null;
  if (chainActionMatch) {
    return chainActionMatch[2] === "keep"
      ? handleChainKeepRoute(request, env, chainActionMatch[1])
      : handleChainPassRoute(request, env, chainActionMatch[1]);
  }
  if (path === "/api/plus/renew" && method === "POST") {
    return handleRenewRoute(request, env);
  }
  if (path === "/api/plus/gift" && method === "POST") {
    return handleGiftRoute(request, env);
  }
  return undefined;
}
