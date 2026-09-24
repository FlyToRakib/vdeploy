CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"database_id" text NOT NULL,
	"server_id" text NOT NULL,
	"kind" text DEFAULT 'dump' NOT NULL,
	"reason" text DEFAULT 'manual' NOT NULL,
	"status" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer,
	"sha256" text,
	"verified" boolean DEFAULT false NOT NULL,
	"error" text,
	"log" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_database_created" ON "backups" USING btree ("database_id","created_at");