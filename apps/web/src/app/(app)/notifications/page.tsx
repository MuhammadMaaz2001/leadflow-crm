'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAct, useT } from '@/lib/session';
import { fmtDateTime, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/form';
import { Badge, Card, EmptyState, PageHeader, Pagination, Skeleton } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/menu';

interface N { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

export function NotificationPrefs() {
  const q = useT(['notif-prefs'], () => api.get<Array<{ type: string; label: string; inApp: boolean }>>('/notifications/preferences'));
  const save = useAct((v: { type: string; inApp: boolean }) => api.put('/notifications/preferences', { prefs: [v] }), { invalidate: ['notif-prefs'], success: 'Preference saved' });
  return (
    <Card className="divide-y divide-line">
      {q.isLoading ? <Skeleton className="m-4 h-40" /> : q.data?.map((p) => (
        <label key={p.type} className="flex items-center justify-between gap-4 px-4 py-3 text-[13px]"><span><span className="font-medium">{p.label}</span></span><span className="flex items-center gap-2 text-xs text-ink-3">In-app<Switch aria-label={`${p.label} in-app notification`} checked={p.inApp} onCheckedChange={(v) => save.mutate({ type: p.type, inApp: v })} /></span></label>
      ))}
      <p className="px-4 py-3 text-xs text-ink-3">In-app notifications appear in the bell menu. Email delivery is not available in this build.</p>
    </Card>
  );
}

export default function NotificationsPage() {
  const router = useRouter();
  const [page, setPage] = React.useState(1);
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const q = useT(['notifications', 'page', page, unreadOnly], () => api.page<N>('/notifications', { page, pageSize: 20, unreadOnly }), { keep: true });
  const readAll = useAct(() => api.post('/notifications/read-all'), { success: 'All caught up' });
  const read = useAct((v: { id: string; read: boolean }) => api.post(`/notifications/${v.id}/${v.read ? 'read' : 'unread'}`), { silent: true });
  return (
    <>
      <PageHeader title="Notifications" description="Reminders, assignments, deadlines and automation alerts." actions={<Button onClick={() => readAll.mutate()} disabled={!q.data?.meta.unread}><CheckCheck className="size-3.5" />Mark all read</Button>} />
      <Tabs defaultValue="inbox">
        <TabsList><TabsTrigger value="inbox">Inbox {Number(q.data?.meta.unread) > 0 && <Badge tone="accent" className="ml-1">{String(q.data?.meta.unread)}</Badge>}</TabsTrigger><TabsTrigger value="prefs"><Settings2 className="mr-1 size-3.5" />Preferences</TabsTrigger></TabsList>
        <TabsContent value="inbox" className="pt-4">
          <Card>
            <div className="flex gap-1 border-b border-line p-2">{[[false, 'All'], [true, 'Unread']].map(([v, l]) => <button key={String(l)} onClick={() => { setUnreadOnly(Boolean(v)); setPage(1); }} className={cn('rounded-md px-3 py-1 text-xs font-medium', unreadOnly === v ? 'bg-subtle text-ink' : 'text-ink-2')}>{String(l)}</button>)}</div>
            {q.isLoading ? <Skeleton className="m-4 h-60" /> : !q.data?.data.length ? <EmptyState icon={<Bell />} title={unreadOnly ? 'No unread notifications' : 'No notifications yet'} /> : (
              <ul className="divide-y divide-line">{q.data.data.map((n) => (
                <li key={n.id} className={cn('flex items-start gap-3 px-4 py-3', !n.readAt && 'bg-accent-soft/30')}>
                  <span className={cn('mt-2 size-2 shrink-0 rounded-full', n.readAt ? 'bg-line-strong' : 'bg-accent')} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => { if (!n.readAt) read.mutate({ id: n.id, read: true }); if (n.link) router.push(n.link); }}><p className="text-[13px] font-medium">{n.title}</p>{n.body && <p className="text-xs text-ink-2">{n.body}</p>}<p className="mt-0.5 text-[11px] text-ink-3" title={fmtDateTime(n.createdAt)}>{timeAgo(n.createdAt)}</p></button>
                  <Button size="sm" variant="ghost" onClick={() => read.mutate({ id: n.id, read: !n.readAt })}>{n.readAt ? 'Mark unread' : 'Mark read'}</Button>
                </li>))}</ul>
            )}
            {(q.data?.meta.total ?? 0) > 0 && <Pagination page={page} pageSize={20} total={q.data!.meta.total} noun="notifications" onPage={setPage} />}
          </Card>
        </TabsContent>
        <TabsContent value="prefs" className="pt-4"><NotificationPrefs /></TabsContent>
      </Tabs>
    </>
  );
}
