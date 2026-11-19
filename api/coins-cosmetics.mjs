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

// T-R25-SPLIT-COINS-1: the cosmetics family off api/coins.mjs. The
// cosmetic sink's buy route + the 0056 inventory slate (purchase, equip,
// unequip arm, consume) move VERBATIM with their SQL fragments: the sink
// pair (COSMETIC_LEDGER_SPEND_SQL / COSMETIC_OWNERSHIP_INSERT_SQL /
// COSMETIC_LEGACY_SPEND_HEAD_SQL) and the inventory family's own fragments
// (INVENTORY_SPEND/OWN/BUMP_SQL + the probe + the equip/unequip/consume
// set). The mirrors-comment idiom: a guard change must be re-mirrored and
// the parity tests pin the copies' behavior. The shop-shared reads +
// shaping (OWNERSHIP_READ_SQL / INVENTORY_READ_SQL / publicCosmeticItems /
// publicInventoryRow / inventoryShape / discountedPrice /
// SPEND_NONCE_BYTES) stay ONE implementation in coins.mjs, never copied.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds, randomToken } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import {
  GC_COSMETIC_BANNER_PRICE,
  GC_COSMETIC_FLAIR_PRICE,
  GC_COSMETIC_PACK_PRICE,
  GC_COSMETIC_FX_BURST_ITEM,
  GC_COSMETIC_FX_BURST_USES,
  GC_COSMETIC_INVENTORY_SKUS,
} from "../constants.mjs";
import { plusPerkActive } from "./plus.mjs";

// The shop-shared machinery stays ONE implementation in api/coins.mjs —
// imported at CALL time (the circular import stays inert — every use
// lives inside a function body, no module-scope const reference; the
// T-R25-SPLIT-SERVERS-1 lesson).
import {
  BALANCE_READ_SQL,
  OWNERSHIP_READ_SQL,
  INVENTORY_READ_SQL,
  publicCosmeticItems,
  publicInventoryRow,
  inventoryShape,
  discountedPrice,
  SPEND_NONCE_BYTES,
} from "./coins.mjs";

// --- the moved region (verbatim out of api/coins.mjs @ 90ca40e) ------------

// The cosmetic sink (the economy re-rule): one atomic batch per purchase — the
// negative ledger row and the ownership row, BOTH guarded by the sufficient-
// coins arm, and the ownership INSERT additionally by its own NOT EXISTS (a
// re-spend is the 409, never a second row). The caller's tier's price rides
// as a bind; the pack is two ownership INSERTs and one ledger row.
const COSMETIC_LEDGER_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce) " +
  "SELECT ?, ?, ?, ?, ? " +
  "WHERE (SELECT COALESCE(SUM(le4.delta), 0) FROM gc_coin_ledger le4 " +
    "WHERE le4.user_id = ?) >= ? LIMIT 1";

const COSMETIC_OWNERSHIP_INSERT_SQL =
  "INSERT INTO gc_cosmetic_ownership (user_id, item, purchased_at) " +
  "SELECT ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_coin_ledger cl WHERE cl.user_id = ? " +
    "AND cl.source = ? AND cl.delta = ? AND cl.created_at = ? " +
    "AND cl.spend_nonce = ?) " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_cosmetic_ownership ow WHERE ow.user_id = ? AND ow.item = ?" +
  ")";

// The legacy shop's spend is the GUARDED CLAIM (the c11 fix): the NOT-
// EXISTS-ownership arm rides INSIDE the INSERT — the same idiom the 0056
// inventory spend uses — because zero-changes does NOT abort a D1 batch.
// On the unguarded statement a re-buy minted its spend row anyway (the
// ownership INSERT's own NOT EXISTS silently answered changes = 0) and the
// 409 drained the coin. A refused re-buy now loses its race IN the spend:
// nothing drains, nothing persists, and the ownership INSERT — a fingerprint
// consumer of the spend row — mints nothing off a spend that never landed.
const COSMETIC_LEGACY_SPEND_HEAD_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce) " +
  "SELECT ?, ?, ?, ?, ? " +
  "WHERE (SELECT COALESCE(SUM(le4.delta), 0) FROM gc_coin_ledger le4 " +
    "WHERE le4.user_id = ?) >= ? " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_cosmetic_ownership ow WHERE ow.user_id = ? AND ow.item IN (";
// The cosmetic INVENTORY (0056, the 2026-11-19 cosmetics v1 slate): the
// purchase pair rides the SAME claim idiom, but the spend row is the
// GUARDED CLAIM itself — its arms are the sufficient-coins check, the NOT-
// EXISTS-ownership arm (a re-buy loses the race INSIDE the spend, so the
// 409 can never drain the coin or persist a spend), and (for the per-server
// channel-banner SKU) the membership arm riding INSIDE the INSERT like the
// voice tick's. The second statement is the fingerprint consumer: the
// inventory row only ever lands on the spend row THIS batch minted (the
// THIS-request nonce, 0058 — a same-second refusal echoes nothing). The
// consumable's bump stacks one pack onto the SAME (user_id, item_key) row —
// the recurring sink is a bump, never a second row.
const INVENTORY_SPEND_SQL =
  "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce) " +
  "SELECT ?, ?, ?, ?, ? " +
  "WHERE (SELECT COALESCE(SUM(le4.delta), 0) FROM gc_coin_ledger le4 " +
    "WHERE le4.user_id = ?) >= ? " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_cosmetic_inventory iv WHERE iv.user_id = ? AND iv.item_key = ?" +
  ") " +
  "AND (? IS NULL OR EXISTS (" +
    "SELECT 1 FROM gc_server_members sm WHERE sm.server_id = ? AND sm.user_id = ?" +
  ")) LIMIT 1";

const INVENTORY_OWN_SQL =
  "INSERT INTO gc_cosmetic_inventory (user_id, item_key, kind, qty, equipped, server_id, created_at, updated_at) " +
  "SELECT ?, ?, 'own', 1, 0, ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_coin_ledger cl WHERE cl.user_id = ? " +
    "AND cl.source = ? AND cl.delta = ? AND cl.created_at = ? " +
    "AND cl.spend_nonce = ?) " +
  "AND NOT EXISTS (" +
    "SELECT 1 FROM gc_cosmetic_inventory iv WHERE iv.user_id = ? AND iv.item_key = ?" +
  ")";

const INVENTORY_BUMP_SQL =
  "INSERT INTO gc_cosmetic_inventory (user_id, item_key, kind, qty, equipped, server_id, created_at, updated_at) " +
  "SELECT ?, ?, 'consumable', ?, 0, NULL, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_coin_ledger cl WHERE cl.user_id = ? " +
    "AND cl.source = ? AND cl.delta = ? AND cl.created_at = ? " +
    "AND cl.spend_nonce = ?) " +
  "ON CONFLICT(user_id, item_key) DO UPDATE SET qty = qty + ?, updated_at = ?";
const INVENTORY_OWNED_PROBE_SQL =
  "SELECT qty FROM gc_cosmetic_inventory " +
  "WHERE user_id = ? AND item_key = ? LIMIT 1";

// The post-batch classification probe (the after-the-fact house style): one
// indexed pair read, answering "is this member seated in this server".
const INVENTORY_MEMBERSHIP_SQL =
  "SELECT 1 FROM gc_server_members sm WHERE sm.server_id = ? AND sm.user_id = ?";

// The equip arm: TWO statements in ONE batch (one transaction) — clear the
// slot's own SKUs, then set the picked row. The slot's SKU list rides as the
// IN-list binds (constants.mjs's list, prefix-sharded route-side); "one
// equipped per slot" is this ROUTE-SIDE arm, never a trigger.
const INVENTORY_EQUIP_CLEAR_SQL =
  "UPDATE gc_cosmetic_inventory SET equipped = 0, updated_at = ? " +
  "WHERE user_id = ? AND item_key IN (";

const INVENTORY_EQUIP_SET_SQL =
  "UPDATE gc_cosmetic_inventory SET equipped = 1, updated_at = ? " +
  "WHERE user_id = ? AND item_key = ?";

// The unequip arm (the UX lane's rider): ONE verdict-gated row clear — the
// equipped arm rides INSIDE the WHERE, so an already-unequipped row is
// changes = 0 and the route's 404. Never a slot walk: the row IS the
// target (no IN-list, no sibling reads).
const INVENTORY_UNEQUIP_SQL =
  "UPDATE gc_cosmetic_inventory SET equipped = 0, updated_at = ? " +
  "WHERE user_id = ? AND item_key = ? AND equipped = 1";

// The unequip verdict's shared 404: a row the caller does not hold and a row
// already sitting unequipped read the same — the guarded write IS the whole
// classification.
const INVENTORY_UNEQUIP_404 = "Cosmetic not found.";

// The consumable use (economy-skill law 3): ONE guarded UPDATE — the qty > 0
// arm IS the claim, so two racing uses can never both clear a one-use pack,
// and a loser is changes = 0 with the ORIGINAL ROW SURVIVING (never deleted,
// never negative — the CHECK floor and the WHERE floor hold). A missing row
// is the buy-first refusal at the route's pre-check.
const INVENTORY_CONSUME_SQL =
  "UPDATE gc_cosmetic_inventory SET qty = qty - 1, updated_at = ? " +
  "WHERE user_id = ? AND item_key = ? AND kind = 'consumable' AND qty > 0";
// The cosmetic SINK's one write route (the economy re-rule): buy banner,
// flair, the pack — or, since 0056 (the 2026-11-19 cosmetics v1 slate), one
// of the inventory SKUs (consumable burst packs, frames, the per-server
// channel-banner skin). The tier's price (50% off for an ACTIVE term on
// banner/flair; the pack flat, plus-only; the v1 SKUs at their tier) is
// computed ROUTE-SIDE per the owner's amendment, and the batch's guards
// carry the balance + NOT-EXISTS-ownership + (for the pack) the plus gate
// into the statements; the v1 SKUs ride their own batch builder below.
async function handleCosmeticBuyRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:cosmetic:" + userId);
  const body = await readJson(request);
  const perks = await plusPerkActive(env, userId, nowSeconds());

  const item = body && body.item;
  const sku = typeof item === "string" ? inventoryShape(item) : null;
  if (sku !== null) {
    return purchaseInventoryCosmetic(env, userId, sku, perks, body);
  }
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
  // THIS batch's own fingerprint nonce (0058): the ownership INSERTs match
  // only the spend row THIS request minted — a same-second refusal echoes
  // nothing.
  const nonce = randomToken(SPEND_NONCE_BYTES);

  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      COSMETIC_LEGACY_SPEND_HEAD_SQL + items.map(() => "?").join(", ") + ")) LIMIT 1",
    ).bind(
      userId, -price, source, now, nonce,
      userId,
      price,
      userId,
      ...items,
    ),
    ...items.map((owned) =>
      env.GOOBER_DB.prepare(COSMETIC_OWNERSHIP_INSERT_SQL).bind(
        userId, owned, now,
        userId, source, -price, now, nonce,
        userId, owned,
      )),
  ]);

  const bought = results.slice(1).every((r) => Number(r?.meta?.changes) === 1);
  if (!bought) {
    // Classified after the fact, one probe: the classify reads the standing
    // state a refused batch NEVER moved — insufficient coins is the spend
    // refusal's copy, anything else is the ownership one. The batch is not
    // "atomic by abort": zero-changes does NOT abort a D1 batch — the LAW is
    // that the spend itself is the refused claim, so the drain-and-classify
    // order the unguarded statement relied on cannot mislabel a real D1 run
    // (the probe's balance is the standing, undrained one).
    const balanceRow = await env.GOOBER_DB.prepare(BALANCE_READ_SQL).bind(userId).first();
    if ((Number(balanceRow?.balance) || 0) < price) {
      throw new HttpError(400, "Not enough Goober Coins for that.");
    }
    throw new HttpError(409, "You already own that cosmetic.");
  }
  const ownership = (await env.GOOBER_DB.prepare(OWNERSHIP_READ_SQL).bind(userId).all()).results || [];
  const inventoryRows = (await env.GOOBER_DB.prepare(INVENTORY_READ_SQL).bind(userId).all()).results || [];
  return json({
    bought: true,
    cost: price,
    items: publicCosmeticItems(ownership.map((row) => String(row.item || "")), perks, inventoryRows),
    inventory: inventoryRows.map(publicInventoryRow),
  });
}

// The 0056 inventory purchase (the 2026-11-19 slate's recurring sink): the
// kind picks the batch. A CONSUMABLE's spend is the plain balance-guarded
// claim (a re-buy IS the business: the ON-CONFLICT bump stacks one pack
// onto the same PK row); an OWN item's spend is the guarded claim with the
// NOT-EXISTS-ownership + membership arms INSIDE the INSERT, so a re-buy
// loses the race in the spend and never drains the coin. Both second
// statements are fingerprint consumers — the inventory row only ever lands
// on the spend row THIS batch minted, so a skipped spend mints nothing.
async function purchaseInventoryCosmetic(env, userId, sku, perks, body) {
  const now = nowSeconds();
  const serverId = inventoryServerId(sku, body);
  const cost = discountedPrice(sku.price, perks);
  const source = "cosmetic";
  const consumable = sku.kind === "consumable";
  // THIS batch's own fingerprint nonce (0058): the inventory INSERT matches
  // only the spend row THIS request minted.
  const nonce = randomToken(SPEND_NONCE_BYTES);
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(consumable ? COSMETIC_LEDGER_SPEND_SQL : INVENTORY_SPEND_SQL).bind(
      userId, -cost, source, now, nonce,
      userId,
      cost,
      ...(!consumable ? [userId, sku.itemKey, serverId, serverId, userId] : [])),
    consumable
      ? env.GOOBER_DB.prepare(INVENTORY_BUMP_SQL).bind(
          userId, sku.itemKey, GC_COSMETIC_FX_BURST_USES, now, now,
          userId, source, -cost, now, nonce,
          GC_COSMETIC_FX_BURST_USES, now)
      : env.GOOBER_DB.prepare(INVENTORY_OWN_SQL).bind(
          userId, sku.itemKey, serverId, now, now,
          userId, source, -cost, now, nonce,
          userId, sku.itemKey),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) {
    await inventoryPurchaseRefusal(env, userId, sku, serverId);
  }
  const [owners, inventoryRows] = await Promise.all([
    env.GOOBER_DB.prepare(OWNERSHIP_READ_SQL).bind(userId).all(),
    env.GOOBER_DB.prepare(INVENTORY_READ_SQL).bind(userId).all(),
  ]);
  return json({
    bought: true,
    cost,
    items: publicCosmeticItems((owners.results || []).map((row) => String(row.item || "")), perks, inventoryRows.results || []),
    inventory: (inventoryRows.results || []).map(publicInventoryRow),
  });
}

// The per-server SKU's serverId (the channel-banner family): a missing or
// malformed one is a 400 BEFORE any write, and any other kind carries none.
function inventoryServerId(sku, body) {
  if (sku.slot !== "channel_banner") return null;
  const serverId = body && body.serverId;
  if (typeof serverId !== "number" || !Number.isInteger(serverId) || serverId <= 0) {
    throw new HttpError(400, "Choose the server this banner skin is for.");
  }
  return serverId;
}

// The after-the-fact house classification for a refused purchase batch:
// already-owned is the 409, a foreign server is the 403, everything else is
// the insufficient-coins copy. Nothing persisted either way (the spend
// itself was the refused claim). A CONSUMABLE skips the owned probe — its
// re-buy stacks by design, so its only refusal is the balance arm.
async function inventoryPurchaseRefusal(env, userId, sku, serverId) {
  if (sku.kind !== "consumable") {
    const owned = await env.GOOBER_DB.prepare(INVENTORY_OWNED_PROBE_SQL)
      .bind(userId, sku.itemKey).first();
    if (owned) throw new HttpError(409, "You already own that cosmetic.");
  }
  if (serverId !== null) {
    const seated = await env.GOOBER_DB.prepare(INVENTORY_MEMBERSHIP_SQL)
      .bind(serverId, userId).first();
    if (!seated) throw new HttpError(403, "You are not a member of that server.");
  }
  throw new HttpError(400, "Not enough Goober Coins for that.");
}

// The equip arm (one equipped per slot, never a trigger): the row's
// ownership is probed FIRST (a lost equip must never clear the slot's
// standing state), then ONE batch — clear the slot's SKUs, set the picked
// row. The response echoes the standing inventory either way.
//
// The unequip arm rides the SAME route as the body's `unequip: true` flag
// (the smaller diff: one session/rate-limit/body surface, no second wire —
// "/api/coins/cosmetics/unequip" stays a 404). It is the consumable's
// refusal shape: only an 'own' row unequips (the burst pack keeps its equip
// arm for the effects slot), and ONE guarded UPDATE clears the picked row —
// equipped = 1 is the WHERE arm, never a slot walk.
async function handleCosmeticEquipRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:cosmetic-equip:" + userId);
  const body = await readJson(request);
  const sku = typeof body?.itemKey === "string" ? inventoryShape(body.itemKey) : null;
  if (!sku) throw new HttpError(400, "That cosmetic is not in the shop.");
  if (body?.unequip === true) return handleCosmeticUnequipArm(sku, env, userId);
  // The kind guard: slots carry 'own' items — with ONE admitted exception (the
  // 2026-11-19 slate's Phase 3): the effects slot's pack IS the equip surface,
  // because the reaction route's burst arm spends only the EQUIPPED row. The
  // equip stays the slot's standing state ride (clear the slot's own SKUs, set
  // the picked row) — a consumable equipped here never changes qty, only the
  // auto-spend arm's visibility.
  if (sku.kind !== "own" && sku.itemKey !== GC_COSMETIC_FX_BURST_ITEM) {
    throw new HttpError(400, "That cosmetic is a consumable pack.");
  }

  const owned = await env.GOOBER_DB.prepare(INVENTORY_OWNED_PROBE_SQL)
    .bind(userId, sku.itemKey).first();
  if (!owned) throw new HttpError(403, "Buy that cosmetic in the coin shop first.");
  // The empty-pack guard (the low-4 wart): an admitted consumable row with no
  // uses left never becomes the slot's standing state — the refusal is
  // PRE-batch, so a lost equip leaves no orphan echo of a batch that never
  // ran (the empty-pack copy is the same 409 the consume arm pins).
  if (sku.kind !== "own" && Number(owned.qty) < 1) {
    throw new HttpError(409, "That pack is empty.");
  }

  const now = nowSeconds();
  const slotSkus = GC_COSMETIC_INVENTORY_SKUS
    .map((entry) => inventoryShape(entry.itemKey))
    .filter((shape) => shape.slot === sku.slot)
    .map((shape) => shape.itemKey);
  await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      INVENTORY_EQUIP_CLEAR_SQL + slotSkus.map(() => "?").join(", ") + ")",
    ).bind(now, userId, ...slotSkus),
    env.GOOBER_DB.prepare(INVENTORY_EQUIP_SET_SQL).bind(now, userId, sku.itemKey),
  ]);
  const inventoryRows = (await env.GOOBER_DB.prepare(INVENTORY_READ_SQL).bind(userId).all()).results || [];
  return json({ equipped: true, itemKey: sku.itemKey, inventory: inventoryRows.map(publicInventoryRow) });
}

// The unequip arm's body: ONE guarded UPDATE (the verdict), the echoed
// inventory either way — the route's own read, never a client-side guess.
async function handleCosmeticUnequipArm(sku, env, userId) {
  if (sku.kind !== "own") throw new HttpError(400, "That cosmetic is a consumable pack.");
  const result = await env.GOOBER_DB.prepare(INVENTORY_UNEQUIP_SQL)
    .bind(nowSeconds(), userId, sku.itemKey)
    .run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(404, INVENTORY_UNEQUIP_404);
  }
  const inventoryRows = (await env.GOOBER_DB.prepare(INVENTORY_READ_SQL).bind(userId).all()).results || [];
  return json({ unequipped: true, itemKey: sku.itemKey, inventory: inventoryRows.map(publicInventoryRow) });
}

// The consumable use (economy-skill law 3): ONE guarded UPDATE — the qty > 0
// arm IS the claim, a loser is changes = 0 with the original row surviving.
// Classified after the fact: an unowned pack is the buy-first 403, an
// empty one the come-back-with-a-fresh-pack 409.
async function handleCosmeticConsumeRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "coins:cosmetic-consume:" + userId);
  const body = await readJson(request);
  const sku = typeof body?.itemKey === "string" ? inventoryShape(body.itemKey) : null;
  if (!sku) throw new HttpError(400, "That cosmetic is not in the shop.");
  // The kind gate (the c11 fix): only 'consumable' rows ride the use arm —
  // an 'own' SKU's consume would ride the UPDATE's kind = 'consumable' arm
  // to changes = 0 and the post-hoc probe would mislabel it the empty-pack
  // 409. The copy is the kind's own shape, the equip/unequip arms' register.
  if (sku.kind !== "consumable") {
    throw new HttpError(400, "That cosmetic is not a consumable pack.");
  }

  const result = await env.GOOBER_DB
    .prepare(INVENTORY_CONSUME_SQL)
    .bind(nowSeconds(), userId, sku.itemKey)
    .run();
  if (Number(result.meta?.changes) !== 1) {
    const owned = await env.GOOBER_DB.prepare(INVENTORY_OWNED_PROBE_SQL)
      .bind(userId, sku.itemKey).first();
    if (!owned) throw new HttpError(403, "Buy that cosmetic in the coin shop first.");
    throw new HttpError(409, "That pack is empty.");
  }
  const inventoryRows = (await env.GOOBER_DB.prepare(INVENTORY_READ_SQL).bind(userId).all()).results || [];
  return json({ used: true, inventory: inventoryRows.map(publicInventoryRow) });
}
// The cosmetics dispatcher (the family's arms cut VERBATIM from
// api/coins.mjs's dispatcher — the forward in coins.mjs sits at the buy
// arm's original position and hands the WHOLE family here).
export async function handleCosmeticsRoutes(request, env, path, method) {
  if (path === "/api/coins/cosmetics" && method === "POST") {
    return handleCosmeticBuyRoute(request, env);
  }
  if (path === "/api/coins/cosmetics/equip" && method === "POST") {
    return handleCosmeticEquipRoute(request, env);
  }
  if (path === "/api/coins/cosmetics/consume" && method === "POST") {
    return handleCosmeticConsumeRoute(request, env);
  }
  return undefined;
}
