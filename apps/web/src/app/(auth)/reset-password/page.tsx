'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { passwordSchema } from '@leadflow/shared';
import { z } from 'zod';
import { toast } from 'sonner';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { ApiError, api } from '@/lib/api';

const schema = z.object({ password: passwordSchema, confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try { await api.post('/auth/reset-password', { token, password: v.password }, { tenant: false }); toast.success('Password updated. Please sign in.'); router.replace('/login'); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Reset failed'); }
  });
  return (
    <AuthLayout title="Choose a new password" footer={<Link className="font-medium text-accent-ink hover:underline" href="/login">Back to sign in</Link>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="New password" required error={errors.password?.message} hint="At least 8 characters, with a letter and a number."><Input type="password" autoComplete="new-password" autoFocus invalid={!!errors.password} {...register('password')} /></Field>
        <Field label="Confirm password" required error={errors.confirm?.message}><Input type="password" autoComplete="new-password" invalid={!!errors.confirm} {...register('confirm')} /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>Update password</Button>
      </form>
    </AuthLayout>
  );
}
export default function Page() { return <React.Suspense><Reset /></React.Suspense>; }
