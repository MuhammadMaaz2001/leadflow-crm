import { currentStore, db } from '../db';
import type { Ctx } from '../http';
import type { Prisma } from '@leadflow/database';

/** Append-only audit trail for sensitive tenant operations. */
export async function audit(ctx: Pick<Ctx, 'orgId' | 'userId' | 'user' | 'ip'> | null, action: string, entityType?: string, entityId?: string, metadata: Prisma.InputJsonValue = {}) {
  const store = currentStore();
  const orgId = ctx?.orgId ?? store?.orgId ?? null;
  await db().auditLog.create({
    data: { organizationId: orgId, actorId: ctx?.userId ?? null, actorEmail: ctx?.user?.email ?? null, scope: 'TENANT', action, entityType, entityId, metadata, ip: ctx?.ip },
  });
}
