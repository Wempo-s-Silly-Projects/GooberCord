-- 0030: the T76 economy slate's schema half (docs/drafts/t76-economy-slate-
-- spec.md) — the Well, the Campfire, and the gift chains. Four CREATEs, no
-- rebuild (no ALTER/CHECK widening anywhere: every table is new).
--
--   1. gc_well_streaks — the daily claim's streak state. ONE row per member,
--      private to the member (the shop's claim panel is its only renderer);
--      no streak surface leaks anywhere else in the API.
--   2. gc_campfires — the server-wide meter. ONE row per server. The fire is
--      a PURE sink: the pool only ever receives coins that already left
--      circulation (stokes, chain fees), its draws pay out no more than the
--      pool holds, and overflow at the pool cap burns (the credit's MIN arm
--      caps the write). The pool column carries an in-schema floor: the
--      draw's pool-funded payouts ride the payout statements' pool arms, and
--      a CHECK pool >= 0 is the transaction's loud backstop — a run-dry
--      mid-sequence draw aborts wholesale instead of overdrawing.
--   3. gc_chain_hops — the anonymous hop chain. Deliberately NO member
--      columns: the token is the only identity pointer, and NO statement of
--      the chain lane ever joins users to answer "who sent me this" (the
--      RED rows pin related_user_id NULL + no JOIN users on every hop row).
--      pool_server_id is a MARKER seat, deliberately FK-free: the pass/send
--      fee banks into the two members' shared server's campfire (the credit
--      statement upserts it in the same batch), and the no-shared-server
--      corner (fresh DM-only pairs) banks the fee into the marker pool 0 —
--      the fee still leaves circulation (the sink law) even when no named
--      campfire exists yet. A FK here would either forbid that corner or
--      force the hop insert to wait on the credit; the ledger needs neither.
--   4. gc_chain_hold — the receive map: WHICH member holds WHICH hop token.
--      The chain's ONLY identity pointer, readable by its owner alone; both
--      members' rows die with their account (CASCADE), a resolved hop dies
--      with its token.

CREATE TABLE gc_well_streaks (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  streak_days INTEGER NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  bonus_percent INTEGER NOT NULL DEFAULT 0
    CHECK (bonus_percent BETWEEN 0 AND 200),
  last_claim_day INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE gc_campfires (
  server_id INTEGER PRIMARY KEY REFERENCES gc_servers(id) ON DELETE CASCADE,
  fuel INTEGER NOT NULL DEFAULT 0 CHECK (fuel >= 0),
  pool INTEGER NOT NULL DEFAULT 0 CHECK (pool >= 0),
  bonus_until INTEGER,
  last_draw_at INTEGER,
  fuel_today INTEGER NOT NULL DEFAULT 0 CHECK (fuel_today >= 0),
  fuel_today_day INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE gc_chain_hops (
  hop_token TEXT PRIMARY KEY,
  depth INTEGER NOT NULL CHECK (depth >= 1),
  amount INTEGER NOT NULL CHECK (amount > 0),
  pool_server_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_chain_hops_expiry ON gc_chain_hops(expires_at);

CREATE TABLE gc_chain_hold (
  hop_token TEXT PRIMARY KEY REFERENCES gc_chain_hops(hop_token) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_chain_hold_user ON gc_chain_hold(user_id);
