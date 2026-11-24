'use client';
import * as React from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { forgotSchema } from '@leadflow/shared';
import type { z } from 'zod';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { ApiError, api } from '@/lib/api';

export default function ForgotPassword() {
  const [sent, setSent] = React.useState<{ link?: string | null } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema) });
  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try { const r = await api.post<{ devResetLink?: string | null }>('/auth/forgot-password', v, { tenant: false }); setSent({ link: r.devResetLink }); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Request failed'); }
  });
  return (
    <AuthLayout title="Reset your password" subtitle="Enter your email and we'll send you a reset link." footer={<Link className="font-medium text-accent-ink hover:underline" href="/login">Back to sign in</Link>}>
      {sent ? (
        <div className="rounded-xl border border-line bg-surface p-4 text-[13px] shadow-card">
          <p className="font-medium">If that address has an account, a reset link is on its way.</p>
          <div className="mt-3 rounded-lg bg-warn-soft p-3 text-xs text-warn"><p className="font-semibold">Development environment</p>{sent.link ? <a className="underline" href={sent.link}>Open the reset link</a> : <p>No account found for that email (not disclosed in production).</p>} · <Link className="underline" href="/dev/mailbox">dev mailbox</Link></div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormError message={error} />
          <Field label="Email" required error={errors.email?.message} htmlFor="email"><Input id="email" type="email" autoFocus invalid={!!errors.email} {...register('email')} /></Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}
