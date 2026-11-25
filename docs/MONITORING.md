# Monitoring — metrics endpoint, Prometheus and Grafana

## The endpoint
* **Not on the public API port.** Metrics are served by a separate listener: `METRICS_PORT` (API process) and `WORKER_METRICS_PORT` (worker process). Both are **disabled unless set**.
* **Loopback by default** (`METRICS_HOST=127.0.0.1`). If you bind a private-network address, `METRICS_TOKEN` (≥ 24 random characters) is **required** — the process refuses to start otherwise, and `check:config` (run at production start) reports it. Prometheus sends `Authorization: Bearer <token>`; the comparison is constant-time. Only `GET /metrics` answers (anything else is 404, a missing/wrong token 401).
* Keep it on a private network / behind your orchestrator's network policy; never publish it through the public load balancer.

## What is exposed (all `leadflow_*` unless noted)
| Area | Metrics |
|---|---|
| HTTP | `http_requests_total{method,route,status}`, `http_request_duration_seconds` (histogram, `method,route,status_class`), `http_errors_total{route,class}`, `http_requests_in_flight` |
| Database | `prisma_client_queries_total`, `prisma_client_queries_duration_histogram_ms`, `prisma_pool_connections_{open,busy,idle}`, wait-time histogram (both clients, label `client="app"|"platform"`); `db_errors_total{code}` (Prisma error codes surfaced to requests) |
| Redis / queue | `redis_up`, `queue_jobs{state=waiting|active|failed|delayed|completed}` |
| Workers / scheduler | `workers_alive`, `scheduler_last_run_age_seconds`, `scheduler_stale`, `jobs_processed_total{job,result}`, `job_duration_seconds{job}`, `job_retries_total{job}` |
| Application | `workspaces{status}`, `leads` (sum of the latest daily usage snapshots — approximate), `users`, `sessions_active` (a count, no identities), `import_jobs{status}`, `import_rows_total{result}`, `import_batch_duration_seconds`, `lead_search_total{strategy}`, `sso_logins_total{result}` |
| Storage | `storage_operations_total{op,result}`, `storage_operation_duration_seconds{op}` |
| Process | Node.js defaults (`leadflow_process_*`, `leadflow_nodejs_*`: CPU, memory, event-loop lag, GC) |

Notes: queue/worker/scheduler gauges are **cluster-wide** and every instance reports the same value — use `max()` in alerts. Database-backed gauges (workspaces, leads, users, sessions, imports) are read with the platform role (no access to CRM rows; `import_jobs` is readable by its `status` column only) and cached for 30 s.

## Safety properties (tested in `test/metrics.test.ts`)
Route labels are **patterns** (`/api/leads/:id`), unmatched URLs collapse into `unmatched`; 120 hostile/random URLs add at most two series. Labels are a closed set (`method, route, status, status_class, class, code, op, result, job, strategy, state, service`). The output contains no e-mail address, UUID, name, search term, file name, token or connection string (asserted against traffic carrying such values).

## Connecting Prometheus and Grafana
Files in `deploy/monitoring/`: `prometheus.yml` (scrape config with bearer token file), `alerts.yml` (down, 5xx rate, p95 latency, no worker, stale scheduler, failed-job growth, queue backlog, Redis down, DB pool saturation, storage failures, import failures), `grafana-dashboard.json` (20 panels; import via Dashboards → Import, pick your Prometheus data source). Steps: set `METRICS_PORT`/`WORKER_METRICS_PORT`, `METRICS_HOST` (private address) and `METRICS_TOKEN`; put the token in the file referenced by `credentials_file`; list the targets; reload Prometheus; import the dashboard.

## Validation status
Implemented and tested in-process (endpoint protection, counters, cardinality, secrecy, scrape gauges against real PostgreSQL and Redis). **Not verified here:** a real Prometheus scraping it, the alert expressions firing, the Grafana dashboard rendering (the YAML/JSON files are syntax-checked only). Treat the files as a starting point and validate them in staging.
