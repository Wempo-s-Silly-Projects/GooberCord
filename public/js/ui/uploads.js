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

// The chunked-upload door (wave-14): the composer face of the large-file
// lane (api/uploads.mjs:415-427 — POST /api/uploads/chunks + POST :id/
// commit + DELETE :id), byte-frozen for the wave. The lane's caps and the
// who-may-send gate live server-side; this module only slices, sends and
// tears down, and its thresholds are the constants.mjs mirrors (G-4).
import { api } from "../core/api.js";
import { t } from "../i18n.js";

// --- mirrored constants (G-4: MAX_ATTACHMENT_BYTES, GC_UPLOAD_PART_BYTES and
// GC_PLUS_ATTACHMENT_BYTES' 1 GiB (constants.mjs) — the caps the backend enforces
// (api/uploads.mjs size gates), never raised client-side. chat.js imports
// these; they are declared ONCE here (wave-19: the tier pairs joined this
// seat as mirrors, the tier resolver attachmentCapBytes stays server-side;
// wave-20: the lane's byte leg rides GC_MEDIA, so the 125 MiB D1-bound arm
// retired, and the lane ceiling rides the tier's own 1 GiB mirror, computed,
// never a second literal).
export const UI_ATTACHMENT_FREE_MAX = 20971520; // MAX_ATTACHMENT_BYTES
export const UI_UPLOAD_PART_BYTES = 1024000; // GC_UPLOAD_PART_BYTES (GC_UPLOAD_PART_CHUNKS 16 × ATTACHMENT_CHUNK_BYTES 64_000)
export const UI_ATTACHMENT_MINI_MAX = 52428800; // GC_MINI_ATTACHMENT_BYTES
export const UI_ATTACHMENT_PLUS_MAX = 1073741824; // GC_PLUS_ATTACHMENT_BYTES
export const UI_UPLOAD_LANE_MAX_BYTES = UI_ATTACHMENT_PLUS_MAX; // the lane's ceiling rides the tier (wave-20)

// The uploadId shape the commit + abandon routes resolve (api/uploads.mjs:211
// UPLOAD_ID_RE) — a malformed token never wires either route.
const UPLOAD_ID_OK_RE = /^[A-Za-z0-9_-]{12}$/;

// The chunked lane's own predicate (wave-19: tier-aware): the D1 chunked
// lane belongs ONLY to a full-plus term (api/uploads.mjs's tier gate — Mini
// and free never pass; a Mini member's 20-50 MiB file rides the single-shot
// pair instead of a server 403), and it opens for the sizes past the free
// cap up to the tier's own 1 GiB ceiling (UI_UPLOAD_LANE_MAX_BYTES above —
// wave-20 opened the parked arm when the byte leg rode to R2).
export function ridesChunkLane(fileSize, tier = null) {
  return tier === "plus" && fileSize > UI_ATTACHMENT_FREE_MAX && fileSize <= UI_UPLOAD_LANE_MAX_BYTES;
}

// openChunkedUpload(file) → { send, cancel }: one door act = the composer's
// one upload state. The progress face is the count of slices actually SENT
// (the lane's own parts) — never an invented bar or timer; the commit births
// the row (the attach-by-id send links it, api/messages.mjs:1181), and a
// cancel or a refused part carries its own ONE abandon DELETE (api/uploads.
// mjs:377 — an empty staging answers 200 too, the no-oracle shape; an
// already-committed token's abandon is the same 200 no-op).
export function openChunkedUpload(file) {
  const totalParts = Math.ceil(file.size / UI_UPLOAD_PART_BYTES);
  const controller = new AbortController(); // the cancel act's abort — an in-flight part can never 201 a staging after the abandon
  let uploadId = null; // the first part's staging token, the abandon route's key
  let cancelled = false; // the composer's cancel act arms it

  const abandonUpload = async () => {
    const id = uploadId;
    uploadId = null;
    if (id === null || !UPLOAD_ID_OK_RE.test(id)) return; // a never-opened door staged nothing
    // ONE explicit DELETE; its own failure never masks the caller's refusal.
    await api(`/api/uploads/${id}`, { method: "DELETE" });
  };

  const send = async (onPart = null) => {
    try {
      for (let seq = 0; seq < totalParts; seq += 1) {
        if (cancelled) {
          await abandonUpload(); // the cancelled return never leaves an orphan staging
          return null;
        }
        const partEnd = Math.min((seq + 1) * UI_UPLOAD_PART_BYTES, file.size);
        const part = file.slice(seq * UI_UPLOAD_PART_BYTES, partEnd);
        const form = new FormData();
        form.append("chunk", part, file.name);
        form.append("seq", String(seq));
        if (seq > 0) form.append("uploadId", uploadId); // the continuation's token (api/uploads.mjs:240-242, 400 otherwise)
        form.append("size", String(file.size));
        const answer = await api("/api/uploads/chunks", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (seq === 0) {
          if (!(typeof answer?.uploadId === "string" && UPLOAD_ID_OK_RE.test(answer.uploadId))) {
            throw new Error(t("gc.chat.attach.failed"));
          }
          uploadId = answer.uploadId;
        }
        onPart?.(seq + 1, totalParts);
      }
      const committed = await api(`/api/uploads/${uploadId}/commit`, {
        method: "POST",
        body: { size: file.size },
        signal: controller.signal,
      });
      const attachment = committed?.attachment;
      if (!attachment || !Number.isInteger(attachment.id)) {
        throw new Error(t("gc.chat.attach.failed"));
      }
      return attachment;
    } catch (error) {
      // The refusal paints verbatim upward; the door's own act is the ONE
      // abandon (a committed-or-empty token's DELETE matches nothing). Its
      // own failure never masks the refusal; a cancelled act paints nothing.
      await abandonUpload().catch(() => null);
      if (cancelled) return null;
      throw error;
    }
  };

  const cancel = async () => {
    cancelled = true;
    controller.abort(); // the wire dies before the DELETE — no part can 201 after the abandon
    // The abandon DELETE is flaky-network-proof (GO-HAYWIRE c21 F2): its own
    // failure stays in the door — a rejection never reaches the composer's
    // remove arms (`await laneDoor.cancel()` in chat.js), the same shape the
    // refusal arm above already rides.
    await abandonUpload().catch(() => null);
  };

  return { send, cancel, totalParts };
}
