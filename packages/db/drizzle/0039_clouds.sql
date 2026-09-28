CREATE TABLE "cloud_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"token_sealed" text NOT NULL,
	"connected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "cloud_account_id" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "cloud_machine_id" text;--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_accounts_org" ON "cloud_accounts" USING btree ("org_id");