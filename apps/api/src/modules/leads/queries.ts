import type { Lead, Prisma } from '@leadflow/database';
import { fullName } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { boolQuery, csvList, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';
import type { Ctx } from '../../http';
import { leadScope } from './service';

export const leadFilterQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csvList, priorityId: csvList, sourceId: csvList, assignedToId: csvList, tagId: csvList,
  createdFrom: z.coerce.date().optional(), createdTo: z.coerce.date().optional(),
  archived: z.enum(['false', 'true', 'all']).default('false'),
  hasOverdueFollowUp: boolQuery, noFollowUp: boolQuery, uncontacted: boolQuery,
});
export const leadListQuery = leadFilterQuery.extend({
  ...pageQuery,
  sort: z.enum(['createdAt', 'name', 'company', 'lastActivityAt', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type LeadFilters = z.infer<typeof leadFilterQuery>;

export function buildLeadWhere(ctx: Ctx, f: LeadFilters): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [leadScope(ctx), { mergedIntoId: null }];
  if (f.archived === 'false') and.push({ archivedAt: null });
  if (f.archived === 'true') and.push({ archivedAt: { not: null } });
  if (f.q) {
    const terms = f.q.split(/\s+/).filter(Boolean);
    for (const t of terms) {
      and.push({ OR: [
        { firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } },
        { email: { contains: t, mode: 'insensitive' } }, { companyName: { contains: t, mode: 'insensitive' } },
        { phone: { contains: t } }, ...(t.replace(/\D/g, '').length >= 4 ? [{ phoneNormalized: { contains: t.replace(/\D/g, '') } }] : []),
      ] });
    }
  }
  if (f.status?.length) and.push({ status: { in: f.status as Lead['status'][] } });
  if (f.priorityId?.length) and.push({ priorityId: { in: f.priorityId } });
  if (f.sourceId?.length) and.push({ sourceId: { in: f.sourceId } });
  if (f.assignedToId?.length) {
    const ids = f.assignedToId.filter((i) => i !== 'unassigned');
    and.push({ OR: [...(ids.length ? [{ assignedToId: { in: ids } }] : []), ...(f.assignedToId.includes('unassigned') ? [{ assignedToId: null }] : [])] });
  }
  if (f.tagId?.length) and.push({ tags: { some: { tagId: { in: f.tagId } } } });
  if (f.createdFrom) and.push({ createdAt: { gte: f.createdFrom } });
  if (f.createdTo) and.push({ createdAt: { lte: f.createdTo } });
  if (f.hasOverdueFollowUp) and.push({ followUps: { some: { status: 'PENDING', dueAt: { lt: new Date() } } } });
  if (f.noFollowUp) and.push({ followUps: { none: { status: 'PENDING' } }, status: { in: ['NEW', 'CONTACTED', 'QUALIFIED'] } });
  if (f.uncontacted) and.push({ firstContactedAt: null });
  return { organizationId: ctx.orgId, AND: and };
}

const include = {
  source: { select: { id: true, name: true, color: true } },
  priority: { select: { id: true, name: true, color: true } },
  tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.LeadInclude;

export async function shapeLeads(ctx: Ctx, rows: Array<Prisma.LeadGetPayload<{ include: typeof include }>>) {
  const users = await usersById(rows.flatMap((r) => [r.assignedToId, r.createdById]));
  const ids = rows.map((r) => r.id);
  const next = ids.length
    ? await db().followUp.groupBy({ by: ['leadId'], where: { organizationId: ctx.orgId, leadId: { in: ids }, status: 'PENDING' }, _min: { dueAt: true } })
    : [];
  const nextMap = new Map(next.map((n) => [n.leadId, n._min.dueAt]));
  return rows.map((r) => ({
    id: r.id, firstName: r.firstName, lastName: r.lastName, name: fullName(r), email: r.email, phone: r.phone, companyName: r.companyName, jobTitle: r.jobTitle,
    status: r.status, campaign: r.campaign, source: r.source, priority: r.priority, tags: r.tags.map((t) => t.tag), customFields: r.customFields,
    assignedTo: lite(users, r.assignedToId), createdBy: lite(users, r.createdById), assignedAt: r.assignedAt,
    nextFollowUpAt: nextMap.get(r.id) ?? null, firstContactedAt: r.firstContactedAt, lastActivityAt: r.lastActivityAt,
    createdAt: r.createdAt, archivedAt: r.archivedAt, description: r.description,
  }));
}
export const leadInclude = include;
