// THE PARITY LAW (owner rethink, Nov 17 2026 ~22:01: "completely rethink the
// idea of parity ... using web search"): GooberCord does not hand-tune
// numbers, and no matrix written from memory is a source. Every numeric
// limit in this codebase CITES a row of this table, and every row was
// VERIFIED against Discord's live documentation the day it was added. When
// you need a number that is not here: STOP, verify it against
// support.discord.com / docs.discord.com, add the row WITH the source and
// the verification date, and only then write code. Invented numbers are
// bugs, exactly like wrong code.
//
// Verified 2026-11-17 (sources: Discord Support "Account Caps, Server Caps,
// and More" + "Soundboard Guide" + "Boosting FAQ" + "Custom Stickers FAQ" +
// the Discord developer changelog; cross-checked conferbot/third-party 2026
// references). Re-verify a row before relying on it if the shipping date is
// far from the verify date.

SERVER / CHANNEL CAPS
| Cap                          | Value | Notes (source verified 2026-11-17)     |
|------------------------------|-------|----------------------------------------|
| Channels per server          | 500   | text+voice+categories ONE pool (30013) |
| Categories per server        | 50    |                                        |
| Channels per category        | 50    |                                        |
| Roles per server             | 250   | incl. @everyone; never raised by boosts (30005) — GC: GC_ROLES_MAX_PER_SERVER (0028: role INSERT's COUNT guard, @everyone counted as the virtual 250th) |
| Role name length             | 1–100 |                                        |
| Channel name length          | 2–100 |                                        |
| Pins per channel             | 250   | raised 50→250 Aug 4 2025 patch (discord.com/blog/discord-patch-notes-august-4-2025); the dedicated "Pin Messages" permission citation: discord-api-docs PR #7766 (merged Aug 20 2025) + the Sept 3 2025 patch notes |
| Members per server           | 25    | (million)                              |
| Invite codes per server      | ~999  | API 1000 (30016) — GC: GC_INVITES_MAX_PER_SERVER 1000 (0028: invite INSERT's COUNT guard, rows stay counted — revoked codes hold the rail) |
| Threads                      | 1000 members/thread; auto-archive 1h/24h/3d(default)/7d; don't count vs 500 | docs.discord.com/developers/topics/threads — NO THREAD SURFACE YET: bindings deferred to the feature lane (registered 2026-11-17, parity-P0 row 5) |
| Forum channels               | thread-only; posts need only SEND; 5 tags ≤20ch; exactly 1 pinned post | support / Forum-Channels-FAQ |
| Stage channels               | 10k viewers audio-only; video 50 base /150 L2 /300 L3; 5 cameras; 1 screen | support / Stage-Channels-FAQ |
| Scheduled events             | 100 scheduled/active per guild; voice events 99 participants; auto-cleanup ~8h past | docs guild-scheduled-event |
| Offline roster display       | hides past 1000 | caps page                     |

MESSAGING / INTERACTIVE
| Cap                              | Value | GC binding |
|----------------------------------|-------|------------|
| Polls                            | 10 answers; q ≤300 text-only; answers ≤55 + emoji; durations 1h/4h/8h/24h/3d/1w | NO POLL SURFACE YET: nothing to bind — feature lane owns the numbers when polls land (registered 2026-11-17, parity-P0 row 5) |
| Unique reactions per message     | 20 (30010); animated custom emoji allowed as reactions | correction wave dispatched |
| Mentions per message (SEND) | 100 ids (AllowedMentions' users and roles arrays each cap at 100) — discord.com/developers/docs/resources/message#allowed-mentions-object (verified 2026-11-17); the deprecated mentions endpoints are NOT in today's docs (also fetched 2026-11-17) — GC's inbox surface is GC-shaped | GC_MENTIONS_MAX_PER_MESSAGE (0028): resolved ids capped at 100 per send, one gc_mentions row per (message, user) — repeats dedupe |
| Mentions inbox read | GC-shaped (GC_MENTIONS_PAGE_DEFAULT 25 / GC_MENTIONS_PAGE_MAX 100, the alerts-feed idiom, verified live 2026-11-17); DELETE /api/mentions/:id rides the deprecated endpoint's message-id shape; rows guard membership-side (a left server/conversation never feeds the inbox); rows SNAPSHOT at send (a later edit never re-pings: edit-added mentions AND an edit introducing @everyone/@here write NO gc_mentions row — deliberate GC-shaping) | constants.mjs (0028) |
| Message search (GC-shaped) | 25 hits per read, 100-char term (both constants GC-shaped — no Discord source; the 25/100 pair sized on the ledger-page idiom, verified live 2026-11-17), LIKE over text-channel bodies with the ESCAPE arm (user % and _ literalized); whole-word seams stay a later lane | GC_SEARCH_PAGE_MAX / GC_SEARCH_TERM_MAX (0028) |
| Message length free / plus       | 2000 / 4000 ✓ shipped |
| AutoMod | 10 rules/server shaped 6 keyword + 1 preset-spam + 1 mention-spam + 1 member-profile; 1000 terms ×60ch PER KEYWORD RULE; 10 regex ×260ch PER RULE; 100 allow-words/rule; exempt ≤20 roles + ≤50 channels; block msg ≤150; timeout ≤28d | support / AutoMod-FAQ (verified). GC deltas (filterrules.mjs, ridden 0027 W-B1.5): rules ✓ 10; terms ✓ 1000 ×60ch per rule; regex ✓ 260ch; exempt ✓ 20/50 (guarded writes on the rule edit path); timeout ✓ 28d (40320 on the menu, gc_filter_rules CHECK rebuilt); block ✓. gc_filter_rules needed the 0027 rebuild after all: 0010's terms CHECK (16384ch) refuses a maxed 1000×60 rule (~63k JSON chars), so both it (65536) and the timeout CHECK (adds 40320) widened in one childless dance; allow-words + mention-spam KIND = feature lane (messages.mjs trigger, threshold 1–50). |

VOICE / MEDIA
| Cap                              | Value |
|----------------------------------|-------|
| Voice bitrate ladder             | 96 → 128 (L1) → 256 (L2) → 384 (L3) kbps |
| Go Live quality                  | base 720p@30; L1 720p@60; L2+ 1080p@60 server-wide; Nitro 4K@60; ≈50 viewers |
| E2EE (DAVE)                      | DECLINED: WebRTC/MLS out of reach — behavior note only |
| Soundboard                       | 512KB, MP3/OGG, ≤5.2s, name 2–32 (GC CHECK widened to 2–32: GC_SOUND_NAME_MAX=32 shipped; the old 2–16 CHECK flag resolves — migration complete), Create/Manage-Expressions perms |

EXPRESSION SLOTS (per server; boost-level keyed)
| Slot          | Base | L1(2) | L2(7) | L3(14) | File limit                       |
|---------------|------|-------|-------|--------|----------------------------------|
| Emoji         | 50   | 100   | 150   | 250    | ≤256 KB; name 2–32 (docs.food/userdoccers corroborated; official page silent — NON-OFFICIAL-source flag) |
| Stickers      | 5    | 15    | 30    | 60     | ≤512 KB, 320×320 (APNG ≤5s duration) — FLAGGED for re-verification: the 60fps figure appears in NO official page; drop this parenthetical fragment unless a cited source turns up; name 2–30 (OFFICIAL sticker resource) |
| Soundboard    | 8    | 24    | 36    | 48     | ≤512 KB, ≤5.2s, MP3/OGG; name 2–32 (OFFICIAL soundboard resource) |
Over-cap behavior when a level drops: items DISABLE, never deleted. GC
equivalent shipped: existing rows stay usable, only new creates respect the
new cap.

UPLOADS (per file, account-tier keyed)
| Tier            | Value |
|-----------------|-------|
| Free            | 20 MiB (raised Aug–Sept 2026 from 10) |
| "Nitro Basic"→Mini | 50 MiB |
| "Nitro"→Plus    | 1 GiB (raised Oct 2026 from 500 MB) |
SERVER-WIDE upload boost (member perk, boost-level keyed): 50 MiB for all
members at L2, 100 MiB at L3. Filed wave.
GC LANE ceiling (the Plus row above): 1 GiB — the lane rides the tier's own
bound exactly (GC_PLUS_ATTACHMENT_BYTES; wave-20, 2026-11-19, retired the
125 MiB D1-bound working arm GC_UPLOAD_LANE_MAX_BYTES when the chunk lane's
byte leg rode to R2 per the owner's Nov 18 revival order; the parts window
is now GC_UPLOAD_PARTS_MAX = ceil(1 GiB / 1,024,000-byte part) = 1049,
engineering).

MESSAGES / SOCIAL
| Cap                              | Value | GC binding                     |
|----------------------------------|-------|--------------------------------|
| Message length free / plus       | 2000 / 4000 | GC_FREE_MESSAGE_MAX / GC_PLUS_MESSAGE_MAX (0021) |
| Unique emoji per message (reactions) | 20 (error 30010) | GC_REACTIONS_MAX_UNIQUE_PER_MESSAGE (b299845) |
| Friends                          | 1000  | GC MAX_FRIENDS was 500 → 1000  |
| Pins per channel                 | 250 (30010-style copy) | GC_PINS_MAX_PER_CHANNEL (0026) |
| Read markers (POST ack)          | last-read advances, self-only, forward-only, ≤ thread's latest | gc_conversation_members.last_read_message_id (0026: route + tail auto-advance; gc_read_state dropped, zero consumers) |
| Group DM members                 | 10    | 0028: MAX_GROUP_INVITES 9 invites + self (conversations.mjs roster cap = 10, both the create list and the add-member gate) |
| Servers joinable                 | 100 free / 200 "Nitro"→friend-passes tier | 0028: GC_SERVERS_JOIN_MAX_FREE / GC_SERVERS_JOIN_MAX_PLUS (COUNT guard inside BOTH join INSERTs; tier keyed on an active gc_plus_state row — the plusActiveExpr shape) |

NAMING RULES (unchanged): this table maps Discord's tiers to Goober terms —
"friend passes" not Nitro, Goober+ branding rules in copy.
