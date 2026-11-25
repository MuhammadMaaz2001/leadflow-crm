import { z } from 'zod';
import { config } from '../../config';
import { created, defineRoutes } from '../../http';
import { badRequest } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { cancelImportJob, createImportJob, errorReportCsv, getJobOr404, listJobs, publicJob, startImportJob } from './import-jobs';
import { lite, usersById } from '../../lib/users';

/** Background imports. Defined before the `/leads/:id` routes' neighbours; all paths live under /leads/import/jobs. */
export const importJobs = defineRoutes('Lead imports', '/leads/import');
const base = { perm: 'leads.import', feature: 'import_export' } as const;

importJobs.get('/jobs', { ...base, summary: 'Import history (newest first) and the current limits' }, async ({ ctx }) => ({
  jobs: await listJobs(ctx),
  limits: { maxFileBytes: config.importMaxFileBytes, maxRows: config.importMaxRows, batchSize: config.importBatchSize, maxActivePerWorkspace: config.importMaxActivePerOrg, retentionDays: config.importHistoryDays },
}));

importJobs.post('/jobs', { ...base, upload: { maxBytes: config.importMaxFileBytes }, summary: 'Upload a CSV/XLSX (multipart "file"): validates headers and a sample and returns a PREVIEW job. Nothing is imported until /start' }, async ({ ctx, req }) => {
  if (!req.file) throw badRequest('Attach a CSV or Excel file in the "file" field', undefined, 'NO_FILE');
  const job = await createImportJob(ctx, { originalname: req.file.originalname, buffer: req.file.buffer });
  await audit(ctx, 'lead.import_uploaded', 'import', job.id, { file: job.fileName, rows: job.totalRows });
  return created(job);
});

importJobs.get('/jobs/:jobId', { ...base, summary: 'Import status, counters and (for a preview) the column mapping and sample rows' }, async ({ ctx, params }) => {
  const j = await getJobOr404(ctx, params.jobId!);
  const u = await usersById([j.createdById]);
  return publicJob(j, lite(u, j.createdById), true);
});

importJobs.post('/jobs/:jobId/start', { ...base, body: z.object({ duplicates: z.enum(['skip', 'import']).default('skip') }), summary: 'Start a previewed import in the background (idempotent)' }, async ({ ctx, params, body }) => {
  const j = await startImportJob(ctx, params.jobId!, body);
  await audit(ctx, 'lead.import_started', 'import', params.jobId!, { duplicates: body.duplicates });
  return j;
});

importJobs.post('/jobs/:jobId/cancel', { ...base, summary: 'Cancel an import. Leads already imported by committed batches are kept' }, async ({ ctx, params }) => cancelImportJob(ctx, params.jobId!));

importJobs.get('/jobs/:jobId/errors', { ...base, summary: 'Download the row-level error report (CSV): row number, problem and the original values' }, async ({ ctx, params }) => errorReportCsv(ctx, params.jobId!));
