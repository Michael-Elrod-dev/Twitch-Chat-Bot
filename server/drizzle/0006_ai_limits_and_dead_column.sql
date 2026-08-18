-- Per-role AI budgets, and the removal of a column that never told the truth.

-- ---------------------------------------------------------------------------
-- 1. The AI limits the settings screen edits.
--
-- Until now these lived only in `DEFAULT_STREAM_LIMITS`, a constant captured by
-- the rate limiter at construction. That made them unreachable from the app in
-- two separate ways: nothing stored them, and nothing could have told a running
-- session if something had. Putting them on `channel_settings` fixes both at
-- once — the row the session already reads through a cache it already
-- invalidates on write, so a change takes effect without a restart and without
-- a new notification path to forget to call.
--
-- Defaults are exactly the constant's values, so this migration changes no
-- channel's behavior: every existing channel keeps the budget it has been
-- running with, and the screen opens on the truth rather than on a proposal.
--
-- The broadcaster's tier is absent on purpose. It is unlimited, the screen
-- renders the word rather than a stepper, and a column would only invite
-- someone to set it to three.
ALTER TABLE "channel_settings"
    ADD COLUMN IF NOT EXISTS "ai_limit_everyone" integer DEFAULT 5 NOT NULL,
    ADD COLUMN IF NOT EXISTS "ai_limit_vip" integer DEFAULT 10 NOT NULL,
    ADD COLUMN IF NOT EXISTS "ai_limit_subscriber" integer DEFAULT 15 NOT NULL,
    ADD COLUMN IF NOT EXISTS "ai_limit_moderator" integer DEFAULT 15 NOT NULL;

-- Zero is a legitimate setting (AI off for that tier, on for the ones above),
-- so the floor is 0 and not 1. The ceiling is a fat-finger guard on a stepper,
-- not a policy. Enforced in the database as well as in the schema for the same
-- reason the status check exists: anything writing SQL directly bypasses zod.
-- Wrapped, because `ADD CONSTRAINT` has no `IF NOT EXISTS`. Every other
-- statement in this file is already re-runnable, and a migration that is
-- idempotent in three statements out of four is one failed deploy away from
-- being unrepeatable exactly when someone needs to repeat it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'channel_settings_ai_limits_check'
    ) THEN
        ALTER TABLE "channel_settings"
            ADD CONSTRAINT "channel_settings_ai_limits_check"
            CHECK (
                "ai_limit_everyone" BETWEEN 0 AND 10000
                AND "ai_limit_vip" BETWEEN 0 AND 10000
                AND "ai_limit_subscriber" BETWEEN 0 AND 10000
                AND "ai_limit_moderator" BETWEEN 0 AND 10000
            );
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. What a built-in command does, in the streamer's words.
--
-- A handler-backed row has no `response_text` to show in the app's reply
-- column, so the content screens rendered the sentence from a map living in the
-- desktop client — and a built-in added on the server showed a generic
-- placeholder until somebody edited that file.
--
-- The description now travels with the handler's registration and is written
-- onto the row at session load, exactly as `user_level` already is: the
-- declaration is the truth and the table is corrected to match it. Nullable,
-- because a static command has nothing to describe beyond its own reply, and
-- because a handler-backed row is only filled in once its session has started.
ALTER TABLE "commands"
    ADD COLUMN IF NOT EXISTS "description" text;

-- ---------------------------------------------------------------------------
-- 3. `streams.unique_chatters` — dropped, not backfilled.
--
-- Nothing has ever written it. The repository grew a `setUniqueChatters` method
-- that acquired no callers, so the column has read 0 for every stream ever
-- recorded, including the imported Phase-0 history. The dashboard already
-- refuses to read it and says why in a comment; the analytics streams table
-- would have been the second query to trip over the same zero.
--
-- Dropping rather than backfilling, following the `viewers.context` precedent:
-- the honest source is `chat_messages`, which is where both readers now count
-- distinct chatters from. A column that lies is worse than an absent one — an
-- absent one cannot be picked up in good faith by the next query that needs it.
--
-- Nothing is lost. There is no data here to lose: every row holds the default.
ALTER TABLE "streams" DROP COLUMN IF EXISTS "unique_chatters";
