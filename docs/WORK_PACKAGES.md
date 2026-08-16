# Work Packages

The living log of lead-issued work packages: spec → engineer completion report → lead verification verdict. Active phase only — completed phases are archived.

**Phase 0 (baseline stabilization) — COMPLETE 2026-08-15, archived to [`archive/PHASE0_WORK_PACKAGES.md`](archive/PHASE0_WORK_PACKAGES.md).** Summary: WP-1..8.2 fixed all 5 P0s + 12 P1s from the baseline review with reintroduction-validated tests; 910 → 1222 tests; CI + Renovate + exact pins; pre-commit and dead code removed. Owner decisions from that era (Option B client-server, pre-commit removal, header retirement) are recorded in the archive and in `PHASE1_DESIGN.md` §8.

---

# PHASE 1 — Client-Server System

Design: `docs/PHASE1_DESIGN.md` (owner decisions locked in its §8: TypeScript, Tauri 2, Hetzner VPS + Docker Compose, signing deferred, shared bot account, DuckDNS to start).

## P1-WP1 — EventSub transport spike  [STATUS: ISSUED 2026-08-15]

**Goal:** lock the Twitch facts before any Phase 1 code. Research-only package — **no repo changes except the deliverable document.** Use current official Twitch documentation (dev.twitch.tv), not memory; cite doc URLs for every load-bearing claim.

**Deliverable:** `docs/PHASE1_EVENTSUB_FACTS.md` answering, with citations:

1. **Transport choice:** webhook vs **conduits** (Twitch's newer transport abstraction) for a small multi-channel server — what conduits actually are, whether they obsolete plain webhooks for our case, and a recommendation.
2. **Auth model per event type we use** (`channel.chat.message`, `channel.channel_points_custom_reward_redemption.add`, `stream.online`, `stream.offline`, `channel.follow`): which token creates the subscription on webhook/conduit transport, which user must have granted which scopes, and specifically how `channel.chat.message` works when the reader is the shared bot account (`user_id` = bot) across N broadcasters.
3. **Limits & costs:** subscription cost model against app access tokens, max_total_cost defaults, per-type costs when authorization exists vs not, webhook callback requirements (TLS, port, verification challenge, HMAC), retry/timeout behavior, and any rate limits on subscription creation.
4. **Chat send path:** confirm the Helix send-chat-message API's auth requirements for a bot sending to N channels (scopes on whose token; any per-channel authorization needed from the broadcaster).
5. **OAuth specifics for our two flows:** authorization-code (server onboarding) and PKCE/device (desktop app sign-in) — current endpoints, refresh semantics, and any Twitch app-registration constraints (redirect URI rules, one client-id vs two for server+app).
6. **Anything that invalidates §2 of the design doc** — called out explicitly with the correction.

**Exit criteria:** the document exists, every claim cited, a clear transport recommendation made, and a short "design corrections" section (empty is a valid finding). Standalone report.

> **Verified by lead 2026-08-15:** both load-bearing claims independently spot-checked (PKCE absence — confirmed, a years-open request on Twitch's own forums; the app-access-token `user:bot`/`channel:bot` "Cloud Chatbot" model — confirmed). Design doc corrected: §2.4 sign-in is now server-mediated auth-code (one client-id, app never an OAuth client); bot-identity simplification flagged to P1-WP3; dual-transport dev-mode question routed to P1-WP5 with deletion of the WS manager as the preferred outcome; onboarding consent = 3 scopes. The scope-hygiene call (single modern scope + empirical check at P1-WP6 rather than over-requesting, citing Twitch's suspension warning) is exactly right. Repo diff confirmed as the single deliverable file.

---

## P1-WP2 — Server skeleton  [STATUS: ISSUED 2026-08-15]

**Goal:** the Phase 1 server exists as a modern TypeScript service that builds, runs, tests, and ships as a Docker image — with zero bot features in it yet. Everything after this lands into a working chassis.

**Scope guard:** additive only. New `server/` and `shared/` workspaces + root workspace wiring + Docker/compose + CI extension. The existing `src/` + `tests/` (the Phase-0 bot) remain untouched and their suite keeps running in CI until modules port over in later packages.

**Lead architecture calls (locked — build to these):**
- **npm workspaces** monorepo: `server/` (the service), `shared/` (types shared with the future app; starts near-empty), root scripts orchestrating both. The legacy bot stays at root `src/` until fully absorbed, then dies.
- **TypeScript strict** (`strict: true`, `noUncheckedIndexedAccess`), ESM, build via `tsc` to `dist/`, dev via `tsx watch`.
- **Vitest** for new-code tests (Jest remains for the legacy suite only; both run in CI; the house reintroduction-validation standard applies in both).
- **pino** for server logging (winston stays legacy-side; structured JSON logs, pretty-print in dev).
- **zod-validated env config**: a `config` module that parses/validates all env at boot and fails fast with a readable report of what's missing — the config.js "control panel" philosophy, typed.
- **express** stays (Phase-0 hardening carries), mounted with `/healthz` + `/readyz` and the graceful-shutdown discipline from Phase 0 (drain, close, exit).

### Tasks

1. Workspace conversion: root `package.json` becomes a workspaces root (existing scripts keep working: `npm test` still runs the legacy suite; add `npm run test:server`, `build`, `dev`). Exact pins + Renovate coverage extend to the new workspaces.
2. `server/`: TS toolchain, strict config, pino logger, zod env config, express app with health endpoints, graceful shutdown, first Vitest tests (config validation matrix, health endpoints, shutdown ordering).
3. `shared/`: package scaffold with a placeholder API-types module consumed by `server/` (proves the dependency path).
4. **Docker:** multi-stage `Dockerfile` (node:24 slim, non-root user, prod deps only), `docker-compose.yml` (server + postgres:17 + redis:7 + caddy with a placeholder Caddyfile), `.dockerignore`. Compose runs locally end-to-end: `docker compose up` → healthy `/healthz`.
5. **CI extension:** typecheck + lint + Vitest for the workspaces alongside the legacy jobs; a `docker build` job proving the image builds on every PR (no registry push yet — deploy workflow arrives with the VPS).
6. ESLint flat config extended with typescript-eslint for the workspaces (same spirit: recommended + our style rules).

### Exit criteria

- `docker compose up` yields a healthy server locally; both test suites + typecheck + lint + image build green in CI; legacy suite untouched at 49/1222.
- Completion report: layout tree, every toolchain version pinned, any deviations flagged.

> **Verified by lead 2026-08-15:** independently ran lint (exit 0), typecheck (clean), legacy suite (49/1222), server Vitest (43), and the compose stack itself — healthy `/healthz` + `/readyz` through Caddy. The Express-5 self-reversal is exemplary deviation handling: flagged going in, reverted on reproducible evidence (two-major hoisting failure), escape path documented for post-absorption. The empty-string env finding is a genuinely valuable class of bug only live containers surface; the schema-level fix (empty ≡ absent, empty-required still fatal, four tests) is the right location. Flags accepted: compose dev-override → first real feature package; `.env.example` → P1-WP6; TLS Caddyfile → VPS provisioning; Express-4/5 types coupling → recorded for Renovate majors.

---

## P1-WP3 — Schema v2 + data layer + migration  [STATUS: ISSUED 2026-08-15]

**Goal:** the multi-tenant PostgreSQL schema exists as versioned migrations, the server can talk to it, the owner's recovered production data imports as channel #1, and the backup/restore guardrails from design §4.1 become real.

**Scope guard:** `server/` + `shared/` + compose (postgres wiring) + scripts + docs. Legacy `src/`+`tests/` untouched (49/1222). The recovered dump at `temp_backups/recovered-backup-2026-01-30.sql` is **read-only input; never print, log, or copy the values in its `tokens` table** — the ETL moves secrets opaquely.

**Lead architecture calls (locked):**
- **Drizzle ORM + `postgres` (postgres.js) driver; drizzle-kit for versioned migrations.** Schema defined in TS under `server/src/db/schema/`, migrations generated and committed; migrations are the only way schema exists (design guardrail 2).
- **Schema v2 per design §2.3:** `channels`, `channel_tokens` (provider ∈ twitch/spotify), `channel_settings`, `bot_identity`, `viewers` (global identity) + `channel_roles`, and channel-scoped `commands`, `emotes`, `quotes`, `song_queue`, `streams`, `chat_messages`, `chat_totals`, `api_usage` (api_type as varchar), `editors` (schema-prep only). Composite indexes led by `channel_id`; FKs with explicit ON DELETE choices (document each).
- **`bot_identity` resolution (the P1-WP1 flag):** decide it here, evidence-first — enumerate every Helix call the bot makes (legacy `twitchAPI.js` is the inventory) against current docs for whose token each requires under the Cloud-Chatbot model. Note `Get Chatters` requires a moderator-scoped **user** token — likely the broadcaster's with `moderator:read:chatters`, which would add a fourth onboarding scope; if so, update design §2.4's consent list and flag it in the report. Shape `bot_identity` (consent record vs stored token pair) from that enumeration, not assumption.

### Tasks

1. **DB client + readyz:** postgres.js client in the server chassis (env-configured via `DATABASE_URL`, least-privilege role in compose init), `/readyz` gains a real postgres probe.
2. **Schema v2** as Drizzle schema + generated migrations; a fresh `docker compose up` + migrate yields the full schema. Document each ON DELETE decision inline.
3. **ETL script** (`scripts/` or `server/scripts/`): reads the Phase-0 MySQL dump via a throwaway mysql:8 container, transforms into v2 (owner's data becomes channel #1; viewers' role flags become `channel_roles` rows; `tokens` rows route to `channel_tokens`/`bot_identity`/`channel_settings` per the §2.3 mapping), loads into Postgres. Idempotent (re-run = clean re-import). Report row counts per table, never values.
4. **Backup pipeline port (guardrail 4):** `pg_dump` → verify (size floor + completion marker, Phase-0 discipline) → S3 script, env-driven, runnable from the server box; wired into compose as a documented manual/cron invocation for now (server-scheduled backups land with ChannelSession work).
5. **CI restore drill (guardrail 5):** a CI job (schedule + manual dispatch + PR-touching-migrations trigger) that spins fresh postgres → runs migrations → seeds sample data → `pg_dump` → restores into a *second* fresh postgres → asserts table counts match. Proves dump/restore tooling continuously without any cloud secrets. (The S3-sourced variant becomes possible once the owner adds AWS secrets to the repo — note it as the upgrade.)
6. **Tests:** migration-applies-cleanly (Vitest against ephemeral postgres via testcontainers or compose service in CI), schema constraint spot-checks (FK cascades, unique constraints, channel-scoping uniqueness like one command name per channel), ETL transform unit tests on synthetic fixture data (never the real dump in tests).

### Exit criteria

- Fresh compose + migrate = full v2 schema; ETL executed locally against the real dump with per-table counts in the report; restore-drill job green; readyz shows the postgres probe; both suites + lint + typecheck green.
- Completion report: schema decisions (esp. ON DELETE table), the `bot_identity` resolution with the Helix-call enumeration, any consent-scope additions, flagged-not-fixed.

> **Verified by lead 2026-08-15 — reproduced from scratch:** fresh postgres → migrations applied → **86/86 server tests green including the 20 schema tests** → ETL executed against the real dump with **identical counts to the report** (idempotency implicitly re-proven — this was a second full run). Legacy 49/1222 untouched. Verdicts on the findings: the 5-scope consent list is approved (both redemption scopes — the non-superset caution is right, collapse at P1-WP6 if proven); **the dashboard-created-rewards refund risk is design-affecting and gets resolved by making "rewards are created by the app at onboarding" the flow** — which also kills reward-title routing (old register item) — verify at P1-WP6; the no-analytics-history finding is surfaced to the owner. The `bot_identity`-as-consent-record resolution is accepted with its evidence table; `channel_tokens` justified by Update-Redemption-Status's user-token-only requirement. Drizzle enum-is-TypeScript-only → CHECK constraints is exactly the WP-7.1 lesson correctly generalized. Flags routed: app-role switch → deliberate task in P1-WP6; S3-sourced restore drill → after owner adds AWS secrets; prod compose override (unpublish 5432) → VPS provisioning; DEPENDENCIES.md count drift → P1-WP4 cosmetic task.

---

## P1-WP4 — ChannelSession core + first domain ports  [STATUS: ISSUED 2026-08-15]

**Goal:** the multi-tenant heart starts beating: a `ChannelSession` with Phase-0-grade lifecycle discipline runs the chat pipeline for N channels against the v2 schema — commands, emotes, quotes, permissions — fed by a fake transport. The remaining domains (AI, songs/Spotify, analytics/viewers) are explicitly OUT — they arrive as P1-WP4.1/4.2/4.3 follow-ups; this package builds the chassis they'll drop into.

**Scope guard:** `server/`, `shared/`, compose dev-override, docs. No real transport (P1-WP5), no Claude client, no Spotify, no analytics pipeline — interfaces/stubs only where the pipeline needs a seam. Legacy untouched at 49/1222.

**Lead architecture calls (locked):**
- **Redis:** ioredis client in the chassis, `/readyz` probe, all keys `ch:{channelId}:…`. Cache manager port keeps the Phase-0 sentinel-miss discipline and the Redis-down fallback guarantee (fallback tests are house law here).
- **Repositories:** Drizzle-backed data access per aggregate (`commands`, `emotes`, `quotes`, `channelSettings`, `channelRoles`) — typed, channel-scoped by constructor, no raw SQL in domain code.
- **Domain ports (TS, Vitest, house validation standard):** permission model (WP-7.1 rank semantics, `channel_roles`-backed), commandManager (registry + declarative handler levels), emoteManager, quoteManager, settings (incl. `aiEnabled` with the fail-closed semantics from WP-6).
- **ChannelSession:** start/stop idempotent, teardown-resilient (runTeardownStep pattern), owns per-channel state only; a `SessionManager` maps channelId → session and boots sessions for all active channels.
- **Chat pipeline:** dedup (from P1-WP1 facts: EventSub message-id) → own-message skip → command dispatch (`!` wins) → emote match → AI-trigger *detection only* (behind an `AiService` interface stub) → analytics *hook* (no-op stub). Fed by a `Transport` interface with a `FakeTransport` test implementation — synthetic EventSub-shaped events drive end-to-end pipeline tests for two channels concurrently, proving tenant isolation (channel A's commands never fire in channel B).
- **Test porting rule:** as each legacy module's behavior is absorbed, port the *behaviors* its legacy tests pinned (not the test files wholesale) into Vitest, and note the mapping in the report. Legacy tests keep running until their module is deleted (later package).

### Tasks

1. Redis client + probe + channel-scoped cache manager (with fallback-mode tests).
2. Repositories + migrations-backed integration tests (TEST_DATABASE_URL pattern from WP3).
3. Domain ports listed above with their Vitest suites.
4. ChannelSession + SessionManager + chat pipeline + FakeTransport, with the two-channel isolation test as the package centerpiece.
5. Compose dev-override (`compose.override.yml`: bind-mount + `tsx watch`) — the WP2 flag lands now; document the dev loop in README.
6. Cosmetic: fix `docs/DEPENDENCIES.md` stale test count (make it non-numeric so it can't drift again).

### Exit criteria

- Two-channel isolation test green; all suites (legacy 49/1222, server incl. schema tests) + lint + typecheck + image build green; dev-override loop documented and working.
- Completion report: per-task summary, legacy-behavior→Vitest mapping table, flagged-not-fixed.

---

## WP-8.2 — First-CI-run warnings  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15]

> Lead verification: 49 suites / 1222 tests green; eslint exit 0 with zero output; all four action call sites on v5; the `cleanupError` fix confirmed in source with both errors carried; `_next` + `argsIgnorePattern` confirmed; no scratch files. The spec's own miss (7 test warnings, not 6) was caught and covered — the "zero annotations" exit criterion did its job. Both Spotify catch-site decisions approved with their rationale (debug-level probe log; documented swallow backed by the WP-5 auth gate). The two unverifiable-locally items (v5 actions against the live runner; Renovate's `github-actions` manager) are correctly scoped as watch-items for the owner's next push and Renovate's first run. Final tally: the pipeline caught a seven-package-old registered bug on its first run, and the fix now carries the regression test that was always missing.

CI's first live run passed but emitted 12 warnings. Clear them all — one is a real bug:

1. **Action versions:** `actions/checkout@v4` and `actions/setup-node@v4` run on the deprecated Node 20 action runtime — bump both to their current major versions.
2. **The real bug — `dbBackupManager.js:82`:** unused `cleanupError` is the baseline review's "failure-cleanup logs the wrong variable" finding (P1 register, agent-2 item 8) still alive: the catch logs the outer `error` instead of the cleanup's own failure. Fix the log to use `cleanupError` (both errors are worth logging — the original and the cleanup failure).
3. **`apiServer.js:48` unused `next`:** Express identifies error middleware by its 4-arg signature, so the param must stay — rename to `_next` and add `argsIgnorePattern: '^_'` (and `caughtErrorsIgnorePattern: '^_'`) to the eslint config so intentional-unused is expressible.
4. **`spotifyManager.js:197,233` unused `error`:** decide per site — if the failure is worth a debug log, log it; if genuinely ignorable, use optional catch binding (`catch {`) with a comment saying why it's safe to swallow.
5. **The 6 test-file unused imports/vars:** delete them.

Exit: CI run with **zero annotations**; suite green; standalone report noting which spotify sites got logs vs. suppression and why.

Three small items, one package, standalone report:

1. **`preserve-caught-error`:** re-enable the rule (delete the disable + its comment) and fix `tokenManager.js:105` to `throw new Error('Unable to load tokens from database', { cause: error })`. Sweep `src/` for any other wrapped-throw sites the rule now flags and fix them the same way. Real diagnostic value on boot failures.
2. **Remove `baseline-browser-mapping`** from devDependencies (unused; accidental explicit install), regenerate lockfile, suite green.
3. **`.gitattributes`:** add `* text=auto eol=lf` (plus `*.png binary`-style entries only if binaries exist in-tree), then run `git add --renormalize .` so the working tree and index agree, and note in the report that the owner's next `git status` may show line-ending-only changes — that's the one-time normalization. This closes the CRLF/`linebreak-style: unix` divergence between Windows checkouts and Linux CI.

**Goal:** every push and PR is automatically tested, dependency versions are exactly pinned, and updates arrive as automated PRs that a human merges. Modern standard: GitHub Actions + Renovate + exact pins + committed lockfile.

**Scope guard:** `.github/` (new), `renovate.json` (new), `package.json` (version pins + `engines`), `.nvmrc` (new), README/docs updates. No `src/` changes.

### Tasks

0. **Remove pre-commit entirely (owner decision).** Delete `.pre-commit-config.yaml` and `.pre-commit-hooks/` (including `check_file_header.py`), and purge every reference to pre-commit from README/docs. Design decisions that follow from this, made fresh rather than inherited: (a) the `// src/<path>` first-line header convention is **retired and removed entirely** (owner decision — it existed to give pre-agentic AI tools file context and is obsolete): delete the first-line path comment and any resulting leading blank line from every `src/` and `tests/` file, mechanically and verifiably — after the sweep, `grep -rE "^// (src|tests)/" src/ tests/` must return zero hits and no file starts with a blank line; suite green after the sweep; (b) lint enforcement lives in CI only (task 1); (c) no code formatter is introduced now — retro-formatting 8K lines of stable code is churn without benefit; Prettier (or Biome) gets adopted for the Phase 1 server codebase, where new code starts clean. Task 9 of WP-7 (pre-commit eslint pin alignment) is void — superseded by task 0b below.
0b. **ESLint modernization.** Upgrade to current ESLint v9 with flat config (`eslint.config.js`), migrating the rules from `.eslintrc.json` (keep the same effective ruleset — this is a tooling upgrade, not a style change; add rule changes only where v9 forces them, and list any in the report). Delete `.eslintrc.json`. `npx eslint src/ tests/` must pass clean.
1. **GitHub Actions CI** (`.github/workflows/ci.yml`): on push + PR to `main` — checkout, `actions/setup-node` reading `.nvmrc`, `npm ci`, `npx eslint src/ tests/`, `npm test`. Add `.nvmrc` with the current LTS major (owner runs Node 24 locally — pin `24`), and an `engines.node: ">=24"` field in package.json.
2. **Exact version pins.** Applications pin exact; libraries use ranges. Convert all `dependencies` and `devDependencies` from `^x.y.z` to `x.y.z` (the versions currently resolved in the lockfile, not the latest), regenerate the lockfile with `npm install`, confirm suite green. Renovate owns upgrades from here.
3. **Renovate config** (`renovate.json`): extend `config:recommended`; `rangeStrategy: "pin"`; group all non-major updates into one weekly PR (`schedule: before 9am on monday`); major updates as separate PRs; `lockFileMaintenance` enabled monthly; **no automerge anywhere** (owner merges manually — CI green is the review signal); labels `dependencies`. Add a short `docs/DEPENDENCIES.md` explaining the flow: Renovate opens PR → CI runs the 1204-test suite against the bump → owner merges when green.
4. **Security floor:** `npm audit --audit-level=high` as a CI step (separate job, so an upstream advisory doesn't block unrelated PRs — it fails visibly instead).
5. **Owner-action documentation:** Opus cannot install GitHub Apps. The report must list the two owner clicks: enable Actions if prompted, and install the Renovate GitHub App (https://github.com/apps/renovate) scoped to this repo — with Dependabot (`.github/dependabot.yml`) named as the zero-install fallback if the owner prefers GitHub-native.

### Exit criteria

- Suite green locally after pinning; workflow + renovate config lint-valid (`npx renovate-config-validator` if available offline, else state it needs the app's first run to validate).
- Completion report: per-task summary, the exact owner-action list, flagged-not-fixed discoveries.

> **Verified by lead 2026-08-15:** legacy 49/1222; server **206/206** including schema/repo suites against live postgres (first runs exposed cold-start races — the DB container being absent/warming produced 2 suite failures that vanish once postgres is ready; routed to P1-WP5 as a test-bootstrap readiness wait). Lint 0, typecheck clean. The channel-bound-repository pattern (isolation as a property of the type) and the two-routing-checks belt-and-braces are endorsed; the FOR-UPDATE-with-aggregate catch is a real find proving the concurrency tests earn their keep; the fail-open rationale carried forward in comments is exactly how decided-questions travel. Flags routed: composition-root wiring + Redis probe → P1-WP5 (as designed); quote/emote unit depth + silent unknown-handler no-op (upgrade to error-level log w/ channel context) → P1-WP4.2; touchPresence caller → P1-WP4.3.

---

## P1-WP5 — EventSub webhook transport + composition root  [STATUS: ISSUED 2026-08-15]

**Goal:** the server hears Twitch. Webhook ingest lands (HMAC, challenge, dedup, enqueue-and-ack), the composition root wires config → postgres → redis → SessionManager → transport into a bootable whole, and dev-mode eventing is solved — with the Twitch CLI investigation deciding whether a second transport ever exists.

**Scope guard:** `server/`, `shared/`, compose/Caddy, CI, docs. No OAuth flows and no live Twitch calls (P1-WP6 brings tokens; everything here is testable with signed synthetic payloads). Legacy untouched at 49/1222.

**Lead calls (locked):**
- **Webhook handler per P1-WP1 facts:** raw-body preservation (`express.json({verify})`) for HMAC-SHA256 over id+timestamp+body with timing-safe compare; challenge echo; 10s-timestamp-skew rejection (replay guard); **enqueue-and-ack** — handler returns 2xx immediately, an in-process queue worker dispatches to SessionManager; revocation messages handled (mark channel state, loud log).
- **Subscription manager v2 (interface + dry-run):** reconciliation model — desired subs per active channel vs actual (list), create-missing/delete-orphaned — implemented against a `HelixClient` interface with a fake; the real client activates in P1-WP6 when tokens exist.
- **Outbound seam:** a `ChatSink` interface (the pipeline's reply path); implementation is a structured-logging fake until P1-WP6's Helix sender.
- **Dev-mode decision (the P1-WP1 flag):** investigate the Twitch CLI (`twitch event`) — if it can deliver signed synthetic events to the local webhook (it documents exactly this), it becomes the dev loop, documented in README, and **no websocket transport is ever built for the new server** (the legacy WS manager dies with the legacy bot). If the CLI proves inadequate, report back with evidence before building anything.
- **Composition root:** index.ts boots config → db (+migrate check) → redis → SessionManager (bootstrapping all active channels from `channels`) → transport → readyz probes for postgres AND redis; graceful shutdown drains the ingest queue, stops sessions (Phase-0 ordering discipline).
- **Test-bootstrap readiness:** DB-dependent Vitest suites wait/retry for postgres readiness (bounded) instead of failing on cold stacks — kills the race the lead hit during WP4 verification.

### Tasks
1. Webhook endpoint + HMAC/challenge/skew/dedup + enqueue-and-ack + revocation handling, with a signed-payload test helper (shared with the CLI dev loop).
2. In-process ingest queue with drain-on-shutdown and per-event error isolation (one bad event never stalls the queue).
3. Subscription reconciler against fake HelixClient (create/delete/diff matrix tests).
4. ChatSink seam + logging implementation; pipeline replies flow to it end-to-end.
5. Composition root wiring + readyz (postgres+redis) + boot-from-DB channel bootstrapping + shutdown ordering tests.
6. Twitch CLI investigation → README dev-loop docs (or evidence-backed alternative proposal).
7. Test-bootstrap DB readiness wait.

### Exit criteria
- `docker compose up` boots the full wired server; a signed synthetic `channel.chat.message` posted to the webhook produces a command response at the ChatSink (logged), end-to-end, for two channels; suites/lint/typecheck/image green; dev loop documented.
- Completion report: per-task, the CLI verdict with evidence, flagged-not-fixed.

> **Verified by lead 2026-08-15:** legacy 49/1222; server **327/327 against a Postgres started 3s prior** — the advisory-lock diagnosis (concurrent Vitest workers migrating a cold DB, not warmup) is a genuinely better root cause than the readiness-wait I asked for, and fixing it in `runMigrations` protects real replica boots, not just tests. Live exit criterion reproduced by the lead personally: compose up → `/readyz` both probes green → signed synthetic `!seed` for broadcaster 900000001 → **CHAT SEND at the sink**, with unknown-broadcaster and unknown-command paths behaving correctly along the way. The 600s-skew deviation is approved (Twitch's documented figure; dedup is the replay defense — a 10s window would reject legitimate redeliveries; my spec number was wrong). The Twitch CLI verdict is accepted: no chat-message trigger → repo-local signer as primary dev loop, CLI as complement, no second transport built — the load-bearing outcome. The honesty items (timingSafeEqual unobservable by test; two tests initially green for wrong reasons, caught by reintroduction) are the standard working as designed. Flags routed: revocation recovery + subscription pacing + shared-chat routing live check → P1-WP6; persistent webhook dedup accepted (session layer is the second belt); tsx-watch SIGTERM accepted as dev-only.

---

## P1-WP6 — Twitch auth, tokens & live activation  [STATUS: ISSUED 2026-08-15]

**Goal:** the server talks to real Twitch. OAuth onboarding, encrypted token storage, a real HelixClient, live subscriptions, and a real chat send — ending with the bot speaking in the owner's channel from the new stack. First package with live-Twitch steps: implementation lands against mocks first; a **live activation phase** then runs with owner-supplied credentials.

**Scope guard:** `server/`, `shared/`, compose/env docs. Legacy untouched (49/1222). No desktop app; no `/api/v1` resources beyond auth machinery + a `/me` stub (P1-WP7). **Never log or echo token values, client secrets, or auth codes — anywhere, including errors.**

**Lead calls (locked):**
- **Token crypto:** refresh/access tokens in `channel_tokens`/`bot_identity` encrypted at rest — AES-256-GCM (node crypto), key from `TOKEN_ENCRYPTION_KEY` (32-byte, env; documented in `.env.example`, which lands in this package). One-time upgrade script encrypts the rows the ETL imported. Key absence = boot refusal in production mode.
- **HelixClient (real):** app-token via client-credentials (cached, single-flight refresh, 401-retry-once); user-token refresh with Phase-0 semantics ported (expiry-based, atomic persist, loud MANUAL-REAUTH error class); endpoints: send chat message, get users/streams/channel info, get chatters, custom-rewards CRUD, update redemption status, EventSub sub CRUD. Basic 429 handling (respect Ratelimit-Reset; no thundering retries). Subscription creation pacing (the WP5 flag): simple spacing under the 100/min budget.
- **OAuth onboarding:** `/auth/twitch/connect` → consent (5 scopes from P1-WP3) → callback with `state` CSRF → upsert channel + encrypted tokens → **live per-channel reconcile**. Separate bot-identity consent route (bot's 3 global scopes). Reconciler gains live mode behind `EVENTSUB_DRY_RUN=false` + `PUBLIC_URL`-derived callback.
- **App sign-in machinery:** same server-mediated flow with identity-only scope → our JWT (short-lived) + refresh token; JWT middleware + `/api/v1/me` stub proving it. (Full API is P1-WP7.)
- **ChatSink (real):** Helix send-chat-message implementation; the empirical `user:write:chat` vs `chat:edit` check happens here and gets recorded in EVENTSUB_FACTS.
- **Revocation recovery (WP5 flag):** per-subscription handling — on revocation, one delayed resubscribe attempt; on failure, channel marked needs-reauth with a loud log. Per-subscription, not per-channel.
- **App-role switch (WP3 flag):** runtime connects as `almosthadai_app`; migrations keep the owner role. Documented.

### Live activation phase (owner + engineer together, after implementation lands)
Owner actions, in order — the report includes this as a fill-in checklist:
1. Register a Twitch application (dev.twitch.tv console): redirect URI `http://localhost:3000/auth/twitch/callback` (this empirically settles the P1-WP1 redirect-rules unknown); obtain client id + secret → `.env` (never committed).
2. Generate `TOKEN_ENCRYPTION_KEY` (command provided in `.env.example`).
3. Visit the bot-consent URL logged at boot, signed in as the bot account (`almosthadai`) → grants the 3 bot scopes.
4. Visit the channel-connect URL signed in as the owner (`aimosthadme`) → 5-scope consent → channel onboards live.
5. Engineer verifies: live subscriptions created (list them), a real chat message sent by the bot into the owner's channel via the new stack, the scope question settled empirically, one app-created test reward + redemption-status update proving the refund path (the P1-WP3 dashboard-rewards risk), and the shared-chat routing check if feasible.

### Exit criteria
- Mocked suites green (both stacks, lint, typecheck, image); live activation executed with evidence in the report (log excerpts with secrets redacted); EVENTSUB_FACTS updated with every empirical answer; any design deltas called out.
- Completion report: per-task, the owner checklist with what happened at each step, flagged-not-fixed.
