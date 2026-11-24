'use client';
import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Keeps list filters in the URL so views are shareable and dashboard deep-links work. */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const state = React.useMemo(() => {
    const s = { ...defaults } as Record<string, string>;
    for (const k of Object.keys(defaults)) { const v = params.get(k); if (v !== null) s[k] = v; }
    return s as T;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const set = React.useCallback((patch: Partial<T>, resetPage = true) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '' || v === defaults[k]) next.delete(k); else next.set(k, String(v)); }
    if (resetPage && !('page' in patch)) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, path, router]);
  return [state, set] as const;
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
