-- 0039: The Campfire Ledger (T90, docs/drafts/t90-campfire-ledger-spec.md §2) —
-- the ONE new table, nothing else: no rebuild of any existing seat.
--
-- gc_campfire_pool_ledger — the fire's books. Pool-flow rows did not exist
-- before this seat (gc_campfires.pool is one overwritten meter column, and
-- the coin ledger is keyed to coin holders, never to servers), so the
-- ledger's history CANNOT be derived without it: NONE-NEEDED is FALSE, the
-- seat is REQUIRED, and the books open at migration day — no backfill, since
-- pre-0039 pool movements are not reconstructible. Per-flow-class only: NO
-- coin-holder identity rides the schema, so no attribution column exists to
-- name in any query, ever. A server's death cascades its books away.
CREATE TABLE gc_campfire_pool_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES gc_servers(id) ON DELETE CASCADE,
  class TEXT NOT NULL,
  source TEXT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  created_at INTEGER NOT NULL
);
-- The read's only access path: server-keyed, windowed by created_at.
CREATE INDEX gc_campfire_pool_ledger_server_window
  ON gc_campfire_pool_ledger (server_id, created_at);
