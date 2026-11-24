# EXPLAIN ANALYZE as role leadflow_app under RLS — dataset l250k (2026-11-24T14:27:02.161Z)

## leads list (page 1, newest first)  —  0.216 ms
```
Limit (actual time=0.034..0.156 rows=25 loops=1)
  Buffers: shared hit=17 read=11
  ->  Result (actual time=0.033..0.152 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=17 read=11
        ->  Index Scan using leads_active_idx on leads (actual time=0.027..0.143 rows=25 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Filter: (merged_into_id IS NULL)
              Buffers: shared hit=17 read=11
Planning:
  Buffers: shared hit=478
Planning Time: 0.954 ms
Execution Time: 0.216 ms
```

## leads list count(*)  —  76.657 ms
```
Aggregate (actual time=76.613..76.614 rows=1 loops=1)
  Buffers: shared hit=33090 read=1923
  ->  Result (actual time=0.040..64.536 rows=251209 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=33090 read=1923
        ->  Index Only Scan using leads_inactivity_scan_idx on leads (actual time=0.036..45.028 rows=251209 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Heap Fetches: 33395
              Buffers: shared hit=33090 read=1923
Planning:
  Buffers: shared hit=4
Planning Time: 0.127 ms
Execution Time: 76.657 ms
```

## leads list, agent scope (own leads)  —  0.447 ms
```
Limit (actual time=0.057..0.382 rows=25 loops=1)
  Buffers: shared hit=443 read=2
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.026..0.026 rows=1 loops=1)
          Buffers: shared hit=4
          ->  Result (actual time=0.026..0.026 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                Buffers: shared hit=4
                ->  Seq Scan on leads leads_1 (actual time=0.024..0.025 rows=1 loops=1)
                      Filter: ((assigned_to_id IS NOT NULL) AND (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid))
                      Rows Removed by Filter: 103
                      Buffers: shared hit=4
  ->  Result (actual time=0.056..0.378 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=443 read=2
        ->  Index Scan using leads_active_idx on leads (actual time=0.052..0.370 rows=25 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Filter: ((merged_into_id IS NULL) AND (assigned_to_id = $0))
              Rows Removed by Filter: 272
              Buffers: shared hit=443 read=2
Planning:
  Buffers: shared hit=2
Planning Time: 0.291 ms
Execution Time: 0.447 ms
```

## leads list, status filter + sort by last activity  —  0.372 ms
```
Limit (actual time=0.033..0.357 rows=25 loops=1)
  Buffers: shared hit=72 read=36
  ->  Result (actual time=0.032..0.353 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=72 read=36
        ->  Index Scan Backward using leads_inactivity_scan_idx on leads (actual time=0.028..0.343 rows=25 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Filter: (status = 'QUALIFIED'::"LeadStatus")
              Rows Removed by Filter: 78
              Buffers: shared hit=72 read=36
Planning:
  Buffers: shared hit=1
Planning Time: 0.126 ms
Execution Time: 0.372 ms
```

## leads search ILIKE %smith% (name/email/company/phone)  —  6.145 ms
```
Limit (actual time=3.897..6.122 rows=25 loops=1)
  Buffers: shared hit=2106 read=194
  ->  Result (actual time=3.896..6.118 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=2106 read=194
        ->  Index Scan using leads_active_idx on leads (actual time=3.891..6.106 rows=25 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Filter: ((merged_into_id IS NULL) AND ((first_name ~~* '%smith%'::text) OR (last_name ~~* '%smith%'::text) OR (email ~~* '%smith%'::text) OR (company_name ~~* '%smith%'::text) OR (phone ~~* '%smith%'::text)))
              Rows Removed by Filter: 1740
              Buffers: shared hit=2106 read=194
Planning:
  Buffers: shared hit=1
Planning Time: 0.142 ms
Execution Time: 6.145 ms
```

## leads search, rare term (worst case: scans the workspace)  —  647.902 ms
```
Limit (actual time=647.877..647.879 rows=0 loops=1)
  Buffers: shared hit=244245 read=9103 written=5
  ->  Result (actual time=647.876..647.877 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=244245 read=9103 written=5
        ->  Index Scan using leads_active_idx on leads (actual time=647.872..647.873 rows=0 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Filter: ((merged_into_id IS NULL) AND ((first_name ~~* '%zzqx%'::text) OR (last_name ~~* '%zzqx%'::text) OR (email ~~* '%zzqx%'::text) OR (company_name ~~* '%zzqx%'::text) OR (phone ~~* '%zzqx%'::text)))
              Rows Removed by Filter: 251209
              Buffers: shared hit=244245 read=9103 written=5
Planning:
  Buffers: shared hit=1
Planning Time: 0.185 ms
Execution Time: 647.902 ms
```

## duplicate check by normalised e-mail (lead create)  —  0.055 ms
```
Limit (actual time=0.033..0.033 rows=0 loops=1)
  Buffers: shared read=3
  ->  Result (actual time=0.032..0.032 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared read=3
        ->  Index Scan using leads_organization_id_email_normalized_idx on leads (actual time=0.029..0.029 rows=0 loops=1)
              Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (email_normalized = 'olivia.smith1@acme1.test'::text))
              Filter: (archived_at IS NULL)
              Buffers: shared read=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.155 ms
Execution Time: 0.055 ms
```

## plan limit: count of active leads (lead create)  —  73.331 ms
```
Aggregate (actual time=73.310..73.311 rows=1 loops=1)
  Buffers: shared hit=33282 read=1731
  ->  Result (actual time=0.027..60.669 rows=251209 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=33282 read=1731
        ->  Index Only Scan using leads_inactivity_scan_idx on leads (actual time=0.024..40.564 rows=251209 loops=1)
              Index Cond: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Heap Fetches: 33395
              Buffers: shared hit=33282 read=1731
Planning:
  Buffers: shared hit=1
Planning Time: 0.136 ms
Execution Time: 73.331 ms
```

## dashboard: leads by status  —  122.918 ms
```
HashAggregate (actual time=122.882..122.884 rows=5 loops=1)
  Group Key: status
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=13820 read=1132
  ->  Result (actual time=0.036..97.451 rows=251209 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=13820 read=1132
        ->  Seq Scan on leads (actual time=0.030..77.488 rows=251209 loops=1)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL) AND (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid))
              Rows Removed by Filter: 134021
              Buffers: shared hit=13820 read=1132
Planning:
  Buffers: shared hit=4
Planning Time: 0.232 ms
Execution Time: 122.918 ms
```

## dashboard: leads created per day (30 days)  —  8.915 ms
```
GroupAggregate (actual time=7.213..8.802 rows=31 loops=1)
  Group Key: (date_trunc('day'::text, created_at))
  Buffers: shared hit=3531 read=152
  ->  Sort (actual time=7.190..7.833 rows=15127 loops=1)
        Sort Key: (date_trunc('day'::text, created_at))
        Sort Method: quicksort  Memory: 385kB
        Buffers: shared hit=3531 read=152
        ->  Result (actual time=0.035..5.986 rows=15127 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Buffers: shared hit=3529 read=151
              ->  Index Only Scan using leads_active_idx on leads (actual time=0.027..3.521 rows=15127 loops=1)
                    Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (created_at >= (now() - '30 days'::interval)))
                    Heap Fetches: 3822
                    Buffers: shared hit=3529 read=151
Planning:
  Buffers: shared hit=7 read=2
Planning Time: 0.273 ms
Execution Time: 8.915 ms
```

## dashboard: leads by source  —  15.38 ms
```
HashAggregate (actual time=15.268..15.270 rows=8 loops=1)
  Group Key: source_id
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=8330
  ->  Result (actual time=3.342..13.463 rows=15127 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=8330
        ->  Bitmap Heap Scan on leads (actual time=3.338..10.024 rows=15127 loops=1)
              Recheck Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (created_at >= (now() - '30 days'::interval)) AND (archived_at IS NULL))
              Heap Blocks: exact=8223
              Buffers: shared hit=8330
              ->  Bitmap Index Scan on leads_active_idx (actual time=2.088..2.089 rows=15880 loops=1)
                    Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (created_at >= (now() - '30 days'::interval)))
                    Buffers: shared hit=107
Planning:
  Buffers: shared hit=5
Planning Time: 0.185 ms
Execution Time: 15.380 ms
```

## pipeline: open value per stage  —  10.39 ms
```
HashAggregate (actual time=10.354..10.357 rows=8 loops=1)
  Group Key: stage_id
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=1 read=741
  ->  Result (actual time=1.628..7.017 rows=17780 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=1 read=741
        ->  Seq Scan on opportunities (actual time=1.624..5.456 rows=17780 loops=1)
              Filter: ((archived_at IS NULL) AND (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid))
              Rows Removed by Filter: 9206
              Buffers: shared hit=1 read=741
Planning:
  Buffers: shared hit=168 read=28
Planning Time: 0.412 ms
Execution Time: 10.390 ms
```

## pipeline: cards of one stage (60)  —  2.748 ms
```
Limit (actual time=2.698..2.706 rows=60 loops=1)
  Buffers: shared hit=743 read=3
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.649..0.650 rows=1 loops=1)
          Buffers: shared hit=253
          ->  Result (actual time=0.648..0.649 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                Buffers: shared hit=253
                ->  Seq Scan on opportunities opportunities_1 (actual time=0.647..0.647 rows=1 loops=1)
                      Filter: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                      Rows Removed by Filter: 9206
                      Buffers: shared hit=253
  ->  Sort (actual time=2.696..2.699 rows=60 loops=1)
        Sort Key: opportunities."position"
        Sort Method: top-N heapsort  Memory: 40kB
        Buffers: shared hit=743 read=3
        ->  Result (actual time=0.819..1.964 rows=2266 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
              Buffers: shared hit=740 read=3
              ->  Bitmap Heap Scan on opportunities (actual time=0.815..1.683 rows=2266 loops=1)
                    Recheck Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (stage_id = $0))
                    Filter: (archived_at IS NULL)
                    Heap Blocks: exact=487
                    Buffers: shared hit=740 read=3
                    ->  Bitmap Index Scan on opportunities_stage_idx (actual time=0.759..0.759 rows=2266 loops=1)
                          Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (stage_id = $0))
                          Buffers: shared hit=253 read=3
Planning:
  Buffers: shared hit=52 read=7
Planning Time: 0.236 ms
Execution Time: 2.748 ms
```

## follow-ups: due today / overdue  —  0.14 ms
```
Limit (actual time=0.021..0.115 rows=25 loops=1)
  Buffers: shared read=27
  ->  Result (actual time=0.020..0.112 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared read=27
        ->  Index Scan using follow_ups_pending_due_idx on follow_ups (actual time=0.016..0.102 rows=25 loops=1)
              Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (due_at <= (now() + '1 day'::interval)))
              Buffers: shared read=27
Planning:
  Buffers: shared hit=193 read=24
Planning Time: 0.465 ms
Execution Time: 0.140 ms
```

## notifications: unread count for a user  —  5.221 ms
```
Aggregate (actual time=5.193..5.194 rows=1 loops=1)
  Buffers: shared hit=816 read=1144 dirtied=28
  InitPlan 1 (returns $0)
    ->  Limit (actual time=4.286..4.287 rows=1 loops=1)
          Buffers: shared read=1018
          ->  Result (actual time=4.285..4.285 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                Buffers: shared read=1018
                ->  Seq Scan on notifications notifications_1 (actual time=4.283..4.283 rows=1 loops=1)
                      Filter: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                      Rows Removed by Filter: 41169
                      Buffers: shared read=1018
  ->  Result (actual time=4.332..5.117 rows=1457 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=816 read=1144 dirtied=28
        ->  Index Only Scan using notifications_organization_id_user_id_read_at_created_at_idx on notifications (actual time=4.329..5.001 rows=1457 loops=1)
              Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (user_id = $0) AND (read_at IS NULL))
              Heap Fetches: 1219
              Buffers: shared hit=816 read=1144 dirtied=28
Planning:
  Buffers: shared hit=55 read=7
Planning Time: 0.197 ms
Execution Time: 5.221 ms
```

## scheduler: uncontacted leads scan  —  17.282 ms
```
Limit (actual time=16.939..17.263 rows=200 loops=1)
  Buffers: shared hit=2048 read=1879
  ->  Result (actual time=16.938..17.248 rows=200 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=2048 read=1879
        ->  Seq Scan on leads (actual time=16.935..17.230 rows=200 loops=1)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL) AND (first_contacted_at IS NULL) AND (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (created_at <= (now() - '24:00:00'::interval)) AND (status = 'NEW'::"LeadStatus"))
              Rows Removed by Filter: 101394
              Buffers: shared hit=2048 read=1879
Planning:
  Buffers: shared hit=1
Planning Time: 0.122 ms
Execution Time: 17.282 ms
```

## scheduler: inactive leads scan  —  0.166 ms
```
Limit (actual time=0.009..0.148 rows=200 loops=1)
  Buffers: shared hit=11
  ->  Result (actual time=0.008..0.113 rows=200 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=11
        ->  Seq Scan on leads (actual time=0.005..0.096 rows=200 loops=1)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL) AND (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (last_activity_at <= (now() - '7 days'::interval)) AND (status = ANY ('{NEW,CONTACTED,QUALIFIED}'::"LeadStatus"[])))
              Rows Removed by Filter: 73
              Buffers: shared hit=11
Planning:
  Buffers: shared hit=1
Planning Time: 0.124 ms
Execution Time: 0.166 ms
```

## activity timeline of one lead  —  0.058 ms
```
Limit (actual time=0.031..0.032 rows=0 loops=1)
  Buffers: shared hit=1 read=3
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.005..0.006 rows=1 loops=1)
          Buffers: shared hit=1
          ->  Result (actual time=0.005..0.005 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                Buffers: shared hit=1
                ->  Seq Scan on leads (actual time=0.004..0.004 rows=1 loops=1)
                      Filter: (organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
                      Buffers: shared hit=1
  ->  Result (actual time=0.030..0.031 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid)
        Buffers: shared hit=1 read=3
        ->  Index Scan Backward using activities_organization_id_lead_id_occurred_at_idx on activities (actual time=0.027..0.027 rows=0 loops=1)
              Index Cond: ((organization_id = 'feab69b3-b49c-4c11-a727-d951ca07265b'::uuid) AND (lead_id = $0))
              Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=128 read=20
Planning Time: 0.459 ms
Execution Time: 0.058 ms
```
