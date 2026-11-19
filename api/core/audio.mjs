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

// The audio core leaf: the soundboard's bytes contract, the mirror of the
// image lane's (api/core/images.mjs) sniff + egress-verify discipline. A
// sound rides a gc_attachments row like any attachment, so its serving path
// needs its own magic-byte verifier — the image sniff cannot read audio
// formats, and the egress re-verification must fail safe the same way:
// stored bytes that no longer carry the row's mime answer the shared 404,
// never a best-guess Content-Type. No audio sanitizer exists today: the
// intake's sniff gates what is admitted, the moderation desk reviews every
// pending row before approval, and egress re-verifies.
import { securityHeaders } from "./http.mjs";

// The admitted intake types (the moderation desk's own copy). The frame-sync
// arm covers MPEG-1/2/2.5 Layer I/II/III frames without an ID3 container
// (broadcast MP3s); OggS covers ogg-vorbis and opus-in-ogg alike.
export function sniffAudioMime(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  // MP3: an ID3v2 container ("ID3") or an MPEG audio frame sync (11 set bits).
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return "audio/mpeg";
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  // WAV: the RIFF container whose form type is WAVE (bytes 8-11).
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 &&
    bytes[10] === 0x56 && bytes[11] === 0x45
  ) return "audio/wav";
  if (
    bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) return "audio/flac";
  return null;
}

// The egress twin of imageResponse: the claimed mime must match the SNIFFED
// magic of the stored bytes — a mismatched or empty set is null (the serving
// route answers the shared 404, never a best-guess Content-Type).
export function audioResponse(bytes, claimedMime, cacheControl) {
  const sniffed = sniffAudioMime(bytes);
  if (!sniffed || sniffed !== claimedMime) return null;
  const headers = securityHeaders();
  headers.set("Content-Type", sniffed);
  headers.set("Cache-Control", cacheControl);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", 'inline; filename="sound"');
  headers.set("Content-Length", String(bytes.length));
  return new Response(bytes, { status: 200, headers });
}
