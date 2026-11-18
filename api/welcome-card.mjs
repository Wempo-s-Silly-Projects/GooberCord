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

// T92: Server Welcome Card (docs/drafts/t92-welcome-card-spec.md) — the
// server's own greeting. A server's mods write a short blurb once; every
// member who then visits can pull that blurb exactly once — a private,
// member-self-recorded greeting (the view row's only writer is the member's
// own GET).
//
// LAWS: defaults law — absence of the gc_welcome_cards row IS the off-state
// (the 0037 idiom): no row, no card, nothing fires for the asking member.
// The blurb is member-authored server content: stored verbatim, painted
// verbatim, never translated or rewritten server-side (locale law, spec §5).
// The once-shown silence is the member's OWN (spec §1) — ?repeat=1 is their
// explicit re-show. Sink law N/A (spec §6) — the card mints and sinks
// nothing; view rows are the only new writes in the whole feature.
import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson } from "./core/http.mjs";
import { GC_WELCOME_CARD_BLURB_MAX } from "../constants.mjs";

// --- the SQL (spec §4's pinned statement-gate shapes and bind orders) ---------

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The off-state read: the config row IS the seat; no row = the surface does
// not exist for this server (the 404's own WHERE — absence of the row IS the
// off-state, never a separate "no card" body).
const CARD_READ_SQL =
  "SELECT blurb_text FROM gc_welcome_cards WHERE server_id = ? LIMIT 1";

// The shown-once ledger read: only the fetching member's own view row — no
// cross-member read, no mod override, no aggregate.
const VIEW_READ_SQL =
  "SELECT shown_at FROM gc_welcome_card_views WHERE server_id = ? AND user_id = ? LIMIT 1";

// The view row's ONLY write: the fetching member's own GET records it. The
// route's membership pre-read already 404s non-members, so this statement
// never fires for an outsider (spec §3's member-self-recorded contract).
// DO NOTHING on the (server_id, user_id) key makes two concurrent first
// GETs idempotent — both serve the fetched blurb, no UNIQUE-constraint 500.
// Bind contract: [server_id, user_id, shown_at].
const VIEW_INSERT_SQL =
  "INSERT INTO gc_welcome_card_views (server_id, user_id, shown_at) VALUES (?, ?, ?) " +
  "ON CONFLICT (server_id, user_id) DO NOTHING";

// The mod-gated upsert (spec §4, the T89-ruled BOTH-ARMS gate): the role
// gate lives INSIDE the statement on BOTH paths — the fresh-INSERT arm's
// SELECT..WHERE EXISTS and the conflict arm's DO UPDATE WHERE EXISTS each
// carry the owner/moderator check, so neither the first write nor an
// overwrite can be driven by a non-mod. A zero-row SELECT (the fresh-arm
// gate) makes changes-0, classified to the shared unknown-server 404, never
// a 403 existence oracle. ON conflict the row refreshes in place — one row
// per server, ever. Bind contract pins the RED fake's read order: bound[0]
// server_id, bound[1] blurb, bound[3] the fresh-arm gate's actor_id.
const CARD_UPSERT_SQL =
  "INSERT INTO gc_welcome_cards (server_id, blurb_text, enabled) " +
  "SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator')) " +
  "ON CONFLICT (server_id) DO UPDATE SET blurb_text = excluded.blurb_text, enabled = 1 " +
  "WHERE EXISTS (SELECT 1 FROM gc_server_members pm " +
    "WHERE pm.server_id = ? AND pm.user_id = ? AND pm.role IN ('owner','moderator'))";
// .bind(server_id, blurb, server_id, actor_id,  server_id, actor_id)
//   — 6 binds; slots [0],[1],[3] stay the RED pin's (server_id, blurb, actor_id)

// --- the gates ----------------------------------------------------------------

// The shared unknown-server 404 body: non-member, unknown id, and
// unconfigured card are indistinguishable to the asker (the paper family
// answer, api/paper.mjs:146).
const SHARED_UNKNOWN_404 = "This server does not exist or you cannot view it.";

async function membershipGate(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) throw new HttpError(404, SHARED_UNKNOWN_404);
  return userId;
}

// --- the routes ----------------------------------------------------------------

export async function handleWelcomeCardRoutes(request, env, url, path, method, ctx) {
  void ctx;

  const cardMatch = (method === "GET" || method === "PUT")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/welcome-card$/)
    : null;
  if (!cardMatch) return undefined;
  const serverId = Number(cardMatch[1]);
  return method === "PUT"
    ? handleWelcomeCardPutRoute(request, env, serverId)
    : handleWelcomeCardGetRoute(request, env, url, serverId);
}

// PUT /api/servers/:id/welcome-card { blurb } — the mod's write. The blurb
// cap check rides ahead of every seat statement (the validation family); the
// mod gate lives INSIDE the upsert's WHERE, so a non-mod's intent fires the
// statement once and gates itself — changes-0 classified to the shared
// unknown-server 404, never a 403 oracle.
async function handleWelcomeCardPutRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const blurb = body ? body.blurb : undefined;
  // Empty and whitespace-only blurbs ride the same 400 family as over-max —
  // the cap arm checks emptiness (on the trim) BEFORE the length bound; the
  // stored text itself stays verbatim, never trimmed.
  if (typeof blurb !== "string" || blurb.trim() === "" ||
    blurb.length > GC_WELCOME_CARD_BLURB_MAX) {
    throw new HttpError(400,
      "A welcome card blurb is text of up to " + GC_WELCOME_CARD_BLURB_MAX + " characters.");
  }
  await rateLimit(request, env, "write", "welcome-card:write:" + serverId + ":" + userId);

  const result = await env.GOOBER_DB.prepare(CARD_UPSERT_SQL).bind(
    serverId, blurb, serverId, userId, serverId, userId,
  ).run();
  if (Number(result.meta?.changes) === 0) {
    throw new HttpError(404, SHARED_UNKNOWN_404);
  }
  return json({ blurb });
}

// GET /api/servers/:id/welcome-card[?repeat=1] — the member's pull. The card
// read rides after the membership pre-read; an unconfigured server answers
// the shared unknown-server 404 (no config-existence oracle, spec §2). The
// first fetch records the member's own view row; the next keeps the blurb
// silent unless ?repeat=1 is the member's explicit re-show (the silence is
// theirs, not the server's, spec §1).
async function handleWelcomeCardGetRoute(request, env, url, serverId) {
  const userId = await membershipGate(request, env, serverId);
  await rateLimit(request, env, "read", "welcome-card:read:" + serverId + ":" + userId);

  const card = await env.GOOBER_DB.prepare(CARD_READ_SQL).bind(serverId).first();
  if (!card || !String(card.blurb_text || "")) {
    throw new HttpError(404, SHARED_UNKNOWN_404);
  }

  const shown = await env.GOOBER_DB.prepare(VIEW_READ_SQL)
    .bind(serverId, userId).first();
  if (!shown) {
    await env.GOOBER_DB.prepare(VIEW_INSERT_SQL)
      .bind(serverId, userId, nowSeconds()).run();
    return json({ blurb: String(card.blurb_text), shown: true });
  }

  const repeat = url.searchParams.get("repeat") === "1";
  return repeat
    ? json({ blurb: String(card.blurb_text), shown: true })
    : json({ shown: true, blurb: null });
}
