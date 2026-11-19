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

// Accounts routes (Phase 1, Task 3): the build stamp, registration, sign-in
// (with the TOTP second step), logout, and the /api/me read. Auth primitives —
// sessions, CSRF/same-origin gates, ban checks, Turnstile, password and TOTP
// crypto — all come from the vendored api/core leaves; this module owns only
// route dispatch, request-shape validation, and status codes.
//
// Control flow mirrors the forum's api/session.mjs registration and login
// handlers (network-ban gate → same-origin → per-route rate limit → body →
// credentials → account-ban check → TOTP branch → session mint) with the
// allow-listed FORUM_DB → GOOBER_DB substitution. Two GooberCord adaptations:
//   • No guest sessions exist yet (Phase 1 has no GET /api/session), so
//     requireCsrf's guest-cookie rotation does not apply: register/login/totp
//     keep the same-origin gate via vendored assertSameOrigin, and
//     createSession(...) is called without an oldTokenHash.
//   • The forum's session-less TOTP challenge lived in a totp_challenges
//     table; GooberCord's scoping contract permits no forum-row writes beyond
//     users/sessions/known_ips, so the challenge is a HMAC-signed STATELESS
//     token (payload {userid, expiry} + HMAC-SHA-256 tag), 5-minute TTL,
//     verified before any code check. The per-account TOTP rate limit bounds
//     code guessing exactly as the forum's limiter did.
import {
  assertSameOrigin,
  requireSignedInRead,
  requireUser,
} from "./core/auth.mjs";
import { equalConstantTime, hex, nowSeconds, randomToken, sha256Hex } from "./core/crypto.mjs";
import {
  HttpError,
  json,
  rateLimit,
  readJson,
  requireTurnstile,
  securityHeaders,
} from "./core/http.mjs";
import { hashPassword, isValidPassword, isValidPasswordPepper, verifyPassword } from "./core/passwords.mjs";
import { publicRole, ROLE_MEMBER_DB } from "./core/roles.mjs";
import { verifyTotpCode } from "./core/totp.mjs";
import { isStrictHexAccent, publicAccent } from "./accent.mjs";
import {
  isValidBanner,
  isValidFlair,
  plusPerkActive,
  publicCosmetics,
  publicPlusTier,
} from "./plus.mjs";
import { applyWordFilter, containsFilteredWord, normalizeUsernameForFilter } from "./filter.mjs";
import { ensureFilterWords, filterWords } from "./filterstore.mjs";
import { relayNetworkBanCheck, relaySet, relayVerify } from "./relay.mjs";

// The username shape rule now lives in its own shared module (the gift route's
// validation reads the same one rule): api/usernames.mjs.
import { isValidUsername } from "./usernames.mjs";

// The vendored auth core stays byte-identical to the Forum. GooberCord asks
// the Forum relay for the authoritative network-ban result so its check is
// always keyed with the Forum's pepper, independent of GC's local secret.
export async function assertGooberNetworkNotBanned(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) {
    throw new HttpError(503, "Forum network-ban verification is unavailable.");
  }
  // Tests may inject the same boolean seam; production always asks the Forum
  // relay, which hashes the address with the Forum's own pepper.
  const network = typeof env._networkBanCheck === "function"
    ? await env._networkBanCheck(request, env)
    : await relayNetworkBanCheck(env, ip);
  if (
    !network || typeof network !== "object" ||
    typeof network.banned !== "boolean" ||
    typeof network.ipHash !== "string" || !/^[0-9a-f]{64}$/.test(network.ipHash)
  ) {
    throw new HttpError(503,
      "Forum network-ban verification is unavailable. Configure the shared RELAY_TOKEN on GooberCord.");
  }
  if (network.banned) throw new HttpError(403, "This network is banned from the forum.");
  return network.ipHash;
}

// Recheck with the Forum immediately before minting, then enforce the returned
// Forum-keyed hash inside the same D1 INSERT that checks the account ban. This
// closes the preflight-to-session race: a network ban committed before this
// INSERT makes the INSERT affect zero rows, even if the earlier relay check
// returned "not banned".
//
// Why a second minter exists at all: api/core/auth.mjs is the parity-locked
// vendored copy of the forum's createSession (this repo must not diverge —
// tests/contract-parity.test.mjs). The Forum mints sessions with its OWN
// pepper-keyed IP checks; GooberCord's authoritative network verdict comes
// from the relay, so the enforcement shape differs by design and lives here,
// the one session-mint entry point GooberCord's auth routes call. The core
// copy still receives forum parity changes (guest rotation etc.) and stays
// byte-identical; it is NOT called by GooberCord routes.
export async function createGooberSession(request, env, userId) {
  const ipHash = await assertGooberNetworkNotBanned(request, env);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const csrfToken = randomToken(24);
  const now = nowSeconds();
  const expiresAt = now + 60 * 60 * 24 * 30;
  const result = await env.GOOBER_DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) " +
      "SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (" +
      "SELECT 1 FROM bans WHERE user_id = ? AND revoked_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?)) AND NOT EXISTS (" +
      "SELECT 1 FROM banned_ips bi JOIN bans b ON b.id = bi.ban_id " +
      "WHERE bi.ip_hash = ? AND b.revoked_at IS NULL " +
      "AND (b.expires_at IS NULL OR b.expires_at > ?))",
  ).bind(tokenHash, Number(userId), csrfToken, now, expiresAt,
    Number(userId), now, ipHash, now).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "This account or network is currently banned.");
  }
  try {
    await env.GOOBER_DB.prepare(
      "INSERT INTO known_ips (ip_hash, user_id, last_seen) VALUES (?, ?, ?) " +
        "ON CONFLICT(ip_hash, user_id) DO UPDATE SET last_seen = excluded.last_seen",
    ).bind(ipHash, Number(userId), now).run();
  } catch {
    /* best-effort tracking; the session and ban gate are already committed */
  }
  await env.GOOBER_DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const setCookie = "goober_session=" + token +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (60 * 60 * 24 * 30) + secure;
  return { tokenHash, csrfToken, setCookie };
}

// Timing-consistent password verification even for unknown usernames: the
// same dummy credentials the forum's session.mjs logs in against.
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_LABEL = "goobercord-totp-challenge:v1:";

function isSixDigitCode(value) {
  return typeof value === "string" && /^\d{6}$/.test(value.trim());
}

// Backup codes (v4.8.1): the Discord-style single-use sign-in codes used
// INSTEAD of the authenticator code when the app is lost or renamed. The raw
// code is randomToken(6) — exactly 8 base64url chars, the same call that mints
// single-use invite tokens — and only its SHA-256 hash is stored in the shared
// forum-owned totp_backup_codes table (migrated by the forum repo, migration
// 0042); the raw list rides the generation response exactly once and is never
// shown or stored again. GC's login step accepts both families through ONE
// verify helper, so a wrong code never reveals which family it resembled.
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_PATTERN = /^[A-Za-z0-9_-]{8}$/;

// One answer shape for every code prompt: trimmed here so a stray space can't
// fail an honest paste.
function codeAnswer(value) {
  return typeof value === "string" && value.length <= 128 ? value.trim() : "";
}

// The single verify helper every code-or-backup-code confirmation rides (the
// login step and the backup-set generation's re-auth): a 6-digit input
// verifies against the live secret; an 8-char base64url input burns in ONE
// guarded statement — DELETE ... AND used_at IS NULL — and 1 changed row is
// the only accept. Each shape's failure is the same boolean false, so a wrong
// code can never reveal which family a real code would have belonged to.
async function verifyCodeAnswer(db, userId, secret, code) {
  if (isSixDigitCode(code)) {
    return verifyTotpCode(secret, code, nowSeconds());
  }
  if (BACKUP_CODE_PATTERN.test(code)) {
    const burned = await db.prepare(
      "DELETE FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    ).bind(userId, await sha256Hex(code)).run();
    return Number(burned.meta?.changes) === 1;
  }
  return false;
}

// GooberCord's management surface for the backup codes: minting a new set
// invalidates the old one — the delete and the fresh inserts ride ONE batch,
// so an interrupted generation can never leave half a set behind. The
// response carries the RAW codes exactly once; only their SHA-256 hashes are
// ever stored. The current password re-proofs the member, a member with 2FA
// on also proves possession with the authenticator's 6-digit code OR an
// unburned backup code via the one shared helper (the lost-authenticator
// flow: sign in with a backup code, then mint a fresh set with another).
async function handleTotpBackupsGenerateRoute(request, env) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "totp", "user:" + Number(session.user.id));
  const body = await readJson(request);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (currentPassword.length < 1 || currentPassword.length > 128) {
    throw new HttpError(400, "Enter your current password to generate new backup codes.");
  }
  const row = await env.GOOBER_DB.prepare(
    "SELECT totp_enabled, totp_secret, password_salt, password_hash FROM users WHERE id = ? LIMIT 1",
  ).bind(Number(session.user.id)).first();
  if (!row) throw new HttpError(404, "Your account could not be found.");
  if (!(await verifyPassword(currentPassword, row.password_salt, row.password_hash, env.PASSWORD_PEPPER))) {
    throw new HttpError(401, "Your current password is incorrect.");
  }
  if (Number(row.totp_enabled) === 1 && row.totp_secret) {
    const code = codeAnswer(body.code);
    if (!code) {
      throw new HttpError(400, "Enter the 6-digit code from your authenticator app, or a backup code.");
    }
    if (!(await verifyCodeAnswer(env.GOOBER_DB, Number(session.user.id), row.totp_secret, code))) {
      throw new HttpError(401, "That code is not correct. Nothing has been changed.");
    }
  }
  const codes = [];
  const statements = [
    env.GOOBER_DB.prepare("DELETE FROM totp_backup_codes WHERE user_id = ?")
      .bind(Number(session.user.id)),
  ];
  for (let index = 0; index < BACKUP_CODE_COUNT; index++) {
    const raw = randomToken(6);
    codes.push(raw);
    statements.push(
      env.GOOBER_DB.prepare(
        "INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)",
      ).bind(Number(session.user.id), await sha256Hex(raw), nowSeconds()),
    );
  }
  await env.GOOBER_DB.batch(statements);
  return json({ codes });
}

// base64url codecs local to the signed challenge token (crypto.mjs keeps its
// own private one; these stay internal to this module).
function b64urlEncode(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(text) {
  const base64 =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// TOTP challenges are always HMAC-signed with the Forum-matching
// PASSWORD_PEPPER. There is deliberately no unkeyed development fallback.
async function challengeMac(env, payloadB64) {
  const data = new TextEncoder().encode(CHALLENGE_LABEL + payloadB64);
  if (!isValidPasswordPepper(env.PASSWORD_PEPPER)) {
    // A TOTP challenge is a password-first capability. Never fall back to an
    // unkeyed digest: anyone could mint a challenge and skip password proof.
    throw new HttpError(503, "TOTP challenge signing is not configured. Set the matching PASSWORD_PEPPER.");
  }
  {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.PASSWORD_PEPPER),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
  }
}

// Minted by the login route only after a VERIFIED password: the plaintext
// token rides the login response, nothing about it is stored anywhere.
async function issueTotpChallenge(env, userId) {
  const payloadB64 = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ v: 1, u: Number(userId), e: nowSeconds() + CHALLENGE_TTL_SECONDS }),
    ),
  );
  return payloadB64 + "." + (await challengeMac(env, payloadB64));
}

async function readChallenge(env, token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) return null;
  const separator = token.indexOf(".");
  if (separator < 0) return null;
  const payloadB64 = token.slice(0, separator);
  const mac = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[0-9a-f]{64}$/.test(mac)) return null;
  // The tag is checked before the payload is even parsed — no forged-JSON
  // oracle, and the comparison runs in constant time.
  if (!equalConstantTime(await challengeMac(env, payloadB64), mac)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64urlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1) return null;
  const userId = Number(payload.u);
  const expiresAt = Number(payload.e);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds()) return null;
  return { userId, expiresAt };
}

// Test seam (Phase 1): real deployments always run the vendored
// requireTurnstile, which calls Cloudflare's siteverify endpoint. Tests inject
// `env._turnstileVerify` — a function with the same (request, env, body,
// expectedAction) signature — so account tests never touch the network. The
// vendored core is untouched, so the contract-parity pin keeps holding, and
// production code paths are unchanged (no override in a real deployment).
async function requireRegisterTurnstile(request, env, body) {
  if (typeof env._turnstileVerify === "function") {
    await env._turnstileVerify(request, env, body, "register");
    return;
  }
  await requireTurnstile(request, env, body, "register");
}

function validateNewCredentials(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!isValidUsername(username)) {
    throw new HttpError(400, "Username must be 3–24 characters and use only letters, numbers, and underscores.");
  }
  if (!isValidPassword(body.password)) {
    throw new HttpError(400, "Password must be 12–128 characters long.");
  }
  return { username, usernameKey: username.toLowerCase(), password: body.password };
}

// The forum's registration INSERT (session.mjs storeUser, member branch) with
// only the allow-listed substitutions: GOOBER_DB instead of FORUM_DB. Column
// list and the CHECK-constraint-satisfying shape are the forum's verbatim.
async function storeUser(env, credentials) {
  const password = await hashPassword(credentials.password, env.PASSWORD_PEPPER);
  const now = nowSeconds();
  try {
    const result = await env.GOOBER_DB.prepare(
      "INSERT INTO users (username, username_key, password_salt, password_hash, role, bio, created_at) " +
        "VALUES (?, ?, ?, ?, ?, '', ?)",
    ).bind(credentials.username, credentials.usernameKey, password.salt, password.hash, ROLE_MEMBER_DB, now).run();
    return await env.GOOBER_DB.prepare(
      "SELECT id, username, username_key, password_salt, password_hash, role, bio, " +
        "avatar_status, avatar_mime, avatar_updated_at, avatar_version, totp_enabled " +
        "FROM users WHERE id = ? LIMIT 1",
    ).bind(Number(result.meta.last_row_id)).first();
  } catch (error) {
    // Same duplicate-username diagnosis as the forum: the unique index on
    // username_key fails the insert, and the pre-existing row (if any) turns
    // it into a user-facing 409 instead of a 500.
    const existing = await userByUsernameKey(env, credentials.usernameKey);
    if (existing) throw new HttpError(409, "That username is already taken.");
    throw error;
  }
}

// The login-shaped user projection, one query shape everywhere a user is
// fetched by username_key (login, register's duplicate check, the TOTP step).
// Same public user shape the vendored readSession builds: role comes through
// publicRole (never feed it a public value), avatarUrl matches the shared
// sessions read.
// Exported for the SSO redeem: the shared-DB member lookup behind the mint
// (the accounts worker names the member; GC's own users row is the truth).
export async function userByUsernameKey(env, key) {
  return env.GOOBER_DB.prepare(
    "SELECT id, username, username_key, password_salt, password_hash, role, bio, " +
      "avatar_status, avatar_mime, avatar_updated_at, avatar_version, totp_enabled " +
      "FROM users WHERE username_key = ? LIMIT 1",
  ).bind(key).first();
}

export function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    role: publicRole(row.role),
    bio: row.bio || "",
    avatarStatus: row.avatar_status || null,
    avatarUrl: row.avatar_mime
      ? "/api/avatars/" + row.id + "?v=" + row.avatar_version
      : null,
    totpEnabled: Number(row.totp_enabled) === 1,
  };
}

// The active-ban screen read, shared by the password login above and the SSO
// redeem (api/sso.mjs): the ban payload (reason/expiresAt) is only ever
// composed for an already-proven member (login proves the password, SSO the
// accounts worker's ticket) — an unproven caller never reaches this row.
export async function activeBanRow(env, userId) {
  return env.GOOBER_DB.prepare(
    "SELECT reason, expires_at FROM bans WHERE user_id = ? AND revoked_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
  ).bind(Number(userId), nowSeconds()).first();
}

// Goober+ perks profile fields (accent + tagline). The accent is a validated
// lowercase hex string, the tagline a bounded string — both additive, both
// NULL means "not set". Absent keys in the request body KEEP the stored
// value; null clears. Every read echoes the values back through the same
// validator, so the wire always carries a strict hex accent or null.
const TAGLINE_MAX = 80;

// Exported for the SSO redeem's /api/me-shaped user payload (the same
// composition handleMeRoute uses below).
export function userAccentColorTagline(row) {
  return {
    accentColor: publicAccent(row?.accent_color),
    tagline:
      row && typeof row.tagline === "string" && row.tagline.length > 0 && row.tagline.length <= TAGLINE_MAX
        ? row.tagline
        : null,
  };
}

async function handleProfilePatchRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "profile:" + userId);
  const body = await readJson(request);

  // SET clauses built only from the fields the request actually carries —
  // an absent key keeps the stored value without ever reading it first.
  const sets = [];
  const binds = [];
  if (body.accentColor !== undefined) {
    if (body.accentColor === null) {
      sets.push("accent_color = NULL");
    } else if (isStrictHexAccent(body.accentColor)) {
      sets.push("accent_color = ?");
      binds.push(body.accentColor);
    } else {
      throw new HttpError(400, "Accent color must be a lowercase #rgb or #rrggbb hex color.");
    }
  }
  if (body.tagline !== undefined) {
    const tagline = typeof body.tagline === "string" ? body.tagline.trim() : null;
    if (tagline === null || tagline === "") {
      // An empty/whitespace tagline clears, exactly like null.
      sets.push("tagline = NULL");
    } else if (tagline.length > TAGLINE_MAX) {
      throw new HttpError(400, "Tagline must be 80 characters or fewer.");
    } else {
      sets.push("tagline = ?");
      binds.push(tagline);
    }
  }

  if (sets.length > 0) {
    await env.GOOBER_DB.prepare(
      "UPDATE users SET " + sets.join(", ") + " WHERE id = ?",
    ).bind(...binds, userId).run();
  }

  // The response echoes the STORED row (the same values a later /api/me read
  // returns), never the request verbatim.
  const row = await env.GOOBER_DB.prepare(
    "SELECT accent_color, tagline FROM users WHERE id = ? LIMIT 1",
  ).bind(userId).first();
  return json({ profile: userAccentColorTagline(row) });
}

// The Goober+ cosmetics PATCH (the 2026-11-17 Nitro-perks contract; migration
// 0013's table). Write path only — reads fold into /api/me and stay public.
// The gate rides the STRICT perk predicate (grace = perks off) and fires only
// on a non-null SET: a lapsed term must still be able to CLEAR its own
// banner/flair (the filed contract's "clearing stays always-legal"), while an
// equip still gets the same refusal as a non-buyer — and never a
// "your banner color was invalid" oracle, since the gate precedes every
// validator.
async function handleCosmeticsPatchRoute(request, env) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  await rateLimit(request, env, "write", "cosmetics:" + userId);
  const body = await readJson(request);
  if (
    ((body.banner !== undefined && body.banner !== null) ||
      (body.flair !== undefined && body.flair !== null)) &&
    !(await plusPerkActive(env, userId, nowSeconds()))
  ) {
    throw new HttpError(403, "Those are Goober+ perks. Get Goober+ in the coin shop to use them.");
  }

  // SET clauses built only from the fields the request actually carries —
  // an absent key keeps the stored value without ever reading it first;
  // null clears. Validators are plus.mjs's (strict hex / strict flair text).
  // The ECONOMY RE-RULE gate: equipping banner/flair requires OWNERSHIP
  // (0019, purchased in the coin shop); clearing stays always-legal, and
  // accent + tagline never touched this route. The refusals happen BEFORE
  // any validation oracle, so an unowned member can't probe the shape.
  const ownedItems = body.banner !== undefined || body.flair !== undefined
    ? new Set(((await env.GOOBER_DB.prepare(
        "SELECT item FROM gc_cosmetic_ownership WHERE user_id = ?",
      ).bind(userId).all()).results || []).map((row) => String(row.item || "")))
    : new Set();
  if (body.banner !== undefined && body.banner !== null && !ownedItems.has("banner")) {
    throw new HttpError(403, "Buy that cosmetic in the coin shop first.");
  }
  if (body.flair !== undefined && body.flair !== null && !ownedItems.has("flair")) {
    throw new HttpError(403, "Buy that cosmetic in the coin shop first.");
  }
  const sets = [];
  const binds = [];
  if (body.banner !== undefined) {
    if (body.banner === null) {
      sets.push("banner_color = NULL");
    } else if (isValidBanner(body.banner)) {
      sets.push("banner_color = ?");
      binds.push(body.banner);
    } else {
      throw new HttpError(400, "Banner color must be a lowercase #rgb or #rrggbb hex color.");
    }
  }
  if (body.flair !== undefined) {
    if (body.flair === null) {
      sets.push("flair_text = NULL");
    } else if (isValidFlair(body.flair)) {
      sets.push("flair_text = ?");
      binds.push(body.flair.trim());
    } else {
      throw new HttpError(400, "Flair must be 2 to 16 characters, one line.");
    }
  }

  if (sets.length > 0) {
    await env.GOOBER_DB.prepare(
      "INSERT INTO gc_cosmetics (user_id, banner_color, flair_text, updated_at) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO NOTHING",
    ).bind(userId, null, null, nowSeconds()).run();
    await env.GOOBER_DB.prepare(
      "UPDATE gc_cosmetics SET " + sets.join(", ") + ", updated_at = ? WHERE user_id = ?",
    ).bind(...binds, nowSeconds(), userId).run();
  }

  // The response echoes the STORED row (the same values a later /api/me read
  // returns), never the request verbatim.
  const row = await env.GOOBER_DB.prepare(
    "SELECT banner_color, flair_text FROM gc_cosmetics WHERE user_id = ? LIMIT 1",
  ).bind(userId).first();
  return json({ cosmetics: publicCosmetics(row) });
}

function expiredCookie(request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return "goober_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secure;
}

// The footer version stamp (contract from the plan): both values come from the
// deployment itself (wrangler [vars] and the deploy script's --var), echoed
// back verbatim; unset vars fall back to empty strings. The stale-build
// feature's client compares this against the stamped <meta> build.
async function handleVersionRoute(env) {
  return json({
    version: typeof env.VERSION === "string" ? env.VERSION : "",
    build: typeof env.COMMIT_SHA === "string" ? env.COMMIT_SHA : "",
  });
}

async function handleMeRoute(request, env) {
  const session = await requireSignedInRead(request, env);
  // The vendored readSession shape is the single source — and it is pinned
  // byte-for-byte by tests/contract-parity.test.mjs, so the Goober+ perks
  // fields CANNOT ride its SELECT. They land here instead, as one additive
  // read of the signed-in member's own row; everything the session carried
  // is returned unchanged, the added keys ride the additive shape.
  if (session.user) {
    const now = nowSeconds();
    const userId = Number(session.user.id);
    const [perks, cosmeticsRow, plusRow] = await Promise.all([
      env.GOOBER_DB.prepare(
        "SELECT accent_color, tagline FROM users WHERE id = ? LIMIT 1",
      ).bind(userId).first(),
      // The Goober+ cosmetics row (0013): GC-owned, absence is the shape.
      env.GOOBER_DB.prepare(
        "SELECT banner_color, flair_text FROM gc_cosmetics WHERE user_id = ? LIMIT 1",
      ).bind(userId).first(),
      // The badge/perk truth: the strict active term (renews_until > now) —
      // grace members keep a lapsed badge with perks OFF. api/plus.mjs's
      // two-predicate note explains the split from publicPlus's display.
      // The tier rides the SAME row (wave-19: the upload tiers' client face —
      // me.plusTier seats the composer's tier mirrors; no row, no key). The
      // 0022 legacy NULL tier folds read-side (publicPlusTier) — a full
      // member's mirror never absents under the server's 1 GiB lane.
      // POSITIONAL binds (the fleet's universal idiom) — the named-bind
      // object form this seat briefly rode 500'd real prod D1 while the
      // fakeDb suite passed (the owner's Nov 19 blank-shell report): a
      // real-D1-only novel API surface never rides a route again.
      env.GOOBER_DB.prepare(
        "SELECT renews_until > ? AS active, tier AS plusTier FROM gc_plus_state WHERE user_id = ? LIMIT 1",
      ).bind(now, userId).first(),
    ]);
    const cosmetics = publicCosmetics(cosmeticsRow);
    const user = {
      ...session.user,
      ...userAccentColorTagline(perks),
      isPlus: Boolean(plusRow?.active),
      // The upload tiers' seat (wave-19): only an ACTIVE term's tier paints —
      // a lapsed term answers the strict-active law, absence adds no key
      // (the accent pair's idiom). The NULL tier folds to "plus"
      // (publicPlusTier): the legacy rows read full, never absent. The
      // SELECT aliases the column (tier AS plusTier) — the row-based helper
      // sees the aliased key through the { tier } wrapper, never a silent
      // undefined fold.
      ...(plusRow?.active ? { plusTier: publicPlusTier({ tier: plusRow.plusTier }) } : {}),
      // Additive, the accent pair's idiom: an unset banner/flair adds NO key
      // (the 0005 shape is untouched for a member who never decorated).
      ...(cosmetics.banner !== null ? { banner: cosmetics.banner } : {}),
      ...(cosmetics.flair !== null ? { flair: cosmetics.flair } : {}),
    };
    return json({ user, csrfToken: session.csrfToken });
  }
  return json({ user: session.user, csrfToken: session.csrfToken });
}

async function handleLoginRoute(request, env) {
  // IP bans: refused up front, before any password work (no oracle, no PBKDF2
  // burn) — exactly the forum registration/login ordering.
  await assertGooberNetworkNotBanned(request, env);
  assertSameOrigin(request);
  await rateLimit(request, env, "login");
  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!isValidUsername(username) || password.length < 1 || password.length > 128) {
    throw new HttpError(400, "Enter your username and password.");
  }
  await rateLimit(request, env, "login", "account:" + username.toLowerCase());
  const user = await userByUsernameKey(env, username.toLowerCase());
  // Prefer local verification; if the local pepper is absent or has
  // drifted, the Forum relay can verify the shared-table hash. Network bans
  // were already checked by the Forum itself using its own pepper above.
  const hasLocalPepper = isValidPasswordPepper(env.PASSWORD_PEPPER);
  let valid = hasLocalPepper && await verifyPassword(
    password,
    user ? user.password_salt : DUMMY_SALT,
    user ? user.password_hash : DUMMY_HASH,
    env.PASSWORD_PEPPER,
  );
  if (!valid) {
    const relayed = await relayVerify(env, username, password);
    if (relayed?.valid === true) {
      valid = true;
    } else if (relayed === null) {
      throw new HttpError(503,
        "Password verification is unavailable. Check PASSWORD_PEPPER and credential relay configuration.");
    }
  }
  if (!user || !valid) throw new HttpError(401, "The username or password is incorrect.");
  // The ban screen payload is only readable with verified credentials; the
  // generic 401 above already answered invalid ones without touching this row.
  // Bans surface BEFORE the 2FA branch — a banned 2FA member must see the ban
  // screen without any code work (requireUnbanned keeps re-checking on the
  // session step, so a ban landing after this point still blocks it). The
  // read itself is the shared activeBanRow (the SSO redeem refuses with the
  // same shape).
  const bannedMessage = "This account is currently banned.";
  const activeBan = await activeBanRow(env, user.id);
  if (activeBan) {
    throw new HttpError(403, bannedMessage, {}, {
      error: bannedMessage,
      banned: true,
      reason: activeBan.reason,
      expiresAt: activeBan.expires_at === null || activeBan.expires_at === undefined
        ? null
        : Number(activeBan.expires_at),
    });
  }
  // Two-factor sits between the ban check and the session mint: members with
  // 2FA on get a short-lived signed challenge (the plaintext rides this
  // response, nothing is stored) and NO cookie — POST /api/auth/totp finishes
  // sign-in.
  const hasTotp = await env.GOOBER_DB.prepare(
    "SELECT totp_secret FROM users WHERE id = ? AND totp_enabled = 1 AND totp_secret IS NOT NULL LIMIT 1",
  ).bind(Number(user.id)).first();
  if (hasTotp) {
    const challenge = await issueTotpChallenge(env, Number(user.id));
    return json({ totpRequired: true, challenge }, 200);
  }
  const session = await createGooberSession(request, env, Number(user.id));
  return json({ user: publicUser(user), csrfToken: session.csrfToken }, 200, {
    "Set-Cookie": session.setCookie,
  });
}

async function handleRegistrationRouteBody(request, env) {
  assertSameOrigin(request);
  await rateLimit(request, env, "register");
  // IP bans: before any credential work, so the response carries no oracle.
  await assertGooberNetworkNotBanned(request, env);
  const body = await readJson(request);
  // Request-shape validation precedes the human check (Phase 1 brief step 1e):
  // a malformed username or password is rejected with no siteverify call and
  // no D1 work. Username/password rules are public client-side checks — no
  // oracle either way — so this only saves the siteverify round trip.
  const credentials = validateNewCredentials(body);
  // Username word-filter parity (Task 3 carry, forum api/session.mjs): a
  // username is identity, never prose, so ANY filter alteration (masking) or
  // a normalized (leet/skeleton) match rejects registration with the forum's
  // verbatim copy — it never hints at the private list. The forum's check
  // sits right after credential validation; GC keeps that spot (its
  // shape-validation-first ordering), and with an effective EMPTY list the
  // two filter passes are a strict no-op here exactly like they are in the
  // forum's register flow.
  await ensureFilterWords(env);
  if (
    applyWordFilter(credentials.username, filterWords(env)) !== credentials.username ||
    containsFilteredWord(normalizeUsernameForFilter(credentials.username), filterWords(env))
  ) {
    throw new HttpError(400, "That username isn't allowed.");
  }
  await requireRegisterTurnstile(request, env, body);
  const user = await storeUser(env, credentials);
  // Pepper convergence: the hash just written is under GC's local pepper, so
  // also re-store it through the credential relay — the forum pepper is the
  // one both apps verify against. Best-effort: a relay hiccup leaves the
  // local-pepper hash, which still verifies on GC via relayVerify fallback.
  await relaySet(env, credentials.username, credentials.password);
  // createGooberSession's atomic INSERT re-checks the account-and-network
  // ban gates; a landing ban makes the INSERT affect zero rows, which the
  // shared 403 surfaces (no cookie).
  const session = await createGooberSession(request, env, Number(user.id));
  return json({ user: publicUser(user), csrfToken: session.csrfToken }, 201, {
    "Set-Cookie": session.setCookie,
  });
}

async function handleTotpRoute(request, env) {
  assertSameOrigin(request);
  await assertGooberNetworkNotBanned(request, env);
  // Per-IP pass first: a constant actor here must not collapse every visitor
  // into one bucket (any origin-post can reach this endpoint). Brute force per
  // account is bounded by the user-keyed pass after the challenge check. Both
  // passes ride every attempt — a backup code is verified against the same
  // limiter tier the 6-digit path uses.
  await rateLimit(request, env, "totp", "");
  const body = await readJson(request);
  const token = typeof body.challenge === "string" ? body.challenge : "";
  // One code field, two families (the coordinator's format contract): the
  // authenticator's 6-digit code or an 8-char base64url backup code. The
  // dispatch happens in the shared verify helper below, after the signature
  // and expiry checks.
  const code = codeAnswer(body.code);
  if (!token || !code) {
    throw new HttpError(400, "Enter the 6-digit code from your authenticator app, or a backup code.");
  }
  // Signature and expiry first, then the per-account limiter — the actor key
  // is an application-controlled value, never request parameters.
  const challenge = await readChallenge(env, token);
  if (!challenge) {
    throw new HttpError(401, "This verification request has expired. Sign in again.");
  }
  await rateLimit(request, env, "totp", "user:" + challenge.userId);
  // Direct select: exactly the 2FA columns, then the full login-shaped row by
  // username_key only to render the same public user payload the password-first
  // login returns.
  const keyRow = await env.GOOBER_DB.prepare(
    "SELECT username_key, totp_enabled, totp_secret FROM users WHERE id = ? LIMIT 1",
  ).bind(challenge.userId).first();
  if (!keyRow || Number(keyRow.totp_enabled) !== 1 || !keyRow.totp_secret) {
    throw new HttpError(401, "This verification request has expired. Sign in again.");
  }
  const user = await userByUsernameKey(env, keyRow.username_key);
  if (!user) {
    throw new HttpError(401, "This verification request has expired. Sign in again.");
  }
  if (!(await verifyCodeAnswer(env.GOOBER_DB, challenge.userId, keyRow.totp_secret, code))) {
    throw new HttpError(401, "That code is not correct.");
  }
  // createGooberSession's atomic INSERT re-checks the ban gates, so a ban
  // landing between password and code still can't mint a session.
  const session = await createGooberSession(request, env, challenge.userId);
  return json({ user: publicUser(user), csrfToken: session.csrfToken }, 200, {
    "Set-Cookie": session.setCookie,
  });
}

async function handleLogoutRoute(request, env) {
  const session = await requireUser(request, env);
  await env.GOOBER_DB.prepare(
    "DELETE FROM sessions WHERE token_hash = ?",
  ).bind(session.tokenHash).run();
  return new Response(null, {
    status: 204,
    headers: securityHeaders(new Headers({
      "Cache-Control": "no-store",
      "Set-Cookie": expiredCookie(request),
    })),
  });
}

// Owner-tier password reset (pepper rescue): accounts minted under an earlier
// GC pepper can't verify on either worker, so the owner can re-issue a
// password through the credential relay — the written hash lands under the
// forum pepper and verifies everywhere. Owner-only (public role 'owner',
// stored 'admin'): letting everyone re-issue passwords would be an account
// takeover primitive.
async function handleAdminResetPasswordRoute(request, env) {
  const session = await requireUser(request, env);
  await rateLimit(request, env, "write", "admin-reset:" + Number(session.user.id));
  if (session.user.role !== "owner") {
    throw new HttpError(403, "Only the owner can reset a password.");
  }
  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!isValidUsername(username) || !isValidPassword(password)) {
    throw new HttpError(400, "Enter a username and a 12–128 character password.");
  }
  const relayed = await relaySet(env, username, password);
  if (!relayed) {
    throw new HttpError(503, "Password reset relay is not available. Try again shortly.");
  }
  // Stolen-session containment (haywire-4 auth): the reset must not leave the
  // victim's other sessions alive for their full 30-day TTL. The acting
  // owner's OWN token is spared (token_hash <>) so the admin isn't logged out
  // mid-operation; a victim who has the owner's reset flow open in another tab
  // (reset target = own account) keeps exactly that one session too. No
  // Set-Cookie rides this route for the victim — the server-side DELETE is the
  // revocation, and the victim's next request 401s.
  const victim = await userByUsernameKey(env, username.toLowerCase());
  if (victim) {
    await env.GOOBER_DB.prepare(
      "DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?",
    ).bind(Number(victim.id), session.tokenHash).run();
  }
  return json({ reset: true, user: relayed.user });
}

export async function handleAccountRoutes(request, env, url, path, method, ctx) {
  // ctx (the worker's execution context) is accepted to complete the dispatch
  // loop's handler signature; these routes schedule no background work today.
  void url;
  void ctx;

  if (path === "/api/version" && method === "GET") {
    return handleVersionRoute(env);
  }
  if (path === "/api/me" && method === "GET") {
    return handleMeRoute(request, env);
  }
  if (path === "/api/profile" && method === "PATCH") {
    return handleProfilePatchRoute(request, env);
  }
  if (path === "/api/me/cosmetics" && method === "PATCH") {
    return handleCosmeticsPatchRoute(request, env);
  }
  if (path === "/api/auth/register" && method === "POST") {
    return handleRegistrationRouteBody(request, env);
  }
  if (path === "/api/auth/login" && method === "POST") {
    return handleLoginRoute(request, env);
  }
  if (path === "/api/auth/totp" && method === "POST") {
    return handleTotpRoute(request, env);
  }
  if (path === "/api/me/totp/backups/generate" && method === "POST") {
    return handleTotpBackupsGenerateRoute(request, env);
  }
  if (path === "/api/auth/logout" && method === "POST") {
    return handleLogoutRoute(request, env);
  }
  if (path === "/api/admin/reset-password" && method === "POST") {
    return handleAdminResetPasswordRoute(request, env);
  }
  return undefined;
}
