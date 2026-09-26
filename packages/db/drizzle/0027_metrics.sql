CREATE TABLE "metric_samples" (
	"server_id" text NOT NULL,
	"project_id" text,
	"at" timestamp with time zone NOT NULL,
	"cpu_percent" double precision NOT NULL,
	"memory_bytes" bigint NOT NULL,
	"memory_limit" bigint NOT NULL,
	"disk_used_bytes" bigint,
	"disk_total_bytes" bigint,
	"rx_bytes" bigint DEFAULT 0 NOT NULL,
	"tx_bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metric_samples_project_at" ON "metric_samples" USING btree ("project_id","at");--> statement-breakpoint
CREATE INDEX "metric_samples_server_at" ON "metric_samples" USING btree ("server_id","at");