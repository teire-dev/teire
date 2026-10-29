-- The repositories each signed-in person can access inside an installation (U3 review): GitHub's
-- `GET /user/installations/{id}/repositories` with their own token. A private repository's data is
-- shown only to people listed here; installation membership alone is visibility, not access.
CREATE TABLE IF NOT EXISTS "user_repos" (
  "user_id" text NOT NULL,
  "repo_id" bigint NOT NULL,
  "installation_id" bigint NOT NULL,
  "refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_repos_user_id_repo_id_pk" PRIMARY KEY ("user_id", "repo_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_repos_repo_idx" ON "user_repos" ("repo_id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT, INSERT, DELETE ON TABLE user_repos TO teire_web;
  END IF;
END
$$;
