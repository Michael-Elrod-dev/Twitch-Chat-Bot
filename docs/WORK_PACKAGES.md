# Phase 0 Work Packages

Companion to `docs/BASELINE_REVIEW.md` (incl. its §8 addendum). Issued by the lead; executed by the engineer; verified by the lead before the next package is issued. One package = one reviewable unit of work. Keep the suite green at every step. No features, no scope creep; anything discovered mid-package that isn't in scope gets *flagged in the completion report*, not fixed.

**Planned sequence** (subject to revision as results come in):

- **WP-1 — Test-suite trustworthiness** (this document, below) — make the safety net honest before touching production code.
- **WP-2 — WebSocket lifecycle** (P0-1, P0-2a/b): named-options refactor, reconnect_url handling, state-aware resubscription, constructor-contract + lifecycle tests.
- **WP-3 — Database layer** (P0-3): mysql2 pool + `withTransaction`, migrate the two transaction scopes.
- **WP-4 — Runtime teardown** (P0-4 extended): SpotifyManager monitor lifecycle + `is_playing` gate, API-server reuse/teardown across stream cycles.
- **WP-5 — Token lifecycle** (P0-5, P1-11, P1-15): expiry-based refresh, atomic persist, fix revalidation branch, stop per-message validation.
- **WP-6 — P1 correctness sweep** (analytics/viewer bugs, AI-flag staleness + fail-closed, EventSub dedup, queue races, permission-model consolidation, backup hardening incl. mysqldump credential fix).
- **WP-7 — Hygiene** (dead deps/files, README rewrite, schema nits that don't require migration, hot-path optimizations approved by lead).

Verification protocol: the engineer has no live credentials. Each package's exit criteria are static: suite green + new targeted tests + lead code review. Live verification happens once at the end of Phase 0: the owner runs `npm run debug` (debug DB, forced full operation) and relays output; WP exit criteria must NOT depend on live runs.

---

## WP-1 — Test-suite trustworthiness  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15]

> Lead verification: 36 suites / 943 tests, exit 0, no open-handle warning, `git status` confirms zero `src/` changes, coverage thresholds hold with `bot.js` included. Root-cause analysis of the forceExit leak (test-side: real timers + automocked AnalyticsManager leaving `viewerManager` undefined → offline path threw → intervals leaked) accepted. Flagged items routed: offline-catch interval leak → WP-4; untracked warning timers → WP-4; `getStreamByUserName` mock/reality mismatch → WP-7; schema-validation testing → held open for owner decision at WP-6.

**Goal:** the suite must be able to catch the bugs we're about to fix. Test files and Jest config only — **zero production-code changes** in this package. If a test cannot be written without a production change, write it up in the completion report instead.

### Tasks

1. **Remove the `'!src/bot.js'` coverage exclusion** (`jest.config.js:19`).
2. **Add bot lifecycle tests** (new file(s) under `tests/bot/`), covering at minimum:
   - `handleStreamOffline`: ends sessions + tracks stream end, clears intervals, sets `isStreaming=false`, detaches WS handlers, unsubscribes, starts the shutdown timer.
   - `handleStreamOnline`: cancels a pending shutdown timer, reaches full operation.
   - `startShutdownTimer`: fires `gracefulShutdown` after the grace period; cancelled by stream-online (use fake timers; note `process.exit` must be stubbed).
   - `cleanupOrphanedSessions`: issues the four UPDATE statements; resilient to query errors.
   - `handleFollow`: guards missing viewerManager; delegates correctly.
   - `sendMessage`: no-ops when not streaming / shutting down.
   Test the methods' *current correct behavior* — do NOT write tests that enshrine P0 bugs (e.g., do not assert the current WebSocketManager constructor arg order; the contract test for that lands with WP-2's fix). Work around the require-time self-start via `NODE_ENV=test` (already how existing bot tests do it).
3. **Fix the live-network mock hazard:** `tests/commands/commandHandlers.test.js:6-9` — the `node-fetch` mock must default to a rejected promise (or `jest.fn()` with no passthrough), never real fetch. Audit the other test files for the same pattern.
4. **Add real assertions to the two empty `checkAndRefreshTokens` tests** (`tests/tokens/tokenManager.test.js:427-486`): assert which refreshes occur and what is persisted.
5. **Investigate `forceExit: true`** (`jest.config.js:49`): identify the leaked handles (run with `--detectOpenHandles`). If the leaks are test-side (un-cleared timers/servers in tests), fix them and remove `forceExit`. If a leak traces to production code (e.g., SpotifyManager constructor intervals), document it in the completion report, keep `forceExit` with a comment naming the responsible WP, and move on.
6. **Coverage thresholds:** after including `bot.js`, thresholds (75/70/75) may dip. Prefer recovering via the new lifecycle tests. If still short, lower the global thresholds minimally, with a comment `// TODO restore to 75/70/75 by end of Phase 0`, and state the numbers in the completion report.
7. Leave `maxWorkers: 1` as-is for now (not worth churn in this package).

### Exit criteria

- `npm test` green; no live network access possible from any test (verify by running once with networking assumptions in mind — e.g., temporarily set an invalid proxy env or grep for surviving passthroughs).
- `src/bot.js` included in coverage; report the resulting global coverage numbers.
- Completion report: what was added/changed per task, coverage before/after, forceExit outcome, any flagged-not-fixed items.

---

## WP-2 — WebSocket lifecycle + owner config edits  [STATUS: COMPLETE — VERIFIED, ONE AMENDMENT REQUIRED (WP-2.1) 2026-08-15]

> Lead verification: 38 suites / 971 tests, exit 0; production diff confined to the scope guard; wiring fix, intent-aware close, reconnect_url handling, and single-SubscriptionManager design all read correct; contract-test validation methodology (reintroduce bug → 5/9 fail → restore) accepted. Flagged items accepted: config-mock model drift → WP-7; reuse-branch second subscription path → WP-4 review; event dedup rationale → P1-7 in WP-6; bot.js size → Phase 1 note.
>
> **WP-2.1 (required amendment, found in lead review):** if the OLD socket dies unexpectedly after `session_reconnect` but before the replacement's welcome (Twitch itself closes it with 4004 after 30s), `handleClose` arms a reconnect timer that nothing cancels when the replacement is then promoted — the timer later fires, `connect()` overwrites the healthy promoted socket, and `resubscribeAll` on the new session duplicates subscriptions across two live sessions. Fix: `handleSessionWelcome` must call `clearReconnectTimer()` (both paths is fine; the promotion path is the load-bearing one). Add a reconnect test for exactly this interleaving: reconnect requested → old socket unexpected-close (timer armed) → replacement welcome → assert timer cancelled and no second connect occurs. Report with the WP-3 completion report.

**Goal:** the bot survives its real lifecycle — stream going online/offline while it waits, and Twitch-initiated reconnects mid-stream — without losing events. Fixes P0-1 and P0-2a/b. Also carries two small owner-approved config edits (task 0) so they ship with a tested package rather than floating alone.

**Scope guard:** `src/websocket/`, `src/bot.js` (wiring/lifecycle only — do not touch the Spotify, DB, token, or API-server code paths; those are WP-3/4/5), `src/config/config.js` (task 0 only), and tests. Suite stays green throughout.

### Tasks

0. **Owner-approved config edits** (`src/config/config.js`):
   - `cache.commandsTTL` and `cache.emotesTTL`: `500` → `300` (owner confirmed they were meant to match the 5-minute refresh intervals; values are seconds).
   - `aiModels.claude.model`: `'claude-sonnet-4-5-20250929'` → `'claude-sonnet-5'` (exact ID, no date suffix — current-generation IDs are undated). Grep the repo for any other `claude-` model strings and upgrade to the current equivalent if found; report what you found either way. Update any tests pinned to the old values.
1. **Named-options refactor of WebSocketManager.** Replace the 6-positional-arg constructor with a single options object (e.g. `{ tokenManager, onChatMessage, onRedemption, onStreamOnline, onStreamOffline, onFollow }`). Update both bot.js call sites — **this is where P0-1 dies**: wire `onStreamOnline` to `handleStreamOnline` and `onStreamOffline` to `handleStreamOffline`. Update existing websocket tests to the new shape.
2. **Wiring contract test.** A test that constructs the real Bot with the real (un-automocked) WebSocketManager class, feeds a synthetic EventSub `stream.online` notification through `handleMessage`, and asserts the bot takes the *online* transition (and mirror-case for `stream.offline`). This test must be written to fail against the old swapped wiring — state in the completion report how you confirmed it would have caught P0-1.
3. **Honor `reconnect_url` on `session_reconnect`.** Per Twitch EventSub protocol: connect a NEW socket to the provided `reconnect_url`, wait for its `session_welcome`, then close the old socket. Subscriptions carry over on a reconnect-URL session (no resubscribe needed on this path — verify against Twitch docs and note it). The old socket's close must NOT schedule another connect.
4. **Intent-aware close handling.** The `close` handler currently always schedules a reconnect (webSocketManager.js:27-31). Add intent tracking so: intentional `close()` (shutdown) → no reconnect; replaced-socket close (task 3) → no reconnect; unexpected close → reconnect with the existing delay to the standard endpoint, followed by full resubscription via task 5.
5. **Single state-aware resubscription path.** One long-lived SubscriptionManager whose session id is updated via `setSessionId`, never replaced (fixes the orphaned-unsubscribe defect). Replace both `onSessionReady` closures with one `resubscribeAll()` that subscribes based on current bot mode: minimal → online/offline/follow; full → those plus chat + channel points. Used by both initial connects and unexpected-close reconnects.
6. **Reconnect tests.** Simulate: `session_reconnect` message (new socket to reconnect_url, old socket closed without reconnect scheduling); unexpected close mid-full-operation (reconnect + full resubscribe including chat/points); intentional close (no reconnect). Mock the `ws` module — no real network.

### Exit criteria

- Suite green; new tests as specified; task-2 test demonstrably catches the P0-1 class.
- No production changes outside the scope guard.
- Completion report: per-task summary, the model-string grep results, how the contract test was validated against the old bug, and any flagged-not-fixed discoveries.

---

## WP-3 — Database layer  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15, incl. WP-2.1]

> Lead verification: 38 suites / 989 tests, exit 0; read the new dbManager in full (pool + probe, `withTransaction` with release-in-finally and non-masking rollback — correct), both queueManager scopes migrated (their hand-rolled rollback blocks — one of them itself buggy — deleted), zero raw transaction strings in `src/`, WP-2.1 fix confirmed at the top of `handleSessionWelcome` with its interleaving test validated by fix-removal. The `config.js` scope-guard deviation is approved — task 1 explicitly named the knob; that was the lead's spec error, handled correctly. Flagged items routed: batch-insert-in-transaction → WP-7; MAX+1 race noted as trivially fixable → WP-6/P1-8; schema validation still open → WP-6 owner decision; **debugDbSetup pool-alignment check → added to the pre-smoke checklist** (it runs on every `npm run debug`).

**Goal:** eliminate P0-3. The single shared `mysql.createConnection` becomes a pool; transactions run on dedicated connections via a `withTransaction` helper; a dropped connection no longer bricks the bot; concurrent queries can no longer interleave into (or be destroyed by) someone else's transaction.

**Scope guard:** `src/database/dbManager.js`, `src/redemptions/songs/queueManager.js` (transaction migration only), `tests/__mocks__/mockDbManager.js`, and tests. Do NOT touch `dbBackupManager` (WP-6), `debugDbSetup`, or any other consumer — `query()` keeps its exact signature and return shape so every existing call site works unchanged.

### Tasks

1. **Pool.** `dbManager.connect()` creates a `mysql2/promise` pool (`connectionLimit` ~10, `waitForConnections: true` — add a `config.database.connectionLimit` knob defaulting to 10 rather than hardcoding). `query()` becomes a pool passthrough preserving its current signature/return; the `START TRANSACTION`/`COMMIT`/`ROLLBACK` special-case detection is deleted (see task 3). `close()` → `pool.end()`. Keep the current logging shape.
2. **`withTransaction(fn)`.** Acquires a dedicated connection, `beginTransaction()`, invokes `fn(connection)` where the connection exposes the same `query`-style call the callback needs, commits on resolve, rolls back on throw (rethrowing the original error), and releases the connection in a `finally` — including when rollback itself fails. No nesting support needed; document that.
3. **Migrate the two transaction scopes** in `src/redemptions/songs/queueManager.js` (`:51` and `:131` regions) onto `withTransaction`. After migration, grep `src/` for any remaining raw `START TRANSACTION`/`COMMIT`/`ROLLBACK` strings — there must be none.
4. **Align the mock.** `tests/__mocks__/mockDbManager.js` currently advertises an interface the real class never had. Make it mirror the NEW real interface exactly: `connect`, `query`, `withTransaction`, `close` (drop or rewire `getConnection`/`beginTransaction`/`commit`/`rollback`/`connected` — nothing real exposes them; check test usages of `createTransactionalDbManager` and update accordingly). The mock's `withTransaction` should execute the callback and surface commit/rollback behavior so queueManager tests can assert rollback-on-throw.
5. **Tests.** New dbManager tests (mock `mysql2/promise` at module level): pool created with config values; `query` delegates; `withTransaction` commits on success, rolls back and rethrows on callback throw, releases in both cases and when rollback throws. Updated queueManager tests: priority-queue insert commits; a mid-transaction failure rolls back and the queue is untouched.

### Exit criteria

- Suite green; no raw transaction strings left in `src/`; mock and reality expose the same interface.
- WP-2.1 amendment applied and its test present (reported together with this package).
- Completion report: per-task summary, any call sites whose behavior changed observably, flagged-not-fixed discoveries.

---

## WP-4 — Runtime teardown  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15]

> Lead verification: 40 suites / 1042 tests, exit 0; read the SpotifyManager lifecycle, apiServer settled-flag/handle-management, and bot.js teardown diffs — all correct. Reuse-over-rebuild decision approved with its rationale (state preservation, structural leak-impossibility). Keep-API-up-between-streams decision approved (loopback-only; removes the collision window; lets the Stream Deck work between streams). Both fix-removal validations (P0-4 → 8 failures; abandon-on-throw → 5 failures) accepted. Flagged items routed: **startup rollback on partial failure → WP-4.1, folded into WP-5** (decision: a failed `startFullOperation` must stop what it started — Spotify monitors, viewer tracking, backups — using the now-idempotent stop paths, then arm the shutdown grace timer before rethrowing, so the bot retries from a clean minimal mode instead of sitting half-started); **auth-dead Spotify start gate → WP-5** (confirmed in scope); bot.js size → Phase 1; leak-test seam via `startFullOperation` accepted as documented.

**Goal:** eliminate P0-4 (extended). After this package, a full online → offline → online cycle leaks nothing: no duplicate Spotify monitors racing the song queue, no dead API server, no orphaned intervals or timers, and a teardown that completes even when one of its steps throws.

**Scope guard:** `src/redemptions/songs/spotifyManager.js`, `src/api/apiServer.js`, `src/bot.js` (lifecycle/teardown paths only), and tests. Do NOT touch token logic (WP-5), analytics/viewer logic (WP-6), or the queueManager beyond what monitor lifecycle requires.

### Tasks

1. **SpotifyManager lifecycle.** The three 3s `setInterval` loops move out of the constructor into explicit `start()`/`stop()` methods (idempotent: double-`start` doesn't stack, `stop` clears all three and is safe to call twice). `startFullOperation` starts it; `handleStreamOffline` and `gracefulShutdown` stop it. Decide and document whether the instance is reused across cycles or rebuilt-per-cycle-with-guaranteed-stop; either is acceptable if provably leak-free.
2. **`is_playing` gate.** `monitorCurrentTrack` must not advance the queue when playback is paused (`is_playing` false) — kills the paused-near-track-end queue drain.
3. **API server across cycles.** `handleStreamOffline` currently never stops it and `startFullOperation` builds a new one → cycle two dies with EADDRINUSE via the settled-promise `reject` (P1-12) and the bot silently runs API-less. Fix all three: stop (or reuse) the server across cycles; `start()` must not reject after it has resolved (post-settle errors get logged, not rejected); a failed start is loudly logged but non-fatal (current behavior preserved).
4. **Resilient offline teardown.** `handleStreamOffline`'s catch currently abandons teardown mid-way (intervals keep running, shutdown timer never armed — the half-torn-down state Opus found in WP-1). Restructure so interval/timer cleanup, `isStreaming=false`, and `startShutdownTimer()` are guaranteed (finally or step-isolated try/catches), regardless of which step throws.
5. **Track the shutdown-warning timers.** `startShutdownTimer`'s three warning `setTimeout`s get stored and cleared when the shutdown is cancelled or replaced.
6. **Reuse-branch subscription review** (carried from WP-2): document why the incremental chat/points subscribe in `startFullOperation`'s reuse branch stays separate from `resubscribeAll` (it's an add to a live session, not a rebuild) — a comment at the site naming the distinction is sufficient; consolidate only if you find an actual defect.
7. **Tests.** The centerpiece: a two-full-cycle test (online → offline → online → offline) asserting no interval/timer/server leaks — count active fake timers and assert monitor singletons; SpotifyManager start/stop idempotency; `is_playing` gate; API server stop/restart across cycles without EADDRINUSE; post-settle server error does not reject; teardown-with-throwing-step still clears intervals and arms the shutdown timer; warning timers cleared on cancel.

### Exit criteria

- Suite green; the two-cycle leak test passes; no production changes outside the scope guard.
- Completion report: per-task summary, the reuse-vs-rebuild decision and rationale, flagged-not-fixed discoveries.

---

## WP-5 — Token lifecycle  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15, incl. WP-4.1]

> Lead verification: 40 suites / 1096 tests, exit 0; read `needsRefresh`, `checkAndRefreshTokens`, `validateToken`, `fetchIdentity`, and the atomic `refreshToken` in full — all correct, including memory-moves-only-after-commit and per-type failure isolation. No stray scratch files in the repo. The `tokenRefreshSafetyMargin` config knob deviation is approved (same reasoning as WP-3's). Migration note accepted and recorded: first boot after deploy performs a one-time unconditional refresh of both tokens (atomic, safe on crash); same applies after any restore of the S3 dump. Latent `updateToken` bare-UPDATE bug (silent no-op on missing key) fixed via upsert — good catch. Flagged items routed to WP-7 with lead decisions attached: **Redis token mirror → DELETE** (write-only, duplicates live credentials, no remaining rationale); **`getConfig()` → DELETE** (dead tmi.js relic); **`validateToken` → lean DELETE unless WP-7 finds a boot-health-check use** (no production callers); **`expires_in` sanity floor → ADD** (one line); dual Spotify auth guards accepted as defense-in-depth with the manager-level guard as the documented authority.

**Goal:** eliminate P0-5, P1-11, and P1-15, plus the two WP-4 carry-overs. After this package: tokens refresh only when they need to, a crash can't strand the bot with a dead refresh token, every outbound chat message stops costing a Twitch API call plus a DB write, and a partially-failed startup cleans up after itself.

**Scope guard:** `src/tokens/tokenManager.js`, `src/tokens/twitchAPI.js` (dead-method removal only), `src/messages/messageSender.js`, `src/redemptions/songs/spotifyManager.js` (auth-gate only), `src/bot.js` (startup-rollback path only), and tests. `src/tokens/redemptionCreation.js` is NOT in scope — it is broken and unused; WP-7 decides delete-vs-repair. Schema: no ALTERs — expiry metadata goes in the existing `tokens` key/value table as new rows.

### Tasks

1. **Expiry-based refresh (P0-5a).** Twitch token responses carry `expires_in`. Persist `<token>ExpiresAt` alongside each token (new key/value rows). `checkAndRefreshTokens` refreshes a token only when it is within a safety margin of expiry (15 min; make it a config knob) or when expiry is unknown (first run after migration). The 5-minute interval stays as the *check* cadence — the refresh rate drops from ~288/day to ~6/day per token.
2. **Atomic persist (P0-5b).** A refresh writes access token, refresh token, and expiry in ONE `withTransaction` — the crash window that could persist a new access token while losing the rotated refresh token must be gone. Update the in-memory map only after commit. A refresh failure with an *invalid-refresh-token* error is logged at error level with an explicit "manual re-authorization required" message — loud, not swallowed.
3. **Fix the revalidation branch (P1-11).** After refreshing the broadcaster token, validate THE BROADCASTER token and persist its id to `userId`; after refreshing the bot token, validate the bot token → `botId`. No cross-wiring. While here: `refreshToken`'s string rejections become real `Error` objects (fixes the `undefined` error logs).
4. **Stop per-message validation (P1-15).** `messageSender.sendMessage` drops its `validateToken` preflight (the Helix `/validate` + DB write per chat line). Trust the refresh cycle; on a 401 from the send itself, refresh once via tokenManager and retry the send once. No retry loops.
5. **Auth-dead Spotify gate (WP-4 carry-over).** When Spotify auth is known-dead (refresh failed, no valid token), `spotifyManager.start()` logs one loud warning and does not start monitors, instead of starting pollers that fail every 3s forever. `authenticate()` returns a success boolean the caller can check; wire `startFullOperation` accordingly (song-request redemptions should still refund gracefully — verify that path doesn't throw uncaught).
6. **Startup rollback (WP-4.1).** `startFullOperation`'s catch stops what already started before rethrowing — Spotify monitors, viewer tracking interval, backup interval, in-flight subscription state — reusing the idempotent stop paths from WP-4, then arms the shutdown grace timer so the bot returns to a clean minimal-mode wait instead of a half-started limbo. Add a teardown-style test: fail startup at three different steps, assert nothing stays running and the bot can go online again cleanly afterward.
7. **Delete `twitchAPI.getChannelId`** — it reads token keys that have never existed (`tokens.AccessToken`/`.ClientID`), cannot work, and has no callers. Grep to confirm zero callers first.
8. **Tests.** Expiry-based skip/refresh decision matrix (fresh, near-expiry, unknown-expiry); atomic persist (all three values in one transaction; failure mid-transaction leaves old values in memory AND db); revalidation branch hits the right token/id per type; messageSender no longer calls validate per send, 401-retry-once behavior (and only once); Spotify auth-dead gate; the three-step startup-rollback matrix.

### Exit criteria

- Suite green; refresh cadence provably expiry-driven; no per-message validation; startup rollback proven by the three-step failure matrix.
- Completion report: per-task summary, migration note for the new expiry rows (first run after deploy refreshes once because expiry is unknown — say so explicitly), flagged-not-fixed discoveries.

---

## WP-6 — P1 correctness sweep  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15]

> Lead verification: 43 suites / 1163 tests, exit 0; spot-read the fail-closed change, the backup `execFile`/`MYSQL_PWD`/`--result-file`/verification implementation, and confirmed no scratch files remain. All twelve defect-reintroduction validations accepted — special credit for the P1-12 methodology note (validation caught that the tests weren't actually load-bearing; that's the process working). Both behavior changes (fail-closed AI, verification-gated rotation) accepted as specced; the shutdown-drain latency note and the S3 over-retention trade-off recorded. Flagged items routed: **InnoDB explicit ENGINE declaration → WP-7 schema task** (a correctness fix now depends on it); `!command add` level syntax → Phase 2 (confirmed); per-instance dedup memory → Phase 1 note; `handleGameCommand` coverage gap → WP-7 test debt; **`tests/wp6/correctness.test.js` → WP-7 relocates into the mirrored tree**.

**Goal:** clear the P1 register. Each numbered task is independently verifiable; if one turns out to be deeper than specced, flag it and move on rather than stalling the package. NO new features: no cooldowns, no new chat syntax, no reward-ID routing (multi-tenant phase).

**Scope guard:** `src/analytics/`, `src/messages/`, `src/ai/aiManager.js` (trigger logic only), `src/commands/` (permission unification only), `src/commands/handlers/ai.js`, `src/redis/queueManager.js` (drain reporting only), `src/redemptions/songs/queueManager.js` (P1-8 only), `src/redemptions/redemptionManager.js`, `src/database/dbBackupManager.js`, `src/bot.js` (backup ordering only), tests.

### Tasks

1. **Role-flag wipe (P1-1).** The 60s viewer poll must stop resetting `is_moderator/is_vip/is_subscriber/is_broadcaster`. Split `ensureUserExists` so the upsert only updates role columns when roles were actually provided (chat path) and never from the poll path. Remove the contradictory `INSERT IGNORE` + `ON DUPLICATE KEY UPDATE` combination.
2. **`userId = username` fallback (P1-4).** When userId is missing, log at error and skip the write — never pollute the numeric-id column with a username.
3. **Dual-queue partial failure (P1-2).** If the chat-message queue push succeeds and the totals push fails (or vice versa), fall back ONLY for the failed write — never replay the succeeded one. Restructure per-write with per-write fallback.
4. **Unique-chatter inflation (P1-3).** The `COUNT(*)` first-message check races the 5s batch flush. Fix with an in-memory per-stream `Set` of seen user ids as the primary check (cleared on stream end), retaining the DB check only as the cold-start seed for the set. Document the restart-during-stream edge (worst case: one extra increment per user after a crash — acceptable).
5. **AI trigger hijack (P1-5, as restated in the addendum).** Messages starting with `!` never enter the AI-mention path — command dispatch wins. Mentions only trigger AI on non-command messages. Also delete the dead `startsWith` clause (aiManager.js:124) and make `extractPrompt` use `config.aiTriggers` instead of its own hardcoded regexes.
6. **`!ai off` latency + fail direction (P1-6).** The toggle handler invalidates `cache:settings:aiEnabled` on write. `isAIEnabled` fails CLOSED on error (a DB outage silences the AI rather than re-enabling it) — this is a deliberate behavior change; note it in the report.
7. **EventSub dedup (P1-7).** Track recently-seen EventSub `message_id`s (metadata-level, covers all notification types) in a bounded structure (e.g. Set + FIFO eviction at ~1000 entries) in the WebSocketManager; duplicates are logged and dropped before dispatch. Twitch explicitly documents at-least-once delivery — cite the doc in the code comment.
8. **Queue-position race (P1-8).** `addToPendingQueue`'s MAX+1 read-then-insert goes inside `withTransaction`.
9. **Permission unification (P1-9, minimal form).** Handler modules declare their required level declaratively (e.g. exported metadata per handler function); `commandManager` enforces exactly once, from the DB `user_level` for static commands and the declared level for handler commands (the DB row for a handler command is updated at load if it disagrees — the DB stops lying). The scattered inline mod-checks inside handlers are deleted. No new chat syntax for `!command add` (Phase 2).
10. **Backup hardening (P1-10).** `dbBackupManager`: switch `exec` + interpolated password + shell redirection to `execFile` with `MYSQL_PWD` in env and `--result-file` (also fixes the PowerShell UTF-16 hazard). Verify the dump before upload AND before rotation: non-trivial size (floor, e.g. 1KB) and contains the `-- Dump completed` marker; a failed verification uploads nothing and never rotates old backups. In `gracefulShutdown`, move the final backup AFTER the Redis queue drain.
11. **Drain honesty (P1-12 remainder).** `getQueueLength` errors must not read as `0`/drained: `drainQueues` treats a length-check failure as "unknown", keeps trying until timeout, and reports failure — never a false success.
12. **`updateRedemptionStatus` array lie.** It accepts `redemptionIds` but PATCHes only the first. All callers pass a single id — change the signature to a single `redemptionId` and update callers.

### Exit criteria

- Suite green; every task has tests including the failure/race cases; behavior changes (fail-closed AI, backup verification gating rotation) called out explicitly in the report.
- Completion report: per-task summary with validation methodology where a race/bug was reproduced, flagged-not-fixed discoveries.

**Held for owner at this gate:** real-database schema-validation testing (testcontainers-style). Lead recommendation: defer to Phase 1 — schema v2 lands there anyway and would immediately invalidate the harness; revisit when the multi-tenant schema is designed.

---

## WP-7 — Hygiene  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15 — one amendment (WP-7.1) open]

> Lead verification: 49 suites / 1204 tests, exit 0 (independently re-run); package.json confirmed at 9 runtime deps incl. the newly-declared `ws` (an undeclared direct dependency the repo had been shipping on transitively — the single most valuable find of the package); all four dead files confirmed gone; zero stale references; 11 explicit InnoDB declarations; `tests/wp6/` relocated. README, MIGRATION_NOTES, and SMOKE_TEST read in full as deliverables — all three approved; the smoke test's pass criteria and "report, don't work around" framing are exactly right. The `validateToken` KEEP decision is approved with its rationale (out-of-band revocation detection at boot beats silent mid-stream failure; ≤2 calls per process start). maxWorkers removal approved on the 3×-green + ~25% evidence.
>
> **WP-7.1 (small amendment, lead decision on the vip flag):** the `'vip'` enum value without a `hasPermission` tier is a trap (a manually-set vip row would resolve to unrestricted). Close it: add the vip tier to `hasPermission` — ordering `everyone < vip < mod < broadcaster`, i.e. a vip-level command runs for vip, mod, and broadcaster — with tests including the trap case (row set to `vip`, plain viewer blocked). No chat syntax to set it (still Phase 2). Report standalone.
>
> Remaining flags recorded for Phase 1: `debugDbSetup` pool migration (smoke test §1 watches it); per-instance dedup memory; `api_usage.api_type` single-value ENUM. Owner post-smoke actions: decide fate of the local recovered dump; consider rotating the Claude/Twitch/Spotify secrets it contains.

**PHASE 0 CODE-COMPLETE — CLOSED 2026-08-15 (owner decision: live gate deferred).** The owner will not stream or run live tests in the foreseeable future, so Phase 0 closes on static verification alone: 910 → 1204 tests, 79.2% → 86.3% statement coverage, 15 → 9 runtime dependencies, all 5 P0s and 12 P1s fixed and validated by defect reintroduction. `docs/SMOKE_TEST.md` is retitled in role, not content: it is now the **pre-first-live checklist**, to be run once before the bot is ever used in anger (likely when the desktop-app UI is mature). Debug mode (`npm run debug` — forced full operation against `<DB_NAME>_debug`, real DB untouched) remains the owner's offline "am-I-live" test switch.

---

> **WP-7.1 verified by lead 2026-08-15:** 49 suites / 1220 tests, exit 0; rank-based `hasPermission` + `rankOf` read correct; the `context.vip` gap catch was necessary and right (the tier would have been silently useless without it). Fail-open-on-unknown-level accepted with Opus's rationale — the DB path is ENUM-constrained, so unknown levels can only come from code, and disabling commands on a typo is the worse failure; recorded here so the decision isn't relitigated.

---

**OWNER DECISIONS 2026-08-15 (recorded):**
1. **Architecture: Option B — client-server.** The bot remains/becomes a hosted multi-tenant service; the Windows desktop app is a client that users download, install, and receive real version upgrades through. Decided on product grounds (a legit installable product for the second user, not a hand-me-down local script). Consequence: the Phase 1 multi-tenant redesign is back in full scope (schema v2, per-channel tokens, Redis key scoping, config split, client-server auth, hosted deployment). The lead's architecture decision doc becomes a **Phase 1 design doc for the client-server system**.
2. **Pre-commit hooks: removed entirely.** They were a learning exercise; CI is the correct home for enforcement. The CI design must be built from modern first principles — explicitly NOT shaped by what the hooks happened to do.

---

## WP-8 — CI pipeline & dependency management  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15]

> Lead verification: 49 suites / 1220 tests green post-sweep; all 101 headers stripped with zero grep hits; pre-commit artifacts gone; eslint.config.js in place with `.eslintrc.json` deleted; exact pins confirmed; `.nvmrc`=24; renovate.json automerge-off confirmed. Judgment calls approved: preserving accurate history in BASELINE_REVIEW with a superseded marker (correct — the review is a dated record, not live guidance); pinning ESLint v9 per spec with v10 arriving as Renovate's first major PR (a clean first exercise of the new flow); disabling `preserve-caught-error` to honor the no-src-change guard (fix now ordered in WP-8.1). The WORK_PACKAGES duplication was the lead's paste artifact — fixed by the lead directly. CI's first live run happens on the owner's push; Windows→Linux seams (loopback-port test, CRLF) are noted and WP-8.1 addresses the line-ending one structurally.

---

## WP-8.1 — Micro-cleanup  [STATUS: COMPLETE — VERIFIED BY LEAD 2026-08-15 — PHASE 0 FULLY CLOSED]

> Lead verification: 49 suites / 1220 tests green; rule explicitly enabled at `eslint.config.js:30` and the `{ cause }` fix confirmed at `tokenManager.js:105`; `baseline-browser-mapping` gone from package.json (remaining lockfile entries are legitimately transitive); `.gitattributes` in place with a correct explanatory comment; 124 entries fully staged, zero unstaged. The `preserve-caught-error` self-correction — discovering the WP-8 sighting came from the transient `@eslint/js@10`/`eslint@9` mismatch and refusing to report an inert fix as done — is the standout of the entire engagement and exactly the standard this process was built for. The `@eslint/js`-must-move-with-`eslint` caveat is recorded in DEPENDENCIES lore via this note.
>
> **Engagement closed.** Everything is staged for the owner's Phase 0 landing commit. Owner actions: review → commit → push (first CI run) → enable Actions if prompted → install Renovate app → merge its onboarding PR. Engineer stands down until the Phase 1 client-server design document is implementation-ready.
>
> **2026-08-15 later:** Owner committed and pushed; **first CI run green in 27s** (after the lead removed the orphaned `.git/hooks/pre-commit` script the old `pre-commit install` had left in local git state — unreachable from the repo, so no package could have caught it).

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
