import { Prisma } from '@leadflow/database';
import { z } from 'zod';
import { rangeQuery, resolveRange, type Range } from '../../lib/dates';
import type { Ctx } from '../../http';

export const reportFilterQuery = z.object({
  ...rangeQuery,
  assignedToId: z.string().optional(),
  sourceId: z.string().uuid().optional(),
  pipelineId: z.string().uuid().optional(),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});
export type ReportFilters = z.infer<typeof reportFilterQuery>;

export interface FilterCtx {
  orgId: string; tz: string; range: Range; assigneeId: string | null; sourceId: string | null; pipelineId: string | null; restricted: boolean;
  /** SQL fragments */
  leadWhere: Prisma.Sql;       // leads created in range + filters (alias l)
  leadAnyWhere: Prisma.Sql;    // leads regardless of date (alias l) + filters
  oppWhere: Prisma.Sql;        // opportunities (alias o) + owner/source/pipeline filters, no date
  now: Date;
}

/** Builds the shared filter context. Members without the "view all" permission are forced to their own data. */
export function buildFilterCtx(ctx: Ctx, f: ReportFilters, viewAll: boolean): FilterCtx {
  const range = resolveRange(f.range, ctx.org.timezone, { from: f.from, to: f.to });
  const restricted = !viewAll;
  const assigneeId = restricted ? ctx.userId : f.assignedToId === 'me' ? ctx.userId : f.assignedToId && f.assignedToId !== 'all' ? f.assignedToId : null;
  const sourceId = f.sourceId ?? null;
  const pipelineId = f.pipelineId ?? null;
  const org = ctx.orgId;
  const base = Prisma.sql`l.organization_id = ${org}::uuid AND l.archived_at IS NULL AND l.merged_into_id IS NULL`;
  const a = assigneeId ? Prisma.sql` AND l.assigned_to_id = ${assigneeId}::uuid` : Prisma.empty;
  const s = sourceId ? Prisma.sql` AND l.source_id = ${sourceId}::uuid` : Prisma.empty;
  const leadAnyWhere = Prisma.sql`${base}${a}${s}`;
  const leadWhere = Prisma.sql`${leadAnyWhere} AND l.created_at >= ${range.from} AND l.created_at < ${range.to}`;
  const oa = assigneeId ? Prisma.sql` AND o.owner_id = ${assigneeId}::uuid` : Prisma.empty;
  const os = sourceId ? Prisma.sql` AND l.source_id = ${sourceId}::uuid` : Prisma.empty;
  const op = pipelineId ? Prisma.sql` AND o.pipeline_id = ${pipelineId}::uuid` : Prisma.empty;
  // deals of archived / merged leads are hidden everywhere (they come back when the lead is restored)
  const oppWhere = Prisma.sql`o.organization_id = ${org}::uuid AND o.archived_at IS NULL AND EXISTS (SELECT 1 FROM leads la WHERE la.id = o.lead_id AND la.organization_id = o.organization_id AND la.archived_at IS NULL AND la.merged_into_id IS NULL)${oa}${os}${op}`;
  return { orgId: org, tz: ctx.org.timezone, range, assigneeId, sourceId, pipelineId, restricted, leadWhere, leadAnyWhere, oppWhere, now: new Date() };
}
