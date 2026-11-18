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

// The rules-gate accept flow — ONE shared module for both arms (the REST 403
// payload and the WS send_failed frame, which carries the same
// {rules, serverId} pair): a gate 403 opens the one accept confirmation, the
// accept POST re-offers the member's original action exactly once on their
// own button, and a refusal simply ends (nothing auto-retries a "no").
//
// A gate error is recognizable by its shape: status 403, error string "You
// must accept this server's rules before doing that.", and the { serverId,
// rules } pair — either in the payload or in the X-Rules-Gate header
// ("server:<id>", the disambiguator api.js lands on .rulesGate). Anything
// else returns false and the caller renders its own ordinary 403 handling.

import { h } from "../core/dom.js";
import { api } from "../core/api.js";
import { openDialog } from "../vendor/frontload/dom.mjs";
import { t } from "../i18n.js";

const GATE_MESSAGE = "You must accept this server's rules before doing that.";

export function rulesGateError(error) {
  if (!error || error.status !== 403 || error.message !== GATE_MESSAGE) return null;
  let serverId = typeof error.serverId === "number" ? error.serverId : null;
  if (!serverId && typeof error.rulesGate === "string" && error.rulesGate.startsWith("server:")) {
    const fromHeader = Number(error.rulesGate.slice(7));
    if (Number.isInteger(fromHeader) && fromHeader > 0) serverId = fromHeader;
  }
  if (!serverId || typeof error.rules !== "string") return null;
  return { serverId, rules: error.rules };
}

// guardRulesGate(doc, error, onAccepted) -> true when the gate claim was
// recognized and the accept dialog shown, false for any other error (the
// caller renders it itself). onAccepted is the member's ORIGINAL action,
// re-offered once via their own click of the confirm button's commit path.
export function guardRulesGate(doc, error, onAccepted) {
  const gate = rulesGateError(error);
  if (!gate) return false;
  const body = h("div", { class: "rules-gate-copy" },
    h("p", { class: "gate-copy", text: t("gc.gate.body") }),
    h("div", { class: "rules-doc", tabindex: "0", text: gate.rules }));
  openDialog(doc, {
    heading: t("gc.gate.heading"),
    body,
    modalOnly: true,
    actions: [
      {
        class: "button button-primary",
        text: t("gc.gate.accept"),
        onPress: async () => {
          try {
            // First accept 201 {changed:true}; replay 200 {changed:false} —
            // either way the member's original action is re-offered once.
            await api(`/api/servers/${gate.serverId}/rules/accept`, { method: "POST" });
            await onAccepted();
          } catch {
            // An accept failure keeps the member where they are; the panel
            // that owns the original action renders its own error next time.
          }
        },
      },
      { class: "button button-quiet", text: t("gc.gate.later") },
    ],
  });
  return true;
}
