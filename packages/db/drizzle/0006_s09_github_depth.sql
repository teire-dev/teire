CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"change_id" text,
	"group_key" text,
	"login" text NOT NULL,
	"reason" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "ci_repair_sha" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "ignores" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "paused_from" text;--> statement-breakpoint
CREATE INDEX "feedback_repo_idx" ON "feedback" USING btree ("repo_id","created_at");