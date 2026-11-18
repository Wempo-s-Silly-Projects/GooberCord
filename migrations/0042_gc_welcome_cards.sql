-- 0042: Server welcome card (T92, docs/drafts/t92-welcome-card-spec.md §3) —
-- the TWO new tables, nothing else (this file creates schema and nothing
-- more: no shared-table edit, no seed, no trigger, no rollup).
--
-- gc_welcome_cards — the config seat: one row per server, ever (the
-- (server_id) PRIMARY KEY IS the upsert's conflict target). Absence of the
-- row IS the off-state (the 0037 idiom, spec §2) — no tombstone, no history.
--
-- gc_welcome_card_views — the shown-once ledger: the (server_id, user_id)
-- composite key IS the member-self-recorded contract; a row exists only
-- after the member themselves fetched the card (spec §3). NO FK: a server's
-- removal leaves orphan view rows that no read ever joins back — no CASCADE
-- arm to reason about, no edit to any other table's write path.
CREATE TABLE gc_welcome_cards (
  server_id INTEGER NOT NULL,
  blurb_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id)
);
CREATE TABLE gc_welcome_card_views (
  server_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  shown_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
