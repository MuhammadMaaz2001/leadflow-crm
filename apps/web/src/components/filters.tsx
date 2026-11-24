'use client';
import * as React from 'react';
import { Select, Input } from '@/components/ui/form';
import { useMembers, usePipelines, useSources } from '@/lib/hooks';
import { useOrg } from '@/lib/session';

export const RANGE_OPTIONS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['all', 'All time'], ['custom', 'Custom range…'],
] as const;

export interface ReportFilterState { range: string; from: string; to: string; assignedToId: string; sourceId: string; pipelineId: string }
export const defaultFilters: ReportFilterState = { range: 'last_30_days', from: '', to: '', assignedToId: '', sourceId: '', pipelineId: '' };
export const filterParams = (f: ReportFilterState) => ({ range: f.range, from: f.range === 'custom' ? f.from : undefined, to: f.range === 'custom' ? f.to : undefined, assignedToId: f.assignedToId || undefined, sourceId: f.sourceId || undefined, pipelineId: f.pipelineId || undefined });

export function FilterBar({ value, onChange, showPerson = true, showSource = true, showPipeline = true }: { value: ReportFilterState; onChange: (v: ReportFilterState) => void; showPerson?: boolean; showSource?: boolean; showPipeline?: boolean }) {
  const { can, canAny } = useOrg();
  const seePeople = showPerson && can('dashboard.view_all') && canAny('team.view', 'team.manage', 'leads.assign');
  const members = useMembers(seePeople);
  const sources = useSources();
  const pipelines = usePipelines();
  const set = (p: Partial<ReportFilterState>) => onChange({ ...value, ...p });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-[150px]"><Select aria-label="Date range" value={value.range} onChange={(e) => set({ range: e.target.value })}>{RANGE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
      {value.range === 'custom' && (
        <>
          <Input type="date" aria-label="From date" className="w-[140px]" value={value.from} max={value.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="text-xs text-ink-3">to</span>
          <Input type="date" aria-label="To date" className="w-[140px]" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </>
      )}
      {seePeople && <div className="w-[160px]"><Select aria-label="Salesperson" value={value.assignedToId} onChange={(e) => set({ assignedToId: e.target.value })}><option value="">All salespeople</option>{members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select></div>}
      {showSource && <div className="w-[150px]"><Select aria-label="Lead source" value={value.sourceId} onChange={(e) => set({ sourceId: e.target.value })}><option value="">All sources</option>{sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>}
      {showPipeline && (pipelines.data?.length ?? 0) > 1 && <div className="w-[160px]"><Select aria-label="Pipeline" value={value.pipelineId} onChange={(e) => set({ pipelineId: e.target.value })}><option value="">Default pipeline</option>{pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>}
    </div>
  );
}

/** Active-member picker (assignees, owners). */
export function MemberSelect({ value, onChange, includeUnassigned, allowEmpty, placeholder = 'Select…', id, invalid, ...rest }: { value: string; onChange: (v: string) => void; includeUnassigned?: boolean; allowEmpty?: boolean; placeholder?: string; id?: string; invalid?: boolean; 'aria-label'?: string }) {
  const members = useMembers();
  return (
    <Select id={id} value={value ?? ''} invalid={invalid} onChange={(e) => onChange(e.target.value)} {...rest}>
      {(allowEmpty || includeUnassigned) && <option value="">{includeUnassigned ? 'Unassigned' : placeholder}</option>}
      {members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
    </Select>
  );
}
