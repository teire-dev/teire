CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester" text NOT NULL,
	"installation_id" bigint,
	"repo_id" bigint,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"result" text,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "default_fix_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "security_fix_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "fix_mode" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "actions_requester_key_idx" ON "actions" USING btree ("requester","idempotency_key");--> statement-breakpoint
CREATE INDEX "actions_repo_idx" ON "actions" USING btree ("repo_id","created_at");--> statement-breakpoint
-- A repository whose fixes were paused keeps that as fix mode Off (D124).
UPDATE "repos" SET "fix_mode" = 'off' WHERE "fixes_paused" = true;
--> statement-breakpoint
-- The web app records a person's action with its outbox delivery and reads it back (D121); the worker
-- moves it to its outcome. Guarded so a database without the role (local development) still migrates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT, INSERT ON TABLE actions TO teire_web;
  END IF;
END
$$;
