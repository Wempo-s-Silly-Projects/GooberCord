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
// MERCHANTABILITY or FITNESS FOR a PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the
// GNU Affero General Public License along with this program.  If not,
// see <https://www.gnu.org/licenses/>

// The orphan-sweep FK law evidence (lane-r2-sweep): a table that already has
// a CASCADE FK to its doomed parent needs NO explicit sweep — the schema is
// the code. These pins read the migration files and record, as executable
// evidence, which message-scoped and server-scoped tables are FK-covered
// (no code, pin-only) and which are not (the sweep statements in
// api/messages.mjs + api/servers.mjs are the contract).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MIGRATIONS = "migrations";

const migration = (name) => readFileSync(`${MIGRATIONS}/${name}`, "utf8");

const blockOf = (sql, table) => {
  const at = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
  const start = sql.indexOf(`CREATE TABLE ${table}`);
  const from = at >= 0 ? at : start;
  return sql.slice(from, sql.indexOf(");", from));
};

test("message-scoped FK law: reactions and mentions CASCADE, read state is channel-scoped", () => {
  const reactions = blockOf(migration("0009_social.sql"), "gc_message_reactions");
  assert.match(reactions, /message_id INTEGER NOT NULL REFERENCES gc_messages\(id\) ON DELETE CASCADE/,
    "gc_message_reactions rides the message FK CASCADE — no explicit sweep, pin-only");

  const mentions = blockOf(migration("0028_mentions.sql"), "gc_mentions");
  assert.match(mentions, /message_id INTEGER NOT NULL REFERENCES gc_messages\(id\) ON DELETE CASCADE/,
    "gc_mentions rides the message FK CASCADE — no explicit sweep, pin-only");

  const readState = blockOf(migration("0001_initial_goobercord.sql"), "gc_read_state");
  assert.match(readState, /channel_id INTEGER NOT NULL REFERENCES gc_channels\(id\) ON DELETE CASCADE/,
    "gc_read_state's FK binds the CHANNEL, whose death CASCADEs it");
  assert.ok(!readState.includes("REFERENCES gc_messages"),
    "gc_read_state has NO message-scoped rows — nothing to sweep on message death");
});

test("sweep-needed orphans: bookmarks, the welcome pair and the sounds rows have no parent FK (or do, for sounds)", () => {
  const bookmarks = migration("0053_gc_bookmarks.sql");
  assert.ok(!bookmarks.includes("REFERENCES"),
    "gc_bookmarks carries NO FK at all — the message/channels/server sweeps are the orphan law, not the schema");

  const welcome = migration("0054_gc_welcome_cards.sql");
  assert.ok(!welcome.includes("REFERENCES"),
    "gc_welcome_cards + gc_welcome_card_views carry NO FK — the server purge's sweep statements are the orphan law");
  assert.match(welcome, /PRIMARY KEY \(server_id\)/,
    "both welcome tables are server-scoped (server_id key) — server death is their only doom");

  const sounds = blockOf(migration("0023_soundboard.sql"), "gc_sounds");
  assert.match(sounds, /server_id INTEGER NOT NULL REFERENCES gc_servers\(id\) ON DELETE CASCADE/,
    "gc_sounds rides the server FK CASCADE — the server purge needs NO explicit sounds sweep");
});

test("the reaction-tag pair is prod-applied without a tree migration (the sweep is FK-shape-safe)", () => {
  // api/reaction-tags.mjs rides migration 0041's PROD-APPLIED tables, which
  // the migration tree does not carry. The opts rows key on tag_id — the
  // purge's opts-before-tags sweep is FK-shape-safe whichever FK law the
  // prod ledger carries: if the FK CASCADEs, the sweep is redundant no-op;
  // if it is absent, the sweep is the orphan law.
  const files = ["0009_social.sql", "0023_soundboard.sql", "0054_gc_welcome_cards.sql"];
  for (const file of files) {
    assert.ok(!migration(file).includes("gc_reaction_tag_opts"),
      `the reaction-tag pair lives outside the tree's ${file}`);
  }
  // The prod ledger's comment is the stored evidence:
  assert.ok(readFileSync("api/reaction-tags.mjs", "utf8")
    .includes("gc_server_reaction_tags + gc_reaction_tag_opts ride migration 0041"));
});
