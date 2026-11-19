# Feature wave 8 — leave server + transfer ownership (T-PARITY-LEAVE)

Date: 2026-11-19. Base: afcbf05 (cycle-6 LIVE tip, suite 1834/1834).
Owner away, Section A fully autonomous. VERSION stays `"prototype"`.

## Through-line

A member with no exit from a server is a real parity gap and a real safety
gap: the only paths out today are account deletion (too drastic) or asking
the owner (not always possible). Discord's model — any member can leave at
will, the owner cannot leave until they transfer ownership — closes both in
one small server-side wave. Parity posture: capability claim only; any
published "Discord parity" line needs the support-artifact URL + date per
the parity-caps house rule (fetch before publish; else NO-URL-RECEIPT).

## Feature 1 — POST /api/servers/:id/leave

- Member removes their own gc_server_members row. In-statement authority:
  the DELETE's WHERE carries both `user_id = ?` (self) and the membership
  EXISTS arm — a plain member's run deletes only their own row; no
  route-side-only gate anywhere.
- OWNER BLOCK (parity-mirrored): the owner cannot leave — 409 with a clear
  message pointing at the transfer route — until ownership has transferred.
  In-statement: the DELETE gains `AND NOT EXISTS (owner-exists WHERE
  user_id = ?)` so the refusal holds even race-on.
- 404 when not a member (view gate first, memberGate idiom).
- Cascade hygiene: the row's children (per-channel membership rows if any)
  ride the schema's ON DELETE CASCADE; nothing else swept — mentions and
  bookmarks survive a leave by design (history-kept law).
- Defaults law: leaving is an explicit action on a named route — never
  default-on, no UI auto-prompt besides the user's own click.
- Sink law: no mint, no spend — outside economy scope.
- Wires: `POST /api/servers/:id/leave` (pick the idiom adjacent to
  servers.mjs's existing mutations), write-wall rate limit keyed
  `write:servers-leave:<id>`, verdict-gated on changes = 1.

## Feature 2 — POST /api/servers/:id/transfer-ownership

- Owner-only (in-statement OWNER_EXISTS arm on the swap batch, mirroring
  M1/category-cap parens). Target must be an ACTIVE member of the same
  server, in-statement via EXISTS bound with (serverId, targetUserId).
- Atomic batch (D1 transactional): 1) demote old owner role → member,
  guard `WHERE user_id = ? [old owner] AND server_id = ? AND EXISTS
  (owner arm)`; 2) promote target role → owner, guard `AND EXISTS (active
  member read)`; verdict: changes = 1 on BOTH — any mismatch → re-read
  and surface a shaped 409/404 (never a half-swapped state: both arms are
  one batch, D1 commits or rolls back whole).
- Self-transfer (owner → themselves) = idempotent no-op 200, not an error.
- Cannot transfer to a non-member or a 'blocked'-tier row — EXISTS read
  must require role NOT NULL and active status per the roster schema.
- Audit: no second source — the roles table itself is the record (state
  change visible in the table; NOT gc_coin_ledger, economy schema stays
  economy-only).
- Wires: route beside the settings mutations it mirrors, write-wall
  `write:servers-transfer:<id>`, verdict-gating per the batch idiom.

## Non-goals

- UI lane optional follow-up (backend-first; chat/settings panels untouched
  this wave).
- No ownership-vacancy daemon (owner's account deleted → server dies with
  CASCADE; unchanged law).
- No invite/role editing changes, no new categories, no migration.

## Testing posture (RED-first)

~15 pins: leave as plain member (green), owner-block (409, zero rows
changed), non-member 404, race-on leave no double-delete (changes gating),
transfer by non-owner 403, transfer to non-member 404/409, transfer
atomicity (both updates in one batch), self-transfer idempotent,
write-wall keys present, in-statement arms (bind-sequence pins like
mod-desk's statements[].bound idiom).

## Routing

- lane-t8-leave (backend, `lane-t8-leave` branch off afcbf05): both routes
  in api/servers.mjs + constants + tests; RED-first; commit on lane branch.
- Deslop reviewer after lead verify, then standard merge chain.
