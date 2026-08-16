CREATE TABLE "channel_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reward_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_rewards_kind_check" CHECK ("channel_rewards"."kind" in ('song_request', 'skip_queue', 'add_quote'))
);
--> statement-breakpoint
ALTER TABLE "channel_rewards" ADD CONSTRAINT "channel_rewards_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_rewards_channel_kind_key" ON "channel_rewards" USING btree ("channel_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_rewards_channel_reward_key" ON "channel_rewards" USING btree ("channel_id","reward_id");