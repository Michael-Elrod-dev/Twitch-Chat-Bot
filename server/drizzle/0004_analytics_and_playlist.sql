-- P1-WP4.3 — analytics, viewers & the requests-playlist foundation.

-- The requests playlist, elevated by the owner to a core feature. Default OFF:
-- saving a viewer's request somewhere the streamer never asked for is a
-- surprise, and the naming/creation UX ships with the app's settings screen.
ALTER TABLE "channel_settings"
    ADD COLUMN IF NOT EXISTS "requests_playlist_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "channel_settings"
    ADD COLUMN IF NOT EXISTS "requests_playlist_name" text;
ALTER TABLE "channel_settings"
    ADD COLUMN IF NOT EXISTS "requests_playlist_id" text;

-- What has already been appended, and the whole reason the Phase-0 hot-path
-- sin does not return: dedup is a unique index, not a full playlist paging
-- read on every redemption.
CREATE TABLE IF NOT EXISTS "playlist_additions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
    "playlist_id" text NOT NULL,
    "track_uri" text NOT NULL,
    "added_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "playlist_additions_channel_playlist_track_key"
    ON "playlist_additions" ("channel_id", "playlist_id", "track_uri");
