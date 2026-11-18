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

// Route composition and the Worker entrypoint. All handler logic lives under
// api/; worker.mjs re-exports the functions that tests import. workerd
// validates every Worker export as a function or ExportedHandler, so besides
// the default fetch only `export { ... } from` re-exports appear here.
import { handleAccountRoutes } from "./api/accounts.mjs";
import { handleSsoRoutes } from "./api/sso.mjs";
import { handleServerRoutes } from "./api/servers.mjs";
import { handleRulesRoutes } from "./api/rules.mjs";
import { handleMessageRoutes } from "./api/messages.mjs";
import { handleConversationRoutes } from "./api/conversations.mjs";
import { handleMentionRoutes } from "./api/mentions.mjs";
import { handleSocialRoutes } from "./api/social.mjs";
import { handleMediaRoutes } from "./api/media.mjs";
import { handleWsRoutes } from "./api/ws.mjs";
import { handlePresenceRoutes } from "./api/presence.mjs";
import { handleCoinRoutes } from "./api/coins.mjs";
import { handleCampfireRoutes } from "./api/campfire.mjs";
import { handleJobsRoutes } from "./api/jobs.mjs";
import { handleCapsuleRoutes } from "./api/capsules.mjs";
import { handleSeasonRoutes } from "./api/seasons.mjs";
import { handleExpressionRoutes } from "./api/emoji.mjs";
import { handleSoundboardRoutes } from "./api/soundboard.mjs";
import { handleSoundPackRoutes } from "./api/soundpacks.mjs";
import { handleGifRoutes } from "./api/gifs.mjs";
import { handleAvatarRoutes } from "./api/avatars.mjs";
import { handleUploadRoutes } from "./api/uploads.mjs";
import { ensureFilterWords } from "./api/filterstore.mjs";
import { HttpError, json, rateLimit, secureResponse, unconditional } from "./api/core/http.mjs";
// Phase-2 Kitskey migration: the ONE error classifier and the dispatch chain
// come from the vendored framework (core re-exports both; the byte-pin keeps
// them identical). worker.mjs stops carrying its second copy of the mapping.
import { dispatch, errorReply } from "./api/vendor/http.mjs";

export { createSession } from "./api/core/auth.mjs";
export {
  hashPassword,
  isValidPassword,
  isValidPasswordPepper,
  isValidSetupSecret,
  verifyPassword,
} from "./api/core/passwords.mjs";
export {
  createAvatarVersion,
  imageResponse,
  sanitizeImage,
  sniffImageMime,
  blobToUint8Array,
} from "./api/core/images.mjs";
export { requireTurnstile, rateLimit } from "./api/core/http.mjs";
// Placeholder DO classes (Phase 1 Task 8/9 replace them): re-exported here so
// workerd sees them as the worker's exports and the ROOMS/PRESENCE bindings
// in wrangler.toml resolve.
export { ChatRoom } from "./api/rooms.mjs";
export { PresenceHub } from "./api/presence.mjs";

// Phase-4 Kitskey migration: the static leg's two workers — secureResponse
// (the security-header re-wrap; the app's microphone=(self) set rides
// makeHttp's securityHeaders config in api/core/http.mjs) and unconditional
// (the conditional-get force-200 trade for documents) — now come from the
// core leaf, which is the vendored framework verbatim. worker.mjs stops
// carrying its own copies; stampedAssetResponse (the build stamp) STAYS
// app-side — the injection differs here by design (the hardened anchored
// injector is pinned by tests/stale-stamp-comment.test.mjs).

// The error classifier is the vendor's errorReply (imported above). The
// console label is GC's OWN ("GooberCord request failed:") — DELIBERATELY
// renamed now (owner-approved): the vendored twin had carried the forum's
// literal since the phase-2 migration, and the rename was done as its own
// commit with the behavior pins capturing the new label, never silently
// inside a refactor-only migration.

// Stale-build stamp (v4.3.1): every HTML document the worker serves carries
// the build it came with (VERSION@COMMIT_SHA) as a <meta> tag. The client
// compares that stamp against the live /api/version — an SPA tab keeps the
// JS it was served with across deploys, and old JS talking to the newer
// backend is where the "page doesn't update after an action" class of
// misbehavior comes from; a mismatch offers the reload instead.
async function stampedAssetResponse(assetResponse, env) {
  const build = env.VERSION ? [env.VERSION, env.COMMIT_SHA].filter(Boolean).join("@") : "";
  const type = assetResponse.headers.get("Content-Type") || "";
  if (!build || !type.includes("text/html")) return assetResponse;
  let html = await assetResponse.text();
  // The served bytes change length, so the original Content-Length must go —
  // a stale length would truncate the stamped document. HTML also revalidates
  // by ETag, which only tracks the asset bytes: a deploy that bumps VERSION
  // without touching index.html would otherwise keep answering 304s with the
  // browser's OLD stamp. The shell is one small file — no-store keeps every
  // document load freshly stamped.
  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  // The byte length changed, so a validator for the old body no longer
  // describes these bytes — a retained Last-Modified would advertise a lie.
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "no-store");
  html = stampHtmlSubresources(html, build);
  const stamp = `<meta name="app-build" content="${escapeHtmlAttribute(build)}">`;
  // Anchored injection: a literal head-close can legitimately appear inside
  // an HTML comment in the shell, and a first-match replace puts the stamp
  // INSIDE that comment — a commented-out element parses to nothing, the
  // client's querySelector misses it, and the stale-build strip silently
  // stops working (it actually happened: index.html's entry comment carried
  // the raw head-close bytes; live-confirmed inert). Anchor on the
  // closing-head/body boundary when one exists, fall back to the LAST bare
  // head close, and serve the bytes untouched when neither is present.
  const boundary = html.match(/<\/head>\s*<body/);
  if (boundary) {
    return new Response(html.slice(0, boundary.index) + stamp + html.slice(boundary.index), {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  }
  const lastClose = html.lastIndexOf("</head>");
  if (lastClose !== -1) {
    return new Response(html.slice(0, lastClose) + stamp + html.slice(lastClose), {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  }
  return new Response(html, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}
// Subresource stamping (v4.3.2): the shell's own no-store only protects the
// HTML — the JS/CSS it references used to ride content-derived ETags at
// FIXED urls, and a browser holding an over-fresh cached copy (entries are
// cached with the headers they were FIRST served under; must-revalidate in
// today's deploy can't reach an entry cached under yesterday's headers)
// would keep answering from cache at the same URL for days — the "CSS still
// borked / nothing works / says I'm offline" rot: old bytes that no deploy
// could evict. Per-build URL: each document (no-store, always fresh) points
// at ?v=BUILD — a build's bytes land at a URL the browser has never seen.
// Relative module imports inherit the stamp (import() resolves against the
// module's own URL), so one query in index.html stamps the entire graph;
// the assets binding ignores query strings when mapping, and the API/CDN
// cache treats every build's URL as a distinct key. Old entries expire by
// their own terms, unreachable and irrelevant.
// Anchored on the src=/href= attributes of same-origin js/css references
// only (api paths and external urls are never rewritten); a ?v already
// present is left alone, so re-stamping an already-stamped document is a
// no-op.
function stampHtmlSubresources(html, build) {
  if (!build) return html;
  return html.replace(
    /((?:src|href)=")(\/(?:js\/[A-Za-z0-9_./-]+\.js|assets\/styles\.css|styles\.css))(")/g,
    (whole, open, url, close) =>
      url.includes("?") ? whole : `${open}${url}?v=${build}${close}`,
  );
}
function escapeHtmlAttribute(value) {
  return String(value).replace(/[&"<>']/g, (char) => ({
    "&": "&amp;",
    '"': "&quot;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
  })[char]);
}
// ctx carries waitUntil (v3.1): background work rides it where a route needs
// one; the response returns without waiting. Callers without a ctx (tests)
// simply never schedule background checks.
// The API chain's not-found tail (phase-2 migration): the vendor dispatch
// calls it when no handler matched — the two 404 copies this worker has
// always carried, still THROWN so they classify through the one errorReply
// chain instead of growing a rival response shape.
function notFound(request, env, url, path) {
  if (path.startsWith("/api/")) throw new HttpError(404, "That API endpoint does not exist.");
  throw new HttpError(404, "Not found.");
}
// The dispatch chain (Phase 1 → phase-2 migration): each handler receives the
// shared dispatch context and answers only the paths it owns; `undefined`
// falls through to the next handler or the notFound tail above.
const API_HANDLERS = [
  handleAccountRoutes,
  handleSsoRoutes,
  handleServerRoutes,
  handleRulesRoutes,
  handleMessageRoutes,
  handleMentionRoutes,
  handleConversationRoutes,
  handleSocialRoutes,
  handleMediaRoutes,
  handleWsRoutes,
  handlePresenceRoutes,
  handleCoinRoutes,
  handleCampfireRoutes,
  handleJobsRoutes,
  handleCapsuleRoutes,
  handleSeasonRoutes,
  handleExpressionRoutes,
  handleSoundboardRoutes,
  handleSoundPackRoutes,
  handleGifRoutes,
  handleAvatarRoutes,
  handleUploadRoutes,
];
// The chain is built once, from the vendor's dispatch() instead of an inlined
// handlers-for-loop.
const answerApiRoute = dispatch(API_HANDLERS, notFound);
async function routeApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!env.GOOBER_DB) throw new HttpError(503, "The GooberCord database is not configured.");

  // Word-filter priming (mirrors the forum's routeApi): the effective list is
  // the shared site_settings row (read-only) with the FILTERED_WORDS secret as
  // the fallback, held in a TTL cache the handler modules read through
  // filterWords(env). A failed read keeps the secret as the source.
  await ensureFilterWords(env);

  await rateLimit(request, env, method === "GET" || method === "HEAD" ? "read" : "write");

  return answerApiRoute(request, env, url, path, method, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, ctx);
      } catch (error) {
        return errorReply(error, "GooberCord request failed:");
      }
    }
    if (!env.ASSETS) return json({ error: "Static assets are not configured." }, 503);
    try {
      // The wedged-en law: the SPA fallback (not_found_handling =
      // "single-page-application", GLOBAL — there is no per-path knob) answers
      // a MISSING asset path with index.html at 200 text/html. For a locale
      // bundle path that 200-HTML rides the loader's `!response.ok` guard,
      // poisons the bundle cache, and paints key tails (2026-11-17: it did,
      // for two hours, console-silent). A missing bundle is a plain 404 here —
      // the loader's existing branch answers it; a real bundle (or any other
      // path, documents included) rides the funnel exactly as before.
      // The segment class is the seated bundle charset (BUNDLE_LANGS keys are
      // loader-sanitized [a-z0-9-] — i18n.js setLang/storedLang), so a crafted
      // segment (dots, escapes, traversal shapes) never enters the funnel: it
      // rides the generic document leg like any other unknown path (T41).
      if (/^\/locales\/[a-z0-9-]+\.json$/.test(url.pathname)) {
        const asset = await env.ASSETS.fetch(unconditional(request));
        const type = asset.status === 200 ? asset.headers.get("Content-Type") || "" : "";
        if (asset.status !== 200 || type.includes("text/html")) {
          return new Response("Locale bundle not found.", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        return secureResponse(await stampedAssetResponse(asset, env));
      }
      return secureResponse(await stampedAssetResponse(await env.ASSETS.fetch(unconditional(request)), env));
    } catch (error) {
      console.error("Static asset request failed:", error);
      return json({ error: "The requested page could not be loaded." }, 500);
    }
  },
};
