import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { ATTACHMENT_ACCEPT } from '../../lib/file-sniff';
import { contentDisposition } from '../../lib/file-sniff';
import { AppError, notFound } from '../../lib/errors';
import { RawReply, created, defineRoutes } from '../../http';
import { lite, usersById } from '../../lib/users';
import { getAttachmentStorage } from '../../lib/storage';
import { getLeadOr404 } from '../leads/service';
import { loadAttachment, publicAttachment, readAttachment, removeAttachment, uploadAttachments } from './service';

export const attachments = defineRoutes('Lead attachments', '/leads');
const idParams = z.object({});
void idParams;

attachments.get('/:id/attachments', { summary: 'Files attached to a lead (metadata only)' }, async ({ ctx, params }) => {
  const lead = await getLeadOr404(ctx, params.id!, { includeArchived: true });
  const rows = await db().leadAttachment.findMany({ where: { leadId: lead.id, organizationId: ctx.orgId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 500 });
  const users = await usersById(rows.map((r) => r.uploadedById));
  return {
    items: rows.map((r) => publicAttachment(r, lite(users, r.uploadedById))),
    limits: { maxBytes: config.attachmentMaxBytes, maxFilesPerRequest: config.attachmentMaxFilesPerRequest, maxPerLead: config.attachmentMaxPerLead, accept: ATTACHMENT_ACCEPT, enabled: !!getAttachmentStorage() },
    canUpload: ctx.can('leads.update') && !lead.archivedAt,
  };
});

attachments.post('/:id/attachments', { perm: 'leads.update', uploadMany: true, summary: 'Upload one or more files (multipart field "files"); content is validated, not the file name' }, async ({ ctx, params, req }) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const r = await uploadAttachments(ctx, params.id!, files.map((f) => ({ originalname: Buffer.from(f.originalname, 'latin1').toString('utf8'), buffer: f.buffer, mimetype: f.mimetype })));
  return created(r);
});

attachments.get('/:id/attachments/:attachmentId/download', { summary: 'Download an attachment (authorised stream through the API; the bucket is never exposed)' }, async ({ ctx, params }) => {
  const { a } = await loadAttachment(ctx, params.id!, params.attachmentId!);
  const obj = await readAttachment(a);
  if (!obj) throw new AppError(404, 'FILE_MISSING', 'The stored file could not be found. Please contact your administrator.');
  return new RawReply(a.contentType, obj.body, {
    'Content-Disposition': contentDisposition(a.originalName), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Length': String(obj.body.length), 'Access-Control-Expose-Headers': 'Content-Disposition',
  });
});

attachments.delete('/:id/attachments/:attachmentId', { summary: 'Remove an attachment (uploader with edit rights, or a manager)' }, async ({ ctx, params }) => {
  await removeAttachment(ctx, params.id!, params.attachmentId!);
  return { removed: true };
});
void notFound;
