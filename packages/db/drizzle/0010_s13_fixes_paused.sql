ALTER TABLE "repos" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "fixes_paused" boolean DEFAULT false NOT NULL;