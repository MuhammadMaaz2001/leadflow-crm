/** Minimal typed fetch client. Every tenant request carries the active workspace in X-Org-Id (validated server-side). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>, public details?: Record<string, unknown>) {
    super(message);
  }
}

let activeOrgId: string | null = null;
export const setActiveOrg = (id: string | null) => { activeOrgId = id; };
export const getActiveOrg = () => activeOrgId;

type Params = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

export function qs(params?: Params): string {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, opts: { body?: unknown; params?: Params; tenant?: boolean; form?: FormData; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.tenant !== false && activeOrgId) headers['X-Org-Id'] = activeOrgId;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(`/api${path}${qs(opts.params)}`, { method, headers, body, credentials: 'include' });
  if (opts.raw) {
    if (!res.ok) throw await toError(res);
    return res as unknown as T;
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw toErrorFrom(res.status, json);
  return json as T;
}

async function toError(res: Response) {
  return toErrorFrom(res.status, await res.json().catch(() => null));
}
function toErrorFrom(status: number, json: { error?: { code?: string; message?: string; details?: { fields?: Record<string, string> } & Record<string, unknown> } } | null) {
  const e = json?.error;
  return new ApiError(status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong. Please try again.', e?.details?.fields, e?.details as Record<string, unknown> | undefined);
}

export interface Paged<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number; [k: string]: unknown } }

export const api = {
  get: <T = unknown>(path: string, params?: Params, opts?: { tenant?: boolean }) => request<{ data: T }>('GET', path, { params, ...opts }).then((r) => r.data),
  page: <T = unknown>(path: string, params?: Params) => request<Paged<T>>('GET', path, { params }),
  post: <T = unknown>(path: string, body?: unknown, opts?: { tenant?: boolean }) => request<{ data: T }>('POST', path, { body: body ?? {}, ...opts }).then((r) => r.data),
  patch: <T = unknown>(path: string, body?: unknown) => request<{ data: T }>('PATCH', path, { body: body ?? {} }).then((r) => r.data),
  put: <T = unknown>(path: string, body?: unknown) => request<{ data: T }>('PUT', path, { body: body ?? {} }).then((r) => r.data),
  del: <T = unknown>(path: string) => request<{ data: T }>('DELETE', path, {}).then((r) => r.data),
  upload: <T = unknown>(path: string, file: File, params?: Params) => { const f = new FormData(); f.append('file', file); return request<{ data: T }>('POST', path, { form: f, params }).then((r) => r.data); },
  /** Downloads a file response (CSV / XLSX exports) and triggers a browser save. */
  download: async (path: string, params?: Params, tenant = true) => {
    const res = await request<Response>('GET', path, { params, raw: true, tenant });
    const cd = res.headers.get('Content-Disposition') ?? '';
    const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'download';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return name;
  },
};
