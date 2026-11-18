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

// The server-settings lane's pins. Caps come from the backend's own exports
// or the mirrored UI constants with equality pins (G-4) — zero hand-typed
// caps in copy. Route truth: /api/servers(+/:id PATCH rules_text), categories,
// roles, overwrites (OVERWRITE_BITS), invites (absent/null/0 = NEVER).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const constants = await import("../constants.mjs");
const permissions = await import("../api/permissions.mjs");
const settings = await import("../public/js/ui/settings.js");
const SETTINGS = readFileSync(join(HERE, "../public/js/ui/settings.js"), "utf8");
const MAIN = readFileSync(join(HERE, "../public/js/main.js"), "utf8");
const SHELL = readFileSync(join(HERE, "../public/js/ui/shell.js"), "utf8");

test("the mirrored lane mirrors the backend exactly (G-4)", () => {
  assert.deepEqual([...settings.UI_SLOWMODE_CHOICES], [...permissions.SLOWMODE_CHOICES]);
  const bitNames = Object.keys(permissions.SERVER_PERMISSIONS);
  assert.deepEqual([...settings.UI_SERVER_PERMISSIONS].sort(), bitNames.sort());
  // OVERWRITE_BITS freezes bit VALUES; the names must match, in order.
  const bitValueToName = new Map(
    Object.entries(permissions.SERVER_PERMISSIONS).map(([name, value]) => [value, name]),
  );
  const overwriteNames = permissions.OVERWRITE_BITS.map((value) => bitValueToName.get(value));
  assert.deepEqual([...settings.UI_OVERWRITE_BITS], overwriteNames);
  assert.deepEqual([...settings.UI_VERIFICATION_LEVELS], [0, 1, 2, 3, 4]);
  assert.equal(settings.UI_MAX_CHANNELS_PER_SERVER, constants.MAX_CHANNELS_PER_SERVER);
  assert.equal(settings.UI_CATEGORIES_MAX_PER_SERVER, constants.GC_CATEGORIES_MAX_PER_SERVER);
  assert.equal(settings.UI_RULES_MAX, constants.GC_RULES_MAX);
});

test("the lane carries NO register and NO account settings (the settings scope law)", () => {
  // Comments tell the law; the pin sees only the code.
  const codeOnly = SETTINGS.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(codeOnly, /register|totp|backup/i,
    "Accounts owns registration and account settings; GC serves server settings only");
});

test("the manage routes: one task page per area, one gear at the channel-rail top", () => {
  for (const [pattern, name] of [
    ["\\/s/:serverId/settings", "server-settings"],
    ["\\/s/:serverId/channels", "server-channels"],
    ["\\/s/:serverId/roles", "server-roles"],
    ["\\/s/:serverId/invites", "server-invites"],
    ["\\/s/:serverId/channels/:channelId/overwrites", "channel-overwrites"],
    ["\\/join", "join"],
  ]) {
    assert.match(MAIN, new RegExp(`addRoute\\("${pattern}", "${name}"`));
  }
  assert.match(SHELL, /serverAdminRights\(server\)/);
  assert.match(SHELL, /\/s\/\$\{server\.id\}\/settings/, "the gear points at the settings page");
});

test("the gear shows only where the bits say so", () => {
  // role owner/admin, or a channel's effectivePermissions carrying a manage bit
  assert.equal(settings.serverAdminRights({ role: "owner", channels: [] }), true);
  assert.equal(settings.serverAdminRights({
    role: "member",
    channels: [{ effectivePermissions: ["MANAGE_INVITES"] }],
  }), true);
  assert.equal(settings.serverAdminRights({ role: "member", channels: [] }), false);
  assert.equal(settings.serverAdminRights({ role: "member", channels: [
    { effectivePermissions: ["VIEW", "SEND"] },
  ] }), false);
});

test("the rules gate rides the settings writes: accept flow, doc read-back, pre-trim", () => {
  assert.match(SETTINGS, /guardRulesGate\(document, error, /, "the REST arm re-offers the write");
  assert.match(SETTINGS, /api\/servers\/\$\{serverId\}\/rules/, "the rules doc reads back via its GET (PATCH never echoes)");
  assert.match(SETTINGS, /maxlength: String\(UI_RULES_MAX\)/);
  assert.match(SETTINGS, /slice\(0, UI_RULES_MAX\)/, "the editor pre-trims at the bound");
  // The gate clears by clearing: empty text saves null (gate OFF).
  assert.match(SETTINGS, /rules_text: text\.trim\(\) === "" \? null : text/);
});

test("the one-channel-pool parity line and the cap-disabled create form", () => {
  assert.match(SETTINGS, /UI_MAX_CHANNELS_PER_SERVER = 500/);
  assert.match(SETTINGS, /t\("gc\.settings\.channels\.full"/);
  assert.equal(enBundle()["gc.settings.channels.full"],
    "That server has reached its channel limit. ({{count}} of {{max}} — the one pool counts text, voice, and categories.)",
    "one pool, one line");
  assert.match(SETTINGS, /control\.disabled = true/, "at cap the create form disables with the reason");
});

test("the roles parity line: 250 incl. @everyone, never raised by boosts", () => {
  assert.match(SETTINGS, /UI_ROLES_MAX = 250/);
  // The role DELETE never lands on the viewer's own row.
  assert.match(SETTINGS, /isSelf = me\?\.id === member\.id/);
  assert.match(SETTINGS, /ownerRow = member\.membershipRole === "owner"/);
});

test("the overwrite editor: read-only truth for rows the viewer cannot write", () => {
  // Position-gated read-only rendering (never hidden — hiding is a lie).
  assert.match(SETTINGS, /readOnly = role\.id !== "everyone" && !canWriteRoles && role\.position > viewerTop/);
  assert.match(SETTINGS, /t\("gc\.settings\.overwrites\.readOnly"\)/);
  assert.equal(enBundle()["gc.settings.overwrites.readOnly"], "(read-only — above your position)");
  assert.match(SETTINGS, /allow_mask: allow, deny_mask: deny/);
});

test("invites: 'empty select = never' is real, not invented refusal (the sharp edge)", () => {
  assert.match(SETTINGS, /t\("gc\.settings\.invites\.expiryNever"\)/,
    "the never choice rides its key (the slip-of-key law: the seat is named)");
  // Absent keys are simply not SENT — the lenient body carries only chosen knobs.
  assert.match(SETTINGS, /if \(maxAge !== ""\) body\.maxAgeSeconds = Number\(maxAge\)/);
  assert.match(SETTINGS, /if \(maxUses !== ""\) body\.maxUses = Number\(maxUses\)/);
  const apiSource = readFileSync(join(HERE, "../api/servers.mjs"), "utf8");
  const minAge = Number(/INVITE_MAX_AGE_MIN = (\d+)/.exec(apiSource)[1]);
  const maxAge = Number(/INVITE_MAX_AGE_MAX = (\d+)/.exec(apiSource)[1]);
  assert.equal(minAge, 60);
  assert.equal(maxAge, 2592000);
  for (const choice of settingsChoiceValues()) {
    assert.ok(choice >= minAge && choice <= maxAge, `expiry choice ${choice} inside the route's window`);
  }
  const usesMax = Number(/INVITE_MAX_USES_MAX = (\d+)/.exec(apiSource)[1]);
  assert.equal(usesMax, 100);
  for (const cap of settingsUseCapValues()) {
    assert.ok(cap >= 1 && cap <= usesMax, `use cap ${cap} inside the route's window`);
  }
});

function enBundle() {
  return JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));
}

function settingsChoiceValues() {
  return [...SETTINGS.matchAll(/value: "(\d+)", label: t\("gc\.settings\.invites\.expiry/g)]
    .map((match) => Number(match[1]));
}

function settingsUseCapValues() {
  return [...SETTINGS.matchAll(/value: "(\d+)", label: t\("gc\.settings\.invites\.uses\d/g)]
    .map((match) => Number(match[1]));
}

test("deletions are single confirmations; the echoed counts render as consequence", () => {
  assert.match(SETTINGS, /confirmDialog/);
  assert.match(SETTINGS, /deleted: \{?\}|\?\.\?\.\.\.|t\("gc\.settings\.danger\.done"\)/);
  assert.match(SETTINGS, /Object\.entries\(counts\)/);
});

test("every manage write rides api.js — no raw fetch, no client-side oracles", () => {
  assert.doesNotMatch(SETTINGS, /\bfetch\(/);
  assert.match(SETTINGS, /t\("gc\.settings\.errors\.permission"\)/,
    "the shared 403 string inline for outsiders (G-3), never a fake empty form");
});

// --- the settings lane speaks through the bundle -------------------------------

const en = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

test("settings.js speaks through gc.settings.* (and the shared seats only)", () => {
  // The seed's own rows keep their values byte-equal (the bundle is ground truth).
  const pinned = {
    "gc.settings.heading": "Server settings",
    "gc.settings.errors.permission": "You do not have permission to do that.",
    "gc.settings.channels.full": "That server has reached its channel limit. ({{count}} of {{max}} — the one pool counts text, voice, and categories.)",
    "gc.settings.categories.count": "{{count}} of {{max}}",
    "gc.settings.roles.count": "{{count}} of {{max}} (the parity cap includes @everyone and is never raised by boosts).",
    "gc.settings.overwrites.readOnly": "(read-only — above your position)",
    "gc.settings.overwrites.order": "Resolution order: server mask → @everyone deny then allow → category role deny then allow → channel role deny then allow. A layer's deny applies before its allow.",
    "gc.settings.invites.fresh": "Fresh invite: {{code}}",
    "gc.settings.invites.never": "never expires",
    "gc.settings.invites.revoked": "· REVOKED",
    "gc.settings.roles.ownerImmune": "· you (owner, immune)",
    "gc.settings.join.serverRow": "Join {{name}} ({{count}} members)",
  };
  for (const [key, value] of Object.entries(pinned)) {
    assert.equal(en[key], value, `the bundle carries ${key} as the source used to say it`);
    assert.ok(SETTINGS.includes(`t("${key}`),
      `the call site rides ${key}`);
  }
  // The adjudicated grammar ride: the use/member count seats flex at
  // exactly count 1. usesOf is judged numeral-safe (its flexed noun
  // attaches to {{max}}, not {{count}} — "1 of 5 uses" is elliptical-
  // grammatical at every count); the ruling rides the commit.
  assert.equal(en["gc.settings.invites.uses_one"], "{{count}} use",
    "the uses seat's singular branch rides beside its bare row");
  assert.equal(en["gc.settings.join.serverRow_one"], "Join {{name}} ({{count}} member)",
    "the serverRow seat's singular branch rides beside its bare row");
  // The shared chrome stays in the closed-set / first-swept seats.
  assert.match(SETTINGS, /t\("gc\.controls\.keep"\)/);
  assert.match(SETTINGS, /t\("gc\.controls\.back"\)/);
  assert.match(SETTINGS, /t\("gc\.controls\.done"\)/);
  assert.match(SETTINGS, /t\("gc\.controls\.rename"\)/);
  assert.match(SETTINGS, /t\("gc\.controls\.save"\)/);
  assert.match(SETTINGS, /t\("gc\.controls\.remove"\)/);
  assert.match(SETTINGS, /t\("gc\.chat\.row\.delete"\)/, "the collapse: chat's Delete rides everywhere");
  assert.match(SETTINGS, /t\("gc\.chat\.row\.edit"\)/);
  assert.match(SETTINGS, /t\("gc\.shell\.nav\.channels"\)/, "shell's Channels rides the manage nav");
  assert.match(SETTINGS, /t\("gc\.voice\.join"\)/, "voice's Join rides the invite door");
  assert.match(SETTINGS, /t\("gc\.settings\.sections\.heading"\)/);
});

test("settings.js holds NO sweep's leftover literals (the seat scan)", () => {
  // Every painted string goes through t(); the survivors are data (kinds,
  // codes, numerals), separators, and the verbatim error passthroughs.
  const codeOnly = SETTINGS
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/t\("gc\.[^"]*"[^)]*\)/g, "");
  assert.doesNotMatch(codeOnly, /text: "[A-Z←][^"]*"/, "no painted literal survives the sweep");
  assert.doesNotMatch(codeOnly, /label: "[A-Z][^"]*"/);
  assert.doesNotMatch(codeOnly, /description: "[A-Z0-9][^"]*"/);
  // Positional confirm args are copy too: the third seat of every
  // confirmDialog-style call must ride a key seat, never a bare word.
  assert.doesNotMatch(codeOnly, /, "(Clear|Delete|Revoke|Save|Keep|Done|Apply)",/,
    "no positional confirm label escapes as a literal");
});

// --- the language picker seat (the locale lane's switcher surface) -----------

test("the language picker rides every settings seat: the manage build and both refusal panes", () => {
  assert.match(SETTINGS, /export function languageBlock/,
    "the picker is its own exported builder (testable, one seat)");
  assert.match(SETTINGS, /BUNDLE_LANGS\.map\(\(seat\) =>/,
    "the option list rides the loader's seat list, never a hand copy");
  assert.match(SETTINGS,
    /select\.addEventListener\("change", \(\) => \{ void setLang\(select\.value\); \}\)/,
    "the select wires straight into setLang — no side state");
  const mounts = (SETTINGS.match(/languageBlock\(\)/g) || []).length;
  assert.ok(mounts >= 3,
    `the picker mounts in the server-settings build and both refusal panes (${mounts} found)`);
  assert.match(SETTINGS, /const LANG_ENDONYMS = \{/,
    "labels are endonyms — the picker convention carries its own words");
});
