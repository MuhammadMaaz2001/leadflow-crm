'use client';
import * as React from 'react';
import { Download, File as FileIcon, FileImage, FileSpreadsheet, FileText, Paperclip, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { useOrg, useT, errMsg } from '@/lib/session';
import { fmtBytes, fmtDateTime, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/data';
import { Tooltip } from '@/components/ui/menu';
import { useConfirm } from '@/components/ui/overlay';

interface Att { id: string; name: string; contentType: string; extension: string; size: number; uploadedAt: string; uploadedBy: { id: string; name: string } | null }
interface Listing { items: Att[]; limits: { maxBytes: number; maxFilesPerRequest: number; maxPerLead: number; accept: string; enabled: boolean }; canUpload: boolean }
interface UploadResult { uploaded: Att[]; rejected: Array<{ name: string; code: string; message: string }> }

const icon = (ext: string) => (['jpg', 'png', 'webp'].includes(ext) ? <FileImage /> : ['xls', 'xlsx', 'csv'].includes(ext) ? <FileSpreadsheet /> : ['pdf', 'doc', 'docx'].includes(ext) ? <FileText /> : <FileIcon />);

export function LeadAttachments({ leadId, archived }: { leadId: string; archived: boolean }) {
  const { can } = useOrg();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useT(['lead', leadId, 'attachments'], () => api.get<Listing>(`/leads/${leadId}/attachments`));
  const input = React.useRef<HTMLInputElement>(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [problems, setProblems] = React.useState<Array<{ name: string; message: string }>>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const data = q.data;
  const uploading = progress !== null;

  const refresh = () => { qc.invalidateQueries({ predicate: (k) => k.queryKey[1] === 'lead' && k.queryKey[2] === leadId }); };

  async function send(list: File[]) {
    if (!data || !list.length || uploading) return;
    // quick client-side checks for instant feedback — the server validates the real content again
    const tooBig = list.filter((f) => f.size > data.limits.maxBytes);
    const ok = list.filter((f) => f.size <= data.limits.maxBytes).slice(0, data.limits.maxFilesPerRequest);
    const local = tooBig.map((f) => ({ name: f.name, message: `Larger than ${fmtBytes(data.limits.maxBytes)}` }));
    if (list.length - tooBig.length > ok.length) local.push({ name: `${list.length - tooBig.length - ok.length} more file(s)`, message: `Only ${data.limits.maxFilesPerRequest} files can be uploaded at a time` });
    setProblems(local);
    if (!ok.length) return;
    setProgress(0);
    try {
      const r = await api.uploadMany<UploadResult>(`/leads/${leadId}/attachments`, ok, setProgress);
      if (r.rejected.length) setProblems((p) => [...p, ...r.rejected.map((x) => ({ name: x.name, message: x.message }))]);
      toast.success(`${r.uploaded.length} file${r.uploaded.length === 1 ? '' : 's'} uploaded`);
    } catch (e) {
      const rej = e instanceof ApiError ? (e.details as { rejected?: Array<{ name: string; message: string }> } | undefined)?.rejected : undefined;
      setProblems((p) => [...p, ...(rej?.length ? rej : [{ name: ok.length === 1 ? ok[0]!.name : 'Upload', message: errMsg(e) }])]);
      toast.error(errMsg(e));
    } finally { setProgress(null); if (input.current) input.current.value = ''; refresh(); }
  }

  async function download(a: Att) {
    setBusy(a.id);
    try { await api.download(`/leads/${leadId}/attachments/${a.id}/download`); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  }
  async function remove(a: Att) {
    if (!(await confirm({ title: `Remove "${a.name}"?`, description: 'The file is deleted from storage. This is recorded on the lead timeline.', confirmLabel: 'Remove', destructive: true }))) return;
    setBusy(a.id);
    try { await api.del(`/leads/${leadId}/attachments/${a.id}`); toast.success('File removed'); refresh(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  }

  if (q.isLoading) return <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (q.error || !data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!data.limits.enabled) return <EmptyState className="py-10" icon={<Paperclip />} title="File storage is not configured" description="Attachments need object storage. Ask your administrator to enable it (STORAGE_PROVIDER=s3)." />;
  const canWrite = data.canUpload && can('leads.update') && !archived;

  return (
    <div>
      {canWrite && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void send([...e.dataTransfer.files]); }}
          className={cn('mb-4 rounded-lg border border-dashed p-4 text-center transition-colors', drag ? 'border-accent bg-accent-soft/50' : 'border-line bg-subtle/40')}
        >
          <input ref={input} type="file" multiple hidden accept={data.limits.accept} aria-label="Choose files to attach" data-testid="attachment-input" onChange={(e) => void send([...(e.target.files ?? [])])} />
          <Button onClick={() => input.current?.click()} disabled={uploading}><Upload className="size-3.5" />{uploading ? 'Uploading…' : 'Upload files'}</Button>
          <p className="mt-2 text-xs text-ink-3">or drop files here · PDF, Word, Excel, CSV, JPG, PNG, WebP · up to {fmtBytes(data.limits.maxBytes)} each · {data.items.length}/{data.limits.maxPerLead} used</p>
          {uploading && (
            <div className="mx-auto mt-3 max-w-sm" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)} aria-label="Upload progress">
              <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>
              <p className="mt-1 text-xs text-ink-3">{Math.round((progress ?? 0) * 100)}%</p>
            </div>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-bad/30 bg-bad-soft/50 p-3 text-[13px]">
          <div className="flex items-start justify-between gap-2"><p className="font-medium text-bad">{problems.length === 1 ? '1 file was not uploaded' : `${problems.length} files were not uploaded`}</p><button type="button" aria-label="Dismiss" onClick={() => setProblems([])} className="text-ink-3 hover:text-ink"><X className="size-3.5" /></button></div>
          <ul className="mt-1 space-y-0.5 text-ink-2">{problems.map((p, i) => <li key={i}><b className="font-medium">{p.name}</b> — {p.message}</li>)}</ul>
        </div>
      )}
      {data.items.length === 0 ? (
        <EmptyState className="py-10" icon={<Paperclip />} title="No files yet" description={canWrite ? 'Attach proposals, contracts, screenshots or spreadsheets to keep everything about this lead in one place.' : 'Nothing has been attached to this lead.'} />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Attachments">
          {data.items.map((a) => (
            <li key={a.id} className="flex items-center gap-3 p-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-ink-2 [&>svg]:size-4">{icon(a.extension)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium" title={a.name}>{a.name}</p>
                <p className="text-xs text-ink-3"><Badge className="mr-1.5 uppercase">{a.extension}</Badge>{fmtBytes(a.size)} · <Tooltip content={fmtDateTime(a.uploadedAt)}><time dateTime={a.uploadedAt}>{timeAgo(a.uploadedAt)}</time></Tooltip>{a.uploadedBy ? ` · ${a.uploadedBy.name}` : ''}</p>
              </div>
              <Button size="sm" aria-label={`Download ${a.name}`} onClick={() => void download(a)} loading={busy === a.id}><Download className="size-3.5" /><span className="hidden sm:inline">Download</span></Button>
              {!archived && (can('leads.archive') || can('leads.update')) && <Button size="icon" variant="ghost" aria-label={`Remove ${a.name}`} disabled={busy === a.id} onClick={() => void remove(a)}><Trash2 className="size-4 text-bad" /></Button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
