ALTER TABLE "secrets" ADD COLUMN "generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "agent_box_key" text;