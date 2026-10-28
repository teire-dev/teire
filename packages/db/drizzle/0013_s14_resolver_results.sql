CREATE TABLE "resolver_results" (
	"key" text PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"commit" text NOT NULL,
	"tarball_sha256" text,
	"state" text NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resolver_results_repo_idx" ON "resolver_results" USING btree ("repo_id");