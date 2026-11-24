import { NOTIFICATION_TYPES, notificationPrefsSchema } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { notFound } from '../../lib/errors';
import { defineRoutes, paged } from '../../http';
import { pageMeta, paginate, pageQuery } from '../../lib/pagination';

export const notifications = defineRoutes('Notifications', '/notifications');

notifications.get('/', { query: z.object({ ...pageQuery, unreadOnly: z.preprocess((v) => v === 'true', z.boolean()).optional() }), summary: 'My notifications' }, async ({ ctx, query }) => {
  const where = { organizationId: ctx.orgId, userId: ctx.userId, ...(query.unreadOnly ? { readAt: null } : {}) };
  const [total, unread, rows] = await Promise.all([
    db().notification.count({ where }), db().notification.count({ where: { organizationId: ctx.orgId, userId: ctx.userId, readAt: null } }),
    db().notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(query) }),
  ]);
  return paged(rows, { ...pageMeta(query, total), unread });
});
notifications.get('/unread-count', { summary: 'Unread notification count' }, async ({ ctx }) => ({ unread: await db().notification.count({ where: { organizationId: ctx.orgId, userId: ctx.userId, readAt: null } }) }));
notifications.post('/read-all', { summary: 'Mark all notifications read' }, async ({ ctx }) => {
  const r = await db().notification.updateMany({ where: { organizationId: ctx.orgId, userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: r.count };
});
notifications.post('/:id/read', { summary: 'Mark one notification read' }, async ({ ctx, params }) => {
  const r = await db().notification.updateMany({ where: { id: params.id, organizationId: ctx.orgId, userId: ctx.userId }, data: { readAt: new Date() } });
  if (!r.count) throw notFound('Notification');
  return { read: true };
});
notifications.post('/:id/unread', { summary: 'Mark one notification unread' }, async ({ ctx, params }) => {
  const r = await db().notification.updateMany({ where: { id: params.id, organizationId: ctx.orgId, userId: ctx.userId }, data: { readAt: null } });
  if (!r.count) throw notFound('Notification');
  return { read: false };
});
notifications.get('/preferences', { summary: 'My notification preferences' }, async ({ ctx }) => {
  const rows = await db().notificationPreference.findMany({ where: { organizationId: ctx.orgId, userId: ctx.userId } });
  const m = new Map(rows.map((r) => [r.type as string, r.inApp]));
  return NOTIFICATION_TYPES.map((t) => ({ type: t.value, label: t.label, inApp: m.get(t.value) ?? true }));
});
notifications.put('/preferences', { body: notificationPrefsSchema, summary: 'Update my notification preferences' }, async ({ ctx, body }) => {
  const valid = new Set<string>(NOTIFICATION_TYPES.map((t) => t.value));
  for (const p of body.prefs.filter((x) => valid.has(x.type))) {
    await db().notificationPreference.upsert({
      where: { organizationId_userId_type: { organizationId: ctx.orgId, userId: ctx.userId, type: p.type as never } },
      update: { inApp: p.inApp }, create: { organizationId: ctx.orgId, userId: ctx.userId, type: p.type as never, inApp: p.inApp },
    });
  }
  return { saved: true };
});
