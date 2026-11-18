# T78 — Starter Grove: server templates (spec, RED-first)

Status: DRAFT (Slate row 5, T78; overnight lane 2026-11-18). Red rows live in
`tests/starter-grove.test.mjs`; the implementation module `api/starter-grove.mjs`
lands to turn them green. Nothing in this spec commits until that green run.

## 1. What a template is

A **Grove** is a community-authored server skeleton: an ordered seed of roles,
channels, and explicit channel overwrites that a creator (or the mod desk, via
fork) applies to a freshly-created server in one click. A Grove is DATA — it
names permission bits and never invents them.

### 1.1 Wire schema (the template document)

```json
{
  "schema": 1,
  "name": "Starter Grove (≤ 64 chars, trimmed non-empty)",
  "description": "≤ 280 chars (optional)",
  "roles": [
    {
      "name": "mod (≤ 32 chars, unique within the Grove)",
      "color": "aa00aa (optional, lowercase #rgb / #rrggbb hex)",
      "permissions": ["DELETE_MESSAGES", "KICK_MEMBERS", "…named server-level bits"]
    }
  ],
  "channels": [
    {
      "name": "general (≤ 32 chars, unique within the Grove)",
      "kind": "text | voice | category",
      "topic": "optional string ≤ 1024",
      "slowmode": "optional 0 | 900 | 1800 | 3600 | 7200 | 21600",
      "private": "optional boolean (rides the EXISTING private toggle's overwrite pair)"
    }
  ],
  "overwrites": [
    {
      "channel": "general (names a channel row above)",
      "role": "mod (names a role row above) | null = the @everyone layer",
      "deny": ["…OVERWRITE_BITS names", "optional"],
      "allow": ["…OVERWRITE_BITS names", "optional"]
    }
  ]
}
```

- `@everyone` is IMPLICIT: the Grove never carries a role row for it — the
  creating server's @everyone rides the pre-existing role_id seat, exactly as a
  hand-rolled server does today.
- The document carries NO ids, NO timestamps, NO created-state: id assignment is
  the apply's business (the same batch() rowid walk the server-create route
  already performs).

### 1.2 Author-time validation (pure, zero D1)

All of these are REFUSALS before any statement is bound (400-class):
- unknown permission bit name (role or overwrite rows) — the refusal copy names
  the offending bit;
- overwrite rows naming bits OUTSIDE the overwrite vocabulary
  (`OVERWRITE_BITS`: VIEW, SEND, CONNECT, SPEAK, ADD_REACTIONS) — MANAGE_* and
  other server-level bits never ride a channel layer, so an overwrite carrying
  them is an over-grant by construction;
- role/channel references in overwrites naming rows the Grove does not define
  (no forward refs, no wildcards, no name-pattern matching);
- duplicate role names, duplicate channel names;
- caps as data: ≤ GC_ROLES_MAX_PER_SERVER (250) roles, ≤ MAX_CHANNELS_PER_SERVER
  (500) channels — the apply re-checks against the server's live counts anyway.

The validator is a PURE function (`validateTemplate`) imported from
`api/starter-grove.mjs`: no env, no DB, no rate limiter, no session. It returns
the parsed shape or a refusal; the routes module calls it at BOTH seats:
authoring (the template author validates before share) and apply (the creator
validates before the batch).

## 2. The apply contract — EXACTLY hand-rolled

The apply produces the same shapes the server-create route and the channel
create route produce when a human hand-rolls the same server. Concretely:

1. **Roles**: one INSERT per role row into `gc_roles` bound name/color/position/
   permission mask — the same SQL shape the role-create route binds (mask from
   `permissionsFromNames`, positions handed out in the Grove's order).
2. **Channels**: one INSERT per channel row plus its rows in ONE `batch()` —
   the same statement shapes the create routes carry (`LAYERED_CHANNEL_INSERT_
   SQL`-class statements; a private text channel gets its overwrite pair in the
   same batch, `PRIVATE_EVERYONE_DENY_SQL` for the @everyone deny and
   `PRIVATE_ROLE_ALLOWS_SQL`-class role allow exactly as the toggle emits
   today).
3. **Overwrites**: every explicit row is a plain INSERT into
   `gc_channel_overwrites (channel_id, role_id, allow_mask, deny_mask)` —
   allow/deny masks assembled from `OVERWRITE_BITS` names only. The apply
   fabricates NOTHING extra: no implicit role rows beyond @everyone, no
   "helpful" default layers, no server-wide re-grants standing behind an
   @everyone deny. What the document says is the whole surface.
4. **The implicit base is UNTOUCHED**: VIEW | SEND | ADD_REACTIONS resolve
   before any layer exactly as they do on a hand-rolled server; a Grove that
   wants a locked room states it with its own explicit @everyone deny row +
   allow rows, never with hidden magic.
5. **One target, one apply**: a Grove applies to the freshly-created server
   (the creator owns it by construction) or to a NEW server the mod desk forks
   it into. There is no re-apply, no merge, no partial apply — the batch is
   all-or-nothing the hand-roll's transaction already is; a refused apply
   leaves zero rows behind.
6. **Caps re-check at apply** against the target server's live counts, then the
   same coin grant / discovery side effects the server-create route already
   owns ride the ROUTE, not the Grove.

### 2.1 Permission-surface rules (the no-hidden-grants law)

- Roles may name ANY `SERVER_PERMISSIONS` bit — the server-level mask
  vocabulary is exactly what a role can carry when hand-rolled (the
  gc_roles-side words: MANAGE_CHANNELS, MANAGE_ROLES, KICK_MEMBERS,
  MANAGE_INVITES, DELETE_MESSAGES, VIEW, SEND, CONNECT, SPEAK,
  BYPASS_SLOWMODE, ADD_REACTIONS, MANAGE_EMOJI, MENTION_EVERYONE).
- Overwrite layers may name ONLY `OVERWRITE_BITS` — the same tri-state editor's
  list. This is the over-grant refusal the red rows pin first.
- The owner tier bypass remains STRUCTURAL (owner, not a bit), so no Grove can
  mint an owner-equivalent member by data; the mod-lane surfaces
  (`effectivePermissions`, `holdsRolesBitsSql`) read the applied rows the same
  way they read hand-rolled ones.
- Sharing/forking is a data move (the mod desk exports a template document,
  imports it against validation); an over-grant document is refused AT AUTHOR
  TIME — never discovered mid-apply.

## 3. Wire surface (module-level, the routes land with GREEN)

- `GET /api/groves` (or rider on the servers list) — the mod desk's template
  listing; body shapes follow the API envelope law.
- `POST /api/servers/:serverId/grove` — apply into the acting server — OWNER
  ONLY pre-caps? (decided at GREEN: the apply targets a FRESH server, owner by
  construction; the route still answers with the existing 403 copy for
  non-owners riding the manage surfaces).
- Authoring/validate is the pure `validateTemplate` (no route needed; the UI
  forks/shares via the mod desk).

(Exact route naming stays open for GREEN; this spec pins only the CONTRACT:
validate-then-apply, all-or-nothing batch, explicit-overwrites vocabulary.)

## 4. Red rows this spec demands (tests/starter-grove.test.mjs)

1. an overwrite carrying a server-level bit (e.g. MANAGE_CHANNELS) is refused
   at author time — zero statements bound;
2. an unknown permission name is refused — the refusal names the bit;
3. an overwrite referencing an unknown channel or role is refused;
4. duplicate role or channel names are refused;
5. a valid Starter Grove validates and applies: its batch carries the role
   INSERTs, the channel INSERTs, and the explicit overwrite rows — the SQL
   shapes match the hand-roll constants (roles mask via permissionsFromNames,
   the private pair as TWO distinct rows);
6. the apply re-checks caps against the target server's live channel count
   (500-seat refusal with zero rows);
7. the Grove's seeded shape reads EXACTLY like a hand-rolled server through the
   existing mod-lane surface (effectivePermissions walk, no hidden grants).

## 5. Out of scope (parked for later waves)

- Template discovery/ranking (Grove marketplace) — later wave; T78 ships the
  document + apply + mod-desk fork.
- Server EDIT-time application (mutating an existing server) — never; the
  apply is fresh-server only.
