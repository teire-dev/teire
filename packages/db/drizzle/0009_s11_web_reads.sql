-- Every table the web reads (S11 surfaces: scan reports, runs, the dashboard, provider and package
-- pages), granted explicitly instead of relying on how the role was first created. SELECT only:
-- the web writes nothing but auth rows, outbox deliveries and public-scan requests (0002, 0004, 0008).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teire_web') THEN
    GRANT SELECT ON TABLE
      installations, user_installations, repos, scans, findings, changes, providers, provider_sources,
      dependency_instances, registry_cache, runs, run_events, llm_calls, sandbox_execs, artifacts, public_scans, system_state
    TO teire_web;
  END IF;
END
$$;
