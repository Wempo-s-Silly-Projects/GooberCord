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
// WITHOUT ANY WARRANTY; WITHOUT even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

// T87: the Morning Paper client surface (docs/drafts/t87-morning-paper-spec.md
// §client) — the server's own daily journal, read back as a pane. Mirrors
// api/paper.mjs's shapes verbatim:
//   GET  /api/servers/:id/paper          today's paper ({ sections: {...} })
//   GET  /api/servers/:id/paper/previous yesterday's paper (same shape)
//   POST /api/servers/:id/paper          the mod toggle ({ enabled })
// PRIVACY: no member attribution is painted anywhere — the rollups carry
// counts, channel/thread ids, and a capsule's sender HANDLE exactly as its
// own routes already paint it; nothing per-member is invented client-side.
// The unconfigured state is the READ's dedicated 404 (spec defaults law) —
// an off server paints the shared off-copy plus the mod's on-toggle, never
// an error card.
import { h, clear } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { t, fmtDate, fmtNumber } from "../i18n.js";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { serverAdminRights } from "./settings.js";

// The backend paints the paper's title as a KEY (api/paper.mjs's titleKey);
// the map is the one translation between its vocabulary and the bundle's
// gc.* scheme (tests/i18n.test.mjs pins the scheme).
const TITLE_KEYS = { "paper.title": "gc.paper.title" };

const utcStamp = (seconds) => fmtDate(new Date(seconds * 1000), {
  timeZone: "UTC",
  year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit",
});

function serverOf(serverId) {
  return (store.get("servers") || []).find((entry) => entry.id === serverId) || null;
}

function channelNameOf(serverId, channelId) {
  const channel = serverOf(serverId)?.channels
    ?.find((entry) => entry.id === channelId);
  return channel ? channel.name : String(channelId);
}

// The sections panel: one h3 + row list per section; an empty section rides
// its honest empty state — a zero-activity window is a COMPLETE paper, not
// an error and never invented filler.
function sectionPanel(headingKey, rows, emptyKey) {
  const panel = h("div", { class: "panel" },
    h("h3", { text: t(headingKey) }));
  if (rows.length === 0) {
    panel.append(h("p", { class: "empty-state", text: t(emptyKey) }));
    return panel;
  }
  panel.append(h("div", { class: "manage-rows" }, ...rows));
  return panel;
}

function togglePanel(serverId, enabled, errorNode) {
  return h("div", { class: "affordance-row" },
    errorNode,
    h("button", {
      class: "control-quiet",
      type: "button",
      text: enabled ? t("gc.paper.toggleOff") : t("gc.paper.toggleOn"),
      onClick: async () => {
        try {
          await api(`/api/servers/${serverId}/paper`, {
            method: "POST",
            body: { enabled: !enabled },
          });
          // The write's next state is the WRITE's truth — re-derive the pane.
          router.renderCurrent();
        } catch (error) {
          errorNode.textContent = error.message;
        }
      },
    }));
}

function paintPaper(serverId, payload) {
  const mod = serverAdminRights(serverOf(serverId));
  const pane = h("section", { class: "task-page" });
  pane.append(h("header", { class: "task-header" },
    h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
    h("h2", { class: "page-heading",
      text: t(TITLE_KEYS[payload.titleKey] ?? "gc.paper.title") })));
  if (payload.window) {
    pane.append(h("p", { class: "muted",
      text: t("gc.paper.windowLabelUtc", {
        start: utcStamp(payload.window.startSeconds),
        end: utcStamp(payload.window.endSeconds),
      }) }));
  }
  if ((payload.activityRows ?? 0) === 0) {
    pane.append(h("p", { class: "empty-state", text: t("gc.paper.empty.all") }));
  }
  const sections = payload.sections || {};
  pane.append(sectionPanel("gc.paper.section.channels",
    (sections.channels || []).map((row) => h("p", { class: "member-row",
      text: t("gc.paper.channelRow", {
        name: channelNameOf(serverId, row.channelId),
        count: fmtNumber(row.count),
      }) })),
    "gc.paper.empty.channels"));
  pane.append(sectionPanel("gc.paper.section.threads",
    (sections.threads || []).map((row) => h("p", { class: "member-row",
      text: t("gc.paper.threadRow", { id: fmtNumber(row.threadId), count: fmtNumber(row.count) }) })),
    "gc.paper.empty.threads"));
  pane.append(sectionPanel("gc.paper.section.capsules",
    (sections.capsules || []).map((row) => h("p", { class: "member-row",
      text: t("gc.paper.capsuleDueRow", {
        id: fmtNumber(row.sealId),
        handle: row.senderHandle,
        due: utcStamp(row.dueAt),
      }) })),
    "gc.paper.empty.capsules"));
  if (mod) {
    const errorNode = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
    pane.append(togglePanel(serverId, true, errorNode));
  }
  return pane;
}

function paintOff(serverId) {
  const mod = serverAdminRights(serverOf(serverId));
  const pane = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.paper.title") })),
    h("p", { class: "empty-state", text: t("gc.paper.off") }));
  if (mod) {
    const errorNode = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
    pane.append(togglePanel(serverId, false, errorNode));
  }
  return pane;
}

function paintFailed(serverId, error) {
  return h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.paper.title") })),
    h("p", { class: "form-error", role: "alert", text: error.message }));
}

// renderPaper(route, mount) — the /s/:serverId/paper (and /paper/previous)
// seat: the skeleton pane paints now, the rows land on the read's resolve.
// The read's 404 IS the off state (api/paper.mjs's dedicated no-paper
// reply); every other failure paints the server's own message verbatim
// (G-3: the server is truth).

export function renderPaper(route, mount) {
  const serverId = Number(route.params.serverId);
  const previous = route.path.endsWith("/previous");
  const body = h("div");
  body.append(h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.paper.title") })),
    h("p", { class: "empty-state", text: t("gc.paper.loading") })));
  // The pane skeleton paints now; a resolve clears it and lands the rows.
  mount.append(renderShell(null, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body))));
  api(`/api/servers/${serverId}/paper${previous ? "/previous" : ""}`)
    .then((payload) => {
      clear(body);
      body.append(paintPaper(serverId, payload || {}));
    })
    .catch((error) => {
      clear(body);
      body.append(error.status === 404 ? paintOff(serverId) : paintFailed(serverId, error));
    });
  document.title = `${t("gc.paper.title")} — GooberCord`;
}
