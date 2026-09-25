ALTER TABLE "backups" ADD COLUMN "pruned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "backup_policy" jsonb DEFAULT '{"enabled":true,"expr":"0 3 * * *","timezone":"UTC","keepLocal":7,"keepOffsite":30}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "backup_checked_at" timestamp with time zone;