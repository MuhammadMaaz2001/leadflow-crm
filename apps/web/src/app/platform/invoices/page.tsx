'use client';
import * as React from 'react';
import Link from 'next/link';
import { Check, FileText, Search, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errMsg, useMe } from '@/lib/session';
import { fmtDate, money, titleCase } from '@/lib/format';
import { useDebounced } from '@/lib/use-url-state';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { Dialog, useConfirm } from '@/components/ui/overlay';

interface I { id: string; number: string; description: string; status: string; amount: number; currency: string; issuedAt: string; dueAt: string; paidAt: string | null; paymentMethod: string | null; paymentReference: string | null; failureReason: string | null; organization: { id: string; name: string } }

export default function InvoicesPage() {
  const me = useMe(); const role = me.data?.user.platformRole; const canBill = role === 'SUPER_ADMIN' || role === 'BILLING_ADMIN';
  const confirm = useConfirm(); const qc = useQueryClient();
  const [q, setQ] = React.useState(''); const dq = useDebounced(q); const [status, setStatus] = React.useState(''); const [page, setPage] = React.useState(1);
  const res = useQuery({ queryKey: ['platform', 'invoices', dq, status, page], queryFn: () => api.page<I>('/platform/invoices', { q: dq || undefined, status: status || undefined, page, pageSize: 25 }), placeholderData: (p) => p });
  const [pay, setPay] = React.useState<I | null>(null); const [fail, setFail] = React.useState<I | null>(null);
  const [text, setText] = React.useState(''); const [error, setError] = React.useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });
  const markPaid = useMutation({ mutationFn: () => api.post(`/platform/invoices/${pay!.id}/mark-paid`, { reference: text }, { tenant: false }), onSuccess: () => { toast.success('Recorded as paid manually'); setPay(null); refresh(); }, onError: (e) => setError(errMsg(e)) });
  const markFailed = useMutation({ mutationFn: () => api.post(`/platform/invoices/${fail!.id}/mark-failed`, { reason: text }, { tenant: false }), onSuccess: () => { toast.success('Marked as failed'); setFail(null); refresh(); }, onError: (e) => setError(errMsg(e)) });
  const voidInv = useMutation({ mutationFn: (id: string) => api.post(`/platform/invoices/${id}/void`, {}, { tenant: false }), onSuccess: () => { toast.success('Invoice voided'); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const columns: Column<I>[] = [
    { key: 'number', header: 'Invoice', primary: true, cell: (i) => <div><p className="font-medium">{i.number}</p><p className="max-w-[260px] truncate text-xs text-ink-3">{i.description}</p></div> },
    { key: 'org', header: 'Organization', cell: (i) => <Link href={`/platform/organizations/${i.organization.id}`} className="text-accent-ink hover:underline">{i.organization.name}</Link> },
    { key: 'amount', header: 'Amount', className: 'text-right', cell: (i) => <span className="tnum font-medium">{money(i.amount, i.currency)}</span> },
    { key: 'status', header: 'Status', cell: (i) => <div><Badge tone={i.status === 'PAID' ? 'ok' : i.status === 'OPEN' ? 'warn' : i.status === 'FAILED' ? 'bad' : 'neutral'}>{titleCase(i.status)}</Badge>{i.status === 'PAID' && <p className="mt-0.5 text-[10px] text-ink-3">{i.paymentMethod === 'MANUAL_PLATFORM' || i.paymentMethod === 'MANUAL_DEV' ? 'manual' : i.paymentMethod} · {i.paymentReference}</p>}{i.failureReason && <p className="mt-0.5 text-[10px] text-bad">{i.failureReason}</p>}</div> },
    { key: 'issued', header: 'Issued', hideBelow: 'md', cell: (i) => <span className="text-ink-2">{fmtDate(i.issuedAt)}</span> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', mobileLabel: '', cell: (i) => canBill && ['OPEN', 'FAILED'].includes(i.status) ? <div className="flex justify-end gap-1.5"><Button size="sm" variant="primary" onClick={() => { setText(''); setError(null); setPay(i); }}><Check className="size-3.5" />Mark paid</Button>{i.status === 'OPEN' && <Button size="sm" onClick={() => { setText(''); setError(null); setFail(i); }}>Mark failed</Button>}<Button size="sm" variant="dangerGhost" aria-label={`Void ${i.number}`} onClick={async () => { if (await confirm({ title: `Void ${i.number}?`, destructive: true, confirmLabel: 'Void invoice' })) voidInv.mutate(i.id); }}><X className="size-3.5" /></Button></div> : null },
  ];
  return (
    <>
      <PageHeader title="Invoices & billing" count={res.data?.meta.total} description={res.data?.meta.totalAmount !== undefined ? `${money(Number(res.data.meta.totalAmount), 'USD')} across this view` : undefined} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-line p-3"><div className="relative min-w-[200px] max-w-xs flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" /><Input aria-label="Search invoices" placeholder="Invoice number or organization…" className="pl-8" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div><div className="w-36"><Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">Any status</option>{['OPEN', 'PAID', 'FAILED', 'VOID'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></div></div>
        <DataTable columns={columns} rows={res.data?.data} loading={res.isLoading} error={res.error} onRetry={() => res.refetch()} empty={<EmptyState icon={<FileText />} title="No invoices" />} />
        {(res.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={25} total={res.data!.meta.total} noun="invoices" onPage={setPage} />}
      </Card>
      <p className="mt-3 text-xs text-ink-3">No payment processor is integrated. “Mark paid” records a payment received outside the system and is attributed to you in the audit log.</p>
      <Dialog open={!!pay} onOpenChange={(o) => !o && setPay(null)} size="sm" title={`Record payment for ${pay?.number}`} description="Manual entry — nothing is charged." footer={<><Button onClick={() => setPay(null)}>Cancel</Button><Button variant="primary" loading={markPaid.isPending} disabled={!text.trim()} onClick={() => markPaid.mutate()}>Record payment</Button></>}><div className="space-y-3"><FormError message={error} /><Field label="Payment reference" required><Input aria-label="Payment reference" value={text} onChange={(e) => setText(e.target.value)} placeholder="Wire #, cheque no., …" /></Field></div></Dialog>
      <Dialog open={!!fail} onOpenChange={(o) => !o && setFail(null)} size="sm" title={`Mark ${fail?.number} as failed`} footer={<><Button onClick={() => setFail(null)}>Cancel</Button><Button variant="danger" loading={markFailed.isPending} disabled={text.trim().length < 3} onClick={() => markFailed.mutate()}>Mark failed</Button></>}><div className="space-y-3"><FormError message={error} /><Field label="Failure reason" required><Input aria-label="Failure reason" value={text} onChange={(e) => setText(e.target.value)} /></Field></div></Dialog>
    </>
  );
}
