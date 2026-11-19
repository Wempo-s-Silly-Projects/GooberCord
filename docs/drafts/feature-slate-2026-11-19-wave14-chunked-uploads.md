# feature-slate — wave-14: the chunked-upload door (2026-11-19)

Through-line: the chunked-upload backend (api/uploads.mjs:415-427 —
POST /api/uploads/chunks + POST :id/commit + DELETE :id/abandon family)
is fully live, hard-audited through the haywire cycles, and the client
still speaks single-shot attachments only — any member-sized file beyond
the single-shot cap has no door. Wave-13 closed the reaction-tags door;
wave-14 wires the chunked flow into the composer. Backend BYTE-FROZEN
for the wave (api, worker.mjs, core) — every change client-side.

## The feature

- **Composer upload switch**: files above the single-shot threshold
  ride the chunked flow — POST /api/uploads/chunks in bounded slices,
  POST /api/uploads/:id/commit on the last slice, DELETE
  /api/uploads/:id/abandon to tear down a cancelled or failed upload.
  One upload state per composer act; no background queue invention.
- **Progress face**: the composer paints the upload's own slice count
  (bounded, payload/mirror-driven — never invented timers or fake bars).
  Failure paints the server's refusal verbatim and abandons the upload
  (one explicit DELETE, no silent partial state).
- **Tier truth**: the client's threshold and any size mirror ride
  constants.mjs (G-4 mirror idiom) — never client-invented tier numbers.
  The Goober+ 50MB/1GB tier numbers stay payload/constants-sourced; the
  upload PERK enforcement question (c19 MED-2's parked row) stays
  untouched — this wave is the DOOR, not the gate.

## Laws the wave rides

- sink law: no coins — uploads mint nothing.
- defaults law: chunked is only the act of the member's own send; no
  auto-upload, no pre-selected tiers, cancel = explicit abandon act.
- no-copy sweep: every painted string rides t() keys; en real copy +
  translated in all 8 staged bundles; no byte-equal en carve.
- error-copy law: server refusals paint verbatim; abandonment is its
  own act, never folded into a refusal.
- backend byte-freeze (the wave-9 lesson, five instances): the freeze
  pin fingerprints the wave's own committed range (LANE_TIP placeholder
  retargeted at commit time by the lead).

## Sequencing

lane-w14-uploads: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → retarget freeze pin → isolated verify ×2 → deslop →
merge → push → ritual deploy → probe stamp == pushed SHA → board.
