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

// The mod desk: the 0010 grammar AS SHIPPED (the terms editor is the
// one-per-line textarea string arm), the mirrored constants with equality
// pins, the alerts feed's quiet empty state, the ban body WITHOUT coercion,
// prune's dry-run-first flow, the member card's rank-gated mod controls, and
// the staff attachment queue (reject states the byte deletion).
import "./helpers/xhr-shim.mjs"; // lane-xhr wave-21: mounts globalThis.XMLHttpRequest (the transport bridge)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const calls = [];
let responses = [];
globalThis.fetch = async (path, init = {}) => {
  calls.push({ path, method: init.method || "GET", body: init.body });
  const response = responses.shift();
  return new Response(typeof response === "string" ? response : JSON.stringify(response),
    { status: Number.isInteger(response?.status) ? response.status : 200 });
};

const mod = await import("../public/js/ui/mod.js");
const store = (await import("../public/js/core/store.js")).default;
const permissions = await import("../api/permissions.mjs");
const filterrules = await import("../api/filterrules.mjs");
const MOD = readFileSync(join(HERE, "../public/js/ui/mod.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
const MEMBERS = readFileSync(join(HERE, "../public/js/ui/members.js"), "utf8");

test.beforeEach(() => {
  calls.length = 0;
  responses = [];
  store.reset();
});

test("the mirrored constants equal the backend's exports (G-4)", () => {
  assert.deepEqual([...mod.UI_TIMEOUT_MINUTE_CHOICES], [...permissions.TIMEOUT_MINUTE_CHOICES]);
  // Timeout menu = ONLY the seven choices (the 28-day seat is the max).
  assert.deepEqual(mod.UI_TIMEOUT_MINUTE_CHOICES, [1, 5, 10, 60, 1440, 10080, 40320]);
  assert.equal(mod.UI_FILTER_RULE_MAX, filterrules.FILTER_RULE_MAX_RULES);
  assert.equal(mod.UI_FILTER_RULE_NAME_MAX, filterrules.FILTER_RULE_NAME_MAX);
  assert.equal(mod.UI_FILTER_RULE_MAX_TERMS, filterrules.FILTER_RULE_MAX_TERMS);
  assert.equal(mod.UI_FILTER_RULE_TERM_CHARS, filterrules.FILTER_RULE_TERM_CHARACTERS);
  assert.equal(mod.UI_FILTER_RULE_BLOCK_MESSAGE_MAX, filterrules.FILTER_RULE_BLOCK_MESSAGE_MAX);
  assert.equal(mod.UI_FILTER_RULE_EXEMPT_ROLES_MAX, filterrules.FILTER_RULE_EXEMPT_ROLES_MAX);
  assert.equal(mod.UI_FILTER_RULE_EXEMPT_CHANNELS_MAX, filterrules.FILTER_RULE_EXEMPT_CHANNELS_MAX);
  assert.equal(mod.UI_FILTER_ALERTS_PAGE_MAX, filterrules.FILTER_ALERTS_PAGE_MAX);
  assert.deepEqual([...mod.UI_FILTER_RULE_ACTIONS], [...filterrules.FILTER_RULE_ACTIONS]);
  // BAN_REASON_MAX never got an export — the mirror pins the source's number.
  const servers = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");
  assert.equal(mod.UI_BAN_REASON_MAX, Number(/BAN_REASON_MAX = (\d+)/.exec(servers)[1]));
  assert.equal(mod.UI_BAN_REASON_MAX, 280);
});

test("routes: the desk, the rule editor (new before :rid), the queue", () => {
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/mod", "mod", renderModDesk\)/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/filter\/rules\/new", "filter-rule-new"/);
  assert.match(MAIN, /addRoute\("\/s\/:serverId\/filter\/rules\/:rid", "filter-rule"/);
  assert.match(MAIN, /addRoute\("\/admin-queue", "staff-queue", renderStaffQueue\)/);
  assert.ok(MAIN.indexOf('"filter-rule-new"') < MAIN.indexOf('"filter-rule",'));
  assert.ok(MAIN.indexOf('"mod", renderModDesk') < MAIN.indexOf('"channel", renderChannelPane'));
});

test("the terms editor is the ONE-PER-LINE TEXTAREA (the string arm), bounded at the line seat", () => {
  assert.match(MOD, /h\("textarea", \{\s*\n?\s*id: "rule-terms"/);
  assert.match(MOD, /terms: termsBox\.value/, "the STRING arm rides the write");
  assert.match(MOD, /maxlength: String\(UI_FILTER_RULE_TERM_CHARS \* UI_FILTER_RULE_MAX_TERMS\)/);
  assert.match(MOD, /slice\(0, UI_FILTER_RULE_MAX_TERMS\)\.join\("\\n"\)/,
    "the textarea stops accepting input at the line bound");
  assert.match(MOD, /t\("gc\.mod\.rules\.termsPlaceholder"\)/);
});

test("the rule write carries the 0010 grammar: checkbox actions, the timeout select, blockMessage null-able", () => {
  assert.match(MOD, /body\.blockMessage = message === "" \? null : message/);
  assert.match(MOD, /timeoutMinutes: Number\(timeout\.querySelector\("select"\)\.value\)/);
  assert.match(MOD, /body\.exemptRoleIds = exempt\.roleIds\(\)/);
  assert.match(MOD, /body\.exemptChannelIds = exempt\.channelIds\(\)/);
  assert.match(MOD, /t\("gc\.mod\.rules\.exemptRoles", \{ max: UI_FILTER_RULE_EXEMPT_ROLES_MAX \}\)/);
  assert.match(MOD, /t\("gc\.mod\.rules\.careFlag"\)/);
  assert.match(MOD, /t\("gc\.mod\.rules\.screenNicknames"\)/);
});

test("the 10-rule cap disables the create affordance with the server's own shape", () => {
  assert.match(MOD, /t\("gc\.mod\.automod\.full", \{ max: UI_FILTER_RULE_MAX \}\)/);
});

test("the alerts feed: default page 50, the G-5 empty state, rows jump to the message", () => {
  assert.match(MOD, /limit=\$\{UI_FILTER_ALERTS_DEFAULT\}/);
  assert.equal(mod.UI_FILTER_ALERTS_DEFAULT, 50);
  assert.match(MOD, /t\("gc\.mod\.alerts\.empty"\)/);
  assert.match(MOD, /href: `\/s\/\$\{serverId\}\/\$\{alert\.channelId\}`/, "rows jump to the message");
  assert.match(MOD,
    /t\("gc\.mod\.alerts\.channel",\s*\n\s*\{ channel: alert\.channelId \|\| t\("gc\.mod\.alerts\.unknown"\) \}\)/,
    "a row without a live channel renders the channel id placeholder");
});

test("the ban body: numeric strings become numbers, anything else rides RAW (no coercion)", () => {
  assert.match(MOD, /\/\^\\d\+\$\/\.test\(raw\)\s*\n?\s*\? \{ user_id: Number\(raw\) \}/);
  assert.match(MOD, /: \{ user_id: raw \}/);
  assert.match(MOD, /if \(reason\) body\.reason = reason/);
  assert.match(MOD, /The ban list rides the roster's own `bans` key/,
    "never requested separately for viewers the shape excludes");
});

test("prune: dry run FIRST, the confirm carries the count and the rules, then the run", () => {
  assert.match(MOD, /dry_run: true/);
  assert.match(MOD, /t\("gc\.mod\.prune\.confirm", \{ count: result\.count \}\)/);
  assert.match(MOD, /t\("gc\.mod\.prune\.candidates"\)/);
  assert.match(MOD, /dry_run: false/);
  assert.match(MOD, /Number\(days\.querySelector/);
});

test("the member card's mod controls: rank-gated, owner rows immune, self rows clean", () => {
  assert.match(MEMBERS, /memberModControls\(payload, member, routerRerender\)/);
  assert.match(MOD, /if \(self \|\| immune \|\| !outranks \|\| !canModerate\(payload\)\) return null;/);
  assert.match(MOD, /viewer\.owner \|\| member\.topPosition < viewer\.topPosition/);
  assert.match(MOD, /t\("gc\.mod\.kick\.note"\)/);
  // Rules verification rides the card for members still owing it.
  assert.match(MOD, /hasRules && !member\.rulesAccepted/);
  assert.match(MOD, /t\("gc\.mod\.automod\.markVerified"\)/);
});

test("the staff attachment queue: staff-gated, approve/reject are commits, reject states the byte deletion", () => {
  assert.match(MOD, /\["admin", "owner"\]\.includes\(user\.role\)/);
  assert.match(MOD, /\/api\/admin\/attachments/);
  assert.match(MOD, /id\}\/approve`/);
  assert.match(MOD, /t\("gc\.mod\.queue\.rejectNote"\)/);
  assert.match(MOD, /t\("gc\.mod\.queue\.empty"\)/);
});

test("the desk gate: owner OR KICK_MEMBERS from the roster — plain members get the shared 403", () => {
  assert.equal(mod.canModerate({ viewer: { owner: true, permissions: [] } }), true);
  assert.equal(mod.canModerate({ viewer: { owner: false, permissions: ["KICK_MEMBERS"] } }), true);
  assert.equal(mod.canModerate({ viewer: { owner: false, permissions: ["MANAGE_EMOJI"] } }), false);
  assert.match(MOD, /t\("gc\.settings\.errors\.permission"\)/,
    "the 403 reuses settings' swept seat (the mod twin collapsed at this commit)");
});

// --- the mod desk speaks through the bundle ------------------------------------

const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

test("mod.js speaks through gc.mod.* (and the swept seats only)", () => {
  const pinned = {
    "gc.mod.automod.full": "This server already has {{max}} filter rules.",
    "gc.mod.rules.exemptRoles": "Exempt roles (≤ {{max}})",
    "gc.mod.rules.exemptChannels": "Exempt channels (≤ {{max}})",
    "gc.mod.rules.termsCount": "{{lines}} lines · {{chars}} characters",
    "gc.mod.rules.blockMessageHelp": "What a blocked send hears (≤ {{max}}; empty = the server's default).",
    "gc.mod.alerts.channel": "channel {{channel}}",
    "gc.mod.alerts.matched": "matched: {{matched}}",
    "gc.mod.bans.confirm": "Ban {{name}}?",
    "gc.mod.bans.byIdHeading": "Ban by member id",
    "gc.mod.bans.byIdHelp": "The member's numeric id — the server refuses anything else.",
    "gc.mod.bans.reasonLabel": "Reason (optional)",
    "gc.mod.bans.clearTimeout": "Clear timeout",
    "gc.mod.prune.confirm": "Prune {{count}} members?",
    "gc.mod.prune.candidates": "Candidates: joined before the cutoff, zero server-wide message activity, never the owner; non-owner actors prune strictly below their own position.",
    "gc.mod.prune.result": "{{count}} kicked.",
    "gc.mod.queue.summary": "{{name}} · {{bytes}} bytes · {{mime}} · {{createdAt}}",
    "gc.mod.queue.rejectConfirm": "Reject attachment #{{id}}?",
    "gc.mod.queue.rejectNote": "The bytes are deleted with the flip.",
    "gc.mod.kick.confirm": "Kick {{name}}?",
    "gc.mod.kick.note": "Their role assignments come off with the kick.",
    "gc.mod.timeout.choice": "{{count}} min",
    "gc.mod.card.heading": "Moderation",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(en[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.match(MOD, new RegExp(`t\\("${key.replace(/\./g, "\\.")}`),
      `the call site rides ${key}`);
  }
  // The adjudicated grammar ride: prune's confirm flexes member/members at
  // exactly count 1 (the result line stays numeral-safe — "1 kicked." needs
  // no branch; the ruling rides the commit).
  assert.equal(en["gc.mod.prune.confirm_one"], "Prune {{count}} member?",
    "the prune's singular branch rides beside its bare row");
  // The collapsed twins reuse the first-swept seats — the three mod-side
  // seeds (errors.permission, heading, bans.member) died at this commit.
  assert.equal(en["gc.mod.errors.permission"], undefined,
    "the 403 rides gc.settings.errors.permission once, not twice");
  assert.equal(en["gc.mod.heading"], undefined,
    "the desk's heading rides gc.settings.sections.mod once");
  assert.equal(en["gc.mod.bans.member"], undefined,
    "the member-id fallback rides gc.social.blocks.member once");
  assert.match(MOD, /t\("gc\.controls\.back"\)/);
  assert.match(MOD, /t\("gc\.controls\.keep"\)/);
  assert.match(MOD, /t\("gc\.shell\.nav\.channels"\)/);
  assert.match(MOD, /t\("gc\.settings\.nav\.server"\)/);
  assert.match(MOD, /t\("gc\.settings\.nav\.expressions"\)/);
  assert.match(MOD, /t\("gc\.settings\.roles\.heading"\)/);
  assert.match(MOD, /t\("gc\.settings\.invites\.heading"\)/);
  assert.match(MOD, /t\("gc\.settings\.sections\.mod"\)/);
  assert.match(MOD, /t\("gc\.social\.blocks\.member"/);
});

test("mod.js holds NO sweep's leftover literals (the seat scan)", () => {
  const codeOnly = MOD
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/t\("gc\.[^"]*"[^)]*\)/g, "");
  assert.doesNotMatch(codeOnly, /text: "[A-Z←][^"]*"/);
  assert.doesNotMatch(codeOnly, /label: "[A-Z][^"]*"/);
  assert.doesNotMatch(codeOnly, /description: "[A-Z0-9][^"]*"/);
  assert.doesNotMatch(codeOnly, /heading: "[A-Z0-9][^"]*"/, "dialog headings ride keys");
  // Positional confirm args are copy too (the third seat never a bare word).
  assert.doesNotMatch(codeOnly, /, "(Clear|Delete|Revoke|Save|Keep|Done|Apply)",/,
    "no positional confirm label escapes as a literal");
});

test("the boundNote seed stays dead (the orphan may not return unnoticed)", () => {
  // "Stops accepting input at the bound" was a COMMENT's phrase, never
  // painted copy — the seed has always had zero call sites; it died from
  // the canon at the orphan-drop. The key is absent from the bundle AND the
  // whole source tree carries no reference, so a reintroducing sweep fails here.
  const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
  assert.equal(en["gc.mod.rules.boundNote"], undefined,
    "the orphan seed is dropped, not re-seeded");
  const MOD2 = readFileSync(join(HERE, "../public/js/ui/mod.js"), "utf8");
  assert.doesNotMatch(MOD2, /boundNote/);
  const I18N2 = readFileSync(join(HERE, "../public/js/i18n.js"), "utf8");
  assert.doesNotMatch(I18N2, /boundNote/);
});
