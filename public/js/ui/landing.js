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

// The landing/auth gate. GooberCord has NO sign-in page of its own (the §4b
// door-swap): Wempo Accounts handles sign-in and registration, and hands a
// member back with a one-time ?wt= ticket that GooberCord redeems right here
// on its own origin. This module is that gate — every signed-out open lands
// in it on boot — and its three outcomes are pinned by tests:
//   1. A ?wt= ticket present + signed out -> redeem; on success boot
//      continues signed in. The parameter is dropped UNCONDITIONALLY
//      (signed-in opens, malformed values included) before anything else,
//      because a one-time code must never be re-posted by a reload.
//   2. Signed out, no ticket -> replace the address with the Accounts
//      sign-in URL (which carries ?return= back to GooberCord's origin).
//   3. A refused redeem -> a refusal card and a STOP — never an automatic
//      redirect back to Accounts (that would ping-pong the open until the
//      ticket burns again). The card carries the ban payload when the
//      server sent one; otherwise a manual retry link.
import { h } from "../core/dom.js";
import { api, setCsrfToken } from "../core/api.js";
import { t } from "../i18n.js";
import store from "../core/store.js";

export const WEMPO_ACCOUNTS_ORIGIN = "https://accounts.itswempo.workers.dev";

export function wempoAccountsSignInUrl(origin) {
  return WEMPO_ACCOUNTS_ORIGIN + "/?return=" + encodeURIComponent(origin || "");
}

// A 32-byte-hex one-time ticket ONLY — anything else (?missing, wrong
// length, non-hex) is treated as absent. Uppercase hex is tolerated (the
// redeem endpoint normalizes).
export function ssoTicketFromSearch(search) {
  let value = null;
  try {
    value = new URLSearchParams(search || "").get("wt");
  } catch {
    return "";
  }
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : "";
}

// Drop ?wt= (and nothing else the URL carried) from the address bar WITHOUT
// touching the router's path or adding a history entry — history.replaceState
// keeps the ticket unrepostable by re-render, reload, or back button.
export function clearTicketParam(win) {
  const params = new URLSearchParams(win.location.search || "");
  if (!params.has("wt")) return false;
  params.delete("wt");
  const query = params.toString();
  win.history.replaceState(
    null,
    "",
    win.location.pathname + (query ? "?" + query : "") + win.location.hash,
  );
  return true;
}

// renderRedeemRefusal(doc, win, error) — the refusal card for outcome 3. The
// mount guard (T-W23): a document with neither #app nor a body is a silent
// skip — a TypeError from replaceChildren would be the boot's own crash card,
// not this lane's failure to show.
export function renderRedeemRefusal(doc, win, error) {
  if (!doc) return;
  const mount = doc.getElementById("app") || doc.body;
  if (!mount) return;
  mount.replaceChildren();
  const panel = h("div", { class: "gate-panel gate-refusal" });
  if (error && error.banned === true) {
    panel.append(
      h("h2", { class: "gate-title", text: t("gc.auth.banned.heading") }),
      h("p", {
        class: "gate-copy",
        text: typeof error.reason === "string" && error.reason
          ? error.reason
          : t("gc.auth.banned.noReason"),
      }),
    );
    if (typeof error.expiresAt === "number" && Number.isFinite(error.expiresAt)) {
      panel.append(h("p", {
        class: "gate-copy",
        text: t("gc.auth.banned.reactivates") + " " + new Date(error.expiresAt * 1000).toLocaleString(),
      }));
    }
  } else {
    panel.append(
      h("h2", { class: "gate-title", text: t("gc.auth.gate.heading") }),
      h("p", {
        class: "gate-copy",
        text: t("gc.auth.gate.body"),
      }),
      h("a", {
        class: "button button-quiet gate-action",
        href: wempoAccountsSignInUrl(win.location.origin),
        text: t("gc.auth.gate.retry"),
      }),
    );
  }
  mount.append(panel);
}

// applySession(result) — the /api/me (and redeem) payload: { user, csrfToken }.
export function applySession(result) {
  const user = result?.user || null;
  setCsrfToken(result?.csrfToken || "");
  store.set({ user, csrfToken: result?.csrfToken || "" });
  return user;
}

// The sign-out handoff: the member lands on Accounts with ?signout=1 (no
// return parameter — an Accounts URL that could auto-ticket straight back
// would make Log out impossible), clearing the Accounts session too.
export function wempoAccountsSignOutUrl() {
  return WEMPO_ACCOUNTS_ORIGIN + "/?signout=1";
}

// ensureSignedIn({ doc, win }) — the boot gate. Resolves "signed-in" | "refused";
// NEVER resolves "signed-out" without having first sent the open to Accounts.
export async function ensureSignedIn({ doc = document, win = window } = {}) {
  const user = store.get("user");
  // 1. Read the ticket BEFORE the strip. (The old client's boot did these in
  //    the opposite order — captured `location.search` only after the
  //    replaceState had already removed the parameter — which makes the
  //    redeem branch unreachable in a real browser, where a replaceState is
  //    visible to the very next location read. The rewrite fixes the order:
  //    capture, then strip the address, then redeem the captured value.)
  const ticket = ssoTicketFromSearch(win.location.search);
  // 2. Drop the ticket parameter unconditionally, signed-in opens included.
  clearTicketParam(win);

  if (!user && ticket) {
    try {
      const redeemed = await api("/api/auth/sso/redeem", { method: "POST", body: { wt: ticket } });
      applySession(redeemed);
    } catch (error) {
      renderRedeemRefusal(doc, win, error);
      return "refused";
    }
  }

  if (store.get("user")) return "signed-in";

  // 2. The silent door: every signed-out open goes to Wempo Accounts.
  win.location.replace(wempoAccountsSignInUrl(win.location.origin));
  return "redirected";
}
