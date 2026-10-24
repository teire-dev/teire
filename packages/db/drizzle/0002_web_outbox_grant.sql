-- The web app's role (teire_web) reads everything it shows and writes exactly one thing: verified
-- GitHub webhook deliveries into the outbox (plan: webhooks → outbox, NOTIFY). Guarded so a database
-- without the role (local development) still migrates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT INSERT ON TABLE webhook_deliveries TO teire_web;
  END IF;
END
$$;
