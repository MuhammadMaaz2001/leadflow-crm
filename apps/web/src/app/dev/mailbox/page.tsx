'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Mail } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui/data';
import { Logo } from '@/components/brand';
import { fmtDateTime } from '@/lib/format';

function Mailbox() {
  const email = useSearchParams().get('email') ?? undefined;
  const q = useQuery({ queryKey: ['dev-mailbox', email], queryFn: () => api.get<Array<{ id: string; toEmail: string; subject: string; body: string; link: string | null; createdAt: string }>>('/dev/mailbox', { email }, { tenant: false }), refetchInterval: 5000 });
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between"><Link href="/login"><Logo /></Link><Badge tone="warn">Development only</Badge></div>
      <h1 className="text-xl font-semibold">Dev mailbox</h1>
      <p className="mt-1 text-[13px] text-ink-2">LeadFlow has no email provider configured in development. Every “sent” email (verification, invitation, password reset) lands here instead. {email && <>Filtered by <b>{email}</b>.</>}</p>
      <div className="mt-6 space-y-3">
        {q.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
        {q.data?.length === 0 && <Card><EmptyState icon={<Mail />} title="No messages yet" /></Card>}
        {q.data?.map((m) => (
          <Card key={m.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{m.subject}</p><span className="text-xs text-ink-3">{fmtDateTime(m.createdAt)}</span></div>
            <p className="mt-0.5 text-xs text-ink-3">To: {m.toEmail}</p>
            <p className="mt-2 text-[13px] text-ink-2">{m.body}</p>
            {m.link && <a href={m.link} className="mt-2 block break-all text-xs font-medium text-accent-ink underline">{m.link}</a>}
          </Card>
        ))}
      </div>
    </div>
  );
}
export default function Page() { return <React.Suspense><Mailbox /></React.Suspense>; }
