-- The desktop header's bot master switch.

-- A new column, deliberately not a fifth value of `status`.
--
-- `status` records what the world did to a channel, meaning Twitch withdrawing
-- consent (`needs_reauth`), or an administrative `suspended` or `disconnected`.
-- `enabled` records what the owner chose. Conflating them would make the app
-- lie in both directions. A bot the broadcaster paused would report itself
-- broken, and a bot Twitch cut off would report itself merely paused. The
-- recovery paths differ too, since one is a toggle and the other is a
-- re-authorization.
--
-- Defaults true so every existing channel keeps running across this migration,
-- because a schema change must never silently switch a live bot off.
ALTER TABLE "channels"
    ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;

-- Boot reads "active AND enabled" to decide which sessions to start, so the
-- index that already covers `status` is no longer selective enough on its own.
CREATE INDEX IF NOT EXISTS "channels_status_enabled_idx"
    ON "channels" ("status", "enabled");
