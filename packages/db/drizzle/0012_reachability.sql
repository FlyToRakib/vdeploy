ALTER TABLE "servers" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "reachability" jsonb;