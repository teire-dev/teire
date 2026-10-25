ALTER TABLE "public_scans" ADD COLUMN "status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_scans" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "public_scans" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
-- Public scans (C9): a signed-in person's request is inserted by the web (its id is the report URL);
-- the worker fills in the scan. Reads for the report page and the per-person daily limit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT, INSERT ON TABLE public_scans TO teire_web;
  END IF;
END
$$;
