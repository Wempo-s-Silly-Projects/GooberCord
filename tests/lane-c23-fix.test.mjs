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

// The lane-c23-fix pins (the GO-HAYWIRE c23 audit's riders): F1 — the wave-16
// desk routes are RUNTIME-wired into worker.mjs's real dispatch chain (the
// text-only wiring gap class ends here: these tests ride worker.fetch, so an
// unwired handler cannot fake green); F2 — the desk's state face re-paints
// from a follow-up GET after the one explicit submit (updatedAt/source are
// GET-only); F3 — entryHelp names the backend's comma-split truth; F4 — the
// mod panel's tag write invalidates the server's map/mine lanes in the same
// client (the mod act IS the change point).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

import worker from "../worker.mjs";
import { _resetFilterWordsCacheForTests } from "../api/filterstore.mjs";
import { nowSeconds, randomToken, sha256Hex } from "../api/core/crypto.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..");
const ORIGIN = "https://goobercord.test";

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const DESK = () => read("public/js/ui/filterdesk.js");
const SETTINGS = () => read("public/js/ui/settings.js");
const TAGS_UI = () => read("public/js/ui/reaction-tags.js");

// --- shared scaffolding (the mod-desk-module idiom) ------------------------------

const SESSION_READ_TEST = (sql) => sql.includes("FROM sessions s LEFT JOIN users u");
const SETTINGS_ROW_TEST = (sql) => sql.includes("FROM site_settings WHERE key = ?");

async function ownerSession() {
  const token = randomToken();
  const csrf = randomToken(24);
  const row = {
    token_hash: await sha256Hex(token),
    user_id: 7,
    csrf_token: csrf,
    expires_at: nowSeconds() + 3600,
    username: "wempos",
    role: "owner",
    bio: "",
    avatar_status: null,
    avatar_mime: null,
    avatar_updated_at: null,
    avatar_version: null,
    totp_enabled: 0,
  };
  return { token, csrf, row };
}

// The fakeDb answers the two reads the desk routes make (the session read and
// the site_settings row); every other statement runs bare. The calls log pins
// the upsert's wire presence.
function fakeDb(routes) {
  const calls = [];
  const find = (sql) => routes.find((route) => route.test(sql));
  const db = {
    calls,
    prepare(sql) {
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ call: "first", sql, bound: statement.bound });
        const route = find(sql);
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ call: "all", sql, bound: statement.bound });
        return { results: [] };
      };
      statement.run = async () => {
        calls.push({ call: "run", sql, bound: statement.bound });
        return { meta: { changes: 1 } };
      };
      return statement;
    },
  };
  return db;
}

function deskEnv(db) {
  return {
    GOOBER_DB: db,
    GC_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
    GC_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

const get = (path, headers = {}) => new Request(ORIGIN + path, { method: "GET", headers });
const post = (path, body, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    ...headers,
  },
  body: JSON.stringify(body),
});

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

// --- F1: the wave-16 desk routes ride the REAL dispatch chain ---------------------

// RED gate: against the unwired tree both routes fall through API_HANDLERS to
// the notFound tail and answer 404 — the runtime proof the text pins could
// not capture. Each test rides worker.fetch with a staff (owner) session.

test("F1 RED-GATE: GET /api/admin/filter answers through the real chain for staff", async () => {
  _resetFilterWordsCacheForTests();
  const { token, row } = await ownerSession();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: SETTINGS_ROW_TEST,
      first: async () => ({ value: "darn\nspooky", updated_at: 1700000000 }),
    },
  ]);
  const response = await worker.fetch(
    get("/api/admin/filter", { Cookie: "goober_session=" + token }),
    deskEnv(db), undefined,
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(typeof body.words, "string");
  assert.equal(body.words, "darn\nspooky");
  assert.equal(body.source, "database");
  assert.equal(body.totalEntries, 2);
  assert.equal(body.updatedAt, "2023-11-14T22:13:20.000Z");
});

test("F1 RED-GATE: POST /api/admin/filter/entries adds through the real chain, the same client's GET sees it", async () => {
  _resetFilterWordsCacheForTests();
  const { token, row } = await ownerSession();
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => row },
    {
      test: SETTINGS_ROW_TEST,
      first: async () => ({ value: "darn\nspooky", updated_at: 1700000000 }),
    },
  ]);
  const response = await worker.fetch(
    post("/api/admin/filter/entries", { entries: "gloom, darn" },
      { Cookie: "goober_session=" + token, "X-CSRF-Token": row.csrf_token }),
    deskEnv(db), undefined,
  );
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(
    { added: body.added, skipped: body.skipped, totalEntries: body.totalEntries },
    { added: 1, skipped: 1, totalEntries: 3 },
  );
  const upsert = db.calls.find((call) =>
    call.call === "run" && call.sql.startsWith("INSERT INTO site_settings"));
  assert.ok(upsert, "the desk's add rides the frozen upsert statement");
  assert.deepEqual(upsert.bound.slice(0, 2), ["filtered_words", "darn\nspooky\ngloom"]);
  // The same client's GET answers the fresh truth through the same gate:
  const after = await worker.fetch(
    get("/api/admin/filter", { Cookie: "goober_session=" + token }),
    deskEnv(db), undefined,
  );
  assert.equal(after.status, 200);
  assert.equal((await bodyOf(after)).totalEntries, 3);
});

test("F1 keeps the gate's teeth: non-staff still 403s and the chain tail stays the notFound 404", async () => {
  _resetFilterWordsCacheForTests();
  const { token, row } = await ownerSession();
  const memberRow = { ...row, role: "member" };
  const db = fakeDb([
    { test: SESSION_READ_TEST, first: async () => memberRow },
  ]);
  const response = await worker.fetch(
    get("/api/admin/filter", { Cookie: "goober_session=" + token }),
    deskEnv(db), undefined,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { error: "Only admins can do that." });
});

test("F1 pin: the wiring is the one merged import and the seat rides beside the sibling desks", () => {
  const source = read("worker.mjs");
  assert.match(source, /import \{ ensureFilterWords, handleFilterAdminRoutes \} from "\.\/api\/filterstore\.mjs";/,
    "the one merged import — no second import line for the same module");
  const handlers = source.slice(
    source.indexOf("const API_HANDLERS"),
    source.indexOf("];", source.indexOf("const API_HANDLERS")),
  );
  assert.match(handlers, /handleFilterAdminRoutes/, "the desk has an API_HANDLERS seat");
  // Safe ordering: the admin desk is a request-lane owner like the account
  // family — it rides after the account/ss/server lanes and before the
  // static-family seats; its two-path head guard cannot shadow any path.
  const accountSeat = handlers.indexOf("handleAccountRoutes");
  const filterSeat = handlers.indexOf("handleFilterAdminRoutes");
  assert.ok(filterSeat > accountSeat, "the filter desk rides alongside the account-route family");
  assert.doesNotMatch(handlers, /handleFilterAdminRoutes,[\s\S]{0,80}handleAccountRoutes/,
    "no seat before the account family — the ordering rides the handler-family lanes");
});

// --- F2: the state face rides a follow-up GET after the one submit ----------------

test("F2: the POST's success arm refreshes the state face from a follow-up GET (updatedAt/source are GET-only)", () => {
  const desk = DESK();
  // Exactly ONE GET call-site literal remains — the shared state refresh —
  // and it is the one the wave-16 defaults-law pin counts (the wave-16
  // suite stays green; the follow-up ride shares the function, it does not
  // add a second call site).
  const loads = desk.match(/api\("\/api\/admin\/filter", \{ method: "GET" \}\)/) || [];
  assert.equal(loads.length, 1, "one shared GET call site — the open's auto-load and the submit's ride");
  // The submit's success arm calls the shared refresh inside ONE act: the
  // POST answer paints result/count, then the follow-up GET repaints the
  // state face from the fresh truth.
  const successArm = desk.slice(desk.indexOf("const answer = await api("),
    desk.indexOf("} catch (error)"));
  assert.ok(successArm.includes("refreshState();"),
    "the one explicit submit's success arm rides the state refresh");
  // The follow-up GET's answer repaints the source and stamp faces (the
  // POST's answer cannot paint them — both are GET-only envelope columns).
  const refresh = desk.slice(desk.indexOf("function refreshState"));
  assert.match(refresh, /\{ source: state\.source \}/);
  assert.match(refresh, /state\.updatedAt\s*\n\s*\? /, "the stamp paints the GET's updatedAt");
  assert.doesNotMatch(desk, /setInterval|setTimeout/, "a submit ride, never a poll");
});

// --- F3: entryHelp names the backend's comma-split truth --------------------------

test("F3: en's entryHelp names the real entry shape — the comma-split law (api/filter.mjs splitFilterEntries)", () => {
  const en = JSON.parse(read("public/locales/en.json"));
  assert.match(en["gc.filterdesk.entryHelp"], /[Cc]omma/);
  assert.match(en["gc.filterdesk.entryHelp"], /[Ss]plit/,
    "the help names that commas split entries (the backend's own split truth)");
});

test("F3: all eight staged bundles re-carry entryHelp TRANSLATED — no en placeholder", () => {
  const en = JSON.parse(read("public/locales/en.json"));
  for (const lang of ["de", "es", "fr", "pt", "ru", "ja", "zh", "ar"]) {
    const bundle = JSON.parse(read(`public/locales/${lang}.json`));
    const value = bundle["gc.filterdesk.entryHelp"];
    assert.equal(typeof value, "string", `${lang} seats entryHelp`);
    assert.notEqual(value, en["gc.filterdesk.entryHelp"], `${lang} carries entryHelp TRANSLATED`);
    assert.ok(!/,\s*skipped|placeholder/.test(value), `${lang} entryHelp is real copy`);
  }
});

// --- F4: the mod act invalidates the map/mine lanes in the same client ------------

test("F4 RED: the mod panel's PUT/DELETE success arms invalidate the server's two lanes", () => {
  const settings = SETTINGS();
  const tags = TAGS_UI();
  assert.match(tags,
    /export function invalidateReactionTagLanes\(serverId\) \{[\s\S]*?store\.set\(\{ \[mapKey\(serverId\)\]: undefined, \[mineKey\(serverId\)\]: undefined \}\);/,
    "the lanes' ONE invalidator — the mod act is the change point");
  const panel = settings.slice(settings.indexOf("function reactionTagsPanel"),
    settings.indexOf("function ", settings.indexOf("function reactionTagsPanel") + 10));
  // The PUT arm and the DELETE arm each ride the invalidate behind their
  // success (the panel re-fetches its own table; the member face in the same
  // client re-pulls on its next open). Source order: the DELETE arm paints
  // first (paintTable), the PUT arm rides the form's confirm dialog after.
  const putIndex = panel.indexOf("method: \"PUT\"");
  const deleteIndex = panel.indexOf("method: \"DELETE\"");
  assert.ok(putIndex > deleteIndex, "the arms' source order (DELETE paints first, PUT rides the confirm)");
  const putArm = panel.slice(putIndex);
  const deleteArm = panel.slice(deleteIndex, putIndex);
  assert.match(putArm, /invalidateReactionTagLanes\(serverId\);/,
    "the PUT's success arm invalidates");
  assert.match(deleteArm, /invalidateReactionTagLanes\(serverId\);/,
    "the DELETE's success arm invalidates");
});
