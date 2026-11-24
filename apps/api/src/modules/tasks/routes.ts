import { commentSchema, fullName, taskSchema, taskUpdateSchema } from '@leadflow/shared';
import { z } from 'zod';
import type { Prisma } from '@leadflow/database';
import { db } from '../../db';
import { badRequest, notFound } from '../../lib/errors';
import { created, defineRoutes, paged } from '../../http';
import { csvEnum, csvUuids, pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';
import { logActivity } from '../activities/service';
import { assertActiveMember, getLeadOr404 } from '../leads/service';
import { getOppOr404 } from '../opportunities/service';
import { notify } from '../notifications/service';
import type { Ctx } from '../../http';

export const tasks = defineRoutes('Tasks', '/tasks');

const taskScope = (ctx: Ctx): Prisma.TaskWhereInput => (ctx.can('tasks.view_all') ? {} : { OR: [{ assignedToId: ctx.userId }, { createdById: ctx.userId }] });

async function getTask(ctx: Ctx, id: string) {
  const t = await db().task.findFirst({ where: { id, organizationId: ctx.orgId, AND: [taskScope(ctx)] } });
  if (!t) throw notFound('Task');
  return t;
}

const listQuery = z.object({
  ...pageQuery, scope: z.enum(['mine', 'team', 'overdue', 'completed', 'all']).default('mine'),
  assignedToId: csvUuids('me'), status: csvEnum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELED']), priority: csvEnum(['LOW', 'MEDIUM', 'HIGH']), leadId: z.string().uuid().optional(), opportunityId: z.string().uuid().optional(), q: z.string().trim().max(100).optional(),
  sort: z.enum(['dueAt', 'createdAt', 'priority']).default('dueAt'), order: z.enum(['asc', 'desc']).default('asc'),
});

const include = { lead: { select: { id: true, firstName: true, lastName: true } }, opportunity: { select: { id: true, name: true } }, _count: { select: { comments: true } } } satisfies Prisma.TaskInclude;
type Row = Prisma.TaskGetPayload<{ include: typeof include }>;
const shape = (t: Row, u: Map<string, { id: string; name: string; email: string }>) => ({
  id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority, dueAt: t.dueAt, completedAt: t.completedAt, isAutomated: t.isAutomated,
  isOverdue: !!t.dueAt && ['TODO', 'IN_PROGRESS'].includes(t.status) && t.dueAt.getTime() < Date.now(),
  assignedTo: lite(u, t.assignedToId), createdBy: lite(u, t.createdById), completedBy: lite(u, t.completedById), createdAt: t.createdAt,
  lead: t.lead ? { id: t.lead.id, name: fullName(t.lead) } : null, opportunity: t.opportunity, commentCount: t._count.comments,
});

tasks.get('/', { query: listQuery, summary: 'List tasks (my / team / overdue / completed)' }, async ({ ctx, query }) => {
  const and: Prisma.TaskWhereInput[] = [taskScope(ctx)];
  if (query.scope === 'mine') and.push({ assignedToId: ctx.userId, status: { in: ['TODO', 'IN_PROGRESS'] } });
  if (query.scope === 'team') and.push({ status: { in: ['TODO', 'IN_PROGRESS'] } });
  if (query.scope === 'overdue') and.push({ status: { in: ['TODO', 'IN_PROGRESS'] }, dueAt: { lt: new Date() } });
  if (query.scope === 'completed') and.push({ status: 'DONE' });
  if (query.assignedToId?.length) and.push({ assignedToId: { in: query.assignedToId.map((i) => (i === 'me' ? ctx.userId : i)) } });
  if (query.status?.length) and.push({ status: { in: query.status as never } });
  if (query.priority?.length) and.push({ priority: { in: query.priority as never } });
  if (query.q) and.push({ title: { contains: query.q, mode: 'insensitive' } });
  const where: Prisma.TaskWhereInput = { organizationId: ctx.orgId, ...(query.leadId ? { leadId: query.leadId } : {}), ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}), AND: and };
  const orderBy: Prisma.TaskOrderByWithRelationInput[] = query.scope === 'completed' ? [{ completedAt: 'desc' }] : [(query.sort === 'dueAt' ? { dueAt: { sort: query.order, nulls: 'last' } } : { [query.sort]: query.order }) as never, { createdAt: 'desc' }];
  const [total, rows] = await Promise.all([db().task.count({ where }), db().task.findMany({ where, include, orderBy, ...paginate(query) })]);
  const u = await usersById(rows.flatMap((r) => [r.assignedToId, r.createdById, r.completedById]));
  return paged(rows.map((r) => shape(r, u)), pageMeta(query, total));
});

tasks.post('/', { perm: 'tasks.manage', body: taskSchema, summary: 'Create a task (optionally linked to a lead / opportunity)' }, async ({ ctx, body }) => {
  if (body.leadId) await getLeadOr404(ctx, body.leadId);
  if (body.opportunityId) await getOppOr404(ctx, body.opportunityId);
  const assignedToId = body.assignedToId ?? ctx.userId;
  await assertActiveMember(ctx, assignedToId, 'Assignee');
  const t = await db().task.create({ data: { organizationId: ctx.orgId, title: body.title, description: body.description ?? null, priority: body.priority, dueAt: body.dueAt ?? null, assignedToId, createdById: ctx.userId, leadId: body.leadId ?? null, opportunityId: body.opportunityId ?? null } });
  if (t.leadId) await logActivity({ leadId: t.leadId, opportunityId: t.opportunityId, type: 'TASK_CREATED', title: `Task created: ${t.title}`, metadata: { taskId: t.id, dueAt: t.dueAt?.toISOString() ?? null } });
  await notify({ userIds: [assignedToId], type: 'TASK_ASSIGNED', title: `New task: ${t.title}`, body: t.dueAt ? `Due ${t.dueAt.toISOString()}` : undefined, link: '/tasks', entityType: 'task', entityId: t.id, exceptUserId: ctx.userId });
  return created({ id: t.id });
});

tasks.get('/:id', { summary: 'Task detail with comments' }, async ({ ctx, params }) => {
  const base = await getTask(ctx, params.id);
  const t = await db().task.findUniqueOrThrow({ where: { id: base.id }, include });
  const comments = await db().taskComment.findMany({ where: { taskId: base.id, organizationId: ctx.orgId }, orderBy: { createdAt: 'asc' } });
  const u = await usersById([t.assignedToId, t.createdById, t.completedById, ...comments.map((c) => c.authorId)]);
  return { ...shape(t, u), comments: comments.map((c) => ({ id: c.id, body: c.body, author: lite(u, c.authorId), createdAt: c.createdAt })) };
});

tasks.patch('/:id', { perm: 'tasks.manage', body: taskUpdateSchema, summary: 'Update a task / change status' }, async ({ ctx, params, body }) => {
  const t = await getTask(ctx, params.id);
  const data: Prisma.TaskUncheckedUpdateInput = { ...body };
  if (body.assignedToId) { await assertActiveMember(ctx, body.assignedToId, 'Assignee'); if (body.assignedToId !== t.assignedToId) data.reminderSentAt = null; }
  if (body.status && body.status !== t.status) {
    if (body.status === 'DONE') { data.completedAt = new Date(); data.completedById = ctx.userId; }
    else { data.completedAt = null; data.completedById = null; }
  }
  if (body.dueAt !== undefined && body.dueAt?.getTime() !== t.dueAt?.getTime()) data.reminderSentAt = null;
  const u = await db().task.update({ where: { id: t.id }, data });
  if (body.status === 'DONE' && t.status !== 'DONE' && t.leadId) await logActivity({ leadId: t.leadId, opportunityId: t.opportunityId, type: 'TASK_COMPLETED', title: `Task completed: ${t.title}`, metadata: { taskId: t.id } });
  if (body.assignedToId && body.assignedToId !== t.assignedToId) await notify({ userIds: [body.assignedToId], type: 'TASK_ASSIGNED', title: `Task assigned to you: ${u.title}`, link: '/tasks', entityType: 'task', entityId: t.id, exceptUserId: ctx.userId });
  return { id: u.id, status: u.status };
});

tasks.delete('/:id', { perm: 'tasks.manage', summary: 'Cancel a task' }, async ({ ctx, params }) => {
  const t = await getTask(ctx, params.id);
  await db().task.update({ where: { id: t.id }, data: { status: 'CANCELED' } });
  return { canceled: true };
});

tasks.post('/:id/comments', { perm: 'tasks.manage', body: commentSchema, summary: 'Comment on a task' }, async ({ ctx, params, body }) => {
  const t = await getTask(ctx, params.id);
  if (!body.body.trim()) throw badRequest('Write a comment');
  const c = await db().taskComment.create({ data: { organizationId: ctx.orgId, taskId: t.id, authorId: ctx.userId, body: body.body } });
  await notify({ userIds: [t.assignedToId, t.createdById], type: 'REMINDER', title: `${ctx.user.name} commented on "${t.title}"`, body: body.body.slice(0, 140), link: '/tasks', entityType: 'task', entityId: t.id, exceptUserId: ctx.userId });
  return created({ id: c.id });
});
