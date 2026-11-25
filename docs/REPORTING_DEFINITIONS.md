# Reporting definitions

All dashboards and reports are computed server-side from live data by `apps/api/src/modules/reports`, in the **workspace timezone**, using the same filter object (date range, salesperson, source, pipeline). Archived and merged leads are excluded. Members without the "view all" permission are **forced to their own data** (`assigned_to_id = me`, `owner_id = me`) — the filter cannot be overridden from the client.

| Metric | Definition |
|---|---|
| Total leads | Leads **created** in the selected range |
| New leads | …of those, status `NEW` |
| Assigned / Unassigned | …with / without `assigned_to_id` |
| Contacted leads | …with a recorded contact attempt (`first_contacted_at` set by a logged call/email/WhatsApp/meeting, or a completed non-"other" follow-up) |
| **Contact rate** | Contacted leads ÷ Assigned leads × 100 |
| Follow-ups due today | Pending follow-ups due within today (workspace timezone) |
| **Overdue follow-ups** | Pending follow-ups with `due_at < now` (derived, never stored) |
| Won / Lost leads | Leads whose `converted_at` / `lost_at` falls in the range |
| Won / Lost opportunities | Opportunities with `won_at` / `lost_at` in the range |
| **Conversion rate** | **Won opportunities ÷ Closed opportunities × 100**, where closed = won + lost in the range |
| **Follow-up completion rate** | Completed follow-ups ÷ Follow-ups that were due in the range (canceled excluded; not-yet-due excluded from the denominator in the dashboard) |
| **First response time** | `first_contacted_at − created_at` (hours); report shows average, median, % within 1 h / 24 h and never-contacted count |
| Lead aging | Open leads (NEW/CONTACTED/QUALIFIED) bucketed by age since creation: 0–1, 2–3, 4–7, 8–14, 15–30, 30+ days |
| Pipeline value / weighted forecast | Sum of open deal values / Σ value × stage win-probability |
| Lead → won | Won leads ÷ leads created, per source |
| Salesperson performance | Per member: leads received (created in range & assigned), contacted + rate, avg response, follow-ups completed, deals won/lost, conversion, won value, open deals |

| Lead status report | Leads **created in the range** grouped by current status (NEW/CONTACTED/QUALIFIED/CONVERTED/LOST) with share, unassigned, contacted and average age; sums to *Total leads* of the lead-generation report |
| Activity report | Per active member: logged calls, emails, WhatsApp, meetings and notes with `occurred_at` in the range, plus distinct leads touched (agents without `activity.view_all` see only themselves); calls/emails/meetings equal the same columns of Contact Performance |
| Task performance | Per assignee: tasks **due in the range** (canceled excluded), completed, on time (completed at or before due), overdue (open and past due), upcoming, high-priority open, completion rate and on-time rate (agents without `tasks.view_all` see only their own) |
| Assignment report | Counts assignment **events** (`lead_assignments`) made in the range, by method (manual / rule / round-robin / automation), including assignments of leads archived later |
| Deals of archived leads | Excluded from every pipeline, forecast and dashboard figure |

Reports: Lead Generation · Lead Source Performance · Assignment · Contact Performance · Follow-up · Pipeline · Conversion · Lost Lead · Salesperson Performance · Lead Aging · Response Time · Lead Status · Activity · Task Performance (14). Each supports the date presets (today … this year, custom), salesperson, source and pipeline filters and CSV / Excel export (plan feature `advanced_reports`, permission `reports.export`). CSV cells are protected against formula injection.
