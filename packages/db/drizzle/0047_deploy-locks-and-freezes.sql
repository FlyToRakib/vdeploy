CREATE TABLE "deploy_freezes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"window" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deploy_lock" jsonb;--> statement-breakpoint
ALTER TABLE "deploy_freezes" ADD CONSTRAINT "deploy_freezes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;