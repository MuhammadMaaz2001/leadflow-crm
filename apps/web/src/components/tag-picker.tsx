'use client';
import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useTags, type Lookup } from '@/lib/hooks';
import { useAct } from '@/lib/session';
import { Input } from '@/components/ui/form';
import { cn } from '@/lib/utils';

export function TagChip({ tag, onRemove }: { tag: { name: string; color: string }; onRemove?: () => void }) {
  return <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2"><span className="size-1.5 rounded-full" style={{ background: tag.color }} />{tag.name}{onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${tag.name}`} className="text-ink-3 hover:text-ink"><X className="size-3" /></button>}</span>;
}

export function TagPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const tags = useTags();
  const [adding, setAdding] = React.useState('');
  const create = useAct((name: string) => api.post<Lookup>('/tags', { name }), { invalidate: ['tags'], silent: false, onSuccess: (t) => { onChange([...value, t.id]); setAdding(''); } });
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tags.data?.map((t) => {
          const on = value.includes(t.id);
          return <button key={t.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== t.id) : [...value, t.id])} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors', on ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2 hover:bg-subtle')}><span className="size-1.5 rounded-full" style={{ background: t.color }} />{t.name}</button>;
        })}
      </div>
      <form className="mt-2 flex max-w-xs gap-1.5" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) create.mutate(adding.trim()); }}>
        <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="New tag…" aria-label="New tag name" className="h-7 text-xs" />
        <button type="submit" className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong px-2 text-xs hover:bg-subtle" disabled={create.isPending}><Plus className="size-3" />Add</button>
      </form>
    </div>
  );
}
