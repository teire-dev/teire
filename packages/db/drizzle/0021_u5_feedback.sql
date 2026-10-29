-- In-app feedback on a catalog change (plan revision 3.3, U5: "Wrong? Tell us", stored): a report
-- needs no repository, says who sent it and from where, and the web role can record one.
ALTER TABLE "feedback" ALTER COLUMN "repo_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'command' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_change_idx" ON "feedback" ("change_id", "created_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT, INSERT ON TABLE feedback TO teire_web;
  END IF;
END
$$;
