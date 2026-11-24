'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, Building2, CreditCard, FileText, HeartPulse, LayoutDashboard, LogOut, Menu, Receipt, ScrollText, Shield, Users, X, Gauge, ArrowLeftRight } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAct, useRequireAuth } from '@/lib/session';
import { Avatar, Badge, Spinner } from '@/components/ui/data';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand';

const NAV = [
  { href: '/platform', label: 'Overview', icon: <LayoutDashboard />, exact: true },
  { href: '/platform/organizations', label: 'Organizations', icon: <Building2 /> },
  { href: '/platform/users', label: 'Users', icon: <Users /> },
  { href: '/platform/plans', label: 'Subscription plans', icon: <CreditCard /> },
  { href: '/platform/subscriptions', label: 'Subscriptions', icon: <Receipt /> },
  { href: '/platform/invoices', label: 'Invoices & billing', icon: <FileText /> },
  { href: '/platform/usage', label: 'Usage statistics', icon: <Gauge /> },
  { href: '/platform/audit-logs', label: 'Audit logs', icon: <ScrollText /> },
  { href: '/platform/health', label: 'System health', icon: <HeartPulse /> },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Platform" className="space-y-0.5 px-2">
      {NAV.map((i) => {
        const active = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
        return <Link key={i.href} href={i.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cn('flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors [&>svg]:size-4', active ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white')}>{i.icon}{i.label}</Link>;
      })}
    </nav>
  );
}

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const me = useRequireAuth({ platform: true });
  const router = useRouter();
  const qc = useQueryClient();
  const [drawer, setDrawer] = React.useState(false);
  const logout = useAct(() => api.post('/auth/logout', {}, { tenant: false }), { silent: true, onSuccess: () => { qc.clear(); router.replace('/login'); } });
  if (me.isLoading || !me.data?.user.platformRole) return <div className="flex h-dvh items-center justify-center"><Spinner className="size-6" /></div>;
  const u = me.data.user;
  const side = (
    <div className="flex h-full flex-col bg-[#14142b] text-white">
      <div className="flex h-12 items-center gap-2 border-b border-white/10 px-4"><Logo className="[&_span:last-child]:text-white" /><Badge tone="warn" className="ml-1">Platform</Badge></div>
      <div className="flex-1 overflow-y-auto py-3"><Nav onNavigate={() => setDrawer(false)} /></div>
      <div className="space-y-1 border-t border-white/10 p-3">
        {me.data.workspaces.length > 0 && <Link href="/dashboard" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white"><ArrowLeftRight className="size-3.5" />Switch to my workspace</Link>}
        <div className="flex items-center gap-2 px-2 py-1.5"><Avatar name={u.name} size="sm" /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{u.name}</p><p className="truncate text-[10px] text-white/50">{u.platformRole?.replace('_', ' ').toLowerCase()}</p></div><button aria-label="Sign out" className="text-white/60 hover:text-white" onClick={() => logout.mutate()}><LogOut className="size-4" /></button></div>
      </div>
    </div>
  );
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-[244px] shrink-0 lg:block">{side}</aside>
      <RDialog.Root open={drawer} onOpenChange={setDrawer}>
        <RDialog.Portal><RDialog.Overlay className="animate-lf-fade fixed inset-0 z-50 bg-black/40 lg:hidden" /><RDialog.Content aria-describedby={undefined} className="animate-lf-slide-right fixed inset-y-0 left-0 z-50 w-[260px] max-w-[85vw] lg:hidden"><RDialog.Title className="sr-only">Platform navigation</RDialog.Title>{side}</RDialog.Content></RDialog.Portal>
      </RDialog.Root>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Menu className="size-4" /></Button>
          <span className="flex items-center gap-2 text-[13px] font-medium"><Shield className="size-4 text-warn" />Platform administration</span>
          <span className="ml-auto hidden items-center gap-1.5 text-xs text-ink-3 sm:flex"><Activity className="size-3.5" />Tenant data is not accessible from this area</span>
        </header>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-[1400px] px-3 py-5 sm:px-6 sm:py-6">{children}</div></main>
      </div>
      <span className="hidden"><X /></span>
    </div>
  );
}
