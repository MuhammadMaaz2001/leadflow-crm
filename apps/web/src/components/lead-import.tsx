'use client';
import * as React from 'react';
import { AlertCircle, CheckCircle2, Clock, Download, FileSpreadsheet, Loader2, UploadCloud, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errMsg, useT, useWorkspace } from '@/lib/session';
import { fmtBytes, fmtDateTime, num } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { Badge, EmptyState, Skeleton } from '@/components/ui/data';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';

interface Job {
  id: string; status: 'PREVIEW' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'EXPIRED'; fileName: string; fileFormat: string; fileSize: number; totalRows: number | null;
  processedRows: number; createdRows: number; failedRows: number; skippedRows: number; progress: number; stopReason: string | null; error: string | null; cancelRequested: boolean;
  createdAt: string; finishedAt: string | null; createdBy: { name: string } | null; canStart: boolean; canCancel: boolean; hasErrorReport: boolean;
  mapping?: Record<string, string>; unmappedHeaders?: string[]; preview?: Array<{ row: number; values: Record<string, string>; status: 'OK' | 'ERROR' | 'DUPLICATE'; message: string | null }> | null;
}
interface Listing { jobs: Job[]; limits: { maxFileBytes: number; maxRows: number; batchSize: number; retentionDays: number } }
const ACTIVE = ['QUEUED', 'RUNNING'];
const TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info' | undefined> = { COMPLETED: 'ok', FAILED: 'bad', CANCELED: undefined, EXPIRED: undefined, QUEUED: 'info', RUNNING: 'info', PREVIEW: 'warn' };
const LABEL: Record<string, string> = { PREVIEW: 'Waiting to start', QUEUED: 'Queued', RUNNING: 'Importing', COMPLETED: 'Completed', FAILED: 'Failed', CANCELED: 'Canceled', EXPIRED: 'Expired' };

export function LeadImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const orgId = useWorkspace().current?.organization.id;
  const [view, setView] = React.useState<'new' | 'history'>('new');
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [dup, setDup] = React.useState<'skip' | 'import'>('skip');
  const [drag, setDrag] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'upload' | 'start' | 'cancel' | null>(null);
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const [polling, setPolling] = React.useState(false);

  const history = useT(['import-jobs'], () => api.get<Listing>('/leads/import/jobs'), { enabled: open, refetchInterval: open && view === 'history' ? 3000 : undefined });
  const job = useT(['import-job', jobId], () => api.get<Job>(`/leads/import/jobs/${jobId}`), { enabled: open && !!jobId, refetchInterval: polling ? 1500 : undefined });
  const j = job.data;
  React.useEffect(() => { setPolling(!!j && ACTIVE.includes(j.status)); }, [j?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!open) return;
    setError(null); setBusy(null); setUploadPct(null);
    // reopening while an import is still running: show it instead of an empty form
    const running = history.data?.jobs.find((x) => ACTIVE.includes(x.status));
    if (running) { setJobId(running.id); setView('new'); } else { setJobId(null); setView('new'); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { qc.invalidateQueries({ predicate: (k) => k.queryKey[1] === 'import-jobs' || k.queryKey[1] === 'import-job' || k.queryKey[1] === 'leads' }); };
  const wasActive = React.useRef(false);
  React.useEffect(() => {
    if (j && ACTIVE.includes(j.status)) wasActive.current = true;
    if (j && wasActive.current && !ACTIVE.includes(j.status) && j.status !== 'PREVIEW') { wasActive.current = false; qc.invalidateQueries({ predicate: (k) => k.queryKey[1] === 'leads' || k.queryKey[1] === 'lead' }); }
  }, [j?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(f?: File | null) {
    if (!f) return;
    setError(null);
    const max = history.data?.limits.maxFileBytes;
    if (max && f.size > max) { setError(`This file is ${fmtBytes(f.size)}; the limit is ${fmtBytes(max)}. Split it into parts.`); return; }
    setBusy('upload'); setUploadPct(0);
    try {
      const created = await api.uploadMany<Job>('/leads/import/jobs', [f], setUploadPct, 'file');
      setJobId(created.id); qc.setQueryData([orgId, 'import-job', created.id], created); refresh();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(null); setUploadPct(null); if (input.current) input.current.value = ''; }
  }
  async function start() {
    if (!j) return; setBusy('start'); setError(null);
    try { const r = await api.post<Job>(`/leads/import/jobs/${j.id}/start`, { duplicates: dup }); qc.setQueryData([orgId, 'import-job', j.id], r); setPolling(true); refresh(); toast.success('Import started — you can close this window, it keeps running.'); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }
  async function cancel(id: string) {
    setBusy('cancel');
    try { await api.post(`/leads/import/jobs/${id}/cancel`); toast.success('Cancel requested'); refresh(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  }
  const report = (id: string) => api.download(`/leads/import/jobs/${id}/errors`).catch((e) => toast.error(errMsg(e)));

  const finished = j && ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(j.status);
  const issues = j?.preview?.filter((p) => p.status !== 'OK') ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="Import leads" description="Upload a CSV or Excel file. We check the columns and a sample first; the import then runs in the background, so large files never block you."
      footer={finished ? <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button> : view === 'history' ? <Button onClick={() => onOpenChange(false)}>Close</Button> : j?.status === 'PREVIEW' ? <><Button onClick={() => setJobId(null)}>Choose another file</Button><Button variant="primary" loading={busy === 'start'} onClick={start}>Start import{j.totalRows != null ? ` (${num(j.totalRows)} rows)` : ''}</Button></> : j && ACTIVE.includes(j.status) ? <><Button onClick={() => onOpenChange(false)}>Close — keep running</Button><Button variant="danger" disabled={!j.canCancel} loading={busy === 'cancel'} onClick={() => cancel(j.id)}>Cancel import</Button></> : <Button onClick={() => onOpenChange(false)}>Cancel</Button>}>
      <div role="tablist" aria-label="Import" className="mb-4 flex w-fit rounded-lg bg-subtle p-0.5">
        {([['new', 'New import'], ['history', 'History']] as const).map(([v, l]) => <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('rounded-md px-3 py-1 text-xs font-medium', view === v ? 'bg-surface shadow-card' : 'text-ink-2 hover:text-ink')}>{l}</button>)}
      </div>

      {view === 'history' ? (
        history.isLoading ? <Skeleton className="h-40" /> : !history.data?.jobs.length ? <EmptyState className="py-10" icon={<Clock />} title="No imports yet" description={`Finished imports are kept for ${history.data?.limits.retentionDays ?? 90} days.`} /> : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Import history">
            {history.data.jobs.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 p-3">
                <FileSpreadsheet className="size-5 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{h.fileName}</p><p className="text-xs text-ink-3">{fmtDateTime(h.createdAt)}{h.createdBy ? ` · ${h.createdBy.name}` : ''} · {num(h.createdRows)} created{h.failedRows ? ` · ${num(h.failedRows)} errors` : ''}{h.skippedRows ? ` · ${num(h.skippedRows)} skipped` : ''}</p></div>
                <Badge tone={TONE[h.status]}>{LABEL[h.status]}{ACTIVE.includes(h.status) && h.totalRows ? ` ${h.progress}%` : ''}</Badge>
                {h.hasErrorReport && <Button size="sm" onClick={() => report(h.id)}><Download className="size-3.5" />Error report</Button>}
                {h.canCancel && h.status !== 'PREVIEW' && <Button size="sm" variant="danger" onClick={() => cancel(h.id)}>Cancel</Button>}
                {ACTIVE.includes(h.status) && <Button size="sm" onClick={() => { setJobId(h.id); setView('new'); }}>View</Button>}
              </li>
            ))}
          </ul>
        )
      ) : !j ? (
        <div className="space-y-4">
          <div role="button" tabIndex={0} aria-label="Choose a file to import" onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void pick(e.dataTransfer.files[0]); }}
            className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors', drag ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-subtle')}>
            {busy === 'upload' ? <Loader2 className="size-8 animate-spin text-accent" /> : <UploadCloud className="size-8 text-ink-3" />}
            <p className="text-[13px] font-medium">{busy === 'upload' ? `Uploading and checking the file… ${Math.round((uploadPct ?? 0) * 100)}%` : 'Drop a file here, or click to browse'}</p>
            <p className="text-xs text-ink-3">.csv or .xlsx · up to {history.data ? `${fmtBytes(history.data.limits.maxFileBytes)} and ${num(history.data.limits.maxRows)} rows` : '…'} · columns like First Name, Last Name, Email, Phone, Company, Source, Priority, Tags</p>
            <input ref={input} type="file" accept=".csv,.xlsx,text/csv" className="sr-only" data-testid="import-file" onChange={(e) => void pick(e.target.files?.[0])} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="link" onClick={() => api.download('/leads/import/template')}><Download className="size-3.5" />Download CSV template</Button>
            <label className="flex items-center gap-2 text-xs text-ink-2">Duplicates<span className="w-44"><Select aria-label="Duplicate handling" value={dup} onChange={(e) => setDup(e.target.value as 'skip' | 'import')}><option value="skip">Skip duplicates</option><option value="import">Import anyway</option></Select></span></label>
          </div>
          {error && <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft p-3 text-xs text-bad">{error}</div>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-line p-3">
            <FileSpreadsheet className="size-6 shrink-0 text-accent" />
            <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{j.fileName}</p><p className="text-xs text-ink-3">{fmtBytes(j.fileSize)} · {j.totalRows != null ? `${num(j.totalRows)} rows` : 'counting rows…'} · duplicates: {dup === 'skip' || j.status === 'PREVIEW' ? (dup === 'skip' ? 'skipped' : 'imported anyway') : 'as chosen'}</p></div>
            <Badge tone={TONE[j.status]}>{LABEL[j.status]}</Badge>
          </div>

          {j.status === 'PREVIEW' && (
            <>
              {j.unmappedHeaders && j.unmappedHeaders.length > 0 && <p className="text-xs text-ink-3">Ignored columns: {j.unmappedHeaders.join(', ')}</p>}
              <div className="flex items-center gap-2 text-xs text-ink-2"><span>Duplicates</span><span className="w-44"><Select aria-label="Duplicate handling" value={dup} onChange={(e) => setDup(e.target.value as 'skip' | 'import')}><option value="skip">Skip duplicates</option><option value="import">Import anyway</option></Select></span></div>
              {issues.length > 0 ? (
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><AlertCircle className="size-3.5 text-bad" />Rows needing attention <span className="font-normal text-ink-3">(checked the first {j.preview?.length ?? 0} rows — every row is checked again while importing)</span></p>
                  <div className="scroll-thin max-h-48 overflow-auto rounded-lg border border-line">
                    <table className="w-full text-xs"><thead className="sticky top-0 bg-subtle text-left text-[11px] uppercase text-ink-3"><tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Problem</th></tr></thead>
                      <tbody className="divide-y divide-line">{issues.map((p) => <tr key={p.row}><td className="tnum px-3 py-1.5">{p.row}</td><td className="px-3 py-1.5"><Badge tone={p.status === 'ERROR' ? 'bad' : 'warn'} className="mr-2">{p.status === 'ERROR' ? 'error' : 'duplicate'}</Badge>{p.message}</td></tr>)}</tbody></table>
                  </div>
                </div>
              ) : <p className="flex items-center gap-1.5 text-xs text-ok"><CheckCircle2 className="size-3.5" />The first {j.preview?.length ?? 0} rows look good.</p>}
              <p className="text-xs text-ink-3">Valid rows are imported; rows with problems are skipped and listed in a downloadable error report. Imported leads are never rolled back if you cancel later.</p>
            </>
          )}

          {(ACTIVE.includes(j.status) || finished) && (
            <div role="status" aria-live="polite" data-testid="import-status">
              {ACTIVE.includes(j.status) && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-ink-2"><span>{j.status === 'QUEUED' ? 'Waiting for a worker…' : j.cancelRequested ? 'Stopping after the current batch…' : 'Importing…'}</span><span className="tnum">{num(j.processedRows)} / {j.totalRows != null ? num(j.totalRows) : '…'} · {j.progress}%</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.progress} aria-label="Import progress"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${j.progress}%` }} /></div>
                </div>
              )}
              {j.status === 'COMPLETED' && <div className="flex items-center gap-3 rounded-lg bg-ok-soft p-4 text-ok"><CheckCircle2 className="size-6" /><div><p className="font-semibold">Import complete</p><p className="text-xs">Imported {num(j.createdRows)} lead{j.createdRows === 1 ? '' : 's'}{j.skippedRows ? ` · ${num(j.skippedRows)} skipped` : ''}{j.failedRows ? ` · ${num(j.failedRows)} with errors` : ''}</p></div></div>}
              {j.status === 'FAILED' && <div role="alert" className="flex items-start gap-3 rounded-lg bg-bad-soft p-4 text-bad"><XCircle className="size-6 shrink-0" /><div><p className="font-semibold">Import failed</p><p className="text-xs">{j.error ?? 'Something went wrong.'} {j.createdRows ? `${num(j.createdRows)} leads were imported before it stopped.` : 'No leads were imported.'}</p></div></div>}
              {j.status === 'CANCELED' && <div className="flex items-center gap-3 rounded-lg bg-subtle p-4 text-ink-2"><XCircle className="size-6" /><div><p className="font-semibold">Import canceled</p><p className="text-xs">{num(j.createdRows)} lead{j.createdRows === 1 ? ' was' : 's were'} imported before it stopped and were kept.</p></div></div>}
              {j.stopReason === 'PLAN_LIMIT' && <p role="alert" className="mt-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-xs text-warn">The import stopped because your plan&apos;s lead limit was reached. The remaining rows were not imported. Upgrade your plan and import them again.</p>}
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[['Rows', j.totalRows ?? 0, ''], ['Imported', j.createdRows, 'text-ok'], ['Skipped', j.skippedRows, j.skippedRows ? 'text-warn' : ''], ['Errors', j.failedRows, j.failedRows ? 'text-bad' : '']].map(([l, v, c]) => <div key={String(l)} className="rounded-lg border border-line p-3"><p className="text-xs text-ink-3">{l}</p><p className={cn('tnum text-xl font-semibold', String(c))}>{num(Number(v))}</p></div>)}
              </div>
              {j.hasErrorReport && finished && <div className="mt-3"><Button size="sm" onClick={() => report(j.id)}><Download className="size-3.5" />Download error report (CSV)</Button></div>}
            </div>
          )}
          {error && <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft p-3 text-xs text-bad">{error}</div>}
        </div>
      )}
    </Dialog>
  );
}
