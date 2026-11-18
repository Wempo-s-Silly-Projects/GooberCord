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

// The deploy-ledger pins (T25 rider, T71): the 2026-11-17 prod churn saw
// non-canonical deploys answer /api/version with build:"" — a bare
// `wrangler deploy` binds no --var, COMMIT_SHA falls back to "", the
// stale-build strip inerts, and the client's ?v= cache-buster breaks. These
// rows pin the canonical deploy script in BOTH trees (GC + wempos-forum,
// contract-parity idiom) and the worker's stamp fallback source, so any
// future drift lands through review instead of through prod.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const FORUM_ROOT = process.env.GC_FORUM_DIR || "/Users/itswempo/wempos-forum";

const COMMIT_SHA_BINDING = "--var COMMIT_SHA:$(git rev-parse --short HEAD)";

// R3 skip-if-absent guard: a fresh clone of this repo may not have the
// sibling wempos-forum checkout on disk, and an ENOENT crash there would read
// as red for a pin the clone cannot see. Each sibling pin skips itself (with
// the reason in the report) when its read target is absent; this tree's own
// pins are NEVER guarded — they must stay hard-failing everywhere.
const FORUM_SKIP_REASON =
  "sibling wempos-forum tree absent (fresh clone) — forum pin skipped, GC pins still enforced";

function skipForumPinIfNeeded(t, root, targetRelPath) {
  if (root === FORUM_ROOT && !existsSync(join(root, targetRelPath))) {
    t.skip(FORUM_SKIP_REASON);
    return true;
  }
  return false;
}

function deployScriptOf(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.scripts?.deploy ?? "";
}

test("deploy script pins the COMMIT_SHA binding + --keep-vars in both trees", (t) => {
  for (const [root, name] of [
    [join(HERE, ".."), "GooberCord"],
    [FORUM_ROOT, "wempos-forum"],
  ]) {
    if (skipForumPinIfNeeded(t, root, "package.json")) continue;
    const deploy = deployScriptOf(root);
    assert.ok(
      deploy.includes(COMMIT_SHA_BINDING),
      `${name} deploy script must bind COMMIT_SHA from git (got: ${JSON.stringify(deploy)})`,
    );
    assert.ok(
      deploy.includes("--keep-vars"),
      `${name} deploy script must keep existing secrets (got: ${JSON.stringify(deploy)})`,
    );
  }
});

test("worker stamp fallback answers empty string, never a fabricated build", (t) => {
  for (const { root, name, relPath } of [
    { root: join(HERE, ".."), name: "GooberCord", relPath: "api/accounts.mjs" },
    { root: FORUM_ROOT, name: "wempos-forum", relPath: "api/session.mjs" },
  ]) {
    if (skipForumPinIfNeeded(t, root, relPath)) continue;
    const source = readFileSync(join(root, relPath), "utf8");
    assert.match(
      source,
      /typeof env\.COMMIT_SHA === "string" \? env\.COMMIT_SHA : ""/,
      `${name} stamp route (${relPath}) must keep the unset-var fallback: build:"" is the honest "stamp missing" contract, not a placeholder build to strip against`,
    );
  }
});
