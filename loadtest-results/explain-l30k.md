# EXPLAIN ANALYZE as role leadflow_app under RLS — dataset l30k (2026-11-24T14:27:00.649Z)

## leads list (page 1, newest first)  —  0.292 ms
```
Limit (actual time=0.092..0.182 rows=25 loops=1)
  Buffers: shared hit=28
  ->  Result (actual time=0.091..0.179 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=28
        ->  Index Scan using leads_active_idx on leads (actual time=0.085..0.169 rows=25 loops=1)
              Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Filter: (merged_into_id IS NULL)
              Buffers: shared hit=28
Planning:
  Buffers: shared hit=478
Planning Time: 1.119 ms
Execution Time: 0.292 ms
```

## leads list count(*)  —  8.75 ms
```
Aggregate (actual time=8.724..8.725 rows=1 loops=1)
  Buffers: shared hit=3452
  ->  Result (actual time=0.058..7.196 rows=32618 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=3452
        ->  Index Only Scan using leads_inactivity_scan_idx on leads (actual time=0.054..4.686 rows=32618 loops=1)
              Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Heap Fetches: 3265
              Buffers: shared hit=3452
Planning:
  Buffers: shared hit=4
Planning Time: 0.149 ms
Execution Time: 8.750 ms
```

## leads list, agent scope (own leads)  —  3.9 ms
```
Limit (actual time=3.848..3.854 rows=25 loops=1)
  Buffers: shared hit=1088 read=3
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.073..0.074 rows=1 loops=1)
          Buffers: shared hit=1 read=3
          ->  Result (actual time=0.072..0.073 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                Buffers: shared hit=1 read=3
                ->  Index Only Scan using leads_organization_id_assigned_to_id_idx on leads leads_1 (actual time=0.071..0.071 rows=1 loops=1)
                      Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (assigned_to_id IS NOT NULL))
                      Heap Fetches: 0
                      Buffers: shared hit=1 read=3
  ->  Sort (actual time=3.847..3.849 rows=25 loops=1)
        Sort Key: leads.created_at DESC
        Sort Method: top-N heapsort  Memory: 46kB
        Buffers: shared hit=1088 read=3
        ->  Result (actual time=0.096..3.115 rows=1342 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Buffers: shared hit=1085 read=3
              ->  Index Scan using leads_organization_id_assigned_to_id_idx on leads (actual time=0.092..2.929 rows=1342 loops=1)
                    Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (assigned_to_id = $0))
                    Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL))
                    Buffers: shared hit=1085 read=3
Planning:
  Buffers: shared hit=2
Planning Time: 0.268 ms
Execution Time: 3.900 ms
```

## leads list, status filter + sort by last activity  —  0.251 ms
```
Limit (actual time=0.020..0.234 rows=25 loops=1)
  Buffers: shared hit=144
  ->  Result (actual time=0.020..0.231 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=144
        ->  Index Scan Backward using leads_inactivity_scan_idx on leads (actual time=0.014..0.219 rows=25 loops=1)
              Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Filter: (status = 'QUALIFIED'::"LeadStatus")
              Rows Removed by Filter: 114
              Buffers: shared hit=144
Planning:
  Buffers: shared hit=1
Planning Time: 0.135 ms
Execution Time: 0.251 ms
```

## leads search ILIKE %smith% (name/email/company/phone)  —  6.137 ms
```
Limit (actual time=5.245..6.117 rows=25 loops=1)
  Buffers: shared hit=3017
  ->  Result (actual time=5.244..6.114 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=3017
        ->  Index Scan using leads_active_idx on leads (actual time=5.239..6.105 rows=25 loops=1)
              Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Filter: ((merged_into_id IS NULL) AND ((first_name ~~* '%smith%'::text) OR (last_name ~~* '%smith%'::text) OR (email ~~* '%smith%'::text) OR (company_name ~~* '%smith%'::text) OR (phone ~~* '%smith%'::text)))
              Rows Removed by Filter: 2973
              Buffers: shared hit=3017
Planning:
  Buffers: shared hit=1
Planning Time: 0.141 ms
Execution Time: 6.137 ms
```

## leads search, rare term (worst case: scans the workspace)  —  68.094 ms
```
Limit (actual time=68.067..68.068 rows=0 loops=1)
  Buffers: shared hit=32633 read=172
  ->  Result (actual time=68.066..68.067 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=32633 read=172
        ->  Index Scan using leads_active_idx on leads (actual time=68.062..68.062 rows=0 loops=1)
              Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Filter: ((merged_into_id IS NULL) AND ((first_name ~~* '%zzqx%'::text) OR (last_name ~~* '%zzqx%'::text) OR (email ~~* '%zzqx%'::text) OR (company_name ~~* '%zzqx%'::text) OR (phone ~~* '%zzqx%'::text)))
              Rows Removed by Filter: 32618
              Buffers: shared hit=32633 read=172
Planning:
  Buffers: shared hit=1
Planning Time: 0.230 ms
Execution Time: 68.094 ms
```

## duplicate check by normalised e-mail (lead create)  —  0.042 ms
```
Limit (actual time=0.024..0.024 rows=0 loops=1)
  Buffers: shared hit=3
  ->  Result (actual time=0.023..0.023 rows=0 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=3
        ->  Index Scan using leads_organization_id_email_normalized_idx on leads (actual time=0.019..0.019 rows=0 loops=1)
              Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (email_normalized = 'olivia.smith1@acme1.test'::text))
              Filter: (archived_at IS NULL)
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.157 ms
Execution Time: 0.042 ms
```

## plan limit: count of active leads (lead create)  —  7.558 ms
```
Aggregate (actual time=7.537..7.541 rows=1 loops=1)
  Buffers: shared hit=3452
  ->  Result (actual time=0.016..6.035 rows=32618 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=3452
        ->  Index Only Scan using leads_inactivity_scan_idx on leads (actual time=0.012..3.432 rows=32618 loops=1)
              Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Heap Fetches: 3265
              Buffers: shared hit=3452
Planning:
  Buffers: shared hit=1
Planning Time: 0.135 ms
Execution Time: 7.558 ms
```

## dashboard: leads by status  —  14.658 ms
```
HashAggregate (actual time=14.589..14.591 rows=5 loops=1)
  Group Key: status
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=1333
  ->  Result (actual time=0.899..11.144 rows=32618 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=1333
        ->  Bitmap Heap Scan on leads (actual time=0.895..8.325 rows=32618 loops=1)
              Recheck Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL))
              Heap Blocks: exact=1298
              Buffers: shared hit=1333
              ->  Bitmap Index Scan on leads_organization_id_source_id_idx (actual time=0.724..0.724 rows=32618 loops=1)
                    Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                    Buffers: shared hit=35
Planning:
  Buffers: shared hit=4
Planning Time: 0.146 ms
Execution Time: 14.658 ms
```

## dashboard: leads created per day (30 days)  —  2.144 ms
```
GroupAggregate (actual time=1.627..2.098 rows=31 loops=1)
  Group Key: (date_trunc('day'::text, created_at))
  Buffers: shared hit=370
  ->  Sort (actual time=1.621..1.838 rows=4224 loops=1)
        Sort Key: (date_trunc('day'::text, created_at))
        Sort Method: quicksort  Memory: 193kB
        Buffers: shared hit=370
        ->  Result (actual time=0.016..1.365 rows=4224 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Buffers: shared hit=370
              ->  Index Only Scan using leads_active_idx on leads (actual time=0.011..0.549 rows=4224 loops=1)
                    Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (created_at >= (now() - '30 days'::interval)))
                    Heap Fetches: 370
                    Buffers: shared hit=370
Planning:
  Buffers: shared hit=9
Planning Time: 0.179 ms
Execution Time: 2.144 ms
```

## dashboard: leads by source  —  2.875 ms
```
HashAggregate (actual time=2.854..2.856 rows=8 loops=1)
  Group Key: source_id
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=4250
  ->  Result (actual time=0.010..2.395 rows=4224 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=4250
        ->  Index Scan using leads_active_idx on leads (actual time=0.006..1.586 rows=4224 loops=1)
              Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (created_at >= (now() - '30 days'::interval)))
              Buffers: shared hit=4250
Planning:
  Buffers: shared hit=5
Planning Time: 0.123 ms
Execution Time: 2.875 ms
```

## pipeline: open value per stage  —  0.98 ms
```
HashAggregate (actual time=0.951..0.953 rows=8 loops=1)
  Group Key: stage_id
  Batches: 1  Memory Usage: 24kB
  Buffers: shared hit=64
  ->  Result (actual time=0.050..0.590 rows=2137 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=64
        ->  Bitmap Heap Scan on opportunities (actual time=0.046..0.418 rows=2137 loops=1)
              Recheck Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Filter: (archived_at IS NULL)
              Heap Blocks: exact=59
              Buffers: shared hit=64
              ->  Bitmap Index Scan on opportunities_stage_idx (actual time=0.034..0.034 rows=2137 loops=1)
                    Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                    Buffers: shared hit=5
Planning:
  Buffers: shared hit=196
Planning Time: 0.368 ms
Execution Time: 0.980 ms
```

## pipeline: cards of one stage (60)  —  0.367 ms
```
Limit (actual time=0.324..0.331 rows=60 loops=1)
  Buffers: shared hit=67
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.036..0.036 rows=1 loops=1)
          Buffers: shared hit=3
          ->  Result (actual time=0.035..0.036 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                Buffers: shared hit=3
                ->  Index Only Scan using opportunities_stage_idx on opportunities opportunities_1 (actual time=0.034..0.035 rows=1 loops=1)
                      Index Cond: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                      Heap Fetches: 0
                      Buffers: shared hit=3
  ->  Sort (actual time=0.324..0.326 rows=60 loops=1)
        Sort Key: opportunities."position"
        Sort Method: top-N heapsort  Memory: 40kB
        Buffers: shared hit=67
        ->  Result (actual time=0.054..0.187 rows=263 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
              Buffers: shared hit=64
              ->  Index Scan using opportunities_stage_idx on opportunities (actual time=0.051..0.153 rows=263 loops=1)
                    Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (stage_id = $0))
                    Filter: (archived_at IS NULL)
                    Buffers: shared hit=64
Planning:
  Buffers: shared hit=59
Planning Time: 0.224 ms
Execution Time: 0.367 ms
```

## follow-ups: due today / overdue  —  0.081 ms
```
Limit (actual time=0.020..0.044 rows=25 loops=1)
  Buffers: shared hit=26
  ->  Result (actual time=0.019..0.041 rows=25 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=26
        ->  Index Scan using follow_ups_pending_due_idx on follow_ups (actual time=0.015..0.031 rows=25 loops=1)
              Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (due_at <= (now() + '1 day'::interval)))
              Buffers: shared hit=26
Planning:
  Buffers: shared hit=217
Planning Time: 0.514 ms
Execution Time: 0.081 ms
```

## notifications: unread count for a user  —  0.762 ms
```
Aggregate (actual time=0.737..0.737 rows=1 loops=1)
  Buffers: shared hit=45
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.007..0.008 rows=1 loops=1)
          Buffers: shared hit=1
          ->  Result (actual time=0.007..0.007 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                Buffers: shared hit=1
                ->  Seq Scan on notifications notifications_1 (actual time=0.006..0.006 rows=1 loops=1)
                      Filter: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                      Buffers: shared hit=1
  ->  Result (actual time=0.044..0.602 rows=2862 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=45
        ->  Index Only Scan using notifications_organization_id_user_id_read_at_created_at_idx on notifications (actual time=0.041..0.349 rows=2862 loops=1)
              Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (user_id = $0) AND (read_at IS NULL))
              Heap Fetches: 0
              Buffers: shared hit=45
Planning:
  Buffers: shared hit=62
Planning Time: 0.208 ms
Execution Time: 0.762 ms
```

## scheduler: uncontacted leads scan  —  0.207 ms
```
Limit (actual time=0.017..0.182 rows=200 loops=1)
  Buffers: shared hit=205
  ->  Result (actual time=0.017..0.168 rows=200 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=205
        ->  Index Scan using leads_uncontacted_scan_idx on leads (actual time=0.013..0.149 rows=200 loops=1)
              Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (created_at <= (now() - '24:00:00'::interval)))
              Filter: ((merged_into_id IS NULL) AND (status = 'NEW'::"LeadStatus"))
              Buffers: shared hit=205
Planning:
  Buffers: shared hit=1
Planning Time: 0.115 ms
Execution Time: 0.207 ms
```

## scheduler: inactive leads scan  —  75.085 ms
```
Limit (actual time=74.938..75.061 rows=200 loops=1)
  Buffers: shared hit=12667 read=1000
  ->  Result (actual time=74.936..75.044 rows=200 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=12667 read=1000
        ->  Seq Scan on leads (actual time=74.932..75.022 rows=200 loops=1)
              Filter: ((archived_at IS NULL) AND (merged_into_id IS NULL) AND (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (last_activity_at <= (now() - '7 days'::interval)) AND (status = ANY ('{NEW,CONTACTED,QUALIFIED}'::"LeadStatus"[])))
              Rows Removed by Filter: 351655
              Buffers: shared hit=12667 read=1000
Planning:
  Buffers: shared hit=1
Planning Time: 0.198 ms
Execution Time: 75.085 ms
```

## activity timeline of one lead  —  0.086 ms
```
Limit (actual time=0.032..0.038 rows=2 loops=1)
  Buffers: shared hit=7
  InitPlan 1 (returns $0)
    ->  Limit (actual time=0.006..0.007 rows=1 loops=1)
          Buffers: shared hit=1
          ->  Result (actual time=0.006..0.006 rows=1 loops=1)
                One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                Buffers: shared hit=1
                ->  Seq Scan on leads (actual time=0.005..0.005 rows=1 loops=1)
                      Filter: (organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
                      Buffers: shared hit=1
  ->  Result (actual time=0.031..0.036 rows=2 loops=1)
        One-Time Filter: ((NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid)
        Buffers: shared hit=7
        ->  Index Scan Backward using activities_organization_id_lead_id_occurred_at_idx on activities (actual time=0.026..0.030 rows=2 loops=1)
              Index Cond: ((organization_id = 'cbff7337-ca76-4710-902d-0d04552740b3'::uuid) AND (lead_id = $0))
              Buffers: shared hit=7
Planning:
  Buffers: shared hit=148
Planning Time: 0.541 ms
Execution Time: 0.086 ms
```
