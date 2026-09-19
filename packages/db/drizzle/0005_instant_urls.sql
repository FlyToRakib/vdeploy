CREATE TABLE "url_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "instant_host" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "previous_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "public_ipv4" text;--> statement-breakpoint
ALTER TABLE "url_settings" ADD CONSTRAINT "url_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_instant_host_live" ON "projects" USING btree ("instant_host") WHERE "projects"."deleted_at" is null;