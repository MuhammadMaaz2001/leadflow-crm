'use client';
import * as React from 'react';
import { Copy, Mail, MoreHorizontal, Shield, UserPlus, UserX, UserCheck, Users, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useMembers, type Member } from '@/lib/hooks';
import { errMsg, useAct, useOrg, useT } from '@/lib/session';
import { fmtDate, money, pct, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, Switch } from '@/components/ui/form';
import { Avatar, Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { Dialog, Sheet, useConfirm } from '@/components/ui/overlay';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';

interface Role { id: string; name: string; systemKey: string | null; memberCount: number }
interface Invite { id: string; email: string; role: { id: string; name: string }; status: string; expiresAt: string; createdAt: string }

function InviteDialog({ open, onOpenChange, roles }: { open: boolean; onOpenChange: (o: boolean) => void; roles: Role[] }) {
  const [email, setEmail] = React.useState('');
  const [roleId, setRoleId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setEmail(''); setError(null); setLink(null); setRoleId(roles.find((r) => r.systemKey === 'SALES_AGENT')?.id ?? roles[0]?.id ?? ''); } }, [open, roles]);
  const save = useAct(() => api.post<{ devInviteLink?: string }>('/invitations', { email, roleId }), { success: 'Invitation sent', silent: true, onSuccess: (r) => setLink(r.devInviteLink ?? null), onError: (e) => setError(errMsg(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Invite team member" description="They'll receive a link to join this workspace with the selected role."
      footer={link ? <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button> : <><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!email.includes('@')} onClick={() => save.mutate()}>Send invitation</Button></>}>
      {link ? (
        <div className="space-y-3"><p className="text-[13px]">Invitation sent to <b>{email}</b>.</p>
          <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn"><p className="font-semibold">Development environment</p><p className="mt-0.5">Emails are not delivered in development. Share this link manually or find it in the <a className="underline" href={`/dev/mailbox?email=${encodeURIComponent(email)}`} target="_blank">dev mailbox</a>:</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-[11px] text-ink">{link}</code><Button size="sm" onClick={() => { navigator.clipboard?.writeText(link); toast.success('Link copied'); }}><Copy className="size-3.5" />Copy</Button></div></div></div>
      ) : (
        <div className="space-y-4"><FormError message={error} /><Field label="Email address" required htmlFor="inv-email"><Input id="inv-email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></Field>
          <Field label="Role" required htmlFor="inv-role"><Select id="inv-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.filter((r) => r.systemKey !== 'OWNER').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field></div>
      )}
    </Dialog>
  );
}

function MemberSheet({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { can, currency } = useOrg();
  const [range, setRange] = React.useState('last_30_days');
  const q = useT(['member-perf', member?.userId, range], () => api.get<{ rows: Array<{ id: string; leads: number; contacted: number; contactRate: number; avgResponseHours: number | null; won: number; lost: number; wonValue: number; conversionRate: number; followUpsCompleted: number; openOpportunities: number }> }>('/reports/salesperson', { range, assignedToId: member?.userId }), { enabled: !!member && can('reports.view_all') });
  const p = q.data?.rows[0];
  return (
    <Sheet open={!!member} onOpenChange={(o) => !o && onClose()} title={member?.name ?? ''} description={member ? `${member.role.name} · ${member.email}` : undefined}>
      {member && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">{[['Open leads', member.workload.openLeads], ['Open deals', member.workload.openOpportunities], ['Pending follow-ups', member.workload.openFollowUps], ['Overdue follow-ups', member.workload.overdueFollowUps], ['Open tasks', member.workload.openTasks]].map(([l, v]) => <div key={String(l)} className="rounded-lg border border-line p-3"><p className="text-xs text-ink-3">{l}</p><p className={cn('tnum text-xl font-semibold', l === 'Overdue follow-ups' && Number(v) > 0 && 'text-bad')}>{v}</p></div>)}</div>
          {can('reports.view_all') && (
            <div>
              <div className="mb-2 flex items-center justify-between"><h3 className="text-[13px] font-semibold">Performance</h3><div className="w-36"><Select aria-label="Performance range" value={range} onChange={(e) => setRange(e.target.value)}><option value="last_7_days">Last 7 days</option><option value="last_30_days">Last 30 days</option><option value="this_month">This month</option><option value="this_quarter">This quarter</option><option value="all">All time</option></Select></div></div>
              {q.isLoading ? <Skeleton className="h-32" /> : p ? (
                <dl className="divide-y divide-line rounded-lg border border-line px-3 text-[13px]">
                  {[['Leads received', p.leads], ['Contacted', `${p.contacted} (${pct(p.contactRate)})`], ['Avg first response', p.avgResponseHours == null ? '—' : `${p.avgResponseHours} h`], ['Follow-ups completed', p.followUpsCompleted], ['Deals won / lost', `${p.won} / ${p.lost}`], ['Conversion rate', pct(p.conversionRate)], ['Won value', money(p.wonValue, currency)]].map(([l, v]) => <div key={String(l)} className="flex justify-between py-2"><dt className="text-ink-3">{l}</dt><dd className="tnum font-medium">{v}</dd></div>)}
                </dl>
              ) : <p className="text-xs text-ink-3">No data.</p>}
            </div>
          )}
          <p className="text-xs text-ink-3">Joined {fmtDate(member.joinedAt)} · Last sign-in {member.lastLoginAt ? timeAgo(member.lastLoginAt) : 'never'}</p>
        </div>
      )}
    </Sheet>
  );
}

export default function TeamPage() {
  const { can } = useOrg();
  const confirm = useConfirm();
  const members = useMembers();
  const roles = useT(['roles'], () => api.get<Role[]>('/roles'));
  const invites = useT(['invitations'], () => api.get<Invite[]>('/invitations'), { enabled: can('team.manage') });
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [sel, setSel] = React.useState<Member | null>(null);
  const patch = useAct((v: { id: string; body: Record<string, unknown> }) => api.patch(`/members/${v.id}`, v.body), { success: 'Member updated' });
  const revoke = useAct((id: string) => api.del(`/invitations/${id}`), { success: 'Invitation revoked' });
  const resend = useAct((id: string) => api.post<{ devInviteLink?: string }>(`/invitations/${id}/resend`), { success: 'New invitation link generated', onSuccess: (r) => r.devInviteLink && navigator.clipboard?.writeText(r.devInviteLink) });
  const active = members.data?.filter((m) => m.status === 'ACTIVE').length ?? 0;
  const manage = can('team.manage');

  const columns: Column<Member>[] = [
    { key: 'name', header: 'Member', primary: true, cell: (m) => <div className="flex items-center gap-2.5"><Avatar name={m.name} /><div className="min-w-0"><p className="truncate font-medium">{m.name}{m.status === 'DEACTIVATED' && <Badge className="ml-2" tone="bad">Deactivated</Badge>}</p><p className="truncate text-xs text-ink-3">{m.email}</p></div></div> },
    { key: 'role', header: 'Role', cell: (m) => manage && m.role.key !== 'OWNER' && m.status === 'ACTIVE' ? (
      <div className="w-36" onClick={(e) => e.stopPropagation()}><Select aria-label={`Role for ${m.name}`} value={m.role.id} onChange={(e) => patch.mutate({ id: m.id, body: { roleId: e.target.value } })}>{roles.data?.filter((r) => r.systemKey !== 'OWNER').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></div>
    ) : <Badge tone={m.role.key === 'OWNER' ? 'accent' : 'neutral'}><Shield className="size-3" />{m.role.name}</Badge> },
    { key: 'leads', header: 'Open leads', className: 'text-right', hideBelow: 'md', cell: (m) => <span className="tnum">{m.workload.openLeads}</span> },
    { key: 'deals', header: 'Open deals', className: 'text-right', hideBelow: 'lg', cell: (m) => <span className="tnum">{m.workload.openOpportunities}</span> },
    { key: 'fu', header: 'Follow-ups', className: 'text-right', hideBelow: 'md', cell: (m) => <span className="tnum">{m.workload.openFollowUps}{m.workload.overdueFollowUps > 0 && <span className="ml-1 text-bad">({m.workload.overdueFollowUps} overdue)</span>}</span> },
    { key: 'tasks', header: 'Tasks', className: 'text-right', hideBelow: 'lg', cell: (m) => <span className="tnum">{m.workload.openTasks}</span> },
    { key: 'assignable', header: <span title="Included in round-robin / auto-assignment">Auto-assign</span>, hideBelow: 'lg', cell: (m) => <div onClick={(e) => e.stopPropagation()}><Switch aria-label={`Auto-assign leads to ${m.name}`} checked={m.isAssignable} disabled={!manage || m.status !== 'ACTIVE'} onCheckedChange={(v) => patch.mutate({ id: m.id, body: { isAssignable: v } })} /></div> },
    { key: 'last', header: 'Last active', hideBelow: 'lg', cell: (m) => <span className="text-xs text-ink-3">{m.lastLoginAt ? timeAgo(m.lastLoginAt) : 'Never'}</span> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'w-10', mobileLabel: '', cell: (m) => manage && m.role.key !== 'OWNER' ? (
      <DropdownMenu><DropdownTrigger asChild><Button variant="ghost" size="iconSm" aria-label={`Actions for ${m.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal className="size-4" /></Button></DropdownTrigger>
        <DropdownContent onClick={(e) => e.stopPropagation()}>
          {m.status === 'ACTIVE' ? <DropdownItem destructive icon={<UserX />} onSelect={async () => { if (await confirm({ title: `Deactivate ${m.name}?`, description: 'They lose access immediately. Their leads stay assigned until you reassign them.', confirmLabel: 'Deactivate', destructive: true })) patch.mutate({ id: m.id, body: { status: 'DEACTIVATED' } }); }}>Deactivate</DropdownItem> : <DropdownItem icon={<UserCheck />} onSelect={() => patch.mutate({ id: m.id, body: { status: 'ACTIVE' } })}>Reactivate</DropdownItem>}
        </DropdownContent></DropdownMenu>) : null },
  ];
  return (
    <>
      <PageHeader title="Team members" description={members.data ? `${active} active · ${manage ? 'manage roles, access and workload' : 'workload and roles'}` : undefined} actions={manage && <Button variant="primary" onClick={() => setInviteOpen(true)}><UserPlus className="size-3.5" />Invite member</Button>} />
      <Tabs defaultValue="members">
        <TabsList><TabsTrigger value="members">Members</TabsTrigger>{manage && <TabsTrigger value="invites">Invitations {invites.data?.filter((i) => i.status === 'PENDING').length ? <Badge tone="accent" className="ml-1">{invites.data.filter((i) => i.status === 'PENDING').length}</Badge> : null}</TabsTrigger>}</TabsList>
        <TabsContent value="members" className="pt-4"><Card><DataTable columns={columns} rows={members.data} loading={members.isLoading} error={members.error} onRetry={() => members.refetch()} onRowClick={setSel} empty={<EmptyState icon={<Users />} title="No members" />} /></Card></TabsContent>
        {manage && <TabsContent value="invites" className="pt-4"><Card>
          {!invites.data?.length ? <EmptyState icon={<Mail />} title="No invitations" description="Invite colleagues to collaborate in this workspace." action={<Button variant="primary" onClick={() => setInviteOpen(true)}>Invite member</Button>} /> : (
            <ul className="divide-y divide-line">{invites.data.map((i) => <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><Avatar name={i.email} /><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{i.email}</p><p className="text-xs text-ink-3">{i.role.name} · sent {timeAgo(i.createdAt)}</p></div><Badge tone={i.status === 'PENDING' ? 'accent' : i.status === 'ACCEPTED' ? 'ok' : 'neutral'}>{i.status.toLowerCase()}</Badge>{i.status !== 'ACCEPTED' && <div className="flex gap-1.5"><Button size="sm" onClick={() => resend.mutate(i.id)}><RefreshCw className="size-3.5" />New link</Button>{i.status === 'PENDING' && <Button size="sm" variant="dangerGhost" onClick={() => revoke.mutate(i.id)}><Trash2 className="size-3.5" />Revoke</Button>}</div>}</li>)}</ul>
          )}
        </Card></TabsContent>}
      </Tabs>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={roles.data ?? []} />
      <MemberSheet member={sel} onClose={() => setSel(null)} />
    </>
  );
}
void CardHeader;
