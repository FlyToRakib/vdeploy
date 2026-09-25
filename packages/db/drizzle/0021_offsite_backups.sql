CREATE TABLE "backup_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"offsite_dismissed_at" timestamp with time zone,
	"offsite_dismissed_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_target_keys" (
	"target_id" text PRIMARY KEY NOT NULL,
	"wrapped" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text DEFAULT 's3' NOT NULL,
	"repository" text NOT NULL,
	"region" text,
	"password_sealed" text NOT NULL,
	"access_key_sealed" text NOT NULL,
	"secret_key_sealed" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"check_server_id" text,
	"check_id" text,
	"checked_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "offsite_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "offsite_snapshot" text;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "offsite_error" text;--> statement-breakpoint
ALTER TABLE "backup_settings" ADD CONSTRAINT "backup_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target_keys" ADD CONSTRAINT "backup_target_keys_target_id_backup_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_targets" ADD CONSTRAINT "backup_targets_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_targets" ADD CONSTRAINT "backup_targets_check_server_id_servers_id_fk" FOREIGN KEY ("check_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_targets_org_live" ON "backup_targets" USING btree ("org_id") WHERE "backup_targets"."deleted_at" is null;