# Contributing to GooberCord

Thanks for wanting to help. This repo is a Cloudflare Worker (vanilla
imperative JS, no frontend framework, no build step) with a D1 database, so
the setup is light.

## Setup

1. Install [pnpm](https://pnpm.io) (it is the only package manager this
   repo uses — never `npm`/`npx`):

   ```bash
   corepack enable pnpm
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. For a local worker, create a `.dev.vars` file at the repo root holding
   the secret bindings the worker reads (Turnstile keys, password pepper,
   relay secret). `.dev.vars` is git-ignored and stays that way — never
   commit it and never print its values.

4. Apply the migrations to the local D1 store and start the dev server:

   ```bash
   pnpm run db:migrate:local
   pnpm run dev
   ```

5. Open the URL Wrangler prints. Migrations applied without `--remote`
   never touch production.

## Tests

The suite is `node --test`, wired as `pnpm test`. Some suites also exercise
vendored-module parity or contract parity against the sibling repos; run
the whole thing, not just one file, before you push:

```bash
pnpm test
```

Also worth running before you declare done:

```bash
pnpx wrangler deploy --dry-run
```

## Ground rules

- **AGPL-3.0-or-later.** By contributing you agree your work is licensed
  under the same license as the repo (see [LICENSE](LICENSE)).
- **Vanilla imperative JS.** No new frameworks, no build pipeline. The
  files under `api/vendor/` and `public/js/vendor/` are vendored byte-parity
  pins — never edit them by hand.
- **Migrations are append-only.** Add a new numbered migration; never edit
  an applied one.
- **Parity numbers need sources.** Any Discord-parity claim carries the doc
  URL and date you verified it at.
- **Secrets stay out.** No keys, peppers, or tokens in code or commits.
- The house code style favors small files, early returns, immutable data,
  and named constants over magic numbers.

## Commit format

Conventional, one line:

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Issues

Open a GitHub issue on
<https://github.com/Wempo-s-Silly-Projects/GooberCord> with what you did,
what you expected, and the actual result. Security reports: please use a
private channel rather than a public issue.
