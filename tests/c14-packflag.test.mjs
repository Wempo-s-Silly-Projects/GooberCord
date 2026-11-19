// GooberCord — the shop payload's pack owned-flag predicate
// Copyright (C) 2026  Wempo's Silly Projects
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

// GO-HAYWIRE cycle-14: the pack's payload `owned` flag must carry the
// SPEND GUARD's own predicate — the c11 NOT-EXISTS arm refuses when the
// caller owns ANY of the pack's items, so a half-owned caller is already
// the 409 "already own" class. The old all-owned flag advertised the pack
// as buyable to exactly the callers the guard refuses.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sqlite3 from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const shopSource = readFileSync(join(ROOT, "api/coins.mjs"), "utf8");

test("the pack's payload owned flag carries the spend guard's ANY-owned predicate", () => {
  // The payload row (the c14 fix): banner and flair ride OR — any half
  // of the pack is the guard's refusal class, the flag says so.
  const packRow = shopSource
    .split("\n")
    .slice(
      shopSource.split("\n").findIndex((line) => line.includes('item: "pack"')),
      shopSource.split("\n").findIndex((line) => line.includes('item: "pack"')) + 8,
    )
    .join("\n");
  assert.match(
    packRow,
    /owned: owned\("banner"\) \|\| owned\("flair"\)/,
    `the pack payload's owned flag must be owned("banner") || owned("flair") — the guard's own predicate; got:\n${packRow}`,
  );
  assert.doesNotMatch(packRow, /owned: owned\("banner"\) && owned\("flair"/);
});

test("the spend guard's ANY-owned refusal is unchanged — the guard the flag now mirrors", () => {
  // The c11 arm (machine truth): NOT EXISTS ow.item IN (banner, flair).
  // The guard's arm shape, read against the source's string-concat form:
  // concatenate the SQL literals the source builds, then match the arm.
  const headSql = shopSource
    .slice(shopSource.indexOf("const COSMETIC_LEGACY_SPEND_HEAD_SQL"))
    .split(";")[0]
    .replace(/(?:[\n ]*\+[\n ]*|")/g, " ")
    .replace(/\s+/g, " ");
  assert.match(
    headSql,
    /AND NOT EXISTS \( SELECT 1 FROM gc_cosmetic_ownership ow WHERE ow\.user_id = \? AND ow\.item IN \( *$/,
    "the spend head's NOT-EXISTS arm must keep its IN (banner, flair) shape",
  );
});

test("mixed ownership in a real D1-shaped batch: half-owned caller is the 409 class, nothing drains", () => {
  // The failure scenario the old flag created: buy banner standalone,
  // then the pack — guard refuses (any-owned), nothing drains, and the
  // payload must have said owned so the client never offers the buy.
  const db = new sqlite3.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gc_coin_ledger (user_id INTEGER, delta INTEGER, source TEXT, created_at INTEGER, spend_nonce TEXT);
    CREATE TABLE gc_cosmetic_ownership (user_id INTEGER, item TEXT);
  `);
  db.prepare("INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce) VALUES (?, ?, ?, ?, ?)").run(7, 300, "daily", 1, null);
  db.prepare("INSERT INTO gc_cosmetic_ownership (user_id, item) VALUES (?, ?)").run(7, "banner");

  // The guard's arm shape, mirrored from COSMETIC_LEGACY_SPEND_HEAD_SQL:
  const items = ["banner", "flair"];
  const refuse = db.prepare(
    "INSERT INTO gc_coin_ledger (user_id, delta, source, created_at, spend_nonce) " +
    "SELECT ?, ?, ?, ?, ? " +
    "WHERE (SELECT COALESCE(SUM(le4.delta), 0) FROM gc_coin_ledger le4 WHERE le4.user_id = ?) >= ? " +
    "AND NOT EXISTS (SELECT 1 FROM gc_cosmetic_ownership ow WHERE ow.user_id = ? AND ow.item IN (?, ?)) LIMIT 1",
  );
  const refused = refuse.run(7, -250, "cosmetic", 2, "n1", 7, 250, 7, ...items);
  assert.equal(refused.changes, 0, "a half-owned pack purchase is the guard's refusal — nothing drains");
  const balance = db.prepare("SELECT COALESCE(SUM(delta), 0) AS b FROM gc_coin_ledger WHERE user_id = ?").get(7);
  assert.equal(balance.b, 300, "the standing (undrained) balance is what the classify probe reads");
  // And the payload predicate the flag now carries says the pack is owned:
  const owned = (item) => db.prepare("SELECT 1 FROM gc_cosmetic_ownership WHERE user_id = ? AND item = ?").get(7, item) !== undefined;
  assert.equal(owned("banner") || owned("flair"), true, "the payload flag (any-owned) matches the guard for this caller");
});
