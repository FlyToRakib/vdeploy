ALTER TABLE "projects" ADD COLUMN "ignored_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "persistence" jsonb DEFAULT '[]'::jsonb NOT NULL;