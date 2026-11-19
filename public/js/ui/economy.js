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
    } catch {
      // A failed tick is routine (cap and gate cases ride granted:false);
      // the loop keeps its seat until stop() ends it.
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
// (`owned`); a buy is a commit; the apply panel rides ownership.
function itemsPanel(payload) {
  const items = payload.items || [];
  if (items.length === 0) return h("div");
  const rows = items.map((item) => h("div", { class: "shop-item" },
    h("span", { class: "item-name", text: item.item }),
    h("span", { class: "muted", text: item.owned ? t("gc.economy.items.owned")
      : t("gc.economy.items.cost", { count: item.cost }) }),
    !item.owned ? h("button", {
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
    }) : h("span", { class: "muted", text: t("gc.economy.items.owned") })));
  const errorLine = inlineError();
  return h("div", { class: "panel" }, h("h3", { text: t("gc.economy.items.heading") }),
    h("div", { class: "shop-items" }, ...rows), errorLine);
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
      } catch { /* the cursor's 400 renders on the next paint */ }
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

// The balance is AMBIENT: the footer line hydrates ITSELF off the store (a
// node-local paint — never a route re-render, which would drop mid-edit form
// state); a refusal leaves the line quiet (the shop route owns the errors,
// the footer never nags).
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
  return line;
}
