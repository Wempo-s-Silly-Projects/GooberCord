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

// Non-function shared constants. Kept out of worker.mjs's exports because
// workerd validates every Worker export as a function or ExportedHandler.
// This is the shared auth-contract surface the vendored api/core modules
// (and their wempos-forum twins) both import; the parity test at
// tests/contract-parity.test.mjs pins the vendored core to the forum's.

// Password hashing work factor. Keep aligned with the password verification
// implementation and benchmark when changing this value. Shared with the
// forum: password rows in the one production D1 database are only verifiable
// while both apps use the same pepper and the same iteration count.
export const PBKDF2_ITERATIONS = 100000;

export const SESSION_INSERT_IF_UNBANNED_SQL =
  "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) " +
    "SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (" +
    "SELECT 1 FROM bans WHERE user_id = ? AND revoked_at IS NULL " +
    "AND (expires_at IS NULL OR expires_at > ?))";

// Rate limiting scopes. The GooberCord bindings (wrangler.toml) are named
// GC_*_RATE_LIMITER and are separate from the forum's limiters, so a forum
// spike can never throttle GooberCord traffic (and vice versa) despite the
// shared D1 database.
export const RATE_LIMIT_BINDINGS = Object.freeze({
  read: "GC_READ_RATE_LIMITER",
  write: "GC_WRITE_RATE_LIMITER",
  guest: "GC_GUEST_RATE_LIMITER",
  register: "GC_REGISTER_RATE_LIMITER",
  login: "GC_LOGIN_RATE_LIMITER",
  message: "GC_MESSAGE_RATE_LIMITER",
  upload: "GC_UPLOAD_RATE_LIMITER",
  password: "GC_PASSWORD_RATE_LIMITER",
  totp: "GC_TOTP_RATE_LIMITER",
});

// Server channel cap (Phase 1 Task 4; the number is now parity-law bound):
// the guarded channel INSERT's COUNT(*) <= MAX_CHANNELS_PER_SERVER - 1
// precondition enforces this per gc_ server (the #general channel counts
// toward it). docs/parity-limits.md: Channels per server 500 —
// text+voice+categories combined (verified 2026-11-17).
export const MAX_CHANNELS_PER_SERVER = 500;

// Categories per server (parity law): the guarded category INSERT's
// COUNT(*) precondition, mirroring the channel cap's shape.
// docs/parity-limits.md: Categories per server 50 (verified 2026-11-17).
export const GC_CATEGORIES_MAX_PER_SERVER = 50;

// Roles per server (parity law): the guarded role INSERT's COUNT(*)
// precondition mirrors the channel cap's shape. The 250 counts @everyone,
// which lives NOWHERE as a row (it is the server's virtual base role), so the
// explicit gc_roles ceiling is 250 - 1.
// docs/parity-limits.md: Roles per server 250 incl. @everyone, error 30005
// (verified 2026-11-17).
export const GC_ROLES_MAX_PER_SERVER = 250;

// Invite codes per server (parity law): the guarded invite INSERT's COUNT(*)
// precondition, counted over the server's gc_invites rows (revoked rows stay
// counted — the conservative rail). docs/parity-limits.md: Invite codes per
// server ~999 / API 1000, error 30016 (verified 2026-11-17); this binds the
// API number.
export const GC_INVITES_MAX_PER_SERVER = 1000;

// Servers joinable per account (parity law): the two join INSERTs' COUNT(*)
// precondition carries the CASE'd ceiling keyed on an ACTIVE gc_plus_state
// row (the plusActiveExpr shape). docs/parity-limits.md: Servers joinable 100
// free / 200 friend-passes tier (verified 2026-11-17).
export const GC_SERVERS_JOIN_MAX_FREE = 100;
export const GC_SERVERS_JOIN_MAX_PLUS = 200;

// Message body bounds (0021, owner-blessed via the tier matrix): one message
// body, tiered at ADMISSION — free keeps 2000, Goober+ admits 4000 (Nitro's
// shape). The DB CHECK floors the widest bound; the route applies the tier.
export const GC_FREE_MESSAGE_MAX = 2000;
export const GC_PLUS_MESSAGE_MAX = 4000;

// Back-compat alias: the widest admission bound, what the DB CHECK carries.
export const GC_MESSAGE_MAX = GC_PLUS_MESSAGE_MAX;

// Attachment upload chunking: each D1 blob chunk stays under the 100KB D1
// row budget (Phase 1 Task 8/9).
export const ATTACHMENT_CHUNK_BYTES = 64000;

// Image attachment cap (Phase 1 Task 6, RAISED by the 0025 parity pass —
// Discord's free tier is 20 MiB as of Aug 2026): the schema CHECKs size_bytes
// at the raised bound, but the JS intake refuses one byte more FIRST — a
// rejection that happens before any sniffing, sanitizing, or chunk insert can
// run. The request ceiling adds multipart envelope slack on top of the file
// cap.
export const MAX_ATTACHMENT_BYTES = 20_971_520;
export const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 512 * 1024;

// Goober+ perk tier (the 2026-11-17 Nitro-perks lane; each value blessed,
// then AMENDED by the economy re-rule the same day): integer tier values, not
// a runtime multiplier — the coin ledger's deltas are INTEGER rows
// (CHECK(delta <> 0)), so the tier reads as per-path values. The re-rule
// RETIRES the claim's tier (25 flat for everyone) and re-bases the message
// rate (2 free / 3 plus); voice (5/8) and the daily ceiling (250/500) stand
// as ever. The mint statements take the tier's values as binds
// (api/coins.mjs); a free member's values are the GC_COIN_* constants.
export const GC_PLUS_MESSAGE_GRANT = 3;
export const GC_PLUS_VOICE_GRANT = 8;
export const GC_PLUS_DAILY_CEILING = 500;

// The ECONOMY RE-RULE (owner, 2026-11-17): coins are earned by being IN the
// community and spent on COSMETICS — the claim tiering is retired (25 flat
// for everyone; GC_PLUS_DAILY_GRANT is gone). The remaining plus earns are
// these integer per-path values beside the free constants of the same block.
//
// The forum-post ROLLUP: a LAZY mint (the member's next coins touch mints one
// rollup row per UTC day for that user) counting the day's PUBLIC posts of
// GC_ROLLUP_MIN_BODY+ chars, at the tiered rate, capped at this many posts.
export const GC_ROLLUP_GRANT = 3;
export const GC_PLUS_ROLLUP_GRANT = 5;
export const GC_ROLLUP_DAILY_CAP = 5;
export const GC_ROLLUP_MIN_BODY = 40;
// The SERVER-CREATE mint: the community-builder's grant (50 free / 75 plus),
// capped at this many mints per UTC day (not coins — mint EVENTS).
export const GC_SERVER_GRANT = 50;
export const GC_PLUS_SERVER_GRANT = 75;
export const GC_SERVER_MINT_DAILY_CAP = 2;

// The SINK (coins' one purpose now): the cosmetics prices. GC_PLUS_SINK_
// DISCOUNT_PERCENT is enforced ROUTE-SIDE (api/coins.mjs) — the shop payload
// exposes BOTH prices and the spend statement carries the caller's own tier.
// The pack is PLUS-ONLY at its flat 250 (no discount: buying the pack is
// itself the plus-lane item). Accent + tagline stay FREE (owner call).
export const GC_COSMETIC_PACK_PRICE = 250;
export const GC_COSMETIC_BANNER_PRICE = 100;
export const GC_COSMETIC_FLAIR_PRICE = 100;
export const GC_PLUS_SINK_DISCOUNT_PERCENT = 50;

// The COMMUNITY SEATS (2026-11-18 re-code wave): the Morning Paper's and the
// community anniversaries' numbers, plus the campfire books' window. Every
// window bound and section cap is a named import at the route — no magic
// numbers there.
//
// The paper's UTC day key: one day, and the "previous paper" re-derives the
// window this many day-keys back (a bounded tail of ONE full day — no
// per-issue archive exists anywhere, the derivation IS the history).
export const GC_PAPER_DAY_SECONDS = 86400;
export const GC_PAPER_YESTERDAY_KEYS = 1;
// Section caps: each aggregate section cuts at its own read-time LIMIT; the
// numbers are GC-shaped (no Discord source) and sized against the read-page
// idiom (25 default, 10 for the big-window day sections).
export const GC_PAPER_CHANNELS_MAX = 10;
export const GC_PAPER_REACTIONS_MAX = 10;
export const GC_PAPER_ANNIVERSARIES_MAX = 25;
// The anniversary's structural bounds: month 0-11 (the UTC month index the
// celebrant join binds), day 1-31 — no per-month day counts, no leap math.
export const GC_USER_ANNIVERSARY_MONTH_MAX = 11;
export const GC_USER_ANNIVERSARY_DAY_MAX = 31;
// The campfire books' trailing window (30 days): the server's economy
// aggregate over the gc_coin_ledger rows the economy already mints — a READ
// window, never a table.
export const GC_CAMPFIRE_LEDGER_WINDOW_SECONDS = 2592000;

// The SERVER BOOST LEVELS (2026-11-17 matrix): per-server perk numbers keyed
// on the boost count, carried FULLY on each level (the matrix's "level N
// plus" inheritances are spelled out so one lookup answers everything). The
// feature-shaped gates (animated icons, static then animated banners, role
// icons, invite backgrounds, custom invite links) are named booleans here —
// their UI/assets waves are the frontend's; this table carries the numbers
// the backend owns: inventory caps, stream quality + fps, audio bitrate, the
// per-server upload size, and the stage seats.
export const GC_BOOST_LEVELS = Object.freeze([
  Object.freeze({
    level: 1, boosts: 2,
    emoji: 100, stickers: 15, soundboard: 24,
    streamHeight: 720, streamFps: 60, audioBitrate: 128,
    uploadBytes: 10_485_760, stageSeats: 50,
    animatedIcon: true, inviteBackground: true,
    staticBanner: false, roleIcons: false,
    animatedBanner: false, customInviteLink: false,
  }),
  Object.freeze({
    level: 2, boosts: 7,
    emoji: 150, stickers: 30, soundboard: 36,
    streamHeight: 1440, streamFps: 60, audioBitrate: 256,
    uploadBytes: 52_428_800, stageSeats: 150,
    animatedIcon: true, inviteBackground: true,
    staticBanner: true, roleIcons: true,
    animatedBanner: false, customInviteLink: false,
  }),
  Object.freeze({
    level: 3, boosts: 14,
    emoji: 250, stickers: 60, soundboard: 48,
    streamHeight: 1440, streamFps: 60, audioBitrate: 384,
    uploadBytes: 104_857_600, stageSeats: 300,
    animatedIcon: true, inviteBackground: true,
    staticBanner: true, roleIcons: true,
    animatedBanner: true, customInviteLink: true,
  }),
]);
// The upload TIERS (2026-11-17 matrix, the 0025 parity pass amended free):
// free admits 20 MiB (Discord's Aug-2026 free raise, MAX_ATTACHMENT_BYTES
// above), Goober+ Mini admits 50 MiB, full Goober+ admits the 1 GiB ceiling
// the 0022 CHECK carries (the 0013-era 25 MiB value is superseded — Mini
// alone outgrew it). The route enforces the per-member tier from these pairs;
// the CHECK is the safety floor. Each request ceiling adds multipart
// envelope slack on top of its file cap.
export const GC_MINI_ATTACHMENT_BYTES = 52_428_800;
export const GC_MINI_ATTACHMENT_REQUEST_BYTES = GC_MINI_ATTACHMENT_BYTES + 512 * 1024;
export const GC_PLUS_ATTACHMENT_BYTES = 1_073_741_824;
export const GC_PLUS_ATTACHMENT_REQUEST_BYTES = GC_PLUS_ATTACHMENT_BYTES + 512 * 1024;

// The LARGE-FILE upload lane — D1-ONLY since 2026-11-17 (owner ruling: "no
// park, and no r2"): a part request carries GC_UPLOAD_PART_CHUNKS of the
// proven 64 KiB intake chunks in ONE batched write (the shipped small
// intake already lands up to 320 chunk statements in a single batch — the
// measured envelope — so 16 sits far inside it), sliced off one ≤-part-sized
// body. All parts ride the gc_upload_parts staging table (migration 0025);
// the commit moves the set into gc_attachment_chunks and empties it.
export const GC_UPLOAD_PART_CHUNKS = 16;
export const GC_UPLOAD_PART_BYTES = GC_UPLOAD_PART_CHUNKS * ATTACHMENT_CHUNK_BYTES;
export const GC_UPLOAD_PART_REQUEST_BYTES = GC_UPLOAD_PART_BYTES + 512 * 1024;
export const GC_UPLOAD_PARTS_MAX = 128;
export const GC_UPLOAD_CHUNKS_MAX = GC_UPLOAD_PARTS_MAX * GC_UPLOAD_PART_CHUNKS;

// The WORKING lane's engineering bound (NOT the tier table's wording —
// flagged): derive from the verified platform rows (both fetched
// 2026-11-17). GC_UPLOAD_PARTS_MAX × GC_UPLOAD_PART_BYTES = 131,072,000
// bytes (~125 MiB):
//   - D1 free plan: 500 MB total database storage (the SHARED forum DB) —
//     one attachment may not eat a quarter of it; 50 queries per Worker
//     invocation bound the paged serving (a lane-max file pages at 64
//     chunk rows per query = 32 reads, headroom under the cap).
//   - Workers free plan: 10 ms CPU per request (a ≤1 MiB multipart parse +
//     16-statement batch sits inside it), 128 MB isolate memory (never
//     holds more than one part or one serving page).
// GC_PLUS_ATTACHMENT_BYTES keeps its 1 GiB row wherever the parity table
// shows tier numbers (docs/parity-limits.md UPLOADS), but the WORKING lane
// refuses above this bound — the tier row wants the owner's wording:
// "1 GiB (lane bound: 125 MiB today)".
export const GC_UPLOAD_LANE_MAX_BYTES = GC_UPLOAD_PARTS_MAX * GC_UPLOAD_PART_BYTES;

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Voice (Phase 2): one WS binary frame per 20ms Opus packet, fanned out by the
// channel's own ChatRoom Durable Object (api/rooms.mjs). No WebRTC mesh, no
// SFU, no media proxying — the DO just relays small binary frames, which the
// FREE plan's hibernating DOs handle without any paid feature. These are the
// hard limits that keep it that way, mirrored in the voice pane's UI copy:
export const GC_VOICE_FRAME_VERSION = 1;
// Per channel. Talkers are capped by this participant cap too: the client only
// feeds Opus frames while its mic level is above the VAD threshold, so voices
// never exceed participants, and a 6-participant fan-out relays at most ~1,500
// 60-byte frames/sec DO-side — comfortable on the free plan.
export const GC_VOICE_MAX_PARTICIPANTS = 6;
// One Opus packet tops out at 1275 bytes (full-band 20ms at max bitrate); the
// ceiling has slack for header growth but still bounds a single frame a peer
// can make the DO relay to every other participant.
export const GC_VOICE_MAX_FRAME_BYTES = 2048;

// The server rules gate (0012): one owner-set text + per-member acceptance.
// The owner's rules document is bounded like the forum's own rules page copy
// (20 KiB); the shared 403's stable message rides the gate's payload so the
// client and the DO frames can echo it verbatim.
export const GC_RULES_MAX = 20_000;
export const RULES_GATE_MESSAGE = "You must accept this server's rules before doing that.";

// Goober Coins (owner decisions, 2026-11-16). Earned ONLY by activity, never
// purchased, never transferable, never expiring; the balance is SUM(gc_coin_
// ledger.delta) — no balance column exists. All four numbers below feed
// guards that ride INSIDE the ledger INSERTs themselves (api/coins.mjs), so
// the caps hold under races and replays, not just under polite clients.
//
// The daily ceiling is the hard farm cap ACROSS all grant sources: earned
// today (positive deltas only — spends never refund a ceiling) is checked
// against it by every minting statement.
export const GC_COIN_DAILY_CEILING = 250;
// The daily activity grant, claimed ONCE per UTC day on the shop page
// (POST /api/coins/claim — one consistent way; message/voice grants stay
// automatic because those are earned points, not the daily grant).
export const GC_COIN_DAILY_GRANT = 25;
// Per-message earned points: +1 per POSTED message, capped within its own
// source (GC_COIN_MESSAGE_DAILY_CAP messages' worth) AND the ceiling.
export const GC_COIN_MESSAGE_GRANT = 2;
export const GC_COIN_MESSAGE_DAILY_CAP = 100;
// Voice-presence time grants: the client posts one tick per presence window
// WHILE its voice session is connected; each verified tick grants this much.
// A spoofed tick stream is harmless — the source cap plus the ceiling bound
// it exactly like honest time does.
export const GC_COIN_VOICE_GRANT = 5;
export const GC_COIN_VOICE_TICK_SECONDS = 600;
export const GC_COIN_VOICE_DAILY_CAP = 150;

// Daily quests (recode lane, 2026-11-18). The claim IS the re-rule's claim
// — 25 flat, minted into the DAILY slot shared with the shop claim, so the
// quest surface mints nothing the plain claim could not have minted
// (api/quests.mjs). Goals derive from the ledger's earn rows: message earn
// rows are one row per posted message (the 2-3 per-message re-rule rate),
// voice rows one per presence tick, and the earn goal counts the day's
// positive deltas. No quest table exists: progress is derived at read.
export const GC_QUEST_CLAIM = GC_COIN_DAILY_GRANT;
export const GC_QUEST_GOAL_MESSAGES = 20;
export const GC_QUEST_GOAL_VOICE = 2;
export const GC_QUEST_GOAL_EARNED = 150;

// Goober+ (owner decisions: ONE bundle, MONTHLY renewal, a grace window,
// boosts stay free, GIFT Goober+ in). The price buys gc_plus_state term
// extensions; the coin spend itself is gc_coin_ledger's negative row.
export const GC_PLUS_BUNDLE_NAME = "Goober+";
// The owner's pricing amendment: a member's FIRST term costs the full price,
// every later term (self-renewal OR a gift to someone who already has a row)
// is the renewal price.
export const GC_PLUS_PRICE = 500;
export const GC_PLUS_RENEWAL_PRICE = 400;
export const GC_PLUS_TERM_DAYS = 30;
export const GC_PLUS_GRACE_DAYS = 7;

// The Goober+ MINI SKU (the 2026-11-17 matrix's two member tiers): the
// lighter term buys the Mini perk set only — custom emoji anywhere (+ the
// animated ones), stickers, Super Reactions, the 50 MB upload cap, the
// badge. NO economy rider (the coin earn/discount numbers stay
// full-plus-only, the strict plusPerkActive decision), NO 4000-char
// messages, NO extra boosts. Same term/grace shape as the full pair. The
// PRICES are PROPOSED pending the owner's ruling — half the Goober+ pair.
export const GC_MINI_BUNDLE_NAME = "Goober+ Mini";
export const GC_MINI_PRICE = 250;
export const GC_MINI_RENEWAL_PRICE = 200;

// Custom emoji + stickers (parity bundle, Nov 17 2026). The 50-per-server
// inventory is Discord's own cap (the checklist's intake line) and rides the
// create statements themselves, so a burst of parallel creates can never
// overshoot it. The upload always RODE the attachment intake: magic bytes,
// sanitizer, 64k chunks, pending moderation — an emoji is just another
// referenced image (APNG's animated form rides image/png untouched).
export const GC_EMOJI_MAX_PER_SERVER = 50;
// The sticker inventory ALSO resolves by boost level (0025's parity pass,
// the ladder the owner relayed from Discord's real caps): the level-0 base
// is Discord's 5, and the matrix's L1/L2/L3 blessings (15/30/60) ride
// GC_BOOST_LEVELS through the shared resolver's max-of shape. An inventory
// over a SMALLER cap (a server whose level dropped) is never deleted —
// only new creates are blocked (the disabled-not-deleted equivalent).
export const GC_STICKER_MAX_PER_SERVER = 5;
// The soundboard's slots are BOOST-LADDERED too, but the level-0 base is
// Discord's REAL 8 (0025's correction — the 0023 matrix's "admits none"
// was wrong): every server HAS a board. The blessings (24/36/48) ride
// GC_BOOST_LEVELS through the shared resolver.
export const GC_SOUNDBOARD_MAX_PER_SERVER = 8;
// A sound FILE'S own intake bounds (Discord-real, 0025): MP3/OGG only,
// 512 KB per sound. The request ceiling adds multipart envelope slack.
export const GC_SOUNDBOARD_SOUND_MAX_BYTES = 524_288;
export const GC_SOUNDBOARD_SOUND_REQUEST_BYTES = GC_SOUNDBOARD_SOUND_MAX_BYTES + 512 * 1024;
// Pack clips (GC-beyond-parity: the server's own theater packs — the PARITY
// board sounds cap above stays 512 KB untouched): the tier caps law's floor —
// a pack clip intake may never admit LESS than 5 MB. The client's G-4 mirror
// (public/js/ui/soundboard-studio.js) pins equality to this seat.
export const GC_SOUND_PACK_CLIP_MAX_BYTES = 5_242_880;
// Expression FILE caps (the W-B0 parity law pass):
// docs/parity-limits.md — Emoji ≤256 KB (animated = own pool, filed wave);
// Stickers ≤512 KB, 320×320 (APNG = Lottie). Both caps gate the expression
// intake (multipart file size AND, for a JSON create's pre-existing row, the
// attachment's recorded size_bytes) — a legacy oversized row keeps working,
// only NEW references respect the bound.
// docs/parity-limits.md: Emoji file limit 256 KB (verified 2026-11-17).
export const GC_EMOJI_FILE_MAX = 262_144;
// docs/parity-limits.md: Sticker file limit 512 KB (verified 2026-11-17).
export const GC_STICKER_FILE_MAX = 524_288;
// The admitted sound formats: the soundboard intake AND the serving verdict
// share this pair — one source (W-B0's NIT-6 tighten).
export const GC_SOUND_INTAKE_MIMES = Object.freeze(["audio/mpeg", "audio/ogg"]);
// Wire tokens: <e:name:id> / <s:name:id>. At the 32-char emoji name cap and
// an 8-digit id the token is 45 characters — a body text token, no column
// CHECK it can overrun (gc_message_reactions' emoji CHECK 1..32 keys the
// unicode emoji string, never a token).
// Name bounds are PER KIND since the 0026 parity wave (each table's CHECK
// rides its own bound; the sticker's 30 is EXACT, NOT a 32 superset — a
// 31-char sticker name failing is parity-correct):
// docs/parity-limits.md: Emoji 2–32 (corroborated docs.food/userdoccers;
//   official page silent — NON-OFFICIAL-source flag), Sticker 2–30 (OFFICIAL
//   sticker resource), Soundboard sound 2–32 (OFFICIAL soundboard resource).
export const GC_EMOJI_NAME_MIN = 2;
export const GC_EMOJI_NAME_MAX = 32;
export const GC_EMOJI_NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;
export const GC_STICKER_NAME_MIN = 2;
export const GC_STICKER_NAME_MAX = 30;
export const GC_STICKER_NAME_PATTERN = /^[A-Za-z0-9_]{2,30}$/;
export const GC_SOUND_NAME_MIN = 2;
export const GC_SOUND_NAME_MAX = 32;
export const GC_SOUND_NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;

// Pins per channel (parity law): the cap on is_pinned rows a channel may
// hold; the 251st pin 400s with the exact copy the routes carry. GET /pins
// serves the newest-first LIMIT of the same constant.
// docs/parity-limits.md: Pins per channel 250 (verified 2026-11-17).
export const GC_PINS_MAX_PER_CHANNEL = 250;

// Super reactions (the plus-gated tier on the existing reaction stack): the
// set of unicode emoji that mark a reaction as "super". A non-plus member's
// ADD is refused at the reaction route; the SET itself is plain data (a
// client shows its sparkle styling keyed on it, never on a tier list).
export const GC_PLUS_REACTIONS = Object.freeze([
  "✨", "💫", "🌟", "🎆", "🎇", "🌈", "🪄", "🩷",
]);

// Unique reactions per message (parity law): one read answers both halves —
// the distinct-emoji count and whether the CALLER already put THIS emoji on
// the message (at the cap, adding the 21st new emoji 400s; adding a repeat
// of an emoji already there is a no-op row, never a refusal — the per-emoji
// reactor count stays unlimited).
// docs/parity-limits.md: Unique emoji per message (reactions) 20, error 30010
// (verified 2026-11-17).
export const GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE = 20;

// Reaction tags (recode lane, 2026-11-18): the cosmetic emoji→tag map's
// caps. Storage rides the PROD-APPLIED 0041/0043 ledger tables
// (gc_server_reaction_tags + gc_reaction_tag_opts) — no migration file
// here. The map cap bounds a mod's pinned emoji→tag pairs per server; the
// text cap bounds a server-native tag string (a locale-key reference like
// gc.tags.campfire is exempt from the code-point cap — api/reaction-tags.mjs).
export const GC_REACTION_TAGS_MAX = 20;
export const GC_REACTION_TAG_TEXT_MAX = 32;

// Mentions (parity law): the persisted per-mention rows a send may carry.
// Today's developer docs cap AllowedMentions' id arrays at 100 per message
// (discord.com/developers/docs/resources/message#allowed-mentions-object —
// "max 100", both the users and the roles arrays, verified 2026-11-17), so
// the send-side resolved-id budget rides the same 100; the mentions
// ENDPOINTS are not in today's docs (fetched 2026-11-17), so GC's inbox
// surface is GC-shaped. Citation rows: docs/parity-limits.md MESSAGING.
export const GC_MENTIONS_MAX_PER_MESSAGE = 100;
// The inbox read cap: GC's own pages (the alerts-feed idiom — a bounded
// LIMIT with a 400 outside the cap), 25 answered by default.
// docs/parity-limits.md: Mentions inbox read limit 25 default / 100 max
// (GC-shaped — no Discord source; idiom verified against the live alerts
// route 2026-11-17).
export const GC_MENTIONS_PAGE_DEFAULT = 25;
export const GC_MENTIONS_PAGE_MAX = 100;
// Server message search: GC's own read surface — 25 hits per page, the
// term bounded at 100 characters.
// docs/parity-limits.md: Message search 25 hits / 100 chars (GC-shaped —
// no Discord source; sized against the ledger page idiom 25/100
// 2026-11-17).
export const GC_SEARCH_PAGE_MAX = 25;
export const GC_SEARCH_TERM_MAX = 100;

// Time capsules (lane2-lifecycle recode, migration 0052): the scheduled
// letter's four caps. One schedule, one reveal, ZERO timers — every number
// here is a cap or a schedule bound, nothing else. GC-shaped caps (no
// Discord parity source; house-sized against the message body family).
export const GC_CAPSULE_BODY_MAX = 2000;
export const GC_CAPSULE_MIN_AHEAD_SECONDS = 300;
export const GC_CAPSULE_MAX_AHEAD_SECONDS = 2592000;
export const GC_CAPSULES_MAX_OPEN_PER_MEMBER = 10;

// Bookmarks (lane2-lifecycle recode, migration 0053): the private reading
// list's only cap — the newest N of the caller's own pointers the GET
// answers (GC-shaped — no Discord parity source; sized against the pin
// read's own cap idiom, GC_PINS_MAX_PER_CHANNEL above).
export const GC_BOOKMARKS_LIST_MAX = 100;

// Welcome cards (lane2-lifecycle recode): the mod-set greeting blurb's
// HOUSE cap. Migration 0042's gc_welcome_cards table predates this lane in
// the prod ledger, so the column takes whatever the route's arm admits —
// this constants seat is the one bound. GC-shaped (no Discord source —
// the card is GC's own surface).
export const GC_WELCOME_CARD_BLURB_MAX = 300;

// R2 object keys (the shared wempos-forum-r2 bucket, binding GC_MEDIA): the
// GC attachment images live under gc-attachments/<attachment id> and the
// shared users table's approved avatars under avatars/<user id> — the key
// shapes the forum's own avatar lane already wrote (avatars/<id> byte-verified
// for all 26 rows 2026-11-18). Prefix-only here (this file carries no
// functions); the callers splice the ids onto them.
export const GC_ATTACHMENT_OBJECT_PREFIX = "gc-attachments/";
export const GC_AVATAR_OBJECT_PREFIX = "avatars/";
