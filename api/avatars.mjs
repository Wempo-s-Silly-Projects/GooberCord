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

// Avatar serving, ported from the forum's api/avatars.mjs (the owner-facing
// 404: every GC session payload and roster already ships
// "/api/avatars/<user id>?v=<avatar_version>" — the shared users table's
// approved avatar — but GC's worker never served the URL). Read-only here:
// the lifecycle stays forum-side (upload + limits + the moderation queue, in
// wempos-forum), while GC serves the same shared rows it already names.
// Approved avatars serve to anyone with public cache headers; a pending
// upload's bytes stay visible only to the account owner and staff —
// uncacheable — while everyone else gets the approved avatar or 404. The
// session is only consulted when a pending set exists, so guest 404s never
// read sessions.
import { readSession } from "./core/auth.mjs";
import { HttpError } from "./core/http.mjs";
import { blobToUint8Array, imageResponse } from "./core/images.mjs";

// The avatar object store flip (the T-R2 wave; owner's 2026-11-18 "just
// migrate everything to r2"): the serving READ path consults the GC_MEDIA
// binding BEFORE any D1 byte read — the T100 attachment serving idiom, byte
// for byte posture. Keys are DERIVED (the id join key every consumer
// already holds, no column added): approved bytes at avatars/<users.id>,
// a pending re-upload's candidate at avatars/pending/<users.id>. D1 stays
// the authority and the fallback: a get miss (absent binding, absent
// object, failed read) rides the proven *_avatar_data columns verbatim.
// The lifecycle stays forum-side — the intake PUT and the approve/reject
// cleanup are wempos-forum lanes; GC's seat is this READ path.
export const AVATAR_OBJECT_PREFIX = "avatars/";

export function avatarObjectKey(userId) {
  return AVATAR_OBJECT_PREFIX + Number(userId);
}

export function pendingAvatarObjectKey(userId) {
  return AVATAR_OBJECT_PREFIX + "pending/" + Number(userId);
}

function r2MissLog(op, userId, error) {
  console.error(op + " missed for avatar " + userId + ":", String((error && error.message) || error));
}

// The R2 read: a hit resolves the bytes; a miss — absent object, failed
// read, failed drain — returns null and rides the D1 fallback. Nothing
// here serves best-guess.
async function r2AvatarBytes(bucket, userId, key) {
  let object;
  try {
    object = await bucket.get(key);
  } catch (error) {
    r2MissLog("GC_MEDIA.get", userId, error);
    return null;
  }
  if (!object || !object.body) return null;
  try {
    return blobToUint8Array(await new Response(object.body).arrayBuffer());
  } catch (error) {
    r2MissLog("GC_MEDIA.get", userId, error);
    return null;
  }
}

// The D1 fallback read: one column, one row — the bytes leave users only if
// a later owner-gated step ever removes them (users is an auth table; this
// seat never writes it).
async function d1AvatarBytes(env, userId, column) {
  const row = await env.GOOBER_DB.prepare(
    "SELECT " + column + " AS data FROM users WHERE id = ? LIMIT 1",
  ).bind(userId).first();
  return row && row.data ? blobToUint8Array(row.data) : null;
}

export async function handleAvatarRoutes(request, env, url, path, method) {
  const avatarMatch = path.match(/^\/api\/avatars\/([0-9]+)$/);
  if (!avatarMatch) return null;
  const db = env.GOOBER_DB;
  if (method !== "GET") throw new HttpError(405, "That method is not supported.");
  const userId = Number(avatarMatch[1]);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new HttpError(404, "Picture not found.");
  const bucket = env.GC_MEDIA;
  const row = await db.prepare(
    "SELECT avatar_status, avatar_mime, pending_avatar_mime FROM users WHERE id = ? LIMIT 1",
  ).bind(userId).first();
  if (!row) throw new HttpError(404, "Picture not found.");

  if (row.pending_avatar_mime) {
    const session = await readSession(request, env);
    const viewer = session && session.user;
    const isStaff = viewer && (viewer.role === "owner" || viewer.role === "admin");
    if (viewer && (viewer.id === userId || isStaff)) {
      let pendingBytes = null;
      if (bucket) pendingBytes = await r2AvatarBytes(bucket, userId, pendingAvatarObjectKey(userId));
      if (!pendingBytes) pendingBytes = await d1AvatarBytes(env, userId, "pending_avatar_data");
      if (pendingBytes) {
        const response = imageResponse(pendingBytes, row.pending_avatar_mime, "no-store");
        if (response) return response;
      }
    }
  }

  if (row.avatar_mime) {
    let bytes = null;
    if (bucket) bytes = await r2AvatarBytes(bucket, userId, avatarObjectKey(userId));
    if (!bytes) bytes = await d1AvatarBytes(env, userId, "avatar_data");
    if (bytes) {
      const response = imageResponse(bytes, row.avatar_mime, "public, max-age=3600");
      if (response) return response;
    }
  }

  throw new HttpError(404, "Picture not found.");
}
