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

// Credential relay client (login-parity rescue): GooberCord's password
// pepper lives in a wrangler secret that is NOT guaranteed to equal the
// forum's PASSWORD_PEPPER — and when the values drifted, members could not
// sign in on either side while the forum itself stayed healthy. Both apps
// share one D1 users table, so instead of betting on the secrets, GC
// delegates credential work to the forum worker over a token-gated relay
// (api/relay.mjs on the forum side):
//   relayVerify → "are these credentials correct under the forum pepper?"
//   relaySet    → "store this new password under the forum pepper"
// relaySet on register/convergence writes fresh hashes under the forum
// pepper, so a hash written by GC verifies on the forum and vice versa.
// The token is the whole auth (RELAY_TOKEN secret on both workers);
// responses carry no credential material — ids, usernames, and roles only.
// Every call degrades gracefully: an unconfigured/absent RELAY_TOKEN (or an
// unreachable forum) returns null and callers keep their existing behavior.
const RELAY_ORIGIN = "https://wempos-forum.itswempo.workers.dev";
const RELAY_TIMEOUT_MS = 10_000;
// Same-zone subrequests from GC to a SIBLING workers.dev script 404 at the
// edge without entering the forum worker, so THIS absolute URL rides inside
// a service binding fetch only.
const RELAY_INTERNAL_ORIGIN = "https://relay.internal";

async function relayCall(env, path, body) {
  if (!env.RELAY_TOKEN || typeof env.RELAY_TOKEN !== "string") return null;

  let response;
  try {
    // Request/Headers construction can itself throw for malformed secret
    // values (for example, a newline in X-Relay-Token). Keep it inside the
    // guarded block so bad configuration degrades to an unavailable relay.
    const request = new Request(RELAY_INTERNAL_ORIGIN + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Token": env.RELAY_TOKEN,
        // The calling worker's declared identity: the forum keys its shared
        // throttle buckets per-worker on this slug (no browser IP rides a
        // service-binding call). A convenience stamp, NOT an auth boundary —
        // the relay token is the whole auth.
        "X-Relay-Worker": "goobercord",
      },
      body: JSON.stringify(body),
    });
    const binding = env.FORUM_WORKER;
    if (binding && typeof binding.fetch === "function") {
      // Production: direct worker-to-worker invocation, no edge routing.
      response = await binding.fetch(request, {
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } else {
      // Dev without the binding: plain internet fetch to the forum.
      response = await fetch(RELAY_ORIGIN + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Token": env.RELAY_TOKEN,
          // Same stamp on the dev-without-binding fallback lane.
          "X-Relay-Worker": "goobercord",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    }
  } catch {
    return null; // forum unreachable — fall back to local behavior
  }

  if (!response.ok) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function relayNetworkBanCheck(env, ip) {
  const result = await relayCall(env, "/api/relay/network-ban-check", { ip });
  if (
    !result || typeof result !== "object" ||
    typeof result.banned !== "boolean" ||
    typeof result.ipHash !== "string" || !/^[0-9a-f]{64}$/.test(result.ipHash)
  ) return null;
  return { banned: result.banned, ipHash: result.ipHash };
}

export async function relayVerify(env, username, password) {
  const result = await relayCall(env, "/api/relay/password-verify", { username, password });
  // A 200 response is not a successful verification unless the contract is
  // exactly { valid: boolean }. Treat malformed payloads as unavailable.
  if (!result || typeof result !== "object" || typeof result.valid !== "boolean") return null;
  return result;
}

export async function relaySet(env, username, password) {
  return relayCall(env, "/api/relay/password-set", { username, password });
}
