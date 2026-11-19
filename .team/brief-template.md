# Seat brief + report contract (harness law, lead-side)

Every seat brief rides the Section Q echo (time-boxed / code-only / diff-scope /
fast-fail) PLUS the observation contract below. Every seat's final report ENDS
with these five lines — the lead parses them, not the prose:

```
STATUS: GREEN | AMBER | RED
EVIDENCE: <files>[:lines] + commands run + counts (suite pass/fail, probes)
BLOCKERS: <one line each, or NONE>
NEXT_ACTIONS: <max 3, actionable, or DONE>
OWNER_GATED: < decisions only the owner can render, or NONE>
```

Rules:
- RED must carry the raw error verbatim (fast-fail law) — never a paraphrase.
- Parity/claims carry source URL + date. Suite greens carry the exact tip SHA.
- NEXT_ACTIONS are the lead's queue, not the seat's todo — the seat stops there.
- No essay before the five lines; prose past the block is ignored on triage.
