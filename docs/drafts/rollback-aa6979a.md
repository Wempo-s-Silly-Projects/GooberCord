<!--
                    GNU AFFERO GENERAL PUBLIC LICENSE
                       Version 3, 19 November 2007

 Copyright (C) 2026 ItsWempo
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

 This file is part of GooberCord. GooberCord is free software: you can
 redistribute it and/or modify it under the terms of the GNU Affero General
 Public License as published by the Free Software Foundation, either
 version 3 of the License, or (at your option) any later version. GooberCord
 is distributed in the hope that it will be useful, but WITHOUT ANY
 WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for
 more details. You should have received a copy of the GNU Affero General
 Public License along with GooberCord. If not, see
 <https://www.gnu.org/licenses/>. This notice must be kept in all copies
 or substantial portions of GooberCord. The current license text lives in
 the repository root LICENSE file.

-->

# Rollback runbook — prod build `aa6979a` (version `dc9a7350`)

Current prod: GooberCord worker built from `aa6979a`, deployed as version
`dc9a7350`. Use this runbook to revert prod to the commit BEFORE `aa6979a`
(called `<prev-sha>` below) without touching data.

## Before you start

- Package manager is pnpm (`pnpm/pnpx only`).
- Deploys and remote D1 are authorized, but a ROLLBACK MUST NOT RUN D1
  MIGRATIONS (see Hazards).
- Confirm the rollback target exists: `git log --oneline aa6979a~1 -1`.

## Revert-to-previous-SHA redeploy

1. Check out the target commit and verify it is the one before the bad tip:

   ```sh
   git checkout aa6979a~1            # or the concrete <prev-sha>
   git log --oneline -1              # head must print <prev-sha>
   ```

2. Redeploy from that checkout. The `deploy` script binds the version stamp
   from the checkout itself (`package.json` `deploy`:
   `wrangler deploy --var COMMIT_SHA:$(git rev-parse --short HEAD)`), so the
   rollback is a plain script run — no manual `--var` overrides:

   ```sh
   pnpm run deploy
   ```

3. Note the new version id Wrangler prints; the build stamp should report
   `<prev-sha>`.

## Verify the rollback

- `/api/version`: `GET https://goobercord.itswempo.workers.dev/api/version`
  must return `{ "version": "1.0", "build": "<prev-sha>" }`
  (`api/accounts.mjs` `handleVersionRoute` echoes `env.VERSION` and
  `env.COMMIT_SHA`).
- Home route: load `/` and confirm the home plate renders and the stamped
  `<meta>` build matches `<prev-sha>` (the client stale-build feature
  compares the meta stamp against `/api/version`).
- EN bundle: confirm `public/locales/en.json` loads with the page (no 404,
  no fallback-to-raw keys on painted seats).
- `/api/me`: with a signed-in session cookie, the boot GET returns the
  normal session shape (no new Set-Cookie surprises from the older wire).

## Hazards (read before step 2)

- **D1 migrations are NOT touched by a worker rollback.** `wrangler deploy`
  ships code only; the database at `wempo-forum-data` keeps whatever
  migrations the newer tip applied. If `aa6979a` shipped a migration and you
  roll the worker back, the schema stays FORWARD — never "fix" this by
  rolling migrations back; escalate instead. Rollback is code-only.
- **Var drift, not version drift:** if the bad tip changed `wrangler.toml`
  `[vars]` or bindings (rate limiters `GC_*`, D1 binding), the older code
  deploys with the CURRENT config — older worker, newer config. Read the
  `aa6979a..HEAD` diff for `wrangler.toml` before redeploying.
- **Assets are deployed with the worker:** the older deploy also rolls the
  served client bundle back. That is correct behavior here, but any newer
  locale seats or client-only fixes vanish with it — expect the older UI.
- **Never force `--var COMMIT_SHA:` with a value that is not the checkout's
  HEAD** — the version stamp is a probe of what the worker actually IS.
- Do NOT roll `dev`/`main` back in git; rollback is a prod deployment
  action only.

## Roll forward

When the defect in `aa6979a..HEAD` is fixed, redeploy by checking out the
fixed tip and running `pnpm run deploy` again; `/api/version` must
report the new tip's short SHA.
