CREATE TABLE "registry_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"host" text NOT NULL,
	"username" text NOT NULL,
	"password_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_credentials" ADD CONSTRAINT "registry_credentials_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_credentials_org_host" ON "registry_credentials" USING btree ("org_id","host");