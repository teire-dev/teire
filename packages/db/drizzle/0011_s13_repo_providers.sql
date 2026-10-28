CREATE TABLE "repo_providers" (
	"repo_id" bigint NOT NULL,
	"provider_slug" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_providers_repo_id_provider_slug_pk" PRIMARY KEY("repo_id","provider_slug")
);
--> statement-breakpoint
CREATE INDEX "repo_providers_slug_idx" ON "repo_providers" USING btree ("provider_slug");