CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"database_id" text NOT NULL,
	"backup_id" text NOT NULL,
	"server_id" text NOT NULL,
	"status" text NOT NULL,
	"tables" integer,
	"error" text,
	"log" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "databases" ALTER COLUMN "backup_policy" SET DEFAULT '{"enabled":true,"expr":"0 3 * * *","timezone":"UTC","keepLocal":7,"keepOffsite":30,"verifyEveryDays":7}'::jsonb;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "verify_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verifications_database_created" ON "verifications" USING btree ("database_id","created_at");--> statement-breakpoint
-- Databases made before checks existed get the same schedule as new ones,
-- rather than a policy with a hole in it where the interval should be.
UPDATE "databases"
SET "backup_policy" = "backup_policy" || '{"verifyEveryDays":7}'::jsonb
WHERE NOT ("backup_policy" ? 'verifyEveryDays');
