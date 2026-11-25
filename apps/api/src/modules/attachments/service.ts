import { createHash, randomUUID } from 'node:crypto';
import { config } from '../../config';
import { afterCommit, db, forEachOrg } from '../../db';
import { AppError, badRequest, notFound, paymentRequired } from '../../lib/errors';
import { detectAttachment, safeFileName } from '../../lib/file-sniff';
import { log } from '../../lib/logger';
import { getAttachmentStorage, type ObjectStorage } from '../../lib/storage';
import type { Ctx } from '../../http';
import { logActivity } from '../activities/service';
import { notify } from '../notifications/service';
import { audit } from '../../lib/audit';
import { getLeadOr404 } from '../leads/service';

export const storageOrThrow = (): ObjectStorage => {
  const s = getAttachmentStorage();
  if (!s) throw new AppError(503, 'FEATURE_UNAVAILABLE', 'File attachments need object storage (STORAGE_PROVIDER=s3). Ask your administrator to configure it.');
  return s;
};
const unavailable = (e: unknown) => {
  log.error('attachment storage failed', { error: (e as Error).message });
  return new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Nothing was saved; please try again in a moment.');
};
export const attachmentKey = (orgId: string, leadId: string, ext: string) => `attachments/${orgId}/${leadId}/${randomUUID()}.${ext}`;

export interface UploadInput { originalname: string; buffer: Buffer; mimetype?: string }
export interface Rejected { name: string; code: string; message: string }

/** Row shape returned to clients: never the storage key, never a bucket URL. */
export const publicAttachment = (a: { id: string; originalName: string; contentType: string; extension: string; sizeBytes: bigint; createdAt: Date; uploadedById: string | null }, uploader: { id: string; name: string } | null) => ({
  id: a.id, name: a.originalName, contentType: a.contentType, extension: a.extension, size: Number(a.sizeBytes), uploadedAt: a.createdAt, uploadedBy: uploader,
});

/**
 * Stores one or more files on a lead. Every file is validated by CONTENT (see lib/file-sniff.ts) and is handled independently:
 * invalid files are reported per file and do not stop valid ones. For each valid file the object is written first and the metadata row second;
 * if anything throws after objects were written, they are deleted again (best effort) and the orphan sweeper is the safety net.
 */
export async function uploadAttachments(ctx: Ctx, leadId: string, files: UploadInput[]) {
  const lead = await getLeadOr404(ctx, leadId);
  const storage = storageOrThrow();
  if (!files.length) throw badRequest('Attach at least one file in the "files" field.', undefined, 'NO_FILE');
  if (files.length > config.attachmentMaxFilesPerRequest) throw badRequest(`You can upload at most ${config.attachmentMaxFilesPerRequest} files at a time.`, undefined, 'TOO_MANY_FILES');
  // serialise concurrent uploads to the same lead so the count / quota checks below cannot be raced
  await db().$queryRaw`SELECT id FROM leads WHERE id = ${lead.id}::uuid AND organization_id = ${ctx.orgId}::uuid FOR UPDATE`;
  let count = await db().leadAttachment.count({ where: { leadId: lead.id, organizationId: ctx.orgId, deletedAt: null } });
  const used = config.attachmentWorkspaceMaxBytes ? Number((await db().leadAttachment.aggregate({ where: { organizationId: ctx.orgId, deletedAt: null }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0) : 0;
  let usedBytes = used;
  const uploaded: Array<ReturnType<typeof publicAttachment>> = [];
  const rejected: Rejected[] = [];
  const statuses: number[] = [];
  const written: string[] = [];
  const name = (f: UploadInput) => safeFileName(f.originalname);
  try {
    for (const f of files) {
      try {
        if (f.buffer.length > config.attachmentMaxBytes) throw new AppError(413, 'FILE_TOO_LARGE', `"${name(f)}" is larger than ${Math.floor(config.attachmentMaxBytes / 1024 / 1024)} MB.`);
        const det = detectAttachment(f);
        if (count >= config.attachmentMaxPerLead) throw paymentRequired(`A lead can have at most ${config.attachmentMaxPerLead} attachments. Remove one first.`, 'ATTACHMENT_LIMIT');
        if (config.attachmentWorkspaceMaxBytes && usedBytes + f.buffer.length > config.attachmentWorkspaceMaxBytes) throw paymentRequired('Your workspace has reached its file storage limit.', 'STORAGE_QUOTA');
        const key = attachmentKey(ctx.orgId, lead.id, det.extension);
        try { await storage.put(key, f.buffer, det.contentType); } catch (e) { throw unavailable(e); }
        written.push(key);
        const row = await db().leadAttachment.create({ data: {
          organizationId: ctx.orgId, leadId: lead.id, storageKey: key, originalName: name(f), contentType: det.contentType, extension: det.extension,
          sizeBytes: BigInt(f.buffer.length), sha256: createHash('sha256').update(f.buffer).digest('hex'), uploadedById: ctx.userId,
        } });
        count++; usedBytes += f.buffer.length;
        await logActivity({ leadId: lead.id, type: 'ATTACHMENT_ADDED', title: `Attached "${row.originalName}"`, metadata: { attachmentId: row.id, size: f.buffer.length, contentType: det.contentType }, touch: false });
        uploaded.push(publicAttachment(row, { id: ctx.userId, name: ctx.user.name }));
      } catch (e) {
        if (!(e instanceof AppError) || e.status >= 500) throw e;
        rejected.push({ name: name(f), code: e.code, message: e.message }); statuses.push(e.status);
      }
    }
  } catch (e) {
    await Promise.all(written.map((k) => storage.delete(k).catch(() => undefined)));
    throw e;
  }
  if (!uploaded.length) throw new AppError(statuses[0] ?? 400, rejected[0]!.code, rejected.length === 1 ? rejected[0]!.message : 'None of the files could be uploaded.', { rejected });
  await audit(ctx, 'lead.attachment_added', 'lead', lead.id, { count: uploaded.length, names: uploaded.map((u) => u.name).slice(0, 10) });
  if (lead.assignedToId && lead.assignedToId !== ctx.userId) {
    await notify({ userIds: [lead.assignedToId], type: 'SYSTEM', title: `${ctx.user.name} attached ${uploaded.length === 1 ? 'a file' : `${uploaded.length} files`} to ${lead.firstName}${lead.lastName ? ` ${lead.lastName}` : ''}`, link: `/leads/${lead.id}`, entityType: 'lead', entityId: lead.id });
  }
  return { uploaded, rejected };
}

export async function loadAttachment(ctx: Ctx, leadId: string, attachmentId: string) {
  const lead = await getLeadOr404(ctx, leadId, { includeArchived: true });   // lead-level authorisation (own leads only for agents)
  const a = await db().leadAttachment.findFirst({ where: { id: attachmentId, leadId: lead.id, organizationId: ctx.orgId, deletedAt: null } });
  if (!a) throw notFound('Attachment');
  return { lead, a };
}

export async function readAttachment(a: { storageKey: string }) {
  try { return await storageOrThrow().get(a.storageKey); } catch (e) { if (e instanceof AppError) throw e; throw unavailable(e); }
}

/** Marks the attachment deleted (history is kept) and removes the object after commit; the sweeper finishes the job if that fails. */
export async function removeAttachment(ctx: Ctx, leadId: string, attachmentId: string) {
  const { lead, a } = await loadAttachment(ctx, leadId, attachmentId);
  const allowed = ctx.can('leads.archive') || (a.uploadedById === ctx.userId && ctx.can('leads.update'));
  if (!allowed) throw new AppError(403, 'MISSING_PERMISSION', 'Only the person who uploaded a file, or a manager, can remove it.');
  if (lead.archivedAt) throw new AppError(409, 'LEAD_ARCHIVED', 'Restore the lead before changing its attachments.');
  await db().leadAttachment.update({ where: { id: a.id }, data: { deletedAt: new Date(), deletedById: ctx.userId } });
  await logActivity({ leadId: lead.id, type: 'ATTACHMENT_REMOVED', title: `Removed attachment "${a.originalName}"`, metadata: { attachmentId: a.id }, touch: false });
  await audit(ctx, 'lead.attachment_removed', 'lead', lead.id, { attachmentId: a.id, name: a.originalName });
  const id = a.id, key = a.storageKey, org = ctx.orgId;
  afterCommit(async () => { await deleteObjectFor(org, id, key); });
}

async function deleteObjectFor(orgId: string, id: string, key: string) {
  const st = getAttachmentStorage();
  if (!st) return;
  try {
    await st.delete(key);
    const { withContext } = await import('../../db');
    await withContext({ orgId, userId: null }, async () => { await db().leadAttachment.update({ where: { id }, data: { storageDeletedAt: new Date() } }); });
  } catch (e) { log.warn('attachment object delete deferred to the sweeper', { error: (e as Error).message }); }
}

/**
 * Housekeeping, run by the scheduler for every workspace (idempotent):
 *  1. objects of attachments that were removed (or whose immediate delete failed) are deleted and stamped;
 *  2. objects under `attachments/<org>/` with no metadata row and older than the grace period (crashed uploads) are deleted.
 */
export async function sweepAttachments(orgId: string, now = new Date()) {
  const st = getAttachmentStorage();
  if (!st) return { deleted: 0, orphans: 0 };
  let deleted = 0, orphans = 0;
  const pending = await db().leadAttachment.findMany({ where: { organizationId: orgId, deletedAt: { not: null }, storageDeletedAt: null }, take: 200 });
  for (const a of pending) {
    try { await st.delete(a.storageKey); await db().leadAttachment.update({ where: { id: a.id }, data: { storageDeletedAt: now } }); deleted++; }
    catch (e) { log.warn('attachment object delete failed', { orgId, error: (e as Error).message }); }
  }
  const objs = await st.list(`attachments/${orgId}/`, 2000).catch((e) => { log.warn('attachment listing failed', { error: (e as Error).message }); return []; });
  if (objs.length) {
    const known = new Set((await db().leadAttachment.findMany({ where: { organizationId: orgId, storageKey: { in: objs.map((o) => o.key) } }, select: { storageKey: true } })).map((r) => r.storageKey));
    for (const o of objs) {
      if (known.has(o.key) || now.getTime() - o.lastModified.getTime() < config.attachmentOrphanGraceMs) continue;
      try { await st.delete(o.key); orphans++; } catch { /* retried next sweep */ }
    }
  }
  if (deleted || orphans) log.info('attachment sweep', { orgId, deleted, orphans });
  return { deleted, orphans };
}

/**
 * Deletes every stored object of a workspace. MUST be called before a workspace (or a lead) is ever hard-deleted: rows cascade away
 * with the organization but objects in a bucket do not. Leads themselves are only archived by the application, never deleted.
 */
export async function purgeWorkspaceAttachments(orgId: string): Promise<number> {
  const st = getAttachmentStorage();
  if (!st) return 0;
  let n = 0;
  for (;;) {
    const objs = await st.list(`attachments/${orgId}/`, 1000);
    if (!objs.length) break;
    for (const o of objs) { await st.delete(o.key); n++; }
  }
  return n;
}
void forEachOrg;
