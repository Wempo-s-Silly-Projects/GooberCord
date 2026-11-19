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

// Avatar serving on GC (the owner-facing 404): api/avatars.mjs serves the
// shared users table's avatar rows — the same rows every GC session payload
// and roster already names as "/api/avatars/<id>?v=<version>" — with the
// forum's exact visibility contract: approved bytes serve to anyone with
// public cache headers, a pending re-upload's bytes stay pending-only (its
// uploader plus staff, no-store), and everyone else 404s. Real SQLite
// fixtures (the route's decisions are byte-for-byte reads), the real
// readSession (session shapes decide the pending lane), and a worker chain
// pin.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleAvatarRoutes } from "../api/avatars.mjs";
import { randomToken, sha256Hex, nowSeconds } from "../api/core/crypto.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

// Bytes that sniff as PNG (magic signature + length past the 12-byte floor).
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
]);

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      bio TEXT NOT NULL DEFAULT '',
      avatar_status TEXT,
      avatar_mime TEXT,
      avatar_data BLOB,
      pending_avatar_mime TEXT,
      pending_avatar_data BLOB,
      avatar_updated_at INTEGER,
      avatar_version TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      csrf_token TEXT,
      expires_at INTEGER NOT NULL);
  `);
  db.prepare(
    "INSERT INTO users (id, username, role, avatar_status, avatar_mime, avatar_data, avatar_updated_at, avatar_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(7, "approved", "member", "approved", "image/png", PNG_BYTES, 1000, 99);

  db.prepare(
    "INSERT INTO users (id, username, role, avatar_status, pending_avatar_mime, pending_avatar_data, avatar_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(8, "pendingonly", "member", "pending", "image/png", PNG_BYTES, 501);

  db.prepare(
    "INSERT INTO users (id, username, role, avatar_status, avatar_mime, avatar_data, pending_avatar_mime, pending_avatar_data, avatar_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(9, "reupload", "member", "pending", "image/png", PNG_BYTES, "image/png", PNG_BYTES, 602);

  const addSession = async (userId, role) => {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    if (role !== undefined) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
    }
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
    ).run(tokenHash, userId, "csrf", nowSeconds() + 3600);
    return token;
  };
  return { db, addSession };
}

// A D1-shaped adapter over the real SQLite fixture: the route (and the real
// readSession inside it) speak prepare().bind().first() — D1's chain — while
// the fixture engine is node:sqlite, which binds positionally.
function d1(db) {
  return {
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        bind: (...args) => ({
          first: async () => stmt.get(...args) ?? null,
          all: async () => stmt.all(...args),
          run: async () => stmt.run(...args),
        }),
      };
    },
  };
}

async function serve(env, path, headers = {}) {
  // The worker hands the handler a path WITHOUT the query (the ?v= cache
  // buster rides url.searchParams only the way every GC route's path does).
  const routePath = path.split("?")[0];
  return handleAvatarRoutes(
    new Request(ORIGIN + path, { headers }),
    env,
    new URL(ORIGIN + path),
    routePath,
    "GET",
  );
}

test("the worker chain carries the route", () => {
  const source = readFileSync(path.join(HERE, "..", "worker.mjs"), "utf8");
  assert.match(source, /import \{ handleAvatarRoutes \} from "\.\/api\/avatars\.mjs";/);
  assert.match(source, /handleAvatarRoutes,/);
});

test("an unknown user answers the 404 without ever reading a session", async () => {
  const { db } = fixture();
  let caught = null;
  try {
    await serve({ GOOBER_DB: d1(db) }, "/api/avatars/999");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "the route answers with a thrown 404");
  assert.equal(caught.status, 404);
  assert.equal(caught.message, "Picture not found.");
  const rows = db.prepare("SELECT COUNT(*) AS c FROM sessions").get();
  assert.equal(Number(rows.c), 0);
});

test("an approved avatar serves to anyone, cached, with the defensive headers", async () => {
  const { db } = fixture();
  const env = { GOOBER_DB: d1(db) };
  for (const suffix of ["", "?v=99"]) {
    const response = await serve(env, "/api/avatars/7" + suffix);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=3600");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="image"');
    assert.equal(Number(response.headers.get("Content-Length")), PNG_BYTES.length);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
  }
});

test("a pending-only avatar serves to its owner and to staff, no-store; others 404", async () => {
  const { db, addSession } = fixture();
  const ownerToken = await addSession(8);
  const staffToken = await addSession(7, "owner");
  const env = { GOOBER_DB: d1(db) };

  await assert.rejects(
    () => serve(env, "/api/avatars/8"),
    (error) => error.status === 404,
    "a guest never sees a pending upload",
  );

  const owner = await serve(env, "/api/avatars/8", { Cookie: "goober_session=" + ownerToken });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get("Cache-Control"), "no-store");

  const staff = await serve(env, "/api/avatars/8", { Cookie: "goober_session=" + staffToken });
  assert.equal(staff.status, 200);
  assert.equal(staff.headers.get("Cache-Control"), "no-store");

  // A member who is neither the owner nor staff — even signed in — 404s.
  const otherToken = await addSession(9);
  await assert.rejects(
    () => serve(env, "/api/avatars/8", { Cookie: "goober_session=" + otherToken }),
    (error) => error.status === 404,
  );
});

test("a re-upload over an approved avatar serves the approved bytes publicly", async () => {
  const { db, addSession } = fixture();
  const env = { GOOBER_DB: d1(db) };
  const guest = await serve(env, "/api/avatars/9?v=602");
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get("Cache-Control"), "public, max-age=3600", "the approved layer, not the pending bytes");

  // The uploader themselves still lands on the pending candidate over the
  // approved one (the candidate is what reviews must see).
  const meToken = await addSession(9);
  const me = await serve(env, "/api/avatars/9", { Cookie: "goober_session=" + meToken });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("Cache-Control"), "no-store");
});

test("non-avatar paths fall through and mutations are refused", async () => {
  const { db } = fixture();
  const env = { GOOBER_DB: d1(db) };
  assert.equal(await serve(env, "/api/avatars/abc"), null, "an unparsable id is not this route's match");
  assert.equal(await serve(env, "/api/avatars"), null);
  const request = new Request(ORIGIN + "/api/avatars/7", { method: "DELETE" });
  await assert.rejects(
    () => handleAvatarRoutes(request, env, new URL(ORIGIN + "/api/avatars/7"), "/api/avatars/7", "DELETE"),
    (error) => error.status === 405,
  );
});
