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

// Per-server filter rules (the AutoMod parity batch): while
// api/filterstore.mjs keeps the SITE-WIDE keyword list in site_settings, this
// module owns the per-server rule rows (gc_filter_rules, migration 0010) that
// carry the filed per-rule surface — wildcard match modes per term (prefix*,
// *suffix, *mid*dle anywhere, plain contains otherwise), JavaScript RegExp
// terms, exempt roles/channels, combinable response actions (block / alert /
// timeout acting AS the server's owner), the Care class whose hits never
// block and write nothing, and name-class rules that screen nicknames.
//
// Term grammar (kept text-shaped so the intake editor reads like today's
// desk, one term per line):
//   /pattern/     -> a regex term (case-insensitive; compile-checked at save)
//   cat*          -> prefix  (a token STARTS with "cat")
//   *cat          -> suffix  (a token ENDS with "cat")
//   *cat*         -> anywhere (a token CONTAINS "cat")
//   mid*dle       -> anywhere spanning (a token carries "mid", then later
//                    "dle" — the checklist's *mid*dle form without the ends)
//   anything else -> plain contains (a case-insensitive substring of the text)
//
// The regex safety rule from the filed checklist is structural here: every
// pattern is compiled at SAVE time (invalid -> a clear 400, never stored) and
// every evaluation wraps the match call in try/catch, so a pattern that goes
// bad in some later runtime state can never 500 a message send. Stored
// regexes are additionally bounded: at most FILTER_RULE_MAX_PATTERNS per
// server and FILTER_RULE_PATTERN_CHARACTERS per pattern, and the matcher's
// own compile path refuses the catastrophic quantifier shapes the global
// filter's compiler refuses.
//
// Performance contract: the whole rule set is held in a short-TTL isolate
// cache keyed by server (RULE_CACHE_TTL_MS, matching filterstore's contract),
// refreshed on the first use inside the TTL window — a server with no rules
// costs one cheap indexed SELECT per TTL window per isolate, and a configured
// server costs the sends it filters one exemption read. Every CRUD write
// drops this isolate's cache entry for the server it touched.
import { HttpError } from "./core/http.mjs";
import { GC_INVISIBLE_CONTROL_STRIP } from "../constants.mjs";
import { TIMEOUT_MINUTE_CHOICES } from "./permissions.mjs";

// GC-scaled limits (docs/parity-limits.md, AutoMod row verified 2026-11-17):
// the filed per-rule surface — 1000 terms x 60 chars per KEYWORD rule,
// 10 regexes x 260 chars, 10 rules per server, block messages 150, exempt
// lists capped at 20 roles / 50 channels. Allow-words per keyword rule and
// the mention-spam rule KIND stay the feature lane (parities, not shipped).
export const FILTER_RULE_NAME_MAX = 64;
// docs/parity-limits.md: AutoMod 1000 terms x 60 chars per KEYWORD rule.
export const FILTER_RULE_TERM_CHARACTERS = 60;
export const FILTER_RULE_MAX_TERMS = 1000;
export const FILTER_RULE_MAX_PATTERNS = 10;
// docs/parity-limits.md: AutoMod regex terms 10 x 260 chars.
export const FILTER_RULE_PATTERN_CHARACTERS = 260;
export const FILTER_RULE_MAX_RULES = 10;
export const FILTER_RULE_BLOCK_MESSAGE_MAX = 150;
// docs/parity-limits.md: AutoMod exempt ≤ 20 roles + ≤ 50 channels per rule
// (NEW caps — the file's read never carried one; both ride the rule edit
// path as guards before the write).
export const FILTER_RULE_EXEMPT_ROLES_MAX = 20;
export const FILTER_RULE_EXEMPT_CHANNELS_MAX = 50;

export const FILTER_RULE_ACTIONS = Object.freeze(["block", "alert", "timeout"]);

// Every rule's timeout response pulls from the SAME duration menu the mod
// desk's manual timeout uses, so a flagged member is never timed out for a
// length no mod could have chosen (default: 10 minutes).
export const FILTER_RULE_DEFAULT_TIMEOUT_MINUTES = 10;

// The Care rule's inline copy (the owner decision, 2026-11-16): care-first,
// never an accusation, pointing at the worldwide helpline finder — a hit
// NEVER blocks or deletes the message, and detection notifies and logs
// NOTHING. Rules may carry their own care copy in block_message (<= 150);
// otherwise the default rides.
// The default copy is the full shape (it has room to breathe); a rule's own
// copy is capped at 150 like every other block message.
export const CARE_HELPLINE_URL = "https://findahelpline.com/";
export const FILTER_RULE_DEFAULT_CARE_NOTICE =
  "It sounds like things might be really heavy right now. You matter, and " +
  "you don't have to carry this alone. If you want support, people are " +
  "ready to listen: " + CARE_HELPLINE_URL;

export const CARE_WS_FRAME_TYPE = "care_notice";

// The alert feed never grows unbounded: the writer trims each server's feed
// to the newest rows (one DELETE past the cap in the same batch as the
// INSERT). 200 covers a busy server's desk panel.
export const FILTER_ALERT_CAP_PER_SERVER = 200;
export const FILTER_ALERT_PREVIEW_MAX = 280;
export const FILTER_ALERTS_PAGE_MAX = 100;

// The name-check copy, in the shape of the filter's own 400 ("That message
// isn't allowed."): the value IS the answer, with no detail about which term
// matched.
export const FILTERED_NAME_ERROR = "That name isn't allowed.";

const RULE_CACHE_TTL_MS = 30_000;

// --- term grammar -----------------------------------------------------------------

// parseTermParts("cat*") -> { strategy: "prefix", parts: ["cat"] }
// The star-grammar normalization: a term splits on its stars into ordered
// literal segments; where the stars sit decides the strategy —
//   no star             -> contains   (parts = [entry])
//   one interior star   -> anywhere   (the *mid*dle spanning form)
//   trailing star only  -> prefix     (the leading segment must start a token)
//   leading star only   -> suffix     (the last segment must end a token)
//   stars at both ends  -> anywhere   (order-preserving contains per token)
// Interior segments always match in order. A term that is only stars (or
// empty between stars everywhere) can never match anything real and is
// rejected at intake.
export function parseTermParts(raw) {
  const text = String(raw ?? "");
  const segments = text.split("*");
  // A term that reduces to all-empty segments ("**", "") matched nothing.
  if (segments.every((segment) => segment === "")) return null;
  const parts = segments.map((segment) => segment.toLowerCase()).filter((segment) => segment !== "");
  return { segments, parts };
}

// matchWildcardStrategy(token, { strategy, parts, segments }): the four star
// modes over ONE already-lowercased token. "contains" is the no-star literal
// (substring anywhere in the text, done by the caller), so this handles the
// star modes over tokens: the mask-never-spans-whitespace reading the global
// filter's glob branch takes as well.
function tokenMatchesWildcard(token, term) {
  const { strategy, parts, segments } = term;
  if (strategy === "prefix") {
    const stem = segments[0].toLowerCase();
    return stem !== "" && token.startsWith(stem);
  }
  if (strategy === "suffix") {
    const stem = segments[segments.length - 1].toLowerCase();
    return stem !== "" && token.endsWith(stem);
  }
  // anywhere (and the interior-star spanning form): every segment matches in
  // order within the token.
  let cursor = 0;
  for (const part of parts) {
    const found = token.indexOf(part, cursor);
    if (found === -1) return false;
    cursor = found + part.length;
  }
  return parts.length > 0;
}

// classifyWildcardTerm(entry): a term whose stars mark its strategy. Prefix
// and suffix are the STARS' reading (cat* = starts with cat), anywhere is
// every star-marked form otherwise. Returns null when the term is star-only
// junk.
export function classifyWildcardTerm(entry) {
  const parsed = parseTermParts(entry);
  if (!parsed) return null;
  // A star-free term is the plain contains literal — the fallback return at
  // the bottom is star-shapes only.
  if (!entry.includes("*")) {
    return { strategy: "contains", parts: parsed.parts, segments: parsed.segments };
  }
  const leadingStar = parsed.segments[0] === "";
  const trailingStar = parsed.segments[parsed.segments.length - 1] === "";
  if (!leadingStar && !trailingStar && parsed.segments.length === 2) {
    return { strategy: "anywhere", parts: parsed.parts, segments: parsed.segments };
  }
  if (trailingStar && !leadingStar && parsed.segments.length === 2) {
    return { strategy: "prefix", parts: parsed.parts, segments: parsed.segments };
  }
  if (leadingStar && !trailingStar && parsed.segments.length === 2) {
    return { strategy: "suffix", parts: parsed.parts, segments: parsed.segments };
  }
  // *a*b*, a*b*, *a*b, a**b, *a**b* — every remaining star shape reads as
  // the order-preserving anywhere form.
  return { strategy: "anywhere", parts: parsed.parts, segments: parsed.segments };
}

// --- save-time term intake ---------------------------------------------------------

function termLengthError(kind, limit) {
  return new HttpError(400, "A " + kind + " term must be at most " + limit + " characters.");
}

// parseFilterTerm(raw): one intake line -> its stored shape, or null (an
// empty line). REGEX terms are COMPILE-VALIDATED right here — the filed
// save-time guarantee: an invalid pattern is a 400 that names the error, so
// nothing inert is ever stored, and the stored text compiles again on the
// matcher's side.
export function parseFilterTerm(raw, { patternCharacters = FILTER_RULE_PATTERN_CHARACTERS } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const regexMatch = text.match(/^\/(.+)\/([a-z]*)$/);
  if (regexMatch) {
    if (regexMatch[1].length > patternCharacters) throw termLengthError("regex", patternCharacters);
    compileRuleRegex(regexMatch[1], regexMatch[2]);
    return { text, strategy: "regex" };
  }

  if (text.includes("*")) {
    const classified = classifyWildcardTerm(text);
    if (!classified) {
      throw new HttpError(400, "A wildcard term must carry at least one character beside its stars.");
    }
    for (const part of classified.parts) {
      if (part.length > patternCharacters) throw termLengthError("wildcard", patternCharacters);
    }
    return { text, strategy: classified.strategy };
  }

  // Plain contains.
  if (text.length > FILTER_RULE_TERM_CHARACTERS) {
    throw new HttpError(400, "A filter term must be at most " + FILTER_RULE_TERM_CHARACTERS + " characters.");
  }
  return { text: text.toLowerCase(), strategy: "contains" };
}

// compileRuleRegex(body, ownerFlags): the ONLY compile path for a stored
// regex term. Saves and evaluation agree on this shape: case-insensitive
// always (the filed "free with the flags"), the g flag stripped (it is
// stateless under the matcher's reset discipline), the astral-escape rewrite
// the global filter's compiler does, and the same catastrophic-quantifier
// refusals. Errors carry the pattern's message (a save 400; on the message
// path a throw never escapes — the matcher wraps this).
export function compileRuleRegex(body, ownerFlags, { allowDangerous = false } = {}) {
  let flags = String(ownerFlags || "").replace(/[^imsu]/g, "");
  if (!flags.includes("i")) flags += "i";
  try {
    const pattern = String(body ?? "");
    if (pattern.length > FILTER_RULE_PATTERN_CHARACTERS && !allowDangerous) {
      throw new HttpError(
        400,
        "A regex term must be at most " + FILTER_RULE_PATTERN_CHARACTERS + " characters.",
      );
    }
    if (!allowDangerous && hasCatastrophicQuantifiers(pattern)) {
      throw new HttpError(
        400,
        "That regex nests quantifiers and would backtrack catastrophically — simplify it.",
      );
    }
    return new RegExp(pattern, flags);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "That regex term does not compile: " + String(error.message ?? error));
  }
}

// Mirrors api/filter.mjs's catastrophic-shape walk (the same guard the global
// filter applies to owner patterns): a quantified group nested inside a
// quantified group is the (x+)+ exponential family.
function hasCatastrophicQuantifiers(pattern) {
  const groups = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") {
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "(") { groups.push({ quantified: false }); continue; }
    if (ch === ")" && groups.length > 0) {
      const group = groups.pop();
      const rest = pattern.slice(i + 1);
      const closesQuantified = rest[0] === "+" || rest[0] === "*" || /^\{[0-9]+,\}/.test(rest);
      if (group.quantified && closesQuantified) return true;
      if (group.quantified) {
        for (const enclosing of groups) enclosing.quantified = true;
      }
    }
    if ((ch === "+" || ch === "*" || /^\{[0-9]+,\}/.test(pattern.slice(i))) && groups.length > 0) {
      groups[groups.length - 1].quantified = true;
      if (ch === "{") i = pattern.indexOf("}", i);
    }
  }
  return false;
}

// termsFromBody(value): the intake accepts the editor's one-per-line string
// or an array of strings; every line is parsed. Returns the stored JSON
// array. Duplicate terms (case-insensitive on the stored text) are dropped,
// and the server caps are enforced here: at most FILTER_RULE_MAX_TERMS terms
// of any shape and maxPatterns (the filed regex ceiling) regex terms.
export function termsFromBody(value, { maxPatterns = FILTER_RULE_MAX_PATTERNS } = {}) {
  const lines = Array.isArray(value)
    ? value.map((line) => String(line ?? ""))
    : String(value ?? "").split(/\r\n|\r|\n/);
  const terms = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const term = parseFilterTerm(line);
    const key = term.strategy + "\u0000" + term.text.toLowerCase();
    if (seen.has(key)) continue;
    if (term.strategy === "regex") {
      const patternCount = terms.filter((existing) => existing.strategy === "regex").length;
      if (patternCount + 1 > maxPatterns) {
        throw new HttpError(
          400,
          "Too many regex terms for this server (at most " + maxPatterns + ").",
        );
      }
    }
    if (terms.length + 1 > FILTER_RULE_MAX_TERMS) {
      throw new HttpError(400, "Too many terms for this server (at most " + FILTER_RULE_MAX_TERMS + ").");
    }
    seen.add(key);
    terms.push(term);
  }
  if (terms.length === 0) {
    throw new HttpError(400, "Enter at least one filter term.");
  }
  return terms;
}

// --- storage shape -----------------------------------------------------------------

function parseJsonArray(value) {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseIdArray(value) {
  return parseJsonArray(value)
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

export function publicRule(row) {
  const actions = parseJsonArray(row.actions).filter((action) => FILTER_RULE_ACTIONS.includes(action));
  const isCare = Number(row.is_care) === 1;
  return {
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: String(row.name ?? ""),
    terms: parseJsonArray(row.terms),
    exemptRoleIds: parseIdArray(row.exempt_role_ids),
    exemptChannelIds: parseIdArray(row.exempt_channel_ids),
    // An empty action list is the block default everywhere (care ignores
    // actions entirely).
    actions,
    isCare,
    checkNames: Number(row.check_names) === 1,
    blockMessage: row.block_message ?? null,
    timeoutMinutes:
      TIMEOUT_MINUTE_CHOICES.includes(Number(row.timeout_minutes))
        ? Number(row.timeout_minutes)
        : FILTER_RULE_DEFAULT_TIMEOUT_MINUTES,
    createdBy: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
    updatedAt: new Date(Number(row.updated_at) * 1000).toISOString(),
  };
}

export function ruleForEvaluation(publicShape) {
  return {
    id: publicShape.id,
    name: publicShape.name,
    isCare: publicShape.isCare,
    checkNames: publicShape.checkNames,
    terms: publicShape.terms,
    exemptRoleIds: publicShape.exemptRoleIds,
    exemptChannelIds: publicShape.exemptChannelIds,
    actions: publicShape.actions,
    blockMessage: publicShape.blockMessage,
    timeoutMinutes: publicShape.timeoutMinutes,
  };
}

// The matcher's own compiled terms, built from the stored shape. Regexes are
// compiled AGAIN here (storage could drift from what save-time validated —
// an edit by a hand other than this code); a regex that fails to compile NOW
// degrades to a never-matching term instead of stopping the send (the
// structural guarantee: the match path is guarded below, but never storing
// inert terms at save time keeps that a last resort).
function compileTerms(terms) {
  const compiled = [];
  for (const term of terms) {
    if (!term || typeof term.text !== "string") continue;
    if (term.strategy === "regex") {
      const source = term.text.match(/^\/(.+)\/([a-z]*)$/);
      let pattern = null;
      try {
        if (source) pattern = compileRuleRegex(source[1], source[2]);
      } catch {
        pattern = null;
      }
      if (!pattern) continue; // bad runtime state: this term goes inert, never explosive
      compiled.push({ text: term.text, strategy: "regex", pattern });
      continue;
    }
    const classified = classifyWildcardTerm(term.text) || { strategy: "contains", parts: [term.text.toLowerCase()] };
    compiled.push({ text: term.text, ...classified });
  }
  return compiled;
}

// --- matching ----------------------------------------------------------------------

// ruleMatchesText(rule, text): the pure matcher. A hit is { matched } — the
// matched term's source text (capped by the alert writer) — or null. Regex
// evaluation is wrapped in its own try/catch: a pattern whose stored form
// misbehaves at runtime (compilation drift, an engine corner) can never 500
// the send path — the filed warning converted into the structural guarantee.
export function ruleMatchesText(rule, text) {
  const lowered = text.toLowerCase();
  for (const term of compileTerms(rule.terms)) {
    try {
      if (term.strategy === "regex") {
        if (term.pattern.test(lowered)) return { matched: term.text };
        continue;
      }
      if (term.strategy === "contains") {
        if (lowered.includes(term.text.toLowerCase())) return { matched: term.text };
        continue;
      }
      // The wildcard strategies are per-token; a multi-word wildcard matches
      // when one token carries its segments.
      for (const token of lowered.split(/\s+/)) {
        if (!token) continue;
        if (tokenMatchesWildcard(token, term)) return { matched: term.text };
      }
    } catch {
      // A matcher throw can at most skip THIS term — the send always proceeds
      // on the code path, the filter never kills itself.
    }
  }
  return null;
}

function ruleExemptChannel(rule, channelId) {
  return rule.exemptChannelIds.some((id) => Number(id) === Number(channelId));
}

function ruleExemptRole(rule, memberRoleIds) {
  return rule.exemptRoleIds.some((exempt) =>
    memberRoleIds.some((held) => Number(held) === Number(exempt)));
}

// evaluateServerFilter(env-independent core): decide what THE RULE SET says
// about a message body. Pure — the DB reads and writes live with the caller
// (api/messages.mjs), which owns the exemption read and the alert/timeout
// writes. The member context is precomputed there: the string tier
// (owner/moderator) and any KICK_MEMBERS holder are structurally exempt from
// every keyword rule (checklist: "Admin/Manage-Server always exempt").
//
// Returns:
//   { kind: "none" }                     — nothing applies
//   { kind: "blocked", rule, matched }   — throw in the caller
//   { kind: "acted", rule, matched }     — alert/timeout only, message stores
//   { kind: "care", rule }               — NEVER blocks; the response carries careNotice
//
// Care wins over keyword even when both would hit: a message that needs care
// is not also a moderation object, and care NEVER acts.
export function evaluateServerRules(rules, text, { channelId, memberRoleIds = [], isMemberModeratorTier = false }) {
  const careRules = [];
  const keywordRules = [];
  for (const rule of rules) {
    if (rule.isCare && rule.terms.length > 0) careRules.push(rule);
    else if (!rule.isCare && !rule.checkNames && rule.terms.length > 0) keywordRules.push(rule);
  }

  for (const rule of careRules) {
    if (ruleExemptChannel(rule, channelId) || ruleExemptRole(rule, memberRoleIds)) continue;
    if (ruleMatchesText(rule, text)) {
      return {
        kind: "care",
        rule,
        careNotice: rule.blockMessage ? rule.blockMessage : FILTER_RULE_DEFAULT_CARE_NOTICE,
      };
    }
  }

  if (isMemberModeratorTier) return { kind: "none" };

  for (const rule of keywordRules) {
    if (ruleExemptChannel(rule, channelId) || ruleExemptRole(rule, memberRoleIds)) continue;
    const hit = ruleMatchesText(rule, text);
    if (!hit) continue;
    const actions = rule.actions.length > 0 ? rule.actions : ["block"];
    if (actions.includes("block")) {
      return { kind: "blocked", rule, matched: hit.matched };
    }
    return { kind: "acted", rule, matched: hit.matched };
  }

  return { kind: "none" };
}

// evaluateNameRules(rules, name): the nickname screen — the check_names rules
// only. A name hit is a plain 400 ("That name isn't allowed."): care rules
// are message-body machinery and never screen names, and there is no logging
// of name hits anywhere.
export function nameRuleHit(rules, name) {
  for (const rule of rules) {
    if (!rule.checkNames || rule.isCare || rule.terms.length === 0) continue;
    if (ruleMatchesText(rule, name)) return true;
  }
  return false;
}

// --- the alert writer ---------------------------------------------------------------

// ALERT_INSERT_SQL / ALERT_PRUNE_SQL ride together in ONE batch from the
// caller: the feed's newest FILTER_ALERT_CAP_PER_SERVER rows are what a
// server keeps, and the write is all-or-nothing with the hit's bookkeeping.
export function filterAlertInsertSql() {
  return "INSERT INTO gc_filter_alerts (" +
    "server_id, channel_id, message_id, user_id, rule_id, rule_name, matched, body, created_at" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
}

export function filterAlertPruneSql() {
  return "DELETE FROM gc_filter_alerts WHERE server_id = ? AND id NOT IN (" +
    "SELECT id FROM gc_filter_alerts WHERE server_id = ? ORDER BY id DESC LIMIT " +
    FILTER_ALERT_CAP_PER_SERVER + ")";
}

// The mod-desk previews run the invisible-control strip (T10 U1) BEFORE the
// length cap: the alert is exactly what a moderator's own editor shows, with
// no bidi-mirage or zero-width padding riding the desk.
export function alertPreview(value) {
  const text = String(value ?? "").replace(GC_INVISIBLE_CONTROL_STRIP, "");
  return text.length > FILTER_ALERT_PREVIEW_MAX ? text.slice(0, FILTER_ALERT_PREVIEW_MAX) : text;
}

// --- the timeout-as-owner write -----------------------------------------------------

// The AutoMod timeout acts AS the filter's owner (the filed item): the
// automated actor satisfies the moderation/position guard by construction —
// the owner cannot be timed out and holds the top of the hierarchy, so the
// statement's guard is the membership row itself plus the owner-immunity
// rider, with NO actor hierarchy to satisfy. Same column, same duration menu,
// same overwrite semantics as the manual timeout route (a fresh timeout
// replaces a shorter remaining one).
export function timeoutAsOwnerSql() {
  return "UPDATE gc_server_members SET timed_out_until = ? " +
    "WHERE server_id = ? AND user_id = ? AND role <> 'owner'";
}

// --- the rules cache ----------------------------------------------------------------

const ruleCache = new Map(); // serverId -> { rules, at }

async function readRules(env, serverId) {
  const result = await env.GOOBER_DB.prepare(
    "SELECT id, server_id, name, terms, exempt_role_ids, exempt_channel_ids, actions, " +
      "is_care, check_names, block_message, timeout_minutes, created_by, created_at, updated_at " +
      "FROM gc_filter_rules WHERE server_id = ? ORDER BY id",
  ).bind(Number(serverId)).all();
  return (result.results || []).map((row) => ruleForEvaluation(publicRule(row)));
}

// loadServerRules(env, serverId): the send/nickname paths' one read per TTL
// window; pre-migration servers (no gc_filter_rules table yet… never — the
// migration carries it) and servers with no rules both cache an EMPTY list
// and cost nothing further until the window lapses.
export async function loadServerRules(env, serverId) {
  const key = Number(serverId);
  const cached = ruleCache.get(key);
  if (cached && Date.now() - cached.at < RULE_CACHE_TTL_MS) return cached.rules;
  let rules = [];
  try {
    rules = await readRules(env, key);
  } catch {
    // A missing table (an un-migrated shared database) keeps the filter OFF —
    // never 500s a send.
    rules = [];
  }
  ruleCache.set(key, { rules, at: Date.now() });
  return rules;
}

export function dropServerRulesCache(serverId) {
  ruleCache.delete(Number(serverId));
}

export function _resetServerRulesCacheForTests() {
  ruleCache.clear();
}
