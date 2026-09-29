CREATE TABLE "custom_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"base" text NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_custom_roles" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_custom_roles" ADD CONSTRAINT "member_custom_roles_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_custom_roles" ADD CONSTRAINT "member_custom_roles_role_id_custom_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_roles_org_name" ON "custom_roles" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "member_custom_roles_org_user" ON "member_custom_roles" USING btree ("org_id","user_id");