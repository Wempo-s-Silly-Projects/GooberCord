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

// GIF search (parity bundle, Nov 17 2026; KLIPY migration — Tenor EOL
// 2026-06-30, owner order): the KLIPY-backed picker route.
//
// OWNER-SUPPLIED SECRET ONLY: the key rides env.KLIPY_API_KEY and is NEVER
// hardcoded, echoed, logged, or committed — a request without the configured
// secret answers the shared 503 copy (the feature is simply not configured
// yet), and no code path below sees more than the one key variable. It rides
// KLIPY's UPSTREAM PATH segment (docs.klipy.com's gifs-search contract), so
// it never appears in a query string. The upstream response is mapped down
// to the same three fields the picker renders (id, description, url) — the
// client's wire shape NEVER changes with the provider, and KLIPY's
// customer_id and locale knobs are OMITTED ENTIRELY (privacy law: LIMIT
// COLLECTION NOT ACCESS — no user identifiers go to third parties).
import { requireSignedInRead } from "./core/auth.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import {
  KLIPY_SEARCH_BASE_URL,
  KLIPY_SEARCH_PATH,
  KLIPY_MAX_PER_PAGE,
  KLIPY_CONTENT_FILTER_DEFAULT,
} from "../constants.mjs";

export const GIF_SEARCH_CONFIGURED_ERROR = "GIF search is not configured yet.";
export const GIF_SEARCH_UNAVAILABLE_ERROR = "GIF search is unavailable right now.";
export const GIF_IMAGE_INVALID_ERROR = "That GIF reference is invalid.";

// The media proxy's allowlist (owner-direct ruling): the picker's payloads
// carry KLIPY's own media hosts, and these routes pass through ONLY
// https URLs on klipy.com or a subdomain of it — one rule, never an
// arbitrary-host fetch. A URL that fails the pair is the shared 400, never
// a network call.
function klipyMediaUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  if (host !== "klipy.com" && !host.endsWith(".klipy.com")) return null;
  // The media fetch keeps only the path + its search — the fragment is
  // never part of a media URL.
  return { origin: parsed.origin, target: parsed.pathname + parsed.search };
}

// The picker's page: 12 by default, 50 at most (KLIPY's per_page ceiling;
// the client paginates by position cursor, GC clamps the page size only).
// The explicit-low content filter is the route's own default — the picker
// is a shared surface, so KLIPY's lowest tier is what a search hands back
// before GC's own rules ever see a rendered sticker-sized GIF in a message.
const GIF_DEFAULT_LIMIT = 12;
const GIF_MAX_LIMIT = KLIPY_MAX_PER_PAGE;

// KLIPY's page cursor walks the wire's opaque position token ONE step at a
// time: the client contract never changes shape with the provider. The
// token's only lawful shape is a bounded page number — anything else is
// the first page.
const GIF_FIRST_PAGE = 1;
const GIF_LAST_PAGE = 999999;

function publicGif(result) {
  const md = result.file?.md?.gif;
  const sm = result.file?.sm?.gif;
  return {
    id: typeof result.id === "string" ? result.id : null,
    description: typeof result.title === "string" ? result.title : null,
    url: typeof md?.url === "string" ? md.url : null,
    previewUrl: typeof sm?.url === "string" ? sm.url : null,
  };
}

export async function handleGifRoutes(request, env, url, path, method, ctx) {
  void ctx;

  if (path === "/api/gifs/search" && method === "GET") {    // The key question runs FIRST: an unconfigured environment answers the
    // 503 before any caller-specific work (and never touches the network).
    const apiKey = env.KLIPY_API_KEY;
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
    // Position cursor: the wire's opaque token — its ONE shape is KLIPY's
    // page number (bounded, never interpreted beyond Number).
    const positionRaw = url.searchParams.get("position");
    const parsed = /^[0-9]{1,6}$/.test(positionRaw ?? "") ? Number(positionRaw) : GIF_FIRST_PAGE;
    const requestedPage = Math.min(Math.max(parsed, GIF_FIRST_PAGE), GIF_LAST_PAGE);

    const searchParams = new URLSearchParams({
      q: query,
      page: String(requestedPage),
      per_page: String(limit),
      format_filter: "gif",
      content_filter: KLIPY_CONTENT_FILTER_DEFAULT,
    });

    let payload;
    try {
      const upstream = await fetch(
        `${KLIPY_SEARCH_BASE_URL}/${encodeURIComponent(apiKey)}${KLIPY_SEARCH_PATH}?` +
          searchParams.toString(),
        { signal: AbortSignal.timeout(5000) },
      );
      if (!upstream.ok) throw new Error("klipy status " + upstream.status);
      payload = await upstream.json();
    } catch {
      // Upstream failure — the shared unavailable copy, never the key, never
      // the upstream error body.
      throw new HttpError(502, GIF_SEARCH_UNAVAILABLE_ERROR);
    }
    const items = payload?.result === true ? payload?.data?.data : null;
    if (!Array.isArray(items)) {
      // A result flag that is not the boolean true is a refusal from
      // upstream — the shared copy, never the upstream body.
      throw new HttpError(502, GIF_SEARCH_UNAVAILABLE_ERROR);
    }

    const hasNext = payload?.data?.has_next === true;
    const currentPage = payload?.data?.current_page;
    return json({
      gifs: items.map(publicGif),
      position:
        hasNext && Number.isInteger(currentPage) && currentPage >= GIF_FIRST_PAGE
          ? String(currentPage + 1)
          : null,
    });
  }

  // The media proxy (owner-direct ruling wave 2): the picker's <img>s point
  // HERE, at the picker payload's own media URLs re-encoded — the worker
  // fetches the bytes on KLIPY's allowlisted hosts and streams them
  // SAME-ORIGIN, where the site CSP (img-src 'self') admits them. The bytes
  // pass through as a STREAM (the response body is never buffered in the
  // isolate), the content type is pinned to image/* (the search route's own
  // format_filter rides gif only), and a sane shared cache ride
  // means a repeat render never refetches upstream. The key check runs first,
  // mirroring the search — an unconfigured environment 503s before any
  // session work, and nothing ever echoes the secret.
  if (path === "/api/gifs/image" && method === "GET") {
    const apiKey = env.KLIPY_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new HttpError(503, GIF_SEARCH_CONFIGURED_ERROR);
    }

    const session = await requireSignedInRead(request, env);
    await rateLimit(request, env, "read", "gifs-image:" + String(session.user.id));

    const media = klipyMediaUrl(url.searchParams.get("u"));
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
