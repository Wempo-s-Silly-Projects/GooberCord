# GooberCord — midnight shift changelog (2026-11-17)

One entry per shipped commit, newest first. App version stays **0.1.0** (the
0.5→1.0 bump is owner-gated). Brand rules in every line: never "Nitro" —
the tier brand is **Goober+ / Mini**, the paid tier is **friend passes**
(owner's known decisions). "Parity row" cites docs/parity-limits.md; law
board: docs/parity-board.md.

## Shipped tonight (seeded from the lead's ledger, order fixed from git log)

- `461c178` — Soundboard UI: the board dialog opens from the composer, one
  sound plays at a time, and adding/management is gated to members with
  expression-management rights. _Cites: Expression Slots — Soundboard
  (base 8) + the Soundboard source row (512 KB, MP3/OGG, ≤5.2 s)._
- `9fa3ef3` — Parity pass: soundboard slots corrected to Discord's real base
  of 8, the sticker ladder lands (5 base / 15 / 30 / 60 by boost level), and
  the free upload tier meets Discord's current 20 MiB. _Cites: Expression
  Slots table + Uploads — Free 20 MiB (raised from 10)._
- `0aa85d9` — Soundboard routes: a server's sounds can be created, renamed
  and deleted, with the slot ladder and the audio bytes contract (512 KB,
  MP3/OGG, ≤5.2 s) enforced by boost level. _Cites: Voice/Media — Soundboard
  + Expression Slots — Soundboard._
- `8d9d84e` — GIF lane, client half: picking a GIF pastes its token into the
  composer and the chat render pass unfurls the media panel. _Cites:
  checklist media lane (no numeric law row)._
- `e92b583` — Large files arrive chunked (intake dormant until the tier gate
  opens): the commit records an honest per-file row and byte-level
  housekeeping keeps the lane clean. _Cites: Uploads — Plus 1 GiB (the row
  that makes chunking necessary)._
- `2f199ad` — The welcome plate quiets: the ruled-paper sheet stays the warm
  brand look; the Discord skin gets the flat column. _(UI surface; no cap
  row.)_
- `15629f4` — Member-list head row fixed: the gear keeps its inset, the
  label takes the room. _(UI surface; no cap row.)_
- `904262f` — The shop's Mini card: the Goober+ Mini purchase card rides
  beside the Plus card, priced and phrased by payload. _Cites: Uploads —
  Mini 50 MiB._
- `47c7ea3` — GIF media proxy: the picker's Tenor bytes now stream
  same-origin — chat never touches a third-party host directly. _Cites:
  checklist media lane (no numeric law row)._
- `6d0e92b` — The default skin is the approved mock: Discord, with the warm
  brand papers kept as a deliberate option. _(UI surface; no cap row.)_
- `6ec2fd1` — Wempo's arcade, the real deal: a faithful arcade Pac-Man on
  one canvas, playable in-app. _(No cap row.)_
- `c46c30c` — Server settings gains its danger zone: the typed-confirm
  Delete server door. _(No cap row; mirrors the owner shaver `c13e4e0`.)_
- `3a9cf83` — Mentions render: the client mirrors the server's parse, so
  @everyone / @here / @username highlight in chat bodies, with a heads-up
  before sending @everyone. _Cites: checklist mentions lanes (no numeric
  law row yet)._
- `3ab6951` — The user panel rides the window's bottom edge; the action row
  gets its inset. _(UI surface; no cap row.)_
- `591f7d6` — The app-wide presence beat: the home lane no longer reads
  Offline on a live site. _(No cap row.)_
- `5ed81a5` — Subresource stamping: every build serves at URLs no browser
  has cached, so stale clients stop lying about what shipped. _(Build
  hygiene; no cap row.)_

## Notes for the next batch

- `8d9d84e` was not on the seed ledger but sits between two logged commits
  (`0aa85d9` / `e92b583`) in git order — logged here so the lane has no
  hole.
- Tonight's ledger opens at `591f7d6` (the full-autonomy night); earlier
  2026-11-17 waves live in git history (0020–0023, mentions `e278094`, the
  egg commits, live-breaks fixes).
