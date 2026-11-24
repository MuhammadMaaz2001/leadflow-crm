import { PERMISSION_GROUPS, ALL_PERMISSIONS, inviteSchema, memberUpdateSchema, roleSchema } from '@leadflow/shared';
import { z } from 'zod';
import { db } from '../../db';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { defineRoutes, created } from '../../http';
import { createInvitation, ensureNotLastOwner } from './service';
import { assertSeatCapacity } from '../subscriptions/service';

export const members = defineRoutes('Team', '');

members.get('/members', { perm: ['team.view', 'team.manage', 'leads.assign'], summary: 'List workspace members with workload' }, async ({ ctx }) => {
  const rows = await db().membership.findMany({
    where: { organizationId: ctx.orgId }, include: { user: true, role: true }, orderBy: [{ status: 'asc' }, { joinedAt: 'asc' }],
  });
  const now = new Date();
  const [leadCounts, openFollowUps, overdue, openTasks, openOpps] = await Promise.all([
    db().lead.groupBy({ by: ['assignedToId'], where: { organizationId: ctx.orgId, archivedAt: null, status: { in: ['NEW', 'CONTACTED', 'QUALIFIED'] } }, _count: true }),
    db().followUp.groupBy({ by: ['assignedToId'], where: { organizationId: ctx.orgId, status: 'PENDING' }, _count: true }),
    db().followUp.groupBy({ by: ['assignedToId'], where: { organizationId: ctx.orgId, status: 'PENDING', dueAt: { lt: now } }, _count: true }),
    db().task.groupBy({ by: ['assignedToId'], where: { organizationId: ctx.orgId, status: { in: ['TODO', 'IN_PROGRESS'] } }, _count: true }),
    db().opportunity.groupBy({ by: ['ownerId'], where: { organizationId: ctx.orgId, status: 'OPEN', archivedAt: null }, _count: true }),
  ]);
  const idx = <T extends { _count: number }>(arr: T[], key: keyof T) => new Map(arr.map((a) => [a[key] as unknown as string, a._count]));
  const L = idx(leadCounts, 'assignedToId'), F = idx(openFollowUps, 'assignedToId'), O = idx(overdue, 'assignedToId'), T = idx(openTasks, 'assignedToId'), P = idx(openOpps, 'ownerId');
  return rows.map((m) => ({
    id: m.id, userId: m.userId, name: m.user.name, email: m.user.email, jobTitle: m.user.jobTitle, status: m.status, isAssignable: m.isAssignable,
    role: { id: m.role.id, name: m.role.name, key: m.role.systemKey }, joinedAt: m.joinedAt, lastLoginAt: m.user.lastLoginAt,
    workload: { openLeads: L.get(m.userId) ?? 0, openFollowUps: F.get(m.userId) ?? 0, overdueFollowUps: O.get(m.userId) ?? 0, openTasks: T.get(m.userId) ?? 0, openOpportunities: P.get(m.userId) ?? 0 },
  }));
});

members.patch('/members/:id', { perm: 'team.manage', body: memberUpdateSchema, summary: 'Change role / activate / deactivate a member' }, async ({ ctx, params, body }) => {
  const target = await db().membership.findFirst({ where: { id: params.id, organizationId: ctx.orgId }, include: { role: true } });
  if (!target) throw notFound('Member');
  if (target.role.systemKey === 'OWNER' && ctx.roleKey !== 'OWNER') throw forbidden('Only an owner can modify another owner');
  const data: Record<string, unknown> = {};
  if (body.roleId && body.roleId !== target.roleId) {
    const role = await db().role.findFirst({ where: { id: body.roleId, organizationId: ctx.orgId } });
    if (!role) throw notFound('Role');
    if (role.systemKey === 'OWNER' && ctx.roleKey !== 'OWNER') throw forbidden('Only an owner can grant the Owner role');
    if (target.role.systemKey === 'OWNER') await ensureNotLastOwner(ctx, target.id);
    data.roleId = role.id;
  }
  if (body.status && body.status !== target.status) {
    if (body.status === 'DEACTIVATED') {
      if (target.userId === ctx.userId) throw new AppError(409, 'SELF_DEACTIVATE', 'You cannot deactivate yourself.');
      await ensureNotLastOwner(ctx, target.id);
      data.deactivatedAt = new Date();
    } else {
      await assertSeatCapacity(ctx, true);
      data.deactivatedAt = null;
    }
    data.status = body.status;
  }
  if (body.isAssignable !== undefined) data.isAssignable = body.isAssignable;
  const updated = await db().membership.update({ where: { id: target.id }, data });
  await audit(ctx, 'member.updated', 'membership', target.id, { changes: Object.keys(data) });
  return updated;
});

members.get('/invitations', { perm: 'team.manage', summary: 'List invitations' }, async ({ ctx }) => {
  const rows = await db().invitation.findMany({ where: { organizationId: ctx.orgId }, include: { role: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map((i) => ({ id: i.id, email: i.email, role: { id: i.role.id, name: i.role.name }, status: i.status === 'PENDING' && i.expiresAt < new Date() ? 'EXPIRED' : i.status, expiresAt: i.expiresAt, createdAt: i.createdAt }));
});
members.post('/invitations', { perm: 'team.manage', body: inviteSchema, summary: 'Invite a team member by email' }, async ({ ctx, body }) => {
  const { invitation, link } = await createInvitation(ctx, body.email, body.roleId);
  return created({ id: invitation.id, email: invitation.email, status: invitation.status, devInviteLink: link });
});
members.post('/invitations/:id/resend', { perm: 'team.manage', summary: 'Re-issue an invitation link' }, async ({ ctx, params }) => {
  const inv = await db().invitation.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!inv) throw notFound('Invitation');
  const { invitation, link } = await createInvitation(ctx, inv.email, inv.roleId);
  return { id: invitation.id, devInviteLink: link };
});
members.delete('/invitations/:id', { perm: 'team.manage', summary: 'Revoke an invitation' }, async ({ ctx, params }) => {
  const r = await db().invitation.updateMany({ where: { id: params.id, organizationId: ctx.orgId, status: 'PENDING' }, data: { status: 'REVOKED' } });
  if (!r.count) throw notFound('Invitation');
  await audit(ctx, 'member.invitation_revoked', 'invitation', params.id);
  return { revoked: true };
});

// ── Roles & permissions ──
members.get('/permissions', { summary: 'Permission catalogue' }, async () => PERMISSION_GROUPS);
members.get('/roles', { summary: 'List roles' }, async ({ ctx }) => {
  const roles = await db().role.findMany({ where: { organizationId: ctx.orgId }, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }], include: { _count: { select: { memberships: true } } } });
  return roles.map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: r.permissions, isSystem: r.isSystem, systemKey: r.systemKey, memberCount: r._count.memberships }));
});
members.post('/roles', { perm: 'roles.manage', feature: 'custom_roles', body: roleSchema, summary: 'Create a custom role' }, async ({ ctx, body }) => {
  const perms = body.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  const role = await db().role.create({ data: { organizationId: ctx.orgId, name: body.name, description: body.description ?? null, permissions: perms } });
  await audit(ctx, 'role.created', 'role', role.id, { name: role.name });
  return created(role);
});
members.patch('/roles/:id', { perm: 'roles.manage', body: roleSchema.partial(), summary: 'Edit a role' }, async ({ ctx, params, body }) => {
  const role = await db().role.findFirst({ where: { id: params.id, organizationId: ctx.orgId } });
  if (!role) throw notFound('Role');
  if (role.systemKey === 'OWNER') throw forbidden('The Owner role cannot be modified', 'OWNER_ROLE_LOCKED');
  if (role.isSystem && !ctx.plan.features.includes('custom_roles')) throw new AppError(402, 'FEATURE_NOT_IN_PLAN', 'Editing role permissions requires a plan with custom roles.');
  const perms = body.permissions?.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  const updated = await db().role.update({ where: { id: role.id }, data: { name: role.isSystem ? undefined : body.name, description: body.description, permissions: perms } });
  await audit(ctx, 'role.updated', 'role', role.id, { name: updated.name });
  return updated;
});
members.delete('/roles/:id', { perm: 'roles.manage', summary: 'Delete a custom role' }, async ({ ctx, params }) => {
  const role = await db().role.findFirst({ where: { id: params.id, organizationId: ctx.orgId }, include: { _count: { select: { memberships: true, invitations: true } } } });
  if (!role) throw notFound('Role');
  if (role.isSystem) throw forbidden('System roles cannot be deleted');
  if (role._count.memberships || role._count.invitations) throw new AppError(409, 'ROLE_IN_USE', 'Reassign members using this role before deleting it.');
  await db().role.delete({ where: { id: role.id } });
  await audit(ctx, 'role.deleted', 'role', role.id, { name: role.name });
  return { deleted: true };
});
void z;
