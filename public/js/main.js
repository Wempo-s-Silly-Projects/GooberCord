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

// The boot. Order is the contract (each step depends on the last):
//   1. the legacy "#/route" fragment, if any, becomes the equal path (the
//      router is History-API based; old deep links were hash-based);
//   2. the session: /api/me -> store (a failure boots as signed out);
//   3. the landing gate (ui/landing.js) — redeem or redirect before ANY
//      route renders;
//   4. the router mounts the shell (or whatever the address points at);
//   5. the stale-build check: the served document's <meta name="app-build">
//      stamp is compared against the live /api/version every 60s; a deployed
//      successor offers a reload instead of old JS quietly talking to a
//      newer backend.
import { api, setCsrfToken, AUTH_EVENT } from "./core/api.js";
import store from "./core/store.js";
import * as router from "./core/router.js";
import {
  appearance, homeRoute, serverPlaceholder,
} from "./ui/shell.js";
import { ensureSignedIn, wempoAccountsSignInUrl } from "./ui/landing.js";
import { renderMemberCard } from "./ui/members.js";
import { renderSocialHub } from "./ui/social.js";
// The chat wave owns the "channel" and "conversation" seats now (the
// placeholders' names stay — re-registration by name is the contract).
import { renderChannelPane, renderConversation, renderChannelPins, renderServerSearch } from "./ui/chat.js";
import {
  renderServerSettings, renderServerChannels, renderServerRoles, renderServerRole,
  renderServerInvites, renderOverwrites, renderJoin,
} from "./ui/settings.js";
import { renderMentions } from "./ui/mentions.js";
import { renderExpressions, renderExpressionCreate } from "./ui/expressions.js";
import { renderShop } from "./ui/economy.js";
import { renderModDesk, renderFilterRule, renderStaffQueue } from "./ui/mod.js";
import { startPresenceBeats } from "./core/ws.js";
import { initI18n, t } from "./i18n.js";

const STALE_CHECK_INTERVAL_MS = 60000;

// compareBuild(metaStamp, versionPayload) -> { stale }
// The stamp is "VERSION@COMMIT_SHA"; /api/version echoes {version, build}
// verbatim. An empty side (a dev boot without the vars) never flags.
export function compareBuild(metaStamp, versionPayload) {
  const stamp = String(metaStamp || "").trim();
  const version = String(versionPayload?.version || "").trim();
  const build = String(versionPayload?.build || "").trim();
  if (!stamp || !version) return { stale: false };
  if (build) return { stale: stamp !== version + "@" + build };
  // No build component (dev): compare the version part only — the stamp may
  // carry the same version with an empty tail.
  return { stale: (stamp.split("@", 1)[0] || stamp) !== version };
}

function readMetaStamp(doc) {
  const meta = doc.querySelector('meta[name="app-build"]');
  return meta?.content || "";
}

export function buildStaleStrip(doc) {
  const strip = doc.createElement("div");
  strip.id = "stale-build-strip";
  strip.hidden = true;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "button button-quiet";
  button.textContent = t("gc.boot.stale.reload");
  button.addEventListener("click", () => win.location.reload());
  strip.append(t("gc.boot.stale.available") + " ", button);
  return strip;
}

// The live window/document, captured at boot (node imports these as null —
// the boot-free exports pin without a browser).
let win = globalThis.window ?? null;
let doc = globalThis.document ?? null;

async function checkBuildOnce() {
  try {
    const payload = await api("/api/version");
    if (compareBuild(readMetaStamp(doc), payload).stale) {
      doc.getElementById("stale-build-strip")?.removeAttribute("hidden");
    }
  } catch {
    // A failed version fetch is no signal; the next tick retries.
  }
}

export function startStaleChecks() {
  checkBuildOnce();
  win.setInterval(checkBuildOnce, STALE_CHECK_INTERVAL_MS);
}

// The auth-expiry signal: exactly one listener, registered here (only main
// registers), which sends the open to the Accounts sign-in. Registration
// happens AFTER the landing gate has settled, so the redeem's own 401s
// (refused ticket, network) stay silent instead of redirect-looping.
function registerUnauthorizedHandler() {
  store.on(AUTH_EVENT, () => {
    win.location.replace(wempoAccountsSignInUrl(win.location.origin));
  });
}

async function boot({ doc: bootDoc = document, win: bootWin = window } = {}) {
  doc = bootDoc;
  win = bootWin;

  // 1. Legacy deep links: "#/join/CODE" arrives as a fragment; the router
  //    wants paths. One replaceState, then the fragment is gone for good.
  const legacy = win.location.hash.startsWith("#/");
  if (legacy) {
    win.history.replaceState(null, "", win.location.hash.slice(1) + win.location.search);
  }

  // 2. The session (an unreachable backend boots as signed out).
  try {
    const session = await api("/api/me");
    setCsrfToken(session?.csrfToken || "");
    store.set({ user: session?.user || null, csrfToken: session?.csrfToken || "" });
  } catch {
    setCsrfToken("");
    store.set({ user: null, csrfToken: "" });
  }

  // 3. The gate: redeem the SSO ticket or leave for Accounts. A refusal
  //    card ends the boot; "signed-in" or "redirected" decides what follows.
  appearance.applyAppearance(doc, win.localStorage);
  // The locale lane (en-first): the bundle loads ALONGSIDE first paint and
  // never blocks the boot; a non-en swap repaints the bound copy on resolve.
  initI18n().catch(() => { /* a failed bundle leaves en, keys visible */ });
  const gate = await ensureSignedIn({ doc, win });
  if (gate === "refused") return;
  if (gate !== "signed-in") return; // "redirected": the page is leaving.

  // The socket-free presence beat (the WS heartbeat owns the channel lanes).
  startPresenceBeats(300);

  // 4. The routes: the shell carries "/" and the placeholder panes; wave
  //    builders re-register the same route names with their own renders.
  //    Specific two-segment server routes register BEFORE the generic
  //    "/:channelId" catch — resolve scans in insertion order and "roles"
  //    would match an "([^/]+)" channel slot otherwise.
  router.addRoute("/", "home", homeRoute);
  router.addRoute("/friends", "friends", renderSocialHub);
  router.addRoute("/join", "join", renderJoin);
  router.addRoute("/mentions", "mentions", renderMentions);
  router.addRoute("/dm/:id", "conversation", renderConversation);
  router.addRoute("/s/:serverId", "server", serverPlaceholder);
  router.addRoute("/s/:serverId/settings", "server-settings", renderServerSettings);
  router.addRoute("/s/:serverId/channels", "server-channels", renderServerChannels);
  router.addRoute("/s/:serverId/channels/:channelId/overwrites", "channel-overwrites", renderOverwrites);
  router.addRoute("/s/:serverId/roles", "server-roles", renderServerRoles);
  router.addRoute("/s/:serverId/roles/:roleId", "server-role", renderServerRole);
  router.addRoute("/s/:serverId/invites", "server-invites", renderServerInvites);
  // W-R3 lanes: expressions + the mod desk + the coin shop (each specific
  // route sits BEFORE the generic "/:channelId" catch — same law).
  router.addRoute("/s/:serverId/expressions/new", "expression-new", renderExpressionCreate);
  router.addRoute("/s/:serverId/expressions", "expressions", renderExpressions);
  router.addRoute("/s/:serverId/filter/rules/new", "filter-rule-new", renderFilterRule);
  router.addRoute("/s/:serverId/filter/rules/:rid", "filter-rule", renderFilterRule);
  router.addRoute("/s/:serverId/mod", "mod", renderModDesk);
  router.addRoute("/shop", "shop", renderShop);
  router.addRoute("/admin-queue", "staff-queue", renderStaffQueue);
  router.addRoute("/s/:serverId/member/:uid", "member", renderMemberCard);
  router.addRoute("/s/:serverId/:channelId/pins", "channel-pins", renderChannelPins);
  router.addRoute("/s/:serverId/search", "server-search", renderServerSearch);
  router.addRoute("/s/:serverId/:channelId", "channel", renderChannelPane);
  router.notFoundHandler(() => router.navigate("/", { replace: true }));
  store.set({ route: null });
  router.mount(doc.getElementById("app") || doc.body);

  // 5. The stale-build offer, on the interval, for the tab's whole life.
  doc.body.append(buildStaleStrip(doc));
  registerUnauthorizedHandler();
  startStaleChecks();
}

// The guard keeps a node --test importer from walking the browser boot: the
// exported boot-free pieces (compareBuild, buildStaleStrip) pin without DOM.
if (typeof window !== "undefined") {
  boot();
}
