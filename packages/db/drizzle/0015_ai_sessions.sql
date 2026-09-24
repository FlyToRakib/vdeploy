CREATE TABLE "ai_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"session_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"title" text NOT NULL,
	"plain" text NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"model" text NOT NULL,
	"tainted" boolean DEFAULT false NOT NULL,
	"focus_project_id" text,
	"spend_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_focus_project_id_projects_id_fk" FOREIGN KEY ("focus_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_seq" ON "ai_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "ai_proposals_org" ON "ai_proposals" USING btree ("org_id","created_at");