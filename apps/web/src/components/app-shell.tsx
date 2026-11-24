'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Dialog as RDialog } from 'radix-ui';
import {
  Activity, AlertTriangle, BarChart3, Bell, Building2, CalendarCheck, ChevronsUpDown, CreditCard, GitBranch, LayoutDashboard, LogOut, Menu, PanelLeftClose, PanelLeftOpen,
  Plus, Search, Settings, ShieldAlert, Target, UserCircle, Users, Workflow, Zap, Check, CheckCheck, X, Handshake,
} from 'lucide-react';
import type { PermissionKey } from '@leadflow/shared';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { fullNameOf } from '@/lib/lead-utils';
import { useAct, useOrg, useRequireAuth, useT, useWorkspace } from '@/lib/session';
import { timeAgo } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar, Badge, EmptyState, Skeleton, Spinner } from '@/components/ui/data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/menu';
import { Logo } from './brand';

interface NavItem { href: string; label: string; icon: React.ReactNode; perms?: PermissionKey[] }
const NAV: Array<{ section: string; items: NavItem[] }> = [
  { section: 'Workspace', items: [
    { href: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard /> },
    { href: '/leads', label: 'Leads', icon: <Target /> },
    { href: '/pipeline', label: 'Sales Pipeline', icon: <GitBranch /> },
    { href: '/opportunities', label: 'Opportunities', icon: <Handshake /> },
    { href: '/follow-ups', label: 'Follow-ups', icon: <CalendarCheck /> },
    { href: '/tasks', label: 'Tasks & Calendar', icon: <Workflow /> },
  ] },
  { section: 'Management', items: [
    { href: '/team', label: 'Team Members', icon: <Users />, perms: ['team.view', 'team.manage'] },
    { href: '/reports', label: 'Reports & Analytics', icon: <BarChart3 />, perms: ['reports.view'] },
    { href: '/activity', label: 'Activity Logs', icon: <Activity /> },
  ] },
  { section: 'Configuration', items: [
    { href: '/automations', label: 'Automations', icon: <Zap />, perms: ['automations.manage', 'settings.manage'] },
    { href: '/billing', label: 'Subscription & Billing', icon: <CreditCard />, perms: ['billing.view', 'billing.manage'] },
    { href: '/settings', label: 'Workspace Settings', icon: <Settings />, perms: ['settings.manage'] },
  ] },
];

const CRUMBS: Record<string, string> = {
  dashboard: 'Dashboard', leads: 'Leads', pipeline: 'Sales Pipeline', opportunities: 'Opportunities', 'follow-ups': 'Follow-ups', tasks: 'Tasks & Calendar', team: 'Team Members',
  reports: 'Reports & Analytics', activity: 'Activity Logs', automations: 'Automations', billing: 'Subscription & Billing', settings: 'Workspace Settings', notifications: 'Notifications', profile: 'My Profile',
};

function NavList({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  const { canAny } = useOrg();
  return (
    <nav aria-label="Main" className="scroll-thin flex-1 space-y-5 overflow-y-auto px-2 pb-3">
      {NAV.map((g) => {
        const items = g.items.filter((i) => !i.perms || canAny(...i.perms));
        if (!items.length) return null;
        return (
          <div key={g.section}>
            {!collapsed ? <p className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{g.section}</p> : <div className="mx-2 mb-1.5 h-px bg-line" />}
            <ul className="space-y-0.5">
              {items.map((i) => {
                const active = path === i.href || path.startsWith(`${i.href}/`);
                const link = (
                  <Link href={i.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                    className={cn('group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors [&>svg]:size-4 [&>svg]:shrink-0', active ? 'bg-accent-soft text-accent-ink' : 'text-ink-2 hover:bg-subtle hover:text-ink', collapsed && 'justify-center px-0')}>
                    {i.icon}{!collapsed && <span className="truncate">{i.label}</span>}
                  </Link>
                );
                return <li key={i.href}>{collapsed ? <Tooltip content={i.label} side="right">{link}</Tooltip> : link}</li>;
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function WorkspaceSwitcher({ collapsed }: { collapsed?: boolean }) {
  const { workspaces, current, switchTo } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  if (!current) return null;
  const o = current.organization;
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <button className={cn('mx-2 mb-3 mt-2 flex items-center gap-2.5 rounded-lg border border-line bg-surface p-1.5 text-left shadow-card transition-colors hover:bg-subtle', collapsed ? 'justify-center' : 'w-[calc(100%-16px)]')} aria-label="Switch workspace">
          <WorkspaceLogo name={o.name} logo={o.logoData} />
          {!collapsed && <><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold">{o.name}</span><span className="block truncate text-[11px] text-ink-3">{current.role.name} · {current.subscription?.planName ?? 'No plan'}</span></span><ChevronsUpDown className="mr-1 size-3.5 text-ink-3" /></>}
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-64">
        <DropdownLabel>Workspaces</DropdownLabel>
        {workspaces.map((w) => (
          <DropdownItem key={w.organization.id} onSelect={() => { switchTo(w.organization.id); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== w.organization.id }); router.push('/dashboard'); }}>
            <WorkspaceLogo name={w.organization.name} logo={w.organization.logoData} small />
            <span className="min-w-0 flex-1"><span className="block truncate">{w.organization.name}</span><span className="block text-[11px] text-ink-3">{w.role.name}</span></span>
            {w.organization.id === o.id && <Check className="size-3.5 text-accent" />}
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem icon={<Plus />} onSelect={() => router.push('/onboarding?new=1')}>Create workspace</DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}
export function WorkspaceLogo({ name, logo, small }: { name: string; logo?: string | null; small?: boolean }) {
  const s = small ? 'size-6 rounded-md text-[10px]' : 'size-8 rounded-md text-xs';
  // eslint-disable-next-line @next/next/no-img-element
  if (logo) return <img src={logo} alt="" className={cn(s, 'shrink-0 object-cover')} />;
  return <span className={cn(s, 'flex shrink-0 items-center justify-center bg-ink font-semibold text-white')} aria-hidden>{name.slice(0, 2).toUpperCase()}</span>;
}

function GlobalSearch() {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [debounced, setDebounced] = React.useState('');
  const ref = React.useRef<HTMLInputElement>(null);
  const router = useRouter();
  React.useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 220); return () => clearTimeout(t); }, [q]);
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); setOpen(true); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  const res = useT(['global-search', debounced], () => api.page<{ id: string; name: string; email: string | null; companyName: string | null; status: string }>('/leads', { q: debounced, pageSize: 6 }), { enabled: debounced.length >= 2 });
  return (
    <div className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
      <Input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Search leads by name, email, phone…" aria-label="Global search" className="h-8 pl-8 pr-12 bg-subtle/70 shadow-none"
        onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { router.push(`/leads?q=${encodeURIComponent(q.trim())}`); setOpen(false); } if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); } }} />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-surface px-1.5 text-[10px] font-medium text-ink-3 sm:block">⌘K</kbd>
      {open && debounced.length >= 2 && (
        <div className="animate-lf-pop absolute left-0 right-0 top-10 z-40 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          {res.isLoading ? <div className="flex items-center gap-2 p-4 text-xs text-ink-3"><Spinner /> Searching…</div> : res.data?.data.length ? (
            <ul>
              {res.data.data.map((l) => (
                <li key={l.id}><Link href={`/leads/${l.id}`} className="flex items-center gap-2.5 px-3 py-2 hover:bg-subtle" onClick={() => setOpen(false)}>
                  <Avatar name={l.name} size="sm" /><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{l.name}</span><span className="block truncate text-xs text-ink-3">{l.companyName ?? l.email}</span></span>
                </Link></li>
              ))}
              <li className="border-t border-line"><Link href={`/leads?q=${encodeURIComponent(debounced)}`} className="block px-3 py-2 text-xs text-accent-ink hover:bg-subtle" onClick={() => setOpen(false)}>See all results for “{debounced}”</Link></li>
            </ul>
          ) : <p className="p-4 text-xs text-ink-3">No leads match “{debounced}”.</p>}
        </div>
      )}
    </div>
  );
}

interface Notif { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }
function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const count = useT(['notif-count'], () => api.get<{ unread: number }>('/notifications/unread-count'), { refetchInterval: 30_000 });
  const list = useT(['notifications', 'bell'], () => api.page<Notif>('/notifications', { pageSize: 8 }), { enabled: open });
  const readAll = useAct(() => api.post('/notifications/read-all'), { invalidate: ['notif-count', 'notifications'] });
  const readOne = useAct((id: string) => api.post(`/notifications/${id}/read`), { invalidate: ['notif-count', 'notifications'], silent: true });
  const unread = count.data?.unread ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative">
          <Bell className="size-4" />
          {unread > 0 && <span className="tnum absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(380px,calc(100vw-24px))]">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <p className="text-[13px] font-semibold">Notifications</p>
          <Button size="sm" variant="ghost" disabled={!unread} onClick={() => readAll.mutate()}><CheckCheck className="size-3.5" />Mark all read</Button>
        </div>
        <div className="scroll-thin max-h-[420px] overflow-y-auto">
          {list.isLoading ? <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div> : !list.data?.data.length ? <EmptyState className="py-10" icon={<Bell />} title="You're all caught up" description="Reminders, assignments and deadlines will show up here." /> : (
            <ul className="divide-y divide-line">
              {list.data.data.map((n) => (
                <li key={n.id}>
                  <button className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-subtle', !n.readAt && 'bg-accent-soft/40')} onClick={() => { if (!n.readAt) readOne.mutate(n.id); setOpen(false); if (n.link) router.push(n.link); }}>
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} />
                    <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium leading-5">{n.title}</span>{n.body && <span className="block truncate text-xs text-ink-2">{n.body}</span>}<span className="text-[11px] text-ink-3">{timeAgo(n.createdAt)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-xs font-medium text-accent-ink hover:bg-subtle">View all notifications</Link>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu() {
  const { me } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const logout = useAct(() => api.post('/auth/logout', {}, { tenant: false }), { silent: true, onSuccess: () => { qc.clear(); try { localStorage.removeItem('lf_org'); } catch { /* ignore */ } router.replace('/login'); } });
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownTrigger asChild><button aria-label="Account menu" className="rounded-full focus-visible:outline-accent"><Avatar name={me.user.name} /></button></DropdownTrigger>
      <DropdownContent className="w-60">
        <div className="px-2 py-2"><p className="truncate text-[13px] font-semibold">{me.user.name}</p><p className="truncate text-xs text-ink-3">{me.user.email}</p></div>
        <DropdownSeparator />
        <DropdownItem icon={<UserCircle />} onSelect={() => router.push('/profile')}>Profile & security</DropdownItem>
        {me.user.platformRole && <DropdownItem icon={<Building2 />} onSelect={() => router.push('/platform')}>Platform administration</DropdownItem>}
        <DropdownSeparator />
        <DropdownItem icon={<LogOut />} onSelect={() => logout.mutate()}>Sign out</DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

function StatusBanner() {
  const { org } = useOrg();
  const [now] = React.useState(() => Date.now());
  if (!org?.subscription) return null;
  const s = org.subscription;
  const days = Math.ceil((new Date(s.trialEndsAt ?? s.currentPeriodEnd).getTime() - now) / 86_400_000);
  let tone: 'warn' | 'bad' | 'info' | null = null; let text = '';
  if (org.organization.status === 'SUSPENDED') { tone = 'bad'; text = 'This workspace is suspended.'; }
  else if (s.status === 'EXPIRED') { tone = 'bad'; text = 'Your subscription has expired — the workspace is read-only until the outstanding invoice is paid.'; }
  else if (s.status === 'PAST_DUE') { tone = 'warn'; text = `Payment is overdue. Full access continues until ${new Date(s.graceEndsAt ?? s.currentPeriodEnd).toLocaleDateString()}.`; }
  else if (s.status === 'TRIALING') { tone = 'info'; text = `${s.planName} trial — ${Math.max(0, days)} day${days === 1 ? '' : 's'} left.`; }
  if (!tone) return null;
  const cls = { warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', info: 'bg-accent-soft text-accent-ink' }[tone];
  return <div className={cn('flex items-center justify-center gap-2 px-4 py-1.5 text-center text-xs font-medium', cls)} role="status"><AlertTriangle className="size-3.5 shrink-0" />{text}<Link href="/billing" className="underline underline-offset-2">Manage billing</Link></div>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const me = useRequireAuth();
  const { workspaces, current, loading } = useWorkspace();
  const router = useRouter();
  const path = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const [drawer, setDrawer] = React.useState(false);
  React.useEffect(() => { try { setCollapsed(localStorage.getItem('lf_collapsed') === '1'); } catch { /* ignore */ } }, []);
  React.useEffect(() => setDrawer(false), [path]);
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem('lf_collapsed', c ? '0' : '1'); } catch { /* ignore */ } return !c; });
  React.useEffect(() => {
    if (me.data && !loading && !workspaces.length) router.replace(me.data.user.platformRole ? '/platform' : '/onboarding');
  }, [me.data, loading, workspaces.length, router]);
  const { org, canAny } = useOrg();
  React.useEffect(() => {
    if (org && current && !org.organization.onboardingCompletedAt && current.role.key === 'OWNER' && path !== '/onboarding') router.replace(`/onboarding?org=${current.organization.id}`);
  }, [org, current, path, router]);

  React.useEffect(() => { if (typeof document !== 'undefined') document.title = `${CRUMBS[path.split('/').filter(Boolean)[0] ?? ''] ?? 'LeadFlow'} · LeadFlow`; }, [path]);
  if (me.isLoading || !current) {
    return <div className="flex h-dvh items-center justify-center"><div className="flex flex-col items-center gap-3"><Logo /><Spinner /></div></div>;
  }
  const guard = NAV.flatMap((g) => g.items).find((i) => path === i.href || path.startsWith(`${i.href}/`));
  const allowed = !guard?.perms || canAny(...guard.perms);
  const seg = path.split('/').filter(Boolean);
  const crumbs = [{ label: current.organization.name, href: '/dashboard' }, ...(seg[0] ? [{ label: CRUMBS[seg[0]] ?? seg[0], href: `/${seg[0]}` }] : []), ...(seg[1] ? [{ label: 'Details', href: path }] : [])];

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop">Skip to content</a>
      <aside className={cn('hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex', collapsed ? 'w-[60px]' : 'w-[248px]')}>
        <div className={cn('flex h-12 items-center border-b border-line px-3', collapsed ? 'justify-center' : 'justify-between')}>
          <Link href="/dashboard" aria-label="LeadFlow home"><Logo compact={collapsed} /></Link>
          {!collapsed && <Button variant="ghost" size="iconSm" onClick={toggle} aria-label="Collapse sidebar"><PanelLeftClose className="size-4" /></Button>}
        </div>
        <WorkspaceSwitcher collapsed={collapsed} />
        <NavList collapsed={collapsed} />
        {collapsed && <div className="border-t border-line p-2"><Button variant="ghost" size="icon" className="w-full" onClick={toggle} aria-label="Expand sidebar"><PanelLeftOpen className="size-4" /></Button></div>}
      </aside>

      <RDialog.Root open={drawer} onOpenChange={setDrawer}>
        <RDialog.Portal>
          <RDialog.Overlay className="animate-lf-fade fixed inset-0 z-50 bg-[#0c0c14]/40 lg:hidden" />
          <RDialog.Content className="animate-lf-slide-right fixed inset-y-0 left-0 z-50 flex w-[272px] max-w-[85vw] flex-col bg-surface shadow-pop focus:outline-none lg:hidden" aria-describedby={undefined}>
            <RDialog.Title className="sr-only">Navigation</RDialog.Title>
            <div className="flex h-12 items-center justify-between border-b border-line px-3"><Logo /><RDialog.Close asChild><Button variant="ghost" size="iconSm" aria-label="Close menu"><X className="size-4" /></Button></RDialog.Close></div>
            <WorkspaceSwitcher />
            <NavList onNavigate={() => setDrawer(false)} />
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBanner />
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu className="size-4" /></Button>
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-[13px] text-ink-3 md:flex">
            {crumbs.map((c, i) => <React.Fragment key={c.href + i}>{i > 0 && <span aria-hidden>/</span>}{i === crumbs.length - 1 ? <span className="truncate font-medium text-ink" aria-current="page">{c.label}</span> : <Link href={c.href} className="truncate hover:text-ink">{c.label}</Link>}</React.Fragment>)}
          </nav>
          <div className="flex flex-1 justify-center md:justify-end lg:px-6"><GlobalSearch /></div>
          <div className="flex items-center gap-1.5"><NotificationBell /><UserMenu /></div>
        </header>
        <main id="main" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1480px] px-3 py-5 sm:px-6 sm:py-6">{allowed ? children : <EmptyState className="py-24" icon={<ShieldAlert />} title="You don't have access to this page" description="Your role in this workspace doesn't include it. Ask a workspace owner or admin if you need access." action={<Link href="/dashboard"><Button variant="primary">Back to dashboard</Button></Link>} />}</div>
        </main>
      </div>
    </div>
  );
}
void Badge; void fullNameOf;
