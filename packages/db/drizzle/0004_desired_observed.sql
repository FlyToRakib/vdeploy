CREATE TABLE "observed_state" (
	"server_id" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"report" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "running" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "desired_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "observed_state" ADD CONSTRAINT "observed_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;