'use client';
import * as React from 'react';
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, UploadCloud } from 'lucide-react';
import { api } from '@/lib/api';
import { errMsg, useAct } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { Badge } from '@/components/ui/data';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/utils';

interface ImportResult { dryRun: boolean; total: number; valid: number; created: number; skippedDuplicates: number; failed: number; errors: Array<{ row: number; field?: string; message: string; data?: Record<string, string> }>; duplicates: Array<{ row: number; message: string }>; mapping: Record<string, string>; unmappedHeaders: string[] }

function csvEscape(v: string) { return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

export function LeadImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [dup, setDup] = React.useState<'skip' | 'import'>('skip');
  const [preview, setPreview] = React.useState<ImportResult | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (open) { setFile(null); setPreview(null); setResult(null); setError(null); } }, [open]);

  const validate = useAct((f: File) => api.upload<ImportResult>('/leads/import', f, { dryRun: true, duplicates: dup }), { silent: true, onSuccess: setPreview, onError: (e) => setError(errMsg(e)) });
  const run = useAct((f: File) => api.upload<ImportResult>('/leads/import', f, { duplicates: dup }), { success: (r) => `Imported ${r.created} lead${r.created === 1 ? '' : 's'}`, onSuccess: setResult });

  function pick(f?: File | null) {
    if (!f) return;
    setFile(f); setPreview(null); setResult(null); setError(null);
    validate.mutate(f);
  }
  function errorReport() {
    if (!preview) return;
    const rows = [['Row', 'Field', 'Problem'], ...preview.errors.map((e) => [String(e.row), e.field ?? '', e.message]), ...preview.duplicates.map((d) => [String(d.row), '', d.message])];
    const blob = new Blob(['﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lead-import-errors.csv'; a.click();
  }
  const data = result ?? preview;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="Import leads" description="Upload a CSV or Excel file. We validate every row first so nothing is imported by surprise."
      footer={result ? <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button> : <><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!preview || preview.valid === 0 || run.isPending} loading={run.isPending} onClick={() => file && run.mutate(file)}>Import {preview?.valid ?? 0} valid {preview?.valid === 1 ? 'row' : 'rows'}</Button></>}>
      {!result && (
        <div className="space-y-4">
          <div role="button" tabIndex={0} aria-label="Choose a file to import" onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
            className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors', drag ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-subtle')}>
            {file ? <FileSpreadsheet className="size-8 text-accent" /> : <UploadCloud className="size-8 text-ink-3" />}
            <p className="text-[13px] font-medium">{file ? file.name : 'Drop a file here, or click to browse'}</p>
            <p className="text-xs text-ink-3">.csv or .xlsx · up to 2,000 rows · columns like First Name, Last Name, Email, Phone, Company, Source, Priority, Tags</p>
            <input ref={input} type="file" accept=".csv,.xlsx,text/csv" className="sr-only" data-testid="import-file" onChange={(e) => pick(e.target.files?.[0])} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="link" onClick={() => api.download('/leads/import/template')}><Download className="size-3.5" />Download CSV template</Button>
            <label className="flex items-center gap-2 text-xs text-ink-2">Duplicates<span className="w-44"><Select aria-label="Duplicate handling" value={dup} onChange={(e) => { setDup(e.target.value as 'skip' | 'import'); if (file) setTimeout(() => validate.mutate(file), 0); }}><option value="skip">Skip rows that already exist</option><option value="import">Import them anyway</option></Select></span></label>
          </div>
          {error && <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft p-3 text-xs text-bad">{error}</div>}
          {validate.isPending && <p className="text-center text-xs text-ink-3">Validating rows…</p>}
        </div>
      )}
      {data && (
        <div className={cn('space-y-4', !result && 'mt-5')}>
          {result && <div className="flex items-center gap-3 rounded-lg bg-ok-soft p-4 text-ok"><CheckCircle2 className="size-6" /><div><p className="font-semibold">Import complete</p><p className="text-xs">{result.created} created · {result.skippedDuplicates} duplicates skipped · {result.failed} rows with errors</p></div></div>}
          {!result && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="status">
              {[['Rows', data.total, 'neutral'], ['Valid', data.valid, 'ok'], ['Duplicates', data.skippedDuplicates, 'warn'], ['Errors', data.failed, data.failed ? 'bad' : 'neutral']].map(([l, v, t]) => (
                <div key={String(l)} className="rounded-lg border border-line p-3"><p className="text-xs text-ink-3">{l}</p><p className={cn('tnum text-xl font-semibold', t === 'ok' && 'text-ok', t === 'bad' && 'text-bad', t === 'warn' && 'text-warn')}>{v}</p></div>
              ))}
            </div>
          )}
          {data.unmappedHeaders.length > 0 && <p className="text-xs text-ink-3">Ignored columns: {data.unmappedHeaders.join(', ')}</p>}
          {(data.errors.length > 0 || data.duplicates.length > 0) && (
            <div>
              <div className="mb-2 flex items-center justify-between"><p className="flex items-center gap-1.5 text-xs font-semibold"><AlertCircle className="size-3.5 text-bad" />Rows needing attention</p><Button size="sm" onClick={errorReport}><Download className="size-3.5" />Error report (CSV)</Button></div>
              <div className="scroll-thin max-h-56 overflow-auto rounded-lg border border-line">
                <table className="w-full text-xs"><thead className="sticky top-0 bg-subtle text-left text-[11px] uppercase text-ink-3"><tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Problem</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {data.errors.slice(0, 100).map((e, i) => <tr key={`e${i}`}><td className="tnum px-3 py-1.5">{e.row}</td><td className="px-3 py-1.5"><Badge tone="bad" className="mr-2">{e.field ?? 'row'}</Badge>{e.message}</td></tr>)}
                    {data.duplicates.slice(0, 100).map((e, i) => <tr key={`d${i}`}><td className="tnum px-3 py-1.5">{e.row}</td><td className="px-3 py-1.5"><Badge tone="warn" className="mr-2">duplicate</Badge>{e.message}</td></tr>)}
                  </tbody></table>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
