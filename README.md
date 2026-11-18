# GooberCord

A Discord-style chat app running on Cloudflare Workers + D1 —servers, rooms,
messages, reactions, roles, uploads, soundboard, GIFs, an economy (coins,
boosts, Goober+), a daily Morning Paper, campfire, bookmarks, and more. All
vanilla imperative JS on both sides: no frontend framework, no build step.

- **Live:** <https://goobercord.itswempo.workers.dev>
- **Source:** <https://github.com/Wempo-s-Silly-Projects/GooberCord>

GooberCord shares one identity layer and one production D1 database with
[wempos-forum] and [wempos-forum's sign-in worker]
[wempo-accounts]: accounts are minted at
<https://accounts.itswempo.workers.dev> and session/user/ban rows are
parity-locked between the apps by contract tests.

## Features

- Servers, rooms, messages, mentions, reactions, conversation DMs
- Presence, WebSocket relay, mobile push-style job queue
- Roles, permissions, mod rules, message filters
- Coins economy, Goober+ tiers, server boosts, cosmetics
- Uploads, GIFs (Tenor), soundboard with sound packs
- Bookmarks, campfire, daily Morning Paper, Goober Day, seasons
- Welcome cards, reaction tags, accent colors, usernames
- 8 UI languages beside English (es, de, fr, pt, ru, ja, zh, ar)
- Turnstile on the door, TOTP two-factor, rate limiters per lane

## Quick start (local dev)

```bash
pnpm install
pnpm run db:migrate:local   # apply migrations to the local D1 store
pnpm run dev                # wrangler dev
```

Secret bindings (Turnstile keys, password pepper, relay secret) are
owner-held: put what you need in `.dev.vars` for local runs — it is
git-ignored and never committed. Without them the app still serves and the
test suite stays green.

Run the tests:

```bash
pnpm test
```

Deploy is always `pnpm run deploy` (it stamps the commit SHA the client uses
as its bundle cache-buster). Deploying is the owner's job, not a
contributor's.

## Repo layout

| Path | What it holds |
| --- | --- |
| `api/` | The `/api/*` endpoints, one module per domain |
| `api/vendor/` | Vendored framework modules, byte-parity pinned |
| `public/` | The client (vanilla JS + CSS) and locale bundles |
| `migrations/` | D1 migrations, sequential |
| `tests/` | `node --test` suites (unit, contract parity, i18n) |
| `docs/` | Parity board, license ledger, specs, decisions |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup details, test
commands, and commit conventions.

## License

AGPL-3.0-or-later — see the [LICENSE](LICENSE) file (full text in
[COPYING](COPYING)). If you run a modified version over a network, you owe
your users the source of that version (AGPLv3 section 13).

[wempos-forum]: https://github.com/Wempo-s-Silly-Projects/wempos-forum
[wempo-accounts]: https://github.com/Wempo-s-Silly-Projects/wempo-accounts

[![Built with Cloudflare](https://workers.cloudflare.com/built-with-cloudflare.svg)](https://cloudflare.com)
