'use client';
import * as React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, Skeleton } from './data';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  className?: string;
  sortable?: boolean;
  /** hide below this breakpoint (table collapses to cards on phones) */
  hideBelow?: 'sm' | 'md' | 'lg';
  /** show in the stacked mobile card as the primary title */
  primary?: boolean;
  mobileLabel?: string;
}

const hide = { sm: 'max-sm:hidden', md: 'max-md:hidden', lg: 'max-lg:hidden' };

export function DataTable<T extends { id: string }>({ columns, rows, loading, empty, onRowClick, selection, sort, onSort, rowClassName, skeletonRows = 8, mobileCards = true, error, onRetry }: {
  error?: unknown; onRetry?: () => void;
  columns: Column<T>[]; rows: T[] | undefined; loading?: boolean; empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selection?: { selected: Set<string>; onChange: (s: Set<string>) => void; renderCheckbox: (checked: boolean, onChange: (v: boolean) => void, label: string, indeterminate?: boolean) => React.ReactNode };
  sort?: { key: string; order: 'asc' | 'desc' }; onSort?: (key: string) => void; rowClassName?: (row: T) => string | undefined; skeletonRows?: number; mobileCards?: boolean;
}) {
  const allSelected = !!rows?.length && rows.every((r) => selection?.selected.has(r.id));
  const someSelected = !!rows?.some((r) => selection?.selected.has(r.id)) && !allSelected;
  const toggleAll = (v: boolean) => { if (!selection || !rows) return; const s = new Set(selection.selected); rows.forEach((r) => (v ? s.add(r.id) : s.delete(r.id))); selection.onChange(s); };
  const toggle = (id: string, v: boolean) => { if (!selection) return; const s = new Set(selection.selected); if (v) s.add(id); else s.delete(id); selection.onChange(s); };

  if (error && !rows?.length) return <ErrorState error={error} onRetry={onRetry} />;
  if (!loading && rows && rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  const primary = columns.find((c) => c.primary) ?? columns[0]!;

  return (
    <>
      {mobileCards && (
        <ul className="divide-y divide-line sm:hidden">
          {loading ? Array.from({ length: 5 }).map((_, i) => <li key={i} className="space-y-2 p-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></li>) : rows?.map((r) => (
            <li key={r.id} className={cn('p-4', onRowClick && 'active:bg-subtle')} onClick={() => onRowClick?.(r)}>
              <div className="flex items-start gap-3">
                {selection && <div onClick={(e) => e.stopPropagation()} className="pt-0.5">{selection.renderCheckbox(selection.selected.has(r.id), (v) => toggle(r.id, v), 'Select row')}</div>}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{primary.cell(r)}</div>
                  <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
                    {columns.filter((c) => c !== primary && c.header).slice(0, 6).map((c) => (
                      <div key={c.key} className="min-w-0"><dt className="text-[10px] uppercase tracking-wide text-ink-3">{c.mobileLabel ?? (typeof c.header === 'string' ? c.header : '')}</dt><dd className="truncate text-[13px]">{c.cell(r)}</dd></div>
                    ))}
                  </dl>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className={cn('scroll-thin overflow-x-auto', mobileCards && 'max-sm:hidden')}>
        <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-subtle/60 text-[11px] font-medium uppercase tracking-wide text-ink-3">
              {selection && <th className="w-10 py-2 pl-4">{selection.renderCheckbox(allSelected, toggleAll, 'Select all rows on this page', someSelected)}</th>}
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('whitespace-nowrap px-3 py-2 first:pl-4 last:pr-4', c.hideBelow && hide[c.hideBelow], c.className)}>
                  {c.sortable && onSort ? (
                    <button type="button" className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink" onClick={() => onSort(c.key)}>
                      {c.header}{sort?.key === c.key && (sort.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading ? Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>{selection && <td className="py-3 pl-4"><Skeleton className="size-4" /></td>}{columns.map((c) => <td key={c.key} className={cn('px-3 py-3 first:pl-4', c.hideBelow && hide[c.hideBelow])}><Skeleton className="h-4 w-[70%]" /></td>)}</tr>
            )) : rows?.map((r) => (
              <tr key={r.id} className={cn('group transition-colors', onRowClick && 'cursor-pointer hover:bg-subtle/70', selection?.selected.has(r.id) && 'bg-accent-soft/40', rowClassName?.(r))} onClick={() => onRowClick?.(r)}>
                {selection && <td className="w-10 py-2.5 pl-4" onClick={(e) => e.stopPropagation()}>{selection.renderCheckbox(selection.selected.has(r.id), (v) => toggle(r.id, v), 'Select row')}</td>}
                {columns.map((c) => <td key={c.key} className={cn('whitespace-nowrap px-3 py-2.5 align-middle first:pl-4 last:pr-4', c.primary && 'max-w-[300px] [&_*]:truncate', c.hideBelow && hide[c.hideBelow], c.className)}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
