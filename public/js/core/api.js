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

// The one API wrapper. Every API call in the new client rides this module —
// no raw transport anywhere else — so the session's CSRF header, the JSON
// error shape, and one auth-expiry signal live in exactly one file.
//
// Transport contract (matches the backend; the transport is XMLHttpRequest —
// owner directive, 2026-11-19):
//   - sends / accepts JSON (or FormData untouched, for uploads); 204 -> null.
//   - mutating methods carry X-CSRF-Token (once setCsrfToken has the value
//     /api/me delivered) and, where the caller passes one, Idempotency-Key.
//   - a failed status throws an Error whose extras carry the JSON body's
//     additive fields (the ban card's banned/reason/expiresAt), whose .status
//     is the HTTP status, and whose .message is the server's `error` string.
//     Two header riders land on the error too (the G-8/G-6 conventions):
//     .rulesGate carries the `X-Rules-Gate` header (the rules-gate
//     disambiguator, "server:<id>", read as truth when a payload's serverId
//     is ambiguous) and .retryAfter the parsed `Retry-After` seconds of a 429.
//   - a 403 whose message names the stale CSRF token is NOT the caller's
//     failure: the wrapper silently re-probes /api/me for a fresh token and
//     retries the call EXACTLY once; a second failure surfaces inline.
//   - a 401 emits store's "auth:unauthorized" — main.js registers exactly one
//     listener (after boot's own gating settles) that routes to the landing;
//     listeners before that point (the boot redeem itself) stay silent, which
//     is what keeps a refused SSO ticket from ping-ponging against Accounts.
//   - network-level death (the flight never settles) throws the local
//     requestFailed copy carrying .status = 0 — callers paint that message
//     verbatim, and the death is never swallowed.

import { emit, set } from "./store.js";
import { t } from "../i18n.js";

let csrfToken = "";

export const setCsrfToken = (token) => {
  csrfToken = typeof token === "string" ? token : "";
};

export const AUTH_EVENT = "auth:unauthorized";

// The server's exact stale-token string prefix (contract §2); any 403 whose
// message opens with it gets the one silent retry.
const CSRF_STALE_PREFIX = "Your security token is out of date.";

// The XHR flight: open, headers, send. The promise resolves the settled
// XMLHttpRequest (onload) or rejects with the requestFailed status-0 death
// error (onerror / a mid-flight abort — never a swallow). A caller's
// AbortController, where one is passed, aborts the transport; the abort
// listener is removed once the flight settles. onUploadProgress /
// onDownloadProgress are the additive hooks (null defaults), wired through
// xhr.upload.onprogress / xhr.onprogress for callers that want them.
const request = (path, method, headers, body, signal, onUploadProgress, onDownloadProgress) =>
  new Promise((resolve, reject) => {
    const death = () => {
      const error = new Error(t("gc.errors.requestFailed", { status: 0 }));
      error.status = 0;
      reject(error);
    };
    // An already-aborted signal never opens a transport.
    if (signal?.aborted) {
      death();
      return;
    }
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open(method, path, true);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    if (typeof onUploadProgress === "function") {
      xhr.upload.onprogress = (event) => onUploadProgress({ loaded: event.loaded, total: event.total });
    }
    if (typeof onDownloadProgress === "function") {
      xhr.onprogress = (event) => onDownloadProgress({ loaded: event.loaded, total: event.total });
    }
    const onAbort = () => xhr.abort();
    const settle = (outcome) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      outcome === "load"
        ? resolve(xhr)
        : death();
    };
    xhr.onload = () => settle("load");
    xhr.onerror = () => settle("error");
    xhr.onabort = () => settle("abort");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });

export const api = async (path, {
  method = "GET", body, idempotencyKey, signal, internalRetry,
  onUploadProgress = null, onDownloadProgress = null,
} = {}) => {
  const headers = { Accept: "application/json" };
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (mutating && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (mutating && typeof idempotencyKey === "string" && idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  const payload = body === undefined ? undefined :
    body instanceof FormData ? body : JSON.stringify(body);
  const xhr = await request(
    path, method, headers, payload, signal, onUploadProgress, onDownloadProgress,
  );
  const response = {
    status: xhr.status,
    ok: xhr.status >= 200 && xhr.status < 300,
    headers: { get: (name) => xhr.getResponseHeader(name) },
  };
  if (response.status === 401) emit(AUTH_EVENT);
  if (response.status === 204) return null;
  let result;
  try {
    result = JSON.parse(xhr.responseText);
  } catch {
    const error = new Error(
      response.ok
        ? t("gc.errors.invalidResponse", { status: response.status })
        : t("gc.errors.requestFailed", { status: response.status }),
    );
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const message = typeof result?.error === "string" && result.error
      ? result.error // the server's own string, verbatim (G-2) — it never localizes
      : t("gc.errors.requestFailed", { status: response.status });
    // G-8: a stale CSRF token is a session refresh, never an inline error —
    // re-probe /api/me, adopt the fresh token, and retry exactly once.
    if (mutating && !internalRetry && response.status === 403
      && message.startsWith(CSRF_STALE_PREFIX)) {
      try {
        const session = await api("/api/me", { internalRetry: true });
        const fresh = typeof session?.csrfToken === "string" ? session.csrfToken : "";
        setCsrfToken(fresh);
        set({ user: session?.user || null, csrfToken: fresh });
        return api(path, { method, body, idempotencyKey, signal, internalRetry: true });
      } catch {
        // The probe itself failed; the original error surfaces below.
      }
    }
    const error = new Error(message);
    error.status = response.status;
    error.rulesGate = response.headers?.get?.("x-rules-gate") || null;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
    // Copy the JSON body's extra fields onto the error ("error", "message"
    // and "status" are skipped — they already live on the Error).
    if (result && typeof result === "object") {
      for (const [key, value] of Object.entries(result)) {
        if (key !== "error" && key !== "message" && key !== "status") error[key] = value;
      }
    }
    throw error;
  }
  return result;
};
