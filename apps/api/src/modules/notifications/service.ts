import type { NotificationType } from '@leadflow/database';
import { currentStore, db } from '../../db';

export interface NotifyInput {
  userIds: Array<string | null | undefined>;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  dedupeKey?: string;
  exceptUserId?: string | null;
}

/** Creates in-app notifications, honouring each recipient's notification preferences. */
export async function notify(input: NotifyInput) {
  const orgId = currentStore()?.orgId;
  if (!orgId) throw new Error('notify() needs an organization context');
  const ids = [...new Set(input.userIds.filter((u): u is string => !!u && u !== input.exceptUserId))];
  if (!ids.length) return 0;
  const [prefs, members] = await Promise.all([
    db().notificationPreference.findMany({ where: { organizationId: orgId, userId: { in: ids }, type: input.type, inApp: false } }),
    db().membership.findMany({ where: { organizationId: orgId, userId: { in: ids }, status: 'ACTIVE' }, select: { userId: true } }),
  ]);
  const muted = new Set(prefs.map((p) => p.userId));
  const active = new Set(members.map((m) => m.userId));
  const recipients = ids.filter((u) => !muted.has(u) && active.has(u));
  if (!recipients.length) return 0;
  const r = await db().notification.createMany({
    data: recipients.map((userId) => ({
      organizationId: orgId, userId, type: input.type, title: input.title, body: input.body, link: input.link,
      entityType: input.entityType, entityId: input.entityId, dedupeKey: input.dedupeKey,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/** Active members whose role can assign leads (owner/admin/manager style roles). */
export async function managerIds(): Promise<string[]> {
  const orgId = currentStore()!.orgId!;
  const rows = await db().membership.findMany({
    where: { organizationId: orgId, status: 'ACTIVE', role: { permissions: { has: 'leads.assign' } } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}
