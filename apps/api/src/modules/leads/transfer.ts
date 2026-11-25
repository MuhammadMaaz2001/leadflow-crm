import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { fullName, normalizeEmail, normalizePhone } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { AppError, badRequest, paymentRequired } from '../../lib/errors';
import { uuid } from '../../lib/crypto';
import type { Ctx } from '../../http';
import { logActivity } from '../activities/service';
import { assertLeadCapacity } from '../subscriptions/service';
import { emitTrigger } from '../automations/events';
import { pickAssignee, validateCustomFields } from './service';
import { assertSpreadsheet } from '../../lib/upload';
import { buildLeadWhere, leadFilterQuery, leadInclude, planSearch, shapeLeads } from './queries';

export const MAX_IMPORT_ROWS = 5000;
export const MAX_EXPORT_ROWS = 20000;

export const HEADER_ALIASES: Record<string, string> = {
  firstname: 'firstName', first: 'firstName', givenname: 'firstName', lastname: 'lastName', last: 'lastName', surname: 'lastName', familyname: 'lastName',
  name: 'fullName', fullname: 'fullName', email: 'email', emailaddress: 'email', mail: 'email', phone: 'phone', phonenumber: 'phone', mobile: 'phone', telephone: 'phone', tel: 'phone',
  company: 'companyName', companyname: 'companyName', organization: 'companyName', organisation: 'companyName', jobtitle: 'jobTitle', title: 'jobTitle', position: 'jobTitle',
  source: 'source', leadsource: 'source', campaign: 'campaign', priority: 'priority', tags: 'tags', tag: 'tags', description: 'description', notes: 'description',
  assignedto: 'assignedTo', owner: 'assignedTo', assigneeemail: 'assignedTo', salesperson: 'assignedTo',
};
export const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ParsedRow { rowNumber: number; values: Record<string, string> }

export async function parseUpload(file: { originalname: string; buffer: Buffer }): Promise<{ headers: string[]; rows: ParsedRow[] }> {
  const kind = assertSpreadsheet(file);
  let table: string[][] = [];
  if (kind === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets');
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c).value;
        vals.push(cell == null ? '' : typeof cell === 'object' ? ('text' in cell ? String((cell as { text: unknown }).text) : 'result' in cell ? String((cell as { result: unknown }).result ?? '') : cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell)) : String(cell));
      }
      table.push(vals);
    });
  } else {
    const parsed = Papa.parse<string[]>(file.buffer.toString('utf8').replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' });
    table = parsed.data as string[][];
  }
  if (table.length < 2) throw badRequest('The file needs a header row and at least one data row.', undefined, 'EMPTY_FILE');
  if ((table[0]?.length ?? 0) > 100) throw badRequest('Too many columns (limit 100).', undefined, 'TOO_MANY_COLUMNS');
  const headers = table[0]!.map((h) => String(h ?? '').trim());
  const rows = table.slice(1).map((r, i) => ({ rowNumber: i + 2, values: Object.fromEntries(headers.map((h, ci) => [h, String(r[ci] ?? '').trim()])) }));
  return { headers, rows };
}

export interface ImportRowError { row: number; field?: string; message: string; data?: Record<string, string> }
export interface ImportResult {
  dryRun: boolean; total: number; valid: number; created: number; skippedDuplicates: number; failed: number;
  errors: ImportRowError[]; duplicates: ImportRowError[]; mapping: Record<string, string>; unmappedHeaders: string[]; notes: string[];
}

export const importOptions = z.object({
  dryRun: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  duplicates: z.enum(['skip', 'import']).default('skip'),
});

export async function importLeads(ctx: Ctx, file: { originalname: string; buffer: Buffer }, opts: z.infer<typeof importOptions>): Promise<ImportResult> {
  const { headers, rows } = await parseUpload(file);
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Imports are limited to ${MAX_IMPORT_ROWS} rows per file (found ${rows.length}). Split the file and try again.`, undefined, 'TOO_MANY_ROWS');

  const [sources, priorities, tags, members, customDefs, existing] = await Promise.all([
    db().leadSource.findMany({ where: { organizationId: ctx.orgId } }),
    db().leadPriority.findMany({ where: { organizationId: ctx.orgId } }),
    db().tag.findMany({ where: { organizationId: ctx.orgId } }),
    db().membership.findMany({ where: { organizationId: ctx.orgId, status: 'ACTIVE' }, include: { user: { select: { id: true, email: true } } } }),
    db().customFieldDef.findMany({ where: { organizationId: ctx.orgId, isActive: true } }),
    db().lead.findMany({ where: { organizationId: ctx.orgId, archivedAt: null, mergedIntoId: null }, select: { emailNormalized: true, phoneNormalized: true } }),
  ]);
  const mapping: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const h of headers) {
    const k = headerKey(h);
    const cf = customDefs.find((d) => headerKey(d.label) === k || headerKey(d.key) === k);
    if (HEADER_ALIASES[k]) mapping[h] = HEADER_ALIASES[k]!;
    else if (cf) mapping[h] = `custom:${cf.key}`;
    else if (h) unmapped.push(h);
  }
  const col = (r: ParsedRow, field: string) => {
    const h = Object.entries(mapping).find(([, f]) => f === field)?.[0];
    return h ? r.values[h] ?? '' : '';
  };
  const seenEmail = new Set(existing.map((e) => e.emailNormalized).filter(Boolean));
  const seenPhone = new Set(existing.map((e) => e.phoneNormalized).filter(Boolean));
  const errors: ImportRowError[] = [], duplicates: ImportRowError[] = [];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  type Ready = { id: string; row: ParsedRow; data: Record<string, unknown>; tagNames: string[]; assignedToId: string | null; sourceName?: string; custom: Record<string, unknown> };
  const ready: Ready[] = [];
  const newSources = new Map<string, string>();

  for (const r of rows) {
    const snapshot = r.values;
    let first = col(r, 'firstName'), last = col(r, 'lastName');
    const full = col(r, 'fullName');
    if (!first && full) { const parts = full.split(/\s+/); first = parts.shift() ?? ''; last = last || parts.join(' '); }
    const email = col(r, 'email'), phone = col(r, 'phone');
    const fail = (message: string, field?: string) => errors.push({ row: r.rowNumber, field, message, data: snapshot });
    if (!first) { fail('First name (or Name) is required', 'firstName'); continue; }
    if (!email && !phone) { fail('Provide an email or a phone number', 'email'); continue; }
    if (email && !emailRe.test(email)) { fail(`Invalid email "${email}"`, 'email'); continue; }
    if (phone && !normalizePhone(phone)) { fail(`Invalid phone "${phone}"`, 'phone'); continue; }
    const en = normalizeEmail(email), pn = normalizePhone(phone);
    if ((en && seenEmail.has(en)) || (pn && seenPhone.has(pn))) {
      if (opts.duplicates === 'skip') { duplicates.push({ row: r.rowNumber, message: 'Duplicate email or phone — skipped', data: snapshot }); continue; }
    }
    let priorityId: string | null = null;
    const prName = col(r, 'priority');
    if (prName) {
      const p = priorities.find((x) => x.name.toLowerCase() === prName.toLowerCase());
      if (!p) { fail(`Unknown priority "${prName}" (use ${priorities.map((x) => x.name).join(', ')})`, 'priority'); continue; }
      priorityId = p.id;
    }
    let assignedToId: string | null = null;
    const asg = col(r, 'assignedTo');
    if (asg) {
      const m = members.find((x) => x.user.email.toLowerCase() === asg.toLowerCase());
      if (!m) { fail(`Assignee "${asg}" is not an active member`, 'assignedTo'); continue; }
      assignedToId = m.userId;
    }
    const custom: Record<string, unknown> = {};
    for (const [h, f] of Object.entries(mapping)) if (f.startsWith('custom:')) custom[f.slice(7)] = r.values[h];
    let cleanCustom: Record<string, unknown> = {};
    try { cleanCustom = await validateCustomFields(ctx, custom, false, customDefs); } catch (e) { fail((e as AppError).message + ': ' + JSON.stringify((e as AppError).details && ((e as AppError).details as { fields: unknown }).fields), 'customFields'); continue; }
    const srcName = col(r, 'source');
    let sourceId = srcName ? sources.find((s) => s.name.toLowerCase() === srcName.toLowerCase())?.id ?? null : null;
    if (srcName && !sourceId) { sourceId = newSources.get(srcName.toLowerCase()) ?? null; if (!sourceId) { sourceId = uuid(); newSources.set(srcName.toLowerCase(), sourceId); } }
    if (en) seenEmail.add(en);
    if (pn) seenPhone.add(pn);
    ready.push({
      id: uuid(), row: r, assignedToId, sourceName: srcName || undefined, custom: cleanCustom,
      tagNames: col(r, 'tags').split(/[;,|]/).map((t) => t.trim()).filter(Boolean),
      data: { firstName: first, lastName: last || null, email: email || null, emailNormalized: en, phone: phone || null, phoneNormalized: pn, companyName: col(r, 'companyName') || null, jobTitle: col(r, 'jobTitle') || null, sourceId, campaign: col(r, 'campaign') || null, priorityId, description: col(r, 'description') || null },
    });
  }

  const result: ImportResult = { dryRun: opts.dryRun, total: rows.length, valid: ready.length, created: 0, skippedDuplicates: duplicates.length, failed: errors.length, errors, duplicates, mapping, unmappedHeaders: unmapped, notes: [] };
  if (opts.dryRun || !ready.length) return result;

  // plan limits are enforced server side before anything is written
  const used = await db().lead.count({ where: { organizationId: ctx.orgId, archivedAt: null, mergedIntoId: null } });
  if (used + ready.length > ctx.plan.maxLeads) {
    throw paymentRequired(`This import adds ${ready.length} leads but your ${ctx.plan.name} plan has room for ${Math.max(0, ctx.plan.maxLeads - used)} more (limit ${ctx.plan.maxLeads}). Upgrade or import fewer rows.`, 'LEAD_LIMIT_REACHED');
  }
  await assertLeadCapacity(ctx, ready.length);

  for (const [lower, id] of newSources) {
    const display = ready.find((r) => r.sourceName?.toLowerCase() === lower)?.sourceName ?? lower;
    await db().leadSource.create({ data: { id, organizationId: ctx.orgId, name: display, position: sources.length + 1 } });
  }
  const tagMap = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  for (const r of ready) for (const tn of r.tagNames) {
    if (!tagMap.has(tn.toLowerCase())) { const t = await db().tag.create({ data: { organizationId: ctx.orgId, name: tn } }); tagMap.set(tn.toLowerCase(), t.id); }
  }
  const warm = priorities.find((p) => p.name === 'Warm')?.id ?? null;
  const now = new Date();
  for (const r of ready) {
    if (!r.assignedToId) {
      const pick = await pickAssignee(ctx, r.data as { sourceId?: string | null; priorityId?: string | null; campaign?: string | null; companyName?: string | null });
      if (pick) r.assignedToId = pick.userId;
    }
  }
  await db().lead.createMany({
    data: ready.map((r) => ({ ...(r.data as object), id: r.id, organizationId: ctx.orgId, priorityId: (r.data.priorityId as string | null) ?? warm, customFields: r.custom as object, createdById: ctx.userId, assignedToId: r.assignedToId, assignedAt: r.assignedToId ? now : null })) as never,
  });
  await db().leadTag.createMany({ data: ready.flatMap((r) => [...new Set(r.tagNames.map((t) => tagMap.get(t.toLowerCase())!))].map((tagId) => ({ organizationId: ctx.orgId, leadId: r.id, tagId }))), skipDuplicates: true });
  await db().leadAssignment.createMany({ data: ready.filter((r) => r.assignedToId).map((r) => ({ organizationId: ctx.orgId, leadId: r.id, toUserId: r.assignedToId, assignedById: ctx.userId, method: 'IMPORT' })) });
  await db().activity.createMany({
    data: ready.map((r) => ({ organizationId: ctx.orgId, leadId: r.id, type: 'LEAD_CREATED' as const, actorId: ctx.userId, title: 'Lead created (import)', metadata: { import: file.originalname, row: r.row.rowNumber } })),
  });
  // automations fire for the first 200 imported leads only (a bulk import must not flood people with notifications); the result says so
  for (const r of ready.slice(0, 200)) await emitTrigger('LEAD_CREATED', { type: 'lead', id: r.id, leadId: r.id });
  if (ready.length > 200) result.notes.push(`Automations for “new lead” ran for the first 200 of ${ready.length} imported leads.`);
  await logActivity({ type: 'NOTE', title: `Imported ${ready.length} leads from ${file.originalname}`, leadId: null, metadata: { imported: ready.length, skipped: duplicates.length, failed: errors.length } });
  result.created = ready.length;
  return result;
}

export const exportQuery = leadFilterQuery.extend({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  ids: z.preprocess((v) => (typeof v === 'string' && v ? v.split(',') : v), z.array(z.string().uuid()).optional()),
});

export async function exportLeads(ctx: Ctx, q: z.infer<typeof exportQuery>) {
  const where = buildLeadWhere(ctx, q, await planSearch(ctx.orgId, q.q));
  if (q.ids?.length) (where.AND as unknown[]).push({ id: { in: q.ids } });
  const rows = await db().lead.findMany({ where, include: leadInclude, orderBy: { createdAt: 'desc' }, take: MAX_EXPORT_ROWS + 1 });
  if (rows.length > MAX_EXPORT_ROWS) throw new AppError(422, 'EXPORT_TOO_LARGE', `This export has more than ${MAX_EXPORT_ROWS.toLocaleString()} leads. Narrow the filters (for example by date or status) and export in parts.`);
  const fields = await db().customFieldDef.findMany({ where: { organizationId: ctx.orgId, isActive: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  const shaped = await shapeLeads(ctx, rows);
  const header = ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Job Title', 'Source', 'Campaign', 'Priority', 'Status', 'Assigned To', 'Assigned To Email', 'Tags', 'Created At', 'Created By', 'Last Activity', 'Next Follow-up', 'Description', ...fields.map((f) => f.label)];
  const data = shaped.map((l) => [l.firstName, l.lastName ?? '', l.email ?? '', l.phone ?? '', l.companyName ?? '', l.jobTitle ?? '', l.source?.name ?? '', l.campaign ?? '', l.priority?.name ?? '', l.status, l.assignedTo?.name ?? '', l.assignedTo?.email ?? '', l.tags.map((t) => t.name).join('; '), l.createdAt.toISOString(), l.createdBy?.name ?? '', l.lastActivityAt.toISOString(), l.nextFollowUpAt?.toISOString() ?? '', l.description ?? '', ...fields.map((f) => { const v = ((l as unknown as { customFields?: Record<string, unknown> }).customFields ?? {})[f.key]; return v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v); })]);
  return tabular('leads', header, data, q.format);
}

export async function tabular(basename: string, header: string[], data: Array<Array<string | number | null>>, format: 'csv' | 'xlsx', sheet = 'Data') {
  const { FileReply } = await import('../../http');
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.addRow(header);
    ws.getRow(1).font = { bold: true };
    data.forEach((r) => ws.addRow(r));
    ws.columns.forEach((c, i) => { c.width = Math.min(40, Math.max(header[i]!.length + 2, 14)); });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return new FileReply(`${basename}-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf);
  }
  // Neutralise spreadsheet formula injection in exported cells.
  const safe = data.map((r) => r.map((c) => (typeof c === 'string' && /^[=+\-@\t\r]/.test(c) ? `'${c}` : c)));
  return new FileReply(`${basename}-${stamp}.csv`, 'text/csv; charset=utf-8', Buffer.from('﻿' + Papa.unparse({ fields: header, data: safe })));
}
export { fullName };
