ALTER TABLE "transfers" ALTER COLUMN "backup_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "role" text DEFAULT 'apps' NOT NULL;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "export_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "export_sha256" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "build_id" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_one_subject" CHECK (("transfers"."backup_id" is not null)::int + ("transfers"."build_id" is not null)::int = 1);