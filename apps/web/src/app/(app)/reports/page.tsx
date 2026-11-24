'use client';
import Link from 'next/link';
import { BarChart3, Clock, Filter, GitBranch, Layers, LineChart, ListChecks, Phone, PieChart, TrendingDown, UserCheck, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/session';
import { Card, PageHeader, Skeleton } from '@/components/ui/data';

const ICONS: Record<string, React.ReactNode> = { 'lead-generation': <LineChart />, 'lead-source': <PieChart />, assignment: <UserCheck />, 'contact-performance': <Phone />, 'follow-up': <ListChecks />, pipeline: <GitBranch />, conversion: <Filter />, 'lost-leads': <TrendingDown />, salesperson: <Users />, 'lead-aging': <Layers />, 'response-time': <Clock /> };

export default function ReportsPage() {
  const q = useT(['reports'], () => api.get<Array<{ key: string; title: string; description: string }>>('/reports'));
  return (
    <>
      <PageHeader title="Reports & analytics" description="Every number comes straight from your live data and respects what each team member is allowed to see." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {q.isLoading ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />) : q.data?.map((r) => (
          <Link key={r.key} href={`/reports/${r.key}`} className="group">
            <Card className="h-full p-4 transition-colors group-hover:border-line-strong group-hover:bg-subtle/40">
              <div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent [&>svg]:size-4.5">{ICONS[r.key] ?? <BarChart3 />}</span><div><p className="text-[13px] font-semibold group-hover:text-accent-ink">{r.title} report</p><p className="mt-1 text-xs leading-[18px] text-ink-2">{r.description}</p></div></div>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
