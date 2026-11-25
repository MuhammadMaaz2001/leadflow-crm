# Large-workspace lead search — investigation, design and benchmarks

Date: 2026-11-25 · Branch `claude/dreamy-sagan-nvy31g`

## 1. Investigation (what was measured before changing anything)
* **Query**: `GET /api/leads?q=…` builds, per whitespace-separated term, `first_name ILIKE %t% OR last_name … OR email … OR company_name … OR phone LIKE … [OR phone_normalized LIKE digits]`, ANDed over terms, plus scope (`assigned_to` for agents), `archived_at IS NULL`, `merged_into_id IS NULL` and the other filters; ordered by `created_at DESC`, `LIMIT/OFFSET`, plus a separate `count(*)`.
* **Indexes that already existed**: btree `(organization_id, …)` indexes and **GIN trigram indexes** on `first_name`, `last_name`, `email`, `company_name`, `phone` (migration 2).
* **Plan at 250,000 leads (rare term, as the runtime role under row level security)**: `Index Scan using leads_active_idx` with a `Filter` and **`Rows Removed by Filter: 249999`, 926 ms**. The trigram indexes were **never used**.
* **Root cause**: row level security. PostgreSQL must evaluate the tenant policy before any operator that is not *leakproof*, and `ILIKE`/`LIKE` (`texticlike`, `textlike`) are not (`SELECT proname, proleakproof FROM pg_proc` → `f`; `texteq`, `text_ge`, `text_lt` are `t`; `ts_match_vq`, i.e. full-text `@@`, is also `f`). So a trigram **or** full-text index cannot be used by the application role, whatever the index definition. Marking operators leakproof needs a superuser and is not portable to managed PostgreSQL, so it was rejected.
* **Cost structure**: a rare or absent term scans the whole workspace (linear in its size); a common term stops early (the page fills quickly) but its `count(*)` still scans; custom fields are not searchable (unchanged); archived leads are excluded by default (unchanged).
* **Workspace data distribution**: the load-test generator (`apps/api/src/scripts/loadtest/seed.ts`) produces 36 first names × 28 surnames, 12 companies × numbered variants, unique e-mail local parts and phone numbers — so surnames and first names are *common* terms (5 % of leads), e-mail local parts and phone digits are *rare* terms.

## 2. Design
`lf_search_lead_ids(terms text[], max_rows int)` — a `SECURITY DEFINER` PL/pgSQL function (migration `lead_search`):
* owned by a dedicated `NOLOGIN` role `leadflow_search` that has `BYPASSRLS` and **column-level** `SELECT` on exactly `id, organization_id, first_name, last_name, email, company_name, phone, phone_normalized` of `leads` — so the trigram indexes can be used;
* isolation is enforced **inside** the function: it filters on `app_org_id()` (the transaction's own setting; there is no organisation parameter to forge) and returns nothing when no workspace is set; `EXECUTE` is revoked from `PUBLIC` and granted to the app role only (`db:verify` checks all of this);
* the statement is built with the patterns inlined as quoted literals (`format('%L')`), because a SQL function (or a bound parameter computed from a CTE) is planned with a non-constant pattern, which cannot be an index condition — measured: a plain SQL version degraded to a 3.6 s sequential scan;
* `%`, `_` and `\` typed by users are **literal** characters (the previous query treated them as wildcards, which was a bug); both code paths now agree.

Application side (`modules/leads/queries.ts`): `planSearch()` calls the function with all terms and `max_rows = SEARCH_MAX_IDS + 1` (default 2,000). If at most that many leads match, the list query becomes `id IN (…)` (exact, indexed); otherwise (broad term) or if every term is shorter than 3 characters (trigrams cannot serve them) the original `ILIKE` predicate is kept, which stops early on dense matches. "This search is broad" is remembered for 5 minutes in process memory (it only chooses a strategy, never changes the result). `SEARCH_STRATEGY=ilike` restores the previous behaviour (rollback switch).

Other changes in this feature: `phone_normalized` trigram index; **keyset (cursor) pagination** (`cursor=start`, then `meta.nextCursor`, `sort=createdAt` only, stable under concurrent inserts, constant cost at any depth, ties broken by `id`); **exact cache invalidation** for the large-workspace total cache: every committed transaction that wrote to `leads`/`lead_tags` bumps a Redis version (`leadver:<org>`, detected centrally by wrapping the transaction client, so no call site can forget it) and the cached total's key contains that version.

## 3. Method
Same machine and tooling as PRODUCTION_READINESS.md §3 (4 vCPU shared VM; PostgreSQL 16, Redis 7, API and load generator on the same host). Database `leadflow_load` created from the migrations; three workspaces (30,000 / 100,000 / 250,000 leads) generated with `seed.ts`; `ANALYZE` run. API production build, `NODE_ENV=development` only for the test endpoints, rate limiter off, access log off. `apps/api/src/scripts/loadtest/search-bench.ts`: authenticated manager (sees all leads), `GET /api/leads?q=…&pageSize=25`, 3 warm-up + 12 timed requests per term, one at a time (this measures latency of one request; it is **not** a throughput test). The "before" run used the build without the migration/function; the "after" run the new build on the same data. Results are in `loadtest-results/search-bench-*-{before,after}.json`. The workspaces had no usage snapshot, so the large-workspace result cache was **off** (the `count(*)` is computed on every request, which is the realistic uncached cost).

## 4. Results — end-to-end API latency, p50 / p95 in ms
### 250,000 leads
| Search | Matches | Before | After | Speed-up |
|---|---:|---:|---:|---:|
| rare, existing (full e-mail) | 1 | 1,628 / 2,125 | **20 / 26** | 80× |
| rare, existing (e-mail local part) | 1 | 1,361 / 1,617 | **19 / 52** | 70× |
| no match (worst case) | 0 | 1,120 / 1,297 | **12 / 14** | 93× |
| phone digits | 25 | 1,294 / 1,481 | **26 / 28** | 50× |
| two common terms (`olivia smith`) | 625 | 651 / 1,016 | **59 / 64** | 11× |
| common surname | 12,500 | 499 / 603 | 693 / 746 | 0.7× (noise ±30 %) |
| common first name | 12,500 | 481 / 578 | 501 / 701 | 1.0× |
| company fragment (`acme 12`) | 27,102 | 788 / 933 | 773 / 1,141 | 1.0× |
| e-mail domain fragment | 27,861 | 495 / 513 | 512 / 638 | 1.0× |
| 2 characters (`li`) | 60,000 | 516 / 676 | 445 / 568 | 1.2× |

### 100,000 leads
| Search | Matches | Before | After | Speed-up |
|---|---:|---:|---:|---:|
| rare, existing (full e-mail) | 1 | 611 / 873 | **19 / 23** | 32× |
| rare, existing (local part) | 1 | 625 / 784 | **16 / 22** | 40× |
| no match | 0 | 475 / 548 | **15 / 17** | 32× |
| phone digits | 10 | 508 / 593 | **22 / 33** | 23× |
| two common terms | 250 | 248 / 285 | **41 / 54** | 6× |
| common surname / first name | 5,000 | 224 / 328 · 224 / 235 | 255 / 313 · 258 / 318 | 0.9× |
| company fragment · domain · 2 chars | 6,878 · 11,211 · 24,000 | 342 · 223 · 200 | 355 · 309 · 223 | 0.7–1.0× |

### 30,000 leads
| Search | Matches | Before | After | Speed-up |
|---|---:|---:|---:|---:|
| rare, existing (full e-mail) | 1 | 240 / 274 | **22 / 25** | 11× |
| rare, existing (local part) | 3 | 243 / 258 | **18 / 23** | 13× |
| no match | 0 | 208 / 238 | **14 / 17** | 15× |
| phone digits | 3 | 147 / 184 | **23 / 25** | 6.5× |
| two common terms | 75 | 121 / 165 | **32 / 41** | 3.8× |
| common surname / first name | 1,500 | 86 / 109 · 94 / 130 | 53 / 74 · 61 / 65 | 1.5× |
| company fragment · domain · 2 chars | 2,712 · 3,341 · 7,200 | 116 · 80 · 76 | 115 · 112 · 116 | 0.7–1.0× |

### Query plans (250,000 leads, the same rare term)
Before (runtime role, RLS): `Index Scan using leads_active_idx` → `Filter: … ILIKE …`, **Rows Removed by Filter: 249,999**, **926 ms**.
After (inside `lf_search_lead_ids`): `Bitmap Heap Scan` ← `BitmapOr` of `Bitmap Index Scan on leads_{first_name,last_name,email,company,phone}_trgm`, **2.4 ms**; the application then loads the single matching row by primary key.

### Import throughput (related benchmark, same machine)
See PRODUCTION_READINESS.md §3.4.

## 5. What this does **not** improve — honest limits
* **Broad searches** (a term matching thousands of leads, e.g. a common surname) are unchanged: their cost is the exact `count(*)` of matches evaluated under RLS (~0.5 s at 250k leads), which the index cannot help because the app role cannot use it. For large workspaces the existing result cache (`LARGE_WORKSPACE_LEADS`, ≤ 20 s TTL) makes repeated identical searches cheap, and it is now invalidated exactly on every lead change. A further step (an approximate/capped total for broad searches) was not taken because it changes what users see.
* Searches whose terms are all shorter than 3 characters cannot use trigrams.
* Custom-field values are not searched (unchanged).
* At 30,000 leads PostgreSQL may choose a sequential scan for the inner statement (it is cheap there); the index is chosen on its own from ~100,000 leads (see the plans above), which is where it matters.
* Measured on one shared 4-core VM; production hardware, a separate database host and concurrent load were **not** measured. The numbers are latencies of single requests, not capacity.
* Cursor pagination is available through the API; the web UI still uses page numbers.

## 6. Reproducing
```bash
bash scripts/loadtest-db.sh                                    # creates leadflow_load from the migrations
# start the API against it, then per size:
NODE_ENV=development npx tsx apps/api/src/scripts/loadtest/seed.ts --leads 250000 --label l250k
LOAD_API_URL=http://localhost:4000 npx tsx apps/api/src/scripts/loadtest/search-bench.ts --label l250k --tag after
```
Set `SEARCH_STRATEGY=ilike` on the API for the "before" behaviour.
