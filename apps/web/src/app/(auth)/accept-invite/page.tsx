'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Spinner, Badge } from '@/components/ui/data';
import { ApiError, api } from '@/lib/api';
import { useMe, useOrgContext } from '@/lib/session';

interface Preview { email: string; organizationName: string; roleName: string; invitedBy: string | null; status: string; accountExists: boolean }

function Accept() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const qc = useQueryClient();
  const { setOrgId } = useOrgContext();
  const me = useMe();
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { api.get<Preview>('/auth/invitation', { token }, { tenant: false }).then(setPreview).catch((e) => setError(e instanceof ApiError ? e.message : 'Invitation not found')); }, [token]);
  const signedIn = !!me.data;
  async function accept() {
    setBusy(true);
    try {
      const r = await api.post<{ organizationId: string }>('/auth/invitation/accept', { token }, { tenant: false });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setOrgId(r.organizationId);
      toast.success('You joined the workspace');
      router.replace('/dashboard');
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not accept the invitation'); } finally { setBusy(false); }
  }
  const q = `invite=${encodeURIComponent(token)}${preview ? `&email=${encodeURIComponent(preview.email)}` : ''}`;
  return (
    <AuthLayout title="You've been invited">
      {!preview && !error && <div className="flex justify-center"><Spinner className="size-6" /></div>}
      {error && <div className="rounded-md border border-bad/20 bg-bad-soft p-3 text-[13px] text-bad">{error}</div>}
      {preview && (
        <div className="space-y-5">
          <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent"><Building2 className="size-5" /></span><div><p className="font-semibold">{preview.organizationName}</p><p className="text-xs text-ink-3">{preview.invitedBy ? `Invited by ${preview.invitedBy}` : 'Workspace invitation'}</p></div></div>
            <dl className="mt-4 space-y-1.5 text-[13px]"><div className="flex justify-between"><dt className="text-ink-3">Your role</dt><dd className="font-medium">{preview.roleName}</dd></div><div className="flex justify-between"><dt className="text-ink-3">Invited email</dt><dd className="font-medium">{preview.email}</dd></div></dl>
          </div>
          {preview.status !== 'PENDING' ? <Badge tone="bad">This invitation is {preview.status.toLowerCase()}</Badge> : signedIn ? (
            me.data!.user.email.toLowerCase() === preview.email.toLowerCase()
              ? <Button variant="primary" size="lg" className="w-full" onClick={accept} loading={busy}>Accept & join workspace</Button>
              : <p className="text-[13px] text-ink-2">You are signed in as <b>{me.data!.user.email}</b>, but this invitation is for <b>{preview.email}</b>. Sign out and use the invited address.</p>
          ) : (
            <div className="space-y-2">
              <Link href={preview.accountExists ? `/login?${q}` : `/register?${q}`}><Button variant="primary" size="lg" className="w-full">{preview.accountExists ? 'Sign in to accept' : 'Create account to accept'}</Button></Link>
              <Link href={preview.accountExists ? `/register?${q}` : `/login?${q}`} className="block text-center text-xs text-ink-3 hover:underline">{preview.accountExists ? 'Need a new account?' : 'Already have an account?'}</Link>
            </div>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
export default function Page() { return <React.Suspense><Accept /></React.Suspense>; }
