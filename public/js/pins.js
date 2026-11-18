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

// The pins lane (the W-F2 wave): the channel's pinned read, the pin-right
// mirror, and the pinned-messages dialog. The backend (0026):
//   - PUT/DELETE /api/messages/:id/pin — the pin ride, idempotent both ways
//     (the already-pinned pin and the unpinned unpin answer the same 200);
//   - GET /api/channels/:id/pins — the NEWEST-FIRST page (bounded by the
//     server's own cap), payloads are the history read's own shape;
//   - the right: own-message OR the moderation grant (platform staff, the
//     server's owner/moderator tiers, or the merged DELETE_MESSAGES bit) —
//     GC carries no separate pin bit (Discord's Aug-2025 grant-family
//     split), so the mirror binds the same power.
// The cap NEVER lives here: the over-cap refusal is the server's own copy
// ("This channel already has N pins."), surfaced verbatim; the client
// invents no slot numbers and displays no cap counts.
import { el } from "./dom.js";
import { t } from "./i18n.js";
import { api } from "./api.js";
import { iconButton } from "./icons.js";

// The pin-power bit's client mirror: the backend's
// SERVER_PERMISSIONS.DELETE_MESSAGES (api/permissions.mjs) is the authority;
// the equality pin carries the mirror.
export const DELETE_MESSAGES_BIT = 1 << 4;

// canPin(message, me, server, viewer): the backend pinRights's exact
// client mirror, decided in the same order:
//   1. own-message pins, both directions;
//   2. platform staff (the site's owner/admin tiers);
//   3. the server's owner/moderator string tiers;
//   4. the viewer's server-wide merged mask holding DELETE_MESSAGES.
// A DM/group channel passes server=null — own-or-staff only, like the
// server's non-server arm. The unknown-roster arm ADMITS (the mention
// gate's spirit: an unloaded roster never warns falsely; the server's 403
// stays the authority on the wire).
export function canPin(message, me, server, viewer) {
  if (!message || !me) return false;
  if (Number(message.authorId) === Number(me.id)) return true;
  if (me.role === "owner" || me.role === "admin") return true;
  if (!server) return false;
  if (server.role === "owner" || server.role === "moderator") return true;
  if (!viewer) return true; // an unloaded roster admits — the 403 speaks
  if (viewer.owner) return true;
  return Array.isArray(viewer.permissions)
    && viewer.permissions.includes("DELETE_MESSAGES");
}

// The read: GET /api/channels/:id/pins — oldest-last by construction (the
// payload is newest-first); the rows are the payload's own, never assumed.
export async function loadPinnedMessages(channelId) {
  const payload = await api("/api/channels/" + Number(channelId) + "/pins");
  return Array.isArray(payload?.messages) ? payload.messages : [];
}

// openPinnedMessagesDialog(doc, win, channelId, context): the pinned list —
// one row per pin (author + time + body, an attachment note when the row
// carries one), each row's unpin affordance decided by the SAME mirror
// (the dialog's unpin rides DELETE /api/messages/:id/pin, idempotent).
// context = { server, viewer } resolvers for the gate; mutations rerender
// the list in place and notify the caller's cache sync (onMutated).
export function openPinnedMessagesDialog(doc, win, channelId, context, onMutated) {
  const error = el("p", { class: "error-strip", role: "alert" });
  const list = el("div", { class: "pins-list" });
  let rows = [];

  const rowNode = (message) => {
    const row = el("div", { class: "pin-row" });
    // The right rides the SAME mirror the message rows' pin affordance
    // reads — the server's 403 stays the authority on the wire.
    const pinOk = canPin(message, context.me, context.server, context.viewer());
    const head = el("div", { class: "pin-row-head" },
      el("strong", { class: "pin-author", text: String(message.authorName || "?") }));
    // (The payload carries no created timestamp by shape — publicMessage's
    // own fields only — so the row says author + body + attachments, never
    // an invented field read.)
    if (pinOk) {
      const unpin = iconButton(doc, "pin", {
        ariaLabel: "Unpin this message",
        className: "icon-button button-quiet pin-unpin",
      });
      unpin.addEventListener("click", async () => {
        try {
          await api("/api/messages/" + Number(message.id) + "/pin", { method: "DELETE" });
          rows = rows.filter((entry) => Number(entry.id) !== Number(message.id));
          if (typeof onMutated === "function") void onMutated();
          await rerender();
        } catch (caught) {
          // The server's own copies verbatim (the pin right, the cap).
          error.textContent = caught?.message || "The pin could not be removed.";
        }
      });
      head.append(unpin);
    }
    row.append(head);
    const body = el("p", { class: "pin-body", text: String(message.body ?? "") });
    row.append(body);
    const attachmentCount = (message.attachmentIds || []).length;
    if (attachmentCount > 0) {
      row.append(el("p", { class: "muted pin-note",
        text: attachmentCount === 1 ? "1 attachment" : attachmentCount + " attachments",
      }));
    }
    return row;
  };

  const rerender = async () => {
    try {
      rows = await loadPinnedMessages(channelId);
      list.replaceChildren();
      if (rows.length === 0) {
        list.append(el("p", { class: "muted pins-empty",
          text: t("gc.chat.pins.empty") }));
        return;
      }
      for (const message of rows) list.append(rowNode(message));
    } catch (caught) {
      // The shared refusal shape (a non-viewer 404s; the gate's own copy).
      error.textContent = caught?.message ||
        "This channel does not exist or you cannot view it.";
    }
  };

  const dialog = el("dialog", { class: "gc-dialog pins-dialog" },
    el("h2", { text: t("gc.chat.pins.title") }),
    el("p", { class: "muted pins-note", text: t("gc.chat.pins.note") }),
    list,
    error,
    el("div", { class: "form-actions" },
      el("button", { class: "button button-quiet", type: "button", text: t("gc.chat.pins.close") })),
  );
  dialog.querySelector(".form-actions button").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  doc.body.append(dialog);
  dialog.showModal();
  void rerender();
}
