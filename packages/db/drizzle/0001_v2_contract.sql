CREATE TABLE "advisory_cache" (
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"ids" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisory_cache_ecosystem_name_version_pk" PRIMARY KEY("ecosystem","name","version")
);
--> statement-breakpoint
CREATE TABLE "dependency_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"dependency_key" text NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"alias_name" text,
	"version" text,
	"declared_range" text,
	"direct" boolean NOT NULL,
	"scope" text NOT NULL,
	"workspace" text NOT NULL,
	"manifest_path" text NOT NULL,
	"lockfile_path" text,
	"source" text NOT NULL,
	"source_ref" text,
	"resolved_by" text NOT NULL,
	"unresolved_reason" text,
	"environment" jsonb
);
--> statement-breakpoint
CREATE TABLE "extraction_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"records" jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes_cache" (
	"repo_url" text NOT NULL,
	"ref" text NOT NULL,
	"path" text NOT NULL,
	"etag" text,
	"content_hash" text NOT NULL,
	"slices" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_cache_repo_url_ref_path_pk" PRIMARY KEY("repo_url","ref","path")
);
--> statement-breakpoint
CREATE TABLE "registry_cache" (
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"body_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_cache_ecosystem_name_pk" PRIMARY KEY("ecosystem","name")
);
--> statement-breakpoint
CREATE TABLE "sandbox_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"lockfile_hash" text NOT NULL,
	"image_digest" text NOT NULL,
	"backend" text NOT NULL,
	"ref" text NOT NULL,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_restored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "surface_diffs" (
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"tool" text NOT NULL,
	"tool_version" text NOT NULL,
	"noise_filter_version" text NOT NULL,
	"result" jsonb NOT NULL,
	"symbol_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "surface_diffs_ecosystem_name_from_version_to_version_tool_tool_version_noise_filter_version_pk" PRIMARY KEY("ecosystem","name","from_version","to_version","tool","tool_version","noise_filter_version")
);
--> statement-breakpoint
DROP INDEX "findings_repo_change_idx";--> statement-breakpoint
ALTER TABLE "changes" ALTER COLUMN "provider_slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "change_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "ecosystem" text;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "subject_name" text;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "class" text;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "from_version" text;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "to_version" text;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "dependency_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "class" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "reachability" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "position" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "catalog_version" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "last_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "from_version" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "target_version" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "replanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "evidence_kind" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pr_mode" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "base_sha" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lock_before_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lock_after_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "test_counts" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "egress_denied" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "env_differences" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "models_used" jsonb;--> statement-breakpoint
ALTER TABLE "sandbox_execs" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "sandbox_execs" ADD COLUMN "job_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_instances_scan_key_idx" ON "dependency_instances" USING btree ("scan_id","dependency_key","version");--> statement-breakpoint
CREATE INDEX "dependency_instances_repo_idx" ON "dependency_instances" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "dependency_instances_pkg_idx" ON "dependency_instances" USING btree ("ecosystem","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_snapshots_key_idx" ON "sandbox_snapshots" USING btree ("repo_id","lockfile_hash","image_digest","backend");--> statement-breakpoint
CREATE INDEX "changes_subject_idx" ON "changes" USING btree ("ecosystem","subject_name");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_repo_change_dep_idx" ON "findings" USING btree ("repo_id","change_id","dependency_key");--> statement-breakpoint
CREATE INDEX "findings_group_idx" ON "findings" USING btree ("repo_id","group_key");