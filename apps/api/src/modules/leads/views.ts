import { z } from 'zod';
import { db } from '../../db';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { created, defineRoutes } from '../../http';
import { usersById } from '../../lib/users';

export const leadViews = defineRoutes('Leads', '/lead-views');

/** Only filter / sort / paging keys of the lead list can be stored; anything else is dropped (a view can never smuggle other parameters). */
const ALLOWED = ['q', 'status', 'priorityId', 'sourceId', 'assignedToId', 'tagId', 'createdFrom', 'createdTo', 'archived', 'uncontacted', 'hasOverdueFollowUp', 'noFollowUp', 'sort', 'order', 'pageSize'];
export function sanitizeQuery(raw: string): string {
  const incoming = new URLSearchParams(raw.replace(/^\?/, ''));
  const out = new URLSearchParams();
  for (const k of ALLOWED) { const v = incoming.get(k); if (v && v.length <= 200) out.set(k, v); }
  return out.toString();
}
const MAX_PER_USER = 50;
const viewBody = z.object({ name: z.string().trim().min(1, 'Name the view').max(80), query: z.string().max(1500).default(''), isShared: z.boolean().default(false) });

const shape = (v: { id: string; name: string; query: string; isShared: boolean; userId: string; updatedAt: Date }, me: string, owners: Map<string, { name: string }>) =>
  ({ id: v.id, name: v.name, query: v.query, isShared: v.isShared, mine: v.userId === me, owner: v.userId === me ? 'You' : owners.get(v.userId)?.name ?? 'A colleague', updatedAt: v.updatedAt });

leadViews.get('/', { summary: 'Saved lead views: your own and the ones shared with the workspace' }, async ({ ctx }) => {
  const rows = await db().savedView.findMany({ where: { organizationId: ctx.orgId, entity: 'LEAD', OR: [{ userId: ctx.userId }, { isShared: true }] }, orderBy: [{ name: 'asc' }] });
  const owners = await usersById(rows.map((r) => r.userId));
  return rows.map((r) => shape(r, ctx.userId, owners));
});

leadViews.post('/', { body: viewBody, summary: 'Save the current lead filters as a view (sharing needs the permission to assign leads)' }, async ({ ctx, body }) => {
  if (body.isShared && !ctx.can('leads.assign')) throw forbidden('Only managers can share a view with the workspace', 'MISSING_PERMISSION');
  if ((await db().savedView.count({ where: { organizationId: ctx.orgId, userId: ctx.userId, entity: 'LEAD' } })) >= MAX_PER_USER) throw new AppError(409, 'TOO_MANY_VIEWS', `You can keep up to ${MAX_PER_USER} saved views. Delete one first.`);
  const query = sanitizeQuery(body.query);
  const name = body.name.trim();
  // saving under an existing name replaces your own view (what the UI promises)
  const existing = await db().savedView.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, entity: 'LEAD', name: { equals: name, mode: 'insensitive' } } });
  const row = existing
    ? await db().savedView.update({ where: { id: existing.id }, data: { query, isShared: body.isShared, name } })
    : await db().savedView.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, name, query, isShared: body.isShared } });
  await audit(ctx, existing ? 'lead_view.updated' : 'lead_view.created', 'saved_view', row.id, { name, shared: body.isShared });
  return created(shape(row, ctx.userId, new Map()));
});

leadViews.patch('/:id', { body: viewBody.partial(), summary: 'Rename a view or change whether it is shared' }, async ({ ctx, params, body }) => {
  const v = await db().savedView.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!v || (!v.isShared && v.userId !== ctx.userId)) throw notFound('View');
  if (v.userId !== ctx.userId) throw forbidden('Only the owner of a view can change it', 'NOT_OWNER');
  if (body.isShared && !ctx.can('leads.assign')) throw forbidden('Only managers can share a view with the workspace', 'MISSING_PERMISSION');
  try {
    const row = await db().savedView.update({ where: { id: v.id }, data: { ...(body.name ? { name: body.name.trim() } : {}), ...(body.query !== undefined ? { query: sanitizeQuery(body.query) } : {}), ...(body.isShared !== undefined ? { isShared: body.isShared } : {}) } });
    return shape(row, ctx.userId, new Map());
  } catch (e) { if ((e as { code?: string }).code === 'P2002') throw new AppError(409, 'DUPLICATE', 'You already have a view with that name'); throw e; }
});

leadViews.delete('/:id', { summary: 'Delete a view (its owner, or anyone who can manage workspace settings)' }, async ({ ctx, params }) => {
  const v = await db().savedView.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!v || (!v.isShared && v.userId !== ctx.userId)) throw notFound('View');
  if (v.userId !== ctx.userId && !ctx.can('settings.manage')) throw forbidden('Only the owner of a view can delete it', 'NOT_OWNER');
  await db().savedView.delete({ where: { id: v.id } });
  await audit(ctx, 'lead_view.deleted', 'saved_view', v.id, { name: v.name });
  return { deleted: true };
});
