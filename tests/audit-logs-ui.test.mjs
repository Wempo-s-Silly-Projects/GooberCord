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

// The audit log's UI pin (W26-1's frontend half: the Logs panel in the
// server settings page) — the same static-analysis lane the settings panels
// pin through (cosmetics-ui.test.mjs style): the source is read as text,
// the en seats are read as data, and the backend writer call sites are read
// as the ONE inventory the client's action-key composition answers to. The
// panel is read-only: ONE auto-GET per visit paints the newest-first page,
// rows ride h() + text seats (no innerHTML anywhere in the settings lane),
// the empties (no entries or the 403-shaped empty page the guard serves)
// are the honest empty state, and actor/target/ref/timestamp paint verbatim
// (server-native data, never t()'d).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SETTINGS = readFileSync(join(HERE, "../public/js/ui/settings.js"), "utf8");
const MOD = readFileSync(join(HERE, "../api/server-mod.mjs"), "utf8");
const ROLES = readFileSync(join(HERE, "../api/server-roles.mjs"), "utf8");
const CHANNELS = readFileSync(join(HERE, "../api/server-channels.mjs"), "utf8");
const enData = JSON.parse(readFileSync(join(HERE, "../public/locales/en.json"), "utf8"));

const ACTION_KEYS = [
  "member.kick", "member.ban", "member.unban", "member.prune",
  "role.create", "role.update", "role.delete", "member.nick",
  "overwrite.update", "overwrite.delete",
];
const ACTION_SEATS = ACTION_KEYS.map((key) => "gc.settings.audit.actions." + key);
const LOGS_KEYS = ["gc.settings.audit.heading", "gc.settings.audit.count",
  "gc.settings.audit.empty", ...ACTION_SEATS];

test("the Logs panel is mounted inside the server settings page's node stack", () => {
  assert.match(SETTINGS, /function auditLogsPanel\(/,
    "the panel function exists beside the sibling settings panels");
  assert.match(SETTINGS, /nodes\.push\(auditLogsPanel\(serverId\)\)/,
    "the panel rides the nodes.push registration idiom after the mod-facing seats");
  assert.match(SETTINGS, /t\("gc\.settings\.audit\.heading"\)/,
    "the heading rides the en-seated key");
});

test("the panel's one auto-GET rides the frozen audit read arm", () => {
  assert.match(SETTINGS, /api\(`\/api\/servers\/\$\{serverId\}\/audit`\)/,
    "the fetch targets GET /api/servers/:id/audit (T-R26-AUDIT's wire)");
  assert.match(SETTINGS, /entry\.createdAt/,
    "the timestamp paints the entry's createdAt verbatim (the ledger-row idiom)");
});

test("every row renders through h() text seats — no innerHTML anywhere in the settings lane", () => {
  assert.ok(!/\.innerHTML/.test(SETTINGS),
    "the XSS law: no innerHTML access in public/js/ui/settings.js, ever");
  assert.match(SETTINGS, /t\("gc\.settings\.audit\.actions\." \+ entry\.actionKey\)/,
    "the action line composes the seat per entry's actionKey — never the raw key painted");
});

test("the empty page (zero entries or the 403-shaped empty page) is the honest empty state", () => {
  assert.match(SETTINGS, /gc\.settings\.audit\.empty/,
    "the empty state rides its en seat");
  assert.match(SETTINGS, /gc\.settings\.audit\.count/,
    "the count line rides its en seat with the AUDIT_READ_LIMIT mirror shape");
});

test("each en seat exists exactly once, and every writer call site's actionKey has a seat", () => {
  for (const key of LOGS_KEYS) {
    assert.equal(typeof enData[key], "string", "en.json seats " + key);
  }
  const serialized = readFileSync(join(HERE, "../public/locales/en.json"), "utf8");
  for (const key of LOGS_KEYS) {
    const hits = serialized.split('"' + key + '"').length - 1;
    assert.equal(hits, 1, key + " is seated exactly once");
  }
  // The writer call sites are the ONE inventory — every actionKey a writer
  // records must have a client seat, so a future action lands with its key.
  for (const source of [MOD, ROLES, CHANNELS]) {
    for (const match of source.matchAll(/recordAudit\(env, [^,]+, [^,]+, "([a-z.]+)"/g)) {
      const key = "gc.settings.audit.actions." + match[1];
      assert.equal(typeof enData[key], "string", "en.json seats the writer's " + match[1] + " as " + key);
    }
  }
});
