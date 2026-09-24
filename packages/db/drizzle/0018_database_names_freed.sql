DROP INDEX "databases_server_name";--> statement-breakpoint
CREATE UNIQUE INDEX "databases_server_name_live" ON "databases" USING btree ("server_id","name") WHERE "databases"."deleted_at" is null;