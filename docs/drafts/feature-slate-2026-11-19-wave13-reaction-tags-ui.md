# feature-slate — wave-13: the reaction-tags surface (2026-11-19)

Through-line: the reaction-tags backend (api/reaction-tags.mjs:252-268) is
fully live — a per-server custom tag map, member opt-in/out verbs, a
/mine read — scouted 2026-11-19 with ZERO public/js/ references. This is
the wave-10/11 pattern again: the wave that ships the surface the
backend already earned. A mod who wrote a tag map has no edit door; a
member offered a tag has no opt act. Wave-13 gives the table its face;
backend BYTE-FROZEN for the wave (api, worker.mjs, core) — every
change client-side.

## The feature

- **Mod face — settings panel**: server-settings reaction-tags panel
  (the welcome-card / boost-tier manageGate idiom): GET
  `/api/servers/:id/reaction-tags` paints the tag table; PUT carries the
  edited map; per-tag DELETE removes a tag (each behind ONE explicit
  confirm — the destructive-act law). Server refusals paint verbatim.
- **Member face — opt act + mine read**: GET
  `/api/servers/:id/reaction-tags/mine` lists the member's opt-ins;
  POST/DELETE `/api/servers/:id/reaction-tags/:tagId/opt` flips one opt
  (one explicit click per act, never default-on — defaults law). The
  mine read rides a per-server lane key (`mineReactionTags:${serverId}`
  — the wave-11 mineKey idiom, flat lanes rejected by law).
- **Paint where the payload already speaks**: if the reactions payload
  the chat panel already receives carries tag seats, the tag chip
  paints from it — zero new backend reads. If it does not, the chip
  stays out of wave-13 (no client-side invention of data the payload
  never sent; payload-truth law).

## Laws the wave rides

- sink law: no coins — tags mint nothing, the client adds no ledger.
- defaults law: the panel GET rides its own open (one auto-load per
  visit); every opt/PUT/DELETE is member-initiated.
- no-copy sweep: every painted string rides t() keys; en real copy +
  translated in all 8 staged bundles; no byte-equal en carve.
- per-server lane idiom: mine lanes are keyed by serverId.
- backend byte-freeze (the wave-10/11/12 idiom): freeze pin
  fingerprints the wave's own committed range, never HEAD (the wave-9
  lesson, four instances).

## Sequencing

lane-w13-tags: spec + RED-first pins, then GREEN, uncommitted handback
→ lead commit → isolated verify ×2 → deslop → merge → push → ritual
deploy → probe stamp == pushed SHA → board.
