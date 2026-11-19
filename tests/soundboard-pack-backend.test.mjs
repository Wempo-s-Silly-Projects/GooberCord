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

// T85 Soundboard Studio — the BACKEND half's pins (the client's routes are
// LIVE: public/js/ui/soundboard-studio.js calls /api/servers/:id/sound-packs
// and its nested arms). Idiom: the goober-jobs-red coins-module fakeDb —
// every statement's guard arms are ENCODED in the fake, so a pinned statement
// that loses an arm fails the tests (the mod gate, the candidate statuses,
// the dup arms, the slots cap). The source pins additionally read
// api/soundpacks.mjs' statement texts so the gate stays INSIDE the SQL.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import worker from "../worker.mjs";
import * as C from "../constants.mjs";
import { RATE_LIMIT_BINDINGS } from "../constants.mjs";
import { nowSeconds, sha256Hex } from "../api/core/crypto.mjs";

const ORIGIN = "https://goobercord.itswempo.workers.dev";
const SERVER_ID = 1;
const USER_ID = 7;
const PACK_ID = 44;
const CLIP_ID = 91;
const STAGED_ID = "ACDEFGHIJKLM"; // exactly 12 chars, the upload-id grammar

const SESSION_TOKEN = "A".repeat(40);

const SESSION_ROW = {
  token_hash: "S".repeat(64),
  user_id: USER_ID,
  csrf_token: "B".repeat(24),
  expires_at: nowSeconds() + 3600,
  username: "wempos",
};

const MODULE_SOURCE = () =>
  readFileSync(new URL("../api/soundpacks.mjs", import.meta.url), "utf8");

// --- the packDb (the coins-module fake: the GUARDS live in the fake) --------

function packDb(options = {}) {
  const roster = options.roster || [];
  const packs = new Map(options.packs || []);      // pack id -> { server_id, name }
  let nextPack = 1000 + packs.size;
  const clips = [...(options.clips || [])];        // { id, pack_id, name, status }
  let nextClip = 5000 + clips.length;
  const staging = new Map(options.staging || []);  // upload id -> { parts: [Uint8Array] }
  const vanish = options.vanishAtInsert || [];     // tokens swept between the verify and the INSERT
  const calls = [];

  const packOf = (packId) => packs.get(Number(packId));
  const clipOf = (clipId) => clips.find((c) => c.id === Number(clipId));
  const approvedCount = (packId) =>
    clips.filter((c) => c.pack_id === Number(packId) && c.status === "approved").length;

  const routes = [
    {
      test: (sql) => sql.includes("FROM sessions s LEFT JOIN users u"),
      first: async () => SESSION_ROW,
    },
    {
      // The slots resolver (api/boost-level.mjs) reads the server's boosts.
      test: (sql) => sql.startsWith("SELECT boosts FROM gc_servers"),
      first: async () => ({ boosts: 0 }),
    },
    {
      // The membership gate (the read-tier's shared 404).
      test: (sql) => sql.startsWith("SELECT 1 AS member FROM gc_server_members"),
      first: async (bound) => (roster.includes(Number(bound[1])) ? { member: 1 } : null),
    },
    {
      // The clip-state classifier read (arm-order after a changes-0 write).
      test: (sql) => sql.includes("FROM gc_sound_pack_sounds ps JOIN gc_sound_packs p ON p.id = ps.pack_id") &&
        sql.includes("WHERE ps.id = ?"),
      first: async (bound) => {
        const clip = clipOf(bound[0]);
        if (!clip) return null;
        return { id: clip.id, status: clip.status, pack_id: clip.pack_id, server_id: SERVER_ID };
      },
    },
    {
      // The list arm: packs with their approved-sound counts.
      test: (sql) => sql.includes("FROM gc_sound_packs p WHERE p.server_id"),
      all: async (bound) => ({
        results: [...packs.values()]
          .filter((p) => p.server_id === Number(bound[0]))
          .map((p) => ({
            id: p.id ?? [...packs.keys()].find((k) => packs.get(k) === p),
            name: p.name,
            created_at: nowSeconds(),
            sounds: approvedCount(p.id ?? [...packs.keys()].find((k) => packs.get(k) === p)),
          })),
      }),
    },
    {
      test: (sql) => sql.includes("FROM gc_sound_pack_sounds ps JOIN gc_sound_packs p") &&
        sql.includes("WHERE p.server_id = ?"),
      all: async (bound) => ({
        results: clips
          .filter((c) => c.status === "candidate")
          .map((c) => ({ id: c.id, pack_id: c.pack_id, name: c.name })),
      }),
    },
    {
      // The mod gate rides INSIDE the insert (guard binds 4-7: the owner pair
      // then the role-bit pair) — the fake encodes it, so a pinned create
      // that loses the arm fails here.
      test: (sql) => sql.startsWith("INSERT INTO gc_sound_packs"),
      run: (bound, sql) => {
        const serverId = Number(bound[0]);
        const actorId = Number(bound[2]);
        const gatesServer = Number(bound[4]) === serverId && Number(bound[6]) === serverId;
        const gatesActor = Number(bound[5]) === actorId && Number(bound[7]) === actorId;
        if (!sql.includes("gc_server_members om") || !gatesServer || !gatesActor) {
          return { meta: { changes: 0 } };
        }
        if (!roster.includes(actorId)) return { meta: { changes: 0 } };
        for (const pack of packs.values()) {
          if (pack.server_id === serverId && pack.name === bound[1]) {
            throw new Error("UNIQUE constraint failed: gc_sound_packs.server_id, gc_sound_packs.name");
          }
        }
        const id = nextPack++;
        packs.set(id, { server_id: serverId, name: bound[1] });
        return { meta: { changes: 1, last_row_id: id } };
      },
    },
    {
      test: (sql) => sql.startsWith("DELETE FROM gc_sound_packs"),
      run: (bound, sql) => {
        const packId = Number(bound[0]);
        const serverId = Number(bound[1]);
        const gatesServer = Number(bound[2]) === serverId && Number(bound[4]) === serverId;
        const gatesActor = Number(bound[3]) === Number(bound[5]);
        if (!sql.includes("gc_server_members om") || !gatesServer || !gatesActor) {
          return { meta: { changes: 0 } };
        }
        const pack = packOf(packId);
        if (!pack || pack.server_id !== serverId || !roster.includes(Number(bound[3]))) {
          return { meta: { changes: 0 } };
        }
        packs.delete(packId);
        for (const clip of clips.filter((c) => c.pack_id === packId)) {
          clips.splice(clips.indexOf(clip), 1);
        }
        return { meta: { changes: 1 } };
      },
    },
    {
      // The candidate insert's arms: the pack-exists pair, the membership
      // pair, the STAGED-BYTES pair (a swept/absent token refuses — the
      // verify-to-insert window), and BOTH dup NOT-EXISTS arms — every one
      // encoded.
      test: (sql) => sql.startsWith("INSERT INTO gc_sound_pack_sounds"),
      run: (bound, sql) => {
        const packId = Number(bound[7]);
        const serverId = Number(bound[8]);
        const memberServer = Number(bound[9]);
        const memberId = Number(bound[10]);
        const stagedUpload = String(bound[11]);
        const stagedUploader = Number(bound[12]);
        const dupServer = Number(bound[13]);
        const dupUpload = String(bound[14]);
        const dupNamePack = Number(bound[15]);
        const dupName = String(bound[16]);
        if (
          !sql.includes("gc_sound_packs p WHERE p.id = ? AND p.server_id = ?") ||
          !sql.includes("gc_server_members") ||
          !sql.includes("gc_upload_parts u WHERE u.upload_id = ? AND u.uploader_id = ?") ||
          !sql.includes("NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE pack_id = ? AND upload_id = ?)") ||
          !sql.includes("NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE pack_id = ? AND name = ?)")
        ) {
          return { meta: { changes: 0 } };
        }
        if (vanish.includes(stagedUpload)) staging.delete(stagedUpload);
        if (!staging.has(stagedUpload) || stagedUploader !== memberId) {
          return { meta: { changes: 0 } }; // the sweep arm: no staged bytes, no clip
        }
        const pack = packOf(packId);
        if (!pack || pack.server_id !== serverId) return { meta: { changes: 0 } };
        if (memberServer !== serverId || !roster.includes(memberId)) return { meta: { changes: 0 } };
        if (dupServer !== packId) return { meta: { changes: 0 } };
        if (dupNamePack !== packId) return { meta: { changes: 0 } };
        if (clips.some((c) => c.pack_id === packId && c.upload_id === dupUpload) ||
            clips.some((c) => c.pack_id === packId && c.name === dupName)) {
          throw new Error("UNIQUE constraint failed: gc_sound_pack_sounds.pack_id, gc_sound_pack_sounds.name");
        }
        const id = nextClip++;
        clips.push({
          id, pack_id: packId, name: bound[1], upload_id: dupUpload,
          size_bytes: Number(bound[3]), mime: bound[4], status: "candidate",
          added_by: memberId,
        });
        return { meta: { changes: 1, last_row_id: id } };
      },
    },
    {
      // The approve's gate: pack arm, mod guard (binds 4-7), and the slots
      // cap arm (bind 8) — all encoded.
      test: (sql) => sql.startsWith("UPDATE gc_sound_pack_sounds"),
      run: (bound, sql) => {
        const clipId = Number(bound[0]);
        const packId = Number(bound[1]);
        const armPack = Number(bound[2]);
        const armServer = Number(bound[3]);
        const capPack = Number(bound[8]);
        const isMod = roster.includes(Number(bound[5])) &&
          Number(bound[5]) === Number(bound[7]) &&
          Number(bound[4]) === Number(bound[6]);
        if (
          !sql.includes("gc_sound_packs p WHERE p.id = ? AND p.server_id = ?") ||
          !sql.includes("gc_server_members om") ||
          !sql.includes("(SELECT COUNT(*) FROM gc_sound_pack_sounds WHERE pack_id = ? AND status = 'approved')")
        ) {
          return { meta: { changes: 0 } };
        }
        if (armPack !== packId || capPack !== packId) return { meta: { changes: 0 } };
        const clip = clipOf(clipId);
        if (!clip || clip.status !== "candidate") return { meta: { changes: 0 } };
        const pack = packOf(armPack);
        if (!pack || pack.server_id !== armServer || !isMod) return { meta: { changes: 0 } };
        if (approvedCount(packId) >= C.GC_SOUNDBOARD_MAX_PER_SERVER) return { meta: { changes: 0 } };
        clip.status = "approved";
        return { meta: { changes: 1 } };
      },
    },
    {
      // The drop: candidate-only, mod-gated, pack-scoped.
      test: (sql) => sql.startsWith("DELETE FROM gc_sound_pack_sounds"),
      run: (bound, sql) => {
        const clipId = Number(bound[0]);
        const packId = Number(bound[1]);
        const armPack = Number(bound[2]);
        const armServer = Number(bound[3]);
        const isMod = roster.includes(Number(bound[5])) &&
          Number(bound[5]) === Number(bound[7]) &&
          Number(bound[4]) === Number(bound[6]);
        if (!sql.includes("gc_sound_packs p WHERE p.id = ? AND p.server_id = ?") ||
            !sql.includes("gc_server_members om")) {
          return { meta: { changes: 0 } };
        }
        if (armPack !== packId) return { meta: { changes: 0 } };
        const clip = clipOf(clipId);
        const pack = packOf(armPack);
        if (!clip || clip.status !== "candidate" || !pack || pack.server_id !== armServer || !isMod) {
          return { meta: { changes: 0 } };
        }
        clips.splice(clips.indexOf(clip), 1);
        return { meta: { changes: 1 } };
      },
    },
    {
      // The approve/drop classification's count read (the cap arm's answer).
      test: (sql) => sql.startsWith("SELECT COUNT(*) AS n FROM gc_sound_pack_sounds"),
      first: async (bound) => ({ n: approvedCount(bound[0]) }),
    },
    {
      // The staged set's spread read.
      test: (sql) => sql.includes("FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?") &&
        sql.includes("COUNT(*) AS n"),
      first: async (bound) => {
        const staged = staging.get(String(bound[0]));
        if (!staged || Number(bound[1]) !== USER_ID) return null;
        return { n: staged.parts.length, size: staged.parts.reduce((t, p) => t + p.length, 0) };
      },
    },
    {
      test: (sql) => sql.startsWith("SELECT data FROM gc_upload_parts"),
      first: async (bound) => {
        const staged = staging.get(String(bound[0]));
        if (!staged) return null;
        return { data: staged.parts[0] };
      },
    },
    {
      // The staging clear's arms, ENCODED (the lifecycle fake): a token
      // another clip still references is never cleared, the mod gate + the
      // pack-in-server arm ride the statement, and a refused arm deletes
      // nothing.
      test: (sql) => sql.startsWith("DELETE FROM gc_upload_parts"),
      run: (bound, sql) => {
        if (sql.includes("s.status = 'candidate'")) {
          // The drop arm: [clipId, packId, clipId, clipId, packId, serverId,
          // serverId, actorId, serverId, actorId].
          const isMod = roster.includes(Number(bound[7])) &&
            Number(bound[7]) === Number(bound[9]) && Number(bound[6]) === Number(bound[8]);
          const clip = clipOf(bound[0]);
          const pack = packOf(Number(bound[4]));
          if (!sql.includes("gc_sound_packs p WHERE p.id = ? AND p.server_id = ?") ||
              !sql.includes("r.id <> ?")) {
            return { meta: { changes: 0 } };
          }
          if (!pack || pack.server_id !== Number(bound[5]) || !isMod) {
            return { meta: { changes: 0 } };
          }
          if (!clip || clip.status !== "candidate" || clip.pack_id !== Number(bound[1])) {
            return { meta: { changes: 0 } };
          }
          if (clips.some((c) => c.upload_id === clip.upload_id && c.id !== clip.id)) {
            return { meta: { changes: 0 } }; // another clip still references the token
          }
          const cleared = staging.delete(String(clip.upload_id));
          return { meta: { changes: cleared ? 1 : 0 } };
        }
        // The pack-delete arm: [packId, packId, packId, serverId, serverId,
        // actorId, serverId, actorId].
        if (sql.includes("upload_id IN (SELECT s.upload_id FROM gc_sound_pack_sounds")) {
          if (!sql.includes("r.pack_id <> ?") ||
              !sql.includes("gc_sound_packs p WHERE p.id = ? AND p.server_id = ?")) {
            return { meta: { changes: 0 } };
          }
          const isMod = roster.includes(Number(bound[5])) &&
            Number(bound[5]) === Number(bound[7]) && Number(bound[4]) === Number(bound[6]);
          const pack = packOf(Number(bound[2]));
          if (!pack || pack.server_id !== Number(bound[3]) || !isMod) {
            return { meta: { changes: 0 } };
          }
          let changes = 0;
          for (const clip of clips.filter((c) => c.pack_id === Number(bound[0]))) {
            if (clips.some((c) => c.upload_id === clip.upload_id && c.pack_id !== Number(bound[0]))) continue;
            if (staging.delete(String(clip.upload_id))) changes += 1;
          }
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    },
  ];

  const db = {
    calls,
    roster,
    packs,
    clips,
    staging,
    approvedCount,
    prepare(sql) {
      const route = routes.find((entry) => entry.test(sql));
      const statement = { sql, bound: [] };
      statement.bind = (...values) => {
        statement.bound = values;
        return statement;
      };
      statement.first = async () => {
        calls.push({ sql, bound: statement.bound, call: "first" });
        return route && route.first ? await route.first(statement.bound) : null;
      };
      statement.all = async () => {
        calls.push({ sql, bound: statement.bound, call: "all" });
        return route && route.all ? await route.all(statement.bound) : { results: [] };
      };
      statement.run = async () => {
        calls.push({ sql, bound: statement.bound, call: "run" });
        return route && route.run ? route.run(statement.bound, sql) : { meta: { changes: 1 } };
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      calls.push({
        call: "batch",
        statements: statements.map((statement) => ({ sql: statement.sql, bound: statement.bound })),
      });
      return results;
    },
  };
  return db;
}

function envOf(db) {
  const env = { GOOBER_DB: db };
  for (const binding of Object.values(RATE_LIMIT_BINDINGS)) {
    if (env[binding]) continue;
    env[binding] = { limit: async ({ key }) => ({ success: true, key }) };
  }
  return env;
}

// The list ride's own limiter recorder: the READ bucket's key, pinned.
function envOfRecordingRead(db, seen) {
  const env = envOf(db);
  env.GC_READ_RATE_LIMITER = { limit: async ({ key }) => { seen.push(key); return { success: true, key }; } };
  return env;
}

function authed(method, path, body) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Cookie: "goober_session=" + SESSION_TOKEN,
      "X-CSRF-Token": SESSION_ROW.csrf_token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const mp3Head = (length = 1024) => {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x49; bytes[1] = 0x44; bytes[2] = 0x33; // "ID3" — the MP3 sniff
  return bytes;
};

// --- rows -------------------------------------------------------------------

test("migration 0050 creates the pack tables with explicit FK deletes and the owner-side index", () => {
  const files = readdirSync(new URL("../migrations/", import.meta.url)).sort();
  assert.ok(files.includes("0050_gc_sound_packs.sql"), "the pack migration ships at the floor");
  assert.ok(files.indexOf("0050_gc_sound_packs.sql") > files.indexOf("0045_gc_recreate_attachment_chunks.sql"),
    "the pack migration orders after 0045 (the local floor)");
  const text = readFileSync(new URL("../migrations/0050_gc_sound_packs.sql", import.meta.url), "utf8");
  assert.ok(text.includes("CREATE TABLE IF NOT EXISTS gc_sound_packs"), "the packs table ships");
  assert.ok(text.includes("CREATE TABLE IF NOT EXISTS gc_sound_pack_sounds"), "the pack sounds table ships");
  packTable(text);
  soundsTable(text);
  index(text);

  function packTable(migration) {
    const body = slice(migration, "CREATE TABLE IF NOT EXISTS gc_sound_packs");
    assert.match(body, /REFERENCES gc_servers\(id\) ON DELETE CASCADE/,
      "the pack dies with its server (explicit ON DELETE, no implicit default)");
    assert.match(body, /REFERENCES users\(id\) ON DELETE CASCADE/, "created_by cascades");
    assert.match(body, /UNIQUE\(server_id, name\)/, "pack names are per-server");
  }
  function soundsTable(migration) {
    const body = slice(migration, "CREATE TABLE IF NOT EXISTS gc_sound_pack_sounds");
    assert.match(body, /REFERENCES gc_sound_packs\(id\) ON DELETE CASCADE/,
      "the pack's clips die with the pack (the delete arm's cascade)");
    assert.match(body, /REFERENCES users\(id\) ON DELETE CASCADE/, "added_by cascades");
    assert.match(body, /status TEXT NOT NULL CHECK \(status IN \('candidate', 'approved'\)\)/,
      "the two states are the whole ladder (candidate -> approved)");
    assert.match(body, /CHECK \(size_bytes BETWEEN 1 AND 5242880\)/,
      "the 5MB tier-caps floor rides the DDL (GC_SOUND_PACK_CLIP_MAX_BYTES)");
    assert.match(body, /CHECK \(mime IN \('audio\/mpeg', 'audio\/ogg'\)\)/,
      "the admitted pair mirrors the intake mimes");
  }
  function index(migration) {
    assert.match(migration,
      /CREATE INDEX IF NOT EXISTS idx_gc_sound_packs_server\s+ON gc_sound_packs\(server_id/,
      "the owner side is indexed (the server_id lookup)");
  }
  function slice(migration, marker) {
    return migration.slice(migration.indexOf(marker), migration.indexOf(";", migration.indexOf(marker)));
  }
});

test("pack create rides the mod gate INSIDE the statement: a non-mod's write answers the shared unknown-server 404, never a 403", async () => {
  const source = MODULE_SOURCE();
  assert.ok(source.length > 0, "api/soundpacks.mjs exists to pin");
  assert.match(source, /om\.server_id = \? AND om\.user_id = \? AND om\.role = 'owner'/,
    "the owner EXISTS arm rides the create statement");
  assert.match(source, /holdsRolesBitsSql\(SERVER_PERMISSIONS\.MANAGE_EMOJI\)/,
    "the MANAGE_EMOJI role-bit (1 << 11) EXISTS rides the same statement");
  // Behavior: the mod-gated arms answer changes 0 with the shared 404.
  const db = packDb(); // empty roster: USER_ID is not a mod
  const response = await worker.fetch(authed("POST", `/api/servers/${SERVER_ID}/sound-packs`, { name: "theater" }), envOf(db), {});
  assert.equal(response.status, 404, "a non-mod's write answers zero changes -> shared 404");
  assert.equal(db.packs.size, 0, "no pack row landed behind the refused write");
  const payload = await response.json();
  assert.match(payload.error, /That server does not exist or you are not in it./);
});

test("a mod's create lands the pack; the per-server name collision answers 409", async () => {
  const db = packDb({ roster: [USER_ID] });
  const response = await worker.fetch(authed("POST", `/api/servers/${SERVER_ID}/sound-packs`, { name: "theater" }), envOf(db), {});
  assert.equal(response.status, 201, "the mod's create lands the row");
  assert.ok([...db.packs.values()].some((p) => p.name === "theater"), "the pack persists");
  const again = await worker.fetch(authed("POST", `/api/servers/${SERVER_ID}/sound-packs`, { name: "theater" }), envOf(db), {});
  assert.equal(again.status, 409, "a UNIQUE collision answers the 409, not the 404");
  const bad = await worker.fetch(authed("POST", `/api/servers/${SERVER_ID}/sound-packs`, { name: "b*d name" }), envOf(db), {});
  assert.equal(bad.status, 400, "a name outside the 2-32 grammar answers 400 before any write");
  assert.equal(db.calls.filter((c) => c.call === "run" && c.sql.startsWith("INSERT INTO gc_sound_packs")).length, 2,
    "the bad name never reached a write");
});

test("pack delete rides the same statement gate: a non-mod's delete finds nothing, a mod's delete takes the clips with it", async () => {
  const db = packDb({
    roster: [],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [{ id: CLIP_ID, pack_id: PACK_ID, name: "hello", upload_id: STAGED_ID, status: "approved" }],
  });
  const refused = await worker.fetch(authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}`), envOf(db), {});
  assert.equal(refused.status, 404, "a non-mod's delete answers the shared 404");
  assert.ok(db.packs.has(PACK_ID), "nothing was deleted behind the refused write");
  db.roster.push(USER_ID);
  const modDelete = await worker.fetch(authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}`), envOf(db), {});
  assert.equal(modDelete.status, 200, "the mod's delete runs");
  assert.equal(db.packs.has(PACK_ID), false, "the pack row left");
  assert.equal(db.clips.length, 0, "the pack's clips cascaded away");
});

test("the list ride answers packs with their counts plus the waiting candidates (member read)", async () => {
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [
      { id: CLIP_ID, pack_id: PACK_ID, name: "approved_one", upload_id: STAGED_ID, status: "approved" },
      { id: CLIP_ID + 1, pack_id: PACK_ID, name: "waiting", upload_id: STAGED_ID + "X", status: "candidate" },
    ],
  });
  const response = await worker.fetch(authed("GET", `/api/servers/${SERVER_ID}/sound-packs`), envOf(db), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.packs, [{ id: PACK_ID, name: "theater", sounds: 1 }],
    "the pack row carries its approved count (the studio's counter)");
  assert.deepEqual(payload.candidates, [{ id: CLIP_ID + 1, packId: PACK_ID, name: "waiting" }],
    "the candidates list rides the same payload (id + packId + name, the client's shape)");
});

test("a member posts a clip candidate against the staged bytes: the size, mime, and duplicate arms hold before any write", async () => {
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    staging: [[STAGED_ID, { parts: [mp3Head()] }]],
  });
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { uploadId: STAGED_ID, name: "hello" }),
    envOf(db), {},
  );
  assert.equal(response.status, 201, "the staged clip's candidate row lands");
  assert.equal(db.clips[0].status, "candidate", "candidates wait for review (the defaults law: nothing is auto-approved)");
  assert.equal(db.clips[0].mime, "audio/mpeg", "the sniffed mime rides the row");
  assert.equal(db.clips[0].size_bytes, mp3Head().length, "the staged set's size rides the row");
  // The over-cap arm: the staged set's bytes exceed the 5MB floor.
  const big = mp3Head(C.GC_SOUND_PACK_CLIP_MAX_BYTES + 1);
  const bigDb = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    staging: [[STAGED_ID, { parts: [big] }]],
  });
  const overCap = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { uploadId: STAGED_ID, name: "big" }),
    envOf(bigDb), {},
  );
  assert.equal(overCap.status, 413, "the staged set's over-cap bytes refuse before any write");
  assert.equal(bigDb.clips.length, 0, "no candidate row for an over-cap upload");
  // The unknown-upload arm.
  const missing = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { uploadId: "ZZZZZZZZZZZZ", name: "ghost" }),
    envOf(db), {},
  );
  assert.equal(missing.status, 404, "an unstaged upload answers the staging lane's 404");
});

test("a clip cannot be born on staging bytes a sweep removed mid-window — the in-SQL staging arm refuses", async () => {
  const source = MODULE_SOURCE();
  assert.match(
    source,
    /AND EXISTS \(SELECT 1 FROM gc_upload_parts u WHERE u\.upload_id = \? AND u\.uploader_id = \?\)/,
    "the candidate INSERT carries the staged-bytes arm (no verify-to-insert sweep race mints a clip)",
  );
  // The verify-to-insert window: the spread/head reads answer the staged set,
  // then the swept bytes are gone by INSERT time (the encoded arm's refusal).
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    staging: [[STAGED_ID, { parts: [mp3Head()] }]],
    vanishAtInsert: [STAGED_ID],
  });
  const response = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { uploadId: STAGED_ID, name: "hello" }),
    envOf(db), {},
  );
  assert.equal(response.status, 404, "the raced insert answers changes 0 → the shared 404");
  assert.equal(db.clips.length, 0, "no row for the swept bytes");
});

test("approve commits a candidate through the statement gate only, under the resolver's slots cap", async () => {
  const db = packDb({
    roster: [],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [{ id: CLIP_ID, pack_id: PACK_ID, name: "hello", upload_id: STAGED_ID, status: "candidate" }],
  });
  const refused = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { clipId: CLIP_ID }),
    envOf(db), {},
  );
  assert.equal(refused.status, 404, "a non-mod's approve answers the shared 404");
  assert.equal(db.clips[0].status, "candidate", "nothing flipped behind the refused approve");
  db.roster.push(USER_ID);
  const capDb = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [{ id: CLIP_ID, pack_id: PACK_ID, name: "hello", upload_id: STAGED_ID, status: "candidate" }],
  });
  for (let i = 0; i < C.GC_SOUNDBOARD_MAX_PER_SERVER; i++) {
    capDb.clips.push({ id: 7000 + i, pack_id: PACK_ID, name: "filler" + i, upload_id: "FILLER" + i, status: "approved" });
  }
  const capped = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { clipId: CLIP_ID }),
    envOf(capDb), {},
  );
  assert.equal(capped.status, 400, "the slots cap arm refuses the pack's next approve");
  assert.equal(capDb.clips.find((c) => c.id === CLIP_ID).status, "candidate",
    "a capped pack approves nothing");
  const modDb = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [{ id: CLIP_ID, pack_id: PACK_ID, name: "hello", upload_id: STAGED_ID, status: "candidate" }],
  });
  const approve = await worker.fetch(
    authed("POST", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips`, { clipId: CLIP_ID }),
    envOf(modDb), {},
  );
  assert.equal(approve.status, 200, "the mod's approve flips the row");
  assert.equal(modDb.clips.find((c) => c.id === CLIP_ID).status, "approved",
    "the candidate crossed to approved (the ONLY path from candidate to the pack)");
});

test("the drop arm takes candidates only: an approved clip refuses through the statement's status arm", async () => {
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [
      { id: CLIP_ID, pack_id: PACK_ID, name: "waiting", upload_id: STAGED_ID, status: "candidate" },
      { id: CLIP_ID + 1, pack_id: PACK_ID, name: "kept", upload_id: STAGED_ID + "X", status: "approved" },
    ],
  });
  const dropped = await worker.fetch(
    authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips/${CLIP_ID}`),
    envOf(db), {},
  );
  assert.equal(dropped.status, 200, "the mod's drop runs");
  assert.equal(db.clips.length, 1, "the candidate row left");
  const kept = await worker.fetch(
    authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips/${CLIP_ID + 1}`),
    envOf(db), {},
  );
  assert.equal(kept.status, 400, "an approved clip is not a candidate — the status arm refuses");
  assert.equal(db.clips.length, 1, "the approved clip stayed");
});

test("the drop takes the candidate's staged bytes with it, unless another pack's clip still references the token", async () => {
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [
      { id: CLIP_ID, pack_id: PACK_ID, name: "waiting", upload_id: STAGED_ID, status: "candidate", added_by: USER_ID },
    ],
    staging: [[STAGED_ID, { parts: [mp3Head()] }]],
  });
  const dropped = await worker.fetch(
    authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips/${CLIP_ID}`),
    envOf(db), {},
  );
  assert.equal(dropped.status, 200);
  assert.equal(db.staging.has(STAGED_ID), false,
    "a dropped candidate's bytes leave the staging table with the row");

  const shared = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [
      { id: CLIP_ID, pack_id: PACK_ID, name: "waiting", upload_id: STAGED_ID, status: "candidate", added_by: USER_ID },
      { id: CLIP_ID + 1, pack_id: PACK_ID + 1, name: "other", upload_id: STAGED_ID, status: "candidate", added_by: USER_ID },
    ],
    staging: [[STAGED_ID, { parts: [mp3Head()] }]],
  });
  const sharedDrop = await worker.fetch(
    authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}/clips/${CLIP_ID}`),
    envOf(shared), {},
  );
  assert.equal(sharedDrop.status, 200);
  assert.equal(shared.staging.has(STAGED_ID), true,
    "a token another pack's clip still references is never cleared");
});

test("pack delete takes its clips' staged bytes with it, and a non-mod's delete never touches the bytes", async () => {
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [
      { id: CLIP_ID, pack_id: PACK_ID, name: "kept", upload_id: STAGED_ID, status: "approved", added_by: USER_ID },
      { id: CLIP_ID + 1, pack_id: PACK_ID, name: "waiting", upload_id: STAGED_ID + "X", status: "candidate", added_by: USER_ID },
    ],
    staging: [[STAGED_ID, { parts: [mp3Head()] }], [STAGED_ID + "X", { parts: [mp3Head(128)] }]],
  });
  const outsider = packDb({
    roster: [],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
    clips: [{ id: CLIP_ID, pack_id: PACK_ID, name: "kept", upload_id: STAGED_ID, status: "approved", added_by: USER_ID }],
    staging: [[STAGED_ID, { parts: [mp3Head()] }]],
  });
  const refused = await worker.fetch(
    authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}`),
    envOf(outsider), {},
  );
  assert.equal(refused.status, 404, "a non-mod's pack delete answers the shared 404");
  assert.equal(outsider.staging.has(STAGED_ID), true, "a refused pack delete never touches the bytes");

  const deleted = await worker.fetch(
    authed("DELETE", `/api/servers/${SERVER_ID}/sound-packs/${PACK_ID}`),
    envOf(db), {},
  );
  assert.equal(deleted.status, 200);
  assert.equal(db.packs.size, 0, "the pack row left");
  assert.equal(db.staging.has(STAGED_ID), false, "the pack's approved clip's bytes cleared");
  assert.equal(db.staging.has(STAGED_ID + "X"), false, "the pack's candidate's bytes cleared");
});

test("the list ride carries the READ bucket's rate limit", async () => {
  const db = packDb({
    roster: [USER_ID],
    packs: [[PACK_ID, { server_id: SERVER_ID, name: "theater" }]],
  });
  const seen = [];
  const response = await worker.fetch(
    authed("GET", `/api/servers/${SERVER_ID}/sound-packs`),
    envOfRecordingRead(db, seen), {},
  );
  assert.equal(response.status, 200);
  // The limiter's wire key is the scope:actor pair, hashed (coins-module's
  // mirror): the list's per-user identity rides the read bucket beside the
  // worker's global per-IP read gate.
  assert.ok(seen.includes(await sha256Hex("read:sound-packs:" + USER_ID)),
    "the list ride limits on the read bucket, per user");
});
