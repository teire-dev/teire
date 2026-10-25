-- Sign-in (Better Auth, Drizzle adapter) as the web role: exactly the operations the adapter issues on
-- its four tables, plus the user → installation mapping refreshed at sign-in. Guarded for databases
-- without the role (local development).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", "session", "account", "verification" TO teire_web;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_installations TO teire_web;
  END IF;
END
$$;
