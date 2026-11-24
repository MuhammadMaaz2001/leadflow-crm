import { DEFAULT_STAGES, pipelineSchema, stageReorderSchema, stageSchema } from '@leadflow/shared';
import { db } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { created, defineRoutes } from '../../http';

export const pipelines = defineRoutes('Pipelines', '');

pipelines.get('/pipelines', { summary: 'List pipelines with stages and open deal counts' }, async ({ ctx }) => {
  const [list, counts] = await Promise.all([
    db().pipeline.findMany({ where: { organizationId: ctx.orgId, archivedAt: null }, include: { stages: { orderBy: { position: 'asc' } } }, orderBy: [{ isDefault: 'desc' }, { position: 'asc' }] }),
    db().opportunity.groupBy({ by: ['stageId'], where: { organizationId: ctx.orgId, archivedAt: null }, _count: true }),
  ]);
  const c = new Map(counts.map((x) => [x.stageId, x._count]));
  return list.map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, opportunityCount: c.get(s.id) ?? 0 })) }));
});

pipelines.post('/pipelines', { perm: 'settings.manage', feature: 'custom_pipelines', body: pipelineSchema, summary: 'Create a pipeline (starts with the standard stages)' }, async ({ ctx, body }) => {
  const count = await db().pipeline.count({ where: { organizationId: ctx.orgId } });
  const p = await db().pipeline.create({ data: { organizationId: ctx.orgId, name: body.name, position: count } });
  await db().pipelineStage.createMany({ data: DEFAULT_STAGES.map((s, i) => ({ organizationId: ctx.orgId, pipelineId: p.id, name: s.name, kind: s.kind, probability: s.probability, color: s.color, position: i })) });
  if (body.isDefault) {
    await db().pipeline.updateMany({ where: { organizationId: ctx.orgId, id: { not: p.id } }, data: { isDefault: false } });
    await db().pipeline.update({ where: { id: p.id }, data: { isDefault: true } });
  }
  await audit(ctx, 'pipeline.created', 'pipeline', p.id, { name: p.name });
  return created(p);
});

pipelines.patch('/pipelines/:id', { perm: 'settings.manage', body: pipelineSchema.partial(), summary: 'Rename / set default pipeline' }, async ({ ctx, params, body }) => {
  const p = await db().pipeline.findFirst({ where: { id: params.id, organizationId: ctx.orgId, archivedAt: null } });
  if (!p) throw notFound('Pipeline');
  if (body.isDefault) await db().pipeline.updateMany({ where: { organizationId: ctx.orgId, isDefault: true, id: { not: p.id } }, data: { isDefault: false } });
  if (body.isDefault === false && p.isDefault) throw new AppError(409, 'DEFAULT_REQUIRED', 'Make another pipeline the default instead.');
  const u = await db().pipeline.update({ where: { id: p.id }, data: { name: body.name, isDefault: body.isDefault } });
  await audit(ctx, 'pipeline.updated', 'pipeline', p.id);
  return u;
});

pipelines.delete('/pipelines/:id', { perm: 'settings.manage', summary: 'Archive a pipeline' }, async ({ ctx, params }) => {
  const p = await db().pipeline.findFirst({ where: { id: params.id, organizationId: ctx.orgId, archivedAt: null } });
  if (!p) throw notFound('Pipeline');
  if (p.isDefault) throw new AppError(409, 'DEFAULT_REQUIRED', 'The default pipeline cannot be archived. Make another pipeline the default first.');
  const open = await db().opportunity.count({ where: { pipelineId: p.id, organizationId: ctx.orgId, status: 'OPEN', archivedAt: null } });
  if (open) throw new AppError(409, 'PIPELINE_IN_USE', `${open} open opportunities are still in this pipeline. Move or close them first.`);
  await db().pipeline.update({ where: { id: p.id }, data: { archivedAt: new Date(), name: `${p.name} (archived ${Date.now().toString(36)})` } });
  await audit(ctx, 'pipeline.archived', 'pipeline', p.id);
  return { archived: true };
});

pipelines.post('/pipelines/:id/stages', { perm: 'settings.manage', body: stageSchema, summary: 'Add a stage (open stages are inserted before Won/Lost)' }, async ({ ctx, params, body }) => {
  const p = await db().pipeline.findFirst({ where: { id: params.id, organizationId: ctx.orgId, archivedAt: null }, include: { stages: { orderBy: { position: 'asc' } } } });
  if (!p) throw notFound('Pipeline');
  const kind = body.kind ?? 'OPEN';
  let position = p.stages.length;
  if (kind === 'OPEN') {
    const firstTerminal = p.stages.find((s) => s.kind !== 'OPEN');
    if (firstTerminal) {
      position = firstTerminal.position;
      await db().pipelineStage.updateMany({ where: { pipelineId: p.id, organizationId: ctx.orgId, position: { gte: position } }, data: { position: { increment: 1 } } });
    }
  }
  const s = await db().pipelineStage.create({ data: { organizationId: ctx.orgId, pipelineId: p.id, name: body.name, kind, probability: body.probability ?? (kind === 'WON' ? 100 : kind === 'LOST' ? 0 : 50), color: body.color ?? '#64748b', position } });
  await audit(ctx, 'pipeline.stage_created', 'pipeline_stage', s.id, { name: s.name });
  return created(s);
});

pipelines.post('/pipelines/:id/stages/reorder', { perm: 'settings.manage', body: stageReorderSchema, summary: 'Reorder stages (Won/Lost stay last)' }, async ({ ctx, params, body }) => {
  const stages = await db().pipelineStage.findMany({ where: { pipelineId: params.id, organizationId: ctx.orgId } });
  if (!stages.length) throw notFound('Pipeline');
  const byId = new Map(stages.map((s) => [s.id, s]));
  if (body.stageIds.length !== stages.length || body.stageIds.some((i) => !byId.has(i)) || new Set(body.stageIds).size !== stages.length) throw new AppError(400, 'BAD_ORDER', 'Provide every stage of the pipeline exactly once');
  const kinds = body.stageIds.map((i) => byId.get(i)!.kind);
  const firstTerminal = kinds.findIndex((k) => k !== 'OPEN');
  if (firstTerminal !== -1 && kinds.slice(firstTerminal).some((k) => k === 'OPEN')) throw new AppError(400, 'BAD_ORDER', 'Won and Lost stages must come after all open stages');
  for (const [i, id] of body.stageIds.entries()) await db().pipelineStage.update({ where: { id }, data: { position: i } });
  await audit(ctx, 'pipeline.stages_reordered', 'pipeline', params.id);
  return { reordered: true };
});

pipelines.patch('/stages/:id', { perm: 'settings.manage', body: stageSchema.partial(), summary: 'Edit a stage' }, async ({ ctx, params, body }) => {
  const s = await db().pipelineStage.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!s) throw notFound('Stage');
  if (body.kind && body.kind !== s.kind) throw new AppError(409, 'KIND_LOCKED', 'A stage\'s outcome type (open / won / lost) cannot be changed. Add a new stage instead.');
  const u = await db().pipelineStage.update({ where: { id: s.id }, data: { name: body.name, probability: body.probability, color: body.color } });
  await audit(ctx, 'pipeline.stage_updated', 'pipeline_stage', s.id);
  return u;
});

pipelines.delete('/stages/:id', { perm: 'settings.manage', summary: 'Delete an unused stage' }, async ({ ctx, params }) => {
  const s = await db().pipelineStage.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!s) throw notFound('Stage');
  const [used, hist, sameKind] = await Promise.all([
    db().opportunity.count({ where: { stageId: s.id, organizationId: ctx.orgId } }),
    db().stageHistory.count({ where: { organizationId: ctx.orgId, OR: [{ fromStageId: s.id }, { toStageId: s.id }] } }),
    db().pipelineStage.count({ where: { pipelineId: s.pipelineId, organizationId: ctx.orgId, kind: s.kind } }),
  ]);
  if (used || hist) throw new AppError(409, 'STAGE_IN_USE', 'This stage has opportunities or history and cannot be deleted. Rename it instead.');
  if (s.kind !== 'OPEN' && sameKind <= 1) throw new AppError(409, 'STAGE_REQUIRED', `A pipeline needs at least one ${s.kind === 'WON' ? 'Won' : 'Lost'} stage.`);
  const open = await db().pipelineStage.count({ where: { pipelineId: s.pipelineId, organizationId: ctx.orgId, kind: 'OPEN' } });
  if (s.kind === 'OPEN' && open <= 1) throw new AppError(409, 'STAGE_REQUIRED', 'A pipeline needs at least one open stage.');
  await db().pipelineStage.delete({ where: { id: s.id } });
  await db().pipelineStage.updateMany({ where: { pipelineId: s.pipelineId, organizationId: ctx.orgId, position: { gt: s.position } }, data: { position: { decrement: 1 } } });
  await audit(ctx, 'pipeline.stage_deleted', 'pipeline_stage', s.id, { name: s.name });
  return { deleted: true };
});
