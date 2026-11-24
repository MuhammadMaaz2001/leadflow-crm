'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Archive, Bookmark, BookmarkPlus, CalendarPlus, ChevronDown, Copy, Download, Filter, MoreHorizontal, Pencil, Phone, Plus, RotateCcw, Search, Tags, Target, Trash2, Upload, UserPlus, X, Flag } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useCustomFields, useMembers, usePriorities, useSources, useTags } from '@/lib/hooks';
import { useAct, useOrg, useT } from '@/lib/session';
import { fmtDate, fmtRelativeDay, timeAgo } from '@/lib/format';
import { useDebounced, useUrlState } from '@/lib/use-url-state';
import { LEAD_STATUSES } from '@leadflow/shared';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Field } from '@/components/ui/form';
import { Avatar, Badge, Card, EmptyState, PageHeader, Pagination, UserChip } from '@/components/ui/data';
import { DataTable, type Column } from '@/components/ui/table';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { Dialog, useConfirm } from '@/components/ui/overlay';
import { PriorityDot, SourceTag, StatusBadge } from '@/components/badges';
import { TagChip } from '@/components/tag-picker';
import { LeadFormSheet, type EditableLead } from '@/components/lead-form';
import { LeadImportDialog } from '@/components/lead-import';
import { DuplicatesDialog } from '@/components/duplicates-dialog';
import { AssignDialog, LogActivityDialog, LostReasonDialog, ScheduleFollowUpDialog, type LeadLite } from '@/components/dialogs';

export interface LeadRow extends EditableLead {
  id: string; name: string; status: string; source: { id: string; name: string; color: string } | null; priority: { id: string; name: string; color: string } | null;
  tags: Array<{ id: string; name: string; color: string }>; assignedTo: { id: string; name: string } | null; nextFollowUpAt: string | null; createdAt: string; lastActivityAt: string; archivedAt: string | null; companyName: string | null;
}

const DEFAULTS = { q: '', status: '', priorityId: '', sourceId: '', assignedToId: '', tagId: '', createdFrom: '', createdTo: '', archived: 'false', uncontacted: '', hasOverdueFollowUp: '', noFollowUp: '', sort: 'createdAt', order: 'desc', page: '1', pageSize: '25' };

interface SavedView { name: string; query: string }
function SavedViews({ orgId }: { orgId: string | undefined }) {
  const router = useRouter();
  const params = useSearchParams();
  const key = `lf_views_${orgId}`;
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState('');
  React.useEffect(() => { try { setViews(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { setViews([]); } }, [key]);
  const persist = (v: SavedView[]) => { setViews(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
  const current = (() => { const p = new URLSearchParams(params.toString()); p.delete('page'); return p.toString(); })();
  return (
    <>
      <DropdownMenu>
        <DropdownTrigger asChild><Button><Bookmark className="size-3.5" />Views</Button></DropdownTrigger>
        <DropdownContent align="start" className="w-64">
          <DropdownLabel>Saved views</DropdownLabel>
          {views.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-3">No saved views yet. Set filters, then save them.</p>}
          {views.map((v) => (
            <DropdownItem key={v.name} onSelect={() => router.replace(v.query ? `/leads?${v.query}` : '/leads')}>
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              <button aria-label={`Delete view ${v.name}`} className="text-ink-3 hover:text-bad" onClick={(e) => { e.stopPropagation(); persist(views.filter((x) => x.name !== v.name)); }}><Trash2 className="size-3.5" /></button>
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem icon={<BookmarkPlus />} onSelect={() => { setName(''); setNaming(true); }}>Save current filters…</DropdownItem>
        </DropdownContent>
      </DropdownMenu>
      <Dialog open={naming} onOpenChange={setNaming} size="sm" title="Save view" description="Saved in this browser for this workspace."
        footer={<><Button onClick={() => setNaming(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => { persist([...views.filter((x) => x.name !== name.trim()), { name: name.trim(), query: current }]); setNaming(false); toast.success('View saved'); }}>Save view</Button></>}>
        <Field label="View name" required><Input aria-label="View name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hot leads without follow-up" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { persist([...views.filter((x) => x.name !== name.trim()), { name: name.trim(), query: current }]); setNaming(false); toast.success('View saved'); } }} /></Field>
      </Dialog>
    </>
  );
}

function LeadsPageInner() {
  const router = useRouter();
  const confirm = useConfirm();
  const { can, has, orgId } = useOrg();
  const [dupOpen, setDupOpen] = React.useState(false);
  const [f, setF] = useUrlState(DEFAULTS);
  const [search, setSearch] = React.useState(f.q);
  const dsearch = useDebounced(search, 300);
  React.useEffect(() => { if (dsearch !== f.q) setF({ q: dsearch }); }, [dsearch]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { setSearch(f.q); }, [f.q]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = React.useState(false);
  const [editLead, setEditLead] = React.useState<LeadRow | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [assignFor, setAssignFor] = React.useState<string[] | null>(null);
  const [lostFor, setLostFor] = React.useState<string[] | null>(null);
  const [followUpFor, setFollowUpFor] = React.useState<LeadLite | null>(null);
  const [logFor, setLogFor] = React.useState<LeadRow | null>(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const params = { q: f.q || undefined, status: f.status || undefined, priorityId: f.priorityId || undefined, sourceId: f.sourceId || undefined, assignedToId: f.assignedToId || undefined, tagId: f.tagId || undefined, createdFrom: f.createdFrom ? new Date(f.createdFrom).toISOString() : undefined, createdTo: f.createdTo ? new Date(`${f.createdTo}T23:59:59`).toISOString() : undefined, archived: f.archived, uncontacted: f.uncontacted || undefined, hasOverdueFollowUp: f.hasOverdueFollowUp || undefined, noFollowUp: f.noFollowUp || undefined };
  const q = useT(['leads', f], () => api.page<LeadRow>('/leads', { ...params, sort: f.sort, order: f.order, page: Number(f.page), pageSize: Number(f.pageSize) }), { keep: true });
  React.useEffect(() => setSelected(new Set()), [f.q, f.status, f.page, f.archived, f.assignedToId, f.sourceId, f.priorityId, f.tagId]);

  const sources = useSources(), priorities = usePriorities(), tags = useTags(), members = useMembers(can('leads.assign') || can('team.view'));
  const cfs = useCustomFields();
  void cfs;
  const activeFilters = ['status', 'priorityId', 'sourceId', 'assignedToId', 'tagId', 'createdFrom', 'createdTo', 'uncontacted', 'hasOverdueFollowUp', 'noFollowUp'].filter((k) => f[k as keyof typeof f]).length + (f.archived !== 'false' ? 1 : 0);
  const rows = q.data?.data;
  const total = q.data?.meta.total ?? 0;

  const archive = useAct((ids: string[]) => api.post('/leads/bulk', { ids, action: 'archive' }), { success: (r: unknown) => `Archived ${(r as { affected: number }).affected} lead(s)`, onSuccess: () => setSelected(new Set()) });
  const restore = useAct((ids: string[]) => api.post('/leads/bulk', { ids, action: 'restore' }), { success: 'Lead(s) restored', onSuccess: () => setSelected(new Set()) });
  const bulk = useAct((b: Record<string, unknown>) => api.post<{ affected: number }>('/leads/bulk', b), { success: (r) => `Updated ${r.affected} lead(s)`, onSuccess: () => { setSelected(new Set()); setAssignFor(null); setLostFor(null); } });

  const toggleSort = (key: string) => setF({ sort: key, order: f.sort === key && f.order === 'desc' ? 'asc' : 'desc' });
  async function doArchive(ids: string[]) {
    if (await confirm({ title: `Archive ${ids.length} lead${ids.length === 1 ? '' : 's'}?`, description: 'Archived leads leave your active lists but keep their full history. You can restore them anytime.', confirmLabel: 'Archive' })) archive.mutate(ids);
  }
  async function exportLeads(format: 'csv' | 'xlsx', ids?: string[]) {
    try { const name = await api.download('/leads/export', { ...params, format, ids: ids?.join(',') }); toast.success(`Exported ${name}`); } catch (e) { toast.error((e as Error).message); }
  }

  const columns: Column<LeadRow>[] = [
    { key: 'name', header: 'Lead', sortable: true, primary: true, cell: (l) => (
      <div className="flex min-w-0 items-center gap-2.5"><Avatar name={l.name} /><div className="min-w-0"><p className="truncate font-medium text-ink">{l.name}{l.archivedAt && <Badge className="ml-2">Archived</Badge>}</p><p className="truncate text-xs text-ink-3">{l.email ?? l.phone}</p></div></div>) },
    { key: 'company', header: 'Company', sortable: true, hideBelow: 'lg', cell: (l) => <div className="min-w-0"><p className="truncate">{l.companyName ?? '—'}</p>{l.jobTitle && <p className="truncate text-xs text-ink-3">{l.jobTitle}</p>}</div> },
    { key: 'status', header: 'Status', sortable: true, cell: (l) => <StatusBadge status={l.status} /> },
    { key: 'priority', header: 'Priority', hideBelow: 'md', cell: (l) => <PriorityDot priority={l.priority} /> },
    { key: 'source', header: 'Source', hideBelow: 'lg', cell: (l) => <SourceTag source={l.source} /> },
    { key: 'owner', header: 'Assigned to', cell: (l) => <UserChip user={l.assignedTo} /> },
    { key: 'next', header: 'Next follow-up', hideBelow: 'md', cell: (l) => l.nextFollowUpAt ? <span className={new Date(l.nextFollowUpAt) < new Date() ? 'font-medium text-bad' : 'text-ink-2'}>{fmtRelativeDay(l.nextFollowUpAt)}</span> : <span className="text-ink-3">—</span> },
    { key: 'createdAt', header: 'Created', sortable: true, hideBelow: 'sm', cell: (l) => <span className="text-ink-2" title={fmtDate(l.createdAt, 'PPpp')}>{fmtDate(l.createdAt)}</span> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'w-10 text-right', mobileLabel: '', cell: (l) => (
      <DropdownMenu>
        <DropdownTrigger asChild><Button variant="ghost" size="iconSm" aria-label={`Actions for ${l.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal className="size-4" /></Button></DropdownTrigger>
        <DropdownContent onClick={(e) => e.stopPropagation()}>
          <DropdownItem onSelect={() => router.push(`/leads/${l.id}`)} icon={<Target />}>View lead</DropdownItem>
          {can('leads.update') && !l.archivedAt && <DropdownItem onSelect={() => setEditLead(l)} icon={<Pencil />}>Edit</DropdownItem>}
          {can('leads.update') && !l.archivedAt && <DropdownItem onSelect={() => setLogFor(l)} icon={<Phone />}>Log call / activity</DropdownItem>}
          {can('followups.manage') && !l.archivedAt && <DropdownItem onSelect={() => setFollowUpFor({ id: l.id, name: l.name, assignedTo: l.assignedTo })} icon={<CalendarPlus />}>Schedule follow-up</DropdownItem>}
          {can('leads.assign') && !l.archivedAt && <DropdownItem onSelect={() => setAssignFor([l.id])} icon={<UserPlus />}>Assign…</DropdownItem>}
          {can('leads.archive') && <><DropdownSeparator />{l.archivedAt ? <DropdownItem onSelect={() => restore.mutate([l.id])} icon={<RotateCcw />}>Restore</DropdownItem> : <DropdownItem destructive onSelect={() => doArchive([l.id])} icon={<Archive />}>Archive</DropdownItem>}</>}
        </DropdownContent>
      </DropdownMenu>) },
  ];
  const ids = [...selected];

  return (
    <>
      <PageHeader title="Leads" count={q.data ? total.toLocaleString() : undefined} description="Every lead, owner and next step in one place."
        actions={<>
          {can('leads.import') && <Button onClick={() => (has('import_export') ? setImportOpen(true) : toast.error('Import requires a plan with CSV / Excel import. Upgrade in Billing.'))}><Upload className="size-3.5" />Import</Button>}
          {can('leads.export') && (
            <DropdownMenu>
              <DropdownTrigger asChild><Button><Download className="size-3.5" />Export<ChevronDown className="size-3" /></Button></DropdownTrigger>
              <DropdownContent>
                <DropdownLabel>Current filters</DropdownLabel>
                <DropdownItem onSelect={() => exportLeads('csv')}>CSV file</DropdownItem>
                <DropdownItem onSelect={() => exportLeads('xlsx')}>Excel (.xlsx)</DropdownItem>
              </DropdownContent>
            </DropdownMenu>
          )}
          {can('leads.merge') && (
            <DropdownMenu>
              <DropdownTrigger asChild><Button size="icon" aria-label="More lead tools"><MoreHorizontal className="size-4" /></Button></DropdownTrigger>
              <DropdownContent><DropdownItem icon={<Copy />} onSelect={() => setDupOpen(true)}>Find & merge duplicates</DropdownItem></DropdownContent>
            </DropdownMenu>
          )}
          {can('leads.create') && <Button variant="primary" onClick={() => { setEditLead(null); setFormOpen(true); }}><Plus className="size-3.5" />Add lead</Button>}
        </>} />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[200px] max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone or company…" aria-label="Search leads" className="pl-8" />
          </div>
          <div className="hidden w-[150px] sm:block"><Select aria-label="Status filter" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">All statuses</option>{LEAD_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></div>
          <div className="hidden w-[160px] md:block"><Select aria-label="Assigned filter" value={f.assignedToId} onChange={(e) => setF({ assignedToId: e.target.value })}><option value="">Anyone</option><option value="unassigned">Unassigned</option>{members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select></div>
          <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger asChild><Button><Filter className="size-3.5" />Filters{activeFilters > 0 && <span className="tnum rounded-full bg-accent px-1.5 text-[10px] text-white">{activeFilters}</span>}</Button></PopoverTrigger>
            <PopoverContent align="start" className="w-[min(360px,calc(100vw-24px))] p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Status"><Select aria-label="Filter status" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">Any</option>{LEAD_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
                <Field label="Priority"><Select aria-label="Filter priority" value={f.priorityId} onChange={(e) => setF({ priorityId: e.target.value })}><option value="">Any</option>{priorities.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                <Field label="Source"><Select aria-label="Filter source" value={f.sourceId} onChange={(e) => setF({ sourceId: e.target.value })}><option value="">Any</option>{sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                <Field label="Tag"><Select aria-label="Filter tag" value={f.tagId} onChange={(e) => setF({ tagId: e.target.value })}><option value="">Any</option>{tags.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                <Field label="Owner" className="col-span-2"><Select aria-label="Filter owner" value={f.assignedToId} onChange={(e) => setF({ assignedToId: e.target.value })}><option value="">Anyone</option><option value="unassigned">Unassigned</option>{members.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select></Field>
                <Field label="Created from"><Input aria-label="Created from" type="date" value={f.createdFrom} onChange={(e) => setF({ createdFrom: e.target.value })} /></Field>
                <Field label="Created to"><Input aria-label="Created to" type="date" value={f.createdTo} onChange={(e) => setF({ createdTo: e.target.value })} /></Field>
                <Field label="Follow-ups" className="col-span-2"><Select aria-label="Follow-up filter" value={f.hasOverdueFollowUp ? 'overdue' : f.noFollowUp ? 'none' : f.uncontacted ? 'uncontacted' : ''} onChange={(e) => setF({ hasOverdueFollowUp: e.target.value === 'overdue' ? 'true' : '', noFollowUp: e.target.value === 'none' ? 'true' : '', uncontacted: e.target.value === 'uncontacted' ? 'true' : '' })}><option value="">Any</option><option value="overdue">Has an overdue follow-up</option><option value="none">No follow-up scheduled</option><option value="uncontacted">Never contacted</option></Select></Field>
                <Field label="Show" className="col-span-2"><Select aria-label="Archived filter" value={f.archived} onChange={(e) => setF({ archived: e.target.value })}><option value="false">Active leads</option><option value="true">Archived only</option><option value="all">Active & archived</option></Select></Field>
              </div>
              <div className="mt-4 flex justify-between"><Button variant="ghost" onClick={() => { setF({ status: '', priorityId: '', sourceId: '', assignedToId: '', tagId: '', createdFrom: '', createdTo: '', archived: 'false', uncontacted: '', hasOverdueFollowUp: '', noFollowUp: '' }); }}>Clear all</Button><Button variant="primary" onClick={() => setFiltersOpen(false)}>Done</Button></div>
            </PopoverContent>
          </Popover>
          <SavedViews orgId={orgId} />
          {(activeFilters > 0 || f.q) && <Button variant="ghost" onClick={() => { setSearch(''); router.replace('/leads'); }}><X className="size-3.5" />Reset</Button>}
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/60 px-4 py-2 text-[13px]" role="region" aria-label="Bulk actions">
            <span className="font-medium text-accent-ink">{selected.size} selected</span>
            {can('leads.assign') && <Button size="sm" onClick={() => setAssignFor(ids)}><UserPlus className="size-3.5" />Assign</Button>}
            {can('leads.update') && (
              <DropdownMenu>
                <DropdownTrigger asChild><Button size="sm">Status<ChevronDown className="size-3" /></Button></DropdownTrigger>
                <DropdownContent align="start">{LEAD_STATUSES.filter((s) => s.value !== 'CONVERTED').map((s) => <DropdownItem key={s.value} onSelect={() => (s.value === 'LOST' ? setLostFor(ids) : bulk.mutate({ ids, action: 'status', status: s.value }))}>{s.label}</DropdownItem>)}</DropdownContent>
              </DropdownMenu>
            )}
            {can('leads.update') && (
              <DropdownMenu>
                <DropdownTrigger asChild><Button size="sm"><Flag className="size-3.5" />Priority</Button></DropdownTrigger>
                <DropdownContent align="start">{priorities.data?.map((p) => <DropdownItem key={p.id} onSelect={() => bulk.mutate({ ids, action: 'priority', priorityId: p.id })}>{p.name}</DropdownItem>)}</DropdownContent>
              </DropdownMenu>
            )}
            {can('leads.update') && (
              <DropdownMenu>
                <DropdownTrigger asChild><Button size="sm"><Tags className="size-3.5" />Tag</Button></DropdownTrigger>
                <DropdownContent align="start">{tags.data?.length ? tags.data.map((t) => <DropdownItem key={t.id} onSelect={() => bulk.mutate({ ids, action: 'tag', tagId: t.id })}><TagChip tag={t} /></DropdownItem>) : <p className="px-2 py-1.5 text-xs text-ink-3">No tags yet</p>}</DropdownContent>
              </DropdownMenu>
            )}
            {can('leads.export') && has('import_export') && <Button size="sm" onClick={() => exportLeads('csv', ids)}><Download className="size-3.5" />Export selected</Button>}
            {can('leads.archive') && (f.archived === 'true' ? <Button size="sm" onClick={() => restore.mutate(ids)}><RotateCcw className="size-3.5" />Restore</Button> : <Button size="sm" variant="dangerGhost" onClick={() => doArchive(ids)}><Archive className="size-3.5" />Archive</Button>)}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        <DataTable columns={columns} rows={rows} loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} onRowClick={(l) => router.push(`/leads/${l.id}`)} sort={{ key: f.sort, order: f.order as 'asc' | 'desc' }} onSort={toggleSort}
          selection={can('leads.update') || can('leads.assign') || can('leads.archive') ? { selected, onChange: setSelected, renderCheckbox: (checked, onChange, label, indeterminate) => <Checkbox checked={checked} onCheckedChange={onChange} aria-label={label} indeterminate={indeterminate} /> } : undefined}
          empty={<EmptyState icon={<Target />} title={f.q || activeFilters ? 'No leads match these filters' : 'No leads yet'} description={f.q || activeFilters ? 'Try removing a filter or searching for something else.' : 'Add your first lead, or import a spreadsheet to get started.'}
            action={f.q || activeFilters ? <Button onClick={() => { setSearch(''); router.replace('/leads'); }}>Clear filters</Button> : can('leads.create') ? <div className="flex gap-2"><Button variant="primary" onClick={() => setFormOpen(true)}><Plus className="size-3.5" />Add lead</Button>{can('leads.import') && <Button onClick={() => setImportOpen(true)}><Upload className="size-3.5" />Import</Button>}</div> : undefined} />} />
        {total > 0 && <Pagination page={Number(f.page)} pageSize={Number(f.pageSize)} total={total} noun="leads" onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(n) => setF({ pageSize: String(n) })} />}
      </Card>

      <LeadFormSheet open={formOpen || !!editLead} onOpenChange={(o) => { if (!o) { setFormOpen(false); setEditLead(null); } }} lead={editLead} onSaved={(id) => { if (!editLead) router.push(`/leads/${id}`); }} />
      <LeadImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <DuplicatesDialog open={dupOpen} onOpenChange={setDupOpen} />
      <AssignDialog open={!!assignFor} onOpenChange={(o) => !o && setAssignFor(null)} title={`Assign ${assignFor?.length ?? 0} lead${assignFor?.length === 1 ? '' : 's'}`} loading={bulk.isPending} onConfirm={(userId) => bulk.mutate({ ids: assignFor, action: 'assign', assignedToId: userId })} />
      <LostReasonDialog open={!!lostFor} onOpenChange={(o) => !o && setLostFor(null)} loading={bulk.isPending} title={`Mark ${lostFor?.length ?? 0} lead(s) as lost`} onConfirm={(reasonId) => bulk.mutate({ ids: lostFor, action: 'status', status: 'LOST', lostReasonId: reasonId })} />
      <ScheduleFollowUpDialog open={!!followUpFor} onOpenChange={(o) => !o && setFollowUpFor(null)} lead={followUpFor} />
      {logFor && <LogActivityDialog open onOpenChange={(o) => !o && setLogFor(null)} leadId={logFor.id} leadName={logFor.name} />}
    </>
  );
}
void timeAgo;
export default function LeadsPage() { return <React.Suspense><LeadsPageInner /></React.Suspense>; }
