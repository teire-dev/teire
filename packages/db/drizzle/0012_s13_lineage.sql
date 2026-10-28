ALTER TABLE "artifacts" ADD COLUMN "lineage_key" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "lineage_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lineage_key" text;--> statement-breakpoint
CREATE INDEX "artifacts_lineage_idx" ON "artifacts" USING btree ("repo_id","lineage_key");--> statement-breakpoint
CREATE INDEX "findings_lineage_idx" ON "findings" USING btree ("repo_id","lineage_key");