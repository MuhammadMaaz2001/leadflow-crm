'use client';
import * as React from 'react';
import { Laptop, LogOut, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { changePasswordSchema, profileSchema } from '@leadflow/shared';
import { api, ApiError } from '@/lib/api';
import { applyServerErrors, useZodForm } from '@/lib/forms';
import { useAct, useMe, useT, useWorkspace } from '@/lib/session';
import { fmtDateTime, timeAgo } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/form';
import { Avatar, Badge, Card, CardHeader, PageHeader, Skeleton } from '@/components/ui/data';

function ProfileForm() {
  const me = useMe();
  const qc = useQueryClient();
  const u = me.data?.user;
  const f = useZodForm<{ name: string; phone: string; jobTitle: string }>(profileSchema, { name: '', phone: '', jobTitle: '' });
  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting, isDirty } } = f;
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { if (u) reset({ name: u.name, phone: u.phone ?? '', jobTitle: u.jobTitle ?? '' }); }, [u, reset]);
  const submit = handleSubmit(async (v) => { setErr(null); try { await api.patch('/auth/profile', v); await qc.invalidateQueries({ queryKey: ['me'] }); toast.success('Profile updated'); } catch (e) { setErr(applyServerErrors(e, setError)); } });
  return (
    <Card>
      <CardHeader title="Profile" description="How you appear to teammates." />
      <form onSubmit={submit} className="space-y-4 p-4" noValidate>
        <FormError message={err} />
        <div className="flex items-center gap-3"><Avatar name={u?.name} size="lg" /><div><p className="text-[13px] font-medium">{u?.email}</p><Badge tone={u?.emailVerified ? 'ok' : 'warn'}>{u?.emailVerified ? 'Email verified' : 'Not verified'}</Badge></div></div>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Full name" required error={errors.name?.message}><Input aria-label="Full name" invalid={!!errors.name} {...register('name')} /></Field><Field label="Job title"><Input aria-label="Job title" {...register('jobTitle')} /></Field><Field label="Phone"><Input aria-label="Phone" {...register('phone')} /></Field></div>
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={isSubmitting} disabled={!isDirty}>Save profile</Button></div>
      </form>
    </Card>
  );
}

function PasswordForm() {
  const f = useZodForm<{ currentPassword: string; newPassword: string; confirm: string }>(changePasswordSchema.extend({}), { currentPassword: '', newPassword: '', confirm: '' });
  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = f;
  const [err, setErr] = React.useState<string | null>(null);
  const submit = handleSubmit(async (v) => {
    setErr(null);
    if (v.newPassword !== v.confirm) { setError('confirm', { message: 'Passwords do not match' }); return; }
    try { await api.post('/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }, { tenant: false }); toast.success('Password changed. Other devices were signed out.'); reset(); } catch (e) { setErr(applyServerErrors(e, setError)); }
  });
  return (
    <Card>
      <CardHeader title="Change password" description="Changing your password signs you out of all other devices." />
      <form onSubmit={submit} className="space-y-4 p-4" noValidate>
        <FormError message={err} />
        <div className="grid gap-4 sm:grid-cols-3"><Field label="Current password" required error={errors.currentPassword?.message}><Input aria-label="Current password" type="password" autoComplete="current-password" invalid={!!errors.currentPassword} {...register('currentPassword')} /></Field><Field label="New password" required error={errors.newPassword?.message} hint="8+ characters with a letter and a number"><Input aria-label="New password" type="password" autoComplete="new-password" invalid={!!errors.newPassword} {...register('newPassword')} /></Field><Field label="Confirm" required error={errors.confirm?.message}><Input aria-label="Confirm new password" type="password" autoComplete="new-password" invalid={!!errors.confirm} {...register('confirm')} /></Field></div>
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={isSubmitting}>Update password</Button></div>
      </form>
    </Card>
  );
}

export default function ProfilePage() {
  const sessions = useT(['sessions'], () => api.get<Array<{ id: string; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string; current: boolean }>>('/auth/sessions', undefined, { tenant: false }));
  const revoke = useAct((id: string) => api.del(`/auth/sessions/${id}`), { success: 'Session revoked', invalidate: ['sessions'] });
  const others = useAct(() => api.post('/auth/sessions/revoke-others'), { success: 'Signed out of other devices', invalidate: ['sessions'] });
  const { workspaces } = useWorkspace();
  const device = (ua: string | null) => (ua?.includes('Mobile') ? 'Mobile browser' : ua?.includes('Firefox') ? 'Firefox' : ua?.includes('Chrome') ? 'Chrome' : ua?.includes('Safari') ? 'Safari' : 'Browser');
  void ApiError;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Profile & security" description="Your personal account — shared across every workspace you belong to." />
      <ProfileForm />
      <PasswordForm />
      <Card>
        <CardHeader title="Active sessions" description="Devices currently signed in to your account." actions={<Button size="sm" onClick={() => others.mutate()}><LogOut className="size-3.5" />Sign out other devices</Button>} />
        {sessions.isLoading ? <Skeleton className="m-4 h-24" /> : <ul className="divide-y divide-line">{sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-3"><Laptop className="size-5 text-ink-3" /><div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{device(s.userAgent)}{s.current && <Badge tone="ok" className="ml-2">This device</Badge>}</p><p className="text-xs text-ink-3">{s.ip ?? 'unknown IP'} · active {timeAgo(s.lastSeenAt)} · signed in {fmtDateTime(s.createdAt)}</p></div>{!s.current && <Button size="sm" variant="dangerGhost" onClick={() => revoke.mutate(s.id)}>Revoke</Button>}</li>))}</ul>}
      </Card>
      <Card>
        <CardHeader title="Your workspaces" description="You can hold a different role in each one." />
        <ul className="divide-y divide-line">{workspaces.map((w) => <li key={w.organization.id} className="flex items-center gap-3 px-4 py-3"><ShieldCheck className="size-4 text-ink-3" /><span className="flex-1 text-[13px] font-medium">{w.organization.name}</span><Badge tone="accent">{w.role.name}</Badge></li>)}</ul>
      </Card>
    </div>
  );
}
