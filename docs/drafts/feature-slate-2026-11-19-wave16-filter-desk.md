# feature-slate — wave-16: the staff filter desk (2026-11-19)

Through-line: the staff word-filter backend (api/filterstore.mjs:89-109 —
GET /api/admin/filter + POST /api/admin/filter/entries, requireStaff) is
fully live and the moderation surface (mod.js/admin attachments door)
exists — but the word-filter desk has no client face: a staff member
cannot see the filter's state or add an entry. This is the wave-10/13/14/15
pattern: the surface the backend already earned. Backend BYTE-FROZEN for
the wave (api, worker.mjs, core) — every change client-side.

## The feature

- **Desk panel**: the staff section gains a filter desk — GET paints the
  filter's state (the backend's own envelope); POST adds ONE entry behind
  the staff act's one explicit submit. Refusals paint verbatim (the 401/403
  staff gate's own body — a non-staff member's door renders its own
  staff-gated absence, never a fake desk).
- **Defaults law**: the desk GET rides its own open (one auto-load per
  visit in the staff surface); adding an entry is member-initiated; no
  bulk/import invention, no delete act beyond what the backend actually
  serves (READ api/filterstore.mjs first — only the GET/POST pair is
  wired; if no DELETE exists, the desk paints what exists, nothing more).
- **Paint truth**: the desk paints the backend's envelope fields as the
  module truly carries them — entry shape, counts, no invented columns,
  no invented pagination.

## Laws the wave rides

- sink law: no coins. defaults law: one auto-GET, member-initiated writes.
- no-copy sweep: every painted string rides t() keys; en real copy +
  translated in all 8 staged bundles; no byte-equal en carve.
- error-copy law: staff-gate + validation refusals paint verbatim.
- backend byte-freeze (the wave-9 lesson, seven instances): the freeze
  pin fingerprints the wave's own committed range (LANE_TIP placeholder
  retargeted at commit time by the lead); the c20-forged disambiguating
  catch arm (is-shallow probe, full-checkout rethrow) is mandatory.

## Sequencing

lane-w16-filter: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → retarget freeze pin → isolated verify ×2 → deslop →
merge → push → ritual deploy → probe stamp == pushed SHA → board.
