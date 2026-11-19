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

// Soundboard Studio's pack routes (T85's backend half, migration 0050):
// /api/servers/:id/sound-packs[...] — the CRUD the DEPLOYED client
// (public/js/ui/soundboard-studio.js) consults: list, create, delete, and
// the candidate arms approve/drop.
//
// THE GATE IS THE STATEMENT (api/jobs.mjs's JOBS_TOGGLE_UPSERT_SQL
// precedent): every mod-arm write carries its manage guard INSIDE the SQL —
// owner OR the gc_roles MANAGE_EMOJI bit, the soundboard lane's exact guard
// fragments re-mirrored here (that module keeps them local by design note; a
// guard change must be re-mirrored). A non-mod's write answers changes 0 and
// is classified to the shared unknown-server 404 — NEVER a 403 existence
// oracle. The candidate create is the MEMBER arm (any member posts a clip
// for review): its guard is membership + the pack's server, same statement
// encoding, same 404 classification.
//
// THE CLIP CAP IS THE CONSTANTS SEAT (GC_SOUND_PACK_CLIP_MAX_BYTES — never
// redeclared; the 5 MB tier-caps floor, GC-beyond-parity: the PARITY board's
// 512KB gc_sounds row and the GC_SOUNDBOARD_* constants stay untouched).
// Candidates reference the STAGING lane verbatim (0025's gc_upload_parts by
// client-held upload id) — the bytes are already staged when the candidate
// is created, and the lifecycle arms keep the bytes aligned with the rows
// (GO-HAYWIRE cycle-3): a dropped candidate and a deleted pack clear their
// tokens' staging bytes server-side (never a token another clip still
// references), and the staging abandon route REFUSES while any clip points
// at the token — an approved clip's bytes survive any uploader abandon.
// Nothing adopts/rewrites the staging id: the gc_upload_parts row keeps its
// free-form token and the clip IS the reference.
//
// THE SLOTS CAP IS THE SHARED RESOLVER: the mod's approve commits a
// candidate through one statement whose cap arm counts the pack's APPROVED
// rows against serverBoostTier().caps.soundboard (GC_SOUNDBOARD_MAX_PER_SERVER
// through api/boost-level.mjs) — the pack's sounds-vs-slots shape the spec's
// pack display names. No bulk approval, no auto-anything (the defaults law).
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { sniffAudioMime } from "./core/audio.mjs";
import { UPLOAD_UNKNOWN_ERROR } from "./uploads.mjs";
import {
  GC_SOUND_INTAKE_MIMES,
  GC_SOUND_NAME_MAX,
  GC_SOUND_NAME_MIN,
  GC_SOUND_NAME_PATTERN,
  GC_SOUND_PACK_CLIP_MAX_BYTES,
  GC_EXPRESSION_ID_CEILING,
} from "../constants.mjs";
import {
  SERVER_PERMISSIONS,
  holdsRolesBitsParams,
  holdsRolesBitsSql,
} from "./permissions.mjs";
import { serverBoostTier } from "./boost-level.mjs";

// The manage-guard fragments mirror the soundboard lane's exact copies (a
// guard change must be re-mirrored and the parity tests pin BOTH copies).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

const MANAGE_GUARD_SQL =
  "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_EMOJI) + ")";

function manageGuardParams(serverId, actorId) {
  // The owner arm's pair, then the role-bit arm's pair (the guard fragment's
  // bind order, the soundboard lane's manageGuard shape).
  return [serverId, actorId, ...holdsRolesBitsParams(serverId, actorId, SERVER_PERMISSIONS.MANAGE_EMOJI)];
}

const NAME_ERROR =
  "Use a " + GC_SOUND_NAME_MIN + "-" + GC_SOUND_NAME_MAX +
  " character name of letters, numbers and underscores.";

function validName(value) {
  if (typeof value !== "string" || !GC_SOUND_NAME_PATTERN.test(value)) {
    throw new HttpError(400, NAME_ERROR);
  }
  return value;
}

function validId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id >= GC_EXPRESSION_ID_CEILING) {
    throw new HttpError(400, "That id is invalid.");
  }
  return id;
}

const STAGED_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const OVER_CAP_ERROR = "That clip is over the 5 MB pack cap.";
const ONLY_CLIPS_ERROR = "Only MP3 and OGG clips are accepted.";
const UNKNOWN_SERVER_404 = "That server does not exist or you are not in it.";

// The read-tier membership gate (no membership → the shared 404, never an
// existence oracle).
async function memberGate(env, serverId, userId) {
  const exists = await env.GOOBER_DB.prepare(
    "SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  if (!exists) throw new HttpError(404, UNKNOWN_SERVER_404);
}

// --- the statements (the guards ride INSIDE the SQL) ---------------------------

const PACK_INSERT_SQL =
  "INSERT INTO gc_sound_packs (server_id, name, created_by, created_at) " +
    "SELECT ?, ?, ?, ? WHERE " + MANAGE_GUARD_SQL;

const PACK_DELETE_SQL =
  "DELETE FROM gc_sound_packs WHERE id = ? AND server_id = ? AND " + MANAGE_GUARD_SQL;

const CLIP_INSERT_SQL =
  "INSERT INTO gc_sound_pack_sounds (pack_id, name, upload_id, size_bytes, mime, status, added_by, created_at) " +
    "SELECT ?, ?, ?, ?, ?, 'candidate', ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM gc_sound_packs p WHERE p.id = ? AND p.server_id = ?) " +
    "AND EXISTS (SELECT 1 FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE pack_id = ? AND upload_id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds WHERE pack_id = ? AND name = ?)";

const CLIP_APPROVE_SQL =
  "UPDATE gc_sound_pack_sounds SET status = 'approved' " +
    "WHERE id = ? AND pack_id = ? AND status = 'candidate' " +
    "AND EXISTS (SELECT 1 FROM gc_sound_packs p WHERE p.id = ? AND p.server_id = ?) AND " +
    MANAGE_GUARD_SQL + " " +
    "AND (SELECT COUNT(*) FROM gc_sound_pack_sounds WHERE pack_id = ? AND status = 'approved') < ";

const CLIP_DROP_SQL =
  "DELETE FROM gc_sound_pack_sounds WHERE id = ? AND pack_id = ? AND status = 'candidate' " +
    "AND EXISTS (SELECT 1 FROM gc_sound_packs p WHERE p.id = ? AND p.server_id = ?) AND " +
    MANAGE_GUARD_SQL;

// The drop's staging clear (GO-HAYWIRE cycle-3): the dying candidate's token
// bytes leave gc_upload_parts IN THE SAME BATCH — but only when NO other
// clip (r.id <> the dying one) still references the token, only from the
// candidate's own uploader_id, with the SAME manage guard + pack-in-server
// arm as the row delete riding the statement (a non-mod's refusal never
// touches the bytes).
const CLIP_DROP_CLEAR_SQL =
  "DELETE FROM gc_upload_parts WHERE upload_id = " +
    "(SELECT s.upload_id FROM gc_sound_pack_sounds s WHERE s.id = ? AND s.pack_id = ? AND s.status = 'candidate') " +
    "AND uploader_id = (SELECT s2.added_by FROM gc_sound_pack_sounds s2 WHERE s2.id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds r WHERE r.upload_id = gc_upload_parts.upload_id AND r.id <> ?) " +
    "AND EXISTS (SELECT 1 FROM gc_sound_packs p WHERE p.id = ? AND p.server_id = ?) AND " +
    MANAGE_GUARD_SQL;

// The pack delete's staging clear (same law, pack-scoped): every token the
// pack's clips point at leaves the staging table with the pack, but only
// tokens NO OTHER pack's clip still references (r.pack_id <> the dying one).
// It rides BEFORE the pack's guarded DELETE in the batch — the dying
// cascade's rows are still readable for the clear's arms.
const PACK_DELETE_CLEAR_SQL =
  "DELETE FROM gc_upload_parts WHERE upload_id IN " +
    "(SELECT s.upload_id FROM gc_sound_pack_sounds s WHERE s.pack_id = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM gc_sound_pack_sounds r WHERE r.upload_id = gc_upload_parts.upload_id AND r.pack_id <> ?) " +
    "AND EXISTS (SELECT 1 FROM gc_sound_packs p WHERE p.id = ? AND p.server_id = ?) AND " +
    MANAGE_GUARD_SQL;

const PACK_LIST_SQL =
  "SELECT p.id, p.name, p.created_at, " +
    "(SELECT COUNT(*) FROM gc_sound_pack_sounds ps WHERE ps.pack_id = p.id AND ps.status = 'approved') AS sounds " +
    "FROM gc_sound_packs p WHERE p.server_id = ? ORDER BY p.created_at, p.id";

const CANDIDATE_LIST_SQL =
  "SELECT ps.id, ps.pack_id, ps.name FROM gc_sound_pack_sounds ps " +
    "JOIN gc_sound_packs p ON p.id = ps.pack_id " +
    "WHERE p.server_id = ? AND ps.status = 'candidate' ORDER BY ps.created_at, ps.id";

const CLIP_STATE_SQL =
  "SELECT ps.id, ps.status, ps.pack_id, p.server_id FROM gc_sound_pack_sounds ps " +
    "JOIN gc_sound_packs p ON p.id = ps.pack_id WHERE ps.id = ? LIMIT 1";

// The staged set's own spread read (0025 lane shapes: count + byte sum, then
// the head chunk's bytes for the sniff).
const STAGED_SPREAD_SQL =
  "SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS size " +
    "FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ?";
const STAGED_HEAD_SQL =
  "SELECT data FROM gc_upload_parts WHERE upload_id = ? AND uploader_id = ? AND seq = 0";

// --- routes ---------------------------------------------------------------------

async function handleListPacksRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  // The READ bucket mirrors the write arms' key (GO-HAYWIRE cycle-3: the
  // packs+candidates ride was the one un-limited route on the block).
  await rateLimit(request, env, "read", "sound-packs:" + session.user.id);
  const serverIdNum = Number(serverId);
  await memberGate(env, serverIdNum, Number(session.user.id));
  const packs = await env.GOOBER_DB.prepare(PACK_LIST_SQL).bind(serverIdNum).all();
  const candidates = await env.GOOBER_DB.prepare(CANDIDATE_LIST_SQL).bind(serverIdNum).all();
  return json({
    packs: (packs.results || []).map((row) => ({
      id: row.id, name: row.name, sounds: Number(row.sounds),
    })),
    candidates: (candidates.results || []).map((row) => ({
      id: row.id, packId: row.pack_id, name: row.name,
    })),
  });
}

async function handleCreatePackRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundpacks:" + session.user.id);
  const serverIdNum = Number(serverId);
  const body = await readJson(request);
  const name = validName(body.name);
  const actorId = Number(session.user.id);
  try {
    const result = await env.GOOBER_DB.prepare(PACK_INSERT_SQL).bind(
      serverIdNum, name, actorId, nowSeconds(),
      // The statement's guard seats: owner arm (server, actor), then the
      // role-bit arm's pair — the fakeDb pins both.
      ...manageGuardParams(serverIdNum, actorId),
    ).run();
    if (Number(result?.meta?.changes) !== 1) {
      // The jobs-prec classification: zero changes IS the shared
      // unknown-server 404 — a non-mod's write and a foreign server answer
      // the same wire, never a 403 oracle.
      throw new HttpError(404, UNKNOWN_SERVER_404);
    }
  } catch (error) {
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(error))) {
      throw new HttpError(409, "That pack name is already taken in this server.");
    }
    throw error;
  }
  return json({ pack: { id: Number((await env.GOOBER_DB.prepare(
    "SELECT id FROM gc_sound_packs WHERE server_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
  ).bind(serverIdNum, name).first())?.id), name, sounds: 0 } }, 201);
}

async function handleDeletePackRoute(request, env, serverId, packId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundpacks:" + session.user.id);
  const serverIdNum = Number(serverId);
  const packIdNum = validId(packId);
  const actorId = Number(session.user.id);
  // ONE atomic batch: the staging clear runs FIRST (the dying cascade's clip
  // rows are still readable), the pack's guarded delete follows — the same
  // transaction, so a refused guard leaves bytes AND rows exactly as they
  // were.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(PACK_DELETE_CLEAR_SQL).bind(
      packIdNum, packIdNum, packIdNum, serverIdNum, ...manageGuardParams(serverIdNum, actorId),
    ),
    env.GOOBER_DB.prepare(PACK_DELETE_SQL).bind(
      packIdNum, serverIdNum, ...manageGuardParams(serverIdNum, actorId),
    ),
  ]);
  if (Number(results[1]?.meta?.changes) !== 1) {
    throw new HttpError(404, UNKNOWN_SERVER_404);
  }
  return json({ ok: true });
}

// The staged clip read: the candidate's bytes are already staged (0025) —
// the route verifies the set's spread + head, then rides the guarded INSERT.
async function verifyStagedClip(env, uploadId, actorId) {
  const spread = await env.GOOBER_DB.prepare(STAGED_SPREAD_SQL)
    .bind(uploadId, actorId).first();
  if (!spread || Number(spread.n) < 1) throw new HttpError(404, UPLOAD_UNKNOWN_ERROR);
  const size = Number(spread.size);
  if (size > GC_SOUND_PACK_CLIP_MAX_BYTES) throw new HttpError(413, OVER_CAP_ERROR);
  const head = await env.GOOBER_DB.prepare(STAGED_HEAD_SQL)
    .bind(uploadId, actorId).first();
  const mime = sniffAudioMime(head?.data instanceof Uint8Array ? head.data : new Uint8Array(0));
  if (!mime || !GC_SOUND_INTAKE_MIMES.includes(mime)) {
    throw new HttpError(400, ONLY_CLIPS_ERROR);
  }
  return { size, mime };
}

// POST /:packId/clips — TWO arms by body shape (the deployed client's
// contract): { clipId } is the MOD's approve; { uploadId, name } is the
// MEMBER's candidate create. Both are statement-guarded writes.
async function handleCreateClipRoute(request, env, serverId, packId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundpacks:" + session.user.id);
  const serverIdNum = Number(serverId);
  const packIdNum = validId(packId);
  const actorId = Number(session.user.id);
  const body = await readJson(request);
  if (body.clipId !== undefined && body.clipId !== null) {
    return handleApproveClipArm(env, {
      serverIdNum, packIdNum, actorId, clipId: validId(body.clipId),
    });
  }
  return handleCandidateCreateArm(env, {
    serverIdNum, packIdNum, actorId, uploadId: body.uploadId, bodyName: body.name,
  });
}

async function handleApproveClipArm(env, context) {
  const { serverIdNum, packIdNum, actorId, clipId } = context;
  const guardParams = manageGuardParams(serverIdNum, actorId);
  const cap = (await serverBoostTier(env, serverIdNum)).caps.soundboard;
  const result = await env.GOOBER_DB.prepare(
    CLIP_APPROVE_SQL + cap,
  ).bind(
    clipId, packIdNum,
    packIdNum, serverIdNum,
    ...guardParams,
    packIdNum,
  ).run();
  if (Number(result?.meta?.changes) !== 1) {
    // The failing-arm classification (the soundboard lane's arm order): the
    // cap question answers first (count vs the resolver answer); a
    // candidate clip that is neither capped nor refused by state stays the
    // shared 404 — the mod gate is the statement's, and its refusal is the
    // same wire as a missing clip (never a 403 oracle).
    const state = await env.GOOBER_DB.prepare(CLIP_STATE_SQL).bind(clipId).first();
    if (state && Number(state.pack_id) === packIdNum && Number(state.server_id) === serverIdNum) {
      if (state.status !== "candidate") {
        throw new HttpError(400, "That clip is not waiting for review.");
      }
      const count = await env.GOOBER_DB.prepare(
        "SELECT COUNT(*) AS n FROM gc_sound_pack_sounds WHERE pack_id = ? AND status = 'approved'",
      ).bind(packIdNum).first();
      if (Number(count?.n) >= cap) {
        throw new HttpError(400, "This pack's approved sounds already fill the server's " + cap + "-slot limit.");
      }
    }
    throw new HttpError(404, UNKNOWN_SERVER_404);
  }
  return json({ clip: { id: clipId, packId: packIdNum, status: "approved" } });
}

async function handleCandidateCreateArm(env, context) {
  const { serverIdNum, packIdNum, actorId, uploadId } = context;
  if (typeof uploadId !== "string" || !STAGED_ID_RE.test(uploadId)) {
    throw new HttpError(400, "Reference one of your staged clips.");
  }
  const name = validName(context.bodyName);
  const staged = await verifyStagedClip(env, uploadId, actorId);
  try {
    const result = await env.GOOBER_DB.prepare(CLIP_INSERT_SQL).bind(
      packIdNum, name, uploadId, staged.size, staged.mime, actorId, nowSeconds(),
      packIdNum, serverIdNum,
      serverIdNum, actorId,
      packIdNum, uploadId,
      packIdNum, name,
    ).run();
    if (Number(result?.meta?.changes) !== 1) {
      throw new HttpError(404, UNKNOWN_SERVER_404);
    }
  } catch (error) {
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(error))) {
      throw new HttpError(409, "That clip is already in this pack.");
    }
    throw error;
  }
  return json({ clip: { name, uploadId, status: "candidate" } }, 201);
}

async function handleDropClipRoute(request, env, serverId, packId, clipId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundpacks:" + session.user.id);
  const serverIdNum = Number(serverId);
  const packIdNum = validId(packId);
  const clipIdNum = validId(clipId);
  const actorId = Number(session.user.id);
  // ONE atomic batch: the staging clear (the dropped token's bytes) rides
  // BEFORE the guarded row delete, inside the same transaction — the clear's
  // own arms (status, other-references, pack, mod guard) refuse for a
  // non-mod or a foreign pack exactly like the row delete's do.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(CLIP_DROP_CLEAR_SQL).bind(
      clipIdNum, packIdNum, clipIdNum, clipIdNum, packIdNum, serverIdNum,
      ...manageGuardParams(serverIdNum, actorId),
    ),
    env.GOOBER_DB.prepare(CLIP_DROP_SQL).bind(
      clipIdNum, packIdNum, packIdNum, serverIdNum, ...manageGuardParams(serverIdNum, actorId),
    ),
  ]);
  if (Number(results[1]?.meta?.changes) !== 1) {
    // The status arm's refusal means the clip is out of the candidate
    // ladder; anything else (missing clip, foreign pack, non-mod) stays the
    // shared 404.
    const state = await env.GOOBER_DB.prepare(CLIP_STATE_SQL).bind(clipIdNum).first();
    if (state && Number(state.pack_id) === packIdNum && Number(state.server_id) === serverIdNum &&
        state.status !== "candidate") {
      throw new HttpError(400, "That clip is not waiting for review.");
    }
    throw new HttpError(404, UNKNOWN_SERVER_404);
  }
  return json({ ok: true });
}

// --- dispatch ----------------------------------------------------------------------

export async function handleSoundPackRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const listMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/servers\/([1-9][0-9]*)\/sound-packs$/)
    : null;
  if (listMatch) {
    return method === "GET"
      ? handleListPacksRoute(request, env, Number(listMatch[1]))
      : handleCreatePackRoute(request, env, Number(listMatch[1]));
  }

  const deletePackMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/([1-9][0-9]*)\/sound-packs\/([1-9][0-9]*)$/)
    : null;
  if (deletePackMatch) {
    return handleDeletePackRoute(request, env, Number(deletePackMatch[1]), deletePackMatch[2]);
  }

  const clipsMatch = method === "POST"
    ? path.match(/^\/api\/servers\/([1-9][0-9]*)\/sound-packs\/([1-9][0-9]*)\/clips$/)
    : null;
  if (clipsMatch) {
    return handleCreateClipRoute(request, env, Number(clipsMatch[1]), clipsMatch[2]);
  }

  const dropMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/([1-9][0-9]*)\/sound-packs\/([1-9][0-9]*)\/clips\/([1-9][0-9]*)$/)
    : null;
  if (dropMatch) {
    return handleDropClipRoute(request, env, Number(dropMatch[1]), dropMatch[2], dropMatch[3]);
  }
  return undefined;
}
