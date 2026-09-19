-- Audit records and releases are never changed or removed by application
-- code. This is enforced here so that no bug, no compromised API process and
-- no future contributor can quietly rewrite history.
CREATE FUNCTION vdeploy_refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION vdeploy_refuse_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION vdeploy_refuse_mutation();
--> statement-breakpoint
CREATE TRIGGER releases_immutable
  BEFORE UPDATE ON releases
  FOR EACH ROW EXECUTE FUNCTION vdeploy_refuse_mutation();
