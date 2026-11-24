'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema } from '@leadflow/shared';
import type { z } from 'zod';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { ApiError, api } from '@/lib/api';

type Values = z.infer<typeof registerSchema>;

function RegisterForm() {
  const params = useSearchParams();
  const router = useRouter();
  const invite = params.get('invite') ?? undefined;
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ email: string; link?: string | null; verified: boolean } | null>(null);
  const { register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(registerSchema), defaultValues: { name: '', email: params.get('email') ?? '', password: '' } });

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await api.post<{ verificationRequired: boolean; devVerificationLink?: string | null }>('/auth/register', { ...v, inviteToken: invite }, { tenant: false });
      if (!r.verificationRequired && invite) return router.replace(`/login?invite=${invite}&email=${encodeURIComponent(v.email)}`);
      setDone({ email: v.email, link: r.devVerificationLink, verified: !r.verificationRequired });
    } catch (e) {
      if (e instanceof ApiError && e.fields) for (const [k, m] of Object.entries(e.fields)) setFieldError(k as keyof Values, { message: m });
      setError(e instanceof ApiError ? e.message : 'Could not create the account');
    }
  });

  if (done) {
    return (
      <AuthLayout title="Check your inbox" subtitle={`We sent a verification link to ${done.email}.`}>
        <div className="rounded-xl border border-line bg-surface p-4 text-[13px] shadow-card">
          <div className="mb-3 flex items-center gap-2 font-medium"><MailCheck className="size-4 text-accent" /> Verify your email to continue</div>
          <p className="text-ink-2">Click the link in the email to activate your account, then sign in.</p>
          <div className="mt-4 rounded-lg bg-warn-soft p-3 text-xs text-warn">
            <p className="font-semibold">Development environment</p>
            <p className="mt-0.5">No email provider is connected, so messages go to the built-in <Link className="underline" href={`/dev/mailbox?email=${encodeURIComponent(done.email)}`}>dev mailbox</Link>.</p>
            {done.link && <a href={done.link} className="mt-2 inline-flex items-center gap-1 font-semibold underline"><CheckCircle2 className="size-3.5" /> Verify my email now</a>}
          </div>
        </div>
        <p className="mt-5 text-center text-[13px] text-ink-2">Already verified? <Link href="/login" className="font-medium text-accent-ink hover:underline">Sign in</Link></p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Create your account" subtitle={invite ? 'Create an account with the invited email address to join the workspace.' : 'Start a free 14-day trial. No credit card required.'} footer={<>Already have an account? <Link className="font-medium text-accent-ink hover:underline" href={invite ? `/login?invite=${invite}` : '/login'}>Sign in</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Full name" required error={errors.name?.message} htmlFor="name"><Input id="name" autoComplete="name" autoFocus invalid={!!errors.name} {...register('name')} /></Field>
        <Field label="Work email" required error={errors.email?.message} htmlFor="email"><Input id="email" type="email" autoComplete="email" invalid={!!errors.email} {...register('email')} /></Field>
        <Field label="Password" required error={errors.password?.message} hint="At least 8 characters, with a letter and a number." htmlFor="password"><Input id="password" type="password" autoComplete="new-password" invalid={!!errors.password} {...register('password')} /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>Create account</Button>
        <p className="text-center text-[11px] text-ink-3">By continuing you agree to the Terms of Service and Privacy Policy.</p>
      </form>
    </AuthLayout>
  );
}
export default function RegisterPage() { return <React.Suspense><RegisterForm /></React.Suspense>; }
