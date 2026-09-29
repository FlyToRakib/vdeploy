ALTER TABLE "servers" ADD COLUMN "agent_binary_sha" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_schema_sha" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "update_channel" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_update_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_update_error" text;