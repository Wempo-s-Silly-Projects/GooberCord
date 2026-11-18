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

// The landing gate. GC builds NO registration and NO account settings (the
// door-swap law) — this module only moves ticket/Accounts traffic: the
// one-time ?wt= ticket parses strictly, drops BEFORE the redeem, never
// reposts; a signed-out open goes UP to Wempo Accounts; sign-out breaks the
// return loop. The refusal card's ban payload rides the additive fields.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { WEMPO_ACCOUNTS_ORIGIN, wempoAccountsSignInUrl, wempoAccountsSignOutUrl,
  ssoTicketFromSearch, applySession } from "../public/js/ui/landing.js";
import store from "../public/js/core/store.js";

const HERE = dirname(new URL(import.meta.url).pathname);
const SOURCE = readFileSync(join(HERE, "../public/js/ui/landing.js"), "utf8");

test.beforeEach(() => store.reset());

test("the ticket parser accepts 32-byte hex only (any case), nothing else", () => {
  const ticket = "a".repeat(32) + "B".repeat(32);
  assert.equal(ssoTicketFromSearch(`?wt=${ticket}`), ticket.toLowerCase());
  assert.equal(ssoTicketFromSearch("?wt=" + "g".repeat(64)), "", "non-hex is absent");
  assert.equal(ssoTicketFromSearch("?wt=" + "a".repeat(63)), "", "wrong length is absent");
  assert.equal(ssoTicketFromSearch("?wt"), "");
  assert.equal(ssoTicketFromSearch("?wt=&x=1"), "");
  assert.equal(ssoTicketFromSearch("?other=1&wt=" + "a".repeat(64)), "a".repeat(64));
});

test("the URLs hand the door to Accounts; sign-out never carries a return", () => {
  assert.equal(WEMPO_ACCOUNTS_ORIGIN, "https://accounts.itswempo.workers.dev");
  assert.match(wempoAccountsSignInUrl("https://gc.example"), /\/\?return=https%3A%2F%2Fgc\.example/);
  assert.equal(wempoAccountsSignOutUrl(), WEMPO_ACCOUNTS_ORIGIN + "/?signout=1");
  assert.doesNotMatch(SOURCE, /signout=1.*return=/, "no auto-ticket loop through sign-out");
});

test("applySession fills the store from /api/me's shape (and tolerates guests)", () => {
  applySession({ user: { id: 1, username: "wempo", role: "owner" }, csrfToken: "tok" });
  assert.equal(store.get("user").username, "wempo");
  assert.equal(store.get("csrfToken"), "tok");
  applySession(null);
  assert.equal(store.get("user"), null);
});

test("the redeem happens against the existing SSO endpoint with { wt }", () => {
  const redeem = SOURCE.match(/api\("([^"]+)", \{ method: "POST", body: \{ wt: ticket \} \}\)/);
  assert.ok(redeem, "the gate redeems /api/auth/sso/redeem");
  assert.equal(redeem[1], "/api/auth/sso/redeem");
  assert.match(SOURCE, /clearTicketParam\(win\)/, "the ticket drops before the call could reload it");
});

test("a refused redeem is a STOP: the ban payload renders, no auto-redirect follows", () => {
  assert.match(SOURCE, /banned === true/);
  assert.match(SOURCE, /error\.reason/);
  assert.match(SOURCE, /expiresAt/);
  assert.doesNotMatch(SOURCE, /location\.replace\([^)]*\)[\s\S]*refused/,
    "the refusal path must not redirect");
  // The refusal card's next action is a LINK back to Accounts (a navigation,
  // never a button — the button grammar is for commits).
  assert.match(SOURCE, /class: "button button-quiet gate-action"/);
});

test("the landing card speaks through the bundle", () => {
  const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
  const pinned = {
    "gc.auth.banned.heading": "Your account is currently banned",
    "gc.auth.banned.noReason": "No reason was provided.",
    "gc.auth.banned.reactivates": "Reactivates",
    "gc.auth.gate.heading": "Can't sign in right now",
    "gc.auth.gate.body": "The Wempo Accounts sign-in isn't completing. Your sign-in link is single-use and may have expired or already been used.",
    "gc.auth.gate.retry": "Try again from Wempo Accounts",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(en[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.match(SOURCE, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
});
