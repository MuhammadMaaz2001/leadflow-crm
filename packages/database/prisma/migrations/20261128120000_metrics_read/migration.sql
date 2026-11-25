-- Operational metrics: the platform role (no access to CRM data) may count import jobs by STATUS only — a single-column grant, no names, no rows of customers.
GRANT SELECT (status) ON import_jobs TO leadflow_platform;
