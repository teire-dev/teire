-- The public changes pages name each provider from its stored record (curated or discovered, D82),
-- so the web role reads `providers`. Guarded for databases without the role (local development).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT ON TABLE providers TO teire_web;
  END IF;
END
$$;
