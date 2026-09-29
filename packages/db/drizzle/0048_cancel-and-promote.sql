ALTER TABLE "plans" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "promoted_release" text;