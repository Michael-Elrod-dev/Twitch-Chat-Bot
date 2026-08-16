CREATE TABLE "bot_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_user_id" text NOT NULL,
	"twitch_login" text NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refresh_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_identity_twitch_user_id_unique" UNIQUE("twitch_user_id")
);
--> statement-breakpoint
CREATE TABLE "channel_settings" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"discord_webhook_url" text,
	"last_discord_notification_at" timestamp with time zone,
	"song_requests_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_tokens_provider_check" CHECK ("channel_tokens"."provider" in ('twitch', 'spotify'))
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_broadcaster_id" text NOT NULL,
	"twitch_login" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"onboarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" in ('active', 'suspended', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "editors" (
	"channel_id" uuid NOT NULL,
	"twitch_user_id" text NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editors_channel_id_twitch_user_id_pk" PRIMARY KEY("channel_id","twitch_user_id"),
	CONSTRAINT "editors_role_check" CHECK ("editors"."role" in ('owner', 'editor'))
);
--> statement-breakpoint
CREATE TABLE "channel_roles" (
	"channel_id" uuid NOT NULL,
	"twitch_user_id" text NOT NULL,
	"is_moderator" boolean DEFAULT false NOT NULL,
	"is_vip" boolean DEFAULT false NOT NULL,
	"is_subscriber" boolean DEFAULT false NOT NULL,
	"is_broadcaster" boolean DEFAULT false NOT NULL,
	"followed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_roles_channel_id_twitch_user_id_pk" PRIMARY KEY("channel_id","twitch_user_id")
);
--> statement-breakpoint
CREATE TABLE "streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"twitch_stream_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"title" text,
	"category" text,
	"peak_viewers" integer DEFAULT 0 NOT NULL,
	"total_messages" integer DEFAULT 0 NOT NULL,
	"unique_chatters" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewers" (
	"twitch_user_id" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewing_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"twitch_user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"twitch_user_id" text NOT NULL,
	"stream_id" uuid,
	"api_type" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"stream_id" uuid,
	"twitch_user_id" text NOT NULL,
	"message_type" text DEFAULT 'message' NOT NULL,
	"content" text,
	"message_time" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_messages_type_check" CHECK ("chat_messages"."message_type" in ('message', 'command', 'redemption'))
);
--> statement-breakpoint
CREATE TABLE "chat_totals" (
	"channel_id" uuid NOT NULL,
	"twitch_user_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"command_count" integer DEFAULT 0 NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_totals_channel_id_twitch_user_id_pk" PRIMARY KEY("channel_id","twitch_user_id")
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"response_text" text,
	"handler_name" text,
	"user_level" text DEFAULT 'everyone' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commands_user_level_check" CHECK ("commands"."user_level" in ('everyone', 'vip', 'mod', 'broadcaster'))
);
--> statement-breakpoint
CREATE TABLE "emotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"trigger_text" text NOT NULL,
	"response_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"quote_number" integer NOT NULL,
	"quote_text" text NOT NULL,
	"author" text,
	"saved_by_twitch_user_id" text,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "song_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"track_uri" text NOT NULL,
	"track_name" text,
	"artist_name" text,
	"requested_by_twitch_user_id" text,
	"requested_by_login" text,
	"queue_position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "channel_settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_tokens" ADD CONSTRAINT "channel_tokens_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editors" ADD CONSTRAINT "editors_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_roles" ADD CONSTRAINT "channel_roles_twitch_user_id_viewers_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewing_sessions" ADD CONSTRAINT "viewing_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewing_sessions" ADD CONSTRAINT "viewing_sessions_stream_id_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewing_sessions" ADD CONSTRAINT "viewing_sessions_twitch_user_id_viewers_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_twitch_user_id_viewers_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_stream_id_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_stream_id_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_twitch_user_id_viewers_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_totals" ADD CONSTRAINT "chat_totals_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_totals" ADD CONSTRAINT "chat_totals_twitch_user_id_viewers_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emotes" ADD CONSTRAINT "emotes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_saved_by_twitch_user_id_viewers_twitch_user_id_fk" FOREIGN KEY ("saved_by_twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_queue" ADD CONSTRAINT "song_queue_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_queue" ADD CONSTRAINT "song_queue_requested_by_viewers_fk" FOREIGN KEY ("requested_by_twitch_user_id") REFERENCES "public"."viewers"("twitch_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_tokens_channel_provider_key" ON "channel_tokens" USING btree ("channel_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_twitch_broadcaster_id_key" ON "channels" USING btree ("twitch_broadcaster_id");--> statement-breakpoint
CREATE INDEX "channels_status_idx" ON "channels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "channel_roles_channel_last_seen_idx" ON "channel_roles" USING btree ("channel_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "streams_channel_started_idx" ON "streams" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "streams_channel_twitch_stream_key" ON "streams" USING btree ("channel_id","twitch_stream_id");--> statement-breakpoint
CREATE INDEX "viewers_login_idx" ON "viewers" USING btree ("login");--> statement-breakpoint
CREATE INDEX "viewing_sessions_stream_user_idx" ON "viewing_sessions" USING btree ("stream_id","twitch_user_id");--> statement-breakpoint
CREATE INDEX "viewing_sessions_stream_open_idx" ON "viewing_sessions" USING btree ("stream_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_usage_channel_user_type_stream_key" ON "api_usage" USING btree ("channel_id","twitch_user_id","api_type","stream_id");--> statement-breakpoint
CREATE INDEX "chat_messages_channel_stream_time_idx" ON "chat_messages" USING btree ("channel_id","stream_id","message_time");--> statement-breakpoint
CREATE INDEX "chat_messages_channel_user_idx" ON "chat_messages" USING btree ("channel_id","twitch_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commands_channel_name_key" ON "commands" USING btree ("channel_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "emotes_channel_trigger_key" ON "emotes" USING btree ("channel_id","trigger_text");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_channel_number_key" ON "quotes" USING btree ("channel_id","quote_number");--> statement-breakpoint
CREATE INDEX "song_queue_channel_position_idx" ON "song_queue" USING btree ("channel_id","queue_position");