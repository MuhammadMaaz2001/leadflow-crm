import { z } from 'zod';
import { defineRoutes, Reply } from '../../http';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { tabular } from '../leads/transfer';
import { buildDashboard } from './dashboard';
import { buildFilterCtx, reportFilterQuery } from './filters';
import { REPORTS, runReport, type ReportKey } from './reports';

export const reports = defineRoutes('Reports & Analytics', '');

reports.get('/dashboard', { query: reportFilterQuery, summary: 'Dashboard KPIs, charts and attention lists (permission-aware)' }, async ({ ctx, query }) => {
  const f = buildFilterCtx(ctx, query, ctx.can('dashboard.view_all'));
  return buildDashboard(ctx, f);
});

reports.get('/reports', { perm: 'reports.view', summary: 'Report catalogue' }, async () => REPORTS);

reports.get('/reports/:key', { perm: 'reports.view', query: reportFilterQuery, summary: 'Run a report (add format=csv|xlsx to export)' }, async ({ ctx, params, query }) => {
  const def = REPORTS.find((r) => r.key === params.key);
  if (!def) throw notFound('Report');
  const f = buildFilterCtx(ctx, query, ctx.can('reports.view_all'));
  const result = await runReport(def.key as ReportKey, ctx, f);
  const payload = { ...result, filters: { from: f.range.from, to: f.range.to, range: f.range.preset, assigneeId: f.assigneeId, sourceId: f.sourceId, pipelineId: f.pipelineId, restricted: f.restricted, timezone: f.tz, currency: ctx.org.currency } };
  if (query.format === 'json') return payload;
  if (!ctx.can('reports.export')) throw forbidden('Missing permission: reports.export', 'MISSING_PERMISSION');
  if (!ctx.plan.features.includes('advanced_reports')) throw new AppError(402, 'FEATURE_NOT_IN_PLAN', 'Report export is available on plans with advanced reports. Upgrade to continue.');
  const header = result.columns.map((c) => c.label);
  const rows = result.rows.map((r) => result.columns.map((c) => (r[c.key] ?? '') as string | number));
  await audit(ctx, 'report.exported', 'report', undefined, { report: def.key, format: query.format });
  return tabular(`report-${def.key}`, header, rows, query.format, def.title);
});
void z; void Reply;
