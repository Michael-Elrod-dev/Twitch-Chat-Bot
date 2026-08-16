# Migration Notes

Everything you need to know when deploying the Phase 0 codebase against an
**existing** database — including the restored production dump. `schema.sql` is
the definition for a *fresh* database; this file covers bringing an old one up to
match, plus the runtime behaviour that only happens on the first boot after deploy.

Read this before running `npm start` or `npm run debug` against real data.

---

## 1. First boot refreshes both Twitch tokens (expected, not an error)

Phase 0 changed token refresh from "rotate both tokens every 5 minutes" to
"rotate only when within 15 minutes of expiry". Expiry is tracked in two new rows
in the existing `tokens` table:

| `token_key` | Value |
|---|---|
| `botAccessTokenExpiresAt` | epoch milliseconds, as a string |
| `broadcasterAccessTokenExpiresAt` | epoch milliseconds, as a string |

**No schema change is needed for these** — they are ordinary key/value rows, created
by upsert on first write.

On the first boot after deploy those rows do not exist yet. Unknown expiry is
treated as "refresh now", so **both tokens refresh once during startup**. This is
correct and expected. From then on the 5-minute check reads the recorded expiry and
skips, settling at roughly **6 refreshes per day per token** instead of 288.

What you should see in the log on that first boot:

```
[TokenManager] No expiry recorded, refreshing {"type":"bot"}
[TokenManager] No expiry recorded, refreshing {"type":"broadcaster"}
[TokenManager] Token refreshed successfully {"type":"bot","expiresInMinutes":240}
[TokenManager] Token refreshed successfully {"type":"broadcaster","expiresInMinutes":240}
```

On the **second** boot (assuming under ~4 hours later) you should instead see:

```
[TokenManager] Token check complete {"refreshed":[],"skipped":["bot","broadcaster"]}
```

Two consequences worth knowing:

- Twitch rotates the refresh token on every refresh. That first-boot rotation is
  written atomically (one transaction covering access token, refresh token, expiry
  and account id), so an interrupted boot cannot strand you with a dead refresh
  token — but do let the first boot finish.
- **Restoring the dump again later re-triggers this**, because the restored rows
  predate the expiry rows. Also expected.

If a refresh fails because the stored refresh token is no longer valid, the log
says so explicitly:

```
[TokenManager] MANUAL RE-AUTHORIZATION REQUIRED - the refresh token is no longer valid
```

That one needs you to re-authorize the app with Twitch and update the
`botRefreshToken` / `broadcasterRefreshToken` rows by hand.

---

## 2. Schema ALTERs for an existing database

`schema.sql` now declares engine, charset and one new index explicitly. An existing
database very likely already matches on engine (InnoDB is the MySQL default), but
verify rather than assume — one Phase 0 correctness fix now depends on it.

### 2a. Check what you actually have

```sql
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE();
```

Anything not reading `InnoDB` / `utf8mb4_unicode_ci` needs the corresponding
statement below. If everything already matches, only §2c applies.

### 2b. Engine and charset

`song_queue` is the one that **matters for correctness**: `addToPendingQueue` uses
`SELECT ... FOR UPDATE` to stop two simultaneous song requests landing on the same
queue position. MyISAM ignores that lock silently — the query succeeds and the race
returns. The rest are for emoji support in chat messages, quotes and command text.

```sql
ALTER TABLE song_queue       ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE tokens           ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE emotes           ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE commands         ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE viewers          ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE streams          ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE viewing_sessions ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE chat_messages    ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE chat_totals      ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE quotes           ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE api_usage        ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`CONVERT TO CHARACTER SET` rewrites the table. On `chat_messages` (the largest table
by a wide margin) expect this to take a while and to need free disk roughly equal to
the table size. Take a backup first, and run it while the bot is stopped.

### 2c. New index on `chat_messages`

Analytics reads always filter by stream and then order or range by time, which
previously had no supporting index.

```sql
ALTER TABLE chat_messages ADD INDEX idx_stream_time (stream_id, message_time);
```

Also a rewrite of a large table — same caveats. Safe to defer; nothing breaks
without it, queries are just slower.

### 2d. `vip` added to the command level enum

Schema preparation only. Permission checks already handle levels declaratively, but
nothing writes `vip` yet and there is no chat syntax to set it (Phase 2).

```sql
ALTER TABLE commands
  MODIFY user_level ENUM('everyone', 'vip', 'mod', 'broadcaster') NOT NULL DEFAULT 'everyone';
```

Adding a value to an ENUM does not rewrite existing rows.

---

## 3. Command `user_level` rows are corrected automatically

Handler-backed commands (`!skip`, `!songs`, `!emoteadd`, `!ai`) now declare their
required level in code, and the level is enforced in exactly one place. On startup,
any `commands` row whose `user_level` disagrees with the handler's declaration is
**updated to match**, with a log line:

```
[CommandManager] Correcting stale user_level for handler command {"commandName":"!skip","was":"everyone","now":"mod"}
```

This is expected on the first boot against the old data, where those rows said
`everyone` while the real check lived inline in the handler. No action needed; it
happens once.

---

## 4. New environment variables

All optional — every one has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `DB_CONNECTION_LIMIT` | `10` | mysql2 pool size |
| `LOG_DIR` | `logs` | Log directory, relative to the repo root |

Two related knobs live in `src/config/config.js` rather than the environment,
alongside the other behaviour settings:

- `tokenRefreshSafetyMargin` (default 15 min) — how close to expiry a token must be
  before it is rotated. `tokenRefreshInterval` (5 min) is only how often we *check*.
- `logging.directory` — backs `LOG_DIR`.

---

## 5. Logs moved

Logs were written inside the source tree at `src/logger/logs/`. They now go to
`./logs/` at the repo root. Nothing reads the old location; delete it if it survived
a `git pull`. The stale `src/logger/config/` directory (audit files from a
`winston-daily-rotate-file` setup that was removed) is gone too.

---

## 6. Deploy checklist

1. Stop the bot.
2. Take a database backup.
3. Apply §2 (verify first — §2b may be a no-op).
4. Deploy the code, run `npm install` (dependency set changed; `ws` is now declared
   explicitly rather than arriving transitively).
5. Start with `npm run debug` first and walk `docs/SMOKE_TEST.md`.
6. Confirm the first-boot double token refresh in the log (§1).
7. Confirm the `user_level` correction lines if the old data is in place (§3).
8. Only then start normally.
