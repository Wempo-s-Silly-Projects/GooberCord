-- Copyright 2026 YourLocalGoober
--
-- This file is part of GooberCord.
--
-- GooberCord is free software: you can redistribute it and/or modify it
-- under the terms of the GNU Affero General Public License as published by
-- the Free Software Foundation, either version 3 of the License, or
-- (at your option) any later version.
--
-- This program is distributed in the hope that it will be useful, but
-- WITHOUT ANY WARRANTY; without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
-- GNU Affero General Public License for more details.
--
-- You should have received a copy of the
-- GNU Affero General Public License along with this program.  If not,
-- see <https://www.gnu.org/licenses/>

-- 0059 — the server audit log (wave 26, W26-1). Every moderation action
-- (kick/ban/unban/nick/role create-edit-delete/overwrite edits/prune)
-- writes ONE gc_server_audit row at the mutation's commit point: the
-- actor, an i18n-friendly action_key, the optional target member, a
-- nullable string reference, one JSON payload of the before→after deltas,
-- and the timestamp. The read (GET /api/servers/:id/audit) serves the
-- newest-first page behind the owner/moderator manage tier; the page's
-- cap lives in constants.mjs (AUDIT_READ_LIMIT, never re-declared).
--
-- FK discipline (the D1 FK-runner law, 0055 precedent): ZERO foreign
-- keys — plain INTEGER columns + CHECKs only. A rename-rebuild is dead on
-- populated parents, and an audit trail must survive the actors/targets
-- it names anyway (a deleted member's kick row stays evidence; the row is
-- history, never a live join arm). The index serves the read's
-- (server, newest-first) arm — the only path the page takes.
--
-- The payload's byte ceiling is the constants.mjs seat
-- AUDIT_PAYLOAD_MAX_BYTES duplicated as a literal CHECK bound below: SQL
-- cannot import the constant, and a second definition in constants would
-- drift — this literal is the migration-side mirror of the one law
-- number.

CREATE TABLE IF NOT EXISTS
  gc_server_audit
(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  action_key TEXT NOT NULL,
  target_user_id INTEGER NULL,
  target_ref TEXT NULL,
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 4096),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_gc_server_audit_server
  ON gc_server_audit(server_id, id);
