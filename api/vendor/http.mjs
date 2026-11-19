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

// api/vendor/http.mjs — fleet-owned response/error/dispatch vocabulary.
//
// THE HOUSE RULES this module enforces by construction:
//   - EVERY response rides the security header set: json() applies it to the
//     API surface, and the static leg's secureResponse (on makeHttp, with the
//     app's securityHeaders riding config) applies it to the asset surface.
//   - errors are thrown, never returned: route handlers raise HttpError and
//     ONE classifier (errorReply) turns the whole API's possible failures
//     into the single response shape — { error: message }, the payload
//     passthrough when a route needs a richer body, and the ONE shared 500
//     that never echoes internals (apps pass their own console label).
//   - the shared 403/401/410/429 literals live in the route module that owns
//     them — this module only guarantees the classification plumbing, so no
//     route can grow its own rival error shape.
//   - rate limits key through a SHA-256 of scope:actor (actor when given,
//     else the connecting IP), resolved through the app's binding-name map;
//     a missing limiter is a hard 503, never a silently unlimited route.
//
// No dependencies, no build step. WebCrypto is global in Workers and
// Node 18+, so no hashing dependency is needed.

export class HttpError extends Error {
  // `payload` replaces the JSON body when present (a login-denied response
  // that carries reason/expiresAt beyond the error message).
  constructor(status, message, headers = {}, payload = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
    this.payload = payload;
  }
}

export const MAX_JSON_BYTES = 16 * 1024;
const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function securityHeaders(headers = new Headers()) {
  const result = new Headers(headers);
  result.set("X-Content-Type-Options", "nosniff");
  result.set("Strict-Transport-Security", "max-age=31536000");
  result.set("X-Frame-Options", "DENY");
  result.set("Referrer-Policy", "strict-origin-when-cross-origin");
  result.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  result.set("Cross-Origin-Resource-Policy", "same-origin");
  result.set("Cross-Origin-Opener-Policy", "same-origin");
  result.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'none'",
  );
  return result;
}

export function json(data, status = 200, headers = {}) {
  const resultHeaders = securityHeaders(new Headers(headers));
  resultHeaders.set("Content-Type", "application/json; charset=utf-8");
  resultHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: resultHeaders });
}

// The ONE error classifier: HttpErrors ride their own status/shape (payload
// passthrough included); anything else is console-logged with the app's
// label and answers the single shared 500.
export function errorReply(error, consoleLabel = "Request failed:") {
  if (error instanceof HttpError) {
    return json(error.payload || { error: error.message }, error.status, error.headers);
  }
  console.error(consoleLabel, error);
  return json({ error: "Something went wrong. Please try again." }, 500);
}

// The ONE dispatch chain: a route file exports handler(request, env, url,
// path, method, ctx); the first truthy response wins; nobody matched falls
// to the chain's 404 (or the app's after-tail, when it passes one).
export function dispatch(handlers, after = null) {
  return async (request, env, url, path, method, ctx) => {
    for (const handler of handlers) {
      const response = await handler(request, env, url, path, method, ctx);
      if (response) return response;
    }
    if (after) return after(request, env, url, path, method, ctx);
    throw new HttpError(404, "Not found.");
  };
}

// --- the static leg ------------------------------------------------------------

// Conditional gets (If-None-Match / If-Modified-Since) are dropped before the
// asset pipeline sees them — but only for DOCUMENT requests: ASSETS.fetch
// answers them with a bare 304 that bypasses app-side stamping entirely, so
// the browser would keep its pre-stamp, pre-security-header HTML until the
// etag changed. Only HTML documents get stamped, so only document requests
// need the force-200 trade; every other asset keeps its correct 304
// revalidation path instead of a full 200 per visit.
const CONDITIONAL_HEADERS = ["If-None-Match", "If-Modified-Since"];
const DOCUMENT_SECFETCH_DESTS = new Set(["document", "iframe", "frame"]);

export function isDocumentRequest(request) {
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest) return DOCUMENT_SECFETCH_DESTS.has(dest.toLowerCase());
  // Fallback without sec-fetch-dest (older agents, wrangler dev): an
  // extension-less path (SPA routes, "/") or .html is a document.
  const path = new URL(request.url).pathname;
  if (/\.html?$/i.test(path)) return true;
  const last = path.split("/").pop();
  return last === "" || !last.includes(".");
}

export function unconditional(request) {
  if (!isDocumentRequest(request)) return request;
  const headers = new Headers(request.headers);
  for (const name of CONDITIONAL_HEADERS) headers.delete(name);
  // The rebuilt request spells URL + method explicitly; the explicit
  // spelling wins because it does not depend on the original request's
  // internals surviving a copy.
  return new Request(request.url, { method: request.method, headers });
}

// makeHttp: the config-bound half. Each app passes its limiter binding map
// ({ [scope]: bindingName }), its JSON cap, and — for the static leg — the
// securityHeaders function its surface answers with. A limiter map without
// the scope fails the route (503) instead of silently skipping the wall.
export function makeHttp({
  rateLimitBindings = {},
  maxJsonBytes = MAX_JSON_BYTES,
  securityHeaders: appSecurityHeaders = securityHeaders,
} = {}) {
  async function rateLimit(request, env, scope, actor = "") {
    const bindingName = rateLimitBindings[scope];
    const limiter = bindingName ? env[bindingName] : null;
    if (!limiter || typeof limiter.limit !== "function") {
      throw new HttpError(503, "Rate limiting is not configured for this endpoint.");
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const identity = actor ? scope + ":" + actor : scope + ":" + ip;
    const key = await sha256Hex(identity);
    const { success } = await limiter.limit({ key });
    if (!success) {
      throw new HttpError(429, "Too many requests. Please wait a little and try again.", {
        "Retry-After": "60",
      });
    }
  }

  // requireMutationApplied: the guarded-WRITE pin — an INSERT/UPDATE/DELETE
  // the row guard refused (changes === 0) answers the shared 403: the
  // route's WHERE clause carries the session's ban gate, so a refused
  // mutation IS "currently banned" from the caller's point of view.
  function requireMutationApplied(result) {
    if (Number(result?.meta?.changes) !== 1) {
      throw new HttpError(403, "This account is currently banned.");
    }
    return result;
  }

  async function readLimitedBody(request, maximum) {
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > maximum) throw new HttpError(413, "That upload is too large.");
    const reader = request.body && request.body.getReader ? request.body.getReader() : null;
    if (!reader) return new Uint8Array();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        try {
          await reader.cancel();
        } catch (cancelError) {
          console.warn(
            "Request body cancellation failed:",
            cancelError && cancelError.name ? cancelError.name : "UnknownError",
          );
        }
        throw new HttpError(413, "That upload is too large.");
      }
      chunks.push(part.value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async function readJson(request, bytesOverride = maxJsonBytes) {
    const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw new HttpError(415, "Send this form as JSON.");
    }
    const bytes = await readLimitedBody(request, bytesOverride);
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new HttpError(400, "The request body is not valid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "The request body must be a JSON object.");
    }
    return value;
  }

  function requiredText(value, field, maximum) {
    if (typeof value !== "string") throw new HttpError(400, "Enter a valid " + field + ".");
    const result = value.trim();
    if (!result || result.length > maximum) {
      throw new HttpError(400, field.charAt(0).toUpperCase() + field.slice(1) + " must be between 1 and " + maximum + " characters.");
    }
    return result;
  }

  // The static leg: an upstream (ASSETS) response re-wrapped with the
  // security header set the app chose on config. Body, status, and
  // statusText pass through untouched; the header set is the only thing the
  // leg decides. (The build-stamping that often surrounds this call stays
  // app-side: it differs per app — build-meta injection is an app's
  // document, not this module's concern.)
  function secureResponse(response) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: appSecurityHeaders(response.headers),
    });
  }

  return {
    rateLimit,
    requireMutationApplied,
    readLimitedBody,
    readJson,
    requiredText,
    secureResponse,
  };
}

// requireTurnstile stays an app-side concern: it fetches siteverify with the
// app's secret/hostnames, so the credential-adjacent call keeps living in
// api/core/http.mjs (app-owned), half of a Turnstile wall is worse than the
// whole one.
