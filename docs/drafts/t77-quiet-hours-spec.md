# T77 — Quiet hours (spec draft, RED rows staged)

Slate row 4 (docs/drafts/feature-slate-lead-2026-11-18.md): a per-member
schedule that HOLDS DM pings during chosen hours and parks them for a digest
on wake. Nothing leaves the member's control; the only durable record of
quiet hours is the choice itself. Laws honored verbatim: defaults law
(opt-in, never on), LIMIT COLLECTION NOT ACCESS, acts-not-suspicion.

Status: SPEC DRAFT — unratified until the chair passes it. This file and
`tests/quiet-hours.test.mjs` (RED) are this lane's whole diff.

## 1. What quiet hours hold — and what they never touch

Quiet hours hold PINGS, never messages. A DM ping is the member-facing
notification half only: the unread pill's flash lane, the mentions pill's
wake nudge, and any future sound/badge dispatch that consults this module
BEFORE it fires. The messages themselves keep arriving and keep landing —
unread truth is data, quiet hours are a presentation schedule. A member
reading during quiet hours sees their DMs exactly as always; only the
outward "attention" ping is held.

The implementing seat: `public/js/ui/quiet-hours.js` (client-seat module;
every ping dispatch site consults `offer()` before it dispatches).

## 2. Schema (the saved choice)

Additive per-user table `gc_quiet_prefs` (migration floor 0029, the 0028
floor moves up only when the backend seat lands):

```sql
CREATE TABLE IF NOT EXISTS gc_quiet_prefs (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  on         INTEGER NOT NULL DEFAULT 0,        -- 0 = opt-in default, OFF
  start_time TEXT NOT NULL DEFAULT '23:00',     -- 'HH:MM', member's device clock
  end_time   TEXT NOT NULL DEFAULT '07:00',
  updated_at INTEGER NOT NULL
);
```

- One row per member, the `gc_social_prefs` precedent (migrations/0009
  `gc_social_prefs`, COALESCE-style read): an absent row reads as the
  default `{ on: false, start: "23:00", end: "07:00" }` and no backfill
  write ever targets users.
- `start_time`/`end_time` are bare `HH:MM` wall-clock strings read against
  the MEMBER'S DEVICE clock at hold time. The window may cross midnight
  (`23:00` → `07:00`); `start == end` means the window never engages
  (explicitly-empty window is legal, never an error).
- The wire shape (GET/PATCH `/api/me/quiet` — social.mjs's prefs lane):
  `{ on: boolean, start: "HH:MM", end: "HH:MM" }`. Server stores INTEGER
  0/1; the API answers booleans.

## 3. Settings surface

- Seat: the `/friends` hub's privacy block (ui/social.js), directly under
  the existing accept-requests gate toggle — quiet hours are social posture,
  not server admin. One toggle (on/off) + two `HH:MM` inputs, disabled while
  the toggle is off.
- Every painted string rides `t()`. Keys (the implementer lands these in
  `public/locales/en.json` and follows the bundle-carve law for the other
  seven — CARVE_GATES entry required per bundle):
  - `gc.social.quiet.heading` — "Quiet hours"
  - `gc.social.quiet.on` / `gc.social.quiet.off` — "On" / "Off"
  - `gc.social.quiet.start` / `gc.social.quiet.end` — "From" / "Until"
  - `gc.social.quiet.note` — the honest copy: "DM pings hold during these
    hours on this device's clock; messages always arrive."
  - `gc.social.quiet.digestHeading` — "While you were quiet"
  - `gc.social.quiet.digestEmpty` — (reserved; the drained second wake
    renders nothing, never an empty-state ceremony)
- The save button is an explicit action; nothing persists on toggle-hover,
  no default-on suggestion, no pre-checked state (defaults law).

## 4. The digest queue shape

- Queue: client-seat, in the member's own page (`makeDigestQueue()` from
  quiet-hours.js; hydrated from the store key `quiet:digest` so a reload
  mid-quiet carries the held rows forward).
- Ping entry as offered: `{ conversationId, senderId }` — the ping already
  carries these; nothing extra is read from the message.
- Queue storage shape: one COALESCED row per conversation —
  `{ conversationId, senderIds: <unique ids, latest last>, count, at: <ISO>
  }`. A held ping for a conversation already holding coalesces (count++, id
  set gains the sender). Cap: 50 conversations held — at the cap the oldest
  row drops silently (the digest is a courtesy, never a retention lane).
- Wake: the clock crossing `end_time` is the wake. The digest renders ONCE
  per drain, on the member's next interaction with the DM surface after the
  window ends (the mentions/friends seat, not a modal): one quiet panel
  titled by `gc.social.quiet.digestHeading`, one row per conversation —
  who sent, how many — clicking the row opens the conversation.
- Drain semantics: `drain()` returns the held rows AND empties the queue. A
  second wake with no held pings renders nothing (no empty-state card ever
  shows for quiet hours).

## 5. What is deliberately NOT stored

- No server-side queue. The server never holds pings; holding lives in the
  member's page. A signed-out member's held pings are their browser's, not
  the fleet's.
- No message bodies in the queue — conversationId + senderId + count + at
  is the whole row.
- No read time, no open history, no "you ignored N pings" ledger beyond the
  current window's queue.
- No timezone, locale, or device fingerprint server-side — the schedule is
  two bare strings; interpretation happens on the member's device at hold
  time.
- No analytics, no counters, no cross-app echo: quiet hours never write to
  the forum tree.
- No "last active during quiet hours" inference row — quiet hours prove
  nothing about anyone else, by design (acts-not-suspicion).

## 6. The RED rows this branch stages

`tests/quiet-hours.test.mjs` (module absent → three named reds):

1. "quiet hours is opt-in with a default of OFF (the defaults law)" —
   absent prefs read as the OFF default; a never-opted-in member's ping
   rides immediately and never lands in the queue.
2. "a DM ping during the member's quiet window is HELD into the digest
   queue" — window `23:00 → 07:00` engaged at 01:30 (midnight-crossing);
   the ping holds; same-conversation pings coalesce to one row.
3. "the wake digest drains the queue" — `drain()` once returns the held
   conversation row and empties the queue; the second drain is empty.

API the rows pin (the implementing seat satisfies these names):
`normalizeSchedule(prefs)`, `isQuietAt(schedule, date)`, `makeDigestQueue()`
with `offer(ping, schedule, when) -> "held" | "passed"`, `entries()`,
`drain()`.
