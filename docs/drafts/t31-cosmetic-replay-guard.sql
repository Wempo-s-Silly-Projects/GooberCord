-- T31 draft ONLY — NOT a migration. Applied by hand to NO environment; the
-- app-side NOT-EXISTS spend guard (api/coins.mjs, COSMETIC_LEDGER_SPEND_SQL)
-- already closes the REPLAY gap. This draft documents the D1-native layer
-- that additionally closes the CONCURRENT double-submit (two requests whose
-- NOT-EXISTS reads both see an empty table pre-commit).
--
-- A plain UNIQUE on (user_id, delta, source, created_at) is WRONG: a caller
-- legitimately buying banner then flair inside one wall-clock second would
-- collide on identical delta/source/created_at. Idempotency needs a
-- REQUEST-borne nonce, so this is a schema + route change, not one index.
--
-- Prereq: gc_cosmetic_ownership exists (0019) with PRIMARY KEY (user_id, item).

ALTER TABLE gc_coin_ledger ADD COLUMN client_nonce TEXT;

-- Two purchases of the SAME kind from the SAME user may legitimately share a
-- created_at second only when they carry different nonces.
CREATE UNIQUE INDEX IF NOT EXISTS gc_coin_ledger_user_source_nonce
  ON gc_coin_ledger (user_id, source, client_nonce)
  WHERE client_nonce IS NOT NULL;

-- Route contract change this implies (draft, unimplemented):
--   POST /api/coins/cosmetics accepts { item, nonce } — nonce a non-empty
--   string <= 64 chars, generated client-side per checkout attempt and
--   REUSED across that attempt's retries. Route binds it as the ledger
--   spend's client_nonce; an INSERT ... ON CONFLICT(gc_coin_ledger
--   user_source_nonce) DO NOTHING + the existing changes-count classification
--   turns a true concurrent double-submit into one charge + one 409.
-- Legacy rows (client_nonce NULL) are untouched by the partial index, so
-- backfill is not required and history keeps its duplicate fingerprints.
