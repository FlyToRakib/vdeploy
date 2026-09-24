CREATE TABLE "database_keys" (
	"database_id" text PRIMARY KEY NOT NULL,
	"wrapped" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_links" (
	"database_id" text NOT NULL,
	"project_id" text NOT NULL,
	"env_key" text NOT NULL,
	"secret_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"version" text NOT NULL,
	"image" text NOT NULL,
	"port" integer NOT NULL,
	"user" text NOT NULL,
	"db_name" text,
	"memory_limit" text NOT NULL,
	"disk_size" text NOT NULL,
	"running" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"password_sealed" text NOT NULL,
	"password_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "database_keys" ADD CONSTRAINT "database_keys_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_links_unique" ON "database_links" USING btree ("database_id","project_id","env_key");--> statement-breakpoint
CREATE INDEX "database_links_project" ON "database_links" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "databases_server_name" ON "databases" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "databases_org" ON "databases" USING btree ("org_id");