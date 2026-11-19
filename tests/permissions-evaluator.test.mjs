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

// api/permissions.mjs — the pure overwrite resolution walk (the filed
// evaluation algorithm) and the graceful-default gate question. The contract
// under test: one bitmask out of (the member's role rows, the channel's layer
// chain), evaluated in the pinned order
//   @everyone deny -> @everyone allow ->
//   category role denies -> category role allows ->
//   channel role denies -> channel role allows
// with role_id NULL as the @everyone sentinel and the member-specific tier
// deliberately unrepresentable in the input.
import test from "node:test";
import assert from "node:assert/strict";

import {
  effectivePermissions,
  enforceVerificationLevel,
  IMPLICIT_BASE_PERMISSIONS,
  OVERWRITE_BITS,
  overwritesTouchDeny,
  permissionNames,
  PRUNE_DAYS,
  SLOWMODE_CHOICES,
  SERVER_PERMISSIONS,
  TIMEOUT_MINUTE_CHOICES,
  VERIFICATION_ACCOUNT_SECONDS,
  VERIFICATION_LEVELS,
  VERIFICATION_MEMBER_SECONDS,
} from "../api/permissions.mjs";

const SP = SERVER_PERMISSIONS;
const V = SP.VIEW, SE = SP.SEND, C = SP.CONNECT, SK = SP.SPEAK;
// ADD_REACTIONS rode in with the phase-3 social layer: it sits in the implicit
// base (a member can always react unless a deny layer strips it) and joins the
// overwrite vocabulary as the one NEW bit the reactions feature shipped.
const AR = SP.ADD_REACTIONS;
const BASE = V | SE | AR;

// row builders: the fake gc_channel_overwrites rows are exactly the evaluator's
// contract (layer ids + the two masks; everything else inert).
function channelRow(roleId, allow, deny) {
  return { channel_id: 90, category_id: null, role_id: roleId, allow_mask: allow, deny_mask: deny };
}
function categoryRow(roleId, allow, deny) {
  return { channel_id: null, category_id: 12, role_id: roleId, allow_mask: allow, deny_mask: deny };
}
function foreignRow(roleId, allow, deny) {
  // A row for a DIFFERENT channel: never applies (the caller's layer chain
  // would not include it; the evaluator treats it as inert either way).
  return { channel_id: 91, category_id: null, role_id: roleId, allow_mask: allow, deny_mask: deny };
}

function role(id, permissions) {
  return { id, permissions };
}

test("the bit vocabulary: the shipped bits keep their values, the new ones slot after", () => {
  assert.equal(SP.MANAGE_CHANNELS, 1);
  assert.equal(SP.MANAGE_ROLES, 2);
  assert.equal(SP.KICK_MEMBERS, 4);
  assert.equal(SP.MANAGE_INVITES, 8);
  assert.equal(SP.DELETE_MESSAGES, 16);
  assert.equal(SP.VIEW, 32);
  assert.equal(SP.SEND, 64);
  assert.equal(SP.CONNECT, 128);
  assert.equal(SP.SPEAK, 256);
  assert.equal(SP.BYPASS_SLOWMODE, 512);
  // The reactions bit slots AFTER the shipped ones (the wire order rides the
  // bit order), and joins the overwrite vocabulary.
  assert.equal(SP.ADD_REACTIONS, 1024);
  assert.deepEqual(OVERWRITE_BITS, [V, SE, C, SK, AR]);
  // Discord's slowmode menu is the column-value contract.
  assert.deepEqual(SLOWMODE_CHOICES, [0, 900, 1800, 3600, 7200, 21600]);
});

test("the implicit base: a roleless member with no overwrites reads VIEW + SEND + ADD_REACTIONS", () => {
  assert.equal(IMPLICIT_BASE_PERMISSIONS, BASE);
  assert.deepEqual(permissionNames(effectivePermissions([], [])),
    ["VIEW", "SEND", "ADD_REACTIONS"]);
  assert.equal(effectivePermissions(null, undefined), BASE, "null/absent inputs degrade");
});

test("the server-wide layer: role bits merge on top of the implicit base", () => {
  const mask = effectivePermissions([role(4, SP.MANAGE_CHANNELS), role(5, SP.KICK_MEMBERS)], []);
  assert.deepEqual(permissionNames(mask).sort(),
    ["KICK_MEMBERS", "MANAGE_CHANNELS", "ADD_REACTIONS", "SEND", "VIEW"].sort());
  // A zero-permission role adds nothing.
  assert.equal(effectivePermissions([role(9, 0)], []), BASE);
});

test("an @everyone deny flips implicit bits off; a later allow re-grants", () => {
  // deny SEND for everyone on the channel: the plain member loses only SEND.
  const denied = effectivePermissions([role(5, 0)], [channelRow(null, 0, SE)]);
  assert.deepEqual(permissionNames(denied), ["VIEW", "ADD_REACTIONS"]);
  // an allow AFTER a deny re-grants: the same row's allow (the deny-first,
  // allow-second read within one layer) — and a channel-layer allow beats a
  // category-layer deny.
  const row = channelRow(null, 0, SE);
  row.allow_mask = SE;
  assert.equal(effectivePermissions([], [row]), BASE, "allow wins within one row");
  const regranted = effectivePermissions([role(5, 0)], [
    categoryRow(null, 0, SE),
    channelRow(5, SE, 0),
  ]);
  assert.deepEqual(permissionNames(regranted), ["VIEW", "SEND", "ADD_REACTIONS"],
    "a channel-layer allow re-grants what a category-layer deny took");
  // ...but only for holders: an unrelated role's allow does nothing here.
  const others = effectivePermissions([role(7, 0)], [
    categoryRow(null, 0, SE),
    channelRow(9, SE, 0),
  ]);
  assert.deepEqual(permissionNames(others), ["VIEW", "ADD_REACTIONS"]);
});

test("an @everyone allow lifts bits beyond the implicit base onto everyone", () => {
  const mask = effectivePermissions([role(5, 0)], [channelRow(null, SP.MANAGE_INVITES, 0)]);
  assert.ok(mask & SP.MANAGE_INVITES, "everyone-layer allows ride the same evaluator");
  assert.ok(!(mask & SP.KICK_MEMBERS), "…and nothing it does not allow");
});

test("the order is denies-then-allows WITHIN one layer, and category before channel", () => {
  // Category: role 5 denied SEND; channel: role 5 allowed SEND → send stands
  // (channel is the LAST allow).
  const up = effectivePermissions([role(5, 0)], [
    categoryRow(5, 0, SE),
    channelRow(5, SE, 0),
  ]);
  assert.ok(up & SE);
  // Reversed: channel denies, category allows → deny wins (the channel
  // layer's deny applies after the category layer's allow).
  const down = effectivePermissions([role(5, 0)], [
    categoryRow(5, SE, 0),
    channelRow(5, 0, SE),
  ]);
  assert.ok(!(down & SE), "a later channel-layer deny beats an earlier category allow");
});

test("an @everyone deny + a role allow is the private/announcement pattern", () => {
  // deny VIEW to everyone on the category; allow VIEW for role 4 on the same
  // category (the filed team-private pattern).
  const chain = [categoryRow(null, 0, V), categoryRow(SP.MANAGE_ROLES === 2 ? 4 : 4, V, 0)];
  const holder = effectivePermissions([role(4, 0)], chain);
  const stranger = effectivePermissions([role(6, 0), ], chain);
  const roleless = effectivePermissions([], chain);
  assert.deepEqual(permissionNames(holder), ["VIEW", "SEND", "ADD_REACTIONS"]);
  assert.deepEqual(permissionNames(stranger), ["SEND", "ADD_REACTIONS"],
    "VIEW denied, SEND/ADD_REACTIONS implicit");
  assert.deepEqual(permissionNames(roleless), ["SEND", "ADD_REACTIONS"]);
});

test("role rows only bind their holders; the @everyone sentinel binds everyone", () => {
  const chain = [
    channelRow(null, 0, C), // everyone: connect denied
    channelRow(4, C, 0), // role 4: connect re-granted
  ];
  assert.ok(effectivePermissions([role(4, 0)], chain) & C, "holder talks");
  assert.ok(!(effectivePermissions([role(8, 99)], chain) & C), "another role's holder doesn't");
  assert.ok(!(effectivePermissions([], chain) & C), "the roleless fall to the sentinel");
});

test("layers are classified by row shape: category_id-set rows walk first, channel rows last", () => {
  // The caller passes the channel's LAYER CHAIN (its rows plus its
  // category's) — row SHAPE is what separates the layers, so a row with a
  // category_id takes the category slot no matter what its channel_id says.
  const chain = [
    { channel_id: 999, category_id: 12, role_id: 5, allow_mask: 0, deny_mask: SE },
    channelRow(5, SE, 0), // the channel layer re-grants
  ];
  assert.deepEqual(permissionNames(effectivePermissions([role(5, 0)], chain)),
    ["VIEW", "SEND", "ADD_REACTIONS"]);
  const categoryChain = [categoryRow(null, SP.DELETE_MESSAGES, 0)];
  assert.ok(effectivePermissions([role(4, 0)], categoryChain) & SP.DELETE_MESSAGES,
    "an @everyone category allow rides the category layer");
});

test("a channel chain carries BOTH kinds of rows; only the chain's shapes apply", () => {
  const chain = [
    categoryRow(5, 0, SE), // category: role 5 denied send
    channelRow(5, SE, 0), // channel: role 5 allowed send
  ];
  const mask = effectivePermissions([role(5, 0)], chain);
  assert.deepEqual(permissionNames(mask), ["VIEW", "SEND", "ADD_REACTIONS"]);
});

test("malformed rows never crash the walk (the graceful-default promise)", () => {
  const weird = [null, undefined, 7, "x", {}];
  assert.equal(effectivePermissions([], weird), BASE);
  const mask = effectivePermissions(
    [role(4, SP.SPEAK)],
    [channelRow(null, 0, V), null],
  );
  assert.deepEqual(permissionNames(mask), ["SEND", "SPEAK", "ADD_REACTIONS"]);
});

test("overwritesTouchDeny: the graceful-default gate's one question", () => {
  // No rows, no denies: untouched.
  assert.equal(overwritesTouchDeny([], []), false);
  assert.equal(overwritesTouchDeny(null, undefined), false);
  // A deny binding the viewer's role touches them …
  assert.equal(overwritesTouchDeny([role(4, 0)], [channelRow(4, 0, SE)]), true);
  // … the @everyone deny touches EVERY member …
  assert.equal(overwritesTouchDeny([], [categoryRow(null, 0, V)]), true);
  // … a role-only deny does NOT touch a viewer holding other roles …
  assert.equal(overwritesTouchDeny([role(6, 0)], [channelRow(4, 0, SE)]), false);
  // … and allows-only rows never touch anyone.
  assert.equal(overwritesTouchDeny([role(4, 0)], [channelRow(4, SE, 0)]), false);
  assert.equal(overwritesTouchDeny([role(4, 0)], [channelRow(null, SE, 0)]), false);
});

test("the private-channel shape walks as filed: everyone-deny VIEW, per-role allows", () => {
  // What the channel-create private toggle writes: deny VIEW @everyone, and
  // one allow-VIEW row per role (role 5 here; role 6 got nothing).
  const chain = [
    channelRow(null, 0, V),
    channelRow(5, V, 0),
  ];
  assert.deepEqual(permissionNames(effectivePermissions([role(5, 0)], chain)),
    ["VIEW", "SEND", "ADD_REACTIONS"]);
  assert.deepEqual(permissionNames(effectivePermissions([role(6, 0)], chain)),
    ["SEND", "ADD_REACTIONS"]);
  assert.deepEqual(permissionNames(effectivePermissions([], chain)), ["SEND", "ADD_REACTIONS"]);
  // And the deny is exactly what makes the sidebar vanish rule fire for the
  // plain members (overwritesTouchDeny + the VIEW miss).
  assert.equal(overwritesTouchDeny([role(6, 0)], chain), true);
  const stranger = effectivePermissions([role(6, 0)], chain);
  assert.equal((stranger & V) === 0, true, "VIEW miss → the 404, not the 403");
});

// --- the mod desk's pure contracts: the verification ladder + the menus ---------

const DAY = 86400;
const MINUTE = 60;

test("the filed menus are the column-value contracts", () => {
  // The time-out FAQ's duration menu — the AutoMod row (parity-limits.md,
  // verified 2026-11-17) adds the 28-day seat; the 0010 CHECK's widening
  // rides migration 0027.
  assert.deepEqual(TIMEOUT_MINUTE_CHOICES, [1, 5, 10, 60, 1440, 10080, 40320]);
  // The how-to-prune guide's window menu.
  assert.deepEqual(PRUNE_DAYS, [7, 30]);
  // The verification ladder: exactly the five levels the gc_servers column
  // stores (0 = none).
  assert.deepEqual(VERIFICATION_LEVELS, [0, 1, 2, 3, 4]);
});

test("the verification ladder seconds match the filed mapping", () => {
  // 0=none, 1=account>1d, 2=account>7d, 3=member>10m, 4=both-7d-and-10m.
  for (const level of VERIFICATION_LEVELS) {
    if (level <= 2) {
      assert.equal(VERIFICATION_MEMBER_SECONDS[level], 0, "level " + level + ": no member gate");
      assert.equal(VERIFICATION_ACCOUNT_SECONDS[level], level === 0 ? 0 : level === 1 ? DAY : 7 * DAY);
    }
    if (level >= 3) {
      assert.equal(VERIFICATION_ACCOUNT_SECONDS[level], level === 3 ? 0 : 7 * DAY);
      assert.equal(VERIFICATION_MEMBER_SECONDS[level], 10 * MINUTE);
    }
  }
  // Every ladder value is frozen to an integer; junk never reaches the route.
  assert.ok(Object.isFrozen(VERIFICATION_ACCOUNT_SECONDS));
  assert.ok(Object.isFrozen(VERIFICATION_MEMBER_SECONDS));
});

test("enforceVerificationLevel: level 0 (and junk) reads as none — every member passes", () => {
  const now = 1000000;
  assert.equal(enforceVerificationLevel(0, now, now, now), null);
  // A pre-0008 row shape (undefined) degrades to level 0.
  assert.equal(enforceVerificationLevel(undefined, now, now, now), null);
  assert.equal(enforceVerificationLevel(null, now, now, now), null);
  assert.equal(enforceVerificationLevel(9, now, now, now), null, "an off-ladder value is none");
  assert.equal(enforceVerificationLevel("3", 0, 0, now), null, "a string level is not stored, so not enforced");
});

test("enforceVerificationLevel: level 1 — the account gate at one day", () => {
  const now = 2000000;
  // Exactly one day old: passes (the gate is a >= read).
  assert.equal(enforceVerificationLevel(1, now - DAY, now, now), null);
  // A second younger: blocked with the account gate named.
  assert.deepEqual(enforceVerificationLevel(1, now - DAY + 1, now, now), ["account"]);
  // A fresh join never matters at level 1 (the member gate is off).
  assert.deepEqual(enforceVerificationLevel(1, now - DAY + 1, now, now), ["account"]);
});

test("enforceVerificationLevel: level 2 — the account gate at seven days", () => {
  const now = 3000000;
  assert.equal(enforceVerificationLevel(2, now - 7 * DAY, now, now), null);
  assert.deepEqual(enforceVerificationLevel(2, now - 7 * DAY + 1, now, now), ["account"]);
  // A one-day-old account still fails level 2.
  assert.deepEqual(enforceVerificationLevel(2, now - 2 * DAY, now, now), ["account"]);
});

test("enforceVerificationLevel: level 3 — the member gate at ten minutes", () => {
  const now = 4000000;
  // The account age is irrelevant at level 3; only the join age counts.
  assert.equal(enforceVerificationLevel(3, now, now - 10 * MINUTE, now), null);
  assert.deepEqual(enforceVerificationLevel(3, now, now - 10 * MINUTE + 1, now), ["member"]);
});

test("enforceVerificationLevel: level 4 — both gates together", () => {
  const now = 5000000;
  assert.equal(enforceVerificationLevel(4, now - 7 * DAY, now - 10 * MINUTE, now), null);
  // Either side alone failing names only that side.
  assert.deepEqual(enforceVerificationLevel(4, now - 2 * DAY, now - 10 * MINUTE, now), ["account"]);
  assert.deepEqual(enforceVerificationLevel(4, now - 7 * DAY, now - MINUTE, now), ["member"]);
  assert.deepEqual(
    enforceVerificationLevel(4, now - MINUTE, now - MINUTE, now),
    ["account", "member"],
    "both fail → both gates named, in account-then-member order",
  );
});

test("enforceVerificationLevel fails closed on unreadable timestamps", () => {
  const now = 6000000;
  // Both columns are NOT NULL in the schema, so junk can only arrive as a
  // stale row shape — and a broken read must look TOO NEW, never like a
  // pass through a NaN comparison.
  assert.deepEqual(enforceVerificationLevel(4, undefined, undefined, now), ["account", "member"]);
  assert.deepEqual(enforceVerificationLevel(4, "not-a-number", now - 600, now), ["account"]);
  assert.deepEqual(enforceVerificationLevel(1, undefined, now, now), ["account"]);
  assert.deepEqual(enforceVerificationLevel(3, now, "x", now), ["member"]);
  // A true epoch-0 (Number(null) === 0) is an ancient read, not a broken one.
  assert.equal(enforceVerificationLevel(4, null, null, now), null);
});
