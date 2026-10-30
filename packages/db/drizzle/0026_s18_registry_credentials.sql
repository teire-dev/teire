-- Private-registry credentials (S18.7, S-P20): one per installation and registry host, the secret
-- sealed with the worker's public key (only the worker opens it). The worker writes them, from an
-- admin's action; the web lists what exists and never reads a sealed value.
CREATE TABLE IF NOT EXISTS "registry_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "installation_id" bigint NOT NULL REFERENCES "installations"("id") ON DELETE CASCADE,
  "ecosystem" text NOT NULL,
  "host" text NOT NULL,
  "url" text,
  "kind" text NOT NULL,
  "username" text,
  "sealed" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_credentials_host_idx" ON "registry_credentials" ("installation_id", "ecosystem", "host");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT ("id", "installation_id", "ecosystem", "host", "url", "kind", "username", "created_by", "created_at", "updated_at", "last_used_at") ON TABLE registry_credentials TO teire_web;
  END IF;
END
$$;
