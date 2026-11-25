-- The platform health page reports how many migrations are applied; the platform role could not read the (non-sensitive) migration table, so it always showed 0.
GRANT SELECT ON TABLE _prisma_migrations TO leadflow_platform;
