'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@leadflow/shared';
import type { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { ApiError, api } from '@/lib/api';
import type { Me } from '@/lib/session';

type Values = z.infer<typeof loginSchema>;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const [unverified, setUnverified] = React.useState(false);
  const [devLink, setDevLink] = React.useState<string | null>(null);
  const invite = params.get('invite');
  const { register, handleSubmit, getValues, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(loginSchema), defaultValues: { email: params.get('email') ?? '', password: '' } });

  const onSubmit = handleSubmit(async (v) => {
    setError(null); setUnverified(false);
    try {
      await api.post('/auth/login', v, { tenant: false });
      qc.clear();
      const me = await api.get<Me>('/auth/me', undefined, { tenant: false });
      qc.setQueryData(['me'], me);
      if (invite) return router.replace(`/accept-invite?token=${invite}`);
      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : me.workspaces.length ? '/dashboard' : me.user.platformRole ? '/platform' : '/onboarding');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      setError(e instanceof ApiError ? e.message : 'Could not sign in');
    }
  });
  async function resend() {
    const r = await api.post<{ devVerificationLink?: string | null }>('/auth/resend-verification', { email: getValues('email') }, { tenant: false });
    setDevLink(r.devVerificationLink ?? null);
    toast.success('Verification email sent');
  }
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your LeadFlow workspace." footer={<>New to LeadFlow? <Link className="font-medium text-accent-ink hover:underline" href={invite ? `/register?invite=${invite}` : '/register'}>Create an account</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        {unverified && (
          <div className="rounded-md border border-line bg-subtle p-3 text-xs text-ink-2">
            <Button type="button" variant="link" onClick={resend}>Resend verification email</Button>
            {devLink && <p className="mt-1">Development only: <a className="font-medium text-accent-ink underline" href={devLink}>verify my email now</a> (also listed in the <Link className="underline" href="/dev/mailbox">dev mailbox</Link>).</p>}
          </div>
        )}
        <Field label="Email" required error={errors.email?.message} htmlFor="email"><Input id="email" type="email" autoComplete="email" autoFocus invalid={!!errors.email} {...register('email')} /></Field>
        <Field label="Password" required error={errors.password?.message} htmlFor="password"><Input id="password" type="password" autoComplete="current-password" invalid={!!errors.password} {...register('password')} /></Field>
        <div className="flex justify-end"><Link href="/forgot-password" className="text-xs text-accent-ink hover:underline">Forgot password?</Link></div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>Sign in</Button>
      </form>
    </AuthLayout>
  );
}
export default function LoginPage() { return <React.Suspense><LoginForm /></React.Suspense>; }
