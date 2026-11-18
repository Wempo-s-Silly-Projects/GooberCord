# The feature slate — lead's own ideas (2026-11-18, branch fleet-wave-2026-11-18)

The owner's ask: "a bunch of features of your own ideas, to make it unique."
Discord parity is the floor; this slate is the part nobody else ships. Every
idea is $0-cost, D1-only, no third-party APIs, vanilla imperative — the fleet
laws hold each one. No real names, no contacts import, no tracking: the
FSF privacy laws design with the members, never around them.

The through-line: **GooberCord is the cozy free-software hangout** — the Well,
the campfire, the quiet evenings. Discord parity gets us to "it's a Discord";
this slate gets us to "why we stay".

## The overnight six (dispatched lanes T76–T81)

1. **The Well streaks (T76)** — daily claim streaks with a gentle decay: one
   missed day halves the multiplier instead of zeroing it; five days resets to
   the base claim. The streak is per-member, shown only to the member, and the
   multiplier caps where the sink analysis says the mint can bear it. Identity:
   the Well already has a name in the fleet's copy — this gives it a rhythm.
   Law: every mint lane names its sink (T62 sequencing: sink-side first).

2. **The Campfire (T76)** — a server-wide shared meter that burns up while
   members are active and talking. At each threshold the whole server draws
   from a shared pool — a small coin bonus to everyone online, or a temporary
   server banner cosmetic. Nobody is ranked, nobody is shamed — the fire is
   the server's, not the member's. Identity: presence as warmth, not as
   a leaderboard.

3. **Pay-it-forward gift chains (T76)** — gift coins anonymously; the
   receiver passes it on and a small sink fee routes to the server's Campfire
   pool. Chains have a depth cap and the ledger records hops without
   identities. Identity: generosity as a game mechanic, privacy-native.

4. **Quiet hours (T77)** — per-member schedule that holds DM pings during
   chosen hours and parks them for a digest on wake. Nothing leaves the
   member's control, nothing is logged beyond the choice itself. Law: the
   defaults law — network actions explicit, never default-on; quiet hours are
   opt-in with a default of off.

5. **Starter Grove — server templates (T78)** — community-authored server
   skeletons (roles, channels, overwrites) applied in one click, with the
   mod desk able to fork and share them. Small servers boot instantly and
   the mod lane's permission surface stays exactly as explicit as hand-roll.

6. **Forum post boost (T79)** — boost a wempos-forum thread into a server's
   announcement channel from the forum side, with one mirrored card in GC.
   The shared DB and the twin cookies become a feature instead of plumbing.
   Identity: the fleet is one community with two rooms.

Also staged for later waves (not dispatched tonight):

7. **Goober of the Day** — discovery spotlight with member votes (8-week
   parity rule respected, votes are per-server-visible only).
8. **High-contrast theme + font scale** (T81) — the a11y lane's theme rows,
   WCAG 2.2 first-class, both themes ride tokens.
9. **Soundboard Studio** — server sound packs off the upload staging lane,
   mod-approved, 5MB clip floor with the tier caps law.
10. **Weekly quests ("Goober jobs")** — rotating three quests per server
    minting modest finishes; ships only after the T62 sink verdict lands.

## The laws every lane rides

- Sink law: every mint feature names its sink before it ships (T62).
- Defaults law: quiet hours, digests, notifications — opt-in, never on.
- No-copy sweep: every painted string rides t() keys; every non-en fill
  carries its CARVE_GATES entry.
- TDD: RED first, isolated-worktree suite bind at the pushed SHA.
- Everything lands on this branch; main stays at the owner's gate.
