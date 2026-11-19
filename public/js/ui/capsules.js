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

// The capsules panel — the server-scoped face of the time capsules (the
// wave-11 slate). The backend doors are LIVE and byte-frozen
// (api/capsules.mjs): the mine list GET /api/servers/:id/capsules/mine, the
// compose POST /api/servers/:id/capsules { body, revealAt }, the reveal GET
// /api/servers/:id/capsules/:cid, the delete DELETE
// /api/servers/:id/capsules/:cid. The list payload carries pointer rows only
// (id, channelId, revealAt, sealed — NO body): the letter's text rides
// EXACTLY ONE read, the member-initiated reveal GET, and paints once through
// its own textContent seat, never t()'d, never interpolated. The store
// lanes key PER-SERVER (the rosterKey/expressionsKey idiom). The empty
// schedule is a valid painted state (the defaults law), never an error;
// every refusal renders the server's own string verbatim (G-2).
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import * as router from "../core/router.js";
import { openDialog } from "../vendor/frontload/dom.mjs";
import { renderShell } from "./shell.js";
import { t } from "../i18n.js";

// GET /api/servers/:serverId/capsules/mine — the author's own list mirrors
// into the store lane; pointer rows only (capsules.mjs reads the body
// column nowhere). The lane keys by server (members.js:39
// roster:${serverId}): a flat lane set on one server's visit could be read
// on another's render — server 1's roster painting under server 2's URL.
const mineKey = (serverId) => `mineCapsules:${serverId}`;
// The mine envelope's truncated seat rides its own quiet lane key — keyed
// PER-SERVER like the pointer lane above (the bookmarksTruncated idiom).
const mineTruncatedKey = (serverId) => `mineTruncated:${serverId}`;

export async function loadMineCapsules(serverId) {
  const payload = await api(`/api/servers/${serverId}/capsules/mine`);
  // A malformed (server-broken) answer seats the lane NULL, never [] —
  // the empty state is the VALID empty schedule's paint alone; a broken
  // answer paints the failed-load face instead (lane-c18-fix F3).
  store.set({ [mineKey(serverId)]: Array.isArray(payload?.capsules) ? payload.capsules : null });
  store.set({ [mineTruncatedKey(serverId)]: payload?.truncated === true });
  return store.get(mineKey(serverId));
}

// POST /api/servers/:serverId/capsules { body, revealAt } — the compose act.
// The body was validated against the mirror and the postmark against the
// window BEFORE the wire; the route's 400/409 family paints verbatim.
export async function createCapsule(serverId, text, postmark) {
  return api(`/api/servers/${serverId}/capsules`, { method: "POST", body: { body: text, revealAt: postmark } });
}

// GET /api/servers/:serverId/capsules/:capsuleId — the reveal: THE one read
// that may carry the letter. Author pre-postmark it answers the sealed
// shape's schedule; post-postmark it answers the body. A non-author
// pre-reveal row answers the 404 family — painted verbatim at the row.
export async function revealCapsule(serverId, capsuleId) {
  return api(`/api/servers/${serverId}/capsules/${Number(capsuleId)}`);
}

// DELETE /api/servers/:serverId/capsules/:capsuleId — the hard delete, the
// member's own GDPR seat; the route's 409 revealed-locked answer paints
// verbatim. The caller only offers it on PRE-reveal rows.
export async function deleteCapsule(serverId, capsuleId) {
  return api(`/api/servers/${serverId}/capsules/${Number(capsuleId)}`, { method: "DELETE" });
}

// G-4 mirror: GC_CAPSULE_BODY_MAX (constants.mjs) — the body cap the
// backend's 400 family enforces (capsules.mjs seat at 2000), never raised
// client-side.
const UI_CAPSULE_BODY_MAX = 2000;

// G-4 mirror: GC_CAPSULE_MIN_AHEAD_SECONDS and GC_CAPSULE_MAX_AHEAD_SECONDS (constants.mjs) — the postmark window the route's 400 family enforces;
// the seat validates inside [now+300s, now+2592000s] client-side and the
// server's verdict rides verbatim behind it.
const UI_CAPSULE_MIN_AHEAD_SECONDS = 300;
const UI_CAPSULE_MAX_AHEAD_SECONDS = 2592000;

// /s/:serverId/capsules — the server capsules task page (the shell's door
// is its nav entry; the route registers in shell.js, main.js untouched).
export function renderCapsulesPanel(route, mount) {
  const serverId = Number(route.params.serverId);
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: `/s/${serverId}`, text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.capsules.heading") })));
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.capsules.heading") }), composePanel(serverId));
  mount.append(renderShell(route, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body, panel))));
  const lane = store.get(mineKey(serverId));
  // A NULL lane is the malformed-load seat: paint the failed-load face
  // (the errorLine idiom's class), never the empty state, and never a
  // second load — a broken answer must not loop the wire.
  if (lane === null) {
    panel.append(h("p", {
      class: "form-error", role: "alert", "aria-live": "polite",
      text: t("gc.capsules.loadFailed"),
    }));
    return;
  }
  if (lane === undefined) {
    loadMineCapsules(serverId).then(() => router.renderCurrent()).catch((error) => {
      panel.append(h("p", { class: "form-error", text: error.message })); // G-2 verbatim
    });
    return;
  }
  panel.append(capsuleRows(store.get(mineKey(serverId)), serverId));
}

// The compose door: the letter well + the postmark seat. The submit is the
// member's own act; ONE confirm openDialog precedes the single POST — the
// settings.js idiom — and the dialog's body is the letter itself,
// member-composed text painted verbatim through its own textContent seat.
function composePanel(serverId) {
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const well = h("textarea", {
    class: "composer-well", rows: "4",
    placeholder: t("gc.capsules.compose.placeholder"),
    "aria-label": t("gc.capsules.compose.placeholder"),
    maxlength: String(UI_CAPSULE_BODY_MAX),
  });
  const postmarkSeat = h("input", {
    class: "search-well", type: "datetime-local",
    "aria-label": t("gc.capsules.reveal.label"),
  });
  const form = h("form", { class: "capsule-compose" },
    well,
    h("p", { class: "muted", text: t("gc.capsules.compose.hint") }),
    postmarkSeat,
    h("button", { class: "button button-primary", type: "submit",
      text: t("gc.capsules.compose.seal") }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = well.value.trim();
    if (text.length < 1 || text.length > UI_CAPSULE_BODY_MAX) {
      errorLine.textContent = t("gc.capsules.compose.empty");
      return;
    }
    const rawSeat = postmarkSeat.value;
    const postmark = rawSeat ? Math.floor(Date.parse(rawSeat) / 1000) : NaN;
    if (!rawSeat || !Number.isFinite(postmark)) {
      errorLine.textContent = t("gc.capsules.reveal.needed");
      return;
    }
    const ahead = postmark - Math.floor(Date.now() / 1000);
    if (ahead < UI_CAPSULE_MIN_AHEAD_SECONDS || ahead > UI_CAPSULE_MAX_AHEAD_SECONDS) {
      errorLine.textContent = t("gc.capsules.reveal.range", { min: UI_CAPSULE_MIN_AHEAD_SECONDS / 60, max: UI_CAPSULE_MAX_AHEAD_SECONDS / 86400 });
      return;
    }
    // One explicit confirm step (the defaults law) before the single POST.
    // The dialog body is composed of the letter itself — never t()'d, never
    // interpolated (the welcome-card law).
    const confirmBody = h("p", { class: "gate-copy" });
    confirmBody.textContent = text;
    openDialog(document, {
      heading: t("gc.capsules.compose.confirmHeading"),
      body: confirmBody,
      modalOnly: true,
      actions: [
        { class: "button button-primary", text: t("gc.capsules.compose.seal"), onPress: async () => {
          try {
            await createCapsule(serverId, text, postmark);
            well.value = "";
            postmarkSeat.value = "";
            errorLine.textContent = "";
            await loadMineCapsules(serverId);
            router.renderCurrent();
          } catch (error) {
            errorLine.textContent = error.message; // the route's 400/409 family, verbatim
          }
        } },
        { class: "button button-quiet", text: t("gc.controls.keep") },
      ],
    });
  });
  return h("div", { class: "capsule-compose-block" }, form, errorLine);
}

// The pointer rows: the sealed rows paint the schedule (the future
// date-time stamp) and hold the delete door; the open rows keep their
// postmark fact and carry the member-initiated reveal. A refused reveal
// (the non-author pre-reveal 404) or refusal-to-delete family paints the
// server's own string verbatim and the panel keeps its painted rows.
function capsuleRows(rows, serverId) {
  if (rows.length === 0) {
    return h("p", { class: "empty-state", text: t("gc.capsules.empty") });
  }
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  // The shown count rides the rows actually painted; the payload's own
  // truncated flag is the only seat that turns the line on (the
  // gc.bookmarks.more idiom — presence, never an invented total).
  const truncated = store.get(mineTruncatedKey(serverId)) === true;
  const truncatedRow = h("p", { class: "muted count-line", text: t("gc.capsules.more", { shown: rows.length }) });
  const tail = truncated === true ? [truncatedRow, errorLine] : [errorLine];
  const list = h("div", { class: "capsule-rows" });
  for (const row of rows) {
    // The sealed fact recomputes at PAINT time from revealAt against now —
    // exactly the backend's own per-row recompute idiom (the mine route's
    // sealed seat). A lane mirror that crossed its postmark since the load
    // paints the revealed state; never a session-stale delete door (the
    // route's 409 stays the raced backstop).
    const paintSealed = Number(row.revealAt) > Math.floor(Date.now() / 1000);
    if (paintSealed) {
      // The delete door rides the own PRE-reveal row only — the route's
      // 409 revealed-locked answer is the raced backstop, verbatim.
      list.append(h("div", { class: "capsule-row capsule-row-sealed" },
        h("span", { class: "muted capsule-when",
          text: t("gc.capsules.row.sealedLabel", { when: revealStamp(row.revealAt) }) }),
        h("button", {
          class: "button button-quiet capsule-delete", type: "button",
          text: t("gc.capsules.row.delete"),
          onClick: async () => {
            openDialog(document, {
              heading: t("gc.capsules.delete.confirmHeading"),
              body: h("p", { class: "gate-copy",
                text: t("gc.capsules.row.sealedLabel", { when: revealStamp(row.revealAt) }) }),
              modalOnly: true,
              actions: [
                { class: "button button-danger", text: t("gc.capsules.row.delete"), onPress: async () => {
                  try {
                    await deleteCapsule(serverId, row.id);
                    await loadMineCapsules(serverId);
                    router.renderCurrent();
                  } catch (error) {
                    errorLine.textContent = error.message; // 404/409 verbatim
                  }
                } },
                { class: "button button-quiet", text: t("gc.controls.keep") },
              ],
            });
          },
        })));
      continue;
    }
    const revealAt = Number(row.revealAt);
    const whenLine = h("span", { class: "muted capsule-when",
      text: t("gc.capsules.row.openLabel", { when: revealStamp(row.revealAt) }) });
    const letterSeat = h("p", { class: "capsule-letter form-error", hidden: true, role: "alert" });
    const openButton = h("button", {
      class: "button button-quiet capsule-open", type: "button",
      text: t("gc.capsules.row.open"),
      onClick: async () => {
        try {
          const revealed = await revealCapsule(serverId, row.id);
          // The unsealed shape alone carries the body — the savedStamp guard
          // family: a sealed-shape 200 (the author's pre-postmark arm) keeps
          // the schedule paint, never an undefined body seat.
          if (revealed?.sealed === false && typeof revealed.body === "string") {
            letterSeat.hidden = false;
            letterSeat.className = "capsule-letter";
            letterSeat.textContent = revealed.body; // the letter paints verbatim through its own textContent seat
            whenLine.textContent = t("gc.capsules.stamp", { when: revealStamp(revealed.revealAt ?? revealAt) });
            openButton.hidden = true;
            return;
          }
          letterSeat.hidden = true;
          letterSeat.textContent = "";
        } catch (error) {
          letterSeat.hidden = false;
          letterSeat.className = "capsule-letter form-error"; // the non-revealed 404, the row's own seat
          letterSeat.textContent = error.message;
        }
      },
    });
    list.append(h("div", { class: "capsule-row" }, whenLine, openButton, letterSeat));
  }
  return h("div", { class: "capsule-list" }, list, ...tail);
}

// The reveal_at is unix seconds (capsules.mjs writes nowSeconds()): the
// stamp renders the UTC minute, the savedStamp idiom's twin (the
// tenureStartedAt dash seat in economy.js). A non-finite seat paints the
// "—" dash, never the RangeError that would kill the whole panel render.
function revealStamp(revealAt) {
  const seconds = Number(revealAt);
  if (!Number.isFinite(seconds)) return "—";
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}
