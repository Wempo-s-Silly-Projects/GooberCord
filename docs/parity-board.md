// THE PARITY BOARD — the redo tracker (owner: "redo everything parity-wise").
// Diff of docs/parity-limits.md (Discord verified) × the repo inventory
// (2026-11-17). COPY surfaces ranked by user pain. TRANSLATE/DECLINE tails.
// Every wave shipped moves a row to SHIPPED with its commit.

== SHIPPED ALREADY (both halves live, counts matched tonight) ==
servers+settings+delete · channels/categories/overwrites/slowmode · roles+perms
10-bit + roster/nick · invites 0017 + join + discovery · rules gate 0012 ·
messages+mentions+expressions+reactions(+super) · mod desk (bans/timesout/
prune/verification) · AutoMod server lane · presence 4-state + custom status ·
friends/blocks hub · DM+groups · coins/shop/Goober+ Mini/Plus/boost levels ·
media + gif proxy + picker · auth SSO/TOTP/backups · soundboard routes+UI ·
voice Opus-over-WS · UI shell/switcher.

== COPY GAPS, RANKED (red order) ==
1. READ MARKERS — no route advances last_read_message_id; server unread never
   clears. gc_read_state (0001) is a zero-consumer orphan → drop it in the
   same migration. [w-b1]
2. PINS — nothing exists (no column/routes/UI). Discord: 250/channel + the
   dedicated "Pin Messages" permission (Aug 2025). Source:
   https://discord.com/blog/discord-patch-notes-august-4-2025 — verified live
   by curl 2026-11-17 (HTTP 200; "250" on page). [w-b1, w-f2]
3. EMOJI/STICKER MANAGE UI — 4 route families (PATCH/DELETE ×2) have ZERO
   client callers; soundboard got its dialog, they didn't. Pure frontend.
   [w-f1]
4. NAME LENGTHS 2–16 → 2–32 (emoji/sticker/sound) — 0020/0023 CHECKs; one
   migration widens three CHECKs. Source (covers emoji 50/100/150/250 +
   name-length rows): https://support.discord.com/hc/en-us/articles/33694251638295
   (page updated Mar 2026; researcher-verified 2026-11-17 per parity-caps
   ledger — support domain bot-blocks curl, 403, not a dead link).
   [w-b1]
5. MENTION NOTIFICATION INBOX — backend SHIPPED 2026-11-17 (w-b2, 0028: gc_mentions rows at send + GET /api/mentions + DELETE /api/mentions/:id, constants GC_MENTIONS_*); the RAIL badge is client arithmetic (w-f3 pending UI).
6. MESSAGE SEARCH — backend SHIPPED 2026-11-17 (w-b2: GET /api/servers/:id/search, LIKE + ESCAPE arm + per-hit VIEW gate, GC_SEARCH_* constants); UI w-f3; filter facets (author etc.) stay a later lane.
7. CHANNEL REORDER — PATCH has no position; client drag is cosmetic-only.
   [w-b3]
8. SERVER AUDIT LOG — kick/ban/timeout events unrecorded. [w-b3]
9. GLOBAL ADMIN FILTER UI — /api/admin/filter served with zero client.
   [w-f3 small]
10. POLLS — none. 10 answers / q≤300 / ans≤55 / 1h–1w. [w-b4, w-f4]
11. THREADS + FORUM CHANNELS — the big systems (1000-member threads,
    auto-archive; forum = thread-only + 5 tags + 1 pinned post). [w-b5+
    w-f5 multi-wave]
12. STAGE + SCHEDULED EVENTS — 10k/50-150-300 caps; 100 events cap. After
    threads. [w-b6]
13. IDLE AUTO-STATE — Discord auto-Idles ~5min inactivity; GC state editor
    lacks it. [w-f4 client-only tiny]
14. SOUNDBOARD PLAY WAVE — <b:name:id> tokens + composer playback (routes
    live; play-side pending). [w-f5]

== VERDICT NON-CHANGES (re-ratified) ==
Video/screenshare/streaming: owner-deferred v1 non-goal — stays out of the
board. Declines: DAVE E2EE, bots/webhooks/App Directory/Social SDK, Orbs/
quests/ads/real money. TTS/embeds/media-channels rows stay UNCITED — no
constants from them. Avatar write-side lives in Accounts by design (GC
serves) — translate-class, not a gap.

== TRANSLATE TAIL ==
Boost add-on perks (Server Tags, Role Styles) → boost-levels lane. Cosmetics
catalog depth + prices → coins re-rule (owner's numbers table governs the
sink; earn rates already blessed). Discovery eligibility bar (1000 members/
8 weeks) → noted for when the community is there.
