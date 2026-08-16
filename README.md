# AlmostHadAI

A single-channel Twitch chat bot for [`aimosthadme`](https://www.twitch.tv/aimosthadme),
running as the bot account `almosthadai`.

Node.js, CommonJS, no build step. MySQL for persistence, Redis as an optional cache
and analytics write queue, Twitch EventSub over WebSocket for all live events.

---

## What it does

- **AI chat** — responds to mentions, plus `!ai`, `!advice` and `!roast`, via the
  Claude API. Per-role rate limits, per stream.
- **Song requests** — channel-point redemptions add Spotify tracks to a MySQL-backed
  queue; a poller feeds them into the real Spotify queue as the current track ends.
- **Commands** — stored in MySQL. Static text commands are editable from chat;
  richer ones are backed by handler modules discovered at startup.
- **Emotes** — exact-match trigger/response pairs.
- **Quotes** — added by redemption, recalled by command.
- **Analytics** — chat messages, viewing sessions, per-stream totals, follows.
- **Discord** — go-live notification with a cooldown.
- **Backups** — hourly `mysqldump` to S3, verified before upload, with rotation.
- **Stream Deck API** — loopback-only HTTP endpoint for toggling song requests.

## Running it

```bash
npm install
npm start
```

Node 24 or newer (see `.nvmrc`).

Debug mode uses a separate `<DB_NAME>_debug` database, forces full operation
regardless of stream status, and skips backups and Discord notifications:

```bash
npm run debug
```

### Lifecycle

The bot has two modes and moves between them on its own.

**Minimal mode** (stream offline): a WebSocket connection subscribed only to
`stream.online`, `stream.offline` and `channel.follow`, plus the token refresh
check. Nothing else runs.

**Full operation** (stream live): everything above plus chat and channel-point
subscriptions, analytics, viewer polling every 60s, the Spotify monitors, hourly
backups, and the API server.

Stream ends → tears back down to minimal mode and starts a 30-minute grace timer
that exits the process. Stream returns → cancels the timer and starts up again.
`SIGINT`/`SIGTERM` → graceful shutdown: ends sessions, drains the Redis queues,
takes a final backup, closes connections.

## Configuration

Secrets come from `.env`. Behaviour knobs live in `src/config/config.js`, which is
the intended place to tune the bot.

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | yes | MySQL connection |
| `DB_CONNECTION_LIMIT` | no | Pool size, default 10 |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | no | Omit to run without Redis |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET_NAME` | for backups | S3 destination |
| `DISCORD_WEBHOOK_URL` | for go-live posts | |
| `API_ENABLED`, `API_PORT`, `API_KEY` | for the Stream Deck | Loopback only |
| `LOG_DIR` | no | Log directory, default `logs/` at the repo root |

Twitch and Spotify credentials are **not** environment variables — they live in the
`tokens` table in MySQL, which the bot reads at startup and updates as tokens rotate.

### Environment — the Phase-1 server

Separate from the legacy bot's variables above. Validated at boot by
`server/src/config/env.ts`, which reports **every** problem at once and exits 78.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis connection string |
| `DATABASE_POOL_MAX` | no | Pool size, default 10 |
| `PORT`, `LOG_LEVEL`, `NODE_ENV` | no | Default 3000 / `info` / `development` |
| `PUBLIC_URL` | for webhooks | The public origin; **must be https** in production |
| `TWITCH_EVENTSUB_SECRET` | **in production** | Webhook signing secret, 10–100 ASCII characters |
| `EVENTSUB_MAX_SKEW_SECONDS` | no | Replay window, default 600 (Twitch's documented 10 minutes) |
| `BOT_TWITCH_USER_ID` | no | Overrides `bot_identity` before onboarding exists |
| `AI_TRIGGERS` | no | Comma-separated names the AI answers to; defaults to the bot's login |

`TWITCH_EVENTSUB_SECRET` defaults to a placeholder so `docker compose up` needs no
configuration, and the server **refuses to start on that placeholder when
`NODE_ENV=production`** — it is committed and therefore public, so shipping it would
let anyone forge a signed event. Production compose runs need a real one:

```bash
TWITCH_EVENTSUB_SECRET=... docker compose -f docker-compose.yml up -d
```

See [`.env.example`](.env.example) for the full annotated list, including the Twitch
application credentials, `TOKEN_ENCRYPTION_KEY` and `JWT_SECRET`.

### Connecting to Twitch

Three OAuth flows share **one** registered redirect URI — the flow is carried in the
server-issued `state`, so the Twitch console needs a single callback URL:

| Route | Who visits it | Grants |
|---|---|---|
| `/auth/bot/connect` | the shared bot account, once | `user:read:chat`, `user:write:chat`, `user:bot` |
| `/auth/twitch/connect` | each broadcaster | `channel:bot`, `channel:read:redemptions`, `channel:manage:redemptions`, `moderator:read:followers`, `moderator:read:chatters` |
| `/auth/app/login` | a desktop-app user | nothing — identity only |

Both URLs are logged at boot. Connecting a channel stores its tokens encrypted,
starts its session immediately, and reconciles its subscriptions — no restart.

Subscription management stays a **dry run** until `EVENTSUB_DRY_RUN=false`, which
additionally requires real client credentials and a `PUBLIC_URL`. A misconfigured
deployment therefore cannot delete a working channel's subscriptions on its first boot.

### Tokens at rest

Every OAuth token in `channel_tokens` and `bot_identity` is AES-256-GCM encrypted
under `TOKEN_ENCRYPTION_KEY`, bound to its column so a value cannot be moved between
them. Without the key the server still boots in development but **refuses to store or
read any credential** — it cannot silently fall back to plaintext.

Rows imported by the ETL predate encryption. Upgrade them once:

```bash
npm run db:encrypt-tokens -w server -- --dry-run
```

Drop `--dry-run` to write. It is idempotent and reports counts only — never a value.

### Database roles

Runtime connects as `almosthadai_app`, which can read and write data but does not own
the tables and cannot alter them. Migrations use `MIGRATION_DATABASE_URL` (the owner
role) on a connection opened at boot and closed immediately. If the runtime credential
leaks, the blast radius is the data it could always read — not the schema.

### Notable knobs in `config.js`

| Setting | Default | Meaning |
|---|---|---|
| `tokenRefreshInterval` | 5 min | How often expiry is *checked* |
| `tokenRefreshSafetyMargin` | 15 min | How close to expiry a token is *rotated* |
| `shutdownGracePeriod` | 30 min | Offline wait before the process exits |
| `viewerTrackingInterval` | 60 s | Chatter poll |
| `spotifyInterval` | 3 s | Playback poll |
| `backupInterval` | 1 h | Scheduled backup |
| `cache.*TTL` | 300 s | Redis cache lifetimes |
| `rateLimits.claude.streamLimits` | per role | AI requests per user per stream |

### Redis is optional

Every Redis-backed path has a MySQL fallback. With Redis down the bot still works;
commands and emotes read from an in-memory cache backed by MySQL, and analytics
writes go straight to the database instead of through the queue.

## Layout

```
src/
├── bot.js                  Composition root: DI wiring, lifecycle, shutdown
├── config/                 All configuration
├── ai/                     Claude client, rate limiter, context and prompt builders
├── analytics/              Analytics manager and viewer tracking
├── api/                    Express server, API-key middleware, song routes
├── commands/               Command registry + auto-discovered handler modules
├── database/               Pool, transactions, backups, debug DB setup, schema
├── emotes/                 Trigger/response matching
├── logger/                 Winston setup with error dedup and rate limiting
├── messages/               Chat routing, sending, redemption dispatch
├── notifications/          Discord webhook
├── redemptions/            Channel-point routing; quotes and songs
├── redis/                  Connection, cache, queue, analytics consumer
├── services/               Song-toggle service
├── tokens/                 Token lifecycle and Twitch Helix client
└── websocket/              EventSub connection and subscription management
tests/                      Mirrors src/
docs/                       Baseline review, work packages, migration, smoke test
```

### How a chat message flows

EventSub → `bot.handleChatMessage` → `chatMessageHandler`, which in order: ignores
the bot's own messages and reward-attached ones, checks whether the message mentions
the bot (commands always win), checks for an exact emote match, dispatches `!`
commands, and records analytics.

### How a command resolves

`commandManager` looks the name up in Redis, then its in-memory map, then MySQL.
A command either has `handler_name` — dispatched to a function loaded from
`commands/handlers/` — or a static `response_text`. Permission is decided in exactly
one place: from the handler's declared level if it has one, otherwise from the
database row.

## Testing

```bash
npm test              # full suite
npm run test:coverage # with coverage report
npm run test:watch    # watch mode
```

The suite is fully mocked — no database, Redis, or network access required, and no
test can reach an external host. Roughly 1200 tests across 49 suites, a few seconds
to run.

Coverage thresholds are enforced in `jest.config.js` (75% statements/lines/functions,
70% branches).

### Local development loop

The Phase-1 server runs in Docker with a live-reload overlay:

```bash
docker compose up
```

`compose.override.yml` is picked up automatically: it bind-mounts `server/src`
and `shared/src` and runs the server through `tsx watch`, so saving a file
restarts the process without a rebuild. Postgres, Redis and Caddy come up
alongside it. The server is on `http://localhost:3000` and through Caddy on
`http://localhost:8080`.

Production and CI use the base file explicitly and never see the overlay:

```bash
docker compose -f docker-compose.yml up --build
```

Working on the server without Docker:

```bash
npm run build          # shared/ must be built once for server/ to resolve it
npm run dev            # tsx watch against a locally-running Postgres/Redis
npm run test:server    # Vitest
```

Schema and repository tests need a Postgres; they self-skip without
`TEST_DATABASE_URL` and CI always supplies one. They wait for a warming database
rather than failing on a cold stack, so `docker compose up && npm run test:server`
works without a pause in between.

### Feeding the bot events locally

Twitch delivers events by POSTing to a public HTTPS callback, which a laptop does
not have. Rather than run a second transport for development, the same webhook
endpoint is driven with correctly-signed synthetic deliveries:

```bash
npm run dev:event -w server -- --kind chat --broadcaster 1001 --text "!discord"
```

The response appears in the server log as a `CHAT SEND` line — but only for a
channel the server is running, since it bootstraps from `channels` at boot. Two
channels with deliberately colliding command names:

```bash
docker compose exec -T postgres psql -U almosthadai -d almosthadai <<'SQL'
insert into channels (twitch_broadcaster_id, twitch_login) values ('1001','alpha'), ('2002','beta')
  on conflict (twitch_broadcaster_id) do nothing;
insert into commands (channel_id, name, response_text, user_level)
select id, '!discord', 'ALPHA discord link', 'everyone' from channels where twitch_broadcaster_id='1001'
union all select id, '!discord', 'BETA discord link', 'everyone' from channels where twitch_broadcaster_id='2002'
union all select id, '!mods', 'beta mods only', 'mod' from channels where twitch_broadcaster_id='2002';
SQL
docker compose restart server
```

Then `--broadcaster 1001` and `--broadcaster 2002` with the same `!discord` produce
different responses, and `!mods` in beta is refused without `--mod`.

Other kinds:

```bash
npm run dev:event -w server -- --kind online  --broadcaster 1001
npm run dev:event -w server -- --kind verify  --broadcaster 1001
npm run dev:event -w server -- --kind revoke  --broadcaster 1001
```

Flags: `--url` (default `http://localhost:3000/eventsub/webhook`), `--secret`
(default `$TWITCH_EVENTSUB_SECRET`, falling back to the development placeholder),
`--chatter`, `--mod`.

This signs with the same function the webhook verifies with, so it exercises the
real HMAC path — a broken signature scheme fails here exactly as it would against
Twitch.

#### The Twitch CLI

The [Twitch CLI](https://dev.twitch.tv/docs/cli/event-command) can forward signed
mock events to a local address, and it is worth having:

```bash
twitch event trigger streamup -F http://localhost:3000/eventsub/webhook -s dev-only-eventsub-secret-change-me
twitch event verify-subscription streamup -F http://localhost:3000/eventsub/webhook -s dev-only-eventsub-secret-change-me
```

It covers `stream.online` (`streamup`), `stream.offline` (`streamdown`),
redemptions, and the challenge-response check — and `-r revoked` produces a
revocation delivery.

**It cannot trigger `channel.chat.message`**, which is the event nearly every
feature depends on, so it complements the script above rather than replacing it.
Either way there is only **one** ingest implementation: both paths POST to the
same endpoint through the same signature check.

### CI

Every push and pull request to `main` runs lint and the full suite via GitHub Actions
(`.github/workflows/ci.yml`), on the Node version in `.nvmrc`. A separate job runs
`npm audit --audit-level=high`.

Dependencies are pinned exactly and updated by Renovate — see
[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md).

Lint locally with:

```bash
npx eslint src/ tests/
```

## API v1

JWT-guarded REST plus a channel-scoped realtime feed. The typed contract —
request schemas and response types — lives in `@almosthadai/shared`, so the
desktop client and the server are compiled against the same definitions.

### The tenant rule

**No endpoint accepts a channel identifier.** The credential selects the tenant:
a token issued for channel A resolves to channel A and there is no field,
header, or path segment that can say otherwise. Isolation is a property of the
routing table rather than of every handler remembering a `WHERE` clause.

### Authentication

| Mode | Header | Reaches |
|---|---|---|
| Session JWT | `Authorization: Bearer <token>` | everything |
| API key | `X-Api-Key: ahai_…` | **songs endpoints only** |

Sign in at `/auth/app/login`; the access token lasts `JWT_TTL_SECONDS` (15
minutes by default) and is renewed at `/auth/app/refresh`, which rotates the
refresh token on every use.

API keys are for a Stream Deck. They are deliberately narrow: a button needs to
skip a track, and a key that could also rewrite commands or read analytics would
be a far worse thing to have taped inside a profile. A key is shown once at
creation and only its hash is stored — there is no recovery endpoint.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/me` | caller, channel, settings — the only route valid with no channel |
| PATCH | `/api/v1/me/settings` | `aiEnabled`, `songRequestsEnabled`, `discordWebhookUrl` |
| GET | `/api/v1/commands` | list (`?limit=&offset=`) |
| POST | `/api/v1/commands` | create |
| PATCH | `/api/v1/commands/:name` | update response and/or level |
| DELETE | `/api/v1/commands/:name` | delete |
| GET | `/api/v1/emotes` | list |
| POST | `/api/v1/emotes` | create |
| DELETE | `/api/v1/emotes/:trigger` | delete |
| GET | `/api/v1/quotes` | list, newest first |
| GET | `/api/v1/quotes/random` | one at random |
| GET | `/api/v1/quotes/:number` | by number |
| POST | `/api/v1/quotes` | add |
| DELETE | `/api/v1/quotes/:number` | delete |
| GET | `/api/v1/songs` | queue **(key ok)** |
| DELETE | `/api/v1/songs/head` | skip the current track **(key ok)** |
| POST | `/api/v1/songs/toggle` | enable/disable requests **(key ok)** |
| GET | `/api/v1/analytics/summary` | totals and top chatters |
| GET | `/api/v1/api-keys` | list keys (never the key itself) |
| POST | `/api/v1/api-keys` | create — returns the key **once** |
| DELETE | `/api/v1/api-keys/:id` | revoke |

Every response uses the standard envelope: `{ok: true, data}` or
`{ok: false, error: {code, message}}`. Codes are `bad_request`, `unauthorized`,
`forbidden`, `not_found`, `conflict`, `rate_limited`, `internal`, `unavailable`.

Quote numbers are never reissued after a delete — a quote is referred to by
number in chat and in clips, so renumbering would silently change what an old
reference points at.

### Realtime

```
wss://<host>/api/v1/live?access_token=<jwt>
```

Authentication happens at the upgrade, before the socket exists, and binds it to
one channel. There is no subscribe message and no way to ask for a different
channel.

| Event | When |
|---|---|
| `hello` | on connect, so a client can render immediately |
| `chat.message` | every chat message, with the pipeline's `outcome` |
| `song_queue.updated` | queue changed |
| `channel.status` | live/offline and session state |

The server pings every 30 s and reaps a socket that has not ponged by the next
sweep. Browsers cannot set headers on a WebSocket handshake, so the token
travels as a query parameter — acceptable because these are our own short-lived
tokens, never Twitch's.

### Rate limiting

Per authenticated principal (user or API key), sliding window, `API_RATE_MAX`
requests per `API_RATE_WINDOW_MS` — 300/minute by default. Responses carry
`RateLimit-Limit` and `RateLimit-Remaining`; a 429 carries `Retry-After`.

Keyed on the credential rather than the IP address, because behind Caddy every
request shares one source address: an IP-keyed limiter would either throttle the
whole tenancy at once or trust a header the client controls.

## Documentation

- [`docs/WORK_PACKAGES.md`](docs/WORK_PACKAGES.md) — the Phase 1 plan and its results
- [`docs/PHASE1_DESIGN.md`](docs/PHASE1_DESIGN.md) — the client-server architecture
- [`docs/PHASE1_EVENTSUB_FACTS.md`](docs/PHASE1_EVENTSUB_FACTS.md) — sourced EventSub
  and auth facts the transport is built on
- [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) — pinning policy and the update flow
- [`docs/archive/`](docs/archive) — Phase 0's baseline review, package log, migration
  notes and smoke-test script

## Status

Phase 0 (baseline stabilisation) is complete. The system is single-channel by
design; multi-channel support and a web frontend are later phases.
