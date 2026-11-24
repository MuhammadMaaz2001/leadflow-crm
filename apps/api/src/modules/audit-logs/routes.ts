import { z } from 'zod';
import { db } from '../../db';
import { defineRoutes, paged } from '../../http';
import { pageMeta, paginate, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';

export const auditLogs = defineRoutes('Audit', '/audit-logs');

auditLogs.get('/', { perm: 'settings.manage', query: z.object({ ...pageQuery, action: z.string().optional(), actorId: z.string().uuid().optional() }), summary: 'Workspace audit trail (sensitive operations)' }, async ({ ctx, query }) => {
  const where = { organizationId: ctx.orgId, ...(query.action ? { action: { contains: query.action } } : {}), ...(query.actorId ? { actorId: query.actorId } : {}) };
  const [total, rows] = await Promise.all([db().auditLog.count({ where }), db().auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(query) })]);
  const u = await usersById(rows.map((r) => r.actorId));
  return paged(rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, metadata: r.metadata, actor: lite(u, r.actorId) ?? (r.actorEmail ? { id: '', name: r.actorEmail, email: r.actorEmail } : null), ip: r.ip, createdAt: r.createdAt })), pageMeta(query, total));
});
