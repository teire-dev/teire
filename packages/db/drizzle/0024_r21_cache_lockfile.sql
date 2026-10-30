-- The lockfile a saved download cache was installed from (R21.11), shown on the restoring run's receipt.
ALTER TABLE "dependency_caches" ADD COLUMN IF NOT EXISTS "lockfile_sha256" text;
