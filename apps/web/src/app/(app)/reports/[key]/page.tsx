'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, FileSpreadsheet, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useOrg, useT } from '@/lib/session';
import { fmtDate, money, num, pct } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/data';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger } from '@/components/ui/menu';
import { FilterBar, defaultFilters, filterParams, type ReportFilterState } from '@/components/filters';
import { HBarChart, StackedBars, TrendChart } from '@/components/charts';

interface Col { key: string; label: string; type: 'text' | 'number' | 'percent' | 'money' | 'hours' | 'date' }
interface Report { key: string; title: string; description: string; columns: Col[]; rows: Array<Record<string, string | number | null>>; summary: Array<{ label: string; value: string | number; type: Col['type'] }>; extra?: { deals?: Array<Record<string, string | number | null>> }; filters: { restricted: boolean; timezone: string } }

export default function ReportPage() {
  const { key } = useParams<{ key: string }>();
  const { can, has, currency } = useOrg();
  const [filters, setFilters] = React.useState<ReportFilterState>(defaultFilters);
  const q = useT(['report', key, filters], () => api.get<Report>(`/reports/${key}`, filterParams(filters)), { keep: true });
  const r = q.data;
  const fmt = (v: string | number | null | undefined, t: Col['type']) => {
    if (v === null || v === undefined || v === '') return '—';
    if (t === 'money') return money(Number(v), currency);
    if (t === 'percent') return pct(Number(v));
    if (t === 'hours') return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
    if (t === 'number') return num(Number(v));
    if (t === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDate(`${v}T12:00:00`) : String(v);
    return String(v);
  };
  async function exportAs(format: 'csv' | 'xlsx') {
    try { const name = await api.download(`/reports/${key}`, { ...filterParams(filters), format }); toast.success(`Exported ${name}`); } catch (e) { toast.error((e as Error).message); }
  }
  // chart selection: first date/text column + first count column
  const chart = React.useMemo(() => {
    if (!r || !r.rows.length) return null;
    const dim = r.columns[0]!;
    const numeric = r.columns.filter((c) => c.type === 'number' || c.type === 'money').slice(0, 3);
    if (!numeric.length) return null;
    const palette = ['#5558e3', '#10b981', '#f59e0b'];
    if (dim.type === 'date' && /^\d{4}-/.test(String(r.rows[0]![dim.key]))) return { kind: 'time' as const, data: r.rows.map((x) => ({ bucket: String(x[dim.key]), ...Object.fromEntries(numeric.map((c) => [c.key, Number(x[c.key] ?? 0)])) })), series: numeric.filter((c) => c.type === 'number').slice(0, 3).map((c, i) => ({ key: c.key, name: c.label, color: palette[i]! })) };
    const main = numeric[0]!;
    return { kind: 'bar' as const, data: r.rows.map((x) => ({ name: String(x[dim.key]), value: Number(x[main.key] ?? 0), color: '#5558e3' })), label: main.label, money: main.type === 'money' };
  }, [r]);
  const canExport = can('reports.export');
  return (
    <>
      <Link href="/reports" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="size-3" />All reports</Link>
      <PageHeader title={r ? `${r.title} report` : 'Report'} description={r?.description} actions={canExport && (
        <DropdownMenu>
          <DropdownTrigger asChild><Button><Download className="size-3.5" />Export{!has('advanced_reports') && <Lock className="size-3 text-ink-3" />}</Button></DropdownTrigger>
          <DropdownContent>{has('advanced_reports') ? <><DropdownItem icon={<Download />} onSelect={() => exportAs('csv')}>CSV</DropdownItem><DropdownItem icon={<FileSpreadsheet />} onSelect={() => exportAs('xlsx')}>Excel (.xlsx)</DropdownItem></> : <p className="max-w-[220px] px-2 py-1.5 text-xs text-ink-2">Exporting reports needs a plan with Advanced reports. See Subscription & Billing.</p>}</DropdownContent>
        </DropdownMenu>)} />
      <div className="mb-4"><FilterBar value={filters} onChange={setFilters} showPipeline={key === 'pipeline' || key === 'conversion' || key === 'lost-leads' || key === 'salesperson'} /></div>
      {r?.filters.restricted && <p className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-ink">Showing only your own data. Ask an administrator for “view all reports” access to see the whole team.</p>}
      {q.isLoading || !r ? <Skeleton className="h-96" /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{r.summary.map((s) => <Card key={s.label} className="p-3.5"><p className="text-xs font-medium text-ink-2">{s.label}</p><p className="tnum mt-1 truncate text-xl font-semibold" title={String(s.value)}>{fmt(s.value, s.type)}</p></Card>)}</div>
          {chart && (
            <Card><CardHeader title={chart.kind === 'time' ? 'Trend' : chart.label} /><div className="px-2 pb-3 pt-2">
              {chart.kind === 'time' ? (chart.series.length > 1 && r.key !== 'lead-generation' ? <StackedBars data={chart.data} series={chart.series} height={260} /> : <TrendChart data={chart.data} series={chart.series} height={260} />) : <HBarChart data={chart.data.slice(0, 12)} height={Math.max(180, Math.min(12, chart.data.length) * 34)} valueFormatter={chart.money ? (v) => money(v, currency, true) : undefined} />}
            </div></Card>
          )}
          <Card className="overflow-hidden">
            <div className="scroll-thin overflow-x-auto">
              {r.rows.length === 0 ? <EmptyState title="No data for these filters" description="Try a wider date range." /> : (
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead><tr className="border-b border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3">{r.columns.map((c) => <th key={c.key} className={`whitespace-nowrap px-4 py-2 ${c.type === 'text' || c.type === 'date' ? '' : 'text-right'}`}>{c.label}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">{r.rows.map((row, i) => <tr key={i} className="hover:bg-subtle/50">{r.columns.map((c) => <td key={c.key} className={`tnum px-4 py-2 ${c.type === 'text' || c.type === 'date' ? '' : 'text-right'}`}>{fmt(row[c.key], c.type)}</td>)}</tr>)}</tbody>
                </table>
              )}
            </div>
          </Card>
          {r.extra?.deals && r.extra.deals.length > 0 && (
            <Card className="overflow-hidden"><CardHeader title="Lost deals" description="Most recent first" />
              <div className="scroll-thin overflow-x-auto"><table className="w-full min-w-[640px] text-left text-[13px]"><thead><tr className="border-y border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3">{['Deal', 'Lead', 'Reason', 'Owner', 'Lost on', 'Value'].map((h) => <th key={h} className="px-4 py-2">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">{r.extra.deals.map((d, i) => <tr key={i}><td className="px-4 py-2 font-medium">{String(d.deal)}</td><td className="px-4 py-2">{String(d.lead)}</td><td className="px-4 py-2">{String(d.reason)}</td><td className="px-4 py-2">{String(d.owner ?? '—')}</td><td className="px-4 py-2">{String(d.lost_on)}</td><td className="tnum px-4 py-2 text-right">{money(Number(d.value), currency)}</td></tr>)}</tbody></table></div></Card>
          )}
          <p className="text-xs text-ink-3">Times are shown in the workspace timezone ({r.filters.timezone}). Metric definitions are listed in the product documentation.</p>
        </div>
      )}
    </>
  );
}
