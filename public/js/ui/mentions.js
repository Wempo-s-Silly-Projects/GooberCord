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

// The mentions inbox (Rethink 3: a real rail item, never a buried bell) +
// the /mentions route. Backend 0028 landed: GET /api/mentions (limit 1–100,
// default 25) and DELETE /api/mentions/:messageId (the message id — the
// caller's own row only, idempotent either way). The unread count IS the
// list length (Rethink 10 level 3 — the shell owns the levels); rows offer
// themselves; dm/group rows navigate to their thread. A server-channel row
// CARRIES NO serverId in the 0028 shape, so it renders as text (channel name)
// with dismiss only — no invented route can deep-link it; that's a backend
// gap to file, not hide.
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { t } from "../i18n.js";

export async function loadMentions() {
  const payload = await api("/api/mentions");
  store.set({ mentions: Array.isArray(payload?.mentions) ? payload.mentions : [] });
  return store.get("mentions");
}

export async function dismissMention(messageId) {
  // 200 { deleted: rows>0 } either way — idempotent, then the count refreshes.
  await api(`/api/mentions/${messageId}`, { method: "DELETE" });
  await loadMentions();
}

// renderMentions(route, mount) — the inbox task page; dismiss re-renders from
// the fresh store (never a client-side purge of rows the server still has).
export function renderMentions(route, mount) {
  const mentions = store.get("mentions");
  const pane = h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" },
      h("section", { class: "task-page" },
        h("header", { class: "task-header" },
          h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
          h("h2", { class: "page-heading", text: t("gc.shell.nav.mentionsShort") })),
        inboxBody(mentions))));
  mount.append(renderShell({ params: {} }, pane));
  if (!mentions) {
    loadMentions().then(() => router.current() && router.renderCurrent()).catch((error) => {
      pane.append(h("p", { class: "empty-state", text: error.message }));
    });
  }
}

function inboxBody(mentions) {
  const body = h("div", {});
  if (Array.isArray(mentions) && mentions.length === 0) {
    body.append(h("p", {
      class: "empty-state", text: t("gc.mentions.empty"),
    }));
    return body;
  }
  if (!Array.isArray(mentions)) return body; // the fetch owns the redraw
  for (const mention of mentions) {
    const isThread = mention.channelKind === "dm" || mention.channelKind === "group";
    body.append(h("div", { class: "manage-row mention-row" },
      isThread
        ? h("a", { class: "manage-row", href: `/dm/${mention.channelId}` },
          h("span", { class: "manage-name", text: mention.authorUsername },
            h("span", {
              class: "mark-muted", text: t("gc.mentions.inThread",
                { channel: mention.channelName || t("gc.mentions.threadUnnamed") }),
            })),
          h("span", { class: "muted mention-body", text: mention.body }))
        : h("div", { class: "manage-row" },
          h("span", { class: "manage-name", text: mention.authorUsername },
            h("span", { class: "mark-muted",
            text: t("gc.mentions.inChannel", { channel: mention.channelName || t("gc.mentions.channelUnnamed") }) })),
          h("span", { class: "muted mention-body", text: mention.body })),
      h("button", {
        class: "row-quiet-control", type: "button", text: t("gc.mentions.dismiss"),
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            await dismissMention(mention.messageId);
            router.renderCurrent();
          } catch (error) {
            event.currentTarget.textContent = error.message; // verbatim
          }
        },
      })));
  }
  return body;
}
