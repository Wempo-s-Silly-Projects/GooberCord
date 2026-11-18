-- 0037: The Morning Paper (T87, docs/drafts/t87-morning-paper-spec.md §4) —
-- the ONE new table, nothing else (no rebuild, no ALTER: the table is new;
-- ordinal ordered after 0035 — 0036 rides the in-flight sound-packs lane).
--
-- gc_paper_configs — the paper's whole seat. The paper is DERIVED ON REQUEST
-- from rows the server already stores (gc_messages, thread seats,
-- gc_capsules): there is NO paper-issues table, NO render cache, NO
-- per-issue persistence, and no history archive — "yesterday's paper" is
-- re-derived from the previous UTC day-key window the same way, so one
-- config row per server carries the entire feature. Absence of the row IS
-- the off-state (defaults law): no default row, no tombstone, no history —
-- the DELETE is the whole off-transition, and an untouched server answers
-- every paper route with the unconfigured 404 shape. Both FKs cascade: the
-- server's death and the enabling mod's account deletion take the seat with
-- them, so the config can never outlive its owners.
CREATE TABLE gc_paper_configs (
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id)
);
