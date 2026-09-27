ALTER TABLE "metric_samples" ADD COLUMN "requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD COLUMN "failures" bigint DEFAULT 0 NOT NULL;