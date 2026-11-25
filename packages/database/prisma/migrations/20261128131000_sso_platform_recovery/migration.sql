-- Break-glass: a platform administrator can switch a workspace's SSO off (e.g. the identity provider is broken and nobody can sign in).
-- Column-level grants only: the platform role can flip two booleans and nothing else of a connection.
GRANT UPDATE (enabled, enforce_sso) ON sso_connections TO leadflow_platform;
