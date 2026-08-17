# Phase 1 Design — AlmostHadAI as a Client-Server Product

**Date:** 2026-08-15
**Author:** Lead (Fable 5)
**Status:** DRAFT — pending owner decisions (§8) before implementation packages are cut
**Prerequisite reading:** `BASELINE_REVIEW.md` (what the bot is), `WORK_PACKAGES.md` (what Phase 0 made true)

---

## 1. What we are building

**Owner decision (recorded in WORK_PACKAGES.md):** Option B — client-server. The bot becomes a **hosted multi-tenant service**; users run a **Windows desktop application** that they download, install, and receive real version upgrades through. The product experience to beat: "my friend installs a legit app, signs in with Twitch, and his channel has the bot."

Two people are the launch audience. The architecture should be *honest multi-tenant* (nothing hardcoded to one channel) but *sized small* (one server process, one box, single-digit channels). We are not building Nightbot-scale infrastructure for two users; we are building a clean shape that could grow.

```
┌─────────────────────────┐          ┌──────────────────────────────────────────┐
│  Desktop App (Windows)  │          │              Server (Docker)             │
│  Tauri shell + web UI   │◄──HTTPS──┤  API (Express): auth, config, analytics  │
│  - Twitch sign-in       │   +WS    │  Realtime: live chat/event feed to app   │
│  - manage commands,     │          │  Bot Core: N channel sessions            │
│    quotes, emotes, AI   │          │   ├─ EventSub ingest (all channels)      │
│  - song queue view      │          │   ├─ per-channel handlers/state          │
│  - analytics dashboards │          │   └─ shared: AI, Spotify, analytics      │
│  - auto-update, crash   │          │  PostgreSQL ─ Redis ── S3 backups        │
│    reporting            │          └────────────┬─────────────────────────────┘
└─────────────────────────┘                       │ EventSub (webhook), Helix,
                                                  │ Claude API, Spotify API,
                                                  ▼ Discord webhooks
```

---

## 2. Server: multi-tenant core

### 2.1 Tenancy model

- One Node process serves N channels. A **`channels`** table is the tenant root; every tenant-scoped table gains a `channel_id` FK. A `ChannelSession` object per channel owns what `bot.js` owns today for one channel: lifecycle state (live/offline), handlers, per-channel caches, timers.
- The Phase-0 composition root splits in two: a **server shell** (boots infra: DB pool, Redis, API, EventSub ingest) and **`ChannelSession`** (per-tenant lifecycle). Phase 0's teardown/rollback discipline maps directly onto session start/stop — that work was the rehearsal for this.
- **Concurrency stance:** shared-nothing between sessions except infra clients. No cross-channel state anywhere. Redis keys become `ch:{channelId}:…`. The stream-scoped structures (rate limits, seen-chatters) already key by stream id; they gain the channel prefix.

### 2.2 EventSub transport: webhook, not per-channel websocket

Today: one websocket, subscriptions for one broadcaster. Websocket transport caps subscriptions per connection and ties awkwardly to user tokens; it is the right shape for a bot running next to one streamer, the wrong one for a hosted service.

**Design direction:** move ingest to **EventSub webhooks** — one HTTPS callback endpoint, app-access-token subscriptions, per-broadcaster authorization granted during onboarding OAuth, HMAC signature verification, and Twitch-side retry. This is the standard server-app shape and scales per-channel with no connection bookkeeping.

- Phase 0's dedup work carries over directly (webhooks are also at-least-once; `Twitch-Eventsub-Message-Id` replaces the WS message id).
- The WS manager doesn't die: it remains the **dev-mode transport** (webhooks need a public URL; developers get `npm run debug` without a tunnel). The ingest layer gets a transport interface with two implementations.
- ✅ **Verified by P1-WP1** (`PHASE1_EVENTSUB_FACTS.md`, lead spot-checked): plain webhook confirmed — conduits are a sharding wrapper whose value starts at >1 server instance (graduation trigger recorded there); Twitch documents our exact shared-bot architecture ("Cloud Chatbot": app access token subscribes AND sends; `max_total_cost` 10,000 with authorized subs costing 0 — vs the websocket transport's cap of 10, which is why today's transport could never host a service). Webhook handler rules for P1-WP5: preserve the raw body for HMAC, enqueue-and-ack (never process inline).
- ⚠️ **Dev-mode transport under review (P1-WP5):** keeping the WS manager as a second ingest implementation is permanent maintenance on exactly the code that produced P0-1/P0-2; if a dev tunnel or the Twitch CLI's EventSub mocking (unverified) covers local dev, the websocket manager is deleted outright and one implementation serves both.

### 2.3 Schema v2

Principles: every tenant table gets `channel_id`; per-channel Twitch attributes stop pretending to be global; the key-value junk drawer is dissolved.

| Today | v2 |
|---|---|
| `tokens` key/value singleton (bot + one broadcaster + Spotify + Claude key + app settings) | `channels` (id, twitch_broadcaster_id, name, status…); `channel_tokens` (channel_id, provider ∈ twitch/spotify, access, refresh, expires_at); `bot_identity` (the shared bot account's token pair); server secrets (Claude key, app secret) move to **environment/secret store, not the DB**; per-channel settings (`aiEnabled`, Discord webhook URL, cooldowns) → `channel_settings` |
| `commands`, `emotes`, `quotes`, `song_queue`, `streams`, `api_usage`, `chat_messages`, `chat_totals` global | same tables + `channel_id` FK (+ composite indexes led by `channel_id`) |
| `viewers` with global `is_mod/vip/sub` flags | `viewers` global identity (twitch user id, username) + `channel_roles` (channel_id, user_id, role flags) — roles are channel-relative on Twitch and finally modeled that way |
| `api_usage.api_type ENUM('claude')` | `VARCHAR` — closes the old register item |

Migration: a v2 migration script imports the existing single-channel data as channel #1 (the owner's). The restored dump becomes tenant one, nothing is lost.

### 2.4 Identity & auth

Three distinct auth problems, kept separate:

1. **Channel onboarding (broadcaster → server):** Twitch OAuth authorization-code flow against the server's redirect URI. Grants the scopes EventSub needs for that channel and yields the broadcaster token pair → `channel_tokens`. Spotify connect is the same pattern per channel, optional.
2. **App sign-in (user → API):** *(corrected per P1-WP1 — Twitch does not support PKCE)* **server-mediated authorization code:** the app opens the system browser to OUR server's sign-in endpoint; the server runs the confidential-client auth-code flow with Twitch, verifies identity, and hands the app only our own short-lived **JWT + refresh token** for API/WS calls. The desktop app is not an OAuth client at all and never talks to id.twitch.tv — one Twitch client-id total, and the design goal (app holds no Twitch tokens) is preserved outright. (Device-code grant rejected: its one-time-use refresh tokens die after 30 idle days, signing out any user who skips a month.)
3. **Bot identity (shared):** the `almosthadai` account authorizes `user:read:chat`/`user:write:chat`/`user:bot` once, globally. *(P1-WP1 flag, resolved in P1-WP3:)* the hot path runs on an **app access token** — chat reads and sends alike — so `bot_identity` may reduce to a consent record rather than a live rotating token pair; Phase 0's refresh machinery ports only if a genuinely user-token-only call remains.

**Onboarding consent (per P1-WP1):** a channel grants three scopes — `channel:bot`, `channel:read:redemptions`, `moderator:read:followers` (follow events v2 require the broadcaster-as-moderator condition). `stream.online`/`offline` need no authorization at all.

Authorization model at launch: a channel has one owner; owner-only access. An `editors` table is schema-prepped but no UI (Phase 2+).

### 2.5 API surface

Express stays (Phase 0 hardened it). Versioned REST under `/api/v1`, JWT-authenticated, channel-scoped by the token's claims:

- `channels/me` — settings (AI toggle, cooldowns, Discord webhook, feature flags)
- `commands`, `emotes`, `quotes` — CRUD (replaces `!command add` chat syntax as the primary interface; chat syntax remains)
- `songs` — queue view, skip, toggle (the old Stream Deck endpoints become authenticated API routes; a Stream Deck can call them with an API key scoped to the channel)
- `analytics` — per-stream and lifetime summaries powering the dashboards
- `auth` — sign-in, refresh, Twitch/Spotify connect flows
- **Realtime WS** (`/api/v1/live`): server→app event feed (chat lines, redemptions, queue changes, bot status) so the app feels live; app→server for nothing critical (all writes via REST).

### 2.6 What survives Phase 0 (most of it)

Handlers, managers, permission model, AI stack, Spotify/queue logic, analytics pipeline, dedup, token lifecycle, the entire test discipline — survive with channel-scoping threaded through. `bot.js` is the one file that dissolves (into server shell + ChannelSession). The 1222-test suite migrates incrementally; the reintroduction-validation standard stays house law.

---

## 3. Client: Windows desktop app

- **Shell — recommendation: Tauri 2.** Installer measured in MB not hundreds, memory-light, Rust core with a system webview, first-class **NSIS/MSI installers**, built-in **updater** (signed updates pulled from GitHub Releases), and an active modern ecosystem. Electron is the fallback if a webview quirk bites; the UI layer is identical either way, so the bet is cheap to reverse early. *(Owner decision §8.2.)*
- **UI stack:** React + TypeScript + Vite inside the shell. UI design itself is a later collaboration (owner + Claude design tools); this document only fixes the stack and the screen inventory.
- **MVP screens:** Sign in with Twitch · Dashboard (bot status, live indicator, recent events feed) · Commands / Emotes / Quotes CRUD · Song queue (view, reorder later, skip, toggle) · AI settings (on/off, rate limits view) · Analytics (per-stream + lifetime) · Settings (Discord webhook, Spotify connect, updates, bug report).
- **Requests-playlist feature (owner-elevated to core, 2026-08-16):** the streamer can toggle "save requested songs to a playlist"; when on, they name a playlist — if it exists songs are appended (DB-side dedup), if not it is created for them where the API allows, and if creation isn't possible the step is skipped gracefully. Owner: "important to me and my community." Foundation (append + dedup, default playlist) ships in P1-WP4.3; the toggle/naming/creation UX ships with the app settings screen — this bullet is the requirement of record for the UI functionality inventory.
- **UI design workflow (owner-defined):** **Claude Design owns the visual/UX design.** At the P1-WP8/9 boundary the lead produces a **functionality inventory** in `docs/` — the complete, design-agnostic catalog of what the UI must surface (every entity, action, state, and live signal, grounded in the real API) — and the owner points a Claude Design session at the repo. Claude Design iterates a design handoff with the owner; the owner commits it; the lead reviews it for groundedness against the actual API/data model, then routes it to the engineer (as-is, edited, or re-specced — lead's call). Three roles: lead orchestrates and grounds, Claude Design designs, engineer implements.
- **Distribution & updates:** GitHub Releases as the artifact store; CI builds and signs the installer on tag push; the Tauri updater checks Releases and self-updates. Version = git tag. This gives "real version upgrades" with zero hosting beyond the repo. Code-signing certificate is an owner purchase decision (unsigned builds trip SmartScreen; acceptable for two users initially — flagged, not forgotten).
- **Crash & bug reporting:** **Sentry** on both server and client (free tier fits). In-app "Report a bug" composes a GitHub issue (via server proxy) with app version, OS, and recent breadcrumbs attached — never secrets.

---

## 4. Infrastructure

- **Packaging:** server ships as a **Docker image** (Node 24 LTS base); `docker-compose.yml` runs server + PostgreSQL + Redis for both production and local dev. This is the "get the environment right for prod" answer: the runtime is frozen in the image.

### 4.1 Database plan — "on the box, built like it's remote" (owner-approved)

**Engine: PostgreSQL 17** (owner-approved switch from MySQL, executed as part of the schema-v2 rewrite — the only cheap moment to change engines). Query layer: Drizzle (SQL-first TS standard; specced concretely in P1-WP2/3). The old MySQL dump is imported via a throwaway MySQL container feeding the v2 migration ETL.

**Tier 0 (launch, $0/mo):** Postgres runs in the Compose stack on the VPS. Six guardrails, enforced from the first Phase 1 code, make the DB location-agnostic:
1. The app knows only `DATABASE_URL` from the environment — no locality assumptions, TLS-ready.
2. Schema exists solely as versioned Drizzle migrations in git — reproducible on any Postgres anywhere.
3. App connects as a least-privilege role, never superuser.
4. Verified `pg_dump` backups to S3 (Phase-0 pipeline adapted; hourly during streams) — the backup artifact IS the migration vehicle, and also the teardown/resurrection vehicle (runbook: new box → compose up → restore dump).
5. **Automated restore drill:** a scheduled CI job restores the latest S3 dump into a fresh Postgres container — backups are proven restorable continuously, not discovered broken in a crisis.
6. Pooling discipline (Phase-0 pool carried forward) so managed poolers slot in without code changes.

**Tier 1 (graduation, ~$19–25/mo, only when triggered):** dump → restore to a managed Postgres (provider chosen at that time) → flip `DATABASE_URL` → rotate creds. Zero code changes, <1 hour, restore path pre-rehearsed by guardrail 5. **Triggers (any one):** first paying user · any user beyond owner+friend · public promotion begins · DB outgrows the box (multi-GB / sustained load).

**Tier 2 (replicas/HA/regions):** deliberately undesigned — it arrives with revenue and is the managed provider's product; guardrails 1–6 are all it needs from us today.
- **Hosting — recommendation: one small VPS** (t4g/Lightsail/Hetzner-class, ~$5–12/mo) running compose, with the existing S3 bucket for backups (Phase 0's verified-backup pipeline pointed at the new DB). Rationale: two users, lowest cost, no platform lock-in, and the webhook endpoint needs is just HTTPS — Caddy/Traefik terminates TLS with Let's Encrypt. Managed alternatives (Fly.io, Railway, ECS) are listed as scale-up paths, not launch choices. *(Owner decision §8.3.)*
- **CI/CD extension:** existing CI stays the merge gate; a `deploy` workflow builds/pushes the server image on tag and deploys to the VPS (SSH or watchtower-style pull); a `release-app` workflow builds the signed Windows installer on tag. Renovate now also watches the Dockerfile base image.
- **Secrets:** server secrets live in the deploy environment (compose `.env` on the box, never in git); the desktop app holds no long-lived secrets at all.

---

## 5. Language decision: TypeScript

**Recommendation: yes — TypeScript for all new/rewritten server code and the client from day one**, with `allowJs` so surviving Phase-0 modules migrate opportunistically rather than in a big bang. Rationale: the owner has explicitly chosen "production web application, modern best practices, unafraid of rewrites"; the client stack (React/Tauri tooling) is TS-native anyway; and the API boundary (server↔client) is exactly where shared type definitions pay for themselves (one `@almosthadai/shared` types package, consumed by both sides). Cost: some churn migrating tests; mitigated by incremental adoption. *(Owner decision §8.1.)*

---

## 6. What dies, deliberately

- The 30-minute auto-shutdown and "minimal mode" process exits — a hosted server runs continuously; sessions go dormant, the process doesn't exit.
- The loopback-only API server as a concept — superseded by the real authenticated API (Stream Deck use-case preserved via scoped API keys).
- Reward-title-string redemption routing — replaced by reward IDs captured at onboarding (the old register item, finally in scope).
- The config.js "developer interface" for per-channel behavior — per-channel knobs move to `channel_settings` (edited in the app); config.js keeps only deployment-level knobs.
- `debugDbSetup`'s copy-the-prod-DB approach — dev environments come from compose + seed scripts.

---

## 7. Sequencing (implementation packages, once decisions land)

| # | Package | Contents |
|---|---|---|
| P1-WP1 | **EventSub spike** | Verify webhook/conduit facts, scopes, limits; one-page addendum. Blocks nothing else. |
| P1-WP2 | **Server skeleton** | TS toolchain, Docker/compose, server shell, config split, CI deploy workflow |
| P1-WP3 | **Schema v2 + migration** | New schema, migration script importing the Phase-0 dump as channel #1, data-layer ports |
| P1-WP4 | **ChannelSession port** | bot.js dissolution; handlers/managers threaded with channel scope; test migration begins |
| P1-WP5 | **EventSub webhook ingest** | Transport interface, webhook endpoint + HMAC + dedup, WS transport kept for dev |
| P1-WP6 | **Auth** | Onboarding OAuth (Twitch + Spotify), app sign-in (PKCE→JWT), bot identity port |
| P1-WP7 | **API v1 + realtime** | REST resources, WS live feed, Stream Deck API keys |
| P1-WP8 | **Client shell** | Tauri app, sign-in flow, updater pipeline, Sentry, bug report; first installable build |
| P1-WP9+ | **Client screens** | Iterative UI packages (design collaboration with owner) |

Phase 0's process carries over unchanged: specs in `WORK_PACKAGES.md` style, scope guards, completion reports, lead verification, reintroduction-validated tests.

---

## 8. Owner decisions — LOCKED 2026-08-15

1. **TypeScript: YES** — server rewrite + client from day one, `allowJs` incremental migration for surviving Phase-0 modules.
2. **App shell: Tauri 2** — decided after full Electron comparison (Windows-only thin client running beside games is Tauri's home-turf profile; Electron's strengths — bundled Node, cross-platform rendering consistency — are irrelevant to this app). Auto-update via Tauri's built-in updater against GitHub Releases; app dependencies tracked by Renovate like everything else.
3. **Hosting: Hetzner VPS** — provisioned 2026-08-15: **CX23** (Cost-Optimized x86, 2 vCPU/4GB/40GB, Falkenstein) at **$7.09/mo all-in** ($6.49 server + $0.60 IPv4; 2026 console pricing — the research-era "$4.59 CX22" figure was stale, and the premium CPX tier the console defaults to costs $23/mo: always select Cost-Optimized). Docker Compose on the box, S3 (existing AWS bucket) for backups. Still decisively cheaper than Lightsail at equal RAM. AWS familiarity held zero weight per owner.
4. **Code signing: DEFERRED** — unsigned installer, SmartScreen one-time click accepted for a two-person audience. Tauri's own update signing (independent of Windows code signing) keeps auto-updates cryptographically verified regardless. Revisit at the third user.
5. **Bot account model: single shared `almosthadai`** (lead default, not vetoed) — one bot identity chatting in all channels.
6. **Domain: start with a free DuckDNS subdomain** (`*.duckdns.org` + Let's Encrypt satisfies Twitch webhook/OAuth HTTPS requirements); real domain is a later cosmetic upgrade — config swap + redirect-URI re-registration in the Twitch/Spotify dashboards.
7. **Database engine: PostgreSQL** — switched from MySQL as part of the schema-v2 rewrite (§4.1).
8. **Database hosting: Tier plan per §4.1** — on the box at $0 with the six location-agnostic guardrails; managed graduation pre-planned with explicit triggers; no enterprise spend until a trigger fires.

## 9. Risks, open items & tracked future work

**Tracked future work (owner-deferred, must never be forgotten):**
- **`chat_messages` retention/pruning — deferred by owner 2026-08-16.** Unbounded growth is accepted at two-streamer scale. Implement a rolling window (90 days was the lead's proposal) when growth actually matters: trigger = multi-GB table size or query slowdown. Aggregates (`chat_totals`, `streams`, `viewing_sessions`) are permanent regardless.
- **Queue-truth reconciliation for UI song-queue manipulation (owner idea, recorded 2026-08-17).** When the app grows queue *editing* beyond today's view/drop/skip (reordering was always "later" in §3), every Spotify-facing mutation should verify the external state around the change — the owner's "double confirmation": what the app shows must match what Spotify holds. The instinct is proven right by three shipped bugs of exactly this class (the 2xx-non-JSON false failure that queued one track four times; the 404-on-write-as-success that silently lost a song; the reconciler failing to recognize its own subscription). Refinement required at build time: naive read-after-write against Spotify races its propagation delay and would produce false alarms — the correct shape is verify-with-tolerance/converge, the same pattern the EventSub reconciler already uses (desired vs actual, bounded retry). Notes for that day: the current design minimizes divergence deliberately (only one track in flight to Spotify inside the 10s advance window; the bot's own queue is sole truth for waiting songs, so reorders need no Spotify check at all); Spotify's read-the-queue endpoint must be verified against current docs (it was not among the five calls checked in the 2026 endpoint-removal review); the playback monitor's periodic re-read is today's convergence mechanism and the seam to extend.

- **EventSub facts** are stated as design direction, not verified fact — P1-WP1 exists precisely to de-risk this before code.
- **Twitch app review/limits** for a public-ish redirect URI and webhook endpoint — verify in P1-WP1.
- **Spotify per-channel OAuth** requires each streamer to have Premium and to authorize; the auth-dead gate from Phase 0 already handles the failure mode.
- **Spotify platform lockdown (recorded 2026-08-16):** per Spotify's Feb/Jul 2026 policy changes, our app runs in Development Mode — the **app owner's Premium subscription is load-bearing** (lapse = API access dies for all channels), non-owner users must be allowlisted in the dashboard (add the friend's Spotify account at onboarding), and **extended quota now requires a registered business with 250k MAU** — meaning the songs feature CANNOT scale to public users under current policy. If the subscription-product future arrives, the industry-verified answer (2026-08-16) is the **hybrid**: our app serves the allowlist's worth of early users frictionlessly; beyond that, onboarding grows a guided **bring-your-own-Spotify-app wizard** (each streamer creates their own dev app — they're then their own app's Premium-holding owner and the 5-user cap is moot). This is what the post-lockdown ecosystem converged on (Songify's "Use Own AppID", MarcDonald's bot, Streamer.bot integrations); managed services doing it centrally run on grandfathered/business extended quota unavailable to new entrants. Spotify offers NO programmatic app creation — BYO is always a human dashboard task, which the desktop app can make tolerable (screenshots + paste + validate). Per-channel Spotify client credentials = small schema addition when needed. Invariant in every model: each streamer needs their own Premium (Spotify's playback rule, not ours). Decision still deferred until that future is real. Our five API calls (track lookup, queue add, playback state, skip, playlist add) are believed to survive the 2026 endpoint removals — verified against the migration guide during P1-WP4.2's client evaluation.
- **The friend's onboarding** is the real acceptance test of everything in §2.4 — the first end-to-end demo target should be "second channel onboards without the lead or engineer touching anything."
- The deferred pre-first-live smoke test folds into Phase 1's own verification: the server's first live run against a real channel supersedes `SMOKE_TEST.md` §1–8 in a dev-channel form.
