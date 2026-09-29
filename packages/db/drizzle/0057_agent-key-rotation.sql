ALTER TABLE "servers" ADD COLUMN "agent_public_key_next" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_key_rotated_at" timestamp with time zone;