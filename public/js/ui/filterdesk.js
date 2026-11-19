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

// The staff filter desk (the wave-16 slate): the client face of the live,
// byte-frozen word-filter backend (api/filterstore.mjs:89-170 — GET
// /api/admin/filter + POST /api/admin/filter/entries, requireStaff). Scope
// truth: /api/admin/* is platform-staff — owner/admin role, no server id in
// the URL, ONE shared site_settings row ("filtered_words"), no per-server
// lane keys. The GET rides its own open (defaults law: one auto-load per
// visit), the POST adds ONE entry behind the one explicit submit, and every
// staff-gate / validation refusal paints the backend's verbatim copy. No
// delete arm exists anywhere (the byte-frozen PUT full-list editor stays
// unpainted this wave) — the desk paints what exists, nothing more.
import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createInput } from "../vendor/designer/kit.mjs";
import { renderShell } from "./shell.js";
import { t } from "../i18n.js";

function shellWrap(pane) {
  return renderShell(null, pane);
}

// The desk: the attachment queue's platform-staff idiom — a non-staff
// session renders the shared permission face, never a fake desk; the server's
// own refusals stay verbatim wherever they land.
export function renderFilterDesk(route, mount) {
  const user = store.get("user");
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: "/admin-queue", text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.filterdesk.heading") })));
  if (!user || !["admin", "owner"].includes(user.role)) {
    body.append(h("p", { class: "empty-state", text: t("gc.settings.errors.permission") }));
    mount.append(shellWrap(h("section", { class: "pane-main task-main" },
      h("div", { class: "pane-body" }, body))));
    return;
  }
  body.append(deskPanel());
  mount.append(shellWrap(h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body))));
}

function deskPanel() {
  const panel = h("div", { class: "panel" });
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const countLine = h("p", { class: "muted count-line" });
  const resultLine = h("p", { class: "muted count-line" });

  // The one explicit submit — ONE entry per act; the backend's own 400/413
  // copies are the truth after any client slip (no client oracle).
  const entryBox = createInput(document, {
    id: "filter-entry", label: t("gc.filterdesk.entryLabel"),
    description: t("gc.filterdesk.entryHelp"),
  });
  const submitButton = h("button", { class: "button button-primary", type: "button",
    text: t("gc.filterdesk.submit") });
  submitButton.addEventListener("click", async () => {
    const entries = entryBox.querySelector("input").value.trim();
    try {
      const answer = await api("/api/admin/filter/entries", {
        method: "POST", body: { entries },
      });
      resultLine.textContent = t("gc.filterdesk.result", {
        added: answer.added, skipped: answer.skipped, total: answer.totalEntries,
      });
      countLine.textContent = t("gc.filterdesk.stateEntries", { total: answer.totalEntries });
      errorLine.textContent = "";
    } catch (error) {
      errorLine.textContent = error.message; // the 400 / 413 / staff-gate 403 verbatim
    }
  });

  panel.append(h("h3", { text: t("gc.filterdesk.heading") }),
    countLine, entryBox, submitButton, resultLine, errorLine);

  // The defaults law: the desk GET rides its own open — one auto-load per
  // visit, its answer the state's paint source, no refresh loop.
  api("/api/admin/filter", { method: "GET" }).then((state) => {
    countLine.textContent = t("gc.filterdesk.stateEntries", { total: state.totalEntries });
    panel.append(
      h("p", { class: "muted", text: t("gc.filterdesk.stateSource", { source: state.source }) }),
      h("p", { class: "muted", text: state.updatedAt
        ? t("gc.filterdesk.stateUpdated", { at: state.updatedAt })
        : t("gc.filterdesk.stateNeverUpdated") }));
  }).catch((error) => {
    errorLine.textContent = error.message; // the staff-gate 403 verbatim
  });
  return panel;
}
