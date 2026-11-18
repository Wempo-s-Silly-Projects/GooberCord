# Decisions ledger

Append-only records of fleet rulings and render outcomes, in ADR shape.
One numbered file per decision; rulings in `.remember/` and board rows stay
ephemeral — this directory holds the citable, dated copy. Every record
carries: context, decision, consequences, and (for parity/ops claims) source
URL + date, per the parity law.
