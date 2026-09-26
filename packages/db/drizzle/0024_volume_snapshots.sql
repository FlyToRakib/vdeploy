ALTER TABLE "backups" ALTER COLUMN "database_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "restores" ALTER COLUMN "database_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "volumes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_project_created" ON "backups" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_one_subject" CHECK (("backups"."database_id" is null) <> ("backups"."project_id" is null));--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_one_target" CHECK (("restores"."database_id" is null) <> ("restores"."project_id" is null));