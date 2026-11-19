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

// GIF search (parity bundle, Nov 17 2026): the Tenor-backed picker route.
//
// OWNER-SUPPLIED SECRET ONLY: the key rides env.TENOR_API_KEY and is NEVER
// hardcoded, echoed, logged, or committed — a request without the configured
// secret answers the shared 503 copy (the feature is simply not configured
// yet), and no code path below sees more than the one key variable. The
// upstream response is mapped down to the three fields the picker renders
// (id, description, url) — Tenor's own payload shape stays theirs.
import { requireSignedInRead } from "./core/auth.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";

const TENOR_SEARCH_URL = "https://g.tenor.com/v2/search";
export const GIF_SEARCH_CONFIGURED_ERROR = "GIF search is not configured yet.";
export const GIF_SEARCH_UNAVAILABLE_ERROR = "GIF search is unavailable right now.";
export const GIF_IMAGE_INVALID_ERROR = "That GIF reference is invalid.";

// The media proxy's allowlist (owner-direct ruling): the picker's payloads
// carry Tenor's own media hosts, and these routes pass through ONLY
// https URLs on tenor.com or a subdomain of it — one rule, never an
// arbitrary-host fetch. A URL that fails the pair is the shared 400, never
// a network call.
function tenorMediaUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  if (host !== "tenor.com" && !host.endsWith(".tenor.com")) return null;
  // The media fetch keeps only the path + its (Tenor-signed) search — the
  // fragment is never part of a media URL.
  return { origin: parsed.origin, target: parsed.pathname + parsed.search };
}

// The picker's page: 12 by default, 24 at most (the client paginates by
// cursor; GC clamps the page size only). The medium content filter is the
// route's own default — the picker is a shared surface, so Tenor's explicit
// mature-off tier is what a search hands back before GC's own rules ever see
// a rendered sticker-sized GIF in a message.
const GIF_DEFAULT_LIMIT = 12;
const GIF_MAX_LIMIT = 24;

function publicGif(result) {
  const media = result.media_formats || {};
  return {
    id: typeof result.id === "string" ? result.id : null,
    description:
      typeof result.content_description === "string" ? result.content_description : null,
    url: typeof media.gif === "object" && media.gif !== null ? media.gif.url : null,
    previewUrl:
      typeof media.tinygif === "object" && media.tinygif !== null ? media.tinygif.url : null,
  };
}

export async function handleGifRoutes(request, env, url, path, method, ctx) {
  void ctx;

  if (path === "/api/gifs/search" && method === "GET") {    // The key question runs FIRST: an unconfigured environment answers the
    // 503 before any caller-specific work (and never touches the network).
    const apiKey = env.TENOR_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new HttpError(503, GIF_SEARCH_CONFIGURED_ERROR);
    }

    await requireSignedInRead(request, env);
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 1 || query.length > 64) {
      throw new HttpError(400, "Search for something between 1 and 64 characters.");
    }
    const limitRaw = url.searchParams.get("limit");
    let limit = GIF_DEFAULT_LIMIT;
    if (limitRaw !== null && limitRaw !== "") {
      if (!/^[0-9]{1,2}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > GIF_MAX_LIMIT) {
        throw new HttpError(400, "That page size is invalid.");
      }
      limit = Number(limitRaw);
    }
    // Position cursor: Tenor's own continuation token, passed through
    // opaquely (bounded, never interpreted).
    const positionRaw = url.searchParams.get("position");
    const position =
      typeof positionRaw === "string" && positionRaw.length > 0 && positionRaw.length <= 64
        ? positionRaw
        : undefined;

    const searchParams = new URLSearchParams({
      q: query,
      key: apiKey,
      limit: String(limit),
      media_filter: "gif,tinygif,webp,tinywebp",
      contentfilter: "medium",
      client_key: "goobercord",
    });
    if (position !== undefined) searchParams.set("pos", position);

    let payload;
    try {
      const response = await fetch(TENOR_SEARCH_URL + "?" + searchParams.toString(), {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("tenor status " + response.status);
      payload = await response.json();
    } catch {
      // Upstream failure — the shared unavailable copy, never the key, never
      // the upstream error body.
      throw new HttpError(502, GIF_SEARCH_UNAVAILABLE_ERROR);
    }

    return json({
      gifs: (Array.isArray(payload?.results) ? payload.results : []).map(publicGif),
      position: typeof payload?.next === "string" ? payload.next : null,
    });
  }

  // The media proxy (owner-direct ruling wave 2): the picker's <img>s point
  // HERE, at the picker payload's own media URLs re-encoded — the worker
  // fetches the bytes on Tenor's allowlisted hosts and streams them
  // SAME-ORIGIN, where the site CSP (img-src 'self') admits them. The bytes
  // pass through as a STREAM (the response body is never buffered in the
  // isolate), the content type is pinned to image/* (the search route's own
  // media_filter rides gif/tinygif/webp only), and a sane shared cache ride
  // means a repeat render never refetches upstream. The key check runs first,
  // mirroring the search — an unconfigured environment 503s before any
  // session work, and nothing ever echoes the secret.
  if (path === "/api/gifs/image" && method === "GET") {
    const apiKey = env.TENOR_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new HttpError(503, GIF_SEARCH_CONFIGURED_ERROR);
    }

    const session = await requireSignedInRead(request, env);
    await rateLimit(request, env, "read", "gifs-image:" + String(session.user.id));

    const media = tenorMediaUrl(url.searchParams.get("u"));
    if (media === null) throw new HttpError(400, GIF_IMAGE_INVALID_ERROR);

    let upstream;
    try {
      upstream = await fetch(media.origin + media.target, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "image/*" },
      });
    } catch {
      throw new HttpError(502, GIF_SEARCH_UNAVAILABLE_ERROR);
    }
    const contentType = typeof upstream.headers?.get === "function"
      ? (upstream.headers.get("content-type") || "")
      : "";
    if (!upstream.ok || !contentType.startsWith("image/")) {
      // The upstream error body is never relayed (it might echo the request
      // URL — and through it nothing of ours — but the discipline is to
      // answer the shared copy, never pass bytes we did not validate).
      throw new HttpError(502, GIF_SEARCH_UNAVAILABLE_ERROR);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return undefined;
}
