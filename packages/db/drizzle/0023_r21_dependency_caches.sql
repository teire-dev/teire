-- A repository's saved download caches (R21.11): DirectoryBackup records in R2, per root.
CREATE TABLE IF NOT EXISTS "dependency_caches" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "repo_id" bigint NOT NULL,
  "ecosystem" text NOT NULL,
  "root" text NOT NULL,
  "record" jsonb NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "dependency_caches_key_idx" ON "dependency_caches" ("repo_id", "ecosystem", "root", "created_at");
