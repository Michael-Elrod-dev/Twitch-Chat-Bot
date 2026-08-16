# AlmostHadAI — Baseline Review & Project Briefing

**Date:** 2026-08-15
**Author:** Lead (Claude Fable 5) — architectural review conducted via full source read + three subsystem review passes + full test-suite run
**Audience:** The implementation engineer (Opus) working in this repository, and the project owner
**Status of codebase at review time:** branch `main`, commit `7443c7c`, working tree clean, dormant since 2026-01-31. Nothing is deployed or running.

---

## 0. How this project works (read first)

You (Opus) are the implementation engineer. A separate conversation holds the lead (Fable 5), who wrote this document. The project owner relays messages between the two conversations by copy-paste; neither AI sees the other's conversation. Both of us have access to this same repository, so shared state lives in files — primarily `docs/`. When you finish a work package, write a completion summary the owner can relay back for verification.

Working agreement:

1. **Baseline first.** The current mission is to prove/repair the existing system, not extend it. Do not add features, new commands, new services, or speculative abstractions. If a fix genuinely requires a design decision beyond what's written here, stop and ask (via the owner) instead of improvising.
2. **The test suite is the safety net.** 35 suites / 910 tests, all passing as of this review (`npm test`, ~9s, fully mocked — no live DB/Redis needed). It must stay green. Fixing a bug means also fixing/adding the tests that should have caught it.
3. **Respect the house style.** *(Partially superseded by WP-8: the `// src/<path>` header convention and the pre-commit hook were both retired — see `WORK_PACKAGES.md` WP-8 task 0. The rest stands.)* Manager classes, dependency injection through `bot.js`, `// src/<path>` first-line header comments (enforced by a pre-commit hook that auto-fixes), winston logging with `logger.info('ModuleName', 'message', {meta})`. Config knobs live in `src/config/config.js` — the owner treats that file as the developer's control panel; keep it that way.
4. **Don't touch:** `.env` (not in repo), `twitch-bot-key.pem` (legacy EC2 SSH key sitting untracked in the root), anything under `node_modules/`, `temp_backups/` (mysqldump staging dir).

---

## 1. What this project is

A single-channel Twitch chat bot for the channel `aimosthadme`, bot account `almosthadai`. Node.js (CommonJS, no TypeScript), started via `npm start` (`node src/bot.js`) or `npm run debug` (`--debug` flag → separate `<DB_NAME>_debug` database, forced full operation, separate log file). Historically ran continuously on an EC2 instance; nothing runs today.

**Feature set:** AI chat responses via the Claude API (mention-triggered, plus `!ai`, `!advice`, `!roast` commands with per-role rate limits), Spotify song-request queue driven by channel-point redemptions, quote system, custom chat commands stored in MySQL, auto-emote responses, viewer/chat analytics, follower tracking, Discord go-live notifications, hourly S3 database backups, and a loopback-only Express API used by a Stream Deck to toggle song requests.

**Stack:** MySQL (`mysql2`), Redis (`ioredis`) as cache + analytics write queue with graceful fallback to direct MySQL when Redis is down, Twitch EventSub over WebSocket (raw `ws`, no Twurple at runtime), raw `node-fetch` Helix calls, `spotify-web-api-node`, `winston` logging, `express`, AWS SDK v3 (S3), Jest.

**Runtime lifecycle (by design):** boot → connect DB → crash-recovery cleanup of orphaned stream/viewing-session rows → connect Redis (optional) → load tokens from the MySQL `tokens` table → check if stream is live. If offline: *minimal mode* (WebSocket + subscriptions for `stream.online`/`offline`/`channel.follow` only, token refresh every 5 min). If live: *full operation* (all managers, chat + redemption subscriptions, viewer polling every 60s, hourly backups, API server). Stream offline → tear down to minimal mode and start a 30-minute grace timer that exits the process; stream online again cancels it. SIGINT/SIGTERM → graceful shutdown that ends sessions, backs up, drains Redis queues, and closes connections.

### Directory map (accurate as of this review — the README's map is stale)

```
src/
├── bot.js                      # Composition root: DI wiring, lifecycle, shutdown (908 lines)
├── config/config.js            # Single config class: env secrets + all behavior knobs
├── ai/                         # aiManager, rateLimiter, contextBuilder, promptBuilder,
│   ├── models/claudeModel.js   #   raw fetch Claude client
│   └── prompts/                #   chatPrompt, advicePrompt, roastPrompt (system prompts)
├── analytics/                  # analyticsManager + viewers/viewerTracker (write-heavy path)
├── api/                        # Express server (loopback), x-api-key middleware, songs routes
├── commands/                   # commandManager (DB-driven registry) + handlers/* (8 modules,
│   └── utils/commandLoader.js  #   auto-discovered, DI via factory functions)
├── database/                   # dbManager (single connection), dbBackupManager (mysqldump→S3),
│   └── schema/schema.sql       #   debugDbSetup, schema
├── emotes/emoteManager.js      # Trigger→response, mirrors commandManager caching
├── logger/logger.js            # Winston + error rate-limit/dedup; writes to src/logger/logs/
├── messages/                   # chatMessageHandler (routing), messageSender, redemptionHandler
├── notifications/discordNotifier.js
├── redemptions/                # redemptionManager (title→handler registry), quotes/, songs/
│   └── songs/                  # spotifyManager (3s poll loops), queueManager (MySQL queue), songRequest
├── redis/                      # redisManager, cacheManager, queueManager, analyticsQueueConsumer
├── services/songToggleService.js  # Enables/disables the two song rewards via Helix
├── tokens/                     # tokenManager (tokens in MySQL, 5-min refresh), twitchAPI (Helix), redemptionCreation (one-off script)
└── websocket/                  # webSocketManager (EventSub WS), subscriptionManager, eventHandler (empty)
tests/                          # Mirrors src/; 35 suites, 910 tests, all mocked infra
```

### Key data flows

- **Chat message:** EventSub WS → `bot.handleChatMessage` → `chatMessageHandler`: skip own messages → skip reward-attached → AI mention check → emote exact-match → `!` command dispatch → analytics tracking. Commands resolve Redis-hash → in-memory Map → MySQL, check `user_level`, then run either a named handler function (DB column `handler_name` → function auto-loaded from `handlers/*.js`) or a static response.
- **Redemption:** EventSub WS → `redemptionHandler` → `redemptionManager` routes **by reward title string** ("Song Request", "Skip Song Queue", "Add a quote") → handler fulfills or cancels (refund) via Helix PATCH.
- **Song playback:** `spotifyManager` polls playback every 3s; when the current track has <3s left it pops `song_queue[0]` (MySQL) into the real Spotify queue.
- **Analytics:** per chat message, `viewerTracker` pushes to two Redis queues (`analytics:chat_messages`, `analytics:chat_totals`); a 5s consumer batch-inserts/aggregates into MySQL. If Redis is down, writes go directly to MySQL.
- **AI request:** rate-limit check (Redis-cached, MySQL-backed, per-user-per-stream by role) → context build (last 50 chat messages + stream info + roles from MySQL) → XML-structured prompt → Claude API → reply with usage counter prefix.

---

## 2. Verdict up front

**The architecture is genuinely good — for what it was designed to be.** The deliberate patterns (composition root with DI, manager-per-domain, data-driven command registry with auto-discovered handlers, consistent Redis-degradation, queue with retry/DLQ/drain, refund discipline on every redemption failure path, debug-database isolation) are real and consistently applied, and the 910-test suite mostly asserts real behavior. This is well above hobby-project baseline.

**But the bot's automated lifecycle almost certainly never worked**, and the review found one inverted wiring bug plus a cluster of lifecycle/concurrency defects that only manifest in exactly the scenario the owner is about to enter: the bot left running unattended, streams starting and stopping, connections dropping. The code has clearly mostly been exercised in the "started manually while already live" path.

**Rebuild from scratch? No.** The domain logic, patterns, and test suite are worth keeping; the defects are localized and fixable. However, two subsystems need structural (not cosmetic) work: the **persistence layer** (single shared MySQL connection must become a pool; transactions must use dedicated connections) and, later, the **schema/keying** (everything is single-tenant — see §6). The path is: stabilize the baseline on the current single-tenant architecture, then do a deliberate multi-tenant migration as its own phase, then the web frontend.

---

## 3. Findings — P0: broken core behavior (fix before anything else)

**P0-1. Stream online/offline handlers are wired backwards.** `WebSocketManager`'s constructor signature is `(tokenManager, chatHandler, redemptionHandler, streamOnlineHandler, streamOfflineHandler, followHandler)` (`src/websocket/webSocketManager.js:8`), but both call sites pass `handleStreamOffline` 4th and `handleStreamOnline` 5th (`src/bot.js:119-120` and `src/bot.js:271-272`). Consequence: a stream going live while the bot waits in minimal mode runs the offline teardown and starts the 30-minute auto-shutdown timer; the stream ending triggers full startup. The bot only ever worked when started manually mid-stream (the init-time live check takes the correct path). Verified by the lead directly. Fix the argument order (or better: replace positional args with a named-options object so this class of bug is impossible), remove the coverage exclusion masking it (P1-13), and add a lifecycle test that would have caught it.

**P0-2. EventSub reconnect loses chat and redemptions mid-stream.** Two compounding defects in `src/websocket/webSocketManager.js`:
(a) On `session_reconnect` (`:116-120`) it calls `this.connect()` against the base endpoint instead of the `reconnect_url` Twitch provides — per Twitch's protocol, that produces a brand-new session whose subscriptions are all gone, and the old socket's close event (`:27-31`) schedules *another* connect, so two connections race.
(b) After a new session, resubscription happens via `onSessionReady` — but if full operation was reached from minimal mode, `onSessionReady` is still the minimal-mode closure (`src/bot.js:124-130`), which subscribes only to online/offline/follow. Chat and channel-point subscriptions are never re-established; the bot appears healthy while hearing nothing. Fix: honor `reconnect_url` (keep old socket until new session welcome, per Twitch docs), make `onSessionReady` state-aware (subscribe based on current bot mode), and guard the close-handler's auto-reconnect during intentional closes/shutdown.

**P0-3. Single shared MySQL connection; transactions are unsafe.** `src/database/dbManager.js:20` opens one `mysql.createConnection` — no pool, no reconnect/keepalive handling. Consequences: (a) any dropped connection (idle timeout, network blip — this ran on EC2 for days at a time) permanently breaks every subsystem until process restart; (b) `START TRANSACTION`/`COMMIT`/`ROLLBACK` issued as plain queries on that shared connection (`src/redemptions/songs/queueManager.js:51-67,131-139`) silently absorb whatever concurrent queries (analytics inserts, 3s Spotify polls, API requests) land mid-transaction — a rollback can destroy unrelated writes. Fix: `mysql2` pool + `pool.getConnection()` for transaction scopes. Note the test mock (`tests/__mocks__/mockDbManager.js:19-25`) already models `getConnection/beginTransaction/commit/rollback` — an interface the real class doesn't have; make reality match the mock.

**P0-4. SpotifyManager monitor leak + paused-playback queue drain.** The three 3s `setInterval` loops start in the constructor (`src/redemptions/songs/spotifyManager.js:24-27`) with no teardown, and `startFullOperation` constructs a fresh SpotifyManager every stream start (`src/bot.js:206`) — after one offline→online cycle, two sets of monitors race on the same queue (double-queueing/double-deleting songs). Separately, `monitorCurrentTrack` (`:56-78`) never checks `is_playing`: pause a track with <3s remaining and every tick shovels another queued song into Spotify and deletes its row. Fix: teardown method called from the offline transition, reuse or properly dispose managers across cycles, and gate queue-advance on `is_playing`.

**P0-5. Refresh-token rotation hazard.** `checkAndRefreshTokens` unconditionally refreshes both Twitch tokens every 5 minutes (`src/bot.js:135-142`, `src/tokens/tokenManager.js`) instead of refreshing near expiry (~4h). Twitch rotates the refresh token on every refresh, and the new access + refresh tokens are persisted as two separate sequential DB writes (`tokenManager.js:234-250`) — a crash/DB failure between rotation and persistence strands the bot with a dead refresh token (manual re-auth required). The 5-minute cadence multiplies the exposure ~50×. Fix: refresh only when near expiry, persist both tokens atomically, and treat "invalid refresh token" as a loud, actionable failure.

---

## 4. Findings — P1: correctness/security defects under normal use

Analytics & viewers (`src/analytics/viewers/viewerTracker.js`):
1. **Role-flag wipe:** the 60s viewer poll calls `ensureUserExists(username, userId)` with default-false roles (`:332`), and its upsert unconditionally overwrites `is_moderator/is_vip/is_subscriber/is_broadcaster` (`:18-38`) — roles set by the chat path are reset every minute. Also `INSERT IGNORE` + `ON DUPLICATE KEY UPDATE` together is contradictory.
2. **Fallback double-write:** if the first of the two queue pushes succeeds and the second fails (`:167-183`), the code falls through to the direct-DB path and replays the already-queued write — duplicate chat_messages rows and double-counted totals.
3. **Unique-chatter inflation:** the `COUNT(*)` first-message check (`:130-142`) races the 5s batch flush; a user's burst before their first row lands increments `unique_chatters` repeatedly.
4. **`ensureUserExists` falls back to `userId = username`** (`:20-22`), polluting a numeric-ID column.

Chat / commands / AI:
5. **AI mention hijacks commands:** `shouldTriggerText` uses substring `includes` and runs before command dispatch (`src/ai/aiManager.js:121-126`, `src/messages/chatMessageHandler.js:65`) — any message containing the bot name, including `!commands`, is consumed by the AI path and burns rate limit.
6. **`!ai off` takes up to 60s:** `handlers/ai.js:28-33` writes the DB flag but never invalidates the `cache:settings:aiEnabled` Redis key (TTL 60). Also `isAIEnabled` **fails open** on DB error (`chatMessageHandler.js:213`).
7. **No EventSub dedup:** redeliveries (at-least-once) re-run redemption handlers — a song can be queued twice. Key processing on `event.id`.
8. **Queue-position race:** `addToPendingQueue` does MAX+1 read-then-insert without a transaction (`src/redemptions/songs/queueManager.js:17-31`); `!skip` races the 3s monitor (both pop `pendingTracks[0]`).
9. **Split permission model:** DB `user_level` vs hardcoded mod checks inside handlers vs the dead `Command.hasPermission` — the DB value is a lie for special commands, and `!command add` can't set a level (everything a mod adds is `everyone`, `commandManager.js:260`). No cooldown/spam protection exists outside AI rate limits.

Tokens / API / backup (security-adjacent):
10. **mysqldump command injection / password exposure:** the DB password is string-interpolated into a shell `exec` with `>` redirection (`src/database/dbBackupManager.js:94`). Use `execFile` + `MYSQL_PWD` env (or `--defaults-extra-file`) + `--result-file` (also fixes potential UTF-16 dump corruption under PowerShell redirection). Backups are also **unverified** (exit-code + file-stat only) and rotation keeps only the newest 10 — one long stream of hourly backups can rotate away every good backup while a silently-empty dump survives. Shutdown backup runs **before** queue drain (`src/bot.js:782` vs `:805`), so the "final" backup misses the last ≤30s of analytics.
11. **Broken/stale token paths:** `twitchAPI.getChannelId` reads nonexistent `tokens.AccessToken/.ClientID` (`src/tokens/twitchAPI.js:19-20`, sends `Bearer undefined`); `validateToken`'s broadcaster path revalidates the bot token and never persists the broadcaster's id (`tokenManager.js:158-164`); `refreshToken` rejects with strings so downstream logs show `undefined` (`tokenManager.js:262,272,284`); `redemptionCreation.js` executes at require-time and calls TokenManager without `init()` — cannot work.
12. Misc: `apiServer.start` can reject a settled promise on late server errors (`src/api/apiServer.js:86-92`); the Redis token-cache mirror is write-only (pure attack surface, never read — delete it or use it); API-key compare is non-constant-time (`src/api/middleware/auth.js:20`; low stakes on loopback, trivial fix); `updateRedemptionStatus` silently handles only the first id of its array parameter (`src/redemptions/redemptionManager.js:53`).

Tests (defects in the safety net itself):
13. **`src/bot.js` is excluded from coverage** (`jest.config.js:19`) and its lifecycle (mode transitions, shutdown timer, crash recovery, follow handling) is essentially untested — this is precisely where P0-1 lived. Remove the exclusion; add lifecycle tests.
14. **`commandHandlers.test.js:6-9` mocks `node-fetch` with a passthrough to real fetch** — any unstubbed path makes live HTTP calls from tests. `forceExit: true` (`jest.config.js:49`) masks leaked timers/handles (Jest warns every run). Two `checkAndRefreshTokens` tests contain zero assertions (`tokenManager.test.js:427-486`). Nothing anywhere validates real SQL against a real schema (all mocked; schema drift is invisible to CI).

---

## 5. Findings — P2: hygiene, dead weight, optimization

- **Dead dependencies:** `tmi.js`, all four `@twurple/*` packages, `form-data` — required nowhere in `src/` (the bot is EventSub + raw fetch now); `supertest` belongs in devDependencies. Dead code: `src/websocket/eventHandler.js` (`module.exports = {}`), `src/commands/command.js` (required by nothing; contains the never-used cooldown field), `tokenManager.getConfig()` (builds a tmi.js-style config nothing consumes), unused `src/logger/config/` dir. Logs write inside the source tree (`src/logger/logs`).
- **README is materially stale:** references `specialCommandHandlers.js` (replaced by `handlers/` + loader), omits entire subsystems (redis/, api/, services/, notifications/, backups, contextBuilder/promptBuilder/prompts), wrong schema path, wrong log filenames, no testing section.
- **Schema nits** (`src/database/schema/schema.sql`): no index on `chat_messages.message_time` (a `(stream_id, message_time)` composite would serve analytics queries); `viewers.username UNIQUE` will collide on Twitch rename+re-register; `song_queue.requested_by` stores a username while everything else uses user_id; no `ON DELETE` rules; no ENGINE/utf8mb4 declarations (emoji depend on server defaults); `commands.user_level` ENUM lacks `vip`; `api_usage.api_type` is a single-value ENUM.
- **Hot-path waste:** every non-matching chat message pays an `hget` + full `hgetall` on both the emote and command hashes (`src/emotes/emoteManager.js:75-87`, `src/commands/commandManager.js:94-107`) — use EXISTS/sentinel keys. `queueManager.pop` does N sequential LPOPs (use `LPOP key count`); `processChatMessages` inserts row-by-row (batch it); ~4-6 Spotify API calls per 3s idle (consolidate the three loops, track token expiry by timestamp instead of a `getMe` probe per call); `addToRequestsPlaylist` pages the whole playlist per request; `trackInteraction` costs 3-4 DB round-trips per message even with Redis on.
- **Misc:** `scripts/delete_logs.ps1` hardcodes a `D:\` path (repo is on `E:\`) and is interactive; `twitch-bot-key.pem` (legacy EC2 SSH key, untracked) should be moved out of the working tree; pre-commit pins eslint 8.57 against a v9 mirror; `claude-sonnet-4-5` model pin is a generation old (current family: Claude 5 — but leave model choice to the owner); the Claude HTTP call has no timeout or retry; consecutive stream sessions use synthetic `Date.now()` ids rather than Twitch's stream id (`src/bot.js:182`); Discord cooldown state is stored in the `tokens` table (works, but the table has become a generic key-value junk drawer); `messageSender.sendMessage` ignores its `channel` parameter entirely (`src/messages/messageSender.js:45-47`).

---

## 6. Forward pressure: what the end goal does to this architecture

The owner's target state: **two streamers using this bot** (owner + friend), and eventually a **Nightbot-style web frontend** where users manage commands, quotes, song settings, etc.

The current system is single-tenant to its foundations — not as an accident, but as a consistent design premise. Evidence: `channelName` hardcoded (`src/config/config.js:9`), bot username + channel list hardcoded (`src/tokens/tokenManager.js:333-336`), AI triggers hardcoded twice (`config.js:121-123`, `aiManager.js:133-134`), `tokens` table is a flat one-bot-one-broadcaster key/value singleton, **no table in the schema has a channel/broadcaster column** (`commands`, `emotes`, `quotes`, `viewers`, `streams`, `song_queue`, `chat_totals` are all global), per-channel Twitch attributes (`is_moderator/vip/subscriber`) stored as absolute flags on `viewers`, all Redis keys unscoped (`cache:commands`, `cache:emotes`, `cache:settings:aiEnabled`, `ratelimit:*`), `messageSender` ignores its channel argument, all API routes operate on the one configured channel, one Spotify account and playlist per process, redemption routing by reward title string.

**Cost assessment: multi-tenancy is a persistence-layer and keying migration — a heavy, deliberate phase, not an additive change.** Every table needs a channel dimension, `tokens` needs restructuring to per-channel credential sets, viewer roles need a per-channel join table, Redis keys need channel scoping, config needs to split "per-channel settings" (→ database, eventually edited via the frontend) from "deployment settings" (→ stays in config.js). The web frontend then needs: a real (non-loopback) API layer with per-user Twitch OAuth, which is a natural extension of the Express server already present.

**What this does NOT require: abandoning the stack.** MySQL is a fine choice for two-to-N channels of this workload (the frontend actually favors a relational store); Redis stays; Node stays; the manager/DI architecture stays. Hosting decisions (Amplify/CloudFront/etc.) are frontend-phase decisions and should not shape baseline work now. The one genuinely open architectural question for the multi-tenant phase is process model — one process handling N channels vs. process-per-channel — and it should be decided in that phase's design doc, not preempted here.

---

## 7. Proposed phasing (owner approval pending)

- **Phase 0 — Baseline stabilization (current):** fix P0-1..5 and the P1 list, prune P2 dead weight, refresh README, bring `bot.js` under test with lifecycle coverage, fix the test-suite defects. No features. Exit criteria: all findings resolved or explicitly waived by the owner, suite green, a debug-mode smoke run clean.
- **Phase 1 — Multi-tenant design + migration:** design doc first (schema v2, token model, Redis keying, config split, process model), owner sign-off, then migration.
- **Phase 2 — Web frontend:** OAuth, public API, hosting selection, UI.

This document is the shared baseline reference. Work packages for Phase 0 will be issued separately by the lead via the owner (see `docs/WORK_PACKAGES.md`).

---

## 8. Addendum — accepted amendments from engineer verification (2026-08-15)

The engineer independently reproduced all P0 findings and the sampled P1s. The following corrections/additions are accepted and supersede the text above where they conflict:

1. **Dead-dependency list corrected:** `@twurple/api` and `@twurple/auth` ARE referenced — by `src/tokens/redemptionCreation.js:3-4` (itself broken, P1-11); they become removable only when that file is fixed or removed. Confirmed dead: `@twurple/eventsub-ws`, `@twurple/pubsub`, `tmi.js`, `form-data`, **and `winston-daily-rotate-file`** (missed by review; `logger.js:61` uses plain `winston.transports.File`, and the stray `src/logger/config/*-audit.json` files are DailyRotateFile leftovers — note `logger.js:16-18` recreates that dir on boot, so removal needs a logger edit).
2. **P0-2b is worse than described:** the minimal-mode `onSessionReady` closure also constructs a NEW SubscriptionManager, orphaning full-mode subscriptions from `unsubscribeFromEventType`'s session-id match (`subscriptionManager.js:315`).
3. **P1-5 restated:** the AI hijack trigger is the substring `almosthadai` (`config.js:122`), so `!commands` is NOT affected; the hijack set is any message containing the bot's name (e.g., `!stats almosthadai`, ordinary chat mentioning the bot). A bare `almosthadai` falls through via `extractPrompt` returning null (`aiManager.js:137`). Fixes/tests must target these cases.
4. **P1-11 broadcaster-id claim restated:** the success path persists the broadcaster id as `userId` (`tokenManager.js:174`), which `subscribeToChatEvents` reads. The defect is the post-refresh revalidation branch (`tokenManager.js:156-164`): it revalidates with `botAccessToken` regardless of token type and only writes `botId`, leaving `userId` stale after a broadcaster refresh.
5. **P2 stream-id note is larger than it reads:** `twitchAPI.getStreamByUserName` returns only `{startDate, viewer_count}` (`twitchAPI.js:71-74`), so `bot.js:96` already logs `undefined`; adopting Twitch's real stream id requires changing the wrapper's return shape and its callers.
6. **P1-13 root-cause refined:** `bot.init()` IS driven through both paths by `bot.backup.test.js`/`bot.discord.test.js`; P0-1 survived because `jest.mock` automocks WebSocketManager so constructor args are never asserted. The fix must include a constructor-contract test (or the named-options refactor that makes arg order moot).

**New findings accepted from engineer (added to the register):**
- **P1-15: `messageSender.sendMessage` validates the bot token on EVERY outbound message** (`messageSender.js:28` → Helix `/validate` fetch + MySQL `updateToken` write per chat line, on the shared P0-3 connection). Fix alongside P0-5 token-lifecycle work.
- **P0-4 (extended): the API server has the same per-cycle leak** — `handleStreamOffline` never stops it and `startFullOperation` constructs a new one (`bot.js:227`); cycle two hits EADDRINUSE via the post-settle error listener (P1-12) and the bot silently runs API-less. Folded into the P0-4 teardown package.
- **Config mismatch (owner decision):** `cache.commandsTTL/emotesTTL = 500` are SECONDS (~8.3 min) while `commandCacheInterval = 300000` ms (5 min) — likely intended equal.
- **Test constraint:** `bot.js` self-starts at require time gated only on `NODE_ENV !== 'test'` (`bot.js:904`) — shapes how lifecycle tests must be written.
- Trivial: dead `startsWith` clause at `aiManager.js:124` (subsumed by `includes`).
