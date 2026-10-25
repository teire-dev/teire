CREATE TABLE "system_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The /trust page shows the worker's heartbeat, model failover and credit state (S10).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT ON TABLE system_state TO teire_web;
  END IF;
END
$$;
