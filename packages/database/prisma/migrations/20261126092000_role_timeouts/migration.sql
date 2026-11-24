-- Safety nets against runaway queries and leaked transactions. Role-level settings apply to every NEW connection of the role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadflow_app') THEN
    ALTER ROLE leadflow_app SET statement_timeout = '60s';
    ALTER ROLE leadflow_app SET lock_timeout = '15s';
    ALTER ROLE leadflow_app SET idle_in_transaction_session_timeout = '120s';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadflow_platform') THEN
    ALTER ROLE leadflow_platform SET statement_timeout = '30s';
    ALTER ROLE leadflow_platform SET lock_timeout = '15s';
    ALTER ROLE leadflow_platform SET idle_in_transaction_session_timeout = '60s';
  END IF;
END $$;
