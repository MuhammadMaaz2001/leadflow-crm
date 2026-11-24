'use client';
import * as React from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, RotateCw } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { Button } from './button';
import { Select } from './form';

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-card', className)} {...p} />;
}
export function CardHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-4 pb-1 pt-4', className)}>
      <div className="min-w-0"><h3 className="text-[13px] font-semibold text-ink">{title}</h3>{description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}</div>
      {actions}
    </div>
  );
}

const badge = cva('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4', {
  variants: { tone: { neutral: 'bg-subtle text-ink-2', accent: 'bg-accent-soft text-accent-ink', ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', info: 'bg-info-soft text-info' } },
  defaultVariants: { tone: 'neutral' },
});
export function Badge({ tone, className, dot, children }: VariantProps<typeof badge> & { className?: string; dot?: string; children: React.ReactNode }) {
  return <span className={cn(badge({ tone }), className)}>{dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-subtle', className)} aria-hidden />;
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-subtle text-ink-3 [&>svg]:size-5">{icon ?? <Inbox />}</div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-ink-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error?: unknown; onRetry?: () => void; className?: string }) {
  const status = (error as { status?: number } | null)?.status;
  const msg = status === 403 ? "You don't have access to this." : status === 402 ? (error as Error).message : status && status >= 500 ? 'Something went wrong on our side. Please try again.' : (error as Error | undefined)?.message ?? 'We could not load this.';
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-bad-soft text-bad"><AlertTriangle className="size-5" /></div>
      <p className="text-sm font-semibold text-ink">{status === 403 ? 'Access denied' : 'Couldn’t load this view'}</p>
      <p className="mt-1 max-w-sm text-[13px] text-ink-2">{msg}</p>
      {onRetry && <Button className="mt-4" onClick={onRetry}><RotateCw className="size-3.5" />Try again</Button>}
    </div>
  );
}

export function Avatar({ name, size = 'md', className }: { name?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }) {
  const hue = Array.from(name ?? '?').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const sizes = { xs: 'size-5 text-[9px]', sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' };
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold', sizes[size], className)} style={{ background: `hsl(${hue} 55% 92%)`, color: `hsl(${hue} 45% 32%)` }}>{initials(name)}</span>
  );
}
export function UserChip({ user, size = 'sm', empty = 'Unassigned' }: { user?: { name: string } | null; size?: 'xs' | 'sm'; empty?: string }) {
  if (!user) return <span className="text-xs text-ink-3">{empty}</span>;
  return <span className="inline-flex min-w-0 items-center gap-1.5"><Avatar name={user.name} size={size} /><span className="truncate text-[13px]">{user.name}</span></span>;
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, noun = 'results' }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink-2">
      <span className="tnum">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} {noun}</span>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <div className="w-[88px]"><Select aria-label="Rows per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="h-7 text-xs">{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}</Select></div>
        )}
        <Button size="iconSm" variant="secondary" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft className="size-3.5" /></Button>
        <span className="tnum min-w-[60px] text-center">Page {page} / {pages}</span>
        <Button size="iconSm" variant="secondary" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight className="size-3.5" /></Button>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions, count, className }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; count?: number | string; className?: string }) {
  return (
    <div className={cn('mb-5 flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">{title}{count !== undefined && <span className="tnum rounded-full bg-subtle px-2 py-0.5 text-xs font-medium text-ink-2">{count}</span>}</h1>
        {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, icon, tone = 'neutral', loading, href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'; loading?: boolean; href?: string }) {
  const toneCls = { neutral: 'text-ink-3', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', accent: 'text-accent' }[tone];
  const body = (
    <div className="flex items-start justify-between gap-2 p-3.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink-2">{label}</p>
        {loading ? <Skeleton className="mt-2 h-7 w-16" /> : <p className="tnum mt-1 text-2xl font-semibold tracking-tight text-ink">{value}</p>}
        {hint && !loading && <p className="mt-0.5 truncate text-xs text-ink-3">{hint}</p>}
      </div>
      {icon && <span className={cn('mt-0.5 [&>svg]:size-4', toneCls)}>{icon}</span>}
    </div>
  );
  return <Card className={cn(href && 'transition-colors hover:border-line-strong')}>{href ? <a href={href} className="block">{body}</a> : body}</Card>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent', className)} role="status" aria-label="Loading" />;
}

export function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-4 py-1.5 text-[13px]"><dt className="shrink-0 text-ink-3">{label}</dt><dd className="min-w-0 text-right text-ink">{children}</dd></div>;
}
