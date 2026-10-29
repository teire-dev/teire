-- Ask Teire (plan revision 3.3, U4): threads, their messages (UI parts as JSON), and a receipt per
-- reply, reserved before the model runs and settled after (its own budget, apart from fix runs, D127).
CREATE TABLE IF NOT EXISTS "assistant_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "installation_id" bigint,
  "title" text NOT NULL DEFAULT 'New thread',
  "context" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_threads_user_idx" ON "assistant_threads" ("user_id", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "assistant_threads"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "parts" jsonb NOT NULL,
  "metadata" jsonb,
  "status" text NOT NULL DEFAULT 'complete',
  "rating" smallint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_messages_thread_idx" ON "assistant_messages" ("thread_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_calls" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "thread_id" uuid,
  "message_id" text,
  "model" text NOT NULL,
  "tokens_in" integer DEFAULT 0 NOT NULL,
  "tokens_out" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
  "latency_ms" integer,
  "status" text DEFAULT 'reserved' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_calls_user_idx" ON "assistant_calls" ("user_id", "created_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE assistant_threads, assistant_messages TO teire_web;
    GRANT SELECT, INSERT, UPDATE ON TABLE assistant_calls TO teire_web;
    GRANT USAGE, SELECT ON SEQUENCE assistant_calls_id_seq TO teire_web;
  END IF;
END
$$;
