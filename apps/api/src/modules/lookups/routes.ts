import { customFieldSchema, lookupSchema } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { created, defineRoutes } from '../../http';
import type { PermissionKey } from '@leadflow/shared';

export const lookups = defineRoutes('Workspace settings', '');

type Delegate = {
  findMany: (a: unknown) => Promise<Array<Record<string, unknown> & { id: string }>>;
  findFirst: (a: unknown) => Promise<(Record<string, unknown> & { id: string }) | null>;
  create: (a: unknown) => Promise<unknown>;
  update: (a: unknown) => Promise<unknown>;
  delete: (a: unknown) => Promise<unknown>;
};

/** Generic CRUD for simple per-workspace lists (sources, priorities, lost reasons, tags). */
function lookupCrud(path: string, model: 'leadSource' | 'leadPriority' | 'lostReason' | 'tag', label: string, usage: (orgId: string, id: string) => Promise<number>, writePerm: PermissionKey, managePerm: PermissionKey = writePerm) {
  const d = () => db()[model] as unknown as Delegate;
  lookups.get(path, { query: z.object({ includeInactive: z.preprocess((v) => v === 'true', z.boolean()).optional() }), summary: `List ${label}` }, async ({ ctx, query }) => {
    const rows = await d().findMany({ where: { organizationId: ctx.orgId, ...(query.includeInactive ? {} : { isActive: true }) }, orderBy: [{ position: 'asc' }, { name: 'asc' }] });
    const counts = await Promise.all(rows.map((r) => usage(ctx.orgId, r.id)));
    return rows.map((r, i) => ({ ...r, usageCount: counts[i] }));
  });
  lookups.post(path, { perm: writePerm, body: lookupSchema, summary: `Create ${label}` }, async ({ ctx, body }) => {
    const max = (await d().findMany({ where: { organizationId: ctx.orgId }, orderBy: { position: 'desc' }, take: 1 }))[0];
    try {
      const row = await d().create({ data: { organizationId: ctx.orgId, name: body.name, color: body.color ?? '#64748b', position: body.position ?? ((max?.position as number | undefined) ?? 0) + 1 } });
      await audit(ctx, `${model}.created`, model, (row as { id: string }).id, { name: body.name });
      return created(row);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new AppError(409, 'DUPLICATE', `A ${label} named "${body.name}" already exists`);
      throw e;
    }
  });
  lookups.patch(`${path}/:id`, { perm: managePerm, body: lookupSchema.partial(), summary: `Update ${label}` }, async ({ ctx, params, body }) => {
    const row = await d().findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
    if (!row) throw notFound(label);
    try {
      const updated = await d().update({ where: { id: row.id }, data: body });
      await audit(ctx, `${model}.updated`, model, row.id, { fields: Object.keys(body) });
      return updated;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new AppError(409, 'DUPLICATE', `A ${label} with that name already exists`);
      throw e;
    }
  });
  lookups.delete(`${path}/:id`, { perm: managePerm, summary: `Delete or deactivate ${label}` }, async ({ ctx, params }) => {
    const row = await d().findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
    if (!row) throw notFound(label);
    const used = await usage(ctx.orgId, row.id);
    if (used > 0) {
      await d().update({ where: { id: row.id }, data: { isActive: false } });
      await audit(ctx, `${model}.deactivated`, model, row.id);
      return { deleted: false, deactivated: true, reason: `In use by ${used} record(s); hidden from new selections instead.` };
    }
    await d().delete({ where: { id: row.id } });
    await audit(ctx, `${model}.deleted`, model, row.id);
    return { deleted: true };
  });
}

lookupCrud('/lead-sources', 'leadSource', 'lead source', (o, id) => db().lead.count({ where: { organizationId: o, sourceId: id } }), 'settings.manage');
lookupCrud('/lead-priorities', 'leadPriority', 'lead priority', (o, id) => db().lead.count({ where: { organizationId: o, priorityId: id } }), 'settings.manage');
lookupCrud('/lost-reasons', 'lostReason', 'lost reason', (o, id) => db().opportunity.count({ where: { organizationId: o, lostReasonId: id } }), 'settings.manage');
lookupCrud('/tags', 'tag', 'tag', (o, id) => db().leadTag.count({ where: { organizationId: o, tagId: id } }), 'leads.update', 'settings.manage'); // anyone who edits leads can create a tag; renaming / deleting a shared tag is a workspace-settings action

// ── Custom fields ──
lookups.get('/custom-fields', { summary: 'List custom lead fields' }, async ({ ctx }) =>
  db().customFieldDef.findMany({ where: { organizationId: ctx.orgId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }));

lookups.post('/custom-fields', { perm: 'settings.manage', feature: 'custom_fields', body: customFieldSchema, summary: 'Create a custom field' }, async ({ ctx, body }) => {
  const key = body.key ?? body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw new AppError(400, 'VALIDATION_ERROR', 'Could not derive a valid field key from that label');
  if (body.type === 'SELECT' && !(body.options?.length)) throw new AppError(400, 'VALIDATION_ERROR', 'Dropdown fields need at least one option');
  const exists = await db().customFieldDef.findFirst({ where: { organizationId: ctx.orgId, key } });
  if (exists) throw new AppError(409, 'DUPLICATE', 'A field with this key already exists');
  const max = await db().customFieldDef.count({ where: { organizationId: ctx.orgId } });
  const row = await db().customFieldDef.create({
    data: { organizationId: ctx.orgId, key, label: body.label, type: body.type, options: body.options ?? [], required: body.required ?? false, position: max + 1 },
  });
  await audit(ctx, 'custom_field.created', 'custom_field', row.id, { key });
  return created(row);
});
lookups.patch('/custom-fields/:id', { perm: 'settings.manage', feature: 'custom_fields', body: customFieldSchema.partial(), summary: 'Update a custom field (the type and key never change; options in use cannot be removed)' }, async ({ ctx, params, body }) => {
  const row = await db().customFieldDef.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!row) throw notFound('Custom field');
  if (body.type && body.type !== row.type) throw new AppError(409, 'TYPE_LOCKED', 'The type of an existing field cannot be changed because leads already store values in that type. Create a new field instead.');
  if (body.key && body.key !== row.key) throw new AppError(409, 'KEY_LOCKED', 'The key of an existing field cannot be changed.');
  const { key: _k, type: _t, options, ...rest } = body;
  void _k; void _t;
  const data: Record<string, unknown> = { ...rest };
  if (options !== undefined) {
    if (row.type !== 'SELECT') throw new AppError(400, 'VALIDATION_ERROR', 'Only dropdown fields have options.');
    const clean = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
    if (!clean.length) throw new AppError(400, 'VALIDATION_ERROR', 'Dropdown fields need at least one option');
    const removed = row.options.filter((o) => !clean.some((c) => c.toLowerCase() === o.toLowerCase()));
    for (const o of removed) {
      const [{ n }] = await db().$queryRaw<[{ n: bigint }]>`SELECT count(*)::bigint AS n FROM leads WHERE organization_id = ${ctx.orgId}::uuid AND custom_fields ->> ${row.key} = ${o}`;
      if (n > 0n) throw new AppError(409, 'OPTION_IN_USE', `“${o}” is used by ${n} lead(s). Change those leads first, or keep the option.`);
    }
    data.options = clean;
  }
  const updated = await db().customFieldDef.update({ where: { id: row.id }, data });
  await audit(ctx, 'custom_field.updated', 'custom_field', row.id);
  return updated;
});
lookups.delete('/custom-fields/:id', { perm: 'settings.manage', summary: 'Deactivate a custom field (values are preserved on leads)' }, async ({ ctx, params }) => {
  const row = await db().customFieldDef.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!row) throw notFound('Custom field');
  await db().customFieldDef.update({ where: { id: row.id }, data: { isActive: false } });
  await audit(ctx, 'custom_field.deactivated', 'custom_field', row.id);
  return { deactivated: true };
});
