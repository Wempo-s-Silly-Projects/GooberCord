-- 0040: Month-day anniversaries (T91, docs/drafts/t91-anniversaries-spec.md §4) —
-- the ONE seat statement, nothing else (CREATE-only: no rebuild, no ALTER,
-- one statement).
--
-- gc_user_anniversaries — one member, at most one month-day anniversary: the
-- PK IS the seat. The schema IS the privacy law (LIMIT COLLECTION NOT
-- ACCESS): MONTH+DAY and nothing else. There is no year column and no
-- anchored timestamp — the data a "member for N years" computation needs
-- does not exist and can never be derived on this seat; any future
-- migration adding one is rejected on its face. An account's death cascades
-- the row away (no orphan, GDPR shape free of charge: nothing to export).
CREATE TABLE gc_user_anniversaries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month   INTEGER NOT NULL CHECK (month IN (0,1,2,3,4,5,6,7,8,9,10,11)),
  day     INTEGER NOT NULL CHECK (day >= 1 AND day <= 31),
  PRIMARY KEY (user_id)
);
