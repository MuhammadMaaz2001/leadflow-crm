'use client';
import * as React from 'react';
import { Search, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errMsg, useMe } from '@/lib/session';
import { fmtDate, timeAgo, titleCase } from '@/lib/format';
import { useDebounced } from '@/lib/use-url-state';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { useConfirm } from '@/components/ui/overlay';

interface U { id: string; name: string; email: string; isActive: boolean; emailVerified: boolean; platformRole: string | null; lastLoginAt: string | null; createdAt: string; workspaces: Array<{ id: string; name: string; role: string; status: string }> }

export default function UsersPage() {
  const me = useMe(); const role = me.data?.user.platformRole;
  const confirm = useConfirm(); const qc = useQueryClient();
  const [q, setQ] = React.useState(''); const dq = useDebounced(q); const [page, setPage] = React.useState(1);
  const res = useQuery({ queryKey: ['platform', 'users', dq, page], queryFn: () => api.page<U>('/platform/users', { q: dq || undefined, page, pageSize: 25 }), placeholderData: (p) => p });
  const status = useMutation({ mutationFn: (v: { id: string; isActive: boolean }) => api.post(`/platform/users/${v.id}/status`, { isActive: v.isActive }, { tenant: false }), onSuccess: () => { toast.success('User updated'); qc.invalidateQueries({ queryKey: ['platform', 'users'] }); }, onError: (e) => toast.error(errMsg(e)) });
  const setRole = useMutation({ mutationFn: (v: { id: string; role: string | null }) => api.post(`/platform/users/${v.id}/platform-role`, { role: v.role }, { tenant: false }), onSuccess: () => { toast.success('Platform role updated'); qc.invalidateQueries({ queryKey: ['platform', 'users'] }); }, onError: (e) => toast.error(errMsg(e)) });
  const canSupport = role === 'SUPER_ADMIN' || role === 'SUPPORT_ADMIN';
  const columns: Column<U>[] = [
    { key: 'name', header: 'User', primary: true, cell: (u) => <div><p className="font-medium">{u.name}{u.platformRole && <Badge tone="warn" className="ml-2"><ShieldCheck className="size-3" />{titleCase(u.platformRole)}</Badge>}</p><p className="text-xs text-ink-3">{u.email}</p></div> },
    { key: 'status', header: 'Status', cell: (u) => <span className="flex gap-1"><Badge tone={u.isActive ? 'ok' : 'bad'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge>{!u.emailVerified && <Badge tone="warn">Unverified</Badge>}</span> },
    { key: 'ws', header: 'Workspaces', hideBelow: 'md', cell: (u) => <span className="text-ink-2">{u.workspaces.length ? u.workspaces.map((w) => `${w.name} (${w.role})`).join(', ') : '—'}</span> },
    { key: 'last', header: 'Last sign-in', hideBelow: 'lg', cell: (u) => <span className="text-xs text-ink-3">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'} · joined {fmtDate(u.createdAt)}</span> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', mobileLabel: '', cell: (u) => (
      <div className="flex justify-end gap-1.5">
        {role === 'SUPER_ADMIN' && u.id !== me.data?.user.id && <div className="w-32"><Select aria-label={`Platform role for ${u.name}`} value={u.platformRole ?? ''} onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value || null })}><option value="">No platform role</option><option value="SUPER_ADMIN">Super admin</option><option value="SUPPORT_ADMIN">Support admin</option><option value="BILLING_ADMIN">Billing admin</option></Select></div>}
        {canSupport && u.id !== me.data?.user.id && (u.isActive ? <Button size="sm" variant="dangerGhost" onClick={async () => { if (await confirm({ title: `Deactivate ${u.name}?`, description: 'They are signed out everywhere and cannot sign in.', destructive: true, confirmLabel: 'Deactivate' })) status.mutate({ id: u.id, isActive: false }); }}><UserX className="size-3.5" />Deactivate</Button> : <Button size="sm" onClick={() => status.mutate({ id: u.id, isActive: true })}><UserCheck className="size-3.5" />Activate</Button>)}
      </div>) },
  ];
  return (
    <>
      <PageHeader title="Users" count={res.data?.meta.total} description="All accounts across the platform." />
      <Card>
        <div className="border-b border-line p-3"><div className="relative max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" /><Input aria-label="Search users" placeholder="Search name or email…" className="pl-8" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div></div>
        <DataTable columns={columns} rows={res.data?.data} loading={res.isLoading} error={res.error} onRetry={() => res.refetch()} empty={<EmptyState title="No users" />} />
        {(res.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={25} total={res.data!.meta.total} noun="users" onPage={setPage} />}
      </Card>
    </>
  );
}
