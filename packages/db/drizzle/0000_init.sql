CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"change_key" text DEFAULT '' NOT NULL,
	"number" integer,
	"branch" text,
	"head_sha" text,
	"state" text DEFAULT 'open' NOT NULL,
	"url" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_slug" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"deadline" timestamp with time zone,
	"status" text NOT NULL,
	"content_hash" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"change_id" text NOT NULL,
	"change_hash" text NOT NULL,
	"scan_id" uuid,
	"verdict" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"call_sites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"avatar_url" text,
	"repository_selection" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"purpose" text NOT NULL,
	"step" text,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cached" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_slug" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'stale' NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_hash" text,
	"last_checked_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo_id" bigint,
	"scan_id" uuid,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" bigint PRIMARY KEY NOT NULL,
	"installation_id" bigint,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"config" jsonb,
	"config_source" text,
	"languages" jsonb,
	"last_scanned_sha" text,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"step" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid,
	"repo_id" bigint NOT NULL,
	"change_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"outcome" text,
	"confidence" real,
	"backend" text,
	"diff" text,
	"verification" jsonb,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"idempotency_key" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"requested_by" text,
	"error" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_execs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"phase" text NOT NULL,
	"command" text NOT NULL,
	"exit_code" integer,
	"timed_out" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"stdout_tail" text,
	"stderr_tail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"sha" text,
	"trigger" text NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"catalog_version" text,
	"coverage" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_installations" (
	"user_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_installations_user_id_installation_id_pk" PRIMARY KEY("user_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"guid" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" bigint,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_repo_kind_change_idx" ON "artifacts" USING btree ("repo_id","kind","change_key");--> statement-breakpoint
CREATE INDEX "changes_provider_idx" ON "changes" USING btree ("provider_slug");--> statement-breakpoint
CREATE INDEX "changes_deadline_idx" ON "changes" USING btree ("deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_repo_change_idx" ON "findings" USING btree ("repo_id","change_id");--> statement-breakpoint
CREATE INDEX "findings_repo_state_idx" ON "findings" USING btree ("repo_id","state");--> statement-breakpoint
CREATE INDEX "llm_calls_run_idx" ON "llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_sources_url_idx" ON "provider_sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "provider_sources_provider_idx" ON "provider_sources" USING btree ("provider_slug");--> statement-breakpoint
CREATE INDEX "public_scans_requester_idx" ON "public_scans" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_full_name_idx" ON "repos" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "repos_installation_idx" ON "repos" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_idx" ON "runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "runs_repo_idx" ON "runs" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_execs_run_idx" ON "sandbox_execs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "scans_repo_idx" ON "scans" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("processed_at","received_at");