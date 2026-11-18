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

// The locale lane — the ONE i18n module (the kit's law: vanilla imperative,
// no deps, no bundler). English is the only bundle that must be complete;
// every other locale is pure data in public/locales/<lang>.json, fetched
// with force-cache and applied progressively so a first paint never waits.
//
// Copy laws the loader carries (docs/i18n/glossary.md is the rulebook):
//   - locale JSON is DATA, never markup: the binding pass sets textContent
//     and attributes only — a markup parse never runs anywhere in here.
//   - a missing key is VISIBLE garbage (the humanized key tail), never
//     silent; the fallback chain is <lang> → <lang>'s base script → en.
//   - AGPLv3 and license names stay verbatim-English in every locale —
//     that is the translators' law, not the loader's, but t() never
//     rewrites what a bundle hands it.

// The bundle seats this repo ships. A navigator-derived tag must sit in
// this list (with the base-script fallback); a stored human choice may
// name any seat — a 404 just fails open to English.
export const BUNDLE_LANGS = ["en"];

const STORE_KEY = "lang";

const catalog = new Map(); // langKey -> flat { "gc.chat.pins.empty": "..." }
let lang = "en";

// --- language selection ------------------------------------------------------

function normalizeTag(tag) {
  const lowered = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
  if (!lowered) return null;
  if (BUNDLE_LANGS.includes(lowered)) return lowered;
  const base = lowered.split("-", 1)[0];
  return BUNDLE_LANGS.includes(base) ? base : null;
}

function storedLang() {
  try {
    const stored = String(localStorage.getItem(STORE_KEY) || "").trim().toLowerCase().replace(/_/g, "-");
    return stored || null; // an explicit human choice: any seat, fail-open below
  } catch {
    return null; // a blocked store keeps the default for this page
  }
}

function navigatorLang() {
  try { return normalizeTag(navigator.language); } catch { return null; }
}

// The base script ("zh-hans" → "zh") rides the chain, never a second fetch
// of a bundle nobody ships.
function candidates() {
  const seen = [];
  for (const candidate of [lang, lang.split("-", 1)[0], "en"]) {
    if (candidate && !seen.includes(candidate)) seen.push(candidate);
  }
  return seen;
}

export function currentLang() {
  return lang;
}

function setHtmlLang(tag) {
  try { document.documentElement.lang = tag; } catch { /* node or a locked doc */ }
}

// --- loading ----------------------------------------------------------------

async function loadBundle(langKey) {
  const response = await fetch(`/locales/${langKey}.json`, { cache: "force-cache" });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}

// initI18n() — en-first paint: the en bundle (or a cached failure, which
// leaves the catalog empty and every key visible-garbage) resolves before
// this returns; a non-en seat loads in the background and swaps the bound
// copy on resolve. The boot NEVER awaits the locale lane.
export async function initI18n() {
  const enBundle = await loadBundle("en");
  catalog.set("en", enBundle ?? {});
  lang = storedLang() || navigatorLang() || "en";
  if (lang === "en") {
    setHtmlLang("en");
    return lang;
  }
  try {
    const bundle = await loadBundle(lang);
    if (bundle) {
      catalog.set(lang, bundle);
      setHtmlLang(lang);
      applyDom();
      return lang;
    }
  } catch { /* 404/network: fail-open to English, silently */ }
  setHtmlLang("en");
  return lang;
}

// setLang(next) — the switcher's seat: stores the choice (per-viewer, the
// browser-storage law's convenience tier), loads the bundle, flips the
// bound copy in place. Refusals fail open to English like every other lane.
export async function setLang(next) {
  const langKey = String(next || "").trim().toLowerCase().replace(/_/g, "-");
  if (!langKey) return lang;
  try { localStorage.setItem(STORE_KEY, langKey); } catch { /* per-page */ }
  lang = langKey;
  let bundle = null;
  try { bundle = await loadBundle(langKey); } catch { /* fail-open */ }
  if (bundle) {
    catalog.set(langKey, bundle);
    setHtmlLang(langKey);
    applyDom();
  } else {
    setHtmlLang("en");
  }
  return lang;
}

// --- the lookup chain + plural rules -----------------------------------------

// The CLDR rule seat: the en-class two-branch shape en/es/de share, the
// shared fr/pt block (one = i = 0..1, plus the round-million many arm —
// es carries the same many arm), plus the extra arms ru and ar demand. A
// bundle adds `key_<rule>` suffixed branches when its rule needs them; the
// pick falls back key_other → key.
const PLURAL_RULES = {
  ru(n) {
    if (n !== Math.trunc(n)) return "other";
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "one";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "few";
    return "many";
  },
  ar(n) {
    if (!Number.isInteger(n)) return "other";
    if (n === 0) return "zero";
    if (n === 1) return "one";
    if (n === 2) return "two";
    if (n <= 10) return "few";
    if (n <= 99) return "many";
    return "other";
  },
  // CLDR 47, the shared locales="fr pt" block: one = i = 0..1 — read as the
  // integer part, so 0 and 1 ride the singular branch WITH every fractional
  // value in (0, 2) ("0,5 image", "1,5 image" — the rider's decimal arm;
  // "1,9 image" too). many = v = 0 and i != 0 and i % 1000000 = 0 — the
  // exact round millions (1000000, 2000000, 10000000, 35000000) — while
  // 1500000, 1000010, 999999, 1000000.5 and 2 ride other (probed against
  // Intl.PluralRules, the CLDR oracle). The only deviation from that oracle
  // is its operand fold (doubles quantize to 3 fraction digits): the sliver
  // [1.9995, 2) would read i = 2 and [999999.9995, 1000000) would read
  // i = 1000000 — this text stays unfolded; no value this copy set renders
  // can land in either sliver. A fr/pt bundle ships `key_many` only when its
  // copy wants the partitive phrasing; the chain falls back key_other → key.
  fr(n) {
    if (n >= 0 && n < 2) return "one";
    if (!Number.isInteger(n) || n % 1000000 !== 0) return "other";
    return "many";
  },
  pt(n) {
    if (n >= 0 && n < 2) return "one";
    if (!Number.isInteger(n) || n % 1000000 !== 0) return "other";
    return "many";
  },
  // CLDR 47 es: one = n = 1 exactly (es 1.0/1.00/1.000/1.0000 — the JS
  // number 1 covers them; 1.5, 0 and every other value ride other), plus
  // the same round-million many arm fr/pt carry — the reviewer's fuzz pinned
  // the mismatch this seat closes: bare 1000000/2000000/35000000 rode
  // "other" under the en fallback while ICU es routes them many. ICU finds
  // no many arm for de/it/en (probed other) — they stay on the en map. The
  // table assumes counts are non-negative — negatives are unreachable, the
  // same unreachability class as the fold slivers above — and counts arrive
  // as integers: a fractional negative falls to other by the integer guard.
  es(n) {
    if (n === 1) return "one";
    if (!Number.isInteger(n) || n === 0 || n % 1000000 !== 0) return "other";
    return "many";
  },
  en(n) {
    return Number.isInteger(n) && n === 1 ? "one" : "other";
  },
};

// The ru seat rides its mod-10/100 rule unchanged from the loader build;
// its fractional and negative inputs (ru 0.5 → other, ru -1 → other) were
// fuzz-clean for this copy set's integer counts, so no ru change rides the
// es arm — stated ruling, not an omission.

function pluralRule(langKey, n) {
  const seat = PLURAL_RULES[langKey] ?? PLURAL_RULES[langKey.split("-", 1)[0]] ?? PLURAL_RULES.en;
  return seat(n);
}

function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match);
}

// t(key, vars) — the ONE lookup. Missing keys humanize the key's tail so a
// miss is visible, never silent; en.json is the only complete bundle. The
// plural seat engages on a count var: vars.n (the loader's engine var) and
// vars.count (the var name the grammar keys themselves interpolate) drive
// the same rule — without the count name, every grammar branch row would be
// unreachable.
export function t(key, vars = null) {
  const count = vars && Number.isFinite(vars.n) ? vars.n
    : vars && Number.isFinite(vars.count) ? vars.count
    : null;
  const variants = count === null
    ? [key]
    : [`${key}_${pluralRule(lang, count)}`, `${key}_other`, key];
  for (const langKey of candidates()) {
    const bundle = catalog.get(langKey);
    if (!bundle) continue;
    for (const variant of variants) {
      const value = bundle[variant];
      if (typeof value === "string") return interpolate(value, vars);
    }
  }
  return humanize(key);
}

function humanize(key) {
  const tail = String(key).split(".").pop() || key;
  const words = tail
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return String(key);
  const [first, ...rest] = words;
  return first[0].toUpperCase() + first.slice(1) + (rest.length ? " " + rest.join(" ") : "");
}

// --- numbers + dates ---------------------------------------------------------

function localeTag() {
  return lang === "en" ? (navigatorLang() || "en") : lang;
}

export function fmtNumber(value, options = null) {
  try {
    return new Intl.NumberFormat(localeTag(), options ?? undefined).format(value);
  } catch {
    return String(value); // an unsupported tag never breaks a number
  }
}

export function fmtDate(value, options = null) {
  try {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(localeTag(), options ?? undefined).format(date);
  } catch {
    return String(value); // the raw value beats "Invalid Date"
  }
}

// --- the binding pass ---------------------------------------------------------

// applyDom(root) — idempotent; the sweep's re-call sites are the painters
// that already re-run per route render. Locale content is DATA: textContent
// and attribute setters only, never a markup parse.
export function applyDom(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n"));
  }
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder")));
  }
  for (const node of root.querySelectorAll("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria")));
  }
}
