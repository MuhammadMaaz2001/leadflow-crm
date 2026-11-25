import type { Lead, Prisma } from '@leadflow/database';
import { fullName } from '@leadflow/shared';
import { z } from 'zod';
import { Prisma as P } from '@leadflow/database';
import { config } from '../../config';
import { db } from '../../db';
import { searchPlans } from '../../lib/metrics';
import { boolQuery, csvEnum, csvUuids, pageQuery } from '../../lib/pagination';
import { lite, usersById } from '../../lib/users';
import type { Ctx } from '../../http';
import { leadScope } from './service';

export const leadFilterQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csvEnum(['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST']), priorityId: csvUuids(), sourceId: csvUuids(), assignedToId: csvUuids('unassigned'), tagId: csvUuids(),
  createdFrom: z.coerce.date().optional(), createdTo: z.coerce.date().optional(),
  archived: z.enum(['false', 'true', 'all']).default('false'),
  hasOverdueFollowUp: boolQuery, noFollowUp: boolQuery, uncontacted: boolQuery,
});
export const leadListQuery = leadFilterQuery.extend({
  ...pageQuery,
  /** Keyset pagination: `start` for the first page, then the `nextCursor` of the previous response. Only with sort=createdAt. Cost does not grow with depth. */
  cursor: z.string().max(200).optional(),
  sort: z.enum(['createdAt', 'name', 'company', 'lastActivityAt', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type LeadFilters = z.infer<typeof leadFilterQuery>;

const likeEscape = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Search terms of a query string (whitespace separated, bounded). */
export const searchTerms = (q?: string) => (q ? q.split(/\s+/).filter(Boolean).slice(0, 6) : []);

/**
 * Resolves a search through the trigram index (see migration `lead_search`) when it is selective: if all terms together match at most
 * SEARCH_MAX_IDS leads, the exact id list is returned and the list query becomes `id IN (…)`. Broader searches (and searches whose terms are
 * all shorter than 3 characters, which trigram indexes cannot serve) return null and keep the ILIKE predicate, which stops early on dense
 * matches. Both paths return exactly the same set of leads.
 */
const broadMemo = new Map<string, number>();       // "this search is broad in this workspace" for a few minutes: skip the probe (it only picks the strategy, never the result)
const BROAD_MEMO_MS = 5 * 60_000;
export const resetSearchMemo = () => broadMemo.clear();
export async function planSearch(orgId: string, q?: string): Promise<string[] | null> {
  const terms = searchTerms(q);
  if (config.searchStrategy !== 'indexed' || !terms.some((t) => t.length >= 3)) return null;
  const memoKey = `${orgId}:${terms.map((t) => t.toLowerCase()).sort().join('\u0001')}`;
  if ((broadMemo.get(memoKey) ?? 0) > Date.now()) { searchPlans.inc({ strategy: 'broad' }); return null; }
  const rows = await db().$queryRaw<Array<{ id: string }>>(P.sql`SELECT lf_search_lead_ids AS id FROM lf_search_lead_ids(${terms}::text[], ${config.searchMaxIds + 1}::integer)`);
  if (rows.length <= config.searchMaxIds) { searchPlans.inc({ strategy: 'indexed' }); return rows.map((r) => r.id); }
  searchPlans.inc({ strategy: 'broad' });
  if (broadMemo.size > 2000) broadMemo.clear();
  broadMemo.set(memoKey, Date.now() + BROAD_MEMO_MS);
  return null;
}

export function buildLeadWhere(ctx: Ctx, f: LeadFilters, searchIds?: string[] | null): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [leadScope(ctx), { mergedIntoId: null }];
  if (f.archived === 'false') and.push({ archivedAt: null });
  if (f.archived === 'true') and.push({ archivedAt: { not: null } });
  if (f.q && searchIds) and.push({ id: { in: searchIds } });
  else if (f.q) {
    const terms = searchTerms(f.q);
    for (const raw of terms) {
      const t = likeEscape(raw);                       // `%` and `_` typed by a user are literal characters, not wildcards (same rule as the indexed path)
      and.push({ OR: [
        { firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } },
        { email: { contains: t, mode: 'insensitive' } }, { companyName: { contains: t, mode: 'insensitive' } },
        { phone: { contains: t } }, ...(raw.replace(/\D/g, '').length >= 4 ? [{ phoneNormalized: { contains: raw.replace(/\D/g, '') } }] : []),
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
