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

// v4.0 core leaf: request/response glue — the typed error, JSON responses,
// the security-header set, rate limiting, Turnstile verification, bounded
// body reading, and field validation.
//
// Phase-1 Kitskey migration: the error/response/rate-limit vocabulary now
// LIVES in api/vendor/http.mjs (byte-identical to the framework's
// experience/http.mjs — pinned by contract-parity; the file is the
// framework's, not an app-owned copy). This leaf re-exports that surface
// unchanged so every api module imports exactly the way it did — public
// signatures and messages never moved — and keeps the app-side pieces: the
// Turnstile wall (app secret/hostnames), the GooberCord limiter binding map,
// and GooberCord's ONE intentional header divergence (voice, below).
import { RATE_LIMIT_BINDINGS, TURNSTILE_SITEVERIFY_URL } from "../../constants.mjs";
import {
  HttpError,
  MAX_JSON_BYTES,
  errorReply,
  json as vendorJson,
  makeHttp,
  securityHeaders as vendorSecurityHeaders,
} from "../vendor/http.mjs";

// The vendored surface, unchanged; since phase 2, worker.mjs consumes errorReply
// and dispatch from here (the vendor import is theirs — one classifier, one
// dispatch chain, no twin). Phase 4: errorReply/dispatch + the static leg
// (secureResponse rides makeHttp's securityHeaders config above; the
// conditional-get force-200 trade, unconditional, is the framework verbatim).
export { unconditional, isDocumentRequest } from "../vendor/http.mjs";
export { HttpError, MAX_JSON_BYTES, errorReply };

// GooberCord's one app-side divergence is kept OUT of the vendored file (it
// must stay byte-identical to the framework source). Voice (phase 2) needs
// the page to be allowed its OWN microphone; `microphone=()` disabled
// getUserMedia outright. `microphone=(self)` still denies every cross-origin
// embed while permitting the app itself. The vendored json() applies the
// framework's header set internally, so BOTH json exits re-assert the app's
// policy — the produced header bytes are exactly what this leaf made before
// the migration.
export function securityHeaders(headers = new Headers()) {
  const result = vendorSecurityHeaders(headers);
  result.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  return result;
}

export function json(data, status = 200, headers = {}) {
  const response = vendorJson(data, status, headers);
  response.headers.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  return response;
}

// The config-bound half: GooberCord's limiter map and the shared JSON cap.
// Phase-4 Kitskey migration: the static leg rides THIS config too — the app's
// securityHeaders (the divergent microphone=(self) set) is the re-wrap the
// vendor secureResponse applies to every upstream ASSETS response, exactly
// where the app's inline secureResponse used to re-assert it.
const app = makeHttp({
  rateLimitBindings: RATE_LIMIT_BINDINGS,
  maxJsonBytes: MAX_JSON_BYTES,
  securityHeaders,
});
export const rateLimit = app.rateLimit;
export const requireMutationApplied = app.requireMutationApplied;
export const readLimitedBody = app.readLimitedBody;
export const readJson = app.readJson;
export const requiredText = app.requiredText;
export const secureResponse = app.secureResponse;

const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

export async function requireTurnstile(request, env, body, expectedAction) {
  const secret = env.TURNSTILE_SECRET;
  const hostnames = String(env.TURNSTILE_HOSTNAMES || "")
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
  const token = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
  if (!secret || hostnames.length === 0 || !token || token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    throw new HttpError(403, "Human verification is required.");
  }
  let result;
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || "",
      }),
    });
    if (!response.ok) throw new Error("siteverify responded with " + response.status);
    result = await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("Turnstile siteverify request failed:", error && error.name ? error.name : "UnknownError");
    throw new HttpError(403, "Human verification could not be completed. Please try again.");
  }
  const verifiedHostname = typeof result.hostname === "string" ? result.hostname.trim().toLowerCase() : "";
  const hostnameAllowed = hostnames.some((configured) => {
    const expected = configured.toLowerCase();
    if (expected.startsWith("*.")) {
      const suffix = expected.slice(1);
      return verifiedHostname.length > suffix.length && verifiedHostname.endsWith(suffix);
    }
    return verifiedHostname === expected;
  });
  if (!result.success || result.action !== expectedAction || !hostnameAllowed) {
    throw new HttpError(403, "Human verification failed. Please try again.");
  }
}
