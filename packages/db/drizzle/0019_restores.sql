CREATE TABLE "restores" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"backup_id" text NOT NULL,
	"database_id" text NOT NULL,
	"server_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"log" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restores_database_created" ON "restores" USING btree ("database_id","created_at");