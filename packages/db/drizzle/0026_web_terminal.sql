CREATE TABLE "terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"replica" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"recording" text DEFAULT '' NOT NULL,
	"recorded_bytes" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_sessions_project_opened" ON "terminal_sessions" USING btree ("project_id","opened_at");