import type { Opportunity, Prisma } from '@leadflow/database';
import { db } from '../../db';
import { AppError, badRequest, notFound } from '../../lib/errors';
import type { Ctx } from '../../http';
import { logActivity } from '../activities/service';
import { emitTrigger } from '../automations/events';
import { assertActiveMember, getLeadOr404, syncLeadFromOpportunities } from '../leads/service';

export function oppScope(ctx: Ctx): Prisma.OpportunityWhereInput {
  return ctx.can('opportunities.view_all') ? {} : { OR: [{ ownerId: ctx.userId }, { createdById: ctx.userId }] };
}
export async function getOppOr404(ctx: Ctx, id: string) {
  const o = await db().opportunity.findFirst({ where: { id, organizationId: ctx.orgId, archivedAt: null, AND: [oppScope(ctx)] } });
  if (!o) throw notFound('Opportunity');
  return o;
}

async function nextPosition(orgId: string, stageId: string) {
  const r = await db().opportunity.aggregate({ where: { organizationId: orgId, stageId, archivedAt: null }, _max: { position: true } });
  return (r._max.position ?? 0) + 1024;
}

export async function createOpportunity(ctx: Ctx, input: { leadId: string; pipelineId?: string | null; stageId?: string | null; name: string; value: number; expectedCloseDate?: Date | null; ownerId?: string | null; notes?: string | null }) {
  const lead = await getLeadOr404(ctx, input.leadId);
  const pipeline = input.pipelineId
    ? await db().pipeline.findFirst({ where: { id: input.pipelineId, organizationId: ctx.orgId, archivedAt: null } })
    : await db().pipeline.findFirst({ where: { organizationId: ctx.orgId, isDefault: true, archivedAt: null } });
  if (!pipeline) throw badRequest('Pipeline not found', { fields: { pipelineId: 'Unknown pipeline' } });
  const stage = input.stageId
    ? await db().pipelineStage.findFirst({ where: { id: input.stageId, organizationId: ctx.orgId, pipelineId: pipeline.id } })
    : await db().pipelineStage.findFirst({ where: { organizationId: ctx.orgId, pipelineId: pipeline.id, kind: 'OPEN' }, orderBy: { position: 'asc' } });
  if (!stage) throw badRequest('Stage not found in that pipeline', { fields: { stageId: 'Unknown stage' } });
  if (stage.kind !== 'OPEN') throw badRequest('New opportunities must start in an open stage. Move it to Won or Lost afterwards.', { fields: { stageId: 'Choose an open stage' } });
  const ownerId = input.ownerId ?? lead.assignedToId ?? ctx.userId;
  await assertActiveMember(ctx, ownerId, 'Owner');
  const opp = await db().opportunity.create({
    data: {
      organizationId: ctx.orgId, leadId: lead.id, pipelineId: pipeline.id, stageId: stage.id, name: input.name, value: input.value,
      expectedCloseDate: input.expectedCloseDate ?? null, ownerId, notes: input.notes ?? null, createdById: ctx.userId, position: await nextPosition(ctx.orgId, stage.id),
    },
  });
  await db().stageHistory.create({ data: { organizationId: ctx.orgId, opportunityId: opp.id, fromStageId: null, toStageId: stage.id, changedById: ctx.userId, note: 'Opportunity created' } });
  await logActivity({ leadId: lead.id, opportunityId: opp.id, type: 'OPPORTUNITY_CREATED', title: `Opportunity created: ${opp.name}`, metadata: { value: Number(opp.value), stage: stage.name } });
  await syncLeadFromOpportunities(lead.id);
  return opp;
}

export async function moveOpportunity(ctx: Ctx, opp: Opportunity, input: { stageId: string; beforeId?: string | null; lostReasonId?: string | null; lostNote?: string | null }) {
  const stage = await db().pipelineStage.findFirst({ where: { id: input.stageId, organizationId: ctx.orgId } });
  if (!stage) throw badRequest('Unknown stage', { fields: { stageId: 'Unknown stage' } });
  const pipeline = await db().pipeline.findFirst({ where: { id: stage.pipelineId, organizationId: ctx.orgId, archivedAt: null } });
  if (!pipeline) throw badRequest('That pipeline is archived');
  const fromStage = await db().pipelineStage.findUniqueOrThrow({ where: { id: opp.stageId } });
  const lead = await db().lead.findUniqueOrThrow({ where: { id: opp.leadId } });
  const stageChanged = stage.id !== opp.stageId;
  const data: Prisma.OpportunityUncheckedUpdateInput = { pipelineId: stage.pipelineId };

  // position inside the destination column
  const before = input.beforeId ? await db().opportunity.findFirst({ where: { id: input.beforeId, organizationId: ctx.orgId, stageId: stage.id, archivedAt: null } }) : null;
  if (before) {
    const prev = await db().opportunity.findFirst({ where: { organizationId: ctx.orgId, stageId: stage.id, archivedAt: null, position: { lt: before.position }, id: { not: opp.id } }, orderBy: { position: 'desc' } });
    data.position = prev ? (prev.position + before.position) / 2 : before.position - 512;
  } else if (stageChanged || input.beforeId === null) data.position = await nextPosition(ctx.orgId, stage.id);

  if (stageChanged) {
    data.stageId = stage.id;
    data.stageEnteredAt = new Date();
    if (stage.kind === 'WON') { data.status = 'WON'; data.wonAt = new Date(); data.lostAt = null; data.lostReasonId = null; data.lostNote = null; }
    else if (stage.kind === 'LOST') {
      if (!input.lostReasonId) throw badRequest('Select a lost reason to close this opportunity as lost', { fields: { lostReasonId: 'Select a lost reason' } }, 'LOST_REASON_REQUIRED');
      const reason = await db().lostReason.findFirst({ where: { id: input.lostReasonId, organizationId: ctx.orgId } });
      if (!reason) throw badRequest('Unknown lost reason', { fields: { lostReasonId: 'Unknown lost reason' } });
      data.status = 'LOST'; data.lostAt = new Date(); data.lostReasonId = reason.id; data.lostNote = input.lostNote ?? null; data.wonAt = null;
    } else { data.status = 'OPEN'; data.wonAt = null; data.lostAt = null; data.lostReasonId = null; data.lostNote = null; }
  }
  const updated = await db().opportunity.update({ where: { id: opp.id }, data });
  if (stageChanged) {
    await db().stageHistory.create({ data: { organizationId: ctx.orgId, opportunityId: opp.id, fromStageId: opp.stageId, toStageId: stage.id, changedById: ctx.userId, note: stage.kind === 'LOST' ? input.lostNote ?? null : pipeline.id !== opp.pipelineId ? 'Moved to another pipeline' : null } });
    const type = stage.kind === 'WON' ? 'OPPORTUNITY_WON' : stage.kind === 'LOST' ? 'OPPORTUNITY_LOST' : 'STAGE_CHANGED';
    const title = stage.kind === 'WON' ? `Won: ${opp.name}` : stage.kind === 'LOST' ? `Lost: ${opp.name}` : `${opp.name}: ${fromStage.name} → ${stage.name}`;
    await logActivity({ leadId: opp.leadId, opportunityId: opp.id, type, title, body: stage.kind === 'LOST' ? input.lostNote ?? null : null, metadata: { from: fromStage.name, to: stage.name, value: Number(opp.value) } });
    const sync = await syncLeadFromOpportunities(opp.leadId);
    if (sync && sync.next === 'CONVERTED' && sync.previous !== 'CONVERTED') {
      await emitTrigger('LEAD_CONVERTED', { type: 'lead', id: lead.id, leadId: lead.id }, `LEAD_CONVERTED:${lead.id}:${opp.id}`);
      await logActivity({ leadId: lead.id, type: 'STATUS_CHANGED', title: 'Lead converted — first opportunity won', metadata: { from: sync.previous, to: 'CONVERTED' } });
    }
  }
  return updated;
}

export { AppError };
