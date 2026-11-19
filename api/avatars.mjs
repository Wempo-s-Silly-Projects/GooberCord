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
import { GC_AVATAR_OBJECT_PREFIX } from "../constants.mjs";

// R2-first serving (the shared wempos-forum-r2 bucket, binding GC_MEDIA): the
// forum's avatar lifecycle already writes approved bytes at avatars/<id> (all
// 26 users byte-verified 2026-11-18), so this route answers the same object
// first and keeps the D1 avatar_data column as the serving fallback — a row
// whose object has not landed (or whose bytes the verifier cannot bless)
// serves exactly as before. The pending lane stays D1-only here: pending
// bytes are this route's read of the shared table's pending columns, gated to
// the owner plus staff and uncacheable. Nothing in this module ever writes
// the users columns — the lifecycle stays forum-side.
async function serveAvatarObject(env, userId, row) {
  if (!env.GC_MEDIA) return null;
  let object = null;
  try {
    object = await env.GC_MEDIA.get(GC_AVATAR_OBJECT_PREFIX + userId);
  } catch {
    return null;
  }
  if (!object || typeof object.arrayBuffer !== "function") return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length === 0) return null;
  return imageResponse(bytes, row.avatar_mime, "public, max-age=3600");
}

export async function handleAvatarRoutes(request, env, url, path, method) {
  const avatarMatch = path.match(/^\/api\/avatars\/([0-9]+)$/);
  if (!avatarMatch) return null;
  const db = env.GOOBER_DB;
  if (method !== "GET") throw new HttpError(405, "That method is not supported.");
  const userId = Number(avatarMatch[1]);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new HttpError(404, "Picture not found.");
  const row = await db.prepare(
    "SELECT avatar_status, avatar_mime, avatar_data, pending_avatar_mime, pending_avatar_data FROM users WHERE id = ? LIMIT 1",
  ).bind(userId).first();
  if (!row) throw new HttpError(404, "Picture not found.");

  if (row.pending_avatar_mime && row.pending_avatar_data) {
    const session = await readSession(request, env);
    const viewer = session && session.user;
    const isStaff = viewer && (viewer.role === "owner" || viewer.role === "admin");
    if (viewer && (viewer.id === userId || isStaff)) {
      const response = imageResponse(blobToUint8Array(row.pending_avatar_data), row.pending_avatar_mime, "no-store");
      if (response) return response;
    }
  }

  if (row.avatar_mime) {
    const mirrored = await serveAvatarObject(env, userId, row);
    if (mirrored) return mirrored;
  }
  if (row.avatar_mime && row.avatar_data) {
    const response = imageResponse(blobToUint8Array(row.avatar_data), row.avatar_mime, "public, max-age=3600");
    if (response) return response;
  }

  throw new HttpError(404, "Picture not found.");
}
