import type { ActivityType, Prisma } from '@leadflow/database';
import { CONTACT_ACTIVITY_TYPES } from '@leadflow/shared';
import { currentStore, db } from '../../db';

export interface ActivityInput {
  leadId?: string | null;
  opportunityId?: string | null;
  type: ActivityType;
  title: string;
  body?: string | null;
  metadata?: Prisma.InputJsonValue;
  occurredAt?: Date;
  actorId?: string | null;
  /** When false the lead's last-activity clock is not reset (used for system-generated entries). */
  touch?: boolean;
}

/**
 * Appends to the lead timeline (immutable history). Contact-type activities (call/email/WhatsApp/meeting)
 * stamp the lead's first-contact time (used for response-time and contact-rate reports).
 */
export async function logActivity(input: ActivityInput) {
  const store = currentStore();
  if (!store?.orgId) throw new Error('logActivity needs an organization context');
  const occurredAt = input.occurredAt ?? new Date();
  const a = await db().activity.create({
    data: {
      organizationId: store.orgId, leadId: input.leadId ?? null, opportunityId: input.opportunityId ?? null, type: input.type,
      actorId: input.actorId === undefined ? store.userId : input.actorId, title: input.title, body: input.body ?? null,
      metadata: input.metadata ?? {}, occurredAt,
    },
  });
  if (input.leadId && input.touch !== false) {
    const isContact = (CONTACT_ACTIVITY_TYPES as readonly string[]).includes(input.type);
    const lead = await db().lead.findUnique({ where: { id: input.leadId }, select: { firstContactedAt: true, status: true } });
    if (lead) {
      const data: Prisma.LeadUpdateInput = { lastActivityAt: occurredAt > new Date() ? new Date() : occurredAt };
      if (isContact) {
        if (!lead.firstContactedAt || occurredAt < lead.firstContactedAt) data.firstContactedAt = occurredAt;
        if (lead.status === 'NEW') data.status = 'CONTACTED';
      }
      await db().lead.update({ where: { id: input.leadId }, data });
    }
  }
  return a;
}

/** Record that a contact attempt happened (without adding a timeline row) — used by follow-up completion. */
export async function markContacted(leadId: string, at: Date) {
  const lead = await db().lead.findUnique({ where: { id: leadId }, select: { firstContactedAt: true, status: true } });
  if (!lead) return;
  const data: Prisma.LeadUpdateInput = { lastActivityAt: at > new Date() ? new Date() : at };
  if (!lead.firstContactedAt || at < lead.firstContactedAt) data.firstContactedAt = at;
  if (lead.status === 'NEW') data.status = 'CONTACTED';
  await db().lead.update({ where: { id: leadId }, data });
}
