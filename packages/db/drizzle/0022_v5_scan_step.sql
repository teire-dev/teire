-- Where a running public scan is (V5–V6 review): the report's flow lights this step.
ALTER TABLE "public_scans" ADD COLUMN IF NOT EXISTS "step" text;
