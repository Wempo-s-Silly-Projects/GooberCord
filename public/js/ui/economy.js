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

// The economy lane — the coin snapshot as the ONLY balance source (no ledger
// summing, no client cap arithmetic), the daily claim, the shop, cosmetics
// apply, renew/gift, and the voice-tick loop (§W-R3 B). The yellow mark is
// the forum's coin color (Rethink 7): CSS classes, never images.
//   /shop  the claim, the bundles, the cosmetic items + apply, gift, ledger
// The rail footer shows the ambient balance; a refusal renders verbatim
// inline (G-2), the never-bought shape renders the "not a member" state, and
// grace shows banner + grayed perks while renewal stays allowed from grace.
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createForm, createInput } from "../vendor/designer/kit.mjs";
import { openDialog } from "../vendor/frontload/dom.mjs";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { t } from "../i18n.js";

// --- mirrored constants (G-4 pins against constants.mjs) ---------------------

export const COIN_VOICE_TICK_SECONDS = 600; // GC_COIN_VOICE_TICK_SECONDS

// --- the store lanes -----------------------------------------------------------

export async function loadCoins() {
  const snapshot = await api("/api/coins");
  store.set({ coins: snapshot });
  return snapshot;
}

// Claim: BOTH refusal arms answer the same 409 ("Already claimed today.
// Come back tomorrow." — no oracle between them); the refusal renders
// verbatim inline and the snapshot only moves on success.
export async function claimDaily() {
  const result = await api("/api/coins/claim", { method: "POST" });
  if (result && result.balance !== undefined) store.set({ coins: result });
  return result;
}

export async function loadShop() {
  const payload = await api("/api/coins/shop");
  store.set({ shop: payload });
  if (payload && payload.balance !== undefined) store.set({ coins: payload });
  return payload;
}

export async function buyCosmetic(item) {
  const result = await api("/api/coins/cosmetics", { method: "POST", body: { item } });
  await loadCoins();
  return result;
}

// POST /api/coins/cosmetics/equip — the equip arm clears the slot and sets
// the picked row; the unequip arm rides the SAME route as the body's
// `unequip: true` flag (no second wire). Either echo lands back in the
// store's shop shape through the one weld: the inventory arm verbatim, and
// the echoed rows' standing equipped state merged onto the payload's items —
// the rows re-read equipped from the route's echo on the re-render, never a
// client-side guess.
export async function equipCosmetic(itemKey) {
  const result = await api("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey },
  });
  weldShopEcho(result);
  return result;
}

// POST /api/coins/cosmetics/equip with `unequip: true` — the route's one-row
// verdict (an unequipped or lost row echoes the route's shared 404).
export async function unequipCosmetic(itemKey) {
  const result = await api("/api/coins/cosmetics/equip", {
    method: "POST", body: { itemKey, unequip: true },
  });
  weldShopEcho(result);
  return result;
}

// The echo weld: the route's echoed inventory is the only data it rides —
// the store's items take the echoed rows' equipped state (the payload's own
// shape, never re-derived); consumable rows carry no equipped state to weld.
function weldShopEcho(result) {
  const shop = store.get("shop");
  const inventory = result?.inventory;
  if (!Array.isArray(inventory) || !shop) return;
  const equippedOf = new Map(
    inventory
      .filter((row) => row.kind !== "consumable")
      .map((row) => [row.itemKey, row.equipped]),
  );
  store.set({
    shop: {
      ...shop,
      inventory,
      items: (shop.items || []).map((item) => equippedOf.has(item.item)
        ? { ...item, equipped: equippedOf.get(item.item) }
        : item),
    },
  });
}

// POST /api/me/cosmetics — GC's own apply surface (Accounts owns profile).
// `patch` carries { banner?, flair? }; absent keeps, null clears. The echo
// lands in the store's user shape (banner/flair are additive keys there).
export async function applyCosmetics(patch) {
  const result = await api("/api/me/cosmetics", { method: "PATCH", body: patch });
  const user = store.get("user");
  if (result?.cosmetics && user) {
    store.set({ user: { ...user, ...result.cosmetics } });
  }
  return result;
}

// Renew: absent tier = full ("absent body = full"). Mini vs an ACTIVE full
// term is the route's 409 — rendered verbatim; the client never pre-blocks.
export async function renewPlus(tier) {
  const result = await api("/api/plus/renew", {
    method: "POST",
    body: tier ? { tier } : undefined,
  });
  await loadCoins();
  return result;
}

// Gift — the confirm stateS the recipient's renewal terms BEFORE the commit
// (their row prices it: their first term costs full price), and the self-gift
// 400 is the route's own steering, rendered verbatim on the form.
export async function giftPlus(username) {
  const result = await api("/api/plus/gift", { method: "POST", body: { username } });
  await loadCoins();
  return result;
}

export async function loadLedger(before) {
  const path = before
    ? `/api/coins/ledger?before=${before}&limit=25`
    : "/api/coins/ledger?limit=25";
  const payload = await api(path);
  const prior = store.get("ledger") || { entries: [], nextAfter: null };
  // Cursor pagination APPENDS; a cursor replay must not duplicate (the ids
  // are the dedupe key — the same page arriving twice inserts nothing).
  const seen = new Set(prior.entries.map((entry) => entry.id));
  const entries = [...prior.entries,
    ...payload.entries.filter((entry) => !seen.has(entry.id))];
  store.set({ ledger: { entries, nextAfter: payload.nextAfter ?? null } });
  return store.get("ledger");
}

// startVoiceTicks(channelId) — the voice-earn loop. Ticks every
// windowSeconds FROM THE SNAPSHOT (G-4; the mirrored constant is the
// fallback), granted:false cases are silent routine (cap/window/foreign/
// non-member are never toasts), and only the granted case may surface, at
// most once a day. Join loss or a WS drop calls stop() — no catch-up ticks
// queue while disconnected.
//
// The catch only ever sees REJECTED tick calls — api() throws on a network
// fault or a non-2xx status — so a network/5xx failure is swallowed BUT
// surfaced one quiet console.warn per session (no DOM churn, the seat stays
// alive). A granted:false cap/gate case rides the 200 response as data and
// never reaches the catch: the silent-in-response contract is untouched.
let tickFailureSurfaced = false;
export function startVoiceTicks(channelId) {
  const snapshot = store.get("coins") || {};
  const windowSeconds = Number(snapshot.voice?.windowSeconds) > 0
    ? Number(snapshot.voice.windowSeconds)
    : COIN_VOICE_TICK_SECONDS;
  let timer = null;
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  timer = setInterval(async () => {
    try {
      const result = await api("/api/coins/voice/tick", {
        method: "POST", body: { channelId },
      });
      if (result?.balance !== undefined) store.set({ coins: result });
      if (result?.granted) onVoiceEarn();
    } catch (error) {
      if (!tickFailureSurfaced) {
        tickFailureSurfaced = true;
        const status = Number.isInteger(error?.status) ? " (" + error.status + ")" : "";
        console.warn("coins tick failed — retrying next tick" + status);
      }
      // The loop keeps its seat either way until stop() ends it.
    }
  }, windowSeconds * 1000);
  return stop;
}

// The once-a-day earn note. The store keeps the UTC day of the last granted
// tick; a second granted tick that day stays silent.
let lastVoiceEarnDay = "";
function onVoiceEarn() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastVoiceEarnDay) return;
  lastVoiceEarnDay = today;
  store.set({ voiceEarned: { day: today } });
}

// --- the shop route ------------------------------------------------------------

function inlineError() {
  return h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
}

export function renderShop(route, mount) {
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.economy.heading") })));
  mount.append(renderShell(null, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body))));
  loadShop().then((payload) => {
    body.append(
      claimPanel(payload),
      plusPanel(payload),
      itemsPanel(payload));
    // The apply panel rides OWNERSHIP (banner/flair bought) — the strict-active
    // 403s render verbatim inside it.
    if ((payload.items || []).some((item) => item.item !== "pack" && item.owned)) {
      body.append(cosmeticsPanel());
    }
    body.append(
      giftPanel(payload),
      ledgerPanel());
  }).catch((error) => {
    body.append(h("p", { class: "form-error", text: error.message }));
  });
}

function coinMark() {
  return h("span", { class: "coin-mark", "aria-hidden": "true" });
}

function coinAmount(value) {
  return h("span", { class: "coin-amount" }, coinMark(), h("span", { text: String(value) }));
}

function claimPanel(payload) {
  const errorLine = inlineError();
  const daily = payload.daily || {};
  const claim = h("button", {
    class: "button button-primary", type: "button",
    text: t("gc.economy.claim.button", { count: daily.grant ?? 25 }),
  });
  claim.addEventListener("click", async () => {
    try {
      await claimDaily();
      errorLine.textContent = "";
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message; // the shared 409, verbatim
    }
  });
  if (daily.claimedToday) claim.disabled = true;
  return h("div", { class: "panel" },
    h("h3", { text: t("gc.economy.claim.heading") }),
    h("p", { class: "count-line" }, t("gc.economy.balance"), " ", coinAmount(payload.balance),
      h("span", { text: t("gc.economy.claim.ceiling", { earned: payload.earnedToday, ceiling: payload.dailyCeiling }) })),
    claim, errorLine);
}

// The plus bundles: perks GRAY under grace (the banner dates stay), renewal
// allowed from grace, the never-bought shape renders the not-a-member state.
function plusPanel(payload) {
  const plus = payload.plus || {};
  const bundle = payload.bundle || {};
  const mini = payload.mini || {};
  const nodes = [
    h("h3", { text: "Goober+" }),
    h("p", { class: "muted", text: graceBanner(plus) || t("gc.economy.tenure.started")
      + " " + (plus.tenureStartedAt || "—") + "." }),
  ];
  if (!plus.hasPlus && !plus.active) {
    nodes.push(h("p", { class: "empty-state",
      text: t("gc.economy.plus.pitch") }));
  }
  for (const offer of [bundle, mini]) {
    if (!offer || !offer.name) continue;
    const isMini = offer === mini;
    nodes.push(h("div", { class: "offer-row" },
      h("span", { class: "offer-name", text: offer.name }),
      h("span", { class: "muted", text: t("gc.economy.offer.summary", {
        price: offer.price, renewal: offer.renewalPrice, days: offer.termDays }) }),
      h("button", {
        class: "button button-primary plus-buy", type: "button", text: t("gc.economy.buy.button"),
        onClick: () => buyDialog(offer, isMini ? "mini" : "plus"),
      })));
  }
  if (Array.isArray(bundle.perks) && plus.hasPlus) {
    nodes.push(h("ul", { class: "perk-list" },
      ...bundle.perks.map((perk) => h("li", {
        class: plus.active ? "perk perk-live" : "perk perk-gray",
        text: perk }))));
  }
  return h("div", { class: "panel" }, ...nodes);
}

function graceBanner(plus) {
  if (plus.inGrace && plus.graceUntil) {
    return t("gc.economy.plus.grace", { until: plus.graceUntil });
  }
  return null;
}

function buyDialog(offer, tier) {
  openDialog(document, {
    heading: t("gc.economy.buy.confirm", { name: offer.name }),
    body: h("p", { class: "gate-copy", text: t("gc.economy.buy.summary", {
      price: offer.price, renewal: offer.renewalPrice, days: offer.termDays }) }),
    modalOnly: true,
    actions: [
      { class: "button button-primary", text: t("gc.economy.buy.button"), onPress: async () => {
        await renewPlus(tier);
        router.renderCurrent();
      } },
      { class: "button button-quiet", text: t("gc.controls.keep") },
    ],
  });
}

// The cosmetic sink: the item rows carry ownership pre-computed route-side
// (`owned`); a buy is a commit; the apply panel rides ownership. The 0056
// inventory SKUs ride the same POST /api/coins/cosmetics path but their rows
// speak KIND (kind/qty/equipped arrive route-side, Phase 1's own shape): a
// consumable answers its remaining uses off the payload's qty (the packs
// re-stack on re-buy; the consume runtime is Phase 3, parked), an own item
// toggles its equipped state, and the plus discount shows both prices where
// the payload provides them.
function itemsPanel(payload) {
  const items = payload.items || [];
  if (items.length === 0) return h("div");
  const errorLine = inlineError();
  const rows = items.map((item) => item.kind ? inventoryRow(item, errorLine)
    : legacyItemRow(item, errorLine));
  return h("div", { class: "panel" }, h("h3", { text: t("gc.economy.items.heading") }),
    h("div", { class: "shop-items" }, ...rows), errorLine);
}

// The legacy row (banner/flair/pack): the shape verbatim.
function legacyItemRow(item, errorLine) {
  return h("div", { class: "shop-item" },
    h("span", { class: "item-name", text: item.item }),
    h("span", { class: "muted", text: item.owned ? t("gc.economy.items.owned")
      : t("gc.economy.items.cost", { count: item.cost }) }),
    !item.owned ? shopBuyButton(item, errorLine)
      : h("span", { class: "muted", text: t("gc.economy.items.owned") }));
}

// The shared buy: EVERY cosmetics buy rides the ONE route (POST
// /api/coins/cosmetics) — the v1 rows add no second wire.
function shopBuyButton(item, errorLine) {
  return h("button", {
    class: "button button-primary shop-buy row-quiet-inline", type: "button",
    text: t("gc.economy.buy.button"),
    onClick: async () => {
      try {
        await buyCosmetic(item.item);
        errorLine.textContent = "";
        router.renderCurrent();
      } catch (error) {
        errorLine.textContent = error.message; // 409/403/400 verbatim
      }
    },
  });
}

// The SKU name key: gc.economy.items.<camelCase itemKey> — the transform is
// generic (the SKU list stays constants.mjs's single source; the client
// re-declares no map).
function skuNameKey(itemKey) {
  return "gc.economy.items." + itemKey.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// The v1 inventory row: the kind speaks. For an own item the equip state
// REPLACES the price display once bought (the purchase question is answered
// at buy time); a consumable keeps its price ride-along (re-buys stack) and
// answers its remaining uses; the plus line shows both prices only where the
// payload provides a plus price that differs (never a fabricated number).
function inventoryRow(item, errorLine) {
  const nodes = [
    h("span", { class: "item-name", text: t(skuNameKey(item.item)) }),
    ...rowPrice(item),
  ];
  if (item.kind === "consumable" && item.owned) {
    nodes.push(h("span", { class: "muted item-uses",
      text: t("gc.economy.items.uses", { count: item.qty }) }));
  }
  if (item.kind === "own" && item.owned) {
    nodes.push(item.equipped
      ? [h("span", { class: "muted item-equipped", text: t("gc.economy.items.equipped") }),
        unequipButton(item, errorLine)]
      : equipButton(item, errorLine));
  } else {
    nodes.push(shopBuyButton(item, errorLine));
  }
  return h("div", { class: "shop-item" }, ...nodes);
}

// The row's price display: the plus line is the payload's own plusPrice —
// "where the payload provides them", never a client-derived number.
function rowPrice(item) {
  if (item.kind === "own" && item.owned) return [];
  const nodes = [h("span", { class: "muted", text: t("gc.economy.items.cost", { count: item.cost }) })];
  if (typeof item.plusPrice === "number" && item.plusPrice !== item.price) {
    nodes.push(h("span", { class: "muted item-plus-price",
      text: t("gc.economy.items.costPlus", { count: item.plusPrice }) }));
  }
  return nodes;
}

// The equip toggle: one equipped row per slot; the refusal (a lost row's
// 403, the kind guard's 400) renders verbatim inline.
function equipButton(item, errorLine) {
  return h("button", {
    class: "button button-quiet shop-equip row-quiet-inline", type: "button",
    text: t("gc.economy.items.equip"),
    onClick: async () => {
      try {
        await equipCosmetic(item.item);
        errorLine.textContent = "";
        router.renderCurrent();
      } catch (error) {
        errorLine.textContent = error.message; // 403 lost row / 409 empty pack / 400 kind verbatim
      }
    },
  });
}

// The unequip control (the equipped own row's ride beside the span): ONE
// verdict-gated route arm — the shared 404 (a lost or already-unequipped
// row) renders verbatim inline.
function unequipButton(item, errorLine) {
  return h("button", {
    class: "button button-quiet shop-unequip row-quiet-inline", type: "button",
    text: t("gc.economy.items.unequip"),
    onClick: async () => {
      try {
        await unequipCosmetic(item.item);
        errorLine.textContent = "";
        router.renderCurrent();
      } catch (error) {
        errorLine.textContent = error.message; // 404 lost/unequipped / 400 kind verbatim
      }
    },
  });
}

// GC OWNS the apply surface (banner/flair) — the shop's post-purchase panel.
// Strict-active plus gates SETTING (the server's 403s render verbatim);
// clearing needs no ownership.
function cosmeticsPanel() {
  const user = store.get("user");
  const errorLine = inlineError();
  const bannerBox = createInput(document, {
    id: "cosmetic-banner", label: t("gc.economy.cosmetics.borderColor"),
    value: user?.banner || "",
  });
  const flairBox = createInput(document, {
    id: "cosmetic-flair", label: t("gc.economy.cosmetics.flair"),
    value: user?.flair || "",
  });
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.economy.cosmetics.heading") }));
  const form = createForm(document, "cosmetics-apply",
    [bannerBox, flairBox], t("gc.economy.cosmetics.apply"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const banner = bannerBox.querySelector("input").value.trim();
    const flair = flairBox.querySelector("input").value.trim();
    try {
      await applyCosmetics({ banner: banner === "" ? null : banner,
        flair: flair === "" ? null : flair });
      errorLine.textContent = "";
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message; // ownership 403 / hex / flair verbatim
    }
  });
  panel.append(form, errorLine);
  return panel;
}

// Gift: the confirm carries the recipient's terms (their first term = full
// price) BEFORE the commit; the self-gift 400 is the route's steering.
function giftPanel(payload) {
  const errorLine = inlineError();
  const nameBox = createInput(document, {
    id: "gift-username", label: t("gc.economy.gift.heading"),
    description: t("gc.economy.gift.priceNote"),
  });
  const form = createForm(document, "plus-gift", [nameBox], t("gc.economy.gift.button"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = nameBox.querySelector("input").value.trim();
    openDialog(document, {
      heading: t("gc.economy.gift.confirm", { name: username || t("gc.economy.gift.unnamed") }),
      body: h("p", { class: "gate-copy", text: t("gc.economy.gift.summary") }),
      modalOnly: true,
      actions: [
        { class: "button button-primary", text: t("gc.economy.gift.button"), onPress: async () => {
          try {
            await giftPlus(username);
            errorLine.textContent = "";
            router.renderCurrent();
          } catch (error) {
            errorLine.textContent = error.message; // 404 name / self 400 / funds 400 verbatim
          }
        } },
        { class: "button button-quiet", text: t("gc.controls.keep") },
      ],
    });
  });
  return h("div", { class: "panel" }, h("h3", { text: t("gc.economy.gift.section") }), form, errorLine);
}

// The ledger: signed deltas ride the yellow mark; the cursor appends; empty
// speaks the G-5 sentence; a cursor replay never duplicates (id-keyed).
function ledgerPanel() {
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.economy.ledger.heading") }));
  const ledger = store.get("ledger");
  if (!ledger) {
    loadLedger().then(() => router.renderCurrent()).catch(() => {
      panel.append(h("p", { class: "empty-state",
        text: t("gc.economy.ledger.signInRequired") }));
    });
    return panel;
  }
  const entries = ledger.entries || [];
  if (entries.length === 0) {
    panel.append(h("p", { class: "empty-state",
      text: t("gc.economy.ledger.empty") }));
  }
  panel.append(h("div", { class: "ledger-rows" },
    ...entries.map((entry) => ledgerRow(entry))));
  if (ledger.nextAfter) {
    const more = h("button", { class: "control-quiet", type: "button",
      text: t("gc.chat.history.older") });
    more.addEventListener("click", async () => {
      try {
        await loadLedger(ledger.nextAfter);
        router.renderCurrent();
      } catch { /* failed cursor keeps the painted rows; the button stays and a later click retries */ }
    });
    panel.append(more);
  }
  return panel;
}

function ledgerRow(entry) {
  return h("div", { class: "ledger-row" },
    coinAmount(entry.delta),
    h("span", { class: "ledger-source", text: entry.source }),
    entry.relatedUsername
      ? h("span", { class: "muted", text: entry.relatedUsername })
      : null,
    h("span", { class: "muted ledger-when", text: entry.createdAt }));
}

// --- the rail footer's ambient line ---------------------------------------------

// The balance is AMBIENT: the footer line hydrates ITSELF off the store AND
// stays live (a node-local paint — never a route re-render, which would drop
// mid-edit form state): the voice-tick loop's balance arrival is a paint
// moment (the shell's one-live-seat idiom — each line drops its predecessor's
// seat). A refusal leaves the line quiet (the shop route owns the errors,
// the footer never nags).
let coinLineUnsub = null;

export function coinFooterLine() {
  const line = h("span", { class: "coin-line" });
  const paint = (coins) => {
    line.replaceChildren();
    if (!coins || typeof coins.balance !== "number") return;
    line.append(h("a", { class: "coin-balance", href: "/shop",
      title: t("gc.economy.footer.link") }, coinMark(),
      h("span", { class: "coin-balance-num", text: String(coins.balance) })));
    if (coins.daily?.claimedToday === false) {
      const claim = h("button", {
        class: "control-quiet row-quiet-inline", type: "button", text: t("gc.economy.claim.ambient"),
        onClick: async () => {
          try {
            const fresh = await claimDaily();
            paint(fresh);
          } catch (error) {
            claim.title = error.message; // the 409 rides as the title (the shop owns the inline lane)
            claim.disabled = true;
          }
        },
      });
      line.append(claim);
    }
  };
  const coins = store.get("coins");
  if (coins && typeof coins.balance === "number") {
    paint(coins);
  } else {
    // Hydrate once off the shell's own lane; the line fills silently.
    loadCoins().then(paint).catch(() => { /* the line stays quiet */ });
  }
  if (coinLineUnsub) coinLineUnsub();
  coinLineUnsub = store.subscribe("coins", (state) => paint(state.coins));
  return line;
}
