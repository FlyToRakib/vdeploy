CREATE TABLE "status_page_entries" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"label" text NOT NULL,
	"position" text DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"org_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "uptime_changes" (
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"up" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_page_entries" ADD CONSTRAINT "status_page_entries_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_entries" ADD CONSTRAINT "status_page_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_changes" ADD CONSTRAINT "uptime_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_changes" ADD CONSTRAINT "uptime_changes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_page_entries_org" ON "status_page_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "uptime_changes_project" ON "uptime_changes" USING btree ("project_id","at");