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

// The shell — the three-pane chrome every route renders inside:
// [server rail 72px] [channel rail 260px] [main pane | members 240px]
//
// W-R1 owns the frame, the server/channel rails, the pane placeholders, the
// theme toggle, and the sign-out handoff. The wave builders inherit:
//   chat/composer -> they re-register the "channel" route (router.addRoute
//     with the same name replaces the current render) and fill the main pane;
//   members       -> they own the .members-rail body inside the shell grid;
//   social        -> they re-register "home" (or add routes) for DM/hub content.
//
// Store keys the shell reads and writes (the contract for every wave;
// W-R2 adds its lanes alongside without touching these):
//   user             the /api/me session user (set by main.js)
//   servers          the /api/servers payload list (set here)
//   activeServerId   the rail's selected server (set here)
//   activeChannelId  the selected channel within it (set here)
//   conversations    the /api/conversations list (set here, social.js loads it)
//   roster:<serverId> the /api/servers/:id/roster envelope (set by members.js)
//   mentions         the /api/mentions list (set by mentions.js; the count
//                    pill derives from the length — Rethink 10's level 3)
//   friends / blocks / status     the social hub's lanes (set by social.js)

import { h } from "../core/dom.js";
import { t } from "../i18n.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import * as router from "../core/router.js";
import { makeAppearance } from "../vendor/frontload/tokens.mjs";
import { renderRosterBody } from "./members.js";
import { loadConversations } from "./social.js";
import { loadMentions } from "./mentions.js";
import { coinFooterLine } from "./economy.js";
import { serverAdminRights } from "./settings.js";
import { wempoAccountsSignOutUrl } from "./landing.js";
import { renderBookmarksPanel } from "./bookmarks.js";
import { renderCapsulesPanel } from "./capsules.js";
import { renderReactionTagsPanel } from "./reaction-tags.js";
import { renderAnniversaryPanel } from "./anniversary.js";
import { renderFilterDesk } from "./filterdesk.js";

// The bookmarks panel: its route registers here (the shell owns the nav
// entry AND its door; main.js's route table stays untouched).
router.addRoute("/bookmarks", "bookmarks", renderBookmarksPanel);

// The capsules panel: the server-scoped page rides the same shell-owned
// wire (the wave-11 slate; main.js's route table stays untouched).
router.addRoute("/s/:serverId/capsules", "server-capsules", renderCapsulesPanel);

// The reaction-tags member panel: the server-scoped page rides the same
// shell-owned wire (the wave-13 slate; main.js's route table stays untouched).
router.addRoute("/s/:serverId/tags", "server-tags", renderReactionTagsPanel);

// The anniversary seat: the member's self-scoped page rides the same
// shell-owned wire (the wave-15 slate; main.js's route table stays untouched).
router.addRoute("/anniversary", "anniversary", renderAnniversaryPanel);

// The staff filter desk: the platform-staff page rides the same shell-owned
// wire (the wave-16 slate; main.js's route table stays untouched).
router.addRoute("/admin-filter", "staff-filter", renderFilterDesk);

// AGPL §13's source-offer rides the shell's user footer: every signed-in
// screen carries the quiet anchor next to sign-out, pointing at the repo.
// (This client ships at cutover; GC MAIN's live UI carries its own §13 seat.)
const GOOBER_SOURCE_URL = "https://github.com/Wempo-s-Silly-Projects/GooberCord";

// The theme engine is Kit's (frontload/tokens) — the storage-key family and
// the browser-chrome repaint ride it; there is no bespoke theme module. GC
// has ONE skin (the forum's look): writes go to goober-theme, forum-theme
// rides along as a read-only legacy home, and the skin vocabulary collapses
// to "brand" from both sides.
export const appearance = makeAppearance({
  themeKey: "goober-theme",
  skinKey: "goober-skin",
  legacyThemeKeys: ["forum-theme"],
  altSkin: "brand",
  defaultSkin: "brand",
  chromeColors: { brand: { light: "#f7efdc", dark: "#131b27" } },
});

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// The pinned chrome pair (the engine config's brand colors, vendored-privately
// computed): a runtime pin re-paints the media'd <meta name="theme-color">
// pair with the media attributes dropped, so the browser chrome follows the
// pin at once instead of the system query.
const PINNED_CHROME = { light: "#f7efdc", dark: "#131b27" };

// The color-scheme contract: the <meta name="color-scheme"> hint is the
// runtime source and styles.css maps it back to the property with :has().
// Kit's engine is vendored and meta-blind, so the shell's toggle seat — the
// only non-vendored runtime write — syncs the hint (pinned, "light"/"dark")
// alongside the chrome pair. The boot paint needs no sync: theme-preload.js
// already settled the hint from the same storage read.
export function syncColorSchemeContract(doc, theme) {
  const color = PINNED_CHROME[theme];
  if (!color) return;
  const schemeMeta = doc.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.content = theme;
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
    meta.removeAttribute("media");
    meta.content = color;
  }
}

// The initials on a server tile: up to two characters, Space Grotesk 700.
export function tileLabel(name) {
  return String(name || "?").trim().slice(0, 2).toUpperCase() || "?";
}

// The home door tile: WEMPO (the standing persona ruling — the door carries
// Wempo's face; Blaxel keeps to the CONTENTS). One <img>, no inline styles.
function homeTile(activeServerId) {
  return h("button", {
    class: ["server-tile", "server-home", activeServerId === null ? "server-active" : null],
    type: "button",
    "aria-label": t("gc.shell.nav.dm"),
    title: t("gc.shell.nav.dm"),
    onClick: () => {
      store.set({ activeServerId: null, activeChannelId: null });
      router.navigate("/");
    },
  }, h("img", { class: "tile-face", src: "/assets/wempo.png", alt: "WEMPO" }));
}

let serversLoading = false;

async function loadServers() {
  if (store.get("servers") || serversLoading) return;
  serversLoading = true;
  try {
    const payload = await api("/api/servers");
    store.set({ servers: Array.isArray(payload?.servers) ? payload.servers : [] });
  } catch {
    // A failed list stays UNCACHED (the empty array is truthy and would wedge
    // the guard) — the next route render retries; the rails still paint empty.
    store.set({ servers: null });
  } finally {
    serversLoading = false;
  }
}

// refreshServers() — the manage writes' re-read: drop the cache and pull
// again (the add-server / settings writes call this; a failure keeps the
// previous list rather than blinding the rails).
export async function refreshServers() {
  store.set({ servers: null });
  serversLoading = false;
  await loadServers();
}

function initialFor(text) {
  return String(text || "").trim().slice(0, 2).toUpperCase();
}

// The placeholder panes: the chat wave replaces the "channel" route by re-
// registering the same route NAME with its own render (addRoute drops the old
// render for a name). Each takes (route, mount) — the router's arg order.
export function channelPlaceholder(route, mount) {
  const server = (store.get("servers") || []).find(
    (entry) => entry.id === Number(route.params.serverId),
  );
  const channel = server?.channels?.find((c) => c.id === Number(route.params.channelId));
  const pane = h("section", { class: "pane-main" },
    h("header", { class: "pane-header" },
      h("h2", { class: "pane-title", text: channel ? "#" + channel.name : t("gc.shell.placeholder.channelTitle") })),
    h("div", { class: "pane-body" },
      h("p", { class: "empty-state", text: t("gc.shell.placeholder.channel") })));
  mount.append(renderShell(route, pane));
  document.title = channel ? `${channel.name} — GooberCord` : "GooberCord";
}

export function serverPlaceholder(route, mount) {
  const server = (store.get("servers") || []).find(
    (entry) => entry.id === Number(route.params.serverId),
  );
  const pane = h("section", { class: "pane-main" },
    h("header", { class: "pane-header" },
      h("h2", { class: "pane-title", text: server ? server.name : t("gc.shell.placeholder.serverTitle") })),
    h("div", { class: "pane-body" },
      h("p", { class: "empty-state", text: t("gc.shell.placeholder.server") })));
  mount.append(renderShell(route, pane));
}

// The subscribed strip's seat: one subscription lives across the latest
// renderShell; the next render drops its predecessor's (subscribe returns
// the unsubscribe).
let connectionStripUnsub = null;

// The social lanes' seat (the same one-live-per-page idiom): the signed-in
// boot paints the rails BEFORE the /api payloads land, and the payloads'
// arrival must repaint — the store's whole purpose, wired. One subscription
// per lane key, node-local edits inside the live frame (chat.js's roster
// repaint idiom), never a route re-render. The DM seat reads no friends
// truth, so the friends lane keeps its own page's render.
let laneUnsub = null;

export function renderShell(route, paneOverride = null) {
  const frame = h("div", { class: "shell", "data-testid": "app-shell" });
  frame.append(serverRail(), channelRail());
  frame.append(paneOverride ?? mainPane(route));
  frame.append(membersRail());
  // The phone drawer (T-R25-SHELL-PHONE): under 640px the CSS collapses the
  // frame to ONE pane and the two fixed rails ship off the grid — they ride
  // THIS shell-level state (the frame's own data-drawer attribute): the
  // toggle opens and closes, the scrim closes, and any nav act closes the
  // drawer by rebuilding the shell (every route render makes a fresh frame;
  // the server-rail rows' and channel rows' own acts navigate first). The
  // desktop and tablet shapes keep their every rule verbatim.
  let scrimNode = null;
  const setPhoneDrawer = (open) => {
    frame.dataset.drawer = open ? "open" : "closed";
    toggle.setAttribute("aria-expanded", String(open));
  };
  const toggle = h("button", {
    class: "phone-drawer-toggle",
    type: "button",
    "aria-label": t("gc.shell.nav.menu"),
    "aria-haspopup": "true",
    "aria-expanded": "false",
    title: t("gc.shell.nav.menu"),
    text: "≡",
    onClick: () => {
      if (frame.dataset.drawer !== "open") {
        setPhoneDrawer(true);
        if (!scrimNode) {
          scrimNode = h("div", { class: "shell-scrim" });
          scrimNode.addEventListener("click", () => setPhoneDrawer(false));
          frame.append(scrimNode);
        }
      } else {
        setPhoneDrawer(false);
      }
    },
  });
  frame.append(toggle);
  // The socket lane's drop strip (G-9): one line of store truth, now
  // SUBSCRIBED (the store's whole purpose) — a connection flip repaints
  // THIS strip node-locally, never a route re-render. One live seat per
  // page: each renderShell drops its predecessor's subscription.
  let stripNode = null;
  const paintConnectionStrip = () => {
    if (store.get("connection") === "reconnecting") {
      if (!stripNode) {
        stripNode = h("div", { class: "connection-strip", role: "status",
          text: t("gc.shell.reconnecting") });
        frame.append(stripNode);
      }
    } else if (stripNode) {
      stripNode.remove();
      stripNode = null;
    }
  };
  paintConnectionStrip();
  if (connectionStripUnsub) connectionStripUnsub();
  connectionStripUnsub = store.subscribe("connection", paintConnectionStrip);
  // The social lanes' live repaint: servers repaint the two rails, the
  // conversations lane repaints the DM seat (the frozen-paint fix — the
  // payload's arrival is the paint moment, the store's subscriber).
  if (laneUnsub) laneUnsub();
  const paintLanes = (_state, key) => {
    if (key === "servers") {
      frame.querySelector(".rail-servers")?.replaceWith(serverRail());
      frame.querySelector(".rail-channels")?.replaceWith(channelRail());
    } else {
      frame.querySelector(".dm-section")?.replaceWith(dmSection());
    }
  };
  laneUnsub = store.subscribe(["conversations", "servers"], paintLanes);
  loadServers();
  // The social lanes hydrate alongside (fire-and-forget; each re-render
  // paints from the store once its payload lands).
  if (!store.get("conversations")) loadConversations().catch(() => { /* the rail shows the quiet state */ });
  if (!store.get("mentions")) loadMentions().catch(() => { /* the pill keeps its quiet state */ });
  // The coin snapshot rides its OWN lane (the footer line self-hydrates —
  // node-local paint, never a route re-render).
  return frame;
}

// --- the server rail (72px) --------------------------------------------------

function serverRail() {
  const rail = h("nav", { class: "rail-servers", "aria-label": t("gc.shell.nav.servers") });
  const servers = store.get("servers") || [];
  const activeServerId = store.get("activeServerId") ?? null;

  rail.append(homeTile(activeServerId));

  for (const server of servers) {
    rail.append(h("button", {
      class: [
        "server-tile",
        activeServerId === server.id ? "server-active" : null,
      ],
      type: "button",
      title: server.name,
      "aria-label": server.name,
      text: initialFor(server.name),
      onClick: () => {
        store.set({ activeServerId: server.id, activeChannelId: null });
        const first = server.channels?.[0];
        router.navigate(first ? `/s/${server.id}/${first.id}` : `/s/${server.id}`);
      },
    }));
  }

  const foot = h("div", { class: "rail-servers-foot" });
  foot.append(h("button", {
    class: "server-tile server-add",
    type: "button",
    title: t("gc.shell.nav.join"),
    "aria-label": t("gc.shell.nav.join"),
    text: "+",
    onClick: () => {
      // The member-facing door: invite code or discovery (settings.js owns it).
      router.navigate("/join");
    },
  }));
  rail.append(foot);
  return rail;
}

// --- the channel rail (260px) ------------------------------------------------

function channelRail() {
  const rail = h("nav", { class: "rail-channels", "aria-label": t("gc.shell.nav.channels") });
  const servers = store.get("servers") || [];
  const activeServerId = store.get("activeServerId");
  const activeChannelId = store.get("activeChannelId");
  const server = servers.find((entry) => entry.id === activeServerId) || null;

  rail.append(h("header", { class: "rail-header rail-header-manage" },
    h("h2", {
      class: "rail-title",
      text: server ? server.name : "GooberCord",
    }),
    server && serverAdminRights(server)
      ? h("a", {
        class: "manage-gear", "aria-label": t("gc.shell.nav.manage"), title: t("gc.shell.nav.manageShort"),
        href: `/s/${server.id}/settings`, text: "⚙",
      })
      : null));

  // The mentions inbox: a real rail item with the count pill (Rethink 3), the
  // text-and-pill grammar the button law demands (no bell icons).
  const mentions = store.get("mentions") || null;
  rail.append(h("a", { class: "channel-row mentions-item", href: "/mentions",
    "aria-label": t("gc.shell.nav.mentions") },
  h("span", { class: "channel-hash", text: "@" }), t("gc.shell.nav.mentionsShort"),
  h("span", {
    class: "count-pill",
    hidden: !Array.isArray(mentions) || mentions.length === 0 ? true : undefined,
    text: Array.isArray(mentions) ? String(mentions.length) : t("gc.shell.mentions.loading"),
  })));

  // The bookmarks door: the private saved panel (bookmarks.js owns it), the
  // same text-and-label grammar the button law demands (no bare icons).
  rail.append(h("a", { class: "channel-row bookmarks-item", href: "/bookmarks",
    "aria-label": t("gc.shell.nav.bookmarks") },
  h("span", { class: "channel-hash", text: "*" }), t("gc.shell.nav.bookmarks")));

  // The capsules door: the active server's own time-capsule panel
  // (capsules.js owns it) — the same text-and-label grammar; it rides the
  // server-scoped half of the rail, so the door only exists on a server.
  if (server) {
    rail.append(h("a", { class: "channel-row capsules-item", href: `/s/${server.id}/capsules`,
      "aria-label": t("gc.shell.nav.capsules") },
    h("span", { class: "channel-hash", text: "✉" }), t("gc.shell.nav.capsules")));
    // The reaction-tags door: the active server's own member opts page
    // (reaction-tags.js owns it) — the same text-and-label grammar.
    rail.append(h("a", { class: "channel-row tags-item", href: `/s/${server.id}/tags`,
      "aria-label": t("gc.shell.nav.tags") },
    h("span", { class: "channel-hash", text: "⚑" }), t("gc.shell.nav.tags")));
  }

  if (server && Array.isArray(server.channels)) {
    // Channels file under their categories when the server has any;
    // otherwise one shared "Text channels" section carries them all.
    const byCategory = new Map(); // categoryId -> channels (null = unfiled)
    for (const channel of server.channels) {
      const key = channel.categoryId ?? null;
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(channel);
    }
    const categoryNames = new Map(
      (server.categories || []).map((category) => [category.id, category.name]),
    );
    for (const [categoryId, channels] of byCategory) {
      rail.append(h("h3", {
        class: "rail-section",
        text: categoryNames.get(categoryId) ?? t("gc.shell.channels.textHeading"),
      }));
      for (const channel of channels) {
        rail.append(channelRow(channel, activeChannelId, server));
      }
    }
  } else {
    rail.append(h("p", {
      class: "empty-state",
      text: t("gc.shell.channels.none"),
    }));
  }

  rail.append(dmSection());

  rail.append(userBlock());
  return rail;
}

// The DM section: the conversations list (social.js loads it), newest
// activity first; unread rides the server's `unread` per row — pills only
// for unread truth, never decoration.
function dmSection() {
  // The loader-lane texts ride the i18n binding pass (data-i18n): a
  // pre-catalog paint humanizes the key's tail, and initI18n's resolution
  // sweep repaints it — the loader never stays frozen (visible-garbage law's
  // repaint half; the sweep sets textContent only, never a markup parse).
  const fragment = h("div", { class: "dm-section" },
    h("h3", { class: "rail-section", "data-i18n": "gc.shell.nav.dm", text: t("gc.shell.nav.dm") }),
    h("a", { class: "control-quiet dm-friends-link", href: "/friends",
      "data-i18n": "gc.shell.social.friendsRequests", text: t("gc.shell.social.friendsRequests") }));
  const conversations = store.get("conversations");
  if (Array.isArray(conversations)) {
    if (conversations.length === 0) {
      fragment.append(h("p", { class: "empty-state", "data-i18n": "gc.shell.social.none",
        text: t("gc.shell.social.none") }));
    }
    for (const thread of conversations) {
      const others = thread.members
        .filter((member) => member.userId !== store.get("user")?.id);
      const label = thread.iconUrl ? "" : thread.name
        || others.map((member) => member.username).join(", ") || t("gc.shell.nav.dm");
      fragment.append(h("a", { class: "channel-row dm-row", href: `/dm/${thread.id}` },
        h("span", { class: "channel-hash", text: "@" }),
        h("span", { class: "dm-name", text: label || t("gc.shell.dm.group") }),
        thread.unread ? h("span", { class: "count-pill", text: String(thread.unread) }) : null));
    }
  } else {
    fragment.append(h("p", { class: "empty-state", "data-i18n": "gc.shell.social.fetching",
      text: t("gc.shell.social.fetching") }));
  }
  return fragment;
}

function channelRow(channel, activeChannelId, server) {
  const selected = activeChannelId === channel.id;
  const slow = channel.slowmodeSeconds ? ` (${channel.slowmodeSeconds}s slow)` : "";
  return h("button", {
    class: ["channel-row", selected ? "channel-active" : null],
    type: "button",
    title: "#" + channel.name + slow,
    onClick: () => {
      store.set({ activeChannelId: channel.id });
      router.navigate(`/s/${server.id}/${channel.id}`);
    },
  }, h("span", { class: "channel-hash", text: "#" }), channel.name);
}

function userBlock() {
  const user = store.get("user");
  const foot = h("footer", { class: "rail-user" });
  // The coin balance is AMBIENT here (B1): one self-hydrating line, the
  // yellow mark the forum's coin color; a refusal never surfaces — the
  // shop route owns the error lanes.
  if (user) foot.append(coinFooterLine());
  foot.append(
    h("span", {
      class: "user-initials",
      "aria-hidden": "true",
      text: user ? initialFor(user.username) : "?",
    }),
    h("span", { class: "user-name", text: user ? user.username : "" }),
    h("button", {
      class: "control-quiet",
      type: "button",
      text: currentTheme() === "dark" ? t("gc.shell.theme.light") : t("gc.shell.theme.dark"),
      onClick: function toggleTheme(event) {
        const next = currentTheme() === "dark" ? "light" : "dark";
        // Kit's engine: attribute, browser chrome, storage — in one call.
        appearance.setThemeChoice(document, localStorage, next);
        // The meta-blind engine can't see the hint: the color-scheme seat
        // rides right behind it (the runtime contract, wave-24).
        syncColorSchemeContract(document, next);
        event.currentTarget.textContent = next === "dark" ? t("gc.shell.theme.light") : t("gc.shell.theme.dark");
      },
    }),
    h("a", {
      class: "control-quiet",
      href: wempoAccountsSignOutUrl(),
      text: t("gc.shell.user.signOut"),
    }),
    h("a", {
      class: "control-quiet",
      href: GOOBER_SOURCE_URL,
      target: "_blank",
      rel: "noopener noreferrer",
      text: t("gc.shell.user.source"),
    }),
  );
  return foot;
}

// --- the main pane -----------------------------------------------------------

// First run is ONE screen (the owner's rethink #4): "You're in." — join with
// an invite link/code or create a server, nothing else. Blaxel decorates the
// CONTENTS; the + tile at the rail's foot is the create affordance the manage
// wave wires up.
function homePane() {
  const servers = store.get("servers") || [];
  if (servers.length === 0) {
    return h("section", { class: "pane-main" },
      h("div", { class: "pane-body first-run" },
        h("img", { class: "blaxel-face", src: "/assets/blaxel.png", alt: "" }),
        h("h2", { class: "display", text: t("gc.shell.home.heading") }),
        h("p", { class: "empty-state", text: t("gc.shell.home.body") })));
  }
  return h("section", { class: "pane-main" },
    h("header", { class: "pane-header" },
      h("h2", { class: "pane-title", text: t("gc.shell.home.title") })),
    h("div", { class: "pane-body" },
      h("p", {
        class: "empty-state",
        text: t("gc.shell.home.pickChannel"),
      })));
}

function mainPane() {
  return homePane();
}

// --- the members rail (240px) ------------------------------------------------

function membersRail() {
  const rail = h("aside", { class: "rail-members", "aria-label": t("gc.shell.nav.members") },
    h("header", { class: "rail-header" },
      h("h2", { class: "rail-title", text: t("gc.shell.nav.members") })));
  const activeServerId = store.get("activeServerId");
  if (activeServerId) {
    // The members wave owns the body; the shell only hands over the node.
    renderRosterBody(rail, activeServerId);
  } else {
    rail.append(h("p", {
      class: "empty-state",
      text: t("gc.shell.members.empty"),
    }));
  }
  return rail;
}
