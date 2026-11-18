# T67 — ToS/Privacy venue: options memo (draft, owner decision pending)

Status: DRAFT — not committed, awaiting the owner's venue call. No terms or
privacy text exists anywhere in the fleet yet (grepped .md/.js/.mjs/.html);
this memo only picks where that text will LIVE, not what it says.

The venue decision is one text, three consumers: GooberCord, wempos-forum,
and Wempo Accounts (accounts.itswempo.workers.dev, shared DB). Whichever
venue wins, all three programs must point at the SAME canonical wording —
the twin-pair habit that governs code should govern legal text too.

## Option 1 — In-app legal pages

Terms and data-handling pages render inside each app (a legal route in the
SPA, locale keys in public/locales/*.json, footer/settings links to it).

- Discovery: strongest — users meet the text without leaving the app, the
  same surface Discord's own users meet theirs on. Parity target favors it.
- Edit friction: heaviest. Every wording change is a code commit, a locale
  sweep across all 8 bundles, and a deploy. Versioning has to be re-invented
  (a rendered string in JSON has no natural version pin).
- License-placement parity: weakest. The per-file notice program lives in
  code and COPYING/README; embedding legal prose in code makes the notice
  template share a file with the very terms it governs, and pins the text to
  each repo separately (three copies that can drift).
- One-way door risk: once users link to in-app routes, moving the venue
  later breaks every published link.

## Option 2 — docs/ + footer link

Canonical text lives in-repo: docs/terms.md + docs/privacy.md, linked from
an in-app footer pointing at the public repo path (the repo is PUBLIC — the
GitHub URL is a stable, free, un-editable-provenance venue) on each of the
three apps.

- Discovery: weaker at the app surface — one footer link out. Mitigable by
  putting the link in the app footer (always visible) and the settings page.
- Edit friction: lightest. A docs edit is a commit, no deploy, no locale
  sweep; git history IS the version pin (every amendment is diffable, which
  a "changes take effect" clause wants anyway). A rendered page can note the
  commit SHA at print time if the owner wants visible versions.
- License-placement parity: strongest. This is exactly how COPYING +
  README already work — repo-level legal text at repo level, shared wording
  across the coordinated repos, the twin-pair pattern the ledger files
  already follow. No legal prose inside the notice template's files.
- Fleet fit: docs/platform-rules.md already lives in docs/ as the fleet's
  ruled-text venue; terms + data-handling text joins the same shelf, and
  the GDPR cross-app deletion question (parked) also spans all three apps,
  so one cross-app document beats three in-app copies.

## Compliance seat's read (not a decision)

Option 2 for the canonical text, with the in-app side staying pointer-only
(links, never embedded prose). That preserves the AGPL placement pattern,
solves the three-app drift hazard, and keeps amendment friction near zero;
a later owner call can always add in-app rendered copies on top — pointer
surfaces are cheap to keep either way.

Amendment law to fold in once the venue is picked: network-facing terms
changes take effect on announce, never default-on (the FSF defaults law);
archive superseded wording in git history and cite the commit SHA.
