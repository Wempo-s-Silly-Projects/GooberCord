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

// The anniversary seat (the wave-15 slate): the client face of the live,
// byte-frozen backend (api/paper.mjs:291-341 — PUT + DELETE
// /api/users/me/anniversary). STRUCTURAL ONLY: the seat mirrors month 0-11 /
// day 1-31, invents no per-month day counts and no leap math — Feb 30
// stores verbatim and simply never fires (matching is pure (month, day)
// equality on the celebrant join). The seat opens EMPTY (defaults law: no
// pre-filled month), the PUT is the one explicit save, the DELETE is one
// explicit clear with no confirm ceremony (absence IS the off-state, the
// route answers its cleared state, never a 404), and the truth line paints
// the route's own answer — the schema carries month+day and nothing else
// (LIMIT COLLECTION NOT ACCESS at the door too).

import { h } from "../core/dom.js";
import { t } from "../i18n.js";
import { api } from "../core/api.js";
import store from "../core/store.js";
import { createSelect } from "../vendor/designer/kit.mjs";
import * as router from "../core/router.js";
import { renderShell } from "./shell.js";

// G-4: GC_USER_ANNIVERSARY_MONTH_MAX and GC_USER_ANNIVERSARY_DAY_MAX (constants.mjs)
// — the structural bounds the backend's 400 family enforces
// (api/paper.mjs:304-308), never raised client-side. Declared ONCE here.
export const UI_ANNIVERSARY_MONTH_MAX = 11;
export const UI_ANNIVERSARY_DAY_MAX = 31;

// PUT /api/users/me/anniversary { month, day } — the one save. A second
// save overwrites in place (the backend's ON CONFLICT upsert); the lane
// paints the ANSWER, never the form's hope.
export async function setAnniversary(month, day) {
  const answer = await api("/api/users/me/anniversary", {
    method: "PUT", body: { month, day },
  });
  store.set({ meAnniversary: { month: answer.month, day: answer.day } });
  return answer;
}

// DELETE /api/users/me/anniversary — the one clear, no confirm ceremony:
// the route is idempotent (an untouched member's clear answers its state
// too — absence IS the off-state).
export async function clearAnniversary() {
  const answer = await api("/api/users/me/anniversary", { method: "DELETE" });
  store.set({ meAnniversary: { month: answer.month, day: answer.day } });
  return answer;
}

// The saved-truth line: only a whole month-day paints the saved face; the
// cleared or never-answered state paints the empty face — no invented
// middle state, no per-month arithmetic, nothing but the painted numbers.
function truthLine() {
  const state = store.get("meAnniversary");
  const line = h("p", { class: "muted anniversary-truth" });
  if (state && Number.isInteger(state.month) && Number.isInteger(state.day)) {
    line.textContent = t("gc.anniversary.current", { month: state.month, day: state.day });
  } else {
    line.textContent = t("gc.anniversary.empty");
  }
  return line;
}

function seatForm(errorLine) {
  const monthOptions = [
    { value: "", label: t("gc.anniversary.unset") },
  ];
  for (let month = 0; month <= UI_ANNIVERSARY_MONTH_MAX; month += 1) {
    monthOptions.push({ value: String(month), label: t("gc.anniversary.monthOption", { number: month + 1 }) });
  }
  const dayOptions = [
    { value: "", label: t("gc.anniversary.unset") },
  ];
  for (let day = 1; day <= UI_ANNIVERSARY_DAY_MAX; day += 1) {
    dayOptions.push({ value: String(day), label: String(day) });
  }
  const monthField = createSelect(document, {
    id: "anniversary-month", label: t("gc.anniversary.monthLabel"), options: monthOptions,
  });
  const dayField = createSelect(document, {
    id: "anniversary-day", label: t("gc.anniversary.dayLabel"), options: dayOptions,
  });
  const monthPick = monthField.querySelector("select");
  const dayPick = dayField.querySelector("select");
  const saveButton = h("button", { class: "button", type: "button", text: t("gc.anniversary.save") });
  const clearButton = h("button", { class: "button button-quiet anniversary-clear", type: "button", text: t("gc.anniversary.clear") });
  // The save speaks only with both structural keys picked — no partial act,
  // no invented client copy: the backend's own 400 copy never has to speak.
  const syncSave = () => {
    saveButton.disabled = !(monthPick.value !== "" && dayPick.value !== "");
  };
  monthPick.addEventListener("change", syncSave);
  dayPick.addEventListener("change", syncSave);
  syncSave();
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      const month = Number(monthPick.value);
      const day = Number(dayPick.value);
      await setAnniversary(month, day);
      router.renderCurrent(); // the truth line re-paints from the route's answer
    } catch (error) {
      errorLine.textContent = error.message; // the 400 family paints verbatim (G-2)
      syncSave();
    }
  });
  clearButton.addEventListener("click", async () => {
    clearButton.disabled = true;
    try {
      await clearAnniversary();
      router.renderCurrent();
    } catch (error) {
      errorLine.textContent = error.message;
      clearButton.disabled = false;
    }
  });
  return h("div", { class: "anniversary-seat" }, monthField, dayField,
    h("div", { class: "form-actions" }, saveButton, clearButton));
}

// /anniversary — the self-scoped task page (the shell's door is its rail
// entry; the route registers in shell.js, main.js untouched — the
// reaction-tags panel's door idiom).
export function renderAnniversaryPanel(route, mount) {
  const errorLine = h("p", { class: "form-error", role: "alert", "aria-live": "polite" });
  const body = h("section", { class: "task-page" },
    h("header", { class: "task-header" },
      h("a", { class: "back-link", href: "/", text: t("gc.controls.back") }),
      h("h2", { class: "page-heading", text: t("gc.anniversary.heading") })));
  const panel = h("div", { class: "panel" },
    h("h3", { text: t("gc.anniversary.heading") }),
    h("p", { class: "muted", text: t("gc.anniversary.description") }),
    truthLine(), seatForm(errorLine), errorLine);
  mount.append(renderShell(route, h("section", { class: "pane-main task-main" },
    h("div", { class: "pane-body" }, body, panel))));
}
