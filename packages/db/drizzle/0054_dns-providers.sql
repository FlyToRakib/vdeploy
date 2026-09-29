CREATE TABLE "dns_providers" (
	"org_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"credentials_sealed" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_providers" ADD CONSTRAINT "dns_providers_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;