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

// T78 Starter Grove: the template document's author-time validation is PURE
// (a refusal never binds a statement), an over-grant document is refused at
// AUTHOR time (overwrite rows may name the OVERWRITE_BITS tri-state
// vocabulary only), and the apply pre-checks caps, then runs ONE
// all-or-nothing batch of the hand-rolled shapes — roles via the
// authority-ridden INSERT, channels with the private toggle's pair, and the
// explicit gc_channel_overwrites rows with NOTHING fabricated.
import test from "node:test";
import assert from "node:assert/strict";

import { validateTemplate, applyTemplate } from "../api/starter-grove.mjs";
import { GC_ROLES_MAX_PER_SERVER, MAX_CHANNELS_PER_SERVER } from "../constants.mjs";
import { SERVER_PERMISSIONS } from "../api/permissions.mjs";

const OVERWRITE_MASK_ALL = [
  SERVER_PERMISSIONS.VIEW,
  SERVER_PERMISSIONS.SEND,
  SERVER_PERMISSIONS.CONNECT,
  SERVER_PERMISSIONS.SPEAK,
  SERVER_PERMISSIONS.ADD_REACTIONS,
].reduce((mask, bit) => mask | bit, 0);
const ROLE_MASK_ALL = Object.values(SERVER_PERMISSIONS).reduce((mask, bit) => mask | bit, 0);

// A valid Starter Grove: two roles, three channels (one private), and two
// explicit overwrite rows — the whole surface is stated, nothing hidden.
const GROVE = {
  schema: 1,
  name: "Starter Grove",
  description: "A small community seed.",
  roles: [
    { name: "mod", color: "#aa00aa", permissions: ["DELETE_MESSAGES", "KICK_MEMBERS"] },
    { name: "voice", permissions: ["CONNECT", "SPEAK"] },
  ],
  channels: [
    { name: "general", kind: "text" },
    { name: "vip", kind: "text", private: true },
    { name: "lounge", kind: "voice" },
  ],
  overwrites: [
    { channel: "vip", role: "voice", deny: [], allow: ["VIEW", "SEND", "CONNECT"] },
    { channel: "vip", role: null, deny: ["VIEW", "SEND"], allow: [] },
  ],
};

// The fake DB: prepare/first/all answer the Grove pre-checks (both count
// reads null-empty, both name reads row-free); batch records each statement's
// SQL + binds and answers changes:1 for every statement.
function groveDb(overrides = {}) {
  const bound = [];
  return {
    bound,
    batchCalls: 0,
    prepare(sql) {
      const statement = { sql, values: [] };
      statement.bind = (...values) => {
        statement.values = values;
        return statement;
      };
      statement.first = async () =>
        overrides.first ? overrides.first(sql, statement.values) : null;
      statement.all = async () =>
        overrides.all ? overrides.all(sql, statement.values) : { results: [] };
      return statement;
    },
    async batch(statements) {
      this.batchCalls += 1;
      for (const statement of statements) {
        this.bound.push({ sql: statement.sql, values: statement.values });
        if (overrides.batch) overrides.batch(statement.sql, statement.values);
      }
      return statements.map(() =>
        overrides.changes !== undefined ? { meta: { changes: overrides.changes } } : { meta: { changes: 1 } });
    },
  };
}

test("an overwrite carrying a server-level bit is an over-grant refused at author time", () => {
  const overGrant = {
    ...GROVE,
    overwrites: [{ channel: "general", role: "mod", deny: [], allow: ["MANAGE_CHANNELS"] }],
  };
  const refusal = validateTemplate(overGrant);
  assert.equal(refusal.ok, false);
  assert.match(refusal.refusal, /MANAGE_CHANNELS/, "the refusal names the offending bit");
  assert.match(refusal.refusal, /unknown permission bit/, "the refusal classes the vocabulary");
  // validateTemplate takes NO db and NO env: a pure refusal cannot bind a
  // statement by construction.
  assert.equal(validateTemplate.length, 1, "the signature is pure: one document argument");
});

test("an unknown permission bit name is refused — the refusal copies the bit's name", () => {
  const roleRide = validateTemplate({
    ...GROVE,
    roles: [...GROVE.roles, { name: "bad", permissions: ["FLY_MEMBERS"] }],
  });
  assert.equal(roleRide.ok, false);
  assert.match(roleRide.refusal, /FLY_MEMBERS/);

  const overwriteRide = validateTemplate({
    ...GROVE,
    overwrites: [{ channel: "general", role: null, deny: ["REACT_EVERYONE"], allow: [] }],
  });
  assert.equal(overwriteRide.ok, false);
  assert.match(overwriteRide.refusal, /REACT_EVERYONE/);
});

test("an overwrite referencing an unknown channel or role is refused", () => {
  const unknownChannel = validateTemplate({
    ...GROVE,
    overwrites: [{ channel: "nope", role: "mod", deny: ["SEND"], allow: [] }],
  });
  assert.equal(unknownChannel.ok, false);
  assert.match(unknownChannel.refusal, /unknown channel/);
  const unknownRole = validateTemplate({
    ...GROVE,
    overwrites: [{ channel: "general", role: "ghost", deny: ["SEND"], allow: [] }],
  });
  assert.equal(unknownRole.ok, false);
  assert.match(unknownRole.refusal, /unknown role/);
});

test("duplicate role or channel names are refused", () => {
  const dupRole = validateTemplate({
    ...GROVE,
    roles: [...GROVE.roles, { name: "mod", permissions: [] }],
  });
  assert.equal(dupRole.ok, false);
  assert.match(dupRole.refusal, /duplicate role name: mod/);
  const dupChannel = validateTemplate({
    ...GROVE,
    channels: [...GROVE.channels, { name: "general", kind: "voice" }],
  });
  assert.equal(dupChannel.ok, false);
  assert.match(dupChannel.refusal, /duplicate channel name: general/);
});

test("a valid Grove validates pure and the @everyone layer reads as the null-seat row", () => {
  const result = validateTemplate(GROVE);
  assert.equal(result.ok, true, "the document rides whole");
  assert.equal(result.template.overwrites[1].role, null, "@everyone is the null-seat row");
  assert.equal(Object.isFrozen(result.template), true, "the validated shape never mutates");
  assert.equal(Object.isFrozen(result.template.overwrites), true, "the rows freeze too");
  assert.equal(result.template.roles[0].permissions,
    SERVER_PERMISSIONS.DELETE_MESSAGES | SERVER_PERMISSIONS.KICK_MEMBERS,
    "the named bits become the numeric mask");
});

test("the apply rides one all-or-nothing batch: roles, channels, the private pair, explicit overwrites", async () => {
  const { ok, template } = validateTemplate(GROVE);
  assert.equal(ok, true);
  const db = groveDb();
  const result = await applyTemplate(db, { serverId: 5, creatorId: 7 }, template);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, { roles: 2, channels: 3, overwrites: 3 });
  assert.equal(db.batchCalls, 1, "ONE batch, and no bare run beside it");
  assert.equal(db.bound.length, 8);
  const roles = db.bound.filter((s) => s.sql.includes("INSERT INTO gc_roles"));
  const channels = db.bound.filter((s) => s.sql.includes("INSERT INTO gc_channels"));
  const overwrites = db.bound.filter((s) => s.sql.includes("INSERT INTO gc_channel_overwrites"));
  assert.equal(roles.length, 2, "one role INSERT per role row, nothing extra");
  assert.equal(channels.length, 3, "one channel INSERT per channel row");
  assert.equal(roles.filter((s) => s.sql.includes("WHERE (")).length, 2,
    "the role INSERT carries the hand-rolled authority rider + cap precondition");
  assert.equal(channels.filter((s) => s.sql.includes("<= 499")).length, 3,
    "the channel INSERT carries the cap precondition");
  // The private toggle's pair (the document @everyone standing in, the
  // blanket role-allow arm excepting the document-covered seat) + the document
  // row for vip/voice. The general row is NOT private: its document row rides.
  assert.equal(overwrites.length, 3, "three overwrite statements, exactly stated");
  assert.equal(overwrites.some((s) => s.values.includes(SERVER_PERMISSIONS.VIEW | SERVER_PERMISSIONS.SEND)),
    true, "the vip deny layer carries the document's VIEW|SEND mask");
  assert.equal(overwrites.some((s) => s.values.includes(SERVER_PERMISSIONS.VIEW | SERVER_PERMISSIONS.SEND | SERVER_PERMISSIONS.CONNECT)),
    true, "the vip/voice allow layer carries VIEW|SEND|CONNECT");
  assert.equal(overwrites.some((s) => s.sql.includes("NOT IN")), true,
    "the blanket role-allow arm excepts the document-covered seat");
  for (const row of overwrites) {
    // The mask rides the statement's first seats (allow, deny for the
    // document targets; the single mask for the private pair's arms) — the
    // serverId/name seats are not masks.
    const maskSeats = row.sql.includes("SELECT c.id, r.id, ?, ?")
      ? [row.values[0], row.values[1]]
      : [row.values[0]];
    for (const value of maskSeats) {
      assert.equal((value & ~OVERWRITE_MASK_ALL) === 0, true,
        "every overwrite mask keeps within the tri-state vocabulary");
    }
  }
  for (const row of roles) {
    // The role mask rides the INSERT's fifth seat (created_at follows it at
    // six); the remaining numerics are the position-subquery/seat binds.
    const maskSeat = row.values[4];
    assert.equal((maskSeat & ~ROLE_MASK_ALL) === 0, true,
      "every role mask keeps within the server-level vocabulary");
  }
});

test("the apply pre-checks the channel cap against the live count — the refusal binds nothing", async () => {
  const atCap = MAX_CHANNELS_PER_SERVER - 2; // one seat short of three channels
  const db = groveDb({
    first: (sql) => (sql.includes("gc_channels") ? { n: atCap } : null),
  });
  const result = await applyTemplate(db, { serverId: 5, creatorId: 7 }, GROVE);
  assert.equal(result.ok, false);
  assert.equal(result.refusal, "That server has reached its channel limit.");
  assert.equal(db.batchCalls, 0, "a refused apply never batches");
});

test("a runtime zero-changes verdict is the all-or-nothing refusal — no partial surface", async () => {
  const db = groveDb({ changes: 0 });
  const result = await applyTemplate(db, { serverId: 5, creatorId: 7 }, GROVE);
  assert.equal(result.ok, false);
  assert.match(result.refusal, /all-or-nothing|could not apply/i,
    "the refusal says the apply refused wholesale");
});

test("the Grove's seeded shape reads exactly like a hand-rolled server: no hidden grants", () => {
  const seeded = validateTemplate(GROVE).template;
  const named = seeded.roles.flatMap((role) => role.permissions);
  assert.equal(typeof named[0] === "number", true, "the rides are masks, not names");
  assert.equal(named & SERVER_PERMISSIONS.MENTION_EVERYONE,
    0, "no Grove row carries a @everyone mint — the document never stated it");
  for (const row of seeded.overwrites) {
    for (const value of [row.deny, row.allow]) {
      assert.equal((value & ~OVERWRITE_MASK_ALL) === 0, true,
        "every overwrite bit rides the tri-state editor's list, nothing hidden");
    }
  }
  assert.equal(seeded.roles.length <= GC_ROLES_MAX_PER_SERVER, true, "role cap rides as data");
  assert.equal(Object.isFrozen(seeded.channels), true, "the seeded shape's arrays are frozen");
});
