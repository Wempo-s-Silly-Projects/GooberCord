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

// The Campfire ledger (2026-11-18 re-code wave): the server's economy event
// ledger — the fire's books, open to the server's members.
//
// THE BOOKS ARE AN AGGREGATE OVER ROWS THAT ALREADY EXIST: gc_coin_ledger
// (migration 0011) is the whole history the economy mints (earn sources and
// sink sources alike). This module adds NO table, NO migration, and — above
// all — NO write: a read statement of any other form than SELECT would mint
// or move something, and the books must never print money.
//
// NO-ATTRIBUTION LAW: the payload is flow lines per (source, direction) —
// labels and amounts, never a coin holder. No userId, no username, never a
// top-list, never a per-member page. The membership join scopes the aggregate
// to the server's members and nothing else.
import { requireSignedInRead } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit } from "./core/http.mjs";
import { GC_CAMPFIRE_LEDGER_WINDOW_SECONDS } from "../constants.mjs";

const MEMBERSHIP_READ_SQL =
  "SELECT role FROM gc_server_members WHERE server_id = ? AND user_id = ? LIMIT 1";

// The books' ONE read: derived ON REQUEST, server-keyed by the membership
// join's WHERE, windowed by created_at, grouped per (source, direction).
// The membership join feeds the WHERE only — no member column is selected.
const FLOWS_READ_SQL =
  "SELECT le.source, " +
    "CASE WHEN le.delta > 0 THEN 'in' ELSE 'out' END AS direction, " +
    "SUM(le.delta) AS amount, COUNT(*) AS count " +
  "FROM gc_coin_ledger le " +
    "JOIN gc_server_members m ON m.user_id = le.user_id " +
  "WHERE m.server_id = ? AND le.created_at >= ? " +
  "GROUP BY le.source, direction";

// The shared member gate: non-members share the unknown-server 404 — no
// server-existence oracle.
async function memberGate(request, env, serverId) {
  const session = await requireSignedInRead(request, env);
  const userId = Number(session.user.id);
  const membership = await env.GOOBER_DB.prepare(MEMBERSHIP_READ_SQL)
    .bind(serverId, userId).first();
  if (!membership) {
    throw new HttpError(404, "This server does not exist or you cannot view it.");
  }
  return userId;
}

// GET /api/servers/:id/ledger — the fire's books are open: members only,
// DERIVED ON REQUEST, and it mints and sinks NOTHING. A book-keeper who
// touches the economy during the audit is an auditor wearing gloves to print
// money — the route runs exactly one aggregate read.
async function handleCampfireLedgerRoute(request, env, serverId) {
  const userId = await memberGate(request, env, serverId);
  await rateLimit(request, env, "read", "campfire:ledger:" + serverId + ":" + userId);
  const endSeconds = nowSeconds();
  const startSeconds = endSeconds - GC_CAMPFIRE_LEDGER_WINDOW_SECONDS;
  const rows = (await env.GOOBER_DB.prepare(FLOWS_READ_SQL)
    .bind(serverId, startSeconds).all()).results || [];
  return json({
    window: { startSeconds, endSeconds },
    flows: rows.map((row) => ({
      source: String(row.source || ""),
      direction: String(row.direction || ""),
      amount: Number(row.amount),
      count: Number(row.count),
    })),
  });
}

export async function handleCampfireRoutes(request, env, url, path, method, ctx) {
  void url;
  void ctx;

  const ledgerMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/ledger$/)
    : null;
  if (ledgerMatch) {
    return handleCampfireLedgerRoute(request, env, Number(ledgerMatch[1]));
  }

  return undefined;
}
