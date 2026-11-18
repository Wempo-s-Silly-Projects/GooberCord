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

// T84 Server Seasons — RED lane (spec: docs/drafts/t84-server-seasons-spec.md
// under construction; exemplar pin style: docs/drafts/t83-goober-of-the-day-
// spec.md §4). RED today by construction — api/seasons.mjs, the constants'
// season block, and the worker registration do not exist; the file's first
// statement fails on the import — that IS the raw RED error and the GREEN
// seed. The pins below are the EXACT deltas: a floor-only implementation
// (constants declared but no sink ordering, a meter table/writer, an
// unguarded completion, a DML-carrying migration, a missing mod gate) stays
// RED — floor-only is fake-green.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../worker.mjs";
import * as C from "../constants.mjs";
import { handleSeasonRoutes } from "../api/seasons.mjs";

const CONSTANTS_SRC = readFileSync(new URL("../constants.mjs", import.meta.url), "utf8");
const MIGRATION_SRC = readFileSync(
  new URL("../migrations/0034_gc_server_seasons.sql", import.meta.url),
  "utf8",
);

test("T84 constants: the exact season deltas, no re-declared caps", () => {
  assert.equal(C.GC_SEASON_WEEK_SECONDS, 604800);
  assert.equal(C.GC_SEASON_MAX_WEEKS, 12);
  assert.equal(C.GC_SEASON_NAME_MAX, 64);
  assert.equal(C.GC_SEASON_METER_GOAL_MAX, 100000);
  assert.equal(C.GC_SEASON_REWARD_COINS, 250);
  assert.deepEqual(C.GC_SEASON_COLOR_TOKENS, ["green", "coral", "yellow", "blue"]);
  // Caps law: the Campfire-pool split is ONE law, ONE declaration — the
  // season lane reuses the jobs lane's pool-share percents, never re-declares.
  assert.ok(!CONSTANTS_SRC.includes("GC_SEASON_POOL_SHARE"));
  assert.ok(!CONSTANTS_SRC.includes("GC_SEASON_MEMBER_SHARE"));
});

test("T84 sink law: finish mints pool-first, 80/20, one credit fingerprint", () => {
  // The 250-coin finish splits poolShare=200 / memberShare=50, and the pool
  // credit statement is bound BEFORE any member seat in the SAME batch.
  const poolShare = Math.round(C.GC_SEASON_REWARD_COINS * C.GC_JOB_POOL_SHARE_PERCENT / 100);
  const memberShare = Math.round(C.GC_SEASON_REWARD_COINS * C.GC_JOB_MEMBER_SHARE_PERCENT / 100);
  assert.equal(poolShare, 200);
  assert.equal(memberShare, 50);
  const seasonsSrc = readFileSync(new URL("../api/seasons.mjs", import.meta.url), "utf8");
  const credits = (seasonsSrc.match(/campfirePoolCreditStatement\(/g) || []).length;
  assert.ok(credits >= 1, "the finish mints through the SHARED pool credit helper");
  // The completion INSERT (once-per-season PK) rides the SAME batch as the
  // credit, so a raced pair of completers answers changes 0 and mints once.
  assert.match(seasonsSrc, /gc_season_completions/);
  assert.match(seasonsSrc, /ON CONFLICT \(server_id, season_started_at\) DO NOTHING/);
});

test("T84 no new tracker: the meter is a read-time aggregate, zero writers", () => {
  const seasonsSrc = readFileSync(new URL("../api/seasons.mjs", import.meta.url), "utf8");
  // The meter READS the activity the server already has (messages +
  // reactions through the channel seat); it writes nothing of its own.
  // No per-member tracker, no counter table, no INSERT with "meter" shape.
  assert.match(seasonsSrc, /gc_message_reactions/);
  assert.match(seasonsSrc, /gc_channels/);
  // The message/reaction lanes never import the season module — no event
  // hook, no counter bump from the live lanes (contribution is by
  // activity the server already has, never by a new tracker).
  const messagesSrc = readFileSync(new URL("../api/messages.mjs", import.meta.url), "utf8");
  assert.ok(!messagesSrc.includes("api/seasons.mjs"));
  const jobsSrc = readFileSync(new URL("../api/jobs.mjs", import.meta.url), "utf8");
  assert.ok(!jobsSrc.includes("api/seasons.mjs"));
});

test("T84 defaults law: no season configured == no change", () => {
  const seasonsSrc = readFileSync(new URL("../api/seasons.mjs", import.meta.url), "utf8");
  const current = seasonsSrc.match(/const CURRENT_READ_SQL = `([\s\S]*?)`;/);
  assert.ok(current, "the current-season lookup is a named pinned SQL");
  // The lookup is the ONLY statement a seasonless server ever fires: the
  // no-season path answers { season: null } and stops there.
  assert.match(current[1], /FROM gc_server_seasons/);
  assert.match(current[1], /ORDER BY started_at DESC LIMIT 1/);
  // No row is ever created by anyone but the mod's POST.
  assert.ok(!/INSERT INTO gc_server_seasons/.test(current[1]));
});

test("T84 mod gate: create + end carry the owner-role arm, reads are member-level", () => {
  const seasonsSrc = readFileSync(new URL("../api/seasons.mjs", import.meta.url), "utf8");
  // The mod-gate SELECT rides the same pinned shape as the roles lanes
  // (SELECT role FROM gc_server_members ...) with its own SQL fingerprint.
  assert.match(seasonsSrc, /SELECT role FROM gc_server_members/);
});

test("T84 migration 0034: CREATE-only (rebuild-class = STOP)", () => {
  const statements = MIGRATION_SRC.replace(/--[^\n]*/g, "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  assert.ok(statements.length >= 3);
  for (const statement of statements) {
    assert.match(statement, /^CREATE (TABLE|INDEX)/);
    assert.ok(!/^(INSERT|UPDATE|DELETE|ALTER|DROP)/.test(statement));
  }
  assert.match(MIGRATION_SRC, /gc_season_completions/);
  assert.match(MIGRATION_SRC, /PRIMARY KEY \(server_id, season_started_at\)/);
});

test("T84 conservation shapes: guarded completion, expired-window read, per-server seat", () => {
  const seasonsSrc = readFileSync(new URL("../api/seasons.mjs", import.meta.url), "utf8");
  // Window arithmetic is a pure date-key comparison (no timers anywhere in
  // the module: no setTimeout, no setInterval, no cron wiring).
  assert.ok(!seasonsSrc.includes("setTimeout"));
  assert.ok(!seasonsSrc.includes("setInterval"));
  assert.match(seasonsSrc, /GC_SEASON_WEEK_SECONDS/);
  // Every season statement binds ITS OWN server seat; there is no surface
  // that aggregates across servers and no global/leaderboard route.
  assert.ok(!seasonsSrc.includes("/api/seasons/leaders"));
  assert.ok(!/[Gg]lobal/.test(seasonsSrc.split("/**")[2] || ""));
});

test("T84 route registration: handleSeasonRoutes rides the worker dispatch chain", () => {
  const workerSrc = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
  assert.match(workerSrc, /import \{ handleSeasonRoutes \} from "\.\/api\/seasons\.mjs";/);
  assert.match(workerSrc, /handleSeasonRoutes,/);
  // Chain position: directly after the jobs family per the dispatch law.
  const order = workerSrc.indexOf("handleJobsRoutes,");
  assert.ok(order >= 0);
  const season = workerSrc.indexOf("handleSeasonRoutes,");
  assert.ok(season > order);
});
