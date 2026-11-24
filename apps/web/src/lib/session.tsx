'use client';
import * as React from 'react';
import { QueryClient, QueryClientProvider, keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey, type UseMutationOptions } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { usePathname, useRouter } from 'next/navigation';
import type { PermissionKey } from '@leadflow/shared';
import { ApiError, api, setActiveOrg } from './api';
import { setFormatPrefs } from './format';
import { ConfirmProvider } from '@/components/ui/overlay';

export interface Workspace {
  membershipId: string; status: string;
  organization: { id: string; name: string; slug: string; logoData: string | null; status: string; onboardingCompleted: boolean; currency: string; timezone: string };
  role: { id: string; name: string; key: string | null; permissions: string[] };
  subscription: { status: string; planCode: string; planName: string; trialEndsAt: string | null } | null;
}
export interface Me {
  user: { id: string; email: string; name: string; phone: string | null; jobTitle: string | null; emailVerified: boolean; platformRole: string | null };
  workspaces: Workspace[];
}
export interface OrgInfo {
  organization: { id: string; name: string; slug: string; logoData: string | null; industry: string | null; website: string | null; contactEmail: string | null; contactPhone: string | null; address: string | null; country: string | null; timezone: string; currency: string; dateFormat: string; status: string; suspendedReason: string | null; onboardingCompletedAt: string | null; autoAssignMode: string; notContactedHours: number; inactiveDays: number };
  role: { id: string; key: string | null }; permissions: string[];
  subscription: { status: string; planCode: string; planName: string; features: string[]; trialEndsAt: string | null; currentPeriodEnd: string; graceEndsAt: string | null; interval: string } | null;
  usage: { leads: number; seats: number; pendingInvites: number; opportunities: number; followUps: number; maxLeads: number; maxSeats: number };
  billing?: { selfServiceManualPayment: boolean };
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
      mutations: { retry: false },
    },
  });
}

const OrgContext = React.createContext<{ orgId: string | null; setOrgId: (id: string) => void }>({ orgId: null, setOrgId: () => undefined });
const STORAGE_KEY = 'lf_org';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(makeQueryClient);
  const [orgId, setOrgIdState] = React.useState<string | null>(null);
  // restore workspace before first render of children that fire queries
  React.useLayoutEffect(() => {
    try { const v = localStorage.getItem(STORAGE_KEY); if (v) { setActiveOrg(v); setOrgIdState(v); } } catch { /* storage unavailable */ }
  }, []);
  const setOrgId = React.useCallback((id: string) => {
    setActiveOrg(id); setOrgIdState(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
  }, []);
  return (
    <QueryClientProvider client={client}>
      <OrgContext.Provider value={{ orgId, setOrgId }}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </OrgContext.Provider>
      <Toaster position="bottom-right" toastOptions={{ classNames: { toast: '!rounded-lg !border !border-line !shadow-pop !text-[13px]' } }} />
    </QueryClientProvider>
  );
}

export const useOrgContext = () => React.useContext(OrgContext);

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me', undefined, { tenant: false }), retry: false, staleTime: 60_000 });
}

/** Resolves the active workspace from the signed-in user's memberships (never trusts localStorage alone). */
export function useWorkspace() {
  const me = useMe();
  const { orgId, setOrgId } = useOrgContext();
  const list = me.data?.workspaces.filter((w) => w.status === 'ACTIVE') ?? [];
  const current = list.find((w) => w.organization.id === orgId) ?? list[0] ?? null;
  React.useEffect(() => { if (current && current.organization.id !== orgId) setOrgId(current.organization.id); }, [current, orgId, setOrgId]);
  if (current) setActiveOrg(current.organization.id);
  return { me: me.data, loading: me.isLoading, error: me.error, workspaces: list, current, switchTo: setOrgId };
}

export function useOrg() {
  const { current } = useWorkspace();
  const id = current?.organization.id;
  const q = useQuery({ queryKey: [id, 'org'], queryFn: () => api.get<OrgInfo>('/organizations/current'), enabled: !!id, staleTime: 30_000 });
  React.useEffect(() => { if (q.data) setFormatPrefs({ dateFormat: q.data.organization.dateFormat, timezone: q.data.organization.timezone }); }, [q.data]);
  const perms = q.data?.permissions ?? current?.role.permissions ?? [];
  return { ...q, org: q.data, orgId: id, can: (p: PermissionKey) => perms.includes(p), canAny: (...ps: PermissionKey[]) => ps.some((p) => perms.includes(p)), has: (f: string) => q.data?.subscription?.features.includes(f) ?? false, currency: q.data?.organization.currency ?? current?.organization.currency ?? 'USD' };
}

/** Tenant-scoped query: key is automatically namespaced with the active workspace so caches never leak between workspaces. */
export function useT<T>(key: QueryKey, fn: () => Promise<T>, opts: { enabled?: boolean; refetchInterval?: number; staleTime?: number; keep?: boolean } = {}) {
  const { current } = useWorkspace();
  const id = current?.organization.id;
  return useQuery({ queryKey: [id, ...key], queryFn: fn, enabled: !!id && (opts.enabled ?? true), refetchInterval: opts.refetchInterval, staleTime: opts.staleTime, placeholderData: opts.keep ? keepPreviousData : undefined });
}

export function errMsg(e: unknown) { return e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong'; }

/** Mutation with success/error toasts and cache invalidation for the tenant. */
export function useAct<TVars = void, TData = unknown>(fn: (v: TVars) => Promise<TData>, opts: { success?: string | ((d: TData) => string); invalidate?: Array<string>; onSuccess?: (d: TData, v: TVars) => void; silent?: boolean } & Pick<UseMutationOptions<TData, Error, TVars>, 'onError'> = {}) {
  const qc = useQueryClient();
  const { current } = useWorkspace();
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    onSuccess: (d, v) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(d) : opts.success);
      const id = current?.organization.id;
      if (opts.invalidate?.length) for (const k of opts.invalidate) qc.invalidateQueries({ queryKey: [id, k] });
      else qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === id });
      opts.onSuccess?.(d, v);
    },
    onError: (e, v, c, m) => { if (!opts.silent) toast.error(errMsg(e)); opts.onError?.(e, v, c, m); },
  });
}

/** Redirects unauthenticated visitors to /login (and platform-only users to /platform). */
export function useRequireAuth(opts: { platform?: boolean } = {}) {
  const me = useMe();
  const router = useRouter();
  const path = usePathname();
  React.useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [me.error, router, path]);
  React.useEffect(() => {
    if (opts.platform && me.data && !me.data.user.platformRole) router.replace('/dashboard');
  }, [me.data, opts.platform, router]);
  return me;
}
