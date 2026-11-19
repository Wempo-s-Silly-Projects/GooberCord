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

// T-R25-SPLIT-SERVERS-4: the mod desk family's home (the wave-25 area-6
// seam, off the phase-1 monolith). The AutoMod desk (the per-server filter
// rules + their alerts feed) and its enforcement arm (kicks, bans, timeouts,
// the member prune) answer here; the search arm keeps its interloper seat in
// servers.mjs between the alerts and kick arms. The dispatch below hands the
// whole desk to the router as one forward with an 'undefined' fall-through —
// route order is semantically byte-unchanged, and every write's guards ride
// INSIDE the SQL exactly as before (an extraction moves bytes, not behavior).
//
// The shared read helpers (readActorContext/moderationGuardSql/isoTimestamp)
// stay ONE implementation in servers.mjs and are imported at CALL time (the
// circular import stays inert — a module-scope const would TDZ during the
// cycle; the T-R25-SPLIT-SERVERS-1 lesson).
//
// The module rides the 800-line soft ceiling with a deliberate exception:
// the AutoMod desk and its enforcement arm read as ONE family (the desk's
// writes arm the kicks/bans/timeouts/prune), no second caller exists to
// split into.

import { requireUser } from "./core/auth.mjs";
import { nowSeconds } from "./core/crypto.mjs";
import { HttpError, json, rateLimit, readJson, requiredText } from "./core/http.mjs";
import {
  PRUNE_DAYS,
  SERVER_PERMISSIONS,
  TIMEOUT_MINUTE_CHOICES,
  holdsRolesBitsParams,
  holdsRolesBitsSql,
} from "./permissions.mjs";
// 0010 filter/AutoMod: the rule-row caps, the alerts page cap, and the
// intake/payload machinery the desk's routes share with the send-path gate.
import {
  dropServerRulesCache,
  FILTER_ALERTS_PAGE_MAX,
  FILTER_RULE_ACTIONS,
  FILTER_RULE_BLOCK_MESSAGE_MAX,
  FILTER_RULE_DEFAULT_TIMEOUT_MINUTES,
  FILTER_RULE_MAX_PATTERNS,
  FILTER_RULE_MAX_RULES,
  FILTER_RULE_EXEMPT_ROLES_MAX,
  FILTER_RULE_EXEMPT_CHANNELS_MAX,
  publicRule,
  termsFromBody,
} from "./filterrules.mjs";
// The calls into the shared helpers happen at CALL time, after servers.mjs's
// module body has initialized (the circular import is inert by design).
import {
  BOOST_RECOUNT_SQL,
  isoTimestamp,
  moderationGuardSql,
  readActorContext,
} from "./servers.mjs";

// The manage-guard fragments mirror the sibling lanes' exact copies (invite,
// channels, roles keep them local by the same design note; a guard change
// must be re-mirrored and the parity tests pin the copies' behavior).
const OWNER_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM gc_server_members om " +
    "WHERE om.server_id = ? AND om.user_id = ? AND om.role = 'owner')";

// The member's strongest role position (-1 when roleless — the hierarchy
// sentinel the strictly-lower rules compare against).
const TOP_POSITION_SELECT =
  "(SELECT COALESCE(MAX(hr.position), -1) FROM gc_member_roles hmr " +
    "JOIN gc_roles hr ON hr.id = hmr.role_id " +
    "WHERE hmr.server_id = ? AND hmr.user_id = ?)";

// gc_server_bans.CHECK(reason IS NULL OR length(reason) <= 280); the route-side
// limit mirrors it so an oversized reason 400s instead of 500-ing.
const BAN_REASON_MAX = 280;

// --- 0010: the per-server filter rules (the AutoMod desk) ----------------------
//
// Every write's authorization rides INSIDE the SQL like every other write in
// this module: the rules desk's guard is the members-desk viewer class (the
// string-tier owner or moderator, OR any KICK_MEMBERS holder — the same
// class that sees the alerts feed, and the same class the checklist names as
// structurally exempt from the filter). Binds, in fragment order:
// serverId, userId (the row class), serverId, userId (the per-bit role
// EXISTS). Zero changes → 403 (with the one
// diagnostic pick between 403 and 400 where a second failure class exists:
// the create's per-server rule cap).
//
// The intake mirrors Discord's AutoMod rule shape at GC scale (the filed
// caps): a name, the TERM LIST (one per line or an array — wildcard stars,
// /regex/ terms compile-checked HERE, plain text otherwise), combinable
// actions from block|alert|timeout, the care flag (its actions are ignored —
// care never acts), the check_names flag (the nickname screen), the exempt
// role/channel ids (validated as THIS server's), and the block message the
// blocked member alone sees.

const FILTER_RULES_GUARD_SQL =
  "(EXISTS (SELECT 1 FROM gc_server_members fg WHERE fg.server_id = ? AND fg.user_id = ? " +
    "AND fg.role IN ('owner','moderator')) OR " +
  holdsRolesBitsSql(SERVER_PERMISSIONS.KICK_MEMBERS) + ")";

// The four binds the guard always wants: the row class's (server, userId)
// pair, then the per-bit EXISTS's pair.
function filterRulesGuardParams(serverId, userId) {
  return [
    serverId, userId,
    ...holdsRolesBitsParams(serverId, userId, SERVER_PERMISSIONS.KICK_MEMBERS),
  ];
}

// The exemption ids must be THIS server's — a rule can never exempt a role
// or channel from another server. Unknown ids 400 (the intake's clear error)
// rather than silently storing an inert exemption. The list length is the
// parity cap (≤ 20 roles / ≤ 50 channels, docs/parity-limits.md AutoMod) —
// the guard rides BEFORE the membership read, so an oversized list never
// spends a query.
async function validExemptIds(env, serverId, ids, sql, message, cap) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, message);
  const requested = ids.map((id) => Number(id));
  for (const id of requested) {
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, message);
  }
  if (requested.length > cap) {
    throw new HttpError(400, "That list is too long — at most " + cap + ".");
  }
  const results = (await env.GOOBER_DB.prepare(sql).bind(serverId).all()).results || [];
  const valid = new Set(results.map((row) => Number(row.id)));
  for (const id of requested) {
    if (!valid.has(id)) throw new HttpError(400, message);
  }
  return requested;
}

function filterRuleBodyFrom(env, serverId, body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "A filter rule needs a name and at least one term.");
  }
  const name = requiredText(body.name, "rule name", 64);
  const isCare = body.isCare === true;
  const checkNames = body.checkNames === true;
  const terms = termsFromBody(body.terms, { maxPatterns: FILTER_RULE_MAX_PATTERNS });

  let actions = ["block"];
  if (body.actions !== undefined) {
    if (!Array.isArray(body.actions)) throw new HttpError(400, "actions must be an array.");
    for (const action of body.actions) {
      if (!FILTER_RULE_ACTIONS.includes(action)) {
        throw new HttpError(400, "actions rides one or more of " + FILTER_RULE_ACTIONS.join(", ") + ".");
      }
    }
    // De-duped, order kept (block|alert|timeout are combinable).
    actions = FILTER_RULE_ACTIONS.filter((action) => body.actions.includes(action));
  }
  if (isCare) actions = []; // care NEVER acts (the owner decision)

  let blockMessage = null;
  if (body.blockMessage === undefined || body.blockMessage === null || body.blockMessage === "") {
    blockMessage = null;
  } else {
    if (typeof body.blockMessage !== "string") throw new HttpError(400, "blockMessage must be a string.");
    blockMessage = requiredText(
      body.blockMessage, "block message", FILTER_RULE_BLOCK_MESSAGE_MAX,
    );
  }

  let timeoutMinutes = null;
  if (body.timeoutMinutes !== undefined && body.timeoutMinutes !== null) {
    if (!TIMEOUT_MINUTE_CHOICES.includes(body.timeoutMinutes)) {
      throw new HttpError(400, "timeoutMinutes must be one of " + TIMEOUT_MINUTE_CHOICES.join(", ") + ".");
    }
    timeoutMinutes = body.timeoutMinutes;
  }
  if (!isCare && actions.includes("timeout") && timeoutMinutes === null) {
    timeoutMinutes = FILTER_RULE_DEFAULT_TIMEOUT_MINUTES; // the mod desk's own default
  }

  return { name, isCare, checkNames, terms, actions, blockMessage, timeoutMinutes };
}

const FILTER_RULE_CREATE_SQL =
  "INSERT INTO gc_filter_rules (" +
    "server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions, " +
    "is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at" +
  ") SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? " +
  "WHERE EXISTS (SELECT 1 FROM gc_servers fs WHERE fs.id = ?) AND " +
  FILTER_RULES_GUARD_SQL + " AND " +
  "(SELECT COUNT(*) FROM gc_filter_rules fc WHERE fc.server_id = ?) < " + FILTER_RULE_MAX_RULES;

const FILTER_RULE_SELECT_SQL =
  "SELECT id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions, " +
    "is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at " +
  "FROM gc_filter_rules";

async function ruleFromRow(env, serverId, ruleId) {
  const row = await env.GOOBER_DB.prepare(
    FILTER_RULE_SELECT_SQL + " WHERE server_id = ? AND id = ? LIMIT 1",
  ).bind(serverId, ruleId).first();
  return row ? publicRule(row) : null;
}

async function handleListFilterRulesRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  // One guarded read: the viewer class's WHERE rides the same shape every
  // read in this module takes.
  const rows = (await env.GOOBER_DB.prepare(
    FILTER_RULE_SELECT_SQL + " WHERE server_id = ? AND " + FILTER_RULES_GUARD_SQL + " ORDER BY id",
  ).bind(serverId, ...filterRulesGuardParams(serverId, userId)).all()).results || [];
  return json({ rules: rows.map((row) => publicRule(row)) }, 200);
}

async function handleCreateFilterRuleRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const parsed = filterRuleBodyFrom(env, serverId, body);
  const exemptRoleIds = await validExemptIds(env, serverId, body.exemptRoleIds,
    "SELECT id FROM gc_roles WHERE server_id = ?", "exemptRoleIds must be role ids of this server.",
    FILTER_RULE_EXEMPT_ROLES_MAX);
  const exemptChannelIds = await validExemptIds(env, serverId, body.exemptChannelIds,
    "SELECT id FROM gc_channels WHERE server_id = ?",
    "exemptChannelIds must be channel ids of this server.",
    FILTER_RULE_EXEMPT_CHANNELS_MAX);
  const now = nowSeconds();

  const result = await env.GOOBER_DB.prepare(FILTER_RULE_CREATE_SQL).bind(
    serverId, parsed.name, JSON.stringify(parsed.terms),
    JSON.stringify(exemptRoleIds), JSON.stringify(exemptChannelIds),
    JSON.stringify(parsed.actions), parsed.isCare ? 1 : 0, parsed.checkNames ? 1 : 0,
    parsed.blockMessage, parsed.timeoutMinutes, userId, now, now,
    // The guard's own binds + the cap's server bind.
    serverId, ...filterRulesGuardParams(serverId, userId), serverId,
  ).run();

  if (Number(result.meta?.changes) === 1) {
    dropServerRulesCache(serverId);
    return json({ rule: await ruleFromRow(env, serverId, Number(result.meta?.last_row_id)) }, 201);
  }

  // Diagnostic only (the INSERT's guard decided): the cap is the one second
  // failure class a create has.
  const count = await env.GOOBER_DB.prepare(
    "SELECT COUNT(*) AS count FROM gc_filter_rules WHERE server_id = ?",
  ).bind(serverId).first();
  if (Number(count?.count) >= FILTER_RULE_MAX_RULES) {
    throw new HttpError(400, "This server already has " + FILTER_RULE_MAX_RULES + " filter rules.");
  }
  throw new HttpError(403, "You do not have permission to do that.");
}

async function handleUpdateFilterRuleRoute(request, env, serverId, ruleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const body = await readJson(request);
  const parsed = filterRuleBodyFrom(env, serverId, body);
  const exemptRoleIds = await validExemptIds(env, serverId, body.exemptRoleIds,
    "SELECT id FROM gc_roles WHERE server_id = ?", "exemptRoleIds must be role ids of this server.",
    FILTER_RULE_EXEMPT_ROLES_MAX);
  const exemptChannelIds = await validExemptIds(env, serverId, body.exemptChannelIds,
    "SELECT id FROM gc_channels WHERE server_id = ?",
    "exemptChannelIds must be channel ids of this server.",
    FILTER_RULE_EXEMPT_CHANNELS_MAX);

  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_filter_rules SET " +
      "name = ?, terms = ?, exempt_role_ids = ?, exempt_channel_ids = ?, actions = ?, " +
      "is_care = ?, check_names = ?, block_message = ?, timeout_minutes = ?, updated_at = ? " +
    "WHERE server_id = ? AND id = ? AND " + FILTER_RULES_GUARD_SQL,
  ).bind(
    parsed.name, JSON.stringify(parsed.terms),
    JSON.stringify(exemptRoleIds), JSON.stringify(exemptChannelIds),
    JSON.stringify(parsed.actions), parsed.isCare ? 1 : 0, parsed.checkNames ? 1 : 0,
    parsed.blockMessage, parsed.timeoutMinutes, nowSeconds(),
    serverId, ruleId, ...filterRulesGuardParams(serverId, userId),
  ).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  dropServerRulesCache(serverId);
  return json({ rule: await ruleFromRow(env, serverId, ruleId) }, 200);
}

async function handleDeleteFilterRuleRoute(request, env, serverId, ruleId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_filter_rules WHERE server_id = ? AND id = ? AND " + FILTER_RULES_GUARD_SQL,
  ).bind(serverId, ruleId, ...filterRulesGuardParams(serverId, userId)).run();
  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  dropServerRulesCache(serverId);
  return json({ deleted: true, serverId, id: ruleId }, 200);
}

async function handleListFilterAlertsRoute(request, env, serverId, url) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw !== null && limitRaw !== "") {
    if (
      !/^[0-9]{1,3}$/.test(limitRaw) ||
      Number(limitRaw) < 1 ||
      Number(limitRaw) > FILTER_ALERTS_PAGE_MAX
    ) {
      throw new HttpError(400, "That alerts limit is invalid.");
    }
    limit = Number(limitRaw);
  }
  const rows = (await env.GOOBER_DB.prepare(
    "SELECT ga.id, ga.server_id, ga.channel_id, ga.message_id, ga.user_id, " +
      "ga.rule_id, ga.rule_name, ga.matched, ga.body, ga.created_at, " +
      "gu.username AS username " +
    "FROM gc_filter_alerts ga JOIN users gu ON gu.id = ga.user_id " +
    "WHERE ga.server_id = ? AND " + FILTER_RULES_GUARD_SQL + " " +
    "ORDER BY ga.id DESC LIMIT " + limit,
  ).bind(serverId, ...filterRulesGuardParams(serverId, userId)).all()).results || [];
  return json({
    alerts: rows.map((row) => ({
      id: Number(row.id),
      serverId: Number(row.server_id),
      channelId: row.channel_id === null ? null : Number(row.channel_id),
      messageId: row.message_id === null ? null : Number(row.message_id),
      userId: Number(row.user_id),
      username: row.username,
      ruleId: row.rule_id === null ? null : Number(row.rule_id),
      ruleName: row.rule_name,
      matched: row.matched,
      body: row.body,
      createdAt: isoTimestamp(row.created_at),
    })),
  }, 200);
}

// --- phase-3 kicks (KICK_MEMBERS + the position rule, batched) ------------------

async function handleKickMemberRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-kick:" + serverId + ":" + userId);

  // ONE batch mirroring leave's cycle-7 shape with the kick guard: the
  // member's role assignments, the kicked booster's gc_server_boosts row, and
  // the membership row leave together, and the boost recount rides in-batch
  // last. ORDER IS LOAD-BEARING (D1's batch is one sequential transaction —
  // the same class leave's strips rely on): the strips ride BEFORE the
  // member-row delete, because their membership-EXISTS arms go false the
  // moment that delete fires — a member-first batch commits them as refuted
  // zero-changes no-ops, and the surviving boost row would keep counting
  // toward the boost level (the caps the kicked booster grants) and re-grant
  // on rejoin via the guarded boost INSERT's DO NOTHING. Each strip carries
  // the SAME arm (the target's membership-EXISTS with the role <> 'owner'
  // rider — kick's mirror of the timeout routes' arm: one clause that is
  // both the membership arm the ordering needs and the owner immunity a
  // refused kick needs) plus the SAME moderation guard, so a refused kick —
  // an owner target included — strips nothing. The verdict reads the
  // member-row delete's changes (results[2]); the race path is intact — a
  // vanished row refutes the strips at batch start AND deletes 0, and the
  // shared 403 answers as before.
  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members ks " +
          "WHERE ks.server_id = ? AND ks.user_id = ? AND ks.role <> 'owner') AND " + guard.sql,
    ).bind(serverId, targetUserId, serverId, targetUserId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND user_id = ? " +
        "AND EXISTS (SELECT 1 FROM gc_server_members ks " +
          "WHERE ks.server_id = ? AND ks.user_id = ? AND ks.role <> 'owner') AND " + guard.sql,
    ).bind(serverId, targetUserId, serverId, targetUserId, ...guard.params),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ? " +
        "AND role <> 'owner' AND " + guard.sql,
    ).bind(serverId, targetUserId, ...guard.params),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);

  if (Number(results[2]?.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ kicked: true, serverId, userId: targetUserId }, 200);
}

// --- phase-3 mod desk: bans (the invalid-invite taxonomy's BANNED case) --------
//
// A ban is kick + a ban flag the join routes check, so a valid invite can't
// re-admit a banned account. Bans are a SEPARATE flow from the kick route
// (kick stays kick), and the authority is the same: KICK_MEMBERS with the
// position rule (no ban on a holder above the actor; the owner is immune and
// the owner bypasses). Un-banning removes the row; the roster hands the list
// to the members page and no IP model exists (filed: account bans only).

function banReasonFrom(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "A ban reason must be a non-empty string or omitted.");
  }
  const reason = value.trim();
  if (reason.length > BAN_REASON_MAX) {
    throw new HttpError(400, "A ban reason must be at most " + BAN_REASON_MAX + " characters.");
  }
  return reason;
}

async function handleBanMemberRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The write wall keyed caller-first (the leave/transfer idiom): a
  // bad-shaped body spends the same bucket, the shared-bucket lesson.
  await rateLimit(request, env, "write", "servers-ban:" + serverId + ":" + userId);
  const body = await readJson(request);

  // No coercion: a string "22" is a request-shape error, not a user id.
  if (!Number.isSafeInteger(body.user_id) || body.user_id < 1) {
    throw new HttpError(400, "user_id must be a user id.");
  }
  const targetUserId = body.user_id;
  if (targetUserId === userId) {
    throw new HttpError(400, "You cannot ban yourself.");
  }
  const reason = banReasonFrom(body.reason);
  const now = nowSeconds();

  // ONE batch under the SAME guard: the ban row (its WHERE carries the user
  // EXISTS, the not-already-banned NOT EXISTS, the owner-immune rider — a
  // -1-sentinel owner row would otherwise fall under the position rule — and
  // the moderation guard) and the kick-style fan-out, whose two deletes ride a
  // "ban row now exists" rider so a refused ban can never kick a member who
  // stayed — and the SAME rider carries the boost strip (cycle-9: a banned
  // booster's gc_server_boosts row leaves in-batch, before the member delete,
  // or it keeps counting toward gc_servers.boosts and re-grants on rejoin).
  // The recount derives from the stripped set in-batch LAST.
  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "INSERT INTO gc_server_bans (server_id, user_id, created_by, reason, created_at) " +
        "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users bu WHERE bu.id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?) AND " +
        "NOT EXISTS (SELECT 1 FROM gc_server_members tb WHERE tb.server_id = ? AND tb.user_id = ? " +
          "AND tb.role = 'owner') AND " +
        guard.sql,
    ).bind(
      serverId, targetUserId, userId, reason, now, targetUserId,
      serverId, targetUserId, serverId, targetUserId, ...guard.params,
    ),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND user_id = ? AND " +
        "EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)",
    ).bind(serverId, targetUserId, serverId, targetUserId),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_members WHERE server_id = ? AND user_id = ? AND role <> 'owner' AND " +
        "EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)",
    ).bind(serverId, targetUserId, serverId, targetUserId),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND user_id = ? AND " +
        "EXISTS (SELECT 1 FROM gc_server_bans gb WHERE gb.server_id = ? AND gb.user_id = ?)",
    ).bind(serverId, targetUserId, serverId, targetUserId),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);

  if (Number(results[0]?.meta?.changes) !== 1) {
    // Diagnostic only: the INSERT's guard decided. A ban already standing is
    // the idempotent answer, everyone else gets the shared 403.
    const existing = await env.GOOBER_DB.prepare(
      "SELECT reason, created_at FROM gc_server_bans WHERE server_id = ? AND user_id = ? LIMIT 1",
    ).bind(serverId, targetUserId).first();
    if (existing) {
      return json(
        {
          ban: {
            serverId, userId: targetUserId,
            reason: existing.reason ?? null,
            bannedAt: isoTimestamp(existing.created_at),
          },
          changed: false,
        },
        200,
      );
    }
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json(
    { ban: { serverId, userId: targetUserId, reason, bannedAt: isoTimestamp(now) }, changed: true },
    201,
  );
}

async function handleUnbanMemberRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-unban:" + serverId + ":" + userId);

  // The guarded DELETE: owner OR KICK_MEMBERS. Un-banning is not bound by the
  // position rule (a banned account is not a member to outrank anymore), and
  // not-banned refusals share the one 403 with refused authority — no oracle.
  const result = await env.GOOBER_DB.prepare(
    "DELETE FROM gc_server_bans WHERE server_id = ? AND user_id = ? AND (" +
      OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.KICK_MEMBERS) + ")",
  ).bind(
    serverId, targetUserId,
    serverId, userId, serverId, userId,
  ).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ banned: false, serverId, userId: targetUserId }, 200);
}

// --- phase-3 mod desk: timeouts (the time-out FAQ) ------------------------------
//
// Kick-lite with an expiry on the membership row. The PUT sets
// timed_out_until from the filed duration menu (minutes); the DELETE removes
// it at any time (NULL). Both are owner OR KICK_MEMBERS with the position
// rule pinned inside the statement: no timeout on a holder above the actor,
// the owner row is immune, and the owner bypasses. The three gates the state
// enforces live elsewhere — the send path (api/messages.mjs), the voice-join
// door (api/ws.mjs), and reactions when they ship.

async function handleSetTimeoutRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-timeout:" + serverId + ":" + userId);
  const body = await readJson(request);

  if (!TIMEOUT_MINUTE_CHOICES.includes(body.minutes)) {
    throw new HttpError(400, "minutes must be one of " + TIMEOUT_MINUTE_CHOICES.join(", ") + ".");
  }

  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const until = nowSeconds() + body.minutes * 60;
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET timed_out_until = ? WHERE server_id = ? AND user_id = ? " +
      "AND role <> 'owner' AND " + guard.sql,
  ).bind(until, serverId, targetUserId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json(
    { member: { serverId, userId: targetUserId, timedOutUntil: isoTimestamp(until) } },
    200,
  );
}

async function handleRemoveTimeoutRoute(request, env, serverId, targetUserId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  await rateLimit(request, env, "write", "servers-untimeout:" + serverId + ":" + userId);

  const guard = moderationGuardSql(
    serverId, userId, targetUserId,
    [SERVER_PERMISSIONS.KICK_MEMBERS],
  );
  const result = await env.GOOBER_DB.prepare(
    "UPDATE gc_server_members SET timed_out_until = NULL WHERE server_id = ? AND user_id = ? " +
      "AND role <> 'owner' AND " + guard.sql,
  ).bind(serverId, targetUserId, ...guard.params).run();

  if (Number(result.meta?.changes) !== 1) {
    throw new HttpError(403, "You do not have permission to do that.");
  }

  return json({ member: { serverId, userId: targetUserId, timedOutUntil: null } }, 200);
}

// --- phase-3 mod desk: member prune (the how-to-prune guide) --------------------
//
// Step 1 (dry_run) is ONE preview COUNT — cheap and kind; step 2 executes the
// kick as a batch of two deletes, both carrying the SAME candidate predicate
// and the SAME moderation guard (the kick route's shape, with the candidate
// set inside the WHERE). Candidates: members whose JOIN predates the cutoff
// with NO message activity in this server (the filed derivable signal: any
// gc_messages row via one of the server's channels), never the owner, and —
// for a non-owner actor — never a holder whose position is >= the actor's.

// The prune's per-statement candidates: the activity NOT EXISTS (no message
// by that member through any of this server's channels) and the role-filter
// EXISTS ("also include members with these roles"). Both statements reuse
// them by table alias — m.
function pruneActivitySql() {
  return "NOT EXISTS (SELECT 1 FROM gc_messages pa JOIN gc_channels pc ON pc.id = pa.channel_id " +
    "AND pc.server_id = ? WHERE pa.author_id = m.user_id)";
}

function pruneRoleFilterSql() {
  return "EXISTS (SELECT 1 FROM gc_member_roles fm JOIN gc_roles fr ON fr.id = fm.role_id " +
    "WHERE fm.server_id = ? AND fm.user_id = m.user_id AND fm.role_id = ?)";
}

async function handlePruneRoute(request, env, serverId) {
  const session = await requireUser(request, env);
  const userId = Number(session.user.id);

  // The write tier with the prune identity (server-scoped, hashed downstream).
  await rateLimit(request, env, "write", "prune:" + serverId + ":" + userId);
  const body = await readJson(request);

  if (!PRUNE_DAYS.includes(body.days)) {
    throw new HttpError(400, "days must be one of 7 or 30.");
  }
  if (body.dry_run !== true && body.dry_run !== false) {
    throw new HttpError(400, "dry_run must be true or false — preview counts, the false run kicks.");
  }
  const roleFilterId = body.role_filter_id === undefined || body.role_filter_id === null
    ? null
    : body.role_filter_id;
  if (roleFilterId !== null && (!Number.isSafeInteger(roleFilterId) || roleFilterId < 1)) {
    throw new HttpError(400, "role_filter_id must be a role id or omitted.");
  }

  // Classification read only: it picks the actor fragment the statements
  // embed (the owner prunes below the crown; a KICK_MEMBERS holder prunes
  // strictly below their own top position) and nothing else. The
  // authorization itself still rides inside every statement below, so a
  // stale tier could only ever produce a zero-change zero-count no-op.
  const actor = await readActorContext(env, serverId, userId);
  if (!actor) throw new HttpError(403, "You do not have permission to do that.");

  const isOwner = actor.role === "owner";
  const cutoff = nowSeconds() - body.days * 86400;

  // The shared fragment inventory: the actor guard (owner OR KICK_MEMBERS —
  // the owner arm alone is skipped in when the actor read said owner, purely
  // to keep the owner free of a -1-sentinel comparison against roleless
  // candidates), the position rule (skipped for the owner for the same
  // reason), and the optional role filter.
  const authorityGuardSql = isOwner
    ? "(" + OWNER_EXISTS_SQL + ")"
    : "(" + OWNER_EXISTS_SQL + " OR " + holdsRolesBitsSql(SERVER_PERMISSIONS.KICK_MEMBERS) + ")";
  const authorityGuardBinds = isOwner
    ? [serverId, userId]
    : [
        // The owner arm's (server, actor) pair, then the per-bit EXISTS pair.
        serverId, userId,
        ...holdsRolesBitsParams(serverId, userId, SERVER_PERMISSIONS.KICK_MEMBERS),
      ];
  const positionGuardSql = isOwner
    ? "1 = 1"
    : "NOT EXISTS (SELECT 1 FROM gc_member_roles pm JOIN gc_roles pr ON pr.id = pm.role_id " +
        "WHERE pm.server_id = ? AND pm.user_id = m.user_id AND pr.position >= " +
        TOP_POSITION_SELECT + ")";
  const positionGuardBinds = isOwner ? [] : [serverId, userId, serverId, userId];
  const roleFilterSql = roleFilterId !== null ? pruneRoleFilterSql() : "1 = 1";
  const roleFilterBinds = roleFilterId !== null ? [serverId, roleFilterId] : [];

  // The authority is the candidate WHERE's FIRST clause, in-statement for the
  // preview AND both deletes (lane-haywire6-servers): the old shape carried
  // the guard only on the dry-run's `authorized` column, so the RUN batch
  // bound only the candidate predicate — a plain member (no KICKMembers bit)
  // who rode a stale actor read wiped every quiet member. The owner arm alone
  // stays the owner's crown (roleless candidates are the crown's to prune, so
  // no position rule and no mask arm rides the owner's statements).
  const candidateWhere =
    authorityGuardSql + " AND " +
    "m.server_id = ? AND m.role <> 'owner' AND m.joined_at <= ? AND " +
      pruneActivitySql() + " AND " + positionGuardSql + " AND " + roleFilterSql;
  const candidateBinds = [
    ...authorityGuardBinds,
    serverId, cutoff, serverId, ...positionGuardBinds, ...roleFilterBinds,
  ];

  if (body.dry_run) {
    // Step 1: the preview COUNT — cheap and kind. The same predicate as the
    // run, with the authorization riding the SELECT list itself (the
    // `authorized` column decides), so the count never leaks past a member
    // without the bit.
    const row = await env.GOOBER_DB.prepare(
      "SELECT COUNT(*) AS count, " + authorityGuardSql + " AS authorized " +
        "FROM gc_server_members m WHERE " + candidateWhere,
    ).bind(...authorityGuardBinds, ...candidateBinds).first();
    if (!row || Number(row.authorized) !== 1) {
      throw new HttpError(403, "You do not have permission to do that.");
    }
    return json({ dry_run: true, count: Number(row.count) }, 200);
  }

  // Step 2: the batched kick. ALL THREE deletes carry the identical candidate
  // set and guard; the assignments leave FIRST (their predicate joins the
  // membership row, which the aliased member statement's predicate would
  // lose), and the boost strip rides the SAME shape — a pruned booster's
  // gc_server_boosts row leaves in-batch (cycle-9: the orphan kept counting
  // toward gc_servers.boosts and re-granted on rejoin) before the member
  // delete refutes its EXISTS arm. The recount derives from the stripped set
  // in-batch LAST.
  const results = await env.GOOBER_DB.batch([
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_member_roles WHERE server_id = ? AND EXISTS (" +
        "SELECT 1 FROM gc_server_members m WHERE " + candidateWhere + ")",
    ).bind(serverId, ...candidateBinds),
    env.GOOBER_DB.prepare(
      "DELETE FROM gc_server_boosts WHERE server_id = ? AND EXISTS (" +
        "SELECT 1 FROM gc_server_members m WHERE " + candidateWhere + ")",
    ).bind(serverId, ...candidateBinds),
    env.GOOBER_DB.prepare(
      // The alias is what the candidate predicate binds against (SQLite takes
      // DELETE targets aliased; the roles statement above never needed it —
      // its predicate's alias rides the subquery).
      "DELETE FROM gc_server_members AS m WHERE " + candidateWhere,
    ).bind(...candidateBinds),
    env.GOOBER_DB.prepare(BOOST_RECOUNT_SQL).bind(serverId, serverId),
  ]);

  return json(
    { dry_run: false, kicked: Number(results[2]?.meta?.changes) || 0 },
    200,
  );
}

export async function handleServerModRoutes(request, env, url, path, method) {
  // url rides into the alerts feed's page links (the desk's own consumer).
  // --- 0010: the filter rules desk + the alerts feed ---------------------------
  const filterRulesMatch = (method === "GET" || method === "POST")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/filter\/rules$/)
    : null;
  if (filterRulesMatch) {
    return method === "GET"
      ? handleListFilterRulesRoute(request, env, Number(filterRulesMatch[1]))
      : handleCreateFilterRuleRoute(request, env, Number(filterRulesMatch[1]));
  }

  const filterRuleItemMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/filter\/rules\/(0|[1-9][0-9]*)$/)
    : null;
  if (filterRuleItemMatch) {
    return method === "PUT"
      ? handleUpdateFilterRuleRoute(
          request, env, Number(filterRuleItemMatch[1]), Number(filterRuleItemMatch[2]),
        )
      : handleDeleteFilterRuleRoute(
          request, env, Number(filterRuleItemMatch[1]), Number(filterRuleItemMatch[2]),
        );
  }

  const filterAlertsMatch = method === "GET"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/filter\/alerts$/)
    : null;
  if (filterAlertsMatch) {
    return handleListFilterAlertsRoute(request, env, Number(filterAlertsMatch[1]), url);
  }
  const kickMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/members\/(0|[1-9][0-9]*)$/)
    : null;
  if (kickMatch) {
    return handleKickMemberRoute(
      request, env, Number(kickMatch[1]), Number(kickMatch[2]),
    );
  }

  // --- phase-3 mod desk: bans, timeouts, prune ---------------------------------
  const banMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/bans$/)
    : null;
  if (banMatch) {
    return handleBanMemberRoute(request, env, Number(banMatch[1]));
  }

  const unbanMatch = method === "DELETE"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/bans\/(0|[1-9][0-9]*)$/)
    : null;
  if (unbanMatch) {
    return handleUnbanMemberRoute(
      request, env, Number(unbanMatch[1]), Number(unbanMatch[2]),
    );
  }

  const timeoutMatch = (method === "PUT" || method === "DELETE")
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/members\/(0|[1-9][0-9]*)\/timeout$/)
    : null;
  if (timeoutMatch) {
    const serverId = Number(timeoutMatch[1]);
    const targetUserId = Number(timeoutMatch[2]);
    return method === "PUT"
      ? handleSetTimeoutRoute(request, env, serverId, targetUserId)
      : handleRemoveTimeoutRoute(request, env, serverId, targetUserId);
  }

  const pruneMatch = method === "POST"
    ? path.match(/^\/api\/servers\/(0|[1-9][0-9]*)\/prune$/)
    : null;
  if (pruneMatch) {
    return handlePruneRoute(request, env, Number(pruneMatch[1]));
  }

  return undefined;
}
