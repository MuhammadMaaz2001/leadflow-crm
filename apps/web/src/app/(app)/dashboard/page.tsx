'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowUpRight, CalendarClock, CalendarX2, CheckCircle2, ClipboardList, Inbox, Phone, TrendingUp, UserX } from 'lucide-react';
import { api } from '@/lib/api';
import { useOrg, useT } from '@/lib/session';
import { fmtRelativeDay, money, num, pct, timeAgo } from '@/lib/format';
import { Avatar, Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton, UserChip } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';
import { FilterBar, defaultFilters, filterParams, type ReportFilterState } from '@/components/filters';
import { Donut, HBarChart, Legend2, RateLine, StackedBars, TrendChart, PALETTE } from '@/components/charts';
import { ACTIVITY_LABELS } from '@leadflow/shared';

interface FU { id: string; type: string; dueAt: string; priority: string; lead: { id: string; name: string; companyName: string | null }; assignedTo: { name: string } | null }
interface Dash {
  filters: { restricted: boolean; granularity: string; range: string; timezone: string };
  kpis: { totalLeads: number; newLeads: number; unassignedLeads: number; assignedLeads: number; contactedLeads: number; contactRate: number; followUpsDueToday: number; overdueFollowUps: number; followUpsCompleted: number; wonLeads: number; lostLeads: number; wonOpportunities: number; lostOpportunities: number; wonValue: number; conversionRate: number };
  leadsOverTime: Array<{ bucket: string; leads: number; won: number }>;
  leadsBySource: Array<{ id: string | null; name: string; color: string; leads: number; won: number; contacted: number }>;
  pipeline: { id: string | null; name: string | null; stages: Array<{ id: string; name: string; color: string; kind: string; count: number; value: number }> };
  wonVsLost: Array<{ bucket: string; won: number; lost: number; wonValue: number }>;
  monthlyConversion: Array<{ bucket: string; won: number; lost: number; rate: number }>;
  salespersonPerformance: Array<{ id: string; name: string; leads: number; contacted: number; contactRate: number; won: number; lost: number; wonValue: number; conversionRate: number; avgResponseHours: number | null; openOpportunities: number; followUpsCompleted: number }>;
  followUpCompletion: { completed: number; onTime: number; overdue: number; upcoming: number; rate: number };
  leadAging: Array<{ bucket: string; count: number }>;
  attention: { overdue: FU[]; dueToday: FU[]; uncontacted: Array<{ id: string; name: string; companyName: string | null; createdAt: string }> };
  recentActivity: Array<{ id: string; type: string; title: string; occurredAt: string; actor: { name: string } | null; lead: { id: string; name: string } | null }>;
}

function Kpi({ label, value, hint, icon, tone, href, big }: { label: string; value: React.ReactNode; hint?: string; icon: React.ReactNode; tone?: string; href?: string; big?: boolean }) {
  const inner = (
    <div className="flex h-full flex-col justify-between gap-1 px-4 py-3.5 transition-colors group-hover:bg-subtle/60">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-ink-2">{label}</span><span className={`[&>svg]:size-3.5 ${tone ?? 'text-ink-3'}`}>{icon}</span></div>
      <div className={`tnum font-semibold tracking-tight ${big ? 'text-[28px] leading-8' : 'text-xl leading-6'}`}>{value}</div>
      {hint && <p className="truncate text-xs text-ink-3">{hint}</p>}
    </div>
  );
  return href ? <Link href={href} className="group block">{inner}</Link> : <div className="group">{inner}</div>;
}

export default function DashboardPage() {
  const [filters, setFilters] = React.useState<ReportFilterState>(defaultFilters);
  const { currency, can } = useOrg();
  const q = useT(['dashboard', filters], () => api.get<Dash>('/dashboard', filterParams(filters)), { staleTime: 20_000, keep: true });
  const d = q.data;
  const k = d?.kpis;
  const loading = q.isLoading;
  return (
    <>
      <PageHeader title="Dashboard" description={d?.filters.restricted ? 'Showing your own leads and follow-ups.' : 'Company-wide performance across leads, pipeline and team.'} actions={<FilterBar value={filters} onChange={setFilters} />} />

      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-line md:grid-cols-3 xl:grid-cols-5 [&>*]:border-b [&>*]:border-line xl:[&>*]:border-b-0">
          <Kpi big label="Total leads" value={loading ? <Skeleton className="h-8 w-16" /> : num(k?.totalLeads)} hint={`${num(k?.newLeads)} new · ${num(k?.unassignedLeads)} unassigned`} icon={<Inbox />} href="/leads" />
          <Kpi big label="Contacted" value={loading ? <Skeleton className="h-8 w-16" /> : num(k?.contactedLeads)} hint={`${pct(k?.contactRate)} contact rate`} icon={<Phone />} tone="text-info" href="/leads?uncontacted=false" />
          <Kpi big label="Follow-ups due today" value={loading ? <Skeleton className="h-8 w-16" /> : num(k?.followUpsDueToday)} hint={`${num(k?.followUpsCompleted)} completed in range`} icon={<CalendarClock />} tone="text-warn" href="/follow-ups?view=today" />
          <Kpi big label="Overdue follow-ups" value={loading ? <Skeleton className="h-8 w-16" /> : <span className={(k?.overdueFollowUps ?? 0) > 0 ? 'text-bad' : ''}>{num(k?.overdueFollowUps)}</span>} hint="Needs attention now" icon={<CalendarX2 />} tone="text-bad" href="/follow-ups?view=overdue" />
          <Kpi big label="Conversion rate" value={loading ? <Skeleton className="h-8 w-16" /> : pct(k?.conversionRate)} hint={`${num(k?.wonOpportunities)} won / ${num((k?.wonOpportunities ?? 0) + (k?.lostOpportunities ?? 0))} closed`} icon={<TrendingUp />} tone="text-ok" href="/reports/conversion" />
        </div>
        <div className="grid grid-cols-2 divide-x divide-line border-t border-line bg-subtle/40 md:grid-cols-4 [&>*]:border-b [&>*]:border-line md:[&>*]:border-b-0">
          <Kpi label="New leads" value={loading ? '—' : num(k?.newLeads)} icon={<Inbox />} href="/leads?status=NEW" />
          <Kpi label="Assigned / unassigned" value={loading ? '—' : `${num(k?.assignedLeads)} / ${num(k?.unassignedLeads)}`} icon={<UserX />} href="/leads?assignedToId=unassigned" />
          <Kpi label="Won leads" value={loading ? '—' : num(k?.wonLeads)} hint={k ? money(k.wonValue, currency, true) + ' won value' : undefined} icon={<CheckCircle2 />} tone="text-ok" href="/leads?status=CONVERTED" />
          <Kpi label="Lost leads" value={loading ? '—' : num(k?.lostLeads)} icon={<AlertCircle />} tone="text-bad" href="/leads?status=LOST" />
        </div>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Leads generated" description="New leads created in the selected period, and how many are now won." />
          <div className="px-2 pb-3 pt-2">{loading || !d ? <Skeleton className="m-3 h-[240px]" /> : <TrendChart data={d.leadsOverTime} granularity={d.filters.granularity} series={[{ key: 'leads', name: 'Leads', color: '#5558e3' }, { key: 'won', name: 'Won', color: '#10b981' }]} />}</div>
        </Card>
        <Card>
          <CardHeader title="Leads by source" description="Where your leads come from" />
          <div className="px-4 pb-4">
            {loading || !d ? <Skeleton className="mt-3 h-[240px]" /> : d.leadsBySource.length === 0 ? <EmptyState className="py-12" title="No leads in this period" /> : (
              <ul className="mt-3 space-y-3">
                {d.leadsBySource.slice(0, 7).map((s, i) => {
                  const max = d.leadsBySource[0]!.leads || 1;
                  return (
                    <li key={s.id ?? 'none'}>
                      <div className="mb-1 flex items-center justify-between text-[13px]"><span className="truncate">{s.name}</span><span className="tnum text-ink-2"><b className="text-ink">{s.leads}</b> · {s.won} won</span></div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-subtle"><div className="h-full rounded-full" style={{ width: `${(s.leads / max) * 100}%`, background: s.color || PALETTE[i % PALETTE.length] }} /></div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Pipeline overview" description={d?.pipeline.name ? `Open opportunities · ${d.pipeline.name}` : 'Open opportunities by stage'} actions={<Link href="/pipeline" className="flex items-center gap-0.5 text-xs text-accent-ink hover:underline">Open board <ArrowUpRight className="size-3" /></Link>} />
          <div className="px-2 pb-3 pt-2">{loading || !d ? <Skeleton className="m-3 h-[230px]" /> : <HBarChart height={230} data={d.pipeline.stages.filter((s) => s.kind === 'OPEN').map((s) => ({ name: s.name, value: s.count, color: s.color }))} />}</div>
        </Card>
        <Card>
          <CardHeader title="Won vs lost" description="Opportunities closed per period" />
          <div className="px-2 pb-3 pt-2">{loading || !d ? <Skeleton className="m-3 h-[230px]" /> : <StackedBars height={230} data={d.wonVsLost} granularity={d.filters.granularity} series={[{ key: 'won', name: 'Won', color: '#10b981' }, { key: 'lost', name: 'Lost', color: '#ef4444' }]} />}</div>
        </Card>
        <Card>
          <CardHeader title="Monthly conversion" description="Won ÷ closed opportunities, last months" />
          <div className="px-2 pb-3 pt-2">{loading || !d ? <Skeleton className="m-3 h-[230px]" /> : d.monthlyConversion.length ? <RateLine data={d.monthlyConversion} height={230} /> : <EmptyState className="py-12" title="No closed deals yet" />}</div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Needs attention" description="Follow-ups and leads waiting on you" />
          <Tabs defaultValue="overdue" className="mt-2">
            <TabsList className="px-4">
              <TabsTrigger value="overdue">Overdue <Badge tone="bad" className="ml-1">{d?.attention.overdue.length ?? 0}{(k?.overdueFollowUps ?? 0) > (d?.attention.overdue.length ?? 0) ? '+' : ''}</Badge></TabsTrigger>
              <TabsTrigger value="today">Due today <Badge tone="warn" className="ml-1">{d?.attention.dueToday.length ?? 0}</Badge></TabsTrigger>
              <TabsTrigger value="uncontacted">Not contacted <Badge className="ml-1">{d?.attention.uncontacted.length ?? 0}</Badge></TabsTrigger>
            </TabsList>
            {(['overdue', 'today'] as const).map((tab) => {
              const rows = tab === 'overdue' ? d?.attention.overdue : d?.attention.dueToday;
              return (
                <TabsContent key={tab} value={tab}>
                  {loading ? <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div> : !rows?.length ? <EmptyState className="py-10" icon={<CheckCircle2 />} title={tab === 'overdue' ? 'No overdue follow-ups' : 'Nothing due today'} description="You're on top of it." /> : (
                    <ul className="divide-y divide-line">
                      {rows.map((f) => (
                        <li key={f.id}><Link href={`/leads/${f.lead.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle">
                          <Avatar name={f.lead.name} size="sm" />
                          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{f.lead.name}</span><span className="block truncate text-xs text-ink-3">{f.type.replace('_', ' ').toLowerCase()} · {f.lead.companyName ?? 'No company'}</span></span>
                          <span className={`shrink-0 text-xs ${tab === 'overdue' ? 'font-medium text-bad' : 'text-ink-2'}`}>{fmtRelativeDay(f.dueAt)}</span>
                          <span className="hidden shrink-0 sm:block"><UserChip user={f.assignedTo} size="xs" /></span>
                        </Link></li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              );
            })}
            <TabsContent value="uncontacted">
              {!d?.attention.uncontacted.length ? <EmptyState className="py-10" icon={<CheckCircle2 />} title="Every new lead has been contacted" /> : (
                <ul className="divide-y divide-line">{d.attention.uncontacted.map((l) => <li key={l.id}><Link href={`/leads/${l.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle"><Avatar name={l.name} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{l.name}</span><span className="block truncate text-xs text-ink-3">{l.companyName ?? '—'}</span></span><span className="text-xs text-warn">waiting {timeAgo(l.createdAt).replace(' ago', '')}</span></Link></li>)}</ul>
              )}
            </TabsContent>
          </Tabs>
        </Card>
        <div className="grid gap-4">
          <Card>
            <CardHeader title="Follow-up completion" description="Due in the selected period" />
            <div className="grid grid-cols-[120px_1fr] items-center gap-3 px-4 pb-4">
              {loading || !d ? <Skeleton className="h-[120px]" /> : <Donut height={120} data={[{ name: 'Completed', value: d.followUpCompletion.completed, color: '#10b981' }, { name: 'Overdue', value: d.followUpCompletion.overdue, color: '#ef4444' }, { name: 'Upcoming', value: d.followUpCompletion.upcoming, color: '#d6d6dc' }]} center={<><span className="tnum text-lg font-semibold">{pct(d.followUpCompletion.rate)}</span><span className="text-[10px] text-ink-3">completed</span></>} />}
              <Legend2 items={[{ name: 'Completed', value: d?.followUpCompletion.completed ?? 0, color: '#10b981' }, { name: 'On time', value: d?.followUpCompletion.onTime ?? 0, color: '#5558e3' }, { name: 'Overdue', value: d?.followUpCompletion.overdue ?? 0, color: '#ef4444' }, { name: 'Upcoming', value: d?.followUpCompletion.upcoming ?? 0, color: '#d6d6dc' }]} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Lead aging" description="Open leads by time since creation" />
            <div className="px-2 pb-3 pt-1">{loading || !d ? <Skeleton className="m-3 h-[150px]" /> : <StackedBars height={150} data={d.leadAging.map((a) => ({ bucket: a.bucket, leads: a.count }))} series={[{ key: 'leads', name: 'Open leads', color: '#8b5cf6' }]} />}</div>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Salesperson performance" description="Leads worked, deals won and revenue in the selected period" actions={can('reports.view') && <Link href="/reports/salesperson" className="flex items-center gap-0.5 text-xs text-accent-ink hover:underline">Full report <ArrowUpRight className="size-3" /></Link>} />
          <div className="scroll-thin overflow-x-auto px-1 pb-2 pt-2">
            {loading || !d ? <Skeleton className="m-3 h-40" /> : d.salespersonPerformance.length === 0 ? <EmptyState className="py-10" title="No team activity yet" /> : (
              <table className="w-full min-w-[560px] text-[13px]">
                <thead><tr className="text-left text-[11px] font-medium uppercase tracking-wide text-ink-3"><th className="px-3 py-1.5">Salesperson</th><th className="px-3 py-1.5 text-right">Leads</th><th className="px-3 py-1.5">Contact rate</th><th className="px-3 py-1.5 text-right">Won</th><th className="px-3 py-1.5 text-right">Conv.</th><th className="px-3 py-1.5 text-right">Won value</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {d.salespersonPerformance.map((p) => (
                    <tr key={p.id}>
                      <td className="px-3 py-2"><span className="flex items-center gap-2"><Avatar name={p.name} size="sm" /><span className="truncate font-medium">{p.name}</span></span></td>
                      <td className="tnum px-3 py-2 text-right">{p.leads}</td>
                      <td className="px-3 py-2"><div className="flex items-center gap-2"><div className="h-1.5 w-20 overflow-hidden rounded-full bg-subtle"><div className="h-full rounded-full bg-info" style={{ width: `${p.contactRate}%` }} /></div><span className="tnum w-10 text-xs text-ink-2">{pct(p.contactRate)}</span></div></td>
                      <td className="tnum px-3 py-2 text-right">{p.won}</td>
                      <td className="tnum px-3 py-2 text-right text-ink-2">{pct(p.conversionRate)}</td>
                      <td className="tnum px-3 py-2 text-right font-medium">{money(p.wonValue, currency, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent activity" actions={<Link href="/activity" className="flex items-center gap-0.5 text-xs text-accent-ink hover:underline">All <ArrowUpRight className="size-3" /></Link>} />
          <ul className="px-4 pb-3 pt-2">
            {loading || !d ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-2 h-10" />) : d.recentActivity.length === 0 ? <EmptyState className="py-10" icon={<ClipboardList />} title="No activity yet" /> : d.recentActivity.map((a) => (
              <li key={a.id} className="relative flex gap-3 pb-3 last:pb-0">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent/70" />
                <div className="min-w-0 text-[13px]"><p className="leading-5"><span className="font-medium">{a.actor?.name ?? 'System'}</span> <span className="text-ink-2">· {ACTIVITY_LABELS[a.type] ?? a.type}</span></p>
                  <p className="truncate text-xs text-ink-3">{a.lead ? <Link href={`/leads/${a.lead.id}`} className="hover:underline">{a.lead.name}</Link> : a.title} · {timeAgo(a.occurredAt)}</p></div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
