-- The web's role shares one connection limit across every Vercel instance, and the run page and the
-- welcome flow poll it ("too many connections for role teire_web" under a few open tabs). Raised to a
-- share Postgres's usual 100 connections can hold beside the worker's pools; skipped where the
-- migrating role may not alter roles, and on databases without the role (local development).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    BEGIN
      ALTER ROLE teire_web CONNECTION LIMIT 40;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'teire_web connection limit left as it is: %', SQLERRM;
    END;
  END IF;
END
$$;
