-- 0043: Reaction-tag opts user index (T89, docs/drafts/t89-reaction-tags-
-- spec.md §5 PARKED candidate; t89-review LOW, lead countermand 2026-11-18).
-- 0041 is PROD-applied (d1_migrations ids 84-86, tables verified live) and
-- therefore byte-IMMUTABLE — this index rides its OWN migration, never an
-- amend of an applied file. The mine read's gc_reaction_tag_opts side is
-- user-keyed; the optimizer gets the user-column entry point.
CREATE INDEX idx_gc_reaction_tag_opts_user
  ON gc_reaction_tag_opts (user_id);
