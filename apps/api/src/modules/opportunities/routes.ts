import { fullName, moveOpportunitySchema, opportunitySchema, opportunityUpdateSchema } from '@leadflow/shared';
import { z } from 'zod';
import type { Prisma } from '@leadflow/database';
import { db } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { created, defineRoutes, paged } from '../../http';
import { csvEnum, csvUuids, pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';
import { audit } from '../../lib/audit';
import { assertActiveMember, syncLeadFromOpportunities } from '../leads/service';
import { createOpportunity, getOppOr404, moveOpportunity, oppScope } from './service';

export const opportunities = defineRoutes('Opportunities', '/opportunities');

const filterQuery = z.object({
  pipelineId: z.string().uuid().optional(), stageId: z.string().uuid().optional(), status: csvEnum(['OPEN', 'WON', 'LOST']), ownerId: csvUuids(), leadId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(), closeFrom: z.coerce.date().optional(), closeTo: z.coerce.date().optional(),
});

function whereFrom(ctx: Parameters<typeof oppScope>[0], f: z.infer<typeof filterQuery>): Prisma.OpportunityWhereInput {
  const and: Prisma.OpportunityWhereInput[] = [oppScope(ctx)];
  if (f.q) and.push({ OR: [{ name: { contains: f.q, mode: 'insensitive' } }, { lead: { firstName: { contains: f.q, mode: 'insensitive' } } }, { lead: { lastName: { contains: f.q, mode: 'insensitive' } } }, { lead: { companyName: { contains: f.q, mode: 'insensitive' } } }] });
  if (f.status?.length) and.push({ status: { in: f.status as never } });
  if (f.ownerId?.length) and.push({ ownerId: { in: f.ownerId } });
  if (f.closeFrom) and.push({ expectedCloseDate: { gte: f.closeFrom } });
  if (f.closeTo) and.push({ expectedCloseDate: { lte: f.closeTo } });
  return { organizationId: ctx.orgId, archivedAt: null, ...(f.pipelineId ? { pipelineId: f.pipelineId } : {}), ...(f.stageId ? { stageId: f.stageId } : {}), ...(f.leadId ? { leadId: f.leadId } : { lead: { archivedAt: null, mergedIntoId: null } }), AND: and };
}

const oppInclude = {
  lead: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true, phone: true } },
  stage: { select: { id: true, name: true, color: true, kind: true, probability: true } },
  pipeline: { select: { id: true, name: true } },
  lostReason: { select: { id: true, name: true } },
} satisfies Prisma.OpportunityInclude;

type OppRow = Prisma.OpportunityGetPayload<{ include: typeof oppInclude }>;
function shape(o: OppRow, users: Map<string, { id: string; name: string; email: string }>) {
  return {
    id: o.id, name: o.name, value: Number(o.value), status: o.status, expectedCloseDate: o.expectedCloseDate, position: o.position, stageEnteredAt: o.stageEnteredAt,
    wonAt: o.wonAt, lostAt: o.lostAt, lostReason: o.lostReason, lostNote: o.lostNote, notes: o.notes, createdAt: o.createdAt,
    lead: { id: o.lead.id, name: fullName(o.lead), companyName: o.lead.companyName, email: o.lead.email, phone: o.lead.phone },
    stage: o.stage, pipeline: o.pipeline, owner: lite(users, o.ownerId),
  };
}

opportunities.get('/', { query: filterQuery.extend({ ...pageQuery, sort: z.enum(['createdAt', 'value', 'expectedCloseDate', 'name']).default('createdAt'), order: z.enum(['asc', 'desc']).default('desc') }), summary: 'List opportunities (table view)' }, async ({ ctx, query }) => {
  const where = whereFrom(ctx, query);
  const [total, rows, agg] = await Promise.all([
    db().opportunity.count({ where }),
    db().opportunity.findMany({ where, include: oppInclude, orderBy: { [query.sort]: query.order }, ...paginate(query) }),
    db().opportunity.aggregate({ where, _sum: { value: true } }),
  ]);
  const users = await usersById(rows.map((r) => r.ownerId));
  const res = paged(rows.map((r) => shape(r, users)), { ...pageMeta(query, total), totalValue: Number(agg._sum.value ?? 0) });
  return res;
});

opportunities.get('/board', { query: filterQuery.pick({ pipelineId: true, ownerId: true, q: true }), summary: 'Kanban board data for a pipeline' }, async ({ ctx, query }) => {
  const pipeline = query.pipelineId
    ? await db().pipeline.findFirst({ where: { id: query.pipelineId, organizationId: ctx.orgId, archivedAt: null } })
    : await db().pipeline.findFirst({ where: { organizationId: ctx.orgId, isDefault: true, archivedAt: null } });
  if (!pipeline) throw notFound('Pipeline');
  const stages = await db().pipelineStage.findMany({ where: { pipelineId: pipeline.id, organizationId: ctx.orgId }, orderBy: { position: 'asc' } });
  const base = whereFrom(ctx, { ...query, pipelineId: pipeline.id });
  const totals = await db().opportunity.groupBy({ by: ['stageId'], where: base, _count: true, _sum: { value: true } });
  const t = new Map(totals.map((x) => [x.stageId, x]));
  const cols = await Promise.all(stages.map(async (s) => {
    const rows = await db().opportunity.findMany({ where: { ...base, stageId: s.id }, include: oppInclude, orderBy: s.kind === 'OPEN' ? { position: 'asc' } : { updatedAt: 'desc' }, take: 60 });
    return { s, rows };
  }));
  const users = await usersById(cols.flatMap((c) => c.rows.map((r) => r.ownerId)));
  return {
    pipeline: { id: pipeline.id, name: pipeline.name },
    stages: cols.map(({ s, rows }) => ({ id: s.id, name: s.name, color: s.color, kind: s.kind, probability: s.probability, position: s.position, count: t.get(s.id)?._count ?? 0, totalValue: Number(t.get(s.id)?._sum.value ?? 0), opportunities: rows.map((r) => shape(r, users)) })),
  };
});

opportunities.post('/', { perm: 'opportunities.manage', body: opportunitySchema, summary: 'Create an opportunity for a lead' }, async ({ ctx, body }) => {
  const o = await createOpportunity(ctx, body);
  const full = await db().opportunity.findUniqueOrThrow({ where: { id: o.id }, include: oppInclude });
  return created(shape(full, await usersById([o.ownerId])));
});

opportunities.get('/:id', { summary: 'Opportunity detail with stage history' }, async ({ ctx, params }) => {
  const base = await getOppOr404(ctx, params.id);
  const full = await db().opportunity.findUniqueOrThrow({ where: { id: base.id }, include: oppInclude });
  const [history, tasks, followUps] = await Promise.all([
    db().stageHistory.findMany({ where: { opportunityId: base.id, organizationId: ctx.orgId }, orderBy: { createdAt: 'desc' } }),
    db().task.count({ where: { opportunityId: base.id, organizationId: ctx.orgId, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
    db().followUp.count({ where: { opportunityId: base.id, organizationId: ctx.orgId, status: 'PENDING' } }),
  ]);
  const stageIds = [...new Set(history.flatMap((h) => [h.fromStageId, h.toStageId]).filter(Boolean) as string[])];
  const stages = await db().pipelineStage.findMany({ where: { id: { in: stageIds } } });
  const sm = new Map(stages.map((s) => [s.id, s]));
  const users = await usersById([base.ownerId, ...history.map((h) => h.changedById)]);
  return {
    ...shape(full, users),
    history: history.map((h) => ({ id: h.id, from: h.fromStageId ? sm.get(h.fromStageId)?.name ?? null : null, to: sm.get(h.toStageId)?.name ?? null, toColor: sm.get(h.toStageId)?.color, changedBy: lite(users, h.changedById), note: h.note, createdAt: h.createdAt })),
    openTasks: tasks, pendingFollowUps: followUps,
  };
});

opportunities.patch('/:id', { perm: 'opportunities.manage', body: opportunityUpdateSchema, summary: 'Edit opportunity details' }, async ({ ctx, params, body }) => {
  const opp = await getOppOr404(ctx, params.id);
  if (body.ownerId) await assertActiveMember(ctx, body.ownerId, 'Owner');
  const u = await db().opportunity.update({ where: { id: opp.id }, data: body });
  return { id: u.id };
});

opportunities.post('/:id/move', { perm: 'opportunities.manage', body: moveOpportunitySchema, summary: 'Move to a stage (drag & drop / win / lose). Lost requires a reason.' }, async ({ ctx, params, body }) => {
  const opp = await getOppOr404(ctx, params.id);
  const u = await moveOpportunity(ctx, opp, body);
  return { id: u.id, status: u.status, stageId: u.stageId };
});

opportunities.delete('/:id', { perm: 'opportunities.manage', summary: 'Archive an opportunity' }, async ({ ctx, params }) => {
  const opp = await getOppOr404(ctx, params.id);
  await db().opportunity.update({ where: { id: opp.id }, data: { archivedAt: new Date() } });
  await syncLeadFromOpportunities(opp.leadId);
  await audit(ctx, 'opportunity.archived', 'opportunity', opp.id);
  return { archived: true };
});
void AppError;
