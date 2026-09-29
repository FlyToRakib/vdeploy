-- A channel lists the triggers it was set up with, so a trigger added later
-- would reach nobody already here. Channels that took every default get the
-- new one too; a channel somebody pared down is left as they chose.
UPDATE "notification_channels"
SET "triggers" = "triggers" || '["folder_filling"]'::jsonb
WHERE "triggers" @> '["deploy_failed","app_crashing","health_failing","out_of_memory","server_offline","server_unreachable","ai_change_applied","backup_missed","backup_failed","disk_filling","certificate_not_renewing","autoscaled"]'::jsonb
  AND NOT "triggers" @> '["folder_filling"]'::jsonb;
