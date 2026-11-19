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

// Server soundboard (0023's feature wave): CRUD mirroring api/emoji.mjs
// exactly — the sound IS a gc_attachments row (same standalone intake
// machinery, same pending moderation, same serving gate with its own audio
// egress verifier), the write authorization rides INSIDE the statements
// (owner tier OR the gc_roles MANAGE_EMOJI bit, the emoji lane's exact
// fragments mirrored locally — the parity discipline there), and the
// inventory cap rides the create statement itself.
//
// THE GATE IS THE BOOST LADDER (0025's parity pass — the 0023 matrix said
// "none at level 0" and the owner corrected it): GC_SOUNDBOARD_MAX_PER_SERVER's
// base is Discord's REAL 8, so EVERY server has a board; the slots resolve
// through the shared resolver (api/boost-level.mjs) — 8 at level 0, then the
// blessings 24/36/48, the max-of shape meaning a level never lowers an
// inventory. The create's cap rides the INSERT, so an over-slot create is a
// zero-changes statement; an inventory over a SMALLER cap is never deleted.
//
// THE WIRE TOKENS (the play wave's contract): gc_sounds' name column carries
// the SAME strict CHECK verbatim as the 0020 twin — the token's name slot is
// spelled once by that CHECK. Message-side tokens ride a LATER wave (sounds
// play into voice, they are not message renderables); the emoji/sticker
// token letters own <s:...>, so the play wave resolves sounds under their
// own distinctive letter off this same name grammar.
import { requireSignedInRead, requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { sniffAudioMime } from "./core/audio.mjs";
import {
  GC_SOUND_INTAKE_MIMES,
  GC_SOUND_NAME_MAX,
  GC_SOUND_NAME_MIN,
  GC_SOUND_NAME_PATTERN,
  GC_SOUNDBOARD_SOUND_MAX_BYTES,
  GC_SOUNDBOARD_SOUND_REQUEST_BYTES,
} from "../constants.mjs";
import { SERVER_PERMISSIONS, holdsRolesBitsSql, holdsRolesBitsParams, parseMergedMask, roleMaskColumnSql } from "./permissions.mjs";
import { serverBoostTier } from "./boost-level.mjs";
import {
  deleteAttachmentObject,
  exportAttachmentObject,
  readMultipartWithImage,
  standaloneAttachmentStatements,
} from "./media.mjs";
import { expressionPayloadRow } from "./emoji.mjs";

// The manage-guard fragments mirror the emoji lane's exact copies (that
// module keeps them local by the same design note; a guard change must be
// re-mirrored and the parity tests pin BOTH copies' behavior).
const MERGED_PERMS_SELECT = roleMaskColumnSql();

const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

function manageGuard(serverId, actorId) {
  return {
    sql: "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_EMOJI) + ")",
    params: [serverId, actorId, ...holdsRolesBitsParams(serverId, actorId, SERVER_PERMISSIONS.MANAGE_EMOJI)],
  };
}

const SOUND_NAME_ERROR =
  "Use a " + GC_SOUND_NAME_MIN + "-" + GC_SOUND_NAME_MAX +
  " character name of letters, numbers and underscores.";

function validSoundName(value) {
  if (typeof value !== "string" || !GC_SOUND_NAME_PATTERN.test(value)) {
    throw new HttpError(400, SOUND_NAME_ERROR);
  }
  return value;
}

function validSoundId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id >= 1_000_000_000_000) {
    throw new HttpError(400, "That id is invalid.");
  }
  return id;
}

// The read-tier membership gate (no membership → the shared 404, never an
// existence oracle).
async function memberGate(env, serverId, userId) {
  const exists = await env.GOOBER_DB.prepare(
    "SELECT 1 AS member FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, userId).first();
  if (!exists) throw new HttpError(404, "That server does not exist or you are not in it.");
}

// The write-tier authority read — the expression lane's exact two-step.
async function soundAuthority(env, serverId, actorId) {
  const membership = await env.GOOBER_DB.prepare(
    "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1",
  ).bind(serverId, actorId).first();
  if (!membership) return { isMember: false, authoritative: false };
  let authoritative =
    membership.role === "owner" || membership.role === "moderator";
  if (!authoritative) {
    const perms = await env.GOOBER_DB.prepare(
      "SELECT (" + MERGED_PERMS_SELECT + ") AS permissions " +
        "FROM gc_server_members m WHERE m.server_id = ? AND m.user_id = ? LIMIT 1",
    ).bind(serverId, actorId, serverId, actorId).first();
    authoritative = ((parseMergedMask(perms?.permissions)) &
      SERVER_PERMISSIONS.MANAGE_EMOJI) === SERVER_PERMISSIONS.MANAGE_EMOJI;
  }
  return { isMember: true, authoritative };
}

// The board: all sounds + names for the server. The read is NOT capped at
// the boost level's EFFECTIVE count: an inventory over a SMALLER cap (a
// server whose boosts lapsed) is never deleted — only new creates are
// blocked — so their tiles and future tokens must still resolve; a
// level-0 board simply lists the whole (base-capped) inventory.
export async function loadServerSounds(env, serverId) {
  const sounds = [];
  const { results } = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, attachment_id, created_at FROM gc_sounds" +
      " WHERE server_id = ? ORDER BY name, id",
  ).bind(Number(serverId)).all();
  for (const row of results || []) sounds.push(expressionPayloadRow(row));
  return sounds;
}
// --- intake ----------------------------------------------------------------------

const SOUND_FILE_FIELD = "sound";
const ONLY_SOUNDS_ERROR = "Only MP3 and OGG sounds are accepted.";
const SOUND_UNREADABLE_ERROR =
  "That sound could not be read. Try re-saving it and uploading again.";
const SOUND_TOO_LARGE_ERROR =
  "Sounds must be 512 KB or smaller.";

// The bytes contract (Discord-real, 0025): the size cap FIRST, then the
// magic sniff, admitted formats MP3 and OGG only — the other formats the
// audio core's sniff can READ (WAV/FLAC) are not soundboard-intake shapes.
// The duration check is the spec's SOFT-FAIL rider: no cheap MP3/OGG length
// parse exists, so the size + format gates carry the intake and the
// moderation desk reviews every pending row's audio before approval. A
// failed sniff means NO row — nothing is stored for an unadmitted format.
export function prepareSoundAttachment(fileBytes) {
  if (!(fileBytes instanceof Uint8Array) || fileBytes.length < 1) {
    throw new HttpError(400, SOUND_UNREADABLE_ERROR);
  }
  if (fileBytes.length > GC_SOUNDBOARD_SOUND_MAX_BYTES) {
    throw new HttpError(413, SOUND_TOO_LARGE_ERROR);
  }
  const mime = sniffAudioMime(fileBytes);
  // The admitted pair is ONE source (constants.mjs) with the serving
  // verdict — an intake never admits what serving would refuse.
  if (!GC_SOUND_INTAKE_MIMES.includes(mime)) {
    throw new HttpError(400, ONLY_SOUNDS_ERROR);
  }
  return { mime, bytes: fileBytes };
}

async function createSoundAttachment(env, uploaderId, fileBytes, ctx) {
  const prepared = prepareSoundAttachment(fileBytes);
  const now = nowSeconds();
  const results = await env.GOOBER_DB.batch(
    standaloneAttachmentStatements(env, uploaderId, prepared, now),
  );
  const id = Number(results[0]?.meta?.last_row_id);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpError(500, "That sound could not be stored. Please try again.");
  }
  // The object copy (the T-R2-WIPE intake put): the sound's bytes land at
  // gc-attachments/<id> once the batch resolved the id — the SAME idiom the
  // landed media.mjs createAttachment put rides (best-effort; the complete
  // D1 copy above stays the serving fallback on a put miss).
  await exportAttachmentObject(env, ctx, id, prepared.bytes);
  return { id, status: "pending", mime: prepared.mime, sizeBytes: prepared.bytes.length };
}

// The JSON branch's own-attachment read: the sound's asset must BE audio —
// a member's own uploaded IMAGE can never ride the board as a sound.
const OWN_SOUND_MIME_SQL =
  "SELECT mime FROM gc_attachments WHERE id = ? AND uploader_id = ? LIMIT 1";

// --- routes ----------------------------------------------------------------------

async function handleListSoundsRoute(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  await memberGate(env, Number(serverId), Number(session.user.id));
  // The caps rider (W-B0, the emoji/sticker lists' twin): the manage UI's
  // sound counter reads the board's own resolver answer.
  const tier = await serverBoostTier(env, Number(serverId));
  return json({
    sounds: await loadServerSounds(env, Number(serverId)),
    caps: {
      emoji: tier.caps.emoji,
      stickers: tier.caps.stickers,
      sounds: tier.caps.soundboard,
    },
  });
}

async function handleCreateSoundRoute(request, env, serverId, ctx) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundboard:" + session.user.id);
  const actorId = Number(session.user.id);
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();

  let attachmentId = null;
  let name = null;
  let files = [];
  if (contentType.startsWith("multipart/form-data")) {
    await rateLimit(request, env, "upload", "user:" + actorId);
    const parsed = await readMultipartWithImage(
      request,
      {
        imageField: SOUND_FILE_FIELD,
        maxFileBytes: GC_SOUNDBOARD_SOUND_MAX_BYTES,
        maxRequestBytes: GC_SOUNDBOARD_SOUND_REQUEST_BYTES,
        tooLargeCopy: SOUND_TOO_LARGE_ERROR,
        label: "sound",
        labelPlural: "Sounds",
      },
    );
    files = parsed.files;
    name = validSoundName(parsed.fields.name);
    if (files.length > 1) throw new HttpError(400, "Attach exactly one sound.");
    if (files.length === 0) {
      throw new HttpError(400, "Attach the sound file for this sound.");
    }
  } else {
    const body = await readJson(request);
    name = validSoundName(body.name);
    attachmentId = Number(body.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId < 1) {
      throw new HttpError(400, "Reference one of your own uploaded sounds.");
    }
  }

  // The level's EFFECTIVE cap answers once per create (one resolver read;
  // the base 8 means every server has a board, the blessings 24/36/48
  // through the max-of shape).
  const cap = (await serverBoostTier(env, Number(serverId))).caps.soundboard;

  if (attachmentId === null) {
    attachmentId = Number((await createSoundAttachment(env, actorId, files[0], ctx)).id);
  } else {
    // The JSON branch's own-asset read: the sound's asset must BE audio — a
    // member's own uploaded IMAGE can never ride the board as a sound.
    const owned = await env.GOOBER_DB.prepare(OWN_SOUND_MIME_SQL)
      .bind(attachmentId, actorId).first();
    if (!owned || !String(owned.mime || "").startsWith("audio/")) {
      throw new HttpError(400, "Reference one of your own uploaded sounds.");
    }
  }

  const result = await env.GOOBER_DB.prepare(
    "INSERT INTO gc_sounds (server_id, name, attachment_id, created_by, created_at) " +
      "SELECT ?, ?, ?, ?, ? " +
      "WHERE (" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.MANAGE_EMOJI) + ") " +
      "AND EXISTS (SELECT 1 FROM gc_attachments a WHERE a.id = ? AND a.uploader_id = ? " +
        // The shared-asset arms (W-B0, emoji lane's twin): a sound's asset is
        // standalone (no message), within the 512 KB bytes contract, and
        // unreferenced by any row — delete-while-referenced is unschedulable.
        "AND a.message_id IS NULL AND a.size_bytes <= " + GC_SOUNDBOARD_SOUND_MAX_BYTES + ") " +
      "AND NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) " +
      "AND (SELECT COUNT(*) FROM gc_sounds WHERE server_id = ?) < " + cap,
  ).bind(
    Number(serverId), name, attachmentId, actorId, nowSeconds(),
    Number(serverId), actorId,
    Number(serverId), actorId,
    attachmentId, actorId,
    attachmentId, attachmentId, attachmentId,
    Number(serverId),
  ).run().catch((error) => {
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(error))) {
      throw new HttpError(409, "That sound name is already taken in this server.");
    }
    throw error;
  });

  if (Number(result?.meta?.changes) !== 1) {
    // Zero changes — classify by the failing arm, in arm order (the
    // expression lane's exact discipline: one read for the caller-own-asset
    // + shared-asset + count questions, the authority read the
    // channel-delete two-step).
    const state = await env.GOOBER_DB.prepare(
      "SELECT EXISTS (SELECT 1 FROM gc_attachments a WHERE a.id = ? AND a.uploader_id = ?) AS ownAttachment, " +
        "(SELECT size_bytes FROM gc_attachments WHERE id = ?) AS size, " +
        "(SELECT message_id FROM gc_attachments WHERE id = ?) AS messageId, " +
        "EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) AS soundsUsed, " +
        "EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) AS emojiUsed, " +
        "EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) AS stickersUsed, " +
        "(SELECT COUNT(*) FROM gc_sounds WHERE server_id = ?) AS count",
    ).bind(
      attachmentId, actorId,
      attachmentId, attachmentId,
      attachmentId, attachmentId, attachmentId,
      Number(serverId),
    ).first();
    const { isMember, authoritative } = await soundAuthority(env, Number(serverId), actorId);
    if (!isMember) throw new HttpError(404, "That server does not exist or you are not in it.");
    if (!authoritative) throw new HttpError(403, "You do not have permission to do that.");
    if (Number(state?.count) >= cap) {
      throw new HttpError(400, "This server already has " + cap + " sounds.");
    }
    if (state?.ownAttachment &&
        (state.soundsUsed || state.emojiUsed || state.stickersUsed || state.messageId !== null)) {
      // The shared-asset create arm's copy: the bytes already serve another
      // slot or a message. The shared arm answers before the size arm (the
      // emoji classifier's order — the sharing is the classification).
      throw new HttpError(400, "That sound is already referenced elsewhere.");
    }
    if (state?.ownAttachment && Number(state.size) > GC_SOUNDBOARD_SOUND_MAX_BYTES) {
      throw new HttpError(413, SOUND_TOO_LARGE_ERROR);
    }
    throw new HttpError(400, "Reference one of your own uploaded sounds.");
  }

  const row = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, attachment_id, created_at FROM gc_sounds " +
      "WHERE server_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
  ).bind(Number(serverId), name).first();
  if (!row) {
    throw new HttpError(500, "The sound could not be saved. Please try again.");
  }
  return json({ sound: expressionPayloadRow(row) }, 201);
}

async function handleRenameSoundRoute(request, env, serverId, soundId) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundboard:" + session.user.id);
  const body = await readJson(request);
  const name = validSoundName(body.name);
  const soundIdNum = validSoundId(soundId);
  const actorId = Number(session.user.id);
  const guard = manageGuard(Number(serverId), actorId);

  let result;
  try {
    result = await env.GOOBER_DB.prepare(
      "UPDATE gc_sounds SET name = ? WHERE id = ? AND server_id = ? AND " + guard.sql,
    ).bind(name, soundIdNum, Number(serverId), ...guard.params).run();
  } catch (error) {
    if (/UNIQUE|SQLITE_CONSTRAINT/i.test(String(error))) {
      throw new HttpError(409, "That sound name is already taken in this server.");
    }
    throw error;
  }
  if (Number(result?.meta?.changes) !== 1) {
    const { isMember, authoritative } = await soundAuthority(env, Number(serverId), actorId);
    if (!isMember) throw new HttpError(404, "That server does not exist or you are not in it.");
    if (authoritative) throw new HttpError(404, "That sound does not exist.");
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const row = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, attachment_id, created_at FROM gc_sounds WHERE id = ? LIMIT 1",
  ).bind(soundIdNum).first();
  return json({ sound: expressionPayloadRow(row) });
}

// The delete batch mirrors the expression lane's W-B0 ordering (ROW →
// chunks → attachment LAST, the RESTRICT FK). The trailing attachment
// delete carries the protection for every OTHER referencer: another sound,
// an emoji row, a sticker row — and the W-B0 fix (the reviewer's HIGH-1)
// lifted the sibling arms into the CHUNK statement itself, which ran first
// UNARMED so a SHARED asset's bytes were stripped while a sibling
// survived. Post-row-delete the sibling NOT EXISTS reads decide honestly:
// shared → the bytes survive with the sibling; sole referencer → the bytes
// leave with the row.
async function handleDeleteSoundRoute(request, env, serverId, soundId, ctx) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "soundboard:" + session.user.id);
  const actorId = Number(session.user.id);
  const soundIdNum = validSoundId(soundId);
  const guard = manageGuard(Number(serverId), actorId);

  const target = await env.GOOBER_DB.prepare(
    "SELECT attachment_id FROM gc_sounds WHERE id = ? AND server_id = ? LIMIT 1",
  ).bind(soundIdNum, Number(serverId)).first();
  if (!target) {
    const { isMember, authoritative } = await soundAuthority(env, Number(serverId), actorId);
    if (!isMember) throw new HttpError(404, "That server does not exist or you are not in it.");
    if (authoritative) throw new HttpError(404, "That sound does not exist.");
    throw new HttpError(403, "You do not have permission to do that.");
  }

  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_sounds WHERE id = ? AND server_id = ? AND " + guard.sql,
    ).bind(soundIdNum, Number(serverId), ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachment_chunks WHERE attachment_id = ? AND " +
        "NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) AND " +
        // The message guard in the chunks statement's own terms (the twin of
        // the attachment delete's message_id arm).
        "EXISTS (SELECT 1 FROM gc_attachments a WHERE a.id = ? AND a.message_id IS NULL) AND " +
        guard.sql,
    ).bind(
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      ...guard.params,
    ),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_attachments WHERE id = ? AND " +
        "NOT EXISTS (SELECT 1 FROM gc_sounds WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_emoji WHERE attachment_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_stickers WHERE attachment_id = ?) AND " +
        "message_id IS NULL AND " + guard.sql,
    ).bind(
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      Number(target.attachment_id),
      ...guard.params,
    ),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  // The object's bytes die with the D1 rows (the T-R2-WIPE ride): gated on
  // the attachment statement's own changes verdict — statement 3's shared-
  // asset NOT EXISTS arms decide whether this sound's asset was a sole
  // referencer, so ONLY a changes==1 there means the chunk rows left and
  // the object purges (the emoji lane's exact ride shape; the batch's own
  // parity, not a new error policy). Best-effort — a missed delete leaves a
  // garbage-collectable orphan, never a dangling reference.
  if (Number(results[2]?.meta?.changes) === 1) {
    await deleteAttachmentObject(env, ctx, Number(target.attachment_id));
  }
  return json({ ok: true });
}

// --- dispatch -----------------------------------------------------------------

export async function handleSoundboardRoutes(request, env, url, path, method, ctx) {
  void url;
  // ctx (the worker's execution context) carries the background-work lane —
  // the create route's intake put and the delete route's object delete
  // schedule through it.

  const listMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/servers\/([1-9][0-9]*)\/sounds$/)
    : null;
  if (listMatch) {
    return method === "GET"
      ? handleListSoundsRoute(request, env, Number(listMatch[1]))
      : handleCreateSoundRoute(request, env, Number(listMatch[1]), ctx);
  }

  const itemMatch = (method === "PATCH" || method === "DELETE")
    ? path.match(/^\/api\/servers\/([1-9][0-9]*)\/sounds\/([1-9][0-9]*)$/)
    : null;
  if (itemMatch) {
    return method === "PATCH"
      ? handleRenameSoundRoute(request, env, Number(itemMatch[1]), itemMatch[2])
      : handleDeleteSoundRoute(request, env, Number(itemMatch[1]), itemMatch[2], ctx);
  }
  return undefined;
}
