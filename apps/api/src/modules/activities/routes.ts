import { ACTIVITY_LABELS, fullName } from '@leadflow/shared';
import { z } from 'zod';
import type { Prisma } from '@leadflow/database';
import { db } from '../../db';
import { defineRoutes, paged } from '../../http';
import { csvList, pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';
import { leadScope } from '../leads/service';

export const activities = defineRoutes('Activity', '/activities');

activities.get('/', { query: z.object({ ...pageQuery, type: csvList, actorId: z.string().optional(), leadId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), summary: 'Workspace activity log' }, async ({ ctx, query }) => {
  const and: Prisma.ActivityWhereInput[] = [];
  // Members without the workspace-wide permission only see activity on leads they can access.
  if (!ctx.can('activity.view_all')) and.push({ OR: [{ actorId: ctx.userId }, { lead: { AND: [leadScope(ctx)] } }] });
  if (query.type?.length) and.push({ type: { in: query.type as never } });
  if (query.actorId) and.push({ actorId: query.actorId === 'me' ? ctx.userId : query.actorId });
  if (query.from) and.push({ occurredAt: { gte: query.from } });
  if (query.to) and.push({ occurredAt: { lte: query.to } });
  const where: Prisma.ActivityWhereInput = { organizationId: ctx.orgId, ...(query.leadId ? { leadId: query.leadId } : {}), AND: and };
  const [total, rows] = await Promise.all([
    db().activity.count({ where }),
    db().activity.findMany({ where, orderBy: { occurredAt: 'desc' }, include: { lead: { select: { id: true, firstName: true, lastName: true } } }, ...paginate(query) }),
  ]);
  const u = await usersById(rows.map((r) => r.actorId));
  return paged(rows.map((r) => ({ id: r.id, type: r.type, label: ACTIVITY_LABELS[r.type] ?? r.type, title: r.title, body: r.body, occurredAt: r.occurredAt, actor: lite(u, r.actorId), lead: r.lead ? { id: r.lead.id, name: fullName(r.lead) } : null })), pageMeta(query, total));
});
