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

// The bookmarks panel — the private reading queue (the wave-10 slate's F1).
// The backend doors are LIVE and byte-frozen (api/bookmarks.mjs): the save
// POST /api/messages/:id/bookmark, the GET /api/bookmarks list, the
// owner-only DELETE /api/bookmarks/:id unsave. The list payload carries
// POINTER rows only (id, messageId, savedAt — no message body, by design at
// bookmarks.mjs:80): the panel renders what the contract gives, inventing
// no read. The store lane ("bookmarks") mirrors the GET list so the chat
// lane's row toggle reads its own saved state without a second wire.
// The empty list is a valid painted state (the defaults law), never an
// error; every refusal renders the server's own string verbatim (G-2).
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";
import { t } from "../i18n.js";

// GET /api/bookmarks — the private list mirrors into the store lane (the
// chat row's save state reads THIS lane; no second GET exists anywhere).
// The envelope's truncated seat rides its own quiet lane key (the wave-11
// rider): the chat save lane keeps reading the pointer array, untouched.
const BOOKMARKS_LANE = "bookmarks";

export async function loadBookmarks() {
  const payload = await api("/api/bookmarks");
  store.set({ [BOOKMARKS_LANE]: Array.isArray(payload?.bookmarks) ? payload.bookmarks : [] });
  store.set({ bookmarksTruncated: payload?.truncated === true });
  return store.get(BOOKMARKS_LANE);
}

// POST /api/messages/:messageId/bookmark — the save act. The idempotent
// duplicate answers 200 { saved: true, duplicate: true } (nothing new to
// mirror); a fresh save answers { saved: true, id, savedAt } and its row
// lands in the store lane so the row's toggle flips without a re-fetch.
export async function saveBookmark(messageId) {
  const result = await api(`/api/messages/${Number(messageId)}/bookmark`, { method: "POST" });
  if (result?.id) {
    store.set({ [BOOKMARKS_LANE]: [...store.get(BOOKMARKS_LANE) || [],
      { id: Number(result.id), messageId: Number(messageId), savedAt: Number(result.savedAt) }] });
  }
  return result;
}

// DELETE /api/bookmarks/:bookmarkId — the owner-only unsave; the pointer
// drops from the store lane on the route's { ok: true } echo.
export async function unsaveBookmark(bookmarkId) {
  const result = await api(`/api/bookmarks/${Number(bookmarkId)}`, { method: "DELETE" });
  store.set({
    [BOOKMARKS_LANE]: (store.get(BOOKMARKS_LANE) || []).filter((row) =>
      row.id !== Number(bookmarkId)),
  });
  return result;
}

// /bookmarks — the private saved panel (the shell's nav entry is its door).
export function renderBookmarksPanel(route, mount) {
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.bookmarks.heading") })));
  const panel = h("div", { class: "panel" }, h("h3", { text: t("gc.bookmarks.heading") }));
  mount.append(renderShell(route, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body, panel))));
  const lane = store.get(BOOKMARKS_LANE);
  if (!Array.isArray(lane)) {
    loadBookmarks().then(() => router.renderCurrent()).catch((error) => {
      panel.append(h("p", { class: "form-error", text: error.message })); // G-2 verbatim
    });
    return;
  }
  panel.append(bookmarkRows(lane, store.get("bookmarksTruncated") === true));
}

// The pointer rows: message reference + saved date + the row's own unsave.
// One explicit click per row (the defaults law); a refused unsave's 404
// verdict renders verbatim inline and the panel keeps its painted rows.
// The wave-11 rider: the envelope's truncated seat paints the shown count
// only when the payload says so — presence, never an invented total (N+1
// known is a lie).
function bookmarkRows(rows, truncated) {
  if (rows.length === 0) {
    return h("p", { class: "empty-state", text: t("gc.bookmarks.empty") });
  }
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  // The shown count rides the rows actually painted; the payload's own
  // truncated flag is the only seat that turns the line on.
  const truncatedRow = h("p", { class: "muted count-line", text: t("gc.bookmarks.more", { shown: rows.length }) });
  const tail = truncated === true ? [truncatedRow, errorLine] : [errorLine];
  const list = h("div", { class: "bookmark-rows" });
  for (const row of rows) {
    list.append(h("div", { class: "bookmark-row" },
      h("span", { class: "bookmark-label",
        text: t("gc.bookmarks.rowLabel", { id: row.messageId }) }),
      h("span", { class: "muted bookmark-when",
        text: t("gc.bookmarks.savedAt", { when: savedStamp(row.savedAt) }) }),
      h("button", {
        class: "button button-quiet bookmark-unsave", type: "button",
        text: t("gc.bookmarks.unsave"),
        onClick: async () => {
          try {
            await unsaveBookmark(row.id);
            errorLine.textContent = "";
            router.renderCurrent();
          } catch (error) {
            errorLine.textContent = error.message; // the shared unknown-bookmark 404, verbatim
          }
        },
      })));
  }
  return h("div", { class: "bookmark-list" }, list, ...tail);
}

// The pointer's saved_at is unix seconds (bookmarks.mjs writes nowSeconds()):
// the stamp renders the UTC minute, no locale arithmetic invented. A
// non-finite seat (absent, NaN, Infinity, garbage) paints the "—" dash seat
// — the codebase's dash idiom (the tenureStartedAt twin in economy.js) —
// never the RangeError that would kill the whole panel render.
function savedStamp(savedAt) {
  const seconds = Number(savedAt);
  if (!Number.isFinite(seconds)) return "—";
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}
