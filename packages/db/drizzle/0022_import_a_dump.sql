ALTER TABLE "restores" ALTER COLUMN "backup_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "upload_id" text;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "restores" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restores" ADD CONSTRAINT "restores_one_source" CHECK (("restores"."backup_id" is null) <> ("restores"."upload_id" is null));