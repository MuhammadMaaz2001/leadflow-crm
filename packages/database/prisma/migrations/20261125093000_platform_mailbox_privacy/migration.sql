-- Platform administrators must not be able to read verification / reset / invitation links.
REVOKE SELECT ON outbound_emails FROM leadflow_platform;
GRANT INSERT ON outbound_emails TO leadflow_platform;
