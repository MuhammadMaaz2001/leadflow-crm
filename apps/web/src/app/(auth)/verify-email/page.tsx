'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/data';
import { ApiError, api } from '@/lib/api';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = React.useState<'loading' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = React.useState('');
  const ran = React.useRef(false);
  React.useEffect(() => {
    if (ran.current) return; ran.current = true;
    if (!token) { setState('error'); setMsg('This verification link is missing its token.'); return; }
    api.post('/auth/verify-email', { token }, { tenant: false }).then(() => setState('ok')).catch((e) => { setState('error'); setMsg(e instanceof ApiError ? e.message : 'Verification failed'); });
  }, [token]);
  return (
    <AuthLayout title={state === 'ok' ? 'Email verified' : state === 'error' ? 'Verification failed' : 'Verifying…'}>
      <div className="flex flex-col items-center gap-4 text-center text-[13px]">
        {state === 'loading' && <Spinner className="size-6" />}
        {state === 'ok' && <><CheckCircle2 className="size-10 text-ok" /><p className="text-ink-2">Your account is active. You can sign in now.</p><Link href="/login"><Button variant="primary" size="lg">Continue to sign in</Button></Link></>}
        {state === 'error' && <><XCircle className="size-10 text-bad" /><p className="text-ink-2">{msg}</p><Link href="/login"><Button>Back to sign in</Button></Link></>}
      </div>
    </AuthLayout>
  );
}
export default function Page() { return <React.Suspense><Verify /></React.Suspense>; }
