-- A key stores the rate limit it was made with, and every key made before
-- this carries the auth library's default: ten requests a day. Those keys
-- are given the limit keys are made with now, a minute's window of 300.
UPDATE "apikey"
SET "rate_limit_time_window" = 60000, "rate_limit_max" = 300
WHERE "rate_limit_time_window" = 86400000 AND "rate_limit_max" = 10;
