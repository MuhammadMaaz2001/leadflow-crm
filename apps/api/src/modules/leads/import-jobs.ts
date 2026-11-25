import { randomUUID } from 'node:crypto';
import { Readable, type Duplex } from 'node:stream';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { normalizeEmail, normalizePhone } from '@leadflow/shared';
import type { Prisma } from '@leadflow/database';
import { config } from '../../config';
import { afterCommit, db, withContext } from '../../db';
import { AppError, badRequest, notFound, paymentRequired } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { withLock } from '../../lib/lock';
import { log } from '../../lib/logger';
import { enqueue } from '../../lib/queue';
import { getPrivateStorage, type ObjectStorage } from '../../lib/storage';
import { assertSpreadsheet } from '../../lib/upload';
import type { Ctx } from '../../http';
import { emitTrigger } from '../automations/events';
import { notify } from '../notifications/service';
import { importBatchDuration, importRows } from '../../lib/metrics';
import { pickAssignee, validateCustomFields } from './service';
import { HEADER_ALIASES, headerKey } from './transfer';
import { lite, usersById } from '../../lib/users';

/**
 * BACKGROUND LEAD IMPORT — architecture and guarantees
 *
 *  upload  → the file is validated by content, stored in the PRIVATE object store (never in PostgreSQL), analysed (headers, column
 *            mapping, row count, a sample of validated rows) and an `import_jobs` row is created in state PREVIEW. Nothing is imported yet.
 *  start   → PREVIEW → QUEUED, a BullMQ job `import.process` is enqueued (idempotent job id).
 *  process → the worker STREAMS the file (never materialising all rows) and commits it in batches of IMPORT_BATCH_SIZE rows. Each batch is
 *            ONE database transaction that creates the valid leads AND advances the checkpoint (`last_row`) and the counters together, so a
 *            crash, a retry or a stalled-job re-run resumes after the last committed batch and can never create a lead twice.
 *
 *  PARTIAL-SUCCESS POLICY (documented, visible in the UI): rows are validated individually. Valid rows are imported; invalid rows and
 *  duplicates are NOT imported and are listed with their row number and reason (downloadable as CSV). Committed batches are never rolled
 *  back by a later failure or cancellation — the job result states exactly how many leads were created. The synchronous legacy endpoint
 *  (POST /leads/import) remains all-or-nothing per request.
 *
 *  Plan limits are enforced per batch; when the lead limit is reached the job stops (stop_reason PLAN_LIMIT) and the rest is reported as skipped.
 *  Concurrency: at most IMPORT_MAX_ACTIVE_PER_ORG active jobs per workspace and IMPORT_MAX_CONCURRENT running jobs cluster-wide (Redis slots).
 */

const PREVIEW_ROWS = 10;
/** Test seam only: lets tests inject a crash / cancellation between two committed batches. Never set in production code. */
export const importHooks: { afterBatch?: (jobId: string, batchNo: number) => Promise<void> } = {};
const nowDate = () => new Date();
type Format = 'csv' | 'xlsx';
export interface SourceRow { n: number; cells: string[] }
export interface ParsedRow { rowNumber: number; values: Record<string, string> }

// ───────────────────────────── streaming readers ─────────────────────────────
function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('text' in o) return String(o.text ?? '');
    if ('result' in o) return String(o.result ?? '');
    if ('richText' in o && Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join('');
    if ('hyperlink' in o) return String(o.hyperlink ?? '');
    return '';
  }
  return String(v).trim();
}

/** Yields the NON-EMPTY rows of a CSV / first worksheet as they are parsed (row 1 is the header). Destroys the source on early exit. */
export async function* streamRows(source: Readable, format: Format): AsyncGenerator<SourceRow> {
  let n = 0;
  try {
    if (format === 'csv') {
      const parser = Papa.parse(Papa.NODE_STREAM_INPUT as never, { skipEmptyLines: 'greedy' } as never) as unknown as Duplex;
      source.on('error', (e) => parser.destroy(e));
      source.pipe(parser);
      try {
        for await (const row of parser as AsyncIterable<unknown[]>) {
          n++;
          const cells = row.map((c) => String(c ?? '').trim());
          if (n === 1 && cells[0]) cells[0] = cells[0].replace(/^\uFEFF/, '');
          yield { n, cells };
        }
      } finally { parser.destroy(); }
    } else {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(source as never, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit' } as never);
      for await (const ws of reader as unknown as AsyncIterable<AsyncIterable<{ values: unknown[] }>>) {
        for await (const row of ws) {
          const cells = (row.values as unknown[]).slice(1).map(cellText);
          if (cells.every((c) => !c)) continue;
          n++;
          yield { n, cells };
        }
        break;                                                  // only the first worksheet is imported
      }
    }
  } finally { source.destroy(); }
}

async function openStream(storage: ObjectStorage, key: string): Promise<Readable | null> {
  if (storage.getStream) return storage.getStream(key);
  const o = await storage.get(key);
  return o ? Readable.from(o.body) : null;
}

// ───────────────────────────── mapping & validation ─────────────────────────────
type CustomDef = { id: string; key: string; label: string };
export function buildMapping(headers: string[], customDefs: CustomDef[]) {
  const mapping: Record<string, string> = {}; const unmapped: string[] = [];
  for (const h of headers) {
    const k = headerKey(h);
    const cf = customDefs.find((d) => headerKey(d.label) === k || headerKey(d.key) === k);
    if (HEADER_ALIASES[k]) mapping[h] = HEADER_ALIASES[k]!;
    else if (cf) mapping[h] = `custom:${cf.key}`;
    else if (h) unmapped.push(h);
  }
  return { mapping, unmapped };
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
interface Lookups {
  sources: Array<{ id: string; name: string }>; priorities: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string }>;
  members: Array<{ userId: string; user: { email: string } }>; customDefs: Array<{ id: string; key: string; label: string; type: string; isRequired?: boolean; options?: unknown; isActive?: boolean }>;
}
export interface ReadyRow { id: string; rowNumber: number; data: Record<string, unknown>; tagNames: string[]; assignedToId: string | null; sourceName?: string; custom: Record<string, unknown> }
export interface RowIssue { rowNumber: number; kind: 'ERROR' | 'DUPLICATE'; field?: string; message: string; data: Record<string, string> }

async function loadLookups(ctx: Ctx): Promise<Lookups> {
  const [sources, priorities, tags, members, customDefs] = await Promise.all([
    db().leadSource.findMany({ where: { organizationId: ctx.orgId } }), db().leadPriority.findMany({ where: { organizationId: ctx.orgId } }),
    db().tag.findMany({ where: { organizationId: ctx.orgId } }),
    db().membership.findMany({ where: { organizationId: ctx.orgId, status: 'ACTIVE' }, include: { user: { select: { id: true, email: true } } } }),
    db().customFieldDef.findMany({ where: { organizationId: ctx.orgId, isActive: true } }),
  ]);
  return { sources, priorities, tags, members, customDefs: customDefs as Lookups['customDefs'] };
}

/** Existing (non-archived, non-merged) leads that share an email or phone with any of the candidates — an indexed lookup, never a full scan. */
async function existingKeys(orgId: string, emails: string[], phones: string[]) {
  if (!emails.length && !phones.length) return { emails: new Set<string>(), phones: new Set<string>() };
  const rows = await db().lead.findMany({
    where: { organizationId: orgId, archivedAt: null, mergedIntoId: null, OR: [...(emails.length ? [{ emailNormalized: { in: emails } }] : []), ...(phones.length ? [{ phoneNormalized: { in: phones } }] : [])] },
    select: { emailNormalized: true, phoneNormalized: true },
  });
  return { emails: new Set(rows.map((r) => r.emailNormalized).filter((x): x is string => !!x)), phones: new Set(rows.map((r) => r.phoneNormalized).filter((x): x is string => !!x)) };
}

/** Validates one batch of rows with exactly the rules of the synchronous importer (required fields, formats, lookups, custom fields, duplicates). */
export async function prepareRows(ctx: Ctx, rows: ParsedRow[], mapping: Record<string, string>, lk: Lookups, duplicates: 'skip' | 'import') {
  const col = (r: ParsedRow, field: string) => { const h = Object.entries(mapping).find(([, f]) => f === field)?.[0]; return h ? r.values[h] ?? '' : ''; };
  const candidates = rows.map((r) => ({ en: normalizeEmail(col(r, 'email')), pn: normalizePhone(col(r, 'phone')) }));
  const existing = await existingKeys(ctx.orgId, candidates.map((c) => c.en).filter((x): x is string => !!x), candidates.map((c) => c.pn).filter((x): x is string => !!x));
  const seenEmail = new Set<string>(), seenPhone = new Set<string>();
  const ready: ReadyRow[] = [], issues: RowIssue[] = [];
  const newSources = new Map<string, string>();
  const warm = lk.priorities.find((p) => p.name === 'Warm')?.id ?? null;
  const trim = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.length > 300 ? `${x.slice(0, 300)}…` : x]));
  for (const [i, r] of rows.entries()) {
    const fail = (message: string, field?: string) => issues.push({ rowNumber: r.rowNumber, kind: 'ERROR', field, message, data: trim(r.values) });
    let first = col(r, 'firstName'), last = col(r, 'lastName');
    const full = col(r, 'fullName');
    if (!first && full) { const parts = full.split(/\s+/); first = parts.shift() ?? ''; last = last || parts.join(' '); }
    const email = col(r, 'email'), phone = col(r, 'phone');
    if (!first) { fail('First name (or Name) is required', 'firstName'); continue; }
    if (!email && !phone) { fail('Provide an email or a phone number', 'email'); continue; }
    if (email && !emailRe.test(email)) { fail(`Invalid email "${email}"`, 'email'); continue; }
    if (phone && !candidates[i]!.pn) { fail(`Invalid phone "${phone}"`, 'phone'); continue; }
    const { en, pn } = candidates[i]!;
    const dup = (en && (existing.emails.has(en) || seenEmail.has(en))) || (pn && (existing.phones.has(pn) || seenPhone.has(pn)));
    if (dup && duplicates === 'skip') { issues.push({ rowNumber: r.rowNumber, kind: 'DUPLICATE', message: 'Duplicate email or phone — skipped', data: trim(r.values) }); continue; }
    let priorityId: string | null = null;
    const prName = col(r, 'priority');
    if (prName) {
      const p = lk.priorities.find((x) => x.name.toLowerCase() === prName.toLowerCase());
      if (!p) { fail(`Unknown priority "${prName}" (use ${lk.priorities.map((x) => x.name).join(', ')})`, 'priority'); continue; }
      priorityId = p.id;
    }
    let assignedToId: string | null = null;
    const asg = col(r, 'assignedTo');
    if (asg) {
      const m = lk.members.find((x) => x.user.email.toLowerCase() === asg.toLowerCase());
      if (!m) { fail(`Assignee "${asg}" is not an active member`, 'assignedTo'); continue; }
      assignedToId = m.userId;
    }
    const custom: Record<string, unknown> = {};
    for (const [h, f] of Object.entries(mapping)) if (f.startsWith('custom:')) custom[f.slice(7)] = r.values[h];
    let cleanCustom: Record<string, unknown> = {};
    try { cleanCustom = await validateCustomFields(ctx, custom, false, lk.customDefs as never); } catch (e) {
      const fields = ((e as AppError).details as { fields?: Record<string, string> } | undefined)?.fields;
      fail(`${(e as AppError).message}${fields ? `: ${Object.entries(fields).map(([k, v]) => `${k} — ${v}`).join('; ')}` : ''}`, 'customFields'); continue;
    }
    const srcName = col(r, 'source');
    let sourceId = srcName ? lk.sources.find((s) => s.name.toLowerCase() === srcName.toLowerCase())?.id ?? null : null;
    if (srcName && !sourceId) { sourceId = newSources.get(srcName.toLowerCase()) ?? null; if (!sourceId) { sourceId = randomUUID(); newSources.set(srcName.toLowerCase(), sourceId); } }
    if (en) seenEmail.add(en);
    if (pn) seenPhone.add(pn);
    ready.push({
      id: randomUUID(), rowNumber: r.rowNumber, assignedToId, sourceName: srcName || undefined, custom: cleanCustom,
      tagNames: col(r, 'tags').split(/[;,|]/).map((t) => t.trim()).filter(Boolean),
      data: { firstName: first, lastName: last || null, email: email || null, emailNormalized: en, phone: phone || null, phoneNormalized: pn, companyName: col(r, 'companyName') || null, jobTitle: col(r, 'jobTitle') || null, sourceId, campaign: col(r, 'campaign') || null, description: col(r, 'description') || null, priorityId: priorityId ?? warm },
    });
  }
  return { ready, issues, newSources };
}

const toRow = (headers: string[], s: SourceRow): ParsedRow => ({ rowNumber: s.n, values: Object.fromEntries(headers.map((h, ci) => [h, s.cells[ci] ?? ''])) });

// ───────────────────────────── public shapes ─────────────────────────────
type JobRow = Prisma.ImportJobGetPayload<Record<string, never>>;
export const ACTIVE = ['QUEUED', 'RUNNING'];
export function publicJob(j: JobRow, creator?: { id: string; name: string } | null, detail = false) {
  const total = j.totalRows ?? null;
  const terminal = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(j.status);
  return {
    id: j.id, status: j.status, fileName: j.fileName, fileFormat: j.fileFormat, fileSize: Number(j.fileSize), totalRows: total, processedRows: j.processedRows,
    createdRows: j.createdRows, failedRows: j.failedRows, skippedRows: j.skippedRows, progress: terminal && j.status === 'COMPLETED' ? 100 : total ? Math.min(99, Math.floor((j.processedRows / Math.max(1, total)) * 100)) : 0,
    stopReason: j.stopReason, error: j.error, cancelRequested: j.cancelRequested, duplicates: (j.options as { duplicates?: string }).duplicates ?? 'skip',
    createdAt: j.createdAt, queuedAt: j.queuedAt, startedAt: j.startedAt, finishedAt: j.finishedAt, createdBy: creator ?? null,
    canStart: j.status === 'PREVIEW', canCancel: ['PREVIEW', 'QUEUED', 'RUNNING'].includes(j.status) && !j.cancelRequested, hasErrorReport: j.failedRows > 0 || j.skippedRows > 0,
    ...(detail ? { mapping: j.mapping, unmappedHeaders: j.unmappedHeaders, preview: j.status === 'PREVIEW' ? j.preview : null, automationsFired: j.automationsFired } : {}),
  };
}

const visible = (ctx: Ctx): Prisma.ImportJobWhereInput => ({ organizationId: ctx.orgId, ...(ctx.can('leads.view_all') ? {} : { createdById: ctx.userId }) });
export async function getJobOr404(ctx: Ctx, id: string) {
  const j = await db().importJob.findFirst({ where: { id, ...visible(ctx) } });
  if (!j) throw notFound('Import');
  return j;
}
export async function listJobs(ctx: Ctx, limit = 30) {
  const rows = await db().importJob.findMany({ where: visible(ctx), orderBy: { createdAt: 'desc' }, take: limit });
  const u = await usersById(rows.map((r) => r.createdById));
  return rows.map((r) => publicJob(r, lite(u, r.createdById)));
}

// ───────────────────────────── upload + preview ─────────────────────────────
export async function createImportJob(ctx: Ctx, file: { originalname: string; buffer: Buffer }) {
  const format = assertSpreadsheet(file) as Format;
  const storage = getPrivateStorage();
  if (!storage) throw new AppError(503, 'FEATURE_UNAVAILABLE', 'Imports need object storage (STORAGE_PROVIDER=s3) in production. Ask your administrator.');
  const open = await db().importJob.count({ where: { organizationId: ctx.orgId, status: 'PREVIEW' } });
  if (open >= 10) throw new AppError(429, 'TOO_MANY_PENDING_IMPORTS', 'You have several uploaded files waiting to be started. Start or cancel them first.');
  // analyse BEFORE storing: header, mapping, row count (bounded), sample rows — streaming, never the whole file as objects
  let headers: string[] = []; const sample: ParsedRow[] = []; let total = 0;
  const tooMany = () => badRequest(`This file has more than ${config.importMaxRows.toLocaleString()} rows (the limit per import). Split it and import the parts.`, { limit: config.importMaxRows }, 'TOO_MANY_ROWS');
  if (format === 'csv') {
    // fast path: Papa's synchronous `step` mode counts ~10x faster than the object stream and still never builds the full row array
    let n = 0; let tooLong = false;
    Papa.parse(file.buffer.toString('utf8').replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy', step: (res, parser) => {
      n++;
      const cells = (res.data as unknown as unknown[]).map((c) => String(c ?? '').trim());
      if (n === 1) { headers = cells; if (headers.length > 100) { tooLong = true; parser.abort(); } return; }
      total++;
      if (total > config.importMaxRows) { parser.abort(); return; }
      if (sample.length < PREVIEW_ROWS) sample.push(toRow(headers, { n, cells }));
    } });
    if (tooLong) throw badRequest('Too many columns (limit 100).', undefined, 'TOO_MANY_COLUMNS');
    if (total > config.importMaxRows) throw tooMany();
  } else {
    for await (const r of streamRows(Readable.from(file.buffer), format)) {
      if (r.n === 1) { headers = r.cells.map((h) => h.trim()); if (headers.length > 100) throw badRequest('Too many columns (limit 100).', undefined, 'TOO_MANY_COLUMNS'); continue; }
      total++;
      if (total > config.importMaxRows) throw tooMany();
      if (sample.length < PREVIEW_ROWS) sample.push(toRow(headers, r));
    }
  }
  if (!headers.length || total < 1) throw badRequest('The file needs a header row and at least one data row.', undefined, 'EMPTY_FILE');
  const lk = await loadLookups(ctx);
  const { mapping, unmapped } = buildMapping(headers, lk.customDefs);
  const fields = new Set(Object.values(mapping));
  if (!fields.has('firstName') && !fields.has('fullName')) throw badRequest('No name column found. Add a "First Name" (or "Name") column — see the template.', { headers }, 'MISSING_NAME_COLUMN');
  if (!fields.has('email') && !fields.has('phone')) throw badRequest('No contact column found. Add an "Email" and/or "Phone" column — see the template.', { headers }, 'MISSING_CONTACT_COLUMN');
  const prepared = await prepareRows(ctx, sample, mapping, lk, 'skip');
  const bad = new Map(prepared.issues.map((i) => [i.rowNumber, i]));
  const id = randomUUID();
  const key = `imports/${ctx.orgId}/${id}.${format}`;
  try { await storage.put(key, file.buffer, format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
  catch (e) { log.error('import file upload failed', { error: (e as Error).message }); throw new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Nothing was saved; please try again.'); }
  try {
    const job = await db().importJob.create({ data: {
      id, organizationId: ctx.orgId, createdById: ctx.userId, fileName: file.originalname.replace(/[\\/]/g, '_').slice(0, 200), fileKey: key, fileSize: BigInt(file.buffer.length), fileFormat: format,
      headers, mapping, unmappedHeaders: unmapped, totalRows: total,
      preview: sample.map((r) => ({ row: r.rowNumber, values: r.values, status: bad.get(r.rowNumber)?.kind ?? 'OK', message: bad.get(r.rowNumber)?.message ?? null })) as unknown as Prisma.InputJsonValue,
    } });
    return publicJob(job, { id: ctx.userId, name: ctx.user.name }, true);
  } catch (e) { await storage.delete(key).catch(() => undefined); throw e; }
}

// ───────────────────────────── start / cancel ─────────────────────────────
export async function startImportJob(ctx: Ctx, id: string, opts: { duplicates: 'skip' | 'import' }) {
  await db().$queryRaw`SELECT id FROM import_jobs WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`;   // double-click / retry safe
  const j = await getJobOr404(ctx, id);
  if (j.status !== 'PREVIEW') return publicJob(j, null, true);                                  // already started: idempotent
  const active = await db().importJob.count({ where: { organizationId: ctx.orgId, status: { in: ACTIVE } } });
  if (active >= config.importMaxActivePerOrg) throw new AppError(409, 'IMPORT_IN_PROGRESS', 'Another import is still running for this workspace. Wait for it to finish (or cancel it) and start this one again.');
  const used = await db().lead.count({ where: { organizationId: ctx.orgId, archivedAt: null, mergedIntoId: null } });
  if (used >= ctx.plan.maxLeads) throw paymentRequired(`Your ${ctx.plan.name} plan allows ${ctx.plan.maxLeads.toLocaleString()} leads and you are at the limit. Upgrade to import more.`, 'LEAD_LIMIT_REACHED');
  const u = await db().importJob.update({ where: { id }, data: { status: 'QUEUED', options: { duplicates: opts.duplicates }, queuedAt: nowDate() } });
  afterCommit(async () => { await dispatch(u.organizationId, u.id, u.requeues); });
  return publicJob(u, null, true);
}

async function dispatch(orgId: string, jobId: string, requeues: number, delay?: number) {
  try { await enqueue('import.process', { orgId, jobId }, { jobId: `import-${jobId}-r${requeues}`, delay }); }
  catch (e) { log.error('could not enqueue import', { jobId, error: (e as Error).message }); }
}

export async function cancelImportJob(ctx: Ctx, id: string) {
  await db().$queryRaw`SELECT id FROM import_jobs WHERE id = ${id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`;
  const j = await getJobOr404(ctx, id);
  if (!['PREVIEW', 'QUEUED', 'RUNNING'].includes(j.status)) throw new AppError(409, 'NOT_CANCELABLE', `This import is already ${j.status.toLowerCase()}.`);
  if (j.status === 'RUNNING') {
    const u = await db().importJob.update({ where: { id }, data: { cancelRequested: true } });
    await audit(ctx, 'lead.import_cancel_requested', 'import', id);
    return publicJob(u);
  }
  const u = await db().importJob.update({ where: { id }, data: { status: 'CANCELED', finishedAt: nowDate() } });
  await audit(ctx, 'lead.import_canceled', 'import', id);
  afterCommit(async () => { await deleteFile(u.organizationId, u.id); });
  return publicJob(u);
}

async function deleteFile(orgId: string, jobId: string) {
  const st = getPrivateStorage();
  try {
    await withContext({ orgId, userId: null }, async () => {
      const j = await db().importJob.findUnique({ where: { id: jobId } });
      if (!j?.fileKey || j.fileDeletedAt) return;
      if (st) await st.delete(j.fileKey);
      await db().importJob.update({ where: { id: jobId }, data: { fileDeletedAt: nowDate() } });
    });
  } catch (e) { log.warn('import file delete deferred to the sweeper', { jobId, error: (e as Error).message }); }
}

// ───────────────────────────── error report ─────────────────────────────
export async function errorReportCsv(ctx: Ctx, id: string) {
  const j = await getJobOr404(ctx, id);
  const rows = await db().importJobError.findMany({ where: { jobId: j.id, organizationId: ctx.orgId }, orderBy: [{ rowNumber: 'asc' }, { kind: 'asc' }], take: config.importErrorCap });
  const headers = (j.headers as string[] | null) ?? [];
  const safe = (c: string) => (/^[=+\-@\t\r]/.test(c) ? `'${c}` : c);
  const data = rows.map((r) => [String(r.rowNumber), r.kind === 'DUPLICATE' ? 'Duplicate (skipped)' : 'Error', r.field ?? '', r.message, ...headers.map((h) => safe(String(((r.data ?? {}) as Record<string, string>)[h] ?? '')))]);
  const { FileReply } = await import('../../http');
  const csv = Papa.unparse({ fields: ['Row', 'Type', 'Field', 'Problem', ...headers], data });
  return new FileReply(`import-${j.fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')}-errors.csv`, 'text/csv; charset=utf-8', Buffer.from(`\uFEFF${csv}`));
}

// ───────────────────────────── worker ─────────────────────────────
class Permanent extends Error {}

/** BullMQ processor. Safe to call any number of times for the same job: it resumes from the committed checkpoint. */
export async function processImportJob(orgId: string, jobId: string) {
  const job = await withContext({ orgId, userId: null }, () => db().importJob.findUnique({ where: { id: jobId } }));
  if (!job || !ACTIVE.includes(job.status)) return;                                              // canceled / finished / unknown: nothing to do
  const run = async () => {
    try { await runJob(orgId, jobId); }
    catch (e) {
      const permanent = e instanceof Permanent;
      const attempts = await withContext({ orgId, userId: null }, async () => (await db().importJob.update({ where: { id: jobId }, data: { attempts: { increment: 1 }, error: (e as Error).message.slice(0, 500) } })).attempts);
      if (permanent || attempts >= config.importMaxAttempts) { await finish(orgId, jobId, 'FAILED', (e as Error).message); return; }
      log.warn('import attempt failed; it will resume from the last committed batch', { jobId, attempts, error: (e as Error).message });
      throw e;                                                                                    // BullMQ retries with backoff
    }
  };
  if (config.jobsInline) { await run(); return; }
  // cluster-wide concurrency: IMPORT_MAX_CONCURRENT running imports, each holding a Redis lease for its whole run
  for (let slot = 0; slot < config.importMaxConcurrent; slot++) {
    const r = await withLock(`import:slot:${slot}`, 60_000, async () => { await run(); });
    if (r.ran) return;
  }
  const j = await withContext({ orgId, userId: null }, async () => db().importJob.update({ where: { id: jobId }, data: { requeues: { increment: 1 } } }));
  await dispatch(orgId, jobId, j.requeues, 15_000);                                              // all slots busy: try again shortly, stays QUEUED
}

async function runJob(orgId: string, jobId: string) {
  const st = getPrivateStorage();
  const job = await withContext({ orgId, userId: null }, async () => {
    await db().importJob.updateMany({ where: { id: jobId, startedAt: null }, data: { startedAt: nowDate() } });
    return db().importJob.update({ where: { id: jobId }, data: { status: 'RUNNING' } });
  });
  if (!st || !job.fileKey || job.fileDeletedAt) throw new Permanent('The uploaded file is no longer available. Upload it again.');
  const stream = await openStream(st, job.fileKey);
  if (!stream) throw new Permanent('The uploaded file could not be found in storage. Upload it again.');
  const headers = (job.headers as string[]) ?? [];
  const mapping = (job.mapping as Record<string, string>) ?? {};
  const duplicates = ((job.options as { duplicates?: 'skip' | 'import' }).duplicates) ?? 'skip';
  let batch: ParsedRow[] = [];
  let stopped: 'canceled' | 'limit' | null = null;
  let batchNo = 0;
  const flush = async () => {
    if (!batch.length) return true;
    const rows = batch; batch = [];
    const r = await commitBatch(orgId, job.id, job.createdById, rows, mapping, duplicates);
    await importHooks.afterBatch?.(job.id, ++batchNo);
    if (r !== 'continue') { stopped = r === 'canceled' ? 'canceled' : 'limit'; return false; }
    return true;
  };
  for await (const s of streamRows(stream, job.fileFormat as Format)) {
    if (s.n === 1) continue;                                                                       // header
    if (s.n <= job.lastRow) continue;                                                              // already committed by an earlier attempt
    batch.push(toRow(headers, s));
    if (batch.length >= config.importBatchSize && !(await flush())) break;
  }
  if (!stopped) await flush();
  if (stopped === 'canceled') { await finish(orgId, jobId, 'CANCELED'); return; }
  await finish(orgId, jobId, 'COMPLETED', undefined, stopped === 'limit' ? 'PLAN_LIMIT' : undefined);
}

type BatchResult = 'continue' | 'canceled' | 'limit';
async function commitBatch(orgId: string, jobId: string, userId: string | null, rows: ParsedRow[], mapping: Record<string, string>, duplicates: 'skip' | 'import'): Promise<BatchResult> {
  const lastRow = rows[rows.length - 1]!.rowNumber;
  const t: Record<string, number> = {}; let t0 = Date.now(); const tStart = t0;
  const mark = (k: string) => { const n = Date.now(); t[k] = (t[k] ?? 0) + n - t0; t0 = n; };
  return withContext({ orgId, userId }, async () => {
    // the job row is the lock: a stalled-job re-run or a second worker waits here and then sees the advanced checkpoint
    const [j] = await db().$queryRaw<Array<{ status: string; cancel_requested: boolean; last_row: number; automations_fired: number }>>`SELECT status, cancel_requested, last_row, automations_fired FROM import_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
    if (!j || j.status !== 'RUNNING') return 'canceled';
    if (j.cancel_requested) return 'canceled';
    if (j.last_row >= lastRow) return 'continue';
    const [org, sub, member] = await Promise.all([
      db().organization.findUniqueOrThrow({ where: { id: orgId } }),
      db().subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } }),
      userId ? db().membership.findFirst({ where: { organizationId: orgId, userId, status: 'ACTIVE' } }) : null,
    ]);
    if (org.status === 'SUSPENDED') throw new Permanent('This workspace is suspended.');
    if (!sub || sub.status === 'EXPIRED') throw new Permanent('The subscription has expired; imports are paused. Renew it and import again.');
    if (userId && !member) throw new Permanent('The person who started this import no longer has access to the workspace.');
    const ctx = { orgId, userId: userId ?? '', org: { autoAssignMode: org.autoAssignMode }, plan: { name: sub.plan.name, maxLeads: sub.plan.maxLeads } } as unknown as Ctx;
    mark('lock+ctx');
    const lk = await loadLookups(ctx);
    mark('lookups');
    const prepared = await prepareRows(ctx, rows, mapping, lk, duplicates);
    mark('validate');
    let ready = prepared.ready; const issues = [...prepared.issues];
    const used = await db().lead.count({ where: { organizationId: orgId, archivedAt: null, mergedIntoId: null } });
    const room = Math.max(0, sub.plan.maxLeads - used);
    let result: BatchResult = 'continue';
    if (ready.length > room) {
      for (const r of ready.slice(room)) issues.push({ rowNumber: r.rowNumber, kind: 'ERROR', message: `Plan limit reached (${sub.plan.maxLeads.toLocaleString()} leads) — row not imported`, data: {} });
      ready = ready.slice(0, room); result = 'limit';
    }
    const now = nowDate();
    if (ready.length) {
      const wanted = new Set(ready.map((r) => r.sourceName?.toLowerCase()).filter(Boolean));
      for (const [lower, id] of prepared.newSources) {
        if (!wanted.has(lower)) continue;
        const display = ready.find((r) => r.sourceName?.toLowerCase() === lower)?.sourceName ?? lower;
        await db().leadSource.create({ data: { id, organizationId: orgId, name: display, position: lk.sources.length + 1 } });
      }
      // rows whose source id was pre-allocated but dropped (limit) must not reference a source that was never created
      const tagMap = new Map(lk.tags.map((t) => [t.name.toLowerCase(), t.id]));
      for (const r of ready) for (const tn of r.tagNames) if (!tagMap.has(tn.toLowerCase())) { const t = await db().tag.create({ data: { organizationId: orgId, name: tn.slice(0, 50) } }); tagMap.set(tn.toLowerCase(), t.id); }
      mark('sources+tags');
      for (const r of ready) if (!r.assignedToId) { const pick = await pickAssignee(ctx, r.data as never); if (pick) r.assignedToId = pick.userId; }
      mark('assign');
      await db().lead.createMany({ data: ready.map((r) => ({ ...(r.data as object), id: r.id, organizationId: orgId, customFields: r.custom as object, createdById: userId, assignedToId: r.assignedToId, assignedAt: r.assignedToId ? now : null})) as never });
      mark('leads');
      await db().leadTag.createMany({ data: ready.flatMap((r) => [...new Set(r.tagNames.map((t) => tagMap.get(t.toLowerCase())!))].map((tagId) => ({ organizationId: orgId, leadId: r.id, tagId }))), skipDuplicates: true });
      mark('tags');
      await db().leadAssignment.createMany({ data: ready.filter((r) => r.assignedToId).map((r) => ({ organizationId: orgId, leadId: r.id, toUserId: r.assignedToId, assignedById: userId, method: 'IMPORT' })) });
      mark('assignments');
      await db().activity.createMany({ data: ready.map((r) => ({ organizationId: orgId, leadId: r.id, type: 'LEAD_CREATED' as const, actorId: userId, title: 'Lead created (import)', metadata: { importJob: jobId, row: r.rowNumber } })) });
    }
    mark('activities');
    let fired = j.automations_fired;
    for (const r of ready) { if (fired >= 200) break; await emitTrigger('LEAD_CREATED', { type: 'lead', id: r.id, leadId: r.id }); fired++; }   // a bulk import must not flood people with automations
    mark('automations');
    const stored = await db().importJobError.count({ where: { jobId } });
    const room2 = Math.max(0, config.importErrorCap - stored);
    if (issues.length && room2) {
      await db().importJobError.createMany({ data: issues.slice(0, room2).map((i) => ({ jobId, organizationId: orgId, rowNumber: i.rowNumber, kind: i.kind, field: i.field ?? null, message: i.message, data: i.data as Prisma.InputJsonValue })), skipDuplicates: true });
    }
    const errs = issues.filter((i) => i.kind === 'ERROR').length, dups = issues.filter((i) => i.kind === 'DUPLICATE').length;
    await db().importJob.update({ where: { id: jobId }, data: {
      processedRows: { increment: rows.length }, createdRows: { increment: ready.length }, failedRows: { increment: errs }, skippedRows: { increment: dups }, lastRow: lastRow, automationsFired: fired,
      ...(result === 'limit' ? { stopReason: 'PLAN_LIMIT' } : {}),
    } });
    mark('job-update');
    importRows.inc({ result: 'created' }, ready.length); importRows.inc({ result: 'failed' }, errs); importRows.inc({ result: 'skipped' }, dups);
    importBatchDuration.observe((Date.now() - tStart) / 1000);
    log.debug('import batch committed', { jobId, rows: rows.length, ms: t });
    return result;
  });
}

async function finish(orgId: string, jobId: string, status: 'COMPLETED' | 'FAILED' | 'CANCELED', error?: string, stopReason?: string) {
  const j = await withContext({ orgId, userId: null }, async () => {
    const cur = await db().importJob.findUnique({ where: { id: jobId } });
    if (!cur || ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(cur.status)) return cur;       // never finish twice
    // rows after a plan-limit stop are reported as skipped without storing each one
    const remaining = stopReason === 'PLAN_LIMIT' && cur.totalRows ? Math.max(0, cur.totalRows - cur.processedRows) : 0;
    return db().importJob.update({ where: { id: jobId }, data: { status, finishedAt: nowDate(), error: error?.slice(0, 500) ?? (status === 'FAILED' ? cur.error : null), stopReason: stopReason ?? cur.stopReason, skippedRows: { increment: remaining }, cancelRequested: false } });
  });
  if (!j) return;
  await deleteFile(orgId, jobId);
  await withContext({ orgId, userId: j.createdById }, async () => {
    const summary = `${j.createdRows.toLocaleString()} lead${j.createdRows === 1 ? '' : 's'} imported${j.failedRows ? `, ${j.failedRows.toLocaleString()} row${j.failedRows === 1 ? '' : 's'} with problems` : ''}${j.skippedRows ? `, ${j.skippedRows.toLocaleString()} skipped` : ''}`;
    await db().auditLog.create({ data: { organizationId: orgId, actorId: j.createdById, scope: 'TENANT', action: status === 'COMPLETED' ? 'lead.imported' : status === 'CANCELED' ? 'lead.import_canceled' : 'lead.import_failed', entityType: 'import', entityId: jobId, metadata: { file: j.fileName, created: j.createdRows, failed: j.failedRows, skipped: j.skippedRows, stopReason: j.stopReason } } });
    if (j.createdById) await notify({ userIds: [j.createdById], type: 'SYSTEM', title: status === 'COMPLETED' ? `Import finished: ${j.fileName}` : status === 'CANCELED' ? `Import canceled: ${j.fileName}` : `Import failed: ${j.fileName}`, body: status === 'FAILED' ? (j.error ?? 'The import could not be completed.') : summary, link: `/leads?imports=${jobId}`, entityType: 'import', entityId: jobId });
  });
}

// ───────────────────────────── housekeeping (scheduler, per workspace) ─────────────────────────────
export async function sweepImportJobs(orgId: string, now = nowDate()) {
  let expired = 0, requeued = 0, purged = 0;
  const ttl = new Date(now.getTime() - config.importPreviewTtlHours * 3_600_000);
  for (const j of await db().importJob.findMany({ where: { organizationId: orgId, status: 'PREVIEW', createdAt: { lt: ttl } }, take: 100 })) {
    await db().importJob.update({ where: { id: j.id }, data: { status: 'EXPIRED', finishedAt: now } }); expired++;
    afterCommit(async () => { await deleteFile(orgId, j.id); });
  }
  const st = getPrivateStorage();
  for (const j of await db().importJob.findMany({ where: { organizationId: orgId, status: { in: ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'] }, fileKey: { not: null }, fileDeletedAt: null }, take: 50 })) {
    try { if (st) await st.delete(j.fileKey!); await db().importJob.update({ where: { id: j.id }, data: { fileDeletedAt: now } }); } catch { /* retried next sweep */ }
  }
  if (!config.jobsInline) {
    // lost queue entries (e.g. Redis was flushed): a job that has been QUEUED for minutes, or RUNNING without progress for 10 minutes, is dispatched again
    const stuck = await db().importJob.findMany({ where: { organizationId: orgId, OR: [{ status: 'QUEUED', queuedAt: { lt: new Date(now.getTime() - 2 * 60_000) } }, { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }] }, take: 20 });
    for (const j of stuck) {
      const u = await db().importJob.update({ where: { id: j.id }, data: { requeues: { increment: 1 } } });
      afterCommit(async () => { await dispatch(orgId, j.id, u.requeues); }); requeued++;
    }
  }
  const old = await db().importJob.deleteMany({ where: { organizationId: orgId, finishedAt: { lt: new Date(now.getTime() - config.importHistoryDays * 86_400_000) }, status: { in: ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'] } } });
  purged = old.count;
  if (expired || requeued || purged) log.info('import sweep', { orgId, expired, requeued, purged });
  return { expired, requeued, purged };
}
