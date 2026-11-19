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

// The reaction-tags member panel — the server-scoped face of the cosmetic
// emoji→tag map (the wave-13 slate). The backend doors are LIVE and
// byte-frozen (api/reaction-tags.mjs:252-268): the map GET
// /api/servers/:id/reaction-tags, the opt POST/DELETE
// /api/servers/:id/reaction-tags/:tagId/opt, and the mine read
// /api/servers/:id/reaction-tags/mine. The store lanes key PER-SERVER (the
// rosterKey/mineCapsules idiom): server 1's tags never answer server 2's
// URL. The defaults law: the panel's own open pulls its two reads ONCE —
// every opt flip is a member-initiated act, never default-on. Tag text is
// mod-written data: a locale-key reference or a server-native string, so it
// paints verbatim through its own textContent seat — never t()'d, never
// interpolated (the welcome-card letter's law). The message reactions
// payload carries NO tag seat (payload-truth law), so nothing here reads the
// chat payload. Tags are FREE cosmetics — the sink law: nothing mints,
// nothing accounts.
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { t } from "../i18n.js";

// G-4 mirror: GC_REACTION_TAGS_MAX, GC_REACTION_TAG_TEXT_MAX and
// GC_REACTION_TAG_EMOJI_MAX (constants.mjs) — the caps the backend's 400
// family enforces (api/reaction-tags.mjs), never raised client-side. The
// settings.js mod panel imports these; they are declared ONCE here.
export const UI_REACTION_TAGS_MAX = 20;
export const UI_REACTION_TAG_TEXT_MAX = 32;
export const UI_REACTION_TAG_EMOJI_MAX = 32;

// The lanes key PER-SERVER (members.js's roster:${serverId} / capsules.js's
// mineCapsules:${serverId}): a flat lane set on one server's visit could be
// read on another's render.
const mapKey = (serverId) => `serverReactionTags:${serverId}`;
const mineKey = (serverId) => `mineReactionTags:${serverId}`;

// GET /api/servers/:serverId/reaction-tags — the member's map read: the
// tags the server offers (id, emoji, tag; no member column — the privacy
// law). A malformed (server-broken) answer seats the lane NULL, never [] —
// the empty state is the VALID empty map's paint alone (the lane-c18-fix
// law); the malformed seat paints the failed-load face instead.
export async function loadServerReactionTags(serverId) {
  const payload = await api(`/api/servers/${serverId}/reaction-tags`);
  store.set({ [mapKey(serverId)]: Array.isArray(payload?.tags) ? payload.tags : null });
  return store.get(mapKey(serverId));
}

// GET /api/servers/:serverId/reaction-tags/mine — ONLY the caller's opt rows
// for THIS server, newest opt first (the privacy law: no other member's row).
export async function loadMineReactionTags(serverId) {
  const payload = await api(`/api/servers/${serverId}/reaction-tags/mine`);
  store.set({ [mineKey(serverId)]: Array.isArray(payload?.tags) ? payload.tags : null });
  return store.get(mineKey(serverId));
}

// The mod tag write is the change point: the settings-side mod panel's
// successful PUT (upsert) or DELETE (unmap) invalidates THIS server's two
// lanes (seated undefined), so the next member-panel open in the same client
// re-pulls fresh truth instead of painting the pre-write map/mine face.
export function invalidateReactionTagLanes(serverId) {
  store.set({ [mapKey(serverId)]: undefined, [mineKey(serverId)]: undefined });
}

// POST /api/servers/:serverId/reaction-tags/:tagId/opt — the opt act. The
// route is idempotent (a repeat answers { opted: true, duplicate: true }).
export async function optInTag(serverId, tagId) {
  return api(`/api/servers/${serverId}/reaction-tags/${Number(tagId)}/opt`, { method: "POST" });
}

// DELETE /api/servers/:serverId/reaction-tags/:tagId/opt — the un-opt act,
// self-scoped (the route's (tag_id, user_id) key); a not-mine row answers
// the shared 404, painted verbatim at the panel.
export async function optOutTag(serverId, tagId) {
  return api(`/api/servers/${serverId}/reaction-tags/${Number(tagId)}/opt`, { method: "DELETE" });
}

// /s/:serverId/tags — the server reaction-tags task page (the shell's door
// is its rail entry; the route registers in shell.js, main.js untouched —
// the capsules panel's door idiom).
export function renderReactionTagsPanel(route, mount) {
  const serverId = Number(route.params.serverId);
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.tags.heading") })));
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.tags.heading") }), errorLine);
  mount.append(renderShell(route, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body, panel))));
  const mapLane = store.get(mapKey(serverId));
  const mineLane = store.get(mineKey(serverId));
  // A NULL lane is the malformed-load seat: paint the failed-load face and
  // never a second load — a broken answer must not loop the wire (the
  // capsules idiom).
  if (mapLane === null || mineLane === null) {
    panel.append(h("p", {
      class: "form-error", role: "alert", "aria-live": "polite",
      text: t("gc.tags.loadFailed"),
    }));
    return;
  }
  // The one auto-pull per visit (the defaults law): the panel's open rides
  // its own two reads, never an opt and never a second pull.
  if (mapLane === undefined || mineLane === undefined) {
    Promise.all([loadServerReactionTags(serverId), loadMineReactionTags(serverId)])
      .then(() => router.renderCurrent())
      .catch((error) => {
        errorLine.textContent = error.message; // the 404 family paints verbatim (G-2)
      });
    return;
  }
  panel.append(tagRowsPanel(store.get(mapKey(serverId)), store.get(mineKey(serverId)), serverId));
}

// The offered tags' rows: the mine lane's ids decide each row's flip, the
// act's wire seats live only in the row's own handler, and the lane rebuilds
// IMMUTABLY (a filtered copy, an appended copy) — never an in-place splice.
function tagRowsPanel(tagRows, mineRows, serverId) {
  if (tagRows.length === 0) {
    return h("p", { class: "empty-state", text: t("gc.tags.empty") });
  }
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const mine = new Set(mineRows.map((row) => row.id));
  // The mine count rides the rows actually painted (the gc.bookmarks.more
  // idiom — presence from the payload, never an invented total).
  const mineCount = h("p", { class: "muted count-line",
    text: t("gc.tags.mineCount", { count: mineRows.length, total: tagRows.length }) });
  const list = h("div", { class: "manage-list" });
  for (const row of tagRows) {
    const mineRow = mine.has(row.id);
    list.append(h("div", { class: mineRow ? "manage-row tag-row-mine" : "manage-row", dataset: { tagId: String(row.id) } },
      h("span", { class: "manage-name" },
        h("span", { class: "tag-emoji", text: row.emoji }),
        h("span", { class: "tag-text", text: row.tag })),
      h("span", { class: "row-controls" },
        h("button", {
          class: mineRow ? "button button-quiet tag-opt-out" : "button button-quiet tag-opt-in",
          type: "button",
          text: mineRow ? t("gc.tags.optOut") : t("gc.tags.optIn"),
          onClick: async () => {
            try {
              // Both flips rebuild the lane from the STORE at call time
              // (the bookmarks.js unsaveBookmark/saveBookmark idiom — the
              // c20 fix): the render-closure's mineRows is a snapshot, and
              // two flips inside one latency window writing the snapshot
              // resurrected/dropped rows. The opt's own presence check
              // absorbs the same-tag double-click.
              if (mineRow) {
                await optOutTag(serverId, row.id);
                store.set(
                  { [mineKey(serverId)]: (store.get(mineKey(serverId)) || []).filter((entry) => entry.id !== row.id) });
              } else {
                await optInTag(serverId, row.id);
                const currentMine = store.get(mineKey(serverId)) || [];
                if (!currentMine.some((entry) => entry.id === row.id)) {
                  store.set({
                    [mineKey(serverId)]: [...currentMine, { id: row.id, emoji: row.emoji, tag: row.tag }],
                  });
                }
              }
              router.renderCurrent();
            } catch (error) {
              errorLine.textContent = error.message; // the shared 404 paints verbatim (G-2)
            }
          },
        }))));
  }
  return h("div", { class: "tag-panel" }, mineCount, list, errorLine);
}
