'use client';
import * as React from 'react';
import { CheckCircle2, Merge } from 'lucide-react';
import { api } from '@/lib/api';
import { errMsg, useAct, useT } from '@/lib/session';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, useConfirm } from '@/components/ui/overlay';
import { Avatar, Badge, EmptyState, Skeleton } from '@/components/ui/data';

interface DupLead { id: string; name: string; email: string | null; phone: string | null; companyName: string | null; createdAt: string; assignedTo: { name: string } | null; status: string }
interface Group { kind: 'email' | 'phone'; key: string; leads: DupLead[] }

export function DuplicatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const confirm = useConfirm();
  const q = useT(['duplicates'], () => api.get<Group[]>('/leads/duplicates'), { enabled: open });
  const [keep, setKeep] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setKeep({}); setError(null); } }, [open]);
  const merge = useAct(async (g: Group) => {
    const target = keep[`${g.kind}:${g.key}`] ?? g.leads[0]!.id;
    for (const l of g.leads.filter((x) => x.id !== target)) await api.post('/leads/merge', { sourceId: l.id, targetId: target });
  }, { success: 'Leads merged — history preserved', invalidate: undefined, silent: true, onError: (e) => setError(errMsg(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="Duplicate leads" description="Leads sharing the same email or phone. Merging keeps one lead and moves the activity, follow-ups, tasks and opportunities of the others into it.">
      <div className="space-y-4">
        {error && <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft p-3 text-xs text-bad">{error}</div>}
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? <EmptyState icon={<CheckCircle2 />} title="No duplicates found" description="Every active lead has a unique email and phone." /> : q.data.map((g) => {
          const gk = `${g.kind}:${g.key}`; const target = keep[gk] ?? g.leads[0]!.id;
          return (
            <div key={gk} className="rounded-xl border border-line">
              <div className="flex items-center justify-between border-b border-line bg-subtle/60 px-3 py-2"><p className="text-xs"><Badge tone="warn">Same {g.kind}</Badge> <span className="ml-1 text-ink-3">{g.key}</span></p><Button size="sm" variant="primary" loading={merge.isPending && merge.variables === g} onClick={async () => { if (await confirm({ title: `Merge ${g.leads.length} leads?`, description: 'The selected lead is kept. The others are archived and marked as merged.', confirmLabel: 'Merge leads' })) merge.mutate(g, { onSuccess: () => q.refetch() }); }}><Merge className="size-3.5" />Merge into selected</Button></div>
              <ul className="divide-y divide-line">{g.leads.map((l) => (
                <li key={l.id}><label className={cn('flex cursor-pointer items-center gap-3 px-3 py-2.5', target === l.id && 'bg-accent-soft/40')}>
                  <input type="radio" name={gk} checked={target === l.id} onChange={() => setKeep({ ...keep, [gk]: l.id })} aria-label={`Keep ${l.name}`} className="accent-[#5558e3]" />
                  <Avatar name={l.name} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{l.name}{target === l.id && <Badge tone="accent" className="ml-2">Keep</Badge>}</span><span className="block truncate text-xs text-ink-3">{[l.email, l.phone, l.companyName].filter(Boolean).join(' · ')}</span></span>
                  <span className="hidden text-right text-xs text-ink-3 sm:block">{l.assignedTo?.name ?? 'Unassigned'}<br />{fmtDate(l.createdAt)}</span>
                </label></li>))}</ul>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
