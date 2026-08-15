# Phase 0 Smoke Test

The manual verification script for the end of Phase 0. Everything in the work
packages was verified statically — a green test suite and code review, with no live
credentials. This is where the code meets a real database, a real Redis, and real
Twitch and Spotify APIs for the first time.

Budget about 45 minutes. Work top to bottom; each section says what **pass** looks
like. Anything that fails, stop and report it with the log lines rather than pressing
on — a failure here is more informative than a workaround.

Read [`MIGRATION_NOTES.md`](MIGRATION_NOTES.md) first if you have not already.

---

## 0. Prerequisites

- [ ] **MySQL running** and reachable with the credentials in `.env`.
- [ ] **Production data restored** from `temp_backups/recovered-backup-2026-01-30.sql`.
      This file contains live credentials in its `tokens` table — do not commit it,
      move it, or paste its contents anywhere.
- [ ] **Schema ALTERs applied** per `MIGRATION_NOTES.md` §2 (verify first; §2b may
      already be satisfied).
- [ ] **Redis** running if you want to test the fast path. Optional — one check below
      deliberately runs without it.
- [ ] **`npm install` run** — the dependency set changed in Phase 0, and `ws` is now
      declared explicitly instead of arriving transitively.
- [ ] **`.env` checklist:**
      - `DB_*` — correct, pointing at the restored database
      - `DISCORD_WEBHOOK_URL` — **likely needs recreating**; the old webhook may have
        been revoked or deleted while the bot was dormant
      - `AWS_*` — needed for the backup check in §7
      - `API_ENABLED` / `API_PORT` / `API_KEY` — only if testing the Stream Deck
      - `REDIS_*` — omit entirely to exercise the fallback
- [ ] **Suite green locally:** `npm test`

Debug mode is used throughout. It writes to `<DB_NAME>_debug`, forces full operation
regardless of stream status, and skips backups and Discord notifications — so nothing
here posts to your Discord or touches production backups unless a section says so.

---

## 1. First boot

```bash
npm run debug
```

**Watch for, in order:**

1. Debug database setup — `debugDbSetup` creates and populates `<DB_NAME>_debug`.
   ⚠️ This is the one component that was **not** migrated to the connection pool; it
   opens its own connections. Confirm it still completes without error — this is the
   single most likely place for a Phase 0 regression to show up.
2. `[DbManager] Successfully connected to SQL database` with `connectionLimit` in the
   metadata.
3. Orphaned-session cleanup — closes any sessions left open by the last crash. On the
   restored dump this will likely report a non-zero count. That is correct.
4. Redis line: either connected, or `Redis unavailable - running in fallback mode`.
5. **The first-boot double token refresh:**
   ```
   [TokenManager] No expiry recorded, refreshing {"type":"bot"}
   [TokenManager] No expiry recorded, refreshing {"type":"broadcaster"}
   [TokenManager] Token refreshed successfully {"type":"bot","expiresInMinutes":240}
   [TokenManager] Token refreshed successfully {"type":"broadcaster","expiresInMinutes":240}
   ```
   **This is expected exactly once.** See `MIGRATION_NOTES.md` §1.
6. Possibly `[CommandManager] Correcting stale user_level for handler command` lines
   for `!skip`, `!songs`, `!emoteadd`, `!ai`. Also expected once.
7. `[Bot] Bot is now fully operational` and a message in chat.

**Pass:** the bot reaches "fully operational" and posts to chat. No stack traces.

**If token refresh fails with `MANUAL RE-AUTHORIZATION REQUIRED`:** the stored refresh
token expired during dormancy. Re-authorize with Twitch and update the
`botRefreshToken` / `broadcasterRefreshToken` rows. Everything below is blocked until
this passes.

---

## 2. Second boot — the refresh cadence

Stop with Ctrl+C, wait for graceful shutdown, then start again.

**Watch for:**
```
[TokenManager] Token check complete {"refreshed":[],"skipped":["bot","broadcaster"]}
```

**Pass:** the second boot refreshes **nothing**. This is the whole point of the token
work — if it refreshes again, the expiry rows are not persisting and that needs
reporting before anything goes live.

Also confirm the boot health check ran: the tokens it skipped get validated once, so
a revoked-but-unexpired token would surface here rather than mid-stream.

---

## 3. Chat round-trip

In your own chat, with the bot running:

- [ ] **Static command** — any existing text command returns its response.
- [ ] **Emote trigger** — an exact emote trigger gets its reply.
- [ ] **Stats command** — `!stats` returns numbers, not an error.
- [ ] **AI mention** — say something that mentions the bot by name. It replies, and
      the reply is prefixed with a usage counter like `(1/15)`.
- [ ] **The command/AI precedence fix** — send `!stats almosthadai`. It must run the
      **stats command**, not the AI. This was a real bug: any command naming the bot
      used to be swallowed by the AI path and burn the sender's rate limit.
- [ ] **Permission gate** — as a non-mod (a second account, or ask someone), try
      `!skip`. It must do nothing. As a mod it must work.

**Pass:** all six behave as described.

---

## 4. AI toggle latency

- [ ] `!ai off` — confirmation in chat.
- [ ] **Immediately** mention the bot. It must **not** reply.
- [ ] `!ai on`, mention again. It replies.

**Pass:** the toggle takes effect at once. It used to take up to a minute because the
cache was never invalidated.

---

## 5. Redis-down fallback

Stop Redis (or comment out `REDIS_*` in `.env`) and restart the bot.

- [ ] Log says `Redis unavailable - running in fallback mode (direct MySQL)`.
- [ ] Commands still respond.
- [ ] Emotes still respond.
- [ ] Chat messages still land in `chat_messages` — check with:
      ```sql
      SELECT COUNT(*) FROM chat_messages WHERE stream_id = (
        SELECT stream_id FROM streams ORDER BY start_time DESC LIMIT 1
      );
      ```
      The count should climb as you talk.

**Pass:** no functional loss with Redis down, only the caching and queueing.

Restart Redis afterwards.

---

## 6. Songs and quotes

Requires channel-point rewards to exist and Spotify to be authorized.

- [ ] **Quote redemption** — redeem "Add a quote" with a correctly formatted quote.
      It saves and confirms in chat.
- [ ] **Bad quote redemption** — redeem with malformed input. It is **refunded** and
      the chat message says so.
- [ ] **Song request** — redeem "Song Request" with a Spotify link. It confirms, and
      the row appears:
      ```sql
      SELECT track_name, artist_name, queue_position FROM song_queue ORDER BY queue_position;
      ```
- [ ] **Bad song request** — redeem with a non-Spotify link. Refunded, with a message.
- [ ] **Pause check** — with a track playing and a song queued, pause Spotify near the
      end of the current track and leave it paused for ~30 seconds. The queue must
      **not** drain. Previously every 3-second tick shovelled another song into
      Spotify and deleted its row.
- [ ] **Advance check** — resume. When the track ends, the queued song plays and its
      row disappears from `song_queue`.

**Pass:** every refund path refunds, and the queue only advances while playing.

**If Spotify auth has expired** you will see `SPOTIFY RE-AUTHORIZATION REQUIRED` and
the monitors will not start — by design, rather than polling a dead API forever. Song
redemptions still refund gracefully. Re-authorize and repeat this section.

---

## 7. Backups

Debug mode skips backups, so this needs a normal run. **Do this last** and be ready
to stop it.

```bash
npm start
```

- [ ] A `stream-start` backup runs at startup (only if the stream is live; otherwise
      the bot sits in minimal mode and you can skip to §8).
- [ ] Log shows `[DbBackupManager] Backup verified` with a plausible size **before**
      the upload line.
- [ ] The object appears in the S3 bucket under `database-backups/`.
- [ ] Download it and confirm it ends with `-- Dump completed`.

**Pass:** the dump verifies, uploads, and is complete.

The verification gate is new: a dump that fails verification uploads nothing **and
does not rotate**, so a bad dump can no longer age out your good backups.

---

## 8. Shutdown

Ctrl+C the running bot.

**Watch for, in this order:**

1. Stream data saved / sessions ended.
2. Intervals and timers cleared.
3. API server stopped (if it was enabled).
4. `Draining Redis queues before shutdown` → `Redis queues drained successfully`.
   A warning that they did **not** drain is honest reporting, not a failure of the
   shutdown itself — but note it if you see it.
5. **Final backup taken — after the drain**, so it includes the analytics just flushed.
6. Database connection closed.
7. `=== Graceful shutdown complete ===` and the process exits.

**Pass:** the order is as above, the process exits on its own, and nothing hangs.

---

## 9. Lifecycle transitions (optional, needs a real stream)

The one thing nothing else covers, because it needs Twitch to actually change state.
Worth doing once before relying on the bot unattended, since this is the path that
never worked.

- [ ] Start the bot while **offline**. It reports minimal mode and waits.
- [ ] **Go live.** The bot must take the **online** transition: "Stream went online",
      full operation starts, greeting posted. It must **not** start a shutdown timer.
      (This was inverted — going live used to run the offline teardown.)
- [ ] Chat and redemptions work.
- [ ] **End the stream.** The bot tears down to minimal mode and reports the
      auto-shutdown timer starting.
- [ ] **Go live again** within the grace period. The timer is cancelled and full
      operation restarts — with chat and redemptions working again, which is the
      other half of the old bug.
- [ ] Check for monitor leaks after that second cycle:
      ```sql
      SELECT COUNT(*) FROM song_queue;
      ```
      Queue a song and confirm it is consumed **once**, not twice.

**Pass:** both transitions go the right way and a second cycle behaves like the first.

---

## Result

| § | Check | Pass/Fail |
|---|---|---|
| 1 | First boot reaches operational | |
| 2 | Second boot refreshes nothing | |
| 3 | Chat round-trip incl. command precedence and permissions | |
| 4 | AI toggle immediate | |
| 5 | Redis-down fallback | |
| 6 | Songs and quotes, refunds, pause gate | |
| 7 | Backup verified and uploaded | |
| 8 | Clean ordered shutdown | |
| 9 | Lifecycle transitions (optional) | |

Report results back with the relevant log lines. Phase 0 exits when §1–8 pass; §9 is
strongly recommended before leaving the bot running unattended.
