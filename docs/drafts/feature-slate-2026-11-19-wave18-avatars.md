# feature-slate — wave-18: the avatar face (2026-11-19)

Through-line: the avatar surface is fully live server-side — GC serves
/api/avatars/:id?v= (api/avatars.mjs, R2-first off the shared
wempos-forum-r2 bucket), and every payload that already speaks a member's
identity ships the URL as data (publicUser's avatarUrl in api/accounts.mjs
— the /api/me and session shape — and the server roster row's avatarUrl in
api/servers.mjs:1928). But the GC client paints ZERO avatars — not on the
roster panel, not on the member's own seat. This is the wave-13 chip
precedent: paint where the payload already speaks. Backend BYTE-FROZEN
for the wave (api, worker.mjs, core) — every change client-side.

## The feature

- **Roster paint**: the server roster panel paints each member's avatar
  image from the row's avatarUrl (the payload's own URL, ?v= cache key
  included verbatim); a null avatarUrl paints the row exactly as today.
- **Own seat paint**: the member's own profile/me seat paints their
  avatar from publicUser's avatarUrl the same way (read-only — the
  lifecycle stays forum-side by design; no upload door, no moderation
  surface, no invite to create one).
- **Paint truth**: the <img> src is the payload's URL verbatim — no
  client-built URLs, no invented cache keys, no invented placeholders
  (a null avatar paints nothing new, presence-of-avatar-only); an in-
  flight failure renders the row without the image (fail soft, the
  attachment 404 idiom).
- **Scope guard**: chat message payloads carry NO avatarUrl (verified
  2026-11-19) — no message-row avatar paint in this wave, pinned
  doesNotMatch on the messages payload surface (the wave-13 tag-chip
  precedent).

## Laws the wave rides

- privacy/design law: avatars serve as the rows already permit (approved
  public, pending owner/staff-only) — the client changes nothing about
  access, it only paints the URL the payload already hands it.
- sink law: no coins. defaults law: paint-only — no new member acts at
  all (the least-defaulting wave yet).
- no-copy sweep: any label riding new paint goes through t() keys with
  real copy ×9 — but the target is zero new strings (the avatar needs no
  label; if one is unavoidable it gets the full sweep).
- payload truth: the URL is payload-carried or nothing.
- backend byte-freeze (the wave-9 lesson, ten instances): freeze pin
  fingerprints the wave's own committed range (LANE_TIP placeholder
  retargeted at commit time by the lead); the c20-forged catch arm is
  mandatory.

## Sequencing

lane-w18-avatars: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → retarget freeze pin → isolated verify ×2 → deslop →
merge → push → ritual deploy → probe stamp == pushed SHA → board.
