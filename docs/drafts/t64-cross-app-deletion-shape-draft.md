# T64 DRAFT — cross-app account deletion shape (READ-ONLY rows; NO migrations, NO remote SQL, NO code)

Status: DRAFT for the pending owner ruling (parked open question, gc-parked-open-questions).
Prepared by: gdpr-reaper. Every row cites its table/relation site as file:line.
Read these DRAFT rows with the T-GDPR-DEL-1 audit (Nov 17): any user row deleted on the
shared DB today either FAILS (FK stall) or cascades silently across all three apps.

## 0. Shared-DB + cookie-twin graph (the shape any option must live inside)

| # | edge | cites |
|---|------|-------|
| G1 | ONE D1 for all three apps; `users` is the single shared identity row | forum 0002 vendored copy GooberCord/migrations/0002_vendored_core_tables.sql:12; GC reads users api/accounts.mjs:371; wa reads users wempo-accounts/api/sso.mjs:23-25 comment |
| G2 | `sessions` is ONE shared table; GC cookie AND forum cookie mint rows into it | forum origin wempos-forum/migrations/0001_initial.sql:22; GC vendored IF-NOT-EXISTS copy GooberCord/migrations/0002_vendored_core_tables.sql:64; forum inserts wempos-forum/api/core/auth.mjs:168,195 |
| G3 | GC cookie twin `__Host-goober_session` (legacy bare name read-side only) | GooberCord/api/core/auth.mjs:73 (mint), :92 (read), GC_LEGACY_COOKIE_NAME note |
| G4 | Forum cookie twin `__Host-wempo_session` (legacy bare name read-side only) | wempos-forum/api/core/auth.mjs:73 (mint), :92 (read) |
| G5 | Accounts cookie `wempo_account_session` (NO __Host prefix) rows in app-private `wa_sso_sessions` | wempo-accounts/constants.mjs:47; table wempo-accounts/migrations/0001_wa_sessions.sql:39 |
| G6 | Forum guest sessions are anonymous rows (`user_id IS NULL`) — NOT user-cascade victims | wempos-forum/api/core/auth.mjs:162,183 |
| G7 | SSO: accountsredeems `wa_login_tickets` and MINTS GC/FORUM's own session from the shared users row | GooberCord/api/sso.mjs:23-25 comment, tickets table wempo-accounts/migrations/0001_wa_sessions.sql:24 |
| G8 | Deletion of `users` row cascades BOTH apps' server-side sessions via G2 FK (client cookies keep their name but every lookup fails) | sessions.user_id ON DELETE CASCADE wempos-forum/migrations/0001_initial.sql:25; wa_sso_sessions.user_id CASCADE wempo-accounts/migrations/0001_wa_sessions.sql:43 |

## 1. Today's live delete paths (the only ones that exist)

| app | path | cites |
|-----|------|-------|
| forum | POST /api/me/delete — self-service, atomic D1 batch, archives forum posts to post_archive | wempos-forum/api/profiles.mjs:556, :515-550; archive table wempos-forum/migrations/0008_post_archive.sql:5 |
| GC | NO account-delete route; sessions sweeps only | GooberCord/api/accounts.mjs:788-791, :830, :133; route table :842-869 |
| accounts | register's DELETE FROM users = fail-closed registration rollback ONLY | wempo-accounts/api/register.mjs:126-155; manage sweeps manage.mjs:189,228,236 |
| export | NO /api/me/export anywhere in the fleet | grep void 2026-11-17 |

## 2. FK graph on user-row delete (per shared D1)

| table.column | action on delete | cites |
|--------------|------------------|-------|
| sessions.user_id | CASCADE (both apps' cookies die server-side) | wempos-forum/migrations/0001_initial.sql:25 |
| gc_messages.author_id | CASCADE — author's messages vanish from every server | GooberCord/migrations/0001_initial_goobercord.sql:61 |
| dm_threads.user_a / user_b | CASCADE — BOTH parties' DM threads vanish | wempos-forum/migrations/0032_presence_chat.sql:31-32 |
| dm_messages.user_id | CASCADE | wempos-forum/migrations/0032_presence_chat.sql:40 |
| gc_server_members / gc_conversation_members / gc_member_status / gc_attachments / gc_server_bans.user_id / gc_friend_requests / gc_friends / gc_blocks / gc_message_reactions / gc_coin_ledger.user_id / gc_plus_state / gc_cosmetic_ownership / gc_emoji/gc_stickers/gc_sounds.created_by / gc_upload_parts / gc_mentions | CASCADE | GooberCord/migrations/0001:34,34,78,91; 0002:66; 0005:25; 0006:31; 0008:36; 0009:37-38,53,73,88; 0011:33; 0013:28; 0019:14; 0020:39,52; 0022:43; 0025:16; 0021:35; 0023:35; 0028:16 |
| bans.user_id / reports.reporter / notifications.user_id / forum reactions.user_id / bookmarks.user_id / thread_subscriptions.user_id | CASCADE | GooberCord/migrations/0002_vendored_core_tables.sql:93; wempos-forum api/profiles.mjs:537-539 pre-deletes |
| bans.created_by / revoked_by, gc_coin_ledger.related_user_id, core created_by | SET NULL | GooberCord/migrations/0002_vendored_core_tables.sql:97,100; 0011:41 |
| **gc_servers.owner_user_id** | **NO ACTION — DELETE THROWS** | GooberCord/migrations/0001_initial_goobercord.sql:13 |
| **gc_invites.created_by** | **NO ACTION — DELETE THROWS** | GooberCord/migrations/0004_discovery_invites.sql:19 |
| **gc_server_bans.created_by** | **NO ACTION — DELETE THROWS** | GooberCord/migrations/0008_mod_desk.sql:37 |
| **gc_filter_rules.created_by** | **NO ACTION — DELETE THROWS** | GooberCord/migrations/0010_filter_upgrades.sql:67 (0027 rebuild identical) |
| known_ips (ip_hash,user_id) | NO FK, NO delete in GC — IP-hash rows strand | GooberCord/migrations/0002_vendored_core_tables.sql:75-79; GC inserts api/accounts.mjs:127, api/core/auth.mjs:142 |
| gc_read_state(user_id,channel_id) | NO FK — orphan rows | GooberCord/migrations/0001_initial_goobercord.sql:71-74 |
| wa_login_tickets.user_id / wa_sso_sessions.user_id | CASCADE | wempo-accounts/migrations/0001_wa_sessions.sql:27,43 |

## 3. Owner-ruling options (DRAFT rows — pick one, or composite)

### Option A — "forum is the door; GC rides the cascade" (smallest shape)
- Keep forum's POST /api/me/delete as the ONE deletion door; add a GC-authored preamble
  statement list (mirror of forum's `accountDeletionStatements`) that the forum batch
  concatenates BEFORE its own deletes: gc_read_state, gc_invites.created_by rows, then
  the user row.
- Precondition rows (must exist first, as DRAFT migration text only):
  - SET NULL on gc_server_bans.created_by (mirror of bans.created_by 0002:97 shape) — gc_server_bans table GooberCord/migrations/0008_mod_desk.sql:34-40.
  - SET NULL on gc_filter_rules.created_by — refs GooberCord/migrations/0010:67.
  - Delete-with-user on gc_invites.created_by — refs GooberCord/migrations/0004:19 (rows are worthless post-delete).
- Owner-row ruling still needed: gc_servers.owner_user_id GooberCord/migrations/0001:13 —
  DRAFT sub-options: (a) route-level refusal for owners until servers transferred/deleted;
  (b) owner-transfer-to-admin batch step; (c) server-delete cascade (channel/message
  cascade rides 0001:34 REFERENCES gc_servers).
- Pro: one audit surface, forum's archive + ordering carry. Con: GC messages/DMs cascade
  with NO archive (post_archive covers forum posts only, wempos-forum/migrations/0008:5) —
  asymmetry stays.

### Option B — GC-side door /api/me/delete (mirrored twin)
- GC gets its own route (accounts.mjs route table api/accounts.mjs:842-869 gains one lane)
  with a `gcAccountDeletionStatements` twin of forum's wempos-forum/api/profiles.mjs:515.
  Both doors must then run the SAME statement list — DRY edge: single shared module could
  be vendored to both, but byte-parity STACK LAW applies to vendor lanes only (Kitskey
  pins api/vendor/db.mjs, api/vendor/http.mjs GooberCord/api/vendor/) — a NEW shared
  module is a fresh pin decision, owner call.
- Precondition migrations identical to Option A.
- Pro: parity + fleet-symmetric. Con: two doors to keep in lockstep; forum's batch must
  still precede it for forum-side extras (post_archive, banned_ips
  wempos-forum/api/profiles.mjs:545).

### Option C — soft-delete staging row (deferred annihilation)
- Add `deleted_at` staging on users (DRAFT: ALTER TABLE users — shared vendored table
  GooberCord/migrations/0002_vendored_core_tables.sql:12 — touches BOTH apps' migrations
  floors; forum local floor beyond GC's 0017 floor per D1-only law) — login gate refuses
  deleted users (GC ban gate precedent api/accounts.mjs:397 activeBanRow), GC sweep runs
  async later, archive window preserved.
- Pro: reversible window, archive-friendly. Con: new table state on the shared row,
  cross-app gate must check it in THREE places (GC api/accounts.mjs login, forum
  wempos-forum/api/core/auth.mjs session read, wa wempo-accounts/api/core/auth.mjs).

### DRAFT cross-cutting rows (ride any option)
| row | cites |
|-----|-------|
| known_ips sweep MUST ride the deletion batch (no FK) | GooberCord/migrations/0002_vendored_core_tables.sql:75-79; forum already does wempos-forum/api/profiles.mjs:547 |
| gc_read_state sweep MUST ride (no FK) | GooberCord/migrations/0001_initial_goobercord.sql:71-74 |
| gc_messages/dm archive ruling: post_archive precedent wempos-forum/migrations/0008:5 vs GC-side message_archive draft | cascade refs GooberCord/migrations/0001:61; wempos-forum/migrations/0032:31-40 |
| cookie-twin hygiene: deletion needs NO cookie-clear edge — dead token_hash makes every existing cookie inert on next auth read (G2/G3/G4/G5); expiredCookie clears ride the normal 401/204 path GooberCord/api/accounts.mjs:547 |
| guest sessions (user_id NULL) are untouched by any option — forum-only fact | wempos-forum/api/core/auth.mjs:162 |
| accounts app needs ZERO change under A and B (wa tables all cascade) | wempo-accounts/migrations/0001_wa_sessions.sql:27,43 |
| NO export lane exists — separate row, not bundled into deletion | void grep 2026-11-17 |

## 4. Fast-fail notes
- Nothing above has been applied anywhere; the four NO ACTION columns are the blocker
  measured in T-GDPR-DEL-1 (nov 17). Any option without the Section-2 preconditions
  reproduces the FK-stall 500 on wempos-forum/api/profiles.mjs:556.
