-- A running scan's heartbeat (S19 review B4): scans with scan-time sandbox probes can run longer than
-- the old 45-minute age limit, so the reaper now fails a scan only after 10 minutes of silence.
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone;
