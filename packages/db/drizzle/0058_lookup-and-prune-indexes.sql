CREATE INDEX "project_events_at" ON "project_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_target_action" ON "audit_log" USING btree ("target","action","occurred_at");--> statement-breakpoint
CREATE INDEX "metric_samples_at" ON "metric_samples" USING btree ("at");