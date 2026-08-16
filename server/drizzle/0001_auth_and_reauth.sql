CREATE TABLE "app_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"twitch_user_id" text NOT NULL,
	"login" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_status_check";--> statement-breakpoint
CREATE UNIQUE INDEX "app_refresh_tokens_token_hash_key" ON "app_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "app_refresh_tokens_user_idx" ON "app_refresh_tokens" USING btree ("twitch_user_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_status_check" CHECK ("channels"."status" in ('active', 'suspended', 'disconnected', 'needs_reauth'));