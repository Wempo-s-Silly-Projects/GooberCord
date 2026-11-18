# The feature slate — wave 4 (2026-11-18, morning after the first six)

The owner read the overnight six and asked for more. The wave-1..3 pipeline
(slate → board → brief → RED → implement → laws → isolate-suite → commit →
gate → deploy) is proven at 1446/1446; wave 4 rides it at full width. Same
laws, bigger swings. $0, D1-only, no third-party APIs, vanilla imperative.

Through-line holds: **the cozy free-software hangout** — now with time,
seasons, and a paper of its own.

## Dispatched lanes

1. **Time Capsules (T82)** — a member schedules a message for a future date
   (to themself, or to a channel when the mod desk allows). At the reveal
   moment the capsule unlocks. Opt-in only, never default; the row holds the
   text, target, and reveal time and nothing else. Capsules are deletable
   until the reveal (author control, GDPR shape). Identity: a letter to your
   future self, postmarked by the server.

2. **Goober of the Day (T83)** — daily discovery spotlight: members vote,
   the top-voted member is painted into the server's Day card (name + avatar
   only, their choice of one free cosmetic tagline slot). Votes are
   per-server-visible only, no global ranking, opt-out toggles the member out
   of candidacy. Identity: kindness as a game; the spotlight is a gift, not a
   ladder.

3. **Server Seasons (T84)** — per-server rotating weekly theme: a name, a
   color accent on the existing token set, and one shared server quest
   (aggregate meter, contribution is by activity the server already has —
   messages, reactions — never by a new tracker). Seasons are mod-configured,
   opt-in; with no season configured nothing changes. Identity: the server
   has a calendar.

4. **Soundboard Studio (T85)** — server sound packs riding the existing
   soundboard module and the upload staging lane: mod-approved clips, 5MB
   floor per the tier caps law, t()-keys everywhere. Packs are per-server,
   deletable, and never auto-play. Identity: the server's little theater.

5. **Goober Jobs (T86)** — weekly quests ("jobs"): three per server, minting
   modest finishes into the server's Campfire pool first, members second
   (sink law: every mint names its sink, pool-side FIRST). Rotated by a
   server-seeded weekly shuffle, no per-member activity tracker beyond the
   quest's own counters, opt-in per server. Identity: chores that pay the
   campfire.

6. **The Morning Paper (T87)** — opt-in daily digest post in a server: a
   synthesized wrap of the server's own public activity for that day
   (channel counts, top threads, capsule reveals due today — no DMs, no
   presence, no profiling; derived on-request from rows the server already
   stores). Defaults law: off until a mod turns the paper on. Identity: the
   server writes its own journal.

## Laws every lane rides (unchanged)

- Sink law: every mint names its sink (jobs → campfire pool first).
- Defaults law: capsules, votes, seasons, paper — opt-in, never default-on.
- No-copy sweep: every painted string rides t(); non-en fills → CARVE_GATES
  or stay en-only until ratified.
- Caps live in constants.mjs; never re-declared.
- RED first; isolated-worktree suite bind at the pushed SHA.
- Branch `fleet-wave-2026-11-18`; main stays at the owner's gate.
