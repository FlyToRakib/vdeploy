CREATE TABLE "domain_checks" (
	"host" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"seen" jsonb DEFAULT '{"a":[],"aaaa":[]}'::jsonb NOT NULL,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "public_ipv6" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "address_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_checks_due" ON "domain_checks" USING btree ("next_check_at");