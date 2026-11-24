# EXPLAIN ANALYZE as role leadflow_app under RLS — dataset l100k (2026-11-24T14:27:01.311Z)

## leads list (page 1, newest first)  —  0.143 ms
```
Limit (actual time=0.025..0.090 rows=25 loops=1)
  Buffers: shared hit=28
  ->  Result (actual time=0.024..0.087 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=28
        ->  Index Scan using leads_active_idx on leads (actual time=0.018..0.077 rows=25 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: (merged_into_id IS NULL)
              Buffers: shared hit=28
Planning:
  Buffers: shared hit=478
Planning Time: 0.931 ms
Execution Time: 0.143 ms
```

## leads list count(*)  —  27.865 ms
```
Aggregate (actual time=27.839..27.840 rows=1 loops=1)
  Buffers: shared hit=15326
  ->  Result (actual time=0.088..23.135 rows=101403 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=15326
        ->  Index Only Scan using leads_inactivity_scan_idx on leads (actual time=0.062..15.411 rows=101403 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Heap Fetches: 14657
              Buffers: shared hit=15326
Planning:
  Buffers: shared hit=4
Planning Time: 0.138 ms
Execution Time: 27.865 ms
```

## leads list, agent scope (own leads)  —  0.727 ms
```
Limit (actual time=0.150..0.683 rows=25 loops=1)
  Buffers: shared hit=521
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.120..0.121 rows=1 loops=1)
          Buffers: shared hit=27
          ->  Result (actual time=0.120..0.121 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                Buffers: shared hit=27
                ->  Seq Scan on leads leads_1 (actual time=0.119..0.119 rows=1 loops=1)
                      Filter: ((assigned_to_id IS NOT NULL) AND (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid))
                      Rows Removed by Filter: 688
                      Buffers: shared hit=27
  ->  Result (actual time=0.149..0.680 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=521
        ->  Index Scan using leads_active_idx on leads (actual time=0.145..0.672 rows=25 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: ((merged_into_id IS NULL) AND (assigned_to_id = $0))
              Rows Removed by Filter: 245
              Buffers: shared hit=521
Planning:
  Buffers: shared hit=2
Planning Time: 0.236 ms
Execution Time: 0.727 ms
```

## leads list, status filter + sort by last activity  —  0.167 ms
```
Limit (actual time=0.016..0.134 rows=25 loops=1)
  Buffers: shared hit=92
  ->  Result (actual time=0.015..0.131 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=92
        ->  Index Scan Backward using leads_inactivity_scan_idx on leads (actual time=0.011..0.123 rows=25 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: (status = 'QUALIFIED'::"LeadStatus")
              Rows Removed by Filter: 62
              Buffers: shared hit=92
Planning:
  Buffers: shared hit=1
Planning Time: 0.134 ms
Execution Time: 0.167 ms
```

## leads search ILIKE %smith% (name/email/company/phone)  —  4.495 ms
```
Limit (actual time=2.852..4.473 rows=25 loops=1)
  Buffers: shared hit=2285
  ->  Result (actual time=2.852..4.469 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=2285
        ->  Index Scan using leads_active_idx on leads (actual time=2.848..4.461 rows=25 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: ((merged_into_id IS NULL) AND ((first_name ~~* '%smith%'::text) OR (last_name ~~* '%smith%'::text) OR (email ~~* '%smith%'::text) OR (company_name ~~* '%smith%'::text) OR (phone ~~* '%smith%'::text)))
              Rows Removed by Filter: 2021
              Buffers: shared hit=2285
Planning:
  Buffers: shared hit=1
Planning Time: 0.141 ms
Execution Time: 4.495 ms
```

## leads search, rare term (worst case: scans the workspace)  —  226.032 ms
```
Limit (actual time=226.008..226.009 rows=0 loops=1)
  Buffers: shared hit=101644 read=572
  ->  Result (actual time=226.006..226.007 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=101644 read=572
        ->  Index Scan using leads_active_idx on leads (actual time=226.002..226.003 rows=0 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: ((merged_into_id IS NULL) AND ((first_name ~~* '%zzqx%'::text) OR (last_name ~~* '%zzqx%'::text) OR (email ~~* '%zzqx%'::text) OR (company_name ~~* '%zzqx%'::text) OR (phone ~~* '%zzqx%'::text)))
              Rows Removed by Filter: 101403
              Buffers: shared hit=101644 read=572
Planning:
  Buffers: shared hit=1
Planning Time: 0.143 ms
Execution Time: 226.032 ms
```

## duplicate check by normalised e-mail (lead create)  —  0.043 ms
```
Limit (actual time=0.027..0.027 rows=0 loops=1)
  Buffers: shared hit=3
  ->  Result (actual time=0.026..0.026 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=3
        ->  Index Scan using leads_organization_id_email_normalized_idx on leads (actual time=0.022..0.022 rows=0 loops=1)
              Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (email_normalized = 'olivia.smith1@acme1.test'::text))
              Filter: (archived_at IS NULL)
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.187 ms
Execution Time: 0.043 ms
```

## plan limit: count of active leads (lead create)  —  27.126 ms
```
Aggregate (actual time=27.106..27.107 rows=1 loops=1)
  Buffers: shared hit=15326
  ->  Result (actual time=0.017..21.968 rows=101403 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=15326
        ->  Index Only Scan using leads_inactivity_scan_idx on leads (actual time=0.013..13.911 rows=101403 loops=1)
              Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Heap Fetches: 14657
              Buffers: shared hit=15326
Planning:
  Buffers: shared hit=1
Planning Time: 0.141 ms
Execution Time: 27.126 ms
```

## dashboard: leads by status  —  41.579 ms
```
HashAggregate (actual time=41.502..41.505 rows=5 loops=1)
  Group Key: status
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=4897
  ->  Result (actual time=3.057..32.359 rows=101403 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=4897
        ->  Bitmap Heap Scan on leads (actual time=3.053..24.707 rows=101403 loops=1)
              Recheck Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL))
              Heap Blocks: exact=4809
              Buffers: shared hit=4897
              ->  Bitmap Index Scan on leads_organization_id_source_id_idx (actual time=2.472..2.472 rows=101707 loops=1)
                    Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                    Buffers: shared hit=88
Planning:
  Buffers: shared hit=4
Planning Time: 0.159 ms
Execution Time: 41.579 ms
```

## dashboard: leads created per day (30 days)  —  3.936 ms
```
GroupAggregate (actual time=3.233..3.907 rows=31 loops=1)
  Group Key: (date_trunc('day'::text, created_at))
  Buffers: shared hit=2378
  ->  Sort (actual time=3.209..3.483 rows=6976 loops=1)
        Sort Key: (date_trunc('day'::text, created_at))
        Sort Method: quicksort  Memory: 193kB
        Buffers: shared hit=2378
        ->  Result (actual time=0.016..2.630 rows=6976 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Buffers: shared hit=2375
              ->  Index Only Scan using leads_active_idx on leads (actual time=0.012..1.419 rows=6976 loops=1)
                    Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (created_at >= (now() - '30 days'::interval)))
                    Heap Fetches: 2342
                    Buffers: shared hit=2375
Planning:
  Buffers: shared hit=9
Planning Time: 0.179 ms
Execution Time: 3.936 ms
```

## dashboard: leads by source  —  5.306 ms
```
HashAggregate (actual time=5.278..5.285 rows=8 loops=1)
  Group Key: source_id
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=7245
  ->  Result (actual time=0.013..4.498 rows=6976 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=7245
        ->  Index Scan using leads_active_idx on leads (actual time=0.009..3.047 rows=6976 loops=1)
              Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (created_at >= (now() - '30 days'::interval)))
              Buffers: shared hit=7245
Planning:
  Buffers: shared hit=5
Planning Time: 0.139 ms
Execution Time: 5.306 ms
```

## pipeline: open value per stage  —  3.216 ms
```
HashAggregate (actual time=3.184..3.188 rows=8 loops=1)
  Group Key: stage_id
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=204
  ->  Result (actual time=0.180..2.029 rows=7069 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=204
        ->  Bitmap Heap Scan on opportunities (actual time=0.176..1.477 rows=7069 loops=1)
              Recheck Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Filter: (archived_at IS NULL)
              Heap Blocks: exact=195
              Buffers: shared hit=204
              ->  Bitmap Index Scan on opportunities_stage_idx (actual time=0.155..0.155 rows=7069 loops=1)
                    Index Cond: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                    Buffers: shared hit=9
Planning:
  Buffers: shared hit=196
Planning Time: 0.357 ms
Execution Time: 3.216 ms
```

## pipeline: cards of one stage (60)  —  0.979 ms
```
Limit (actual time=0.950..0.957 rows=60 loops=1)
  Buffers: shared hit=257
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.168..0.169 rows=1 loops=1)
          Buffers: shared hit=59
          ->  Result (actual time=0.168..0.168 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                Buffers: shared hit=59
                ->  Seq Scan on opportunities opportunities_1 (actual time=0.167..0.167 rows=1 loops=1)
                      Filter: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                      Rows Removed by Filter: 2137
                      Buffers: shared hit=59
  ->  Sort (actual time=0.949..0.951 rows=60 loops=1)
        Sort Key: opportunities."position"
        Sort Method: top-N heapsort  Memory: 40kB
        Buffers: shared hit=257
        ->  Result (actual time=0.185..0.672 rows=883 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
              Buffers: shared hit=254
              ->  Index Scan using opportunities_stage_idx on opportunities (actual time=0.181..0.569 rows=883 loops=1)
                    Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (stage_id = $0))
                    Filter: (archived_at IS NULL)
                    Buffers: shared hit=254
Planning:
  Buffers: shared hit=59
Planning Time: 0.216 ms
Execution Time: 0.979 ms
```

## follow-ups: due today / overdue  —  0.093 ms
```
Limit (actual time=0.018..0.067 rows=25 loops=1)
  Buffers: shared hit=26
  ->  Result (actual time=0.017..0.064 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=26
        ->  Index Scan using follow_ups_pending_due_idx on follow_ups (actual time=0.013..0.053 rows=25 loops=1)
              Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (due_at <= (now() + '1 day'::interval)))
              Buffers: shared hit=26
Planning:
  Buffers: shared hit=217
Planning Time: 0.364 ms
Execution Time: 0.093 ms
```

## notifications: unread count for a user  —  1.424 ms
```
Aggregate (actual time=1.401..1.402 rows=1 loops=1)
  Buffers: shared hit=471
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.947..0.948 rows=1 loops=1)
          Buffers: shared hit=261
          ->  Result (actual time=0.945..0.946 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                Buffers: shared hit=261
                ->  Seq Scan on notifications notifications_1 (actual time=0.943..0.944 rows=1 loops=1)
                      Filter: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                      Rows Removed by Filter: 12051
                      Buffers: shared hit=261
  ->  Result (actual time=0.979..1.323 rows=1647 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=471
        ->  Index Only Scan using notifications_organization_id_user_id_read_at_created_at_idx on notifications (actual time=0.976..1.202 rows=1647 loops=1)
              Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (user_id = $0) AND (read_at IS NULL))
              Heap Fetches: 251
              Buffers: shared hit=471
Planning:
  Buffers: shared hit=62
Planning Time: 0.186 ms
Execution Time: 1.424 ms
```

## scheduler: uncontacted leads scan  —  5.355 ms
```
Limit (actual time=1.300..5.333 rows=200 loops=1)
  Buffers: shared hit=1268
  ->  Result (actual time=1.299..5.315 rows=200 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=1268
        ->  Seq Scan on leads (actual time=1.295..5.292 rows=200 loops=1)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL) AND (first_contacted_at IS NULL) AND (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (created_at <= (now() - '24:00:00'::interval)) AND (status = 'NEW'::"LeadStatus"))
              Rows Removed by Filter: 32725
              Buffers: shared hit=1268
Planning:
  Buffers: shared hit=1
Planning Time: 0.113 ms
Execution Time: 5.355 ms
```

## scheduler: inactive leads scan  —  0.186 ms
```
Limit (actual time=0.009..0.168 rows=200 loops=1)
  Buffers: shared hit=19
  ->  Result (actual time=0.009..0.154 rows=200 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=19
        ->  Seq Scan on leads (actual time=0.006..0.137 rows=200 loops=1)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL) AND (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (last_activity_at <= (now() - '7 days'::interval)) AND (status = ANY ('{NEW,CONTACTED,QUALIFIED}'::"LeadStatus"[])))
              Rows Removed by Filter: 272
              Buffers: shared hit=19
Planning:
  Buffers: shared hit=1
Planning Time: 0.116 ms
Execution Time: 0.186 ms
```

## activity timeline of one lead  —  0.063 ms
```
Limit (actual time=0.025..0.027 rows=2 loops=1)
  Buffers: shared hit=6
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.005..0.005 rows=1 loops=1)
          Buffers: shared hit=1
          ->  Result (actual time=0.004..0.005 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                Buffers: shared hit=1
                ->  Seq Scan on leads (actual time=0.003..0.003 rows=1 loops=1)
                      Filter: (organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
                      Buffers: shared hit=1
  ->  Result (actual time=0.024..0.026 rows=2 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid)
        Buffers: shared hit=6
        ->  Index Scan Backward using activities_organization_id_lead_id_occurred_at_idx on activities (actual time=0.019..0.020 rows=2 loops=1)
              Index Cond: ((organization_id = '4c68f2f6-db2e-4c9a-bb76-5f428b018528'::uuid) AND (lead_id = $0))
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=148
Planning Time: 0.517 ms
Execution Time: 0.063 ms
```
